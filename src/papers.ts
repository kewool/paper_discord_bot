import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { readFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PaperInput } from "./types.js";
import {
  TRANSLATION_VERSION,
  TRANSLATION_VERSIONS,
} from "./translation-types.js";
import { KOREAN_FONT } from "./fonts.js";

const MAX_PDF_BYTES = 40 * 1024 * 1024;
const MAX_PAGES = 40;
const MAX_TEXT_CHARS = 120_000;
const MIN_TEXT_CHARS = 300;
const MAX_RENDER_EDGE = 1_600;
const MAX_RENDER_PIXELS = 2_500_000;
// Embedded figures can be much larger than the final downscaled page canvas.
const MAX_EMBEDDED_IMAGE_PIXELS = 32_000_000;
const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));

function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !rel.includes(":");
}

function cleanMeta(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${label}을(를) 입력해 주세요.`);
  if (result.length > 2_000) throw new Error(`${label}이(가) 너무 깁니다.`);
  return result;
}

function pageText(
  content: Awaited<
    ReturnType<import("pdfjs-dist").PDFPageProxy["getTextContent"]>
  >,
): string {
  let text = "";
  for (const item of content.items) {
    if (!("str" in item)) continue;
    text += item.str;
    if (item.hasEOL) text += "\n";
    else text += " ";
  }
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function renderScale(width: number, height: number): number {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("PDF 페이지 크기를 읽을 수 없습니다.");
  }
  return Math.min(
    2.2,
    MAX_RENDER_EDGE / Math.max(width, height),
    Math.sqrt(MAX_RENDER_PIXELS / (width * height)),
  );
}

export async function importPaper(
  filePath: string,
  meta: { title: string; authors: string; sourceUrl: string; license: string },
  dataDir: string,
): Promise<PaperInput> {
  const title = cleanMeta(meta.title, "제목");
  const authors = cleanMeta(meta.authors, "저자");
  const sourceUrl = cleanMeta(meta.sourceUrl, "출처 URL");
  const license = cleanMeta(meta.license, "라이선스");
  const source = resolve(filePath);
  let sourceStat;
  try {
    sourceStat = await stat(source);
  } catch {
    throw new Error("관리자 로컬 PDF 파일을 찾을 수 없습니다.");
  }
  if (!sourceStat.isFile())
    throw new Error("PDF 파일 경로가 올바르지 않습니다.");
  if (sourceStat.size <= 0 || sourceStat.size > MAX_PDF_BYTES)
    throw new Error("PDF는 40MB 이하만 가져올 수 있습니다.");

  const bytes = new Uint8Array(await readFile(source));
  const standardFontDataUrl = `${join(pdfjsRoot, "standard_fonts")}/`;
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    useWorkerFetch: false,
    useWasm: false,
    isOffscreenCanvasSupported: false,
    maxImageSize: MAX_EMBEDDED_IMAGE_PIXELS,
    stopAtErrors: true,
    canvasMaxAreaInBytes: MAX_RENDER_PIXELS * 4,
    standardFontDataUrl,
  });
  let document: Awaited<typeof loadingTask.promise> | undefined;
  let createdDirectory: string | undefined;
  try {
    document = await loadingTask.promise;
    if (document.numPages < 1 || document.numPages > MAX_PAGES)
      throw new Error("PDF는 1~40페이지만 가져올 수 있습니다.");

    const pages: Array<{
      page: import("pdfjs-dist").PDFPageProxy;
      text: string;
    }> = [];
    const textParts: string[] = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const extracted = pageText(
        await page.getTextContent({ includeMarkedContent: false }),
      );
      if (!extracted)
        throw new Error(
          `페이지 ${number}에서 텍스트를 추출할 수 없습니다. 스캔 PDF는 지원하지 않습니다.`,
        );
      pages.push({ page, text: extracted });
      textParts.push(`[Page ${number}]\n${extracted}`);
    }
    const text = textParts.join("\n\n");
    const meaningful = text.replace(/[^\p{L}\p{N}]+/gu, "");
    if (text.length < MIN_TEXT_CHARS || meaningful.length < MIN_TEXT_CHARS) {
      throw new Error(
        "추출된 본문이 너무 짧습니다. 텍스트 기반 PDF만 가져올 수 있습니다.",
      );
    }
    if (text.length > MAX_TEXT_CHARS)
      throw new Error(
        "추출된 본문이 너무 깁니다. 120,000자 이하 PDF만 가져올 수 있습니다.",
      );

    const id = randomUUID();
    const papersRoot = resolve(dataDir, "papers");
    const directory = resolve(papersRoot, id);
    if (!inside(papersRoot, directory))
      throw new Error("논문 저장 경로를 만들 수 없습니다.");
    await mkdir(papersRoot, { recursive: true });
    await mkdir(directory, { recursive: false });
    createdDirectory = directory;

    for (let index = 0; index < pages.length; index += 1) {
      const base = pages[index].page.getViewport({ scale: 1 });
      const scale = renderScale(base.width, base.height);
      const viewport = pages[index].page.getViewport({ scale });
      const canvas = createCanvas(
        Math.max(1, Math.ceil(viewport.width)),
        Math.max(1, Math.ceil(viewport.height)),
      );
      await pages[index].page.render({
        canvas: canvas as never,
        canvasContext: canvas.getContext("2d") as never,
        viewport,
      }).promise;
      await writeFile(
        join(directory, `page-${index + 1}.png`),
        canvas.toBuffer("image/png"),
        { flag: "wx" },
      );
    }
    return {
      id,
      title,
      authors,
      sourceUrl,
      license,
      pageCount: pages.length,
      text,
      directory,
      demo: false,
    };
  } catch (error) {
    if (createdDirectory) {
      const papersRoot = resolve(dataDir, "papers");
      if (inside(papersRoot, createdDirectory))
        await rm(createdDirectory, { recursive: true, force: true });
    }
    throw error;
  } finally {
    document?.cleanup();
    await loadingTask.destroy();
  }
}

export async function renderPage(
  paper: PaperInput,
  page: number,
  watermark: string,
  translation?: { artifactId: string; part: number; version?: string },
): Promise<Buffer> {
  if (!Number.isInteger(page) || page < 1 || page > paper.pageCount)
    throw new Error("요청한 페이지 번호가 올바르지 않습니다.");
  if (!watermark.trim() || watermark.length > 1_000)
    throw new Error("워터마크 정보가 올바르지 않습니다.");
  const directory = resolve(paper.directory);
  if (
    translation &&
    (!/^[a-f0-9-]{36}$/.test(translation.artifactId) ||
      !Number.isInteger(translation.part) ||
      translation.part < 1 ||
      translation.part > 32 ||
      !TRANSLATION_VERSIONS.includes(
        translation.version ?? TRANSLATION_VERSION,
      ))
  )
    throw new Error("번역 페이지 정보가 올바르지 않습니다.");
  const imagePath = translation
    ? resolve(
        directory,
        translation.version ?? TRANSLATION_VERSION,
        translation.artifactId,
        `page-${page}-${translation.part}.png`,
      )
    : resolve(directory, `page-${page}.png`);
  if (!inside(directory, imagePath))
    throw new Error("페이지 경로가 올바르지 않습니다.");
  const source = await loadImage(await readFile(imagePath));
  if (
    source.width > MAX_RENDER_EDGE ||
    source.height > MAX_RENDER_EDGE ||
    source.width * source.height > MAX_RENDER_PIXELS
  ) {
    throw new Error("저장된 페이지 이미지가 허용 범위를 벗어났습니다.");
  }
  const canvas = createCanvas(source.width, source.height + 26);
  const context = canvas.getContext("2d");
  context.drawImage(source, 0, 0);
  const stamp = watermark.replace(/[\r\n]+/g, " ").slice(0, 500);
  context.save();
  context.beginPath();
  context.rect(0, 0, source.width, source.height);
  context.clip();
  context.globalAlpha = 0.13;
  context.fillStyle = "#703c32";
  context.font = `18px "${KOREAN_FONT}"`;
  context.textAlign = "center";
  context.translate(source.width / 2, source.height / 2);
  context.rotate(-Math.PI / 8);
  const stepY = Math.max(180, source.height / 5);
  for (let y = -source.height; y <= source.height; y += stepY) {
    context.fillText(stamp, 0, y, source.width * 0.95);
  }
  context.restore();
  context.fillStyle = "rgba(20, 20, 20, 0.82)";
  context.fillRect(0, source.height, source.width, 26);
  context.fillStyle = "#ffffff";
  context.font = `11px "${KOREAN_FONT}"`;
  context.fillText(
    [paper.sourceUrl, paper.license, translation ? "번역" : ""]
      .filter(Boolean)
      .join(" · "),
    12,
    source.height + 17,
    source.width - 24,
  );
  return canvas.toBuffer("image/png");
}
