import assert from "node:assert/strict";
import test from "node:test";
import { renderTranslationPages } from "../src/translation-renderer.js";

test("renders Korean prose, TeX, and a table into bounded PNG sheets", async () => {
  const pages = await renderTranslationPages(
    [
      { kind: "heading", text: "실험 결과", rows: [] },
      {
        kind: "paragraph",
        text: "제안 방법은 \\(O(n \\log n)\\) 시간에 동작하며 한국어 본문과 수식을 함께 표시합니다.",
        rows: [],
      },
      { kind: "equation", text: "\\frac{a+b}{c} = \\sqrt{x}", rows: [] },
      {
        kind: "table",
        text: "표 1. 비교 결과",
        rows: [
          ["방법", "정확도"],
          ["제안", "94.2%"],
        ],
      },
    ],
    { title: "번역 렌더러 검증", page: 1, pageCount: 1 },
  );
  assert.ok(pages.length >= 1);
  for (const page of pages) {
    assert.equal(page.subarray(1, 4).toString("ascii"), "PNG");
    assert.ok(page.length > 1_000);
  }
});

test("continues long translated prose onto another sheet", async () => {
  const pages = await renderTranslationPages(
    [
      {
        kind: "paragraph",
        text: "긴 번역 문단을 안전하게 다음 시트로 이어서 표시합니다. ".repeat(
          90,
        ),
        rows: [],
      },
    ],
    { title: "페이지 분할", page: 2, pageCount: 5 },
  );
  assert.ok(pages.length > 1);
});
