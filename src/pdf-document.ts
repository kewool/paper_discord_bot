import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Paper } from "./types.js";

const MAX_SOURCE_PDF_BYTES = 40 * 1024 * 1024;
const MAX_TRANSLATED_PDF_BYTES = 120 * 1024 * 1024;
const MAX_PAGES = 120;
const MAX_RENDER_EDGE = 1_600;
const MAX_RENDER_PIXELS = 2_500_000;
const MAX_EMBEDDED_IMAGE_PIXELS = 32_000_000;
const FETCH_TIMEOUT_MS = 90_000;
const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));

function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !rel.includes(":");
}

function isPdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from("%PDF-"))
  );
}

function renderScale(width: number, height: number): number {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("PDF 페이지 크기를 읽을 수 없습니다.");
  return Math.min(
    2.2,
    MAX_RENDER_EDGE / Math.max(width, height),
    Math.sqrt(MAX_RENDER_PIXELS / (width * height)),
  );
}

function arxivPdfUrl(sourceUrl: string): URL | undefined {
  let source: URL;
  try {
    source = new URL(sourceUrl);
  } catch {
    return undefined;
  }
  if (
    source.protocol !== "https:" ||
    source.hostname !== "arxiv.org" ||
    source.port ||
    source.search ||
    source.hash
  )
    return undefined;
  const match = source.pathname.match(
    /^\/abs\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(?:v\d+)?)$/i,
  );
  if (!match) return undefined;
  return new URL(`https://arxiv.org/pdf/${match[1]}`);
}

async function checkedLocalPdf(
  path: string,
  maximum: number,
): Promise<boolean> {
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size <= 0 || details.size > maximum)
      return false;
    const handle = await open(path, "r");
    try {
      const header = Buffer.alloc(5);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      return bytesRead === header.length && isPdf(header);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function fetchArxivPdf(
  url: URL,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, { signal: combined, redirect: "manual" });
  } catch (error) {
    if (combined.aborted)
      throw new Error("원문 PDF 다운로드 시간이 초과되었거나 취소되었습니다.");
    throw error;
  }
  if (response.status >= 300 && response.status < 400)
    throw new Error(
      "arXiv 원문 PDF 다운로드가 허용되지 않는 리디렉션을 반환했습니다.",
    );
  if (!response.ok || !response.body)
    throw new Error(`arXiv 원문 PDF를 받을 수 없습니다 (${response.status}).`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_PDF_BYTES) {
    await response.body.cancel();
    throw new Error("arXiv 원문 PDF가 40MB 제한을 초과합니다.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SOURCE_PDF_BYTES) {
        await reader.cancel();
        throw new Error("arXiv 원문 PDF가 40MB 제한을 초과합니다.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!isPdf(result)) throw new Error("arXiv 응답이 올바른 PDF가 아닙니다.");
  return result;
}

async function savePdfAtomically(
  target: string,
  bytes: Uint8Array,
): Promise<void> {
  const directory = dirname(target);
  const temporary = join(directory, `.source-${randomUUID()}.tmp`);
  if (!inside(directory, temporary))
    throw new Error("원문 PDF 임시 경로를 만들 수 없습니다.");
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Returns the cached original PDF, recovering only an explicitly saved arXiv source. */
export async function ensureOriginalPdf(
  paper: Paper,
  signal?: AbortSignal,
): Promise<string> {
  const directory = resolve(paper.directory);
  const target = resolve(directory, "source.pdf");
  if (!inside(directory, target))
    throw new Error("원문 PDF 경로가 올바르지 않습니다.");
  if (await checkedLocalPdf(target, MAX_SOURCE_PDF_BYTES)) return target;
  const url = arxivPdfUrl(paper.sourceUrl);
  if (!url)
    throw new Error("원문 PDF가 없습니다. 원본 PDF를 다시 가져와 주세요.");
  const bytes = await fetchArxivPdf(url, signal);
  await mkdir(directory, { recursive: true });
  // Another request may have populated the cache while this one downloaded it.
  if (await checkedLocalPdf(target, MAX_SOURCE_PDF_BYTES)) return target;
  await savePdfAtomically(target, bytes);
  return target;
}

/** Rasterizes a model-produced Korean PDF without rebuilding its typesetting. */
export async function renderTranslatedPdf(
  pdfPath: string,
  outputDirectory: string,
  signal?: AbortSignal,
): Promise<{ pageCount: number }> {
  if (signal?.aborted) throw new Error("번역 PDF 렌더링이 취소되었습니다.");
  const source = resolve(pdfPath);
  const details = await stat(source).catch(() => undefined);
  if (
    !details?.isFile() ||
    details.size <= 0 ||
    details.size > MAX_TRANSLATED_PDF_BYTES
  )
    throw new Error("번역 PDF는 120MB 이하의 파일이어야 합니다.");
  const bytes = new Uint8Array(await readFile(source));
  if (!isPdf(bytes)) throw new Error("번역 결과가 올바른 PDF가 아닙니다.");
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
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
    standardFontDataUrl: `${join(pdfjsRoot, "standard_fonts")}/`,
  });
  let document: Awaited<typeof loadingTask.promise> | undefined;
  try {
    document = await loadingTask.promise;
    if (document.numPages < 1 || document.numPages > MAX_PAGES)
      throw new Error("번역 PDF는 1~120페이지여야 합니다.");
    const pages: import("pdfjs-dist").PDFPageProxy[] = [];
    let hasHangul = false;
    for (let number = 1; number <= document.numPages; number += 1) {
      if (signal?.aborted) throw new Error("번역 PDF 렌더링이 취소되었습니다.");
      const page = await document.getPage(number);
      const content = await page.getTextContent({
        includeMarkedContent: false,
      });
      for (const item of content.items) {
        if ("str" in item && /[\uAC00-\uD7A3]/u.test(item.str)) {
          hasHangul = true;
          break;
        }
      }
      pages.push(page);
    }
    if (!hasHangul)
      throw new Error("번역 PDF에서 한국어 텍스트를 찾을 수 없습니다.");
    for (let number = 1; number <= pages.length; number += 1) {
      if (signal?.aborted) throw new Error("번역 PDF 렌더링이 취소되었습니다.");
      const page = pages[number - 1];
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: renderScale(base.width, base.height),
      });
      const canvas = createCanvas(
        Math.max(1, Math.ceil(viewport.width)),
        Math.max(1, Math.ceil(viewport.height)),
      );
      await page.render({
        canvas: canvas as never,
        canvasContext: canvas.getContext("2d") as never,
        viewport,
      }).promise;
      await writeFile(
        join(output, `page-${number}-1.png`),
        canvas.toBuffer("image/png"),
        { flag: "wx" },
      );
    }
    return { pageCount: document.numPages };
  } finally {
    document?.cleanup();
    await loadingTask.destroy();
  }
}
