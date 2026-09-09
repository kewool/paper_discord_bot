import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
  type Interaction,
  type RequestData,
} from "discord.js";
import { handleInteraction, makeCommands } from "../src/bot.js";

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
    const access = issueAccess(f.league, user);
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
        token: rawToken(issueAccess(f.league, userB).url),
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
        token: rawToken(issueAccess(f.league, user).url),
      }),
    );
    csrf = (
      await (await request("/api/state", "GET", undefined, cookie)).json()
    ).csrfToken;
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
    const anotherStore = new Store(f.config.dbPath);
    try {
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
