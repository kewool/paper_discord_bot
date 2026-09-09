import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, sep } from "node:path";
import { Store } from "../src/store.js";
import { loadConfig } from "../src/config.js";
import { League, roundWindow } from "../src/league.js";
import { issueAccess } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { seedDemo } from "../scripts/seed-demo.js";
import { demoGrade, validateGrade } from "../src/grader.js";
import {
  Client,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  PermissionsBitField,
  type Interaction,
  type RequestData,
} from "discord.js";
import { announceDaily, handleInteraction, makeCommands } from "../src/bot.js";
import { resetPapers, resetUser } from "../src/maintenance.js";
import { PDFDocument } from "pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { importPaper } from "../src/papers.js";

test("PDF import preserves source figures larger than the output page pixel limit", async () => {
  const root = resolve("work");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(resolve(root, "pdf-figures-"));
  try {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([600, 800]);
    page.drawText(
      "This synthetic paper checks whether large source figures remain visible. ".repeat(
        8,
      ),
      { x: 20, y: 760, size: 8, maxWidth: 560, lineHeight: 12 },
    );
    const figure = createCanvas(2000, 1600);
    figure.getContext("2d").fillStyle = "#00cc55";
    figure.getContext("2d").fillRect(0, 0, 2000, 1600);
    const embedded = await pdf.embedPng(figure.toBuffer("image/png"));
    page.drawImage(embedded, { x: 100, y: 300, width: 200, height: 200 });
    const source = resolve(dir, "source.pdf");
    await writeFile(source, await pdf.save());
    const meta = {
      title: "Figure fixture",
      authors: "Test",
      sourceUrl: "https://example.com",
      license: "CC0",
    };
    const imported = await importPaper(source, meta, dir);
    const output = await loadImage(
      await readFile(resolve(imported.directory, "page-1.png")),
    );
    const canvas = createCanvas(output.width, output.height);
    canvas.getContext("2d").drawImage(output, 0, 0);
    const pixel = canvas.getContext("2d").getImageData(400, 800, 1, 1).data;
    assert.ok(
      pixel[0] < 30 && pixel[1] > 150 && pixel[2] < 120,
      "source figure must remain in the rendered page",
    );
  } finally {
    if (!resolve(dir).startsWith(root + sep))
      throw new Error("Unexpected test path");
    await rm(dir, { recursive: true, force: true });
  }
});

test("PDF control characters do not truncate the full grading reference", () => {
  const store = new Store(":memory:");
  try {
    const reference =
      "[Page 1]\nFirst page.\u0000\n[Page 2]\nSecond page evidence.";
    store.addPaper({
      id: "control-text",
      title: "Reference",
      authors: "Test",
      sourceUrl: "",
      license: "Original",
      pageCount: 2,
      directory: "",
      demo: true,
      text: reference,
    });
    assert.match(store.getPaper("control-text")!.text, /Second page evidence/);
    store.run("UPDATE papers SET text=? WHERE id=?", reference, "control-text");
    const restored = store.getPaper("control-text")!.text;
    assert.match(restored, /\[Page 2\]/);
    assert.equal(restored.includes("\u0000"), false);
  } finally {
    store.close();
  }
});

async function fixture() {
  const root = resolve("work");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(resolve(root, "core-"));
  const config = loadConfig({
    DEMO_MODE: "true",
    DATA_DIR: dir,
    PUBLIC_URL: "http://127.0.0.1:3000",
  });
  const store = new Store(config.dbPath);
  await seedDemo(store, dir);
  let now = Date.parse("2026-09-08T01:00:00Z");
  const league = new League(store, config, () => now);
  return {
    config,
    store,
    league,
    advance: (ms: number) => {
      now += ms;
    },
    cleanup: async () => {
      store.close();
      if (!resolve(dir).startsWith(root + sep))
        throw new Error("Unexpected test directory");
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("maintenance resets only the selected user, then clears papers without deleting server settings", async () => {
  const f = await fixture();
  try {
    const userA = { id: "123456789012345678", displayName: "Reset user" };
    const userB = { id: "223456789012345678", displayName: "Keep user" };
    const guildId = "700000000000000001";
    const channelId = "710000000000000001";
    f.store.saveGuildSettings(guildId, channelId, "720000000000000001");
    const settings = f.store.getGuildSettings(guildId);
    const firstAttempt = f.league.start(userA);
    const otherAttempt = f.league.start(userB);
    const round = f.league.ensureRound()!;
    const paperDirectory = f.store.getPaper(round.paperId)!.directory;
    for (const user of [userA, userB]) {
      issueAccess(f.league, user, guildId, channelId);
      f.store.run(
        `INSERT INTO sessions(tokenHash,userId,csrfToken,expiresAt,roundId)
        VALUES (?,?,?,?,?)`,
        user.id,
        user.id,
        "csrf",
        f.league.now() + 60000,
        round.id,
      );
      f.store.run(
        "UPDATE attempts SET score=80,gradingStatus='graded' WHERE userId=?",
        user.id,
      );
    }
    const preview = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/admin.ts", "reset-user", userA.id],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          DEMO_MODE: "true",
          DATA_DIR: f.config.dataDir,
          PUBLIC_URL: "http://127.0.0.1:3000",
        },
      },
    );
    assert.match(preview, /미리보기/);
    assert.ok(f.store.get("SELECT * FROM users WHERE id=?", userA.id));
    assert.equal(f.league.currentAttempt(userA.id)!.id, firstAttempt.id);
    resetUser(f.store, userA.id, true);
    assert.equal(
      f.store.get("SELECT * FROM users WHERE id=?", userA.id),
      undefined,
    );
    assert.equal(f.league.currentAttempt(userA.id), undefined);
    for (const table of ["sessions", "accessTokens"])
      assert.equal(
        f.store.get(`SELECT * FROM ${table} WHERE userId=?`, userA.id),
        undefined,
      );
    assert.equal(f.league.currentAttempt(userB.id)!.id, otherAttempt.id);
    assert.equal(f.league.currentAttempt(userB.id)!.score, 80);
    assert.ok(f.store.get("SELECT * FROM sessions WHERE userId=?", userB.id));
    f.advance(60000);
    const fresh = f.league.start(userA);
    assert.notEqual(fresh.id, firstAttempt.id);
    assert.equal(fresh.phase, "reading");
    assert.equal(fresh.startedAt, f.league.now());

    f.store.run(
      "INSERT INTO announcements VALUES (?,?,?,?)",
      round.id,
      "sent",
      1,
      "message",
    );
    f.store.run(
      "INSERT INTO guildAnnouncements VALUES (?,?,?,?,?,?)",
      guildId,
      round.id,
      channelId,
      "sent",
      1,
      "guild-message",
    );
    f.store.run(
      "INSERT INTO arxivImports VALUES (?,?,?,?,?,?,?,?)",
      "test-arxiv",
      round.paperId,
      "cs.AI",
      "",
      "",
      "imported",
      null,
      1,
    );
    f.store.run("INSERT INTO syncState VALUES (?,?,?,?)", "arxiv", 1, 1, null);
    f.store.run("INSERT INTO sourceLocks VALUES (?,?,?)", "arxiv", "test", 1);
    const importDirectory = resolve(f.config.dataDir, "import-work");
    await mkdir(importDirectory);
    await writeFile(resolve(importDirectory, "incomplete.pdf"), "test import");
    const retainedFile = resolve(f.config.dataDir, "operator-settings.txt");
    await writeFile(retainedFile, "keep this file");
    resetPapers(f.store, f.config.dataDir);
    assert.ok(f.store.getPaper(round.paperId));
    assert.ok((await stat(paperDirectory)).isDirectory());
    assert.throws(
      () => resetPapers(f.store, resolve(f.config.dataDir, "wrong"), true),
      /경로/,
    );
    resetPapers(f.store, f.config.dataDir, true);
    assert.equal(f.league.ensureRound(), null);
    assert.equal(f.store.get("SELECT * FROM attempts"), undefined);
    assert.equal(f.store.get("SELECT * FROM sessions"), undefined);
    assert.equal(f.store.get("SELECT * FROM accessTokens"), undefined);
    assert.equal(f.store.get("SELECT * FROM arxivImports"), undefined);
    assert.equal(
      f.store.get("SELECT * FROM syncState WHERE name='arxiv'"),
      undefined,
    );
    assert.equal(
      f.store.get("SELECT * FROM sourceLocks WHERE name='arxiv'"),
      undefined,
    );
    assert.deepEqual(f.store.all("PRAGMA foreign_key_check"), []);
    assert.deepEqual(f.store.getGuildSettings(guildId), settings);
    assert.ok(f.store.get("SELECT * FROM users WHERE id=?", userB.id));
    assert.equal(await readFile(retainedFile, "utf8"), "keep this file");
    await assert.rejects(stat(paperDirectory), { code: "ENOENT" });
    await assert.rejects(stat(importDirectory), { code: "ENOENT" });
  } finally {
    await f.cleanup();
  }
});

test("one-use invitation and expiry keep the web limited to reading", async () => {
  const f = await fixture();
  const app = createApp(f.league, f.config);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  f.config.publicUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (
    path: string,
    method = "GET",
    body?: object,
    cookie = "",
    csrf = "",
  ) =>
    fetch(`${f.config.publicUrl}${path}`, {
      method,
      headers: {
        Origin: f.config.publicUrl,
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const rawToken = (url: string) =>
    new URLSearchParams(new URL(url).hash.slice(1)).get("access")!;
  const cookieOf = (response: Response) =>
    response.headers.get("set-cookie")!.split(";")[0];
  try {
    const user = { id: "123456789012345678", displayName: "참가자 A" };
    const guildA = "700000000000000001";
    const guildB = "700000000000000002";
    const channelA = "710000000000000001";
    const channelB = "710000000000000002";
    f.store.saveGuildSettings(guildB, channelB);
    const access = issueAccess(f.league, user, guildA, channelA);
    assert.equal(f.store.getGuildSettings(guildA), undefined);
    const raw = rawToken(access.url);
    assert.equal((await request("/")).status, 200);
    assert.equal((await request("/api/attempt/page/1")).status, 401);
    const publicState = await (await request("/api/state")).json();
    assert.equal(publicState.attempt, null);
    assert.equal("paperId" in publicState.round, false);
    assert.equal("leaderboard" in publicState, false);
    assert.equal("seasonLeaderboard" in publicState, false);
    assert.equal((await request("/auth/discord")).status, 404);
    const simultaneous = await Promise.all([
      request("/api/access/redeem", "POST", { token: raw }),
      request("/api/access/redeem", "POST", { token: raw }),
    ]);
    assert.deepEqual(simultaneous.map((r) => r.status).sort(), [200, 410]);
    let cookie = cookieOf(simultaneous.find((r) => r.status === 200)!);
    const privateState = await (
      await request("/api/state", "GET", undefined, cookie)
    ).json();
    assert.equal(privateState.user.id, user.id);
    assert.equal(
      privateState.discordUrl,
      `https://discord.com/channels/${guildA}/${channelA}`,
    );
    let csrf = privateState.csrfToken;
    assert.equal(
      (await request("/api/attempt/start", "POST", {}, cookie)).status,
      403,
    );
    const started = await (
      await request("/api/attempt/start", "POST", {}, cookie, csrf)
    ).json();
    assert.equal(started.attempt.phase, "reading");
    assert.equal("summary" in started.attempt, false);
    assert.equal("grade" in started.attempt, false);
    const page = await request("/api/attempt/page/1", "GET", undefined, cookie);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type")!, /image\/png/);
    assert.match(page.headers.get("cache-control")!, /no-store/);
    assert.ok((await page.arrayBuffer()).byteLength > 10000);

    const userB = { id: "223456789012345678", displayName: "참가자 B" };
    const cookieB = cookieOf(
      await request("/api/access/redeem", "POST", {
        token: rawToken(issueAccess(f.league, userB, guildB).url),
      }),
    );
    assert.equal(
      (await request("/api/attempt/page/1", "GET", undefined, cookieB)).status,
      403,
    );
    const stateB = await (
      await request("/api/state", "GET", undefined, cookieB)
    ).json();
    const startedB = await (
      await request("/api/attempt/start", "POST", {}, cookieB, stateB.csrfToken)
    ).json();
    assert.equal(startedB.attempt.paperTitle, started.attempt.paperTitle);
    assert.notEqual(startedB.attempt.id, started.attempt.id);
    assert.equal(
      (
        await request(
          "/api/attempt/finish",
          "POST",
          { attemptId: startedB.attempt.id },
          cookie,
          csrf,
        )
      ).status,
      410,
    );
    assert.equal(
      f.league.currentAttempt(user.id)!.readingEndsAt,
      started.attempt.readingEndsAt,
    );

    f.advance(60000);
    cookie = cookieOf(
      await request("/api/access/redeem", "POST", {
        token: rawToken(issueAccess(f.league, user, guildB).url),
      }),
    );
    const switchedServer = await (
      await request("/api/state", "GET", undefined, cookie)
    ).json();
    csrf = switchedServer.csrfToken;
    assert.equal(
      switchedServer.discordUrl,
      `https://discord.com/channels/${guildB}/${channelB}`,
    );
    const reopened = await (
      await request("/api/attempt/start", "POST", {}, cookie, csrf)
    ).json();
    assert.equal(reopened.attempt.id, started.attempt.id);
    assert.equal(reopened.attempt.readingEndsAt, started.attempt.readingEndsAt);
    f.advance(29 * 60000);
    assert.equal(
      (await request("/api/attempt/page/1", "GET", undefined, cookie)).status,
      410,
    );
    assert.equal(
      (
        await (
          await request("/api/attempt/start", "POST", {}, cookie, csrf)
        ).json()
      ).attempt.phase,
      "writing",
    );
    const summary =
      "문제와 방법을 구분하고 실제 결과를 근거와 연결하여 설명합니다. 논문에서 확인할 수 없는 수치를 만들어 내지 않으며 일반화의 한계를 분명하게 밝힙니다. ".repeat(
        4,
      );
    assert.equal(
      (await request("/api/attempt/submit", "POST", { summary }, cookie, csrf))
        .status,
      404,
    );
    assert.equal(f.league.currentAttempt(user.id)!.summary, null);
    const accepted = f.league.submit(user.id, summary, started.attempt.id);
    assert.equal(accepted.phase, "queued");
    const pending = f.league.claimGrade()!;
    f.league.completeGrade(pending, demoGrade(f.league.ensureRound()!));
    const webResult = await (
      await request("/api/state", "GET", undefined, cookie)
    ).json();
    assert.equal("summary" in webResult.attempt, false);
    assert.equal("grade" in webResult.attempt, false);
    assert.equal("leaderboard" in webResult, false);
    assert.equal(
      (await request("/api/attempt/submit", "POST", { summary }, cookie, csrf))
        .status,
      404,
    );
    assert.equal(
      (await (await request("/api/state", "GET", undefined, cookieB)).json())
        .attempt.summary,
      undefined,
    );
    f.advance(20 * 60000);
    assert.throws(() => f.league.submit(userB.id, summary), /제출 시간이 종료/);
    assert.equal(
      (await request("/data/demo/papers/demo-reading-study/page-1.png")).status,
      404,
    );

    const expired = issueAccess(f.league, {
      id: "323456789012345678",
      displayName: "참가자 C",
    });
    f.advance(15 * 60000);
    assert.equal(
      (
        await request("/api/access/redeem", "POST", {
          token: rawToken(expired.url),
        })
      ).status,
      410,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
});

test("queue claims, retries, score validation, and tied rankings preserve one record per participant", async () => {
  const f = await fixture();
  try {
    const round = f.league.ensureRound()!;
    for (const id of ["a", "b"]) {
      f.league.start({ id, displayName: id });
      f.league.finish(id);
      f.league.submit(
        id,
        "원문의 문제 설정과 실험 설계를 분석하고, 관찰된 결과를 해석하면서 가능한 대안 설명과 일반화의 한계를 정리합니다. ".repeat(
          4,
        ),
      );
    }
    const first = f.league.claimGrade()!;
    const second = f.league.claimGrade()!;
    assert.notEqual(first.id, second.id);
    assert.equal(f.league.claimGrade(), null);
    f.league.completeGrade(first, demoGrade(round));
    f.league.failGrade(second);
    assert.equal(f.league.claimGrade(), null);
    f.advance(60000);
    const retry = f.league.claimGrade()!;
    assert.equal(retry.id, second.id);
    assert.equal(retry.gradingAttempts, 2);
    f.league.completeGrade(retry, demoGrade(round));
    const rankings = f.league.leaderboard("today");
    assert.deepEqual(
      rankings.map((r) => [r.rank, r.score, r.count]),
      [
        [1, 69, 1],
        [1, 69, 1],
      ],
    );
    assert.equal(
      f.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM attempts")!.n,
      2,
    );
    const { total, model, rubricVersion, demo, ...raw } = demoGrade(round);
    raw.criteria[4].score = 25;
    assert.throws(() => validateGrade(raw, round), /범위/);
    raw.criteria[4].score = 8;
    raw.criteria[4].key = "understanding";
    assert.throws(() => validateGrade(raw, round), /중복/);
  } finally {
    await f.cleanup();
  }
});

test("Discord modal submission keeps ownership, deadlines, and feedback in Discord", async () => {
  const f = await fixture();
  const client = new Client({ intents: [] });
  const calls: { method: string; body: any; files?: any[] }[] = [];
  const botUser = {
    id: "900000000000000001",
    username: "PaperLeague",
    discriminator: "0",
    avatar: null,
    bot: true,
  };
  const post = mock.method(
    client.rest,
    "post",
    async (_route: string, options?: RequestData) => {
      calls.push({ method: "POST", body: options?.body });
      return {};
    },
  );
  const patch = mock.method(
    client.rest,
    "patch",
    async (_route: string, options?: RequestData) => {
      calls.push({
        method: "PATCH",
        body: options?.body,
        files: options?.files,
      });
      return {
        id: "900000000000000002",
        channel_id: f.config.discord.channelId,
        author: botUser,
        content: "",
        timestamp: new Date().toISOString(),
        edited_timestamp: null,
        type: 0,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
        flags: 64,
      };
    },
  );
  const user = { id: "123456789012345678", displayName: "디스코드 참가자" };
  f.config.discord.guildId = "700000000000000001";
  f.config.discord.channelId = "700000000000000002";
  f.config.discord.allowedRoleId = "700000000000000003";
  let serial = 10n;
  const input = (
    data: object,
    type = 2,
    userId = user.id,
    roles = [f.config.discord.allowedRoleId],
  ): Interaction => {
    const payload = {
      id: String(900000000000000000n + serial++),
      application_id: botUser.id,
      type,
      data,
      token: "local-test-only",
      version: 1,
      guild_id: f.config.discord.guildId,
      channel: { id: f.config.discord.channelId, type: 0 },
      member: {
        user: {
          id: userId,
          username: "participant",
          discriminator: "0",
          avatar: null,
        },
        roles,
        permissions: "0",
        joined_at: new Date().toISOString(),
        deaf: false,
        mute: false,
      },
      app_permissions: "0",
      locale: "ko",
      guild_locale: "ko",
      entitlements: [],
      authorizing_integration_owners: { "0": f.config.discord.guildId },
    };
    return Reflect.construct(
      type === 5 ? ModalSubmitInteraction : ChatInputCommandInteraction,
      [client, payload],
    );
  };
  const command = (name: string, roles?: string[]) =>
    input({ id: "800000000000000001", name, type: 1 }, 2, user.id, roles);
  try {
    assert.ok(
      makeCommands().some((command) => command.toJSON().name === "submit"),
    );
    const started = f.league.start(user);
    await handleInteraction(command("submit"), f.league, f.config);
    assert.match(calls.at(-1)!.body.data.content, /아직 열람 중/);
    assert.equal(calls.at(-1)!.body.data.flags, 64);
    f.league.finish(user.id);
    const deadline = f.league.currentAttempt(user.id)!.submitBy;
    await handleInteraction(command("submit", []), f.league, f.config);
    assert.equal(calls.at(-1)!.body.type, 9);
    f.store.saveGuildSettings(
      f.config.discord.guildId!,
      f.config.discord.channelId!,
      f.config.discord.allowedRoleId,
    );
    await handleInteraction(command("submit", []), f.league, f.config);
    assert.match(calls.at(-1)!.body.data.content, /참가 역할/);
    await handleInteraction(command("submit"), f.league, f.config);
    const modalResponse = calls.at(-1)!.body;
    assert.equal(modalResponse.type, 9);
    const modal = modalResponse.data;
    assert.equal(modal.components.length, 5);
    const answers = [
      "이 자료는 실제 논문이 아닌 가상 교육용 글로, 핵심 주장과 증거를 구분하여 읽는 연습을 제안합니다.",
      "가상 참가자 열두 명의 읽기 노트 두 조건을 비교하며, 실험 설계와 관찰 결과를 분리합니다.",
      "구조화된 질문을 사용한 가상 집단의 예시 결과를 제시하지만, 실제 효과의 근거가 될 수 없습니다.",
      "모든 수치는 학습을 위한 예시이므로 실제 인과관계나 일반화의 근거로 사용해서는 안 됩니다.",
      "논문의 결론을 그대로 반복하기보다 연구 설계와 관찰 결과가 뒷받침하는 범위를 먼저 따져야 합니다.",
    ];
    const submission = {
      custom_id: modal.custom_id,
      components: modal.components.map((field: any, index: number) => ({
        type: 18,
        id: index + 1,
        component: {
          type: 4,
          custom_id: field.component.custom_id,
          value: answers[index],
        },
      })),
    };
    f.advance(60000);
    await handleInteraction(command("submit"), f.league, f.config);
    assert.equal(f.league.currentAttempt(user.id)!.submitBy, deadline);
    const other = { id: "223456789012345678", displayName: "다른 참가자" };
    f.league.start(other);
    f.league.finish(other.id);
    await handleInteraction(input(submission, 5, other.id), f.league, f.config);
    assert.equal(f.league.currentAttempt(other.id)!.summary, null);
    await handleInteraction(
      input(submission, 5, user.id, []),
      f.league,
      f.config,
    );
    assert.equal(f.league.currentAttempt(user.id)!.summary, null);
    await handleInteraction(input(submission, 5), f.league, f.config);
    assert.match(calls.at(-1)!.body.content, /정리를 접수/);
    assert.equal(f.league.currentAttempt(user.id)!.gradingStatus, "queued");
    const saved = f.league.currentAttempt(user.id)!.summary;
    assert.match(saved!, /핵심 주장과 증거/);
    await handleInteraction(input(submission, 5), f.league, f.config);
    assert.match(calls.at(-1)!.body.content, /이미 제출/);
    assert.equal(f.league.currentAttempt(user.id)!.summary, saved);
    const pending = f.league.claimGrade()!;
    const grade = demoGrade(f.league.ensureRound()!);
    grade.criteria[0].feedback =
      "충분한 근거를 바탕으로 평가하였습니다. ".repeat(60) + "마지막 근거";
    f.league.completeGrade(pending, grade);
    await handleInteraction(command("my-score"), f.league, f.config);
    const result = calls.at(-1)!;
    assert.match(result.body.embeds[0].title, /69\/100점/);
    assert.equal(result.body.embeds[0].fields.length, 7);
    assert.match(result.files![0].data.toString("utf8"), /마지막 근거/);
    await handleInteraction(command("ranking"), f.league, f.config);
    assert.match(calls.at(-1)!.body.embeds[0].description, /69점/);
    f.advance(24 * 60 * 60000);
    const next = f.league.start(user);
    f.league.finish(user.id);
    await handleInteraction(input(submission, 5), f.league, f.config);
    assert.match(calls.at(-1)!.body.content, /라운드가 종료/);
    assert.equal(f.store.getAttempt(next.id)!.summary, null);
    await handleInteraction(command("submit"), f.league, f.config);
    const latest = calls.at(-1)!.body.data;
    f.advance(20 * 60000);
    await handleInteraction(
      input({ ...submission, custom_id: latest.custom_id }, 5),
      f.league,
      f.config,
    );
    assert.match(calls.at(-1)!.body.content, /제출 시간이 종료/);
    assert.equal(f.store.getAttempt(next.id)!.summary, null);
    assert.notEqual(started.id, next.id);
  } finally {
    post.mock.restore();
    patch.mock.restore();
    await client.destroy();
    await f.cleanup();
  }
});

test("focus loss ends the reading permanently even when reported after reconnecting", async () => {
  const f = await fixture();
  try {
    const user = { id: "focus-loss", displayName: "포커스 종료 확인" };
    const started = f.league.start(user);
    const lostAt = f.league.now() + 60000;
    f.advance(35 * 60000);
    const ended = f.league.finish(user.id, started.id, lostAt);
    assert.equal(ended.readingEndsAt, lostAt);
    assert.equal(ended.submitBy, lostAt + 20 * 60000);
    assert.equal(ended.phase, "expired");
    assert.throws(() => f.league.readable(user.id), /열람 시간이 종료/);
    const retry = f.league.finish(user.id, started.id, f.league.now());
    assert.equal(retry.readingEndsAt, ended.readingEndsAt);
    assert.equal(retry.submitBy, ended.submitBy);
    const reopened = f.league.start(user);
    assert.equal(reopened.phase, "expired");
    f.advance(24 * 60 * 60000);
    const next = f.league.start(user);
    assert.throws(
      () => f.league.finish(user.id, started.id, lostAt),
      /라운드의 열람/,
    );
    assert.equal(
      f.league.currentAttempt(user.id)!.readingEndsAt,
      next.readingEndsAt,
    );
  } finally {
    await f.cleanup();
  }
});

test("server admins configure their own channels and role gates entirely through Discord", async () => {
  const f = await fixture();
  const client = new Client({ intents: [] });
  const bot = {
    id: "900000000000000001",
    username: "PaperLeague",
    discriminator: "0",
    avatar: null,
    bot: true,
  };
  Reflect.set(client, "user", bot);
  const guildA = "700000000000000001",
    guildB = "700000000000000002";
  const channelA = "710000000000000001",
    channelB = "710000000000000002";
  const roleA = "720000000000000001",
    roleB = "720000000000000002";
  let botPermissions = 117760n;
  const channels = new Map(
    [channelA, channelB].map((id, index) => [
      id,
      {
        id,
        guildId: index ? guildB : guildA,
        type: 0,
        isTextBased: () => true,
        isSendable: () => true,
        permissionsFor: () => new PermissionsBitField(botPermissions),
      },
    ]),
  );
  const fetchChannel = mock.method(
    client.channels,
    "fetch",
    async (id: any) => channels.get(id) as any,
  );
  const calls: any[] = [];
  const post = mock.method(
    client.rest,
    "post",
    async (_route: string, options?: RequestData) => {
      calls.push(options?.body);
      return {};
    },
  );
  const patch = mock.method(
    client.rest,
    "patch",
    async (_route: string, options?: RequestData) => {
      calls.push(options?.body);
      return {
        id: "900000000000000002",
        channel_id: channelA,
        author: bot,
        content: "",
        timestamp: new Date().toISOString(),
        edited_timestamp: null,
        type: 0,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
        flags: 64,
      };
    },
  );
  const latest = () => calls.at(-1).data || calls.at(-1);
  let serial = 20n;
  const input = (
    guildId: string,
    name: string,
    roles: string[] = [],
    manage = false,
    channelId = channelA,
    roleId = "",
  ) => {
    const options =
      name === "setup"
        ? [
            { name: "channel", type: 7, value: channelId },
            ...(roleId ? [{ name: "role", type: 8, value: roleId }] : []),
          ]
        : [];
    return Reflect.construct(ChatInputCommandInteraction, [
      client,
      {
        id: String(900000000000000000n + serial++),
        application_id: bot.id,
        type: 2,
        token: "local-test-only",
        version: 1,
        guild_id: guildId,
        channel: { id: guildId === guildA ? channelA : channelB, type: 0 },
        data: {
          id: "800000000000000001",
          name,
          type: 1,
          options,
          resolved: {
            channels: {
              [channelId]: {
                id: channelId,
                name: "papers",
                type: 0,
                permissions: "117760",
              },
            },
            roles: roleId
              ? {
                  [roleId]: {
                    id: roleId,
                    name: "readers",
                    color: 0,
                    hoist: false,
                    position: 1,
                    permissions: "0",
                    managed: false,
                    mentionable: false,
                  },
                }
              : {},
          },
        },
        member: {
          user: {
            id: "123456789012345678",
            username: "reader",
            discriminator: "0",
            avatar: null,
          },
          roles,
          permissions: manage ? String(PermissionFlagsBits.ManageGuild) : "0",
          joined_at: new Date().toISOString(),
          deaf: false,
          mute: false,
        },
        app_permissions: "117760",
        locale: "ko",
        guild_locale: "ko",
        entitlements: [],
        authorizing_integration_owners: { "0": guildId },
      },
    ]) as ChatInputCommandInteraction;
  };
  try {
    assert.equal(f.config.discord.guildId, undefined);
    const definitions = makeCommands().map((command) => command.toJSON());
    assert.equal(
      definitions.find((c) => c.name === "setup")!.default_member_permissions,
      String(PermissionFlagsBits.ManageGuild),
    );
    assert.ok(
      definitions.every(
        (c) =>
          c.contexts?.join() === "0" && c.integration_types?.join() === "0",
      ),
    );
    await handleInteraction(input(guildA, "paper"), f.league, f.config);
    assert.match(latest().components[0].components[0].url, /#access=/);
    await handleInteraction(input(guildA, "my-score"), f.league, f.config);
    assert.match(latest().content, /아직 읽기 세션/);
    await handleInteraction(input(guildA, "ranking"), f.league, f.config);
    assert.match(latest().embeds[0].title, /전체 서버/);
    assert.equal(f.store.getGuildSettings(guildA), undefined);
    await handleInteraction(input(guildA, "setup"), f.league, f.config);
    assert.match(latest().content, /서버 관리 권한/);
    assert.equal(f.store.getGuildSettings(guildA), undefined);
    await handleInteraction(
      input(guildA, "setup", [], true, channelB),
      f.league,
      f.config,
    );
    assert.equal(f.store.getGuildSettings(guildA), undefined);
    botPermissions = 0n;
    await handleInteraction(
      input(guildA, "setup", [], true, channelA),
      f.league,
      f.config,
    );
    assert.match(latest().content, /권한/);
    assert.equal(f.store.getGuildSettings(guildA), undefined);
    botPermissions = 117760n;
    await handleInteraction(
      input(guildA, "setup", [], true, channelA, roleA),
      f.league,
      f.config,
    );
    await handleInteraction(
      input(guildB, "setup", [], true, channelB, roleB),
      f.league,
      f.config,
    );
    assert.equal(f.store.getGuildSettings(guildA)!.allowedRoleId, roleA);
    assert.equal(f.store.getGuildSettings(guildB)!.allowedRoleId, roleB);
    await handleInteraction(
      input(guildB, "paper", [roleA]),
      f.league,
      f.config,
    );
    assert.match(latest().content, /참가 역할/);
    await handleInteraction(
      input(guildB, "paper", [roleB]),
      f.league,
      f.config,
    );
    assert.match(latest().components[0].components[0].url, /#access=/);
    const storedToken = f.store.get<{ guildId: string; channelId: string }>(
      "SELECT guildId,channelId FROM accessTokens",
    )!;
    assert.equal(storedToken.guildId, guildB);
    assert.equal(storedToken.channelId, channelB);
    await handleInteraction(
      input(guildA, "setup", [], true, channelA, guildA),
      f.league,
      f.config,
    );
    await handleInteraction(input(guildA, "paper"), f.league, f.config);
    assert.match(latest().components[0].components[0].url, /#access=/);
    await handleInteraction(
      input(guildA, "setup", [], true, channelA),
      f.league,
      f.config,
    );
    assert.equal(f.store.getGuildSettings(guildA)!.allowedRoleId, "");
    assert.equal(f.store.getGuildSettings(guildB)!.allowedRoleId, roleB);
    const reopened = new Store(f.config.dbPath);
    try {
      assert.deepEqual(
        reopened.listGuildSettings(),
        f.store.listGuildSettings(),
      );
    } finally {
      reopened.close();
    }
  } finally {
    fetchChannel.mock.restore();
    post.mock.restore();
    patch.mock.restore();
    await client.destroy();
    await f.cleanup();
  }
});

test("daily announcements reach every server and recover failures without duplicates", async () => {
  const f = await fixture();
  const guildA = "700000000000000001",
    guildB = "700000000000000002";
  const channelA = "710000000000000001",
    channelB = "710000000000000002",
    movedChannel = "710000000000000003";
  const botId = "900000000000000001";
  const sent: { channelId: string; nonce: string }[] = [];
  const remote = new Map<string, any[]>();
  let failA = true;
  const client = {
    user: { id: botId },
    guilds: {
      cache: new Map([
        [guildA, {}],
        [guildB, {}],
      ]),
    },
    channels: {
      fetch: async (id: string) => ({
        id,
        guildId: id === channelB ? guildB : guildA,
        type: 0,
        isTextBased: () => true,
        isSendable: () => true,
        permissionsFor: () => new PermissionsBitField(117760n),
        messages: { fetch: async () => remote.get(id) || [] },
        send: async (options: any) => {
          if (id === channelA && failA)
            throw new Error("simulated inaccessible channel");
          sent.push({ channelId: id, nonce: options.nonce });
          const message = {
            id: String(900000000000000010n + BigInt(sent.length)),
            author: { id: botId },
            embeds: options.embeds.map((e: any) => e.toJSON()),
          };
          remote.set(id, [message]);
          return message;
        },
      }),
    },
  } as unknown as Client;
  const errors = mock.method(console, "error", () => {});
  try {
    f.store.saveGuildSettings(guildA, channelA);
    f.store.saveGuildSettings(guildB, channelB);
    await announceDaily(f.league, client);
    assert.deepEqual(
      sent.map((item) => item.channelId),
      [channelB],
    );
    failA = false;
    await announceDaily(f.league, client);
    assert.deepEqual(
      sent.map((item) => item.channelId),
      [channelB, channelA],
    );
    const reopened = new Store(f.config.dbPath);
    try {
      await announceDaily(new League(reopened, f.config, f.league.now), client);
    } finally {
      reopened.close();
    }
    assert.equal(sent.length, 2);
    f.store.run(
      "UPDATE guildAnnouncements SET status='pending' WHERE guildId=?",
      guildB,
    );
    await announceDaily(f.league, client);
    assert.equal(sent.length, 2);
    assert.equal(
      f.store.get<{ status: string }>(
        "SELECT status FROM guildAnnouncements WHERE guildId=?",
        guildB,
      )!.status,
      "sent",
    );
    f.store.saveGuildSettings(guildA, movedChannel);
    await announceDaily(f.league, client);
    await announceDaily(f.league, client);
    assert.deepEqual(
      sent.map((item) => item.channelId),
      [channelB, channelA, movedChannel],
    );
    assert.equal(new Set(sent.map((item) => item.nonce)).size, 3);
    assert.ok(sent.every((item) => item.nonce.length <= 25));
    assert.equal(errors.mock.callCount(), 1);
  } finally {
    errors.mock.restore();
    await f.cleanup();
  }
});

test("daily rollover uses Seoul release time and saved attempts survive a new service instance", async () => {
  const f = await fixture();
  try {
    assert.equal(
      roundWindow(Date.parse("2026-09-07T23:59:59Z"), f.config).day,
      "2026-09-07",
    );
    assert.equal(
      roundWindow(Date.parse("2026-09-08T00:00:00Z"), f.config).day,
      "2026-09-08",
    );
    const original = f.league.start({
      id: "persistent",
      displayName: "기록 보존",
    });
    const round = f.league.ensureRound()!;
    issueAccess(f.league, { id: "persistent", displayName: "기록 보존" });
    f.store.run(
      "INSERT INTO sessions(tokenHash,userId,csrfToken,expiresAt,roundId) VALUES (?,?,?,?,?)",
      "legacy-session",
      "persistent",
      "legacy-csrf",
      round.closesAt,
      round.id,
    );
    f.store.run(
      "INSERT INTO announcements VALUES (?,?,?,?)",
      round.id,
      "sent",
      f.league.now(),
      "legacy-message",
    );
    // Reopen the previous single-server schema with real saved reading/token records.
    f.store.db.exec(
      "DROP TABLE guildAnnouncements; DROP TABLE guildSettings; ALTER TABLE sessions DROP COLUMN guildId; ALTER TABLE accessTokens DROP COLUMN guildId; ALTER TABLE sessions DROP COLUMN channelId; ALTER TABLE accessTokens DROP COLUMN channelId; PRAGMA user_version=2;",
    );
    const anotherStore = new Store(f.config.dbPath);
    try {
      anotherStore.importLegacyGuild(
        "700000000000000001",
        "710000000000000001",
        "720000000000000001",
      );
      assert.equal(
        anotherStore.get<{ guildId: string }>("SELECT guildId FROM sessions")!
          .guildId,
        "700000000000000001",
      );
      assert.equal(
        anotherStore.get<{ guildId: string }>(
          "SELECT guildId FROM accessTokens",
        )!.guildId,
        "700000000000000001",
      );
      assert.equal(
        anotherStore.get<{ status: string }>(
          "SELECT status FROM guildAnnouncements",
        )!.status,
        "sent",
      );
      anotherStore.saveGuildSettings(
        "700000000000000001",
        "710000000000000002",
      );
      anotherStore.importLegacyGuild(
        "700000000000000001",
        "710000000000000001",
        "720000000000000001",
      );
      assert.equal(
        anotherStore.getGuildSettings("700000000000000001")!.channelId,
        "710000000000000002",
      );
      const restarted = new League(anotherStore, f.config, f.league.now);
      assert.equal(
        restarted.start({ id: "persistent", displayName: "기록 보존" })
          .readingEndsAt,
        original.readingEndsAt,
      );
      assert.equal(restarted.currentAttempt("persistent")!.id, original.id);
    } finally {
      anotherStore.close();
    }
    f.advance(24 * 60 * 60000);
    assert.notEqual(f.league.ensureRound()!.id, "2026-09-08");
    assert.equal(f.league.currentAttempt("persistent"), undefined);
    assert.ok(f.store.getAttempt(original.id));
  } finally {
    await f.cleanup();
  }
});
