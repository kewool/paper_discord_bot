import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { mkdir, mkdtemp, rm, access } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Server } from "node:http";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { League } from "../src/league.js";
import { createApp } from "../src/server.js";
import { issueAccess } from "../src/auth.js";
import { seedDemo } from "../scripts/seed-demo.js";
import { resetPapers } from "../src/maintenance.js";
import {
  claimTranslation,
  queueTranslations,
  retryTranslation,
  saveTranslationPage,
  translationState,
  validatePaperTranslation,
  applyTranslationReview,
  rerenderTranslations,
  applyPaperLayout,
  describeTranslationError,
} from "../src/translation.js";
import type { TranslationPage } from "../src/translation-types.js";

test("translation diagnostics retain the failure reason without credentials or response payloads", () => {
  const detail = describeTranslationError(
    new Error(
      "HTTP 401: invalid credentials; Bearer secret-value; api_key=sk-test-secret",
    ),
  );
  assert.match(detail, /HTTP 401: invalid credentials/);
  assert.doesNotMatch(detail, /secret-value|sk-test-secret/);
  assert.doesNotMatch(
    describeTranslationError(
      new Error('Failed to parse item: {"paper":"private source"}'),
    ),
    /private source/,
  );
  const invalid = z
    .object({ pages: z.array(z.number()) })
    .safeParse({ pages: ["private source"] });
  assert.equal(invalid.success, false);
  if (!invalid.success) {
    const diagnostic = describeTranslationError(invalid.error);
    assert.match(diagnostic, /pages.0/);
    assert.doesNotMatch(diagnostic, /private source/);
  }
});

test("translation resumes saved pages, waits before timing, and serves only protected PNGs", async () => {
  const root = resolve("work");
  await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(resolve(root, "translation-test-"));
  const config = loadConfig({
    DEMO_MODE: "true",
    TRANSLATION_ENABLED: "true",
    DATA_DIR: dataDir,
  });
  let store = new Store(config.dbPath);
  let server: Server | undefined;
  try {
    await seedDemo(store, dataDir);
    config.demo = false;
    store.run("UPDATE papers SET demo=0");
    let league = new League(store, config, () =>
      Date.parse("2026-09-10T01:00:00Z"),
    );
    const paper = store.getPaper(league.ensureRound()!.paperId)!;
    const user = { id: "423456789012345678", displayName: "번역 검증" };
    queueTranslations(store, config);
    assert.equal(translationState(store, paper.id, true).status, "pending");
    assert.throws(() => league.start(user), /아직 제한시간은 시작되지/);
    assert.equal(
      store.get<{ n: number }>("SELECT COUNT(*) AS n FROM attempts")!.n,
      0,
    );
    const translated = (page: number): TranslationPage => ({
      page,
      complete: true,
      layout: { columns: 1 },
      glossary: [],
      blocks: [
        {
          kind: "heading",
          text: `한국어 검증 페이지 ${page}`,
          rows: [],
          span: "full",
        },
        {
          kind: "paragraph",
          text: "가상의 참가자와 결과를 사용한 예시이며 실제 연구 결과로 인용할 수 없습니다. 관찰은 인과관계나 일반화 가능성을 입증하지 않으며 연구의 방법과 한계를 구분해야 합니다. ".repeat(
            page === 2 ? 24 : 2,
          ),
          rows: [],
          span: "column",
        },
      ],
    });
    const first = claimTranslation(store, config)!;
    const layout = {
      pages: [1, 2, 3].map((page) => ({
        page,
        layout: { columns: page === 2 ? 2 : 1 },
        spans: ["full", "column"],
      })),
    };
    const annotated = applyPaperLayout(
      layout,
      [1, 2, 3].map(translated),
      paper,
    );
    assert.equal(annotated[1].layout.columns, 2);
    assert.equal(annotated[1].blocks[1].text, translated(2).blocks[1].text);
    assert.throws(
      () =>
        applyPaperLayout(
          { pages: layout.pages.slice(1) },
          [1, 2, 3].map(translated),
          paper,
        ),
      /전체/,
    );
    const wholePaper = validatePaperTranslation(
      {
        complete: true,
        pages: [1, 2, 3].map((page) => ({
          ...translated(page),
          blocks: translated(page).blocks.map((block) => ({
            ...block,
            sourceRegion: null,
          })),
        })),
      },
      paper,
    );
    assert.throws(
      () =>
        validatePaperTranslation(
          { ...wholePaper, pages: wholePaper.pages.slice(0, 2) },
          paper,
        ),
      /전체 번역/,
    );
    assert.throws(
      () =>
        applyTranslationReview(
          { verified: false, corrections: [] },
          wholePaper,
          paper,
        ),
      /검수/,
    );
    const verified = applyTranslationReview(
      { verified: true, corrections: [] },
      wholePaper,
      paper,
    );
    store.run(
      "UPDATE paperTranslations SET draftJson=?,verifiedJson=? WHERE paperId=?",
      JSON.stringify(wholePaper),
      JSON.stringify(verified),
      paper.id,
    );
    assert.equal(
      claimTranslation(store, config),
      null,
      "a live lease cannot be reclaimed",
    );
    assert.equal(
      await saveTranslationPage(store, first, paper, translated(1)),
      true,
    );
    const saved = store.get<{ contentJson: string; artifactId: string }>(
      "SELECT contentJson,artifactId FROM translatedPages WHERE paperId=? AND page=1",
      paper.id,
    )!;
    store.close();
    store = new Store(config.dbPath);
    league = new League(store, config, league.now);
    queueTranslations(store, config);
    const second = claimTranslation(store, config)!;
    assert.equal(second.completedPages, 1, "restart resumes from page 2");
    assert.deepEqual(
      JSON.parse(second.verifiedJson!),
      verified,
      "restart preserves the complete verified translation",
    );
    store.run(
      "UPDATE paperTranslations SET leaseUntil=0 WHERE paperId=?",
      paper.id,
    );
    const replacement = claimTranslation(store, config)!;
    assert.equal(
      await saveTranslationPage(store, second, paper, translated(2)),
      false,
      "stale worker cannot publish",
    );
    assert.equal(
      await saveTranslationPage(store, replacement, paper, translated(2)),
      true,
    );
    assert.equal(
      await saveTranslationPage(
        store,
        claimTranslation(store, config)!,
        paper,
        translated(3),
      ),
      true,
    );
    assert.equal(translationState(store, paper.id, true).status, "ready");
    assert.deepEqual(
      {
        ...(store.get(
          "SELECT contentJson,artifactId FROM translatedPages WHERE paperId=? AND page=1",
          paper.id,
        ) as object),
      },
      { ...saved },
    );
    assert.equal(claimTranslation(store, config), null);
    assert.equal(
      retryTranslation(store, paper.id),
      0,
      "ready translations are shared and reused",
    );
    store.run(
      "UPDATE paperTranslations SET version='ko-v1' WHERE paperId=?",
      paper.id,
    );
    store.run(
      "UPDATE translatedPages SET renderVersion=1 WHERE paperId=?",
      paper.id,
    );
    assert.equal(translationState(store, paper.id, true).status, "pending");
    assert.throws(() => league.start(user), /아직 제한시간은 시작되지/);
    assert.equal(
      await rerenderTranslations(store),
      3,
      "rebuild old PNGs from stored text without a model call",
    );
    assert.equal(translationState(store, paper.id, true).status, "ready");
    const app = createApp(league, config);
    server = await new Promise<Server>((done) => {
      const listener = app.listen(0, "127.0.0.1", () => done(listener));
    });
    const port = (server.address() as { port: number }).port;
    config.publicUrl = `http://127.0.0.1:${port}`;
    const request = (path: string, options: RequestInit = {}) =>
      fetch(`${config.publicUrl}${path}`, options);
    assert.equal((await request("/api/attempt/translation/1")).status, 401);
    const invitation = issueAccess(league, user);
    const token = new URLSearchParams(
      new URL(invitation.url).hash.slice(1),
    ).get("access");
    const redeemed = await request("/api/access/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: config.publicUrl },
      body: JSON.stringify({ token }),
    });
    assert.equal(redeemed.status, 200);
    const cookie = redeemed.headers.get("set-cookie")!.split(";")[0];
    const headers = { Cookie: cookie };
    assert.equal(
      (await request("/api/attempt/translation/1", { headers })).status,
      403,
    );
    const attempt = league.start(user);
    const response = await request("/api/attempt/translation/2?part=1", {
      headers,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /^image\/png/);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    assert.ok(Number(response.headers.get("x-page-parts")) > 1);
    const png = Buffer.from(await response.arrayBuffer());
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(
      (await request("/api/attempt/translation/2?part=2", { headers })).status,
      200,
    );
    assert.equal(
      (await request("/api/attempt/translation/1?part=32", { headers })).status,
      404,
    );
    const state = await (await request("/api/state", { headers })).json();
    assert.equal(state.translation.status, "ready");
    assert.equal(JSON.stringify(state).includes("가상의 참가자와 결과"), false);
    assert.equal(
      (
        await request(
          `/papers/${paper.id}/ko-v1/${saved.artifactId}/page-1-1.png`,
          { headers },
        )
      ).status,
      404,
    );
    league.finish(user.id, attempt.id);
    assert.equal(
      (await request("/api/attempt/translation/1", { headers })).status,
      410,
    );
    assert.equal(
      (await request("/api/attempt/page/1", { headers })).status,
      410,
    );
    await new Promise<void>((done) => server!.close(() => done()));
    server = undefined;
    resetPapers(store, dataDir, true);
    assert.equal(
      store.get<{ n: number }>("SELECT COUNT(*) AS n FROM translatedPages")!.n,
      0,
    );
    assert.equal(
      store.get<{ n: number }>("SELECT COUNT(*) AS n FROM paperTranslations")!
        .n,
      0,
    );
    await assert.rejects(access(paper.directory));
  } finally {
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    store.close();
    if (!resolve(dataDir).startsWith(root + sep))
      throw new Error("Unexpected test path");
    await rm(dataDir, { recursive: true, force: true });
  }
});
