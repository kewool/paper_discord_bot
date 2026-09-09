import test from "node:test";
import assert from "node:assert/strict";
import { arxivCandidateQueries, fetchArxivCandidates } from "../src/arxiv.js";
import { loadConfig } from "../src/config.js";
import { classifyPublication } from "../src/paper-selection.js";

const now = Date.parse("2026-09-10T00:00:00Z");
const config = loadConfig({
  PUBLIC_URL: "https://example.test",
  PAPER_PREFERRED_VENUES: "ICML,Physical Review Letters",
});
const entry = (
  id: string,
  fields = "",
) => `<entry><id>https://arxiv.org/abs/${id}</id>
  <title>Test paper</title><summary>Test abstract</summary><author><name>Author</name></author>
  <category term="physics.optics"/>${fields}</entry>`;
const feed = (...entries: string[]) =>
  Buffer.from(
    `<feed xmlns:arxiv="http://arxiv.org/schemas/atom">${entries.join("")}</feed>`,
  );

test("venue search supplements all-subject candidates, deduplicates versions and tolerates one failed search", async () => {
  const queries = arxivCandidateQueries(config, now);
  assert.equal(queries.length, 2);
  assert.equal(
    queries.some((url) =>
      url.searchParams.get("search_query")!.includes("cat:"),
    ),
    false,
  );
  assert.match(
    queries[1].searchParams.get("search_query")!,
    /jr:"ICML" OR co:"ICML"/,
  );
  assert.match(
    queries[1].searchParams.get("search_query")!,
    /Physical Review Letters/,
  );
  const candidates = await fetchArxivCandidates(config, now, async (url) => ({
    body: new URL(url).searchParams.get("search_query")!.includes("jr:")
      ? feed(
          entry(
            "2609.00001v2",
            "<arxiv:comment>Accepted at ICML 2026</arxiv:comment>",
          ),
        )
      : feed(entry("2609.00001v1"), entry("2609.00002v1")),
  }));
  assert.equal(candidates.length, 2);
  const preferred = candidates.find(
    (candidate) => candidate.baseId === "2609.00001",
  )!;
  assert.equal(preferred.versionedId, "2609.00001v2");
  assert.equal(classifyPublication(preferred).tier, "preferred");
  const fallback = await fetchArxivCandidates(config, now, async (url) => {
    if (new URL(url).searchParams.get("search_query")!.includes("jr:"))
      throw new Error("temporary source failure");
    return { body: feed(entry("2609.00002v1")) };
  });
  assert.equal(fallback[0].baseId, "2609.00002");
});

test("selection settings support equal weights and validate custom venue query terms", () => {
  const uniform = loadConfig({
    PUBLIC_URL: "https://example.test",
    PAPER_WEIGHT_PREFERRED: "1",
    PAPER_WEIGHT_PUBLISHED: "1",
    PAPER_WEIGHT_UNCONFIRMED: "1",
  });
  assert.equal(arxivCandidateQueries(uniform, now).length, 1);
  assert.throws(
    () => loadConfig({ PAPER_WEIGHT_PREFERRED: "0" }),
    /PAPER_WEIGHT_PREFERRED/,
  );
  assert.throws(
    () => loadConfig({ PAPER_PREFERRED_VENUES: 'ICML" OR all:x' }),
    /PAPER_PREFERRED_VENUES/,
  );
});
