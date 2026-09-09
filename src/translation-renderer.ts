import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { mathjax } from "@mathjax/src/js/mathjax.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import type { LiteElement } from "@mathjax/src/js/adaptors/lite/Element.js";
import { KOREAN_FONT } from "./fonts.js";
import type { TranslationBlock } from "./translation-types.js";

const WIDTH = 1200;
const HEIGHT = 1600;
const MAX_PIXELS = 2_500_000;
const MAX_SOURCE_EDGE = 1_600;
const MARGIN = 64;
const HEADER = 112;
const FOOTER = 48;
const BODY_BOTTOM = HEIGHT - FOOTER - 22;
const MAX_BLOCKS = 180;
const MAX_TOTAL_CHARS = 180_000;
const MAX_MATH_CHARS = 4_000;
const MAX_MATH_MACROS = 80;
const FONT = KOREAN_FONT;

type Context = ReturnType<ReturnType<typeof createCanvas>["getContext"]>;
type LineRun = {
  text?: string;
  image?: Awaited<ReturnType<typeof loadImage>>;
  width: number;
  height: number;
  fallback?: boolean;
  break?: boolean;
};
type Line = { runs: LineRun[]; height: number };
type SourceRegion = { x: number; y: number; width: number; height: number };
type FigureBlock = TranslationBlock & {
  sourceRegion?: SourceRegion | null;
};

let mathDocument: ReturnType<typeof mathjax.document> | undefined;
let mathAdaptor: ReturnType<typeof liteAdaptor> | undefined;

// SVG glyph groups are lazy-loaded by MathJax v4.  Restrict that loader to
// its installed font package; TeX can never turn this into a URL or a loader.
mathjax.asyncLoad ??= (name: string) => {
  if (!name.startsWith("@mathjax/mathjax-newcm-font/"))
    throw new Error("허용되지 않은 MathJax 로컬 모듈입니다.");
  return import(name);
};

function getMathDocument() {
  if (mathDocument) return mathDocument;
  mathAdaptor = liteAdaptor();
  RegisterHTMLHandler(mathAdaptor);
  const tex = new TeX({
    packages: ["base", "ams"],
    maxMacros: MAX_MATH_MACROS,
    maxBuffer: 20_000,
  });
  const svg = new SVG({ fontCache: "none" });
  mathDocument = mathjax.document("", { InputJax: tex, OutputJax: svg });
  return mathDocument;
}

function cleanText(value: string, label: string, maximum: number): string {
  if (typeof value !== "string")
    throw new Error(`${label} 형식이 올바르지 않습니다.`);
  const result = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim();
  if (!result) throw new Error(`${label}이 비어 있습니다.`);
  if (result.length > maximum) throw new Error(`${label}이 너무 깁니다.`);
  return result;
}

function boundedText(value: string, label: string, maximum: number): string {
  if (typeof value !== "string")
    throw new Error(`${label} 형식이 올바르지 않습니다.`);
  const result = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim();
  if (result.length > maximum) throw new Error(`${label}이 너무 깁니다.`);
  return result;
}

function setFont(ctx: Context, size: number, weight = "400") {
  ctx.font = `${weight} ${size}px "${FONT}"`;
}

function graphemes(text: string): string[] {
  return Array.from(text);
}

function plainRuns(
  ctx: Context,
  text: string,
  size: number,
  maxWidth: number,
): LineRun[] {
  setFont(ctx, size);
  const result: LineRun[] = [];
  for (const grapheme of graphemes(text)) {
    if (grapheme === "\n") {
      result.push({ width: 0, height: 0, break: true });
      continue;
    }
    const width = ctx.measureText(grapheme).width;
    if (width > maxWidth)
      throw new Error("번역 문자가 렌더링 너비를 초과합니다.");
    result.push({ text: grapheme, width, height: Math.ceil(size * 1.45) });
  }
  return result;
}

async function mathRun(
  tex: string,
  size: number,
  display: boolean,
  maxWidth: number,
): Promise<LineRun> {
  if (tex.length > MAX_MATH_CHARS) throw new Error("수식이 너무 깁니다.");
  if (
    /\\(?:require|autoload|href|url|html(?:Class|Data|Id|Style)?|includegraphics|input|write)\b/i.test(
      tex,
    )
  ) {
    return {
      text: tex,
      width: 0,
      height: Math.ceil(size * 1.45),
      fallback: true,
    };
  }
  try {
    const node = await mathjax.handleRetriesFor(() =>
      getMathDocument().convert(tex, { display }),
    );
    const svgNode = mathAdaptor!.firstChild(node);
    if (mathAdaptor!.kind(svgNode) !== "svg")
      throw new Error("SVG output invalid");
    const svg = mathAdaptor!.outerHTML(svgNode as LiteElement);
    const viewBox = /\bviewBox="[-.\d]+\s+[-.\d]+\s+([\d.]+)\s+([\d.]+)"/.exec(
      svg,
    );
    if (!svg.startsWith("<svg") || !viewBox || svg.length > 1_000_000)
      throw new Error("SVG output invalid");
    const width = Math.max(1, Math.ceil((Number(viewBox[1]) * size) / 1000));
    const height = Math.max(1, Math.ceil((Number(viewBox[2]) * size) / 1000));
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width > maxWidth ||
      height > BODY_BOTTOM - HEADER ||
      width * height > MAX_PIXELS
    ) {
      return {
        text: tex,
        width: 0,
        height: Math.ceil(size * 1.45),
        fallback: true,
      };
    }
    // Canvas does not resolve MathJax's `ex` intrinsic dimensions.  Rasterize
    // only at the final bounded pixel size, never at viewBox units.
    const canvasSvg = svg
      .replace(/\bwidth="[^"]*"/, `width="${width}"`)
      .replace(/\bheight="[^"]*"/, `height="${height}"`);
    const image = await loadImage(Buffer.from(canvasSvg));
    return { image, width, height };
  } catch {
    // Preserve the supplied TeX where typesetting is unavailable or invalid.
    return {
      text: tex,
      width: 0,
      height: Math.ceil(size * 1.45),
      fallback: true,
    };
  }
}

async function makeLines(
  ctx: Context,
  value: string,
  size: number,
  maxWidth: number,
): Promise<Line[]> {
  const pieces = value.split(/(\\\([\s\S]*?\\\))/g).filter(Boolean);
  const runs: LineRun[] = [];
  for (const piece of pieces) {
    const match = /^\\\(([\s\S]*?)\\\)$/.exec(piece);
    if (match) {
      const run = await mathRun(match[1], size, false, maxWidth);
      if (run.fallback) {
        const prefix = "[수식 렌더링 불가: ";
        runs.push(
          ...plainRuns(
            ctx,
            prefix + match[1] + "]",
            Math.max(17, size - 3),
            maxWidth,
          ),
        );
      } else runs.push(run);
    } else runs.push(...plainRuns(ctx, piece, size, maxWidth));
  }
  const lines: Line[] = [];
  let line: LineRun[] = [];
  let used = 0;
  let lineHeight = Math.ceil(size * 1.5);
  const flush = () => {
    if (line.length) lines.push({ runs: line, height: lineHeight });
    line = [];
    used = 0;
    lineHeight = Math.ceil(size * 1.5);
  };
  for (const run of runs) {
    if (run.break) {
      flush();
      continue;
    }
    if (run.width > maxWidth) {
      flush();
      lines.push({
        runs: [run],
        height: Math.max(Math.ceil(size * 1.6), run.height + 6),
      });
      continue;
    }
    if (used && used + run.width > maxWidth) flush();
    line.push(run);
    used += run.width;
    lineHeight = Math.max(lineHeight, run.height + 5);
  }
  flush();
  return lines.length ? lines : [{ runs: [], height: Math.ceil(size * 1.5) }];
}

function drawLine(
  ctx: Context,
  line: Line,
  x: number,
  y: number,
  size: number,
  color = "#202124",
  weight = "400",
) {
  let cursor = x;
  for (const run of line.runs) {
    if (run.image) {
      ctx.drawImage(
        run.image,
        cursor,
        y + Math.max(0, (line.height - run.height) / 2),
        run.width,
        run.height,
      );
    } else if (run.text) {
      setFont(ctx, run.fallback ? Math.max(17, size - 3) : size, weight);
      ctx.fillStyle = run.fallback ? "#8a4b12" : color;
      ctx.fillText(run.text, cursor, y + size);
    }
    cursor += run.width;
  }
}

function validate(
  blocks: readonly TranslationBlock[],
  meta: { title: string; page: number; pageCount: number },
) {
  cleanText(meta.title, "논문 제목", 2_000);
  if (
    !Number.isInteger(meta.page) ||
    !Number.isInteger(meta.pageCount) ||
    meta.page < 1 ||
    meta.page > meta.pageCount ||
    meta.pageCount > 40
  )
    throw new Error("페이지 정보가 올바르지 않습니다.");
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > MAX_BLOCKS)
    throw new Error("번역 블록 수가 허용 범위를 벗어났습니다.");
  let total = 0;
  for (const block of blocks) {
    if (
      !block ||
      ![
        "heading",
        "paragraph",
        "caption",
        "equation",
        "table",
        "reference",
        "figure",
      ].includes(block.kind)
    )
      throw new Error("번역 블록 종류가 올바르지 않습니다.");
    const blockText = boundedText(block.text, "번역 블록", 12_000);
    const isFigure = (block as { kind: string }).kind === "figure";
    if (!blockText && block.kind !== "table" && !isFigure)
      throw new Error("번역 블록이 비어 있습니다.");
    total += blockText.length;
    if (block.kind === "table") {
      if (
        !Array.isArray(block.rows) ||
        !block.rows.length ||
        block.rows.length > 100
      )
        throw new Error("표 행 수가 올바르지 않습니다.");
      for (const row of block.rows) {
        if (!Array.isArray(row) || !row.length || row.length > 12)
          throw new Error("표 열 수가 올바르지 않습니다.");
        for (const cell of row)
          total += boundedText(cell, "표 셀", 1_200).length;
      }
    }
    if (isFigure) {
      if (!Array.isArray(block.rows) || block.rows.length)
        throw new Error("그림 블록 행은 비어 있어야 합니다.");
      const region = (block as FigureBlock).sourceRegion;
      if (
        !region ||
        ![region.x, region.y, region.width, region.height].every(
          Number.isFinite,
        ) ||
        region.x < 0 ||
        region.y < 0 ||
        region.width <= 0 ||
        region.height <= 0 ||
        region.x + region.width > 1 ||
        region.y + region.height > 1
      )
        throw new Error("그림 원문 영역이 올바르지 않습니다.");
    }
  }
  if (total > MAX_TOTAL_CHARS) throw new Error("번역 페이지가 너무 큽니다.");
}

/** Renders one translated source page into one or more self-contained PNG sheets. */
export async function renderTranslationPages(
  blocks: readonly TranslationBlock[],
  meta: { title: string; page: number; pageCount: number },
  sourcePageImage?: Buffer,
): Promise<Buffer[]> {
  validate(blocks, meta);
  if (WIDTH * HEIGHT > MAX_PIXELS)
    throw new Error("렌더링 캔버스 크기가 허용 범위를 벗어났습니다.");
  const hasFigure = blocks.some(
    (block) => (block as { kind: string }).kind === "figure",
  );
  let sourceImage: Awaited<ReturnType<typeof loadImage>> | undefined;
  if (hasFigure) {
    if (!sourcePageImage?.length)
      throw new Error("그림 번역에는 원문 페이지 이미지가 필요합니다.");
    sourceImage = await loadImage(sourcePageImage);
    if (
      sourceImage.width < 1 ||
      sourceImage.height < 1 ||
      sourceImage.width > MAX_SOURCE_EDGE ||
      sourceImage.height > MAX_SOURCE_EDGE ||
      sourceImage.width * sourceImage.height > MAX_PIXELS
    )
      throw new Error("원문 페이지 이미지가 허용 범위를 벗어났습니다.");
  }
  const sheetCanvases: Canvas[] = [];
  let canvas = createCanvas(WIDTH, HEIGHT);
  let ctx = canvas.getContext("2d");
  let y = HEADER;
  const startSheet = () => {
    canvas = createCanvas(WIDTH, HEIGHT);
    ctx = canvas.getContext("2d");
    y = HEADER;
    ctx.fillStyle = "#fffefd";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = "#273447";
    ctx.fillRect(0, 0, WIDTH, 8);
    setFont(ctx, 19, "700");
    ctx.fillStyle = "#1e2b3a";
    ctx.fillText(meta.title, MARGIN, 40, WIDTH - MARGIN * 2);
    setFont(ctx, 15);
    ctx.fillStyle = "#627080";
    ctx.strokeStyle = "#d8dee5";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MARGIN, 88);
    ctx.lineTo(WIDTH - MARGIN, 88);
    ctx.stroke();
  };
  const finishSheet = () => {
    if (sheetCanvases.length >= 32)
      throw new Error("번역 결과가 최대 32장을 초과합니다.");
    sheetCanvases.push(canvas);
  };
  const next = () => {
    if (sheetCanvases.length >= 31)
      throw new Error("번역 결과가 최대 32장을 초과합니다.");
    finishSheet();
    startSheet();
  };
  startSheet();
  const ensure = (height: number) => {
    if (y + height > BODY_BOTTOM && y > HEADER) next();
  };

  for (const block of blocks) {
    const text = boundedText(block.text, "번역 블록", 12_000);
    if ((block as { kind: string }).kind === "figure") {
      const region = (block as FigureBlock).sourceRegion!;
      const caption = text
        ? await makeLines(ctx, text, 21, WIDTH - MARGIN * 2)
        : [];
      const captionHeight =
        caption.reduce((sum, line) => sum + line.height, 0) +
        (caption.length ? 18 : 0);
      const bodyHeight = BODY_BOTTOM - HEADER;
      // Keep a normal caption with its figure when both fit on one sheet.  A
      // pathological caption still flows intact after the image instead of
      // making the source crop disappear or shrink to nothing.
      const reservedCaption =
        captionHeight <= bodyHeight / 2 ? captionHeight : 0;
      const sourceX = Math.floor(region.x * sourceImage!.width);
      const sourceY = Math.floor(region.y * sourceImage!.height);
      const sourceWidth = Math.min(
        sourceImage!.width - sourceX,
        Math.max(1, Math.ceil(region.width * sourceImage!.width)),
      );
      const sourceHeight = Math.min(
        sourceImage!.height - sourceY,
        Math.max(1, Math.ceil(region.height * sourceImage!.height)),
      );
      const scale = Math.min(
        (WIDTH - MARGIN * 2) / sourceWidth,
        (bodyHeight - reservedCaption) / sourceHeight,
      );
      const renderedWidth = Math.max(1, Math.floor(sourceWidth * scale));
      const renderedHeight = Math.max(1, Math.floor(sourceHeight * scale));
      ensure(renderedHeight + reservedCaption);
      ctx.drawImage(
        sourceImage!,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        (WIDTH - renderedWidth) / 2,
        y,
        renderedWidth,
        renderedHeight,
      );
      y += renderedHeight;
      if (caption.length) {
        y += 6;
        for (const line of caption) {
          ensure(line.height);
          drawLine(ctx, line, MARGIN, y, 21, "#596775");
          y += line.height;
        }
        y += 12;
      }
      continue;
    }
    if (block.kind === "equation") {
      const run = await mathRun(text, 30, true, WIDTH - MARGIN * 2);
      if (run.fallback) {
        const lines = await makeLines(
          ctx,
          `[수식 렌더링 불가: ${text}]`,
          21,
          WIDTH - MARGIN * 2,
        );
        for (const line of lines) {
          ensure(line.height);
          drawLine(ctx, line, MARGIN, y, 21);
          y += line.height;
        }
      } else {
        if (run.width > WIDTH - MARGIN * 2 || run.height > BODY_BOTTOM - HEADER)
          throw new Error("수식이 한 장에 담기에는 너무 큽니다.");
        ensure(run.height + 22);
        ctx.drawImage(
          run.image!,
          (WIDTH - run.width) / 2,
          y,
          run.width,
          run.height,
        );
        y += run.height + 22;
      }
      continue;
    }
    if (block.kind === "table") {
      const columns = Math.max(...block.rows.map((row) => row.length));
      const tableWidth = WIDTH - MARGIN * 2;
      const cellWidth = tableWidth / columns;
      const drawRow = async (
        row: string[],
        header: boolean,
        repeatHeader = true,
      ) => {
        const cells = await Promise.all(
          row.map((cell) =>
            makeLines(
              ctx,
              boundedText(cell, "표 셀", 1_200),
              20,
              cellWidth - 18,
            ),
          ),
        );
        const offsets = cells.map(() => 0);
        while (
          offsets.some(
            (offset, column) => offset < (cells[column]?.length ?? 0),
          )
        ) {
          if (y + 38 > BODY_BOTTOM) {
            next();
            if (!header && repeatHeader)
              await drawRow(block.rows[0], true, false);
          }
          const available = BODY_BOTTOM - y - 18;
          const fragments = cells.map((lines, column) => {
            const result: Line[] = [];
            let height = 0;
            for (
              let index = offsets[column];
              index < lines.length;
              index += 1
            ) {
              if (height + lines[index].height > available) break;
              result.push(lines[index]);
              height += lines[index].height;
            }
            if (!result.length && offsets[column] < lines.length)
              throw new Error("표 셀의 한 줄이 한 장에 담기에는 너무 큽니다.");
            return result;
          });
          const height =
            Math.max(
              ...fragments.map((lines) =>
                lines.reduce((sum, line) => sum + line.height, 0),
              ),
            ) + 18;
          for (let column = 0; column < columns; column += 1) {
            const x = MARGIN + column * cellWidth;
            ctx.fillStyle = header ? "#e8eef5" : "#ffffff";
            ctx.fillRect(x, y, cellWidth, height);
            ctx.strokeStyle = "#9eabb8";
            ctx.strokeRect(x, y, cellWidth, height);
            let cellY = y + 8;
            for (const line of fragments[column] ?? []) {
              drawLine(ctx, line, x + 9, cellY, 20);
              cellY += line.height;
            }
            offsets[column] += fragments[column]?.length ?? 0;
          }
          y += height;
        }
      };
      if (text) {
        const label = await makeLines(ctx, text, 21, tableWidth);
        for (const line of label) {
          ensure(line.height);
          drawLine(ctx, line, MARGIN, y, 21, "#4c5967");
          y += line.height;
        }
        y += 6;
      }
      for (let i = 0; i < block.rows.length; i += 1) {
        if (i > 0 && y + 54 > BODY_BOTTOM) {
          next();
          await drawRow(block.rows[0], true, false);
        }
        await drawRow(block.rows[i], i === 0);
      }
      y += 18;
      continue;
    }
    const style =
      block.kind === "heading"
        ? { size: 30, weight: "700", color: "#142a43", before: 18, after: 12 }
        : block.kind === "caption"
          ? { size: 21, weight: "400", color: "#596775", before: 4, after: 12 }
          : block.kind === "reference"
            ? { size: 19, weight: "400", color: "#4f5964", before: 4, after: 8 }
            : {
                size: 26,
                weight: "400",
                color: "#202124",
                before: 4,
                after: 14,
              };
    const lines = await makeLines(ctx, text, style.size, WIDTH - MARGIN * 2);
    if (style.before) ensure(style.before);
    y += style.before;
    for (const line of lines) {
      ensure(line.height);
      drawLine(ctx, line, MARGIN, y, style.size, style.color, style.weight);
      y += line.height;
    }
    y += style.after;
  }
  finishSheet();
  return sheetCanvases.map((sheet, index) => {
    const sheetCtx = sheet.getContext("2d");
    sheetCtx.fillStyle = "#fffefd";
    sheetCtx.fillRect(MARGIN, 50, WIDTH - MARGIN * 2, 36);
    setFont(sheetCtx, 15);
    sheetCtx.fillStyle = "#627080";
    sheetCtx.fillText(
      `원문 ${meta.page}/${meta.pageCount} · 한국어 ${index + 1}/${sheetCanvases.length}쪽`,
      MARGIN,
      71,
    );
    return sheet.toBuffer("image/png");
  });
}
