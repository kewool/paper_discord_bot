import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { GlobalFonts } from "@napi-rs/canvas";

/**
 * The family name used by every server-side Korean canvas renderer.  The font
 * files ship with the application, so Docker's system font configuration is
 * never part of Korean glyph rendering.
 */
export const KOREAN_FONT = "Paper League Korean";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const fontDirectory = [
  resolve(moduleDirectory, "../public/fonts"),
  resolve(moduleDirectory, "../../public/fonts"),
].find((candidate) => existsSync(candidate));

if (!fontDirectory) {
  throw new Error(
    "번들 한글 폰트 디렉터리를 찾을 수 없습니다. public/fonts를 배포에 포함해 주세요.",
  );
}
const bundledFontDirectory = fontDirectory;

function registerBundledFont(fileName: string): void {
  const fontPath = resolve(bundledFontDirectory, fileName);
  if (!existsSync(fontPath)) {
    throw new Error(
      `번들 한글 폰트 파일이 없습니다: ${fontPath}. public/fonts를 배포에 포함해 주세요.`,
    );
  }
  try {
    if (!GlobalFonts.registerFromPath(fontPath, KOREAN_FONT)) {
      throw new Error("@napi-rs/canvas가 폰트를 등록하지 못했습니다.");
    }
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : "";
    throw new Error(
      `번들 한글 폰트를 등록하지 못했습니다: ${fontPath}${detail}`,
    );
  }
}

registerBundledFont("NanumGothic-Regular.ttf");
registerBundledFont("NanumGothic-Bold.ttf");

if (!GlobalFonts.has(KOREAN_FONT)) {
  throw new Error("번들 한글 폰트 등록 후 글꼴 패밀리를 찾을 수 없습니다.");
}
