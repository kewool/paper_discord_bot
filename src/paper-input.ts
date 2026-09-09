import type { UserInput } from "@openai/codex-sdk";
import { resolve } from "node:path";
import type { Paper } from "./types.js";

export function paperPageTexts(
  paper: Pick<Paper, "text" | "pageCount">,
): string[] {
  if (
    !paper.text ||
    paper.text.length > 120000 ||
    !Number.isInteger(paper.pageCount) ||
    paper.pageCount < 1 ||
    paper.pageCount > 40
  )
    throw new Error("원문의 길이 또는 페이지 수가 지원 범위를 벗어났습니다.");
  const markers = [...paper.text.matchAll(/^\[Page (\d+)\]\r?$/gm)];
  if (
    markers.length !== paper.pageCount ||
    markers.some((m, i) => Number(m[1]) !== i + 1)
  )
    throw new Error("원문의 페이지 구분을 확인할 수 없습니다.");
  return markers.map((marker, i) => {
    const text = paper.text
      .slice(marker.index! + marker[0].length, markers[i + 1]?.index)
      .trim();
    if (!text) throw new Error("비어 있는 원문 페이지입니다.");
    return text;
  });
}

export function paperModelInput(paper: Paper, prompt: string): UserInput[] {
  paperPageTexts(paper);
  // Codex attaches images in this order; PDF page numbers never refer to translated sheets.
  return [
    { type: "text", text: prompt },
    ...Array.from({ length: paper.pageCount }, (_, index): UserInput => ({
      type: "local_image",
      path: resolve(paper.directory, `page-${index + 1}.png`),
    })),
  ];
}
