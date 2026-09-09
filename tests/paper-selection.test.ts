import assert from "node:assert/strict";
import test from "node:test";
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
