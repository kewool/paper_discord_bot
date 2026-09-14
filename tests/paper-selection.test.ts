import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { League, roundWindow } from "../src/league.js";
import { GRADING_VERSION } from "../src/types.js";
import { issueAccess } from "../src/auth.js";
import { syncArxiv } from "../src/arxiv.js";
import {
  classifyPublication,
  pickWeightedIndex,
  weightedOrder,
} from "../src/paper-selection.js";

test("classifies publication metadata conservatively", () => {
  assert.equal(
    classifyPublication({
      comment:
        "Accepted at the 43rd International Conference on Machine Learning (ICML 2026)",
    }).tier,
    "preferred",
  );
  assert.equal(
    classifyPublication({ comment: "Accepted as regular paper at ICML 2026" })
      .tier,
    "preferred",
  );
  assert.equal(
    classifyPublication({ comment: "Not yet accepted at ICML 2026" }).tier,
    "unconfirmed",
  );
  assert.equal(
    classifyPublication({ journalRef: "Journal of Science 12 (2026)" }).tier,
    "published",
  );
  assert.equal(
    classifyPublication({ journalRef: "Phys. Rev. Lett. 137, 010001 (2026)" }, [
      "Physical Review Letters",
    ]).tier,
    "preferred",
  );
  assert.equal(
    classifyPublication({ journalRef: "NeurIPS 2026" }).tier,
    "preferred",
  );
  assert.equal(
    classifyPublication({ comment: "Submitted to NeurIPS 2026" }).tier,
    "unconfirmed",
  );
  assert.equal(
    classifyPublication({
      comment: "Accepted at a local workshop; compared against ICML baselines",
    }).tier,
    "published",
  );
  assert.equal(
    classifyPublication({ journalRef: "Nature Communications" }).tier,
    "published",
  );
  assert.equal(
    classifyPublication({ journalRef: "Science Advances" }).tier,
    "published",
  );
  assert.equal(
    classifyPublication({ journalRef: "Nature Medicine" }).tier,
    "published",
  );
  assert.equal(
    classifyPublication({ journalRef: "ICML 2026 Workshop on X" }).tier,
    "published",
  );
  assert.equal(
    classifyPublication({ comment: "Accepted at the NeurIPS 2026 Workshop" })
      .tier,
    "published",
  );
  assert.equal(
    classifyPublication({ comment: "Submitted to the ICML 2026 Workshop" })
      .tier,
    "unconfirmed",
  );
  assert.equal(
    classifyPublication({ comment: "Accepted to NeurIPS2026 (Workshop on X)" })
      .tier,
    "published",
  );
  assert.equal(
    classifyPublication({ comment: "Accepted to NeurIPS2026" }).tier,
    "preferred",
  );
  assert.equal(
    classifyPublication({ journalRef: "Cell Reports 12 (2026)" }).tier,
    "published",
  );
  assert.equal(
    classifyPublication({
      comment:
        "Proceedings of a local symposium. We compare with ICML baselines",
    }).tier,
    "published",
  );
  assert.equal(
    classifyPublication({ comment: "Presented at ICML 2026" }).tier,
    "preferred",
  );
  assert.equal(
    classifyPublication({ comment: "Accepted by ICML 2026" }).tier,
    "preferred",
  );
  assert.equal(
    classifyPublication({
      comment: "Accepted for publication in Physical Review Letters",
    }).tier,
    "preferred",
  );
  assert.equal(
    classifyPublication({ comment: "Accepted for publication" }).tier,
    "published",
  );
  assert.equal(
    classifyPublication({
      comment: "Accepted at a local symposium. We compare with ICML baselines",
    }).tier,
    "published",
  );
  assert.equal(
    classifyPublication({ comment: "Proceedings of ICML 2026" }).tier,
    "preferred",
  );
  assert.equal(
    classifyPublication({ comment: "Accepted baseline compared with ICML" })
      .tier,
    "unconfirmed",
  );
  assert.equal(
    classifyPublication({
      journalRef: "Journal of Testing",
      comment: "Rejected by NeurIPS",
    }).tier,
    "published",
  );
});

test("weighted picker respects 5:2:1 boundaries", () => {
  assert.equal(
    pickWeightedIndex(
      [5, 2, 1],
      (value) => value,
      () => 0,
    ),
    0,
  );
  assert.equal(
    pickWeightedIndex(
      [5, 2, 1],
      (value) => value,
      () => 0.624999,
    ),
    0,
  );
  assert.equal(
    pickWeightedIndex(
      [5, 2, 1],
      (value) => value,
      () => 0.625,
    ),
    1,
  );
  assert.equal(
    pickWeightedIndex(
      [5, 2, 1],
      (value) => value,
      () => 0.875,
    ),
    2,
  );
  assert.equal(
    pickWeightedIndex(
      [],
      () => 1,
      () => 0,
    ),
    -1,
  );
});

test("weighted order samples without replacement", () => {
  const values = weightedOrder(
    ["a", "b", "c"],
    (item) => ({ a: 5, b: 2, c: 1 })[item]!,
    () => 0.99,
  );
  assert.deepEqual(values, ["c", "b", "a"]);
});

test("unused legacy assignments carry forward until someone starts reading", () => {
  const config = loadConfig({
    PUBLIC_URL: "https://example.test",
    TRANSLATION_ENABLED: "false",
  });
  const store = new Store(":memory:");
  let now = Date.parse("2026-09-13T01:00:00Z");
  const league = new League(store, config, () => now);
  const legacy = (day: string, paperId: string) => {
    const window = roundWindow(Date.parse(`${day}T01:00:00Z`), config);
    store.run(
      "INSERT INTO rounds VALUES (?,?,?,?,?,?,?,?,?)",
      day,
      day,
      paperId,
      window.opensAt,
      window.closesAt,
      30,
      20,
      config.model,
      GRADING_VERSION,
    );
  };
  try {
    for (const id of ["a", "b", "c"])
      store.addPaper({
        id,
        title: id,
        authors: "fixture",
        sourceUrl: "https://example.test",
        license: "fixture",
        text: "fixture",
        pageCount: 1,
        directory: "unused",
        demo: false,
      });
    legacy("2026-09-10", "a");
    legacy("2026-09-11", "b");
    legacy("2026-09-12", "c");
    legacy("2026-09-13", "c");
    assert.equal(
      league.ensureRound()!.paperId,
      "a",
      "repair today's unused legacy selection",
    );
    assert.equal(
      store.getRound("2026-09-11")!.paperId,
      "b",
      "preserve historical records",
    );
    const user = { id: "123456789012345678", displayName: "reader" };
    issueAccess(league, user);
    now += 86400000;
    const carried = league.ensureRound()!;
    assert.equal(carried.paperId, "a", "a link alone does not consume a paper");
    assert.equal(carried.day, "2026-09-14");
    const attempt = league.start(user);
    const savedAttempt = store.getAttempt(attempt.id);
    assert.equal(savedAttempt!.submittedAt, null);
    config.model = "different-future-model";
    assert.deepEqual(
      { ...league.ensureRound() },
      carried,
      "a started round must never be rewritten",
    );
    now += 86400000;
    const next = league.ensureRound()!;
    assert.notEqual(
      next.paperId,
      "a",
      "reading counts even without a submission",
    );
    assert.deepEqual(store.getAttempt(attempt.id), savedAttempt);
    // Simulate further rotations by the old version after the last used round.
    legacy("2026-09-16", "a");
    legacy("2026-09-17", "a");
    now += 2 * 86400000;
    assert.equal(
      new League(store, config, () => now).ensureRound()!.paperId,
      next.paperId,
    );
    now += 3 * 86400000;
    assert.equal(
      league.ensureRound()!.paperId,
      next.paperId,
      "carry through skipped days too",
    );
  } finally {
    store.close();
  }
});

test("arxiv counts assigned but unread papers as available inventory", async () => {
  const config = loadConfig({
    PUBLIC_URL: "https://example.test",
    ARXIV_POOL_TARGET: "1",
  });
  const store = new Store(":memory:");
  try {
    store.addPaper({
      id: "unread",
      title: "unread",
      authors: "fixture",
      sourceUrl: "https://example.test",
      license: "fixture",
      text: "fixture",
      pageCount: 1,
      directory: "unused",
      demo: false,
    });
    store.run(
      "INSERT INTO arxivImports VALUES (?,?,?,?,?,?,?,?)",
      "2609.00001",
      "unread",
      "cs.AI",
      "",
      "",
      "imported",
      null,
      0,
    );
    const league = new League(store, config, () =>
      Date.parse("2026-09-13T01:00:00Z"),
    );
    league.ensureRound();
    assert.deepEqual(
      await syncArxiv(league, config, { signal: AbortSignal.abort() }),
      { imported: 0, skipped: 0, cached: true },
    );
    assert.equal(store.get("SELECT * FROM syncState"), undefined);
  } finally {
    store.close();
  }
});
