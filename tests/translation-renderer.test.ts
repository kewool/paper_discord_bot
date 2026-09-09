import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
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

test("copies a requested original figure region into the translated sheet", async () => {
  const source = createCanvas(400, 300);
  const sourceContext = source.getContext("2d");
  sourceContext.fillStyle = "#ffffff";
  sourceContext.fillRect(0, 0, 400, 300);
  sourceContext.fillStyle = "#00c853";
  sourceContext.fillRect(200, 60, 120, 120);
  const pages = await renderTranslationPages(
    [
      {
        kind: "figure",
        text: "그림 1. 원문 도표",
        rows: [],
        sourceRegion: { x: 0.5, y: 0.2, width: 0.3, height: 0.4 },
      },
    ],
    { title: "그림 보존", page: 1, pageCount: 1 },
    source.toBuffer("image/png"),
  );
  const rendered = await loadImage(pages[0]);
  const output = createCanvas(rendered.width, rendered.height);
  const outputContext = output.getContext("2d");
  outputContext.drawImage(rendered, 0, 0);
  const pixel = outputContext.getImageData(128, 176, 1, 1).data;
  assert.ok(pixel[1] > 150 && pixel[0] < 40 && pixel[2] < 120);
});
