import { Codex, type ThreadOptions } from "@openai/codex-sdk";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, access } from "node:fs/promises";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import type { Store } from "./store.js";
import type { Paper } from "./types.js";
import type { PaperTranslation } from "./translation-types.js";
import { TRANSLATION_RENDER_VERSION } from "./translation-types.js";
import { pdfTranslationCodexOptions } from "./codex.js";
import { ensureOriginalPdf, renderTranslatedPdf } from "./pdf-document.js";
import { bundledFontDirectory } from "./fonts.js";

export const PDF_TRANSLATION_PROMPT =
  "source.pdf 논문 전체를 한국어로 번역해 translated.pdf로 저장해 주세요. 원문의 한 단·두 단 구성, 제목, 문단, 표, 수식, 그림과 배치를 유지하고 번역만 하세요. 요약하거나 내용을 생략하지 마세요. 논문 전체 문맥에 맞춰 용어를 일관되게 번역하고, 한글 분량에 따라 페이지 수가 달라져도 괜찮습니다. 완성된 PDF를 이미지로 열어 원문과 배치 및 한글 표시를 확인해 주세요.";

type PdfCheckpoint = {
  kind: "pdf";
  workId: string;
  threadId?: string;
  completed?: boolean;
};

function checkpoint(raw: string | undefined): PdfCheckpoint | undefined {
  if (!raw) return;
  const value = JSON.parse(raw) as PdfCheckpoint;
  if (
    value.kind !== "pdf" ||
    !/^[0-9a-f-]{36}$/i.test(value.workId) ||
    (value.threadId !== undefined && !/^[0-9a-f-]{36}$/i.test(value.threadId))
  )
    throw new Error("저장된 PDF 번역 작업 정보가 올바르지 않습니다.");
  return value;
}

/** The model owns translation and document layout; this code only runs and publishes its PDF. */
export async function translatePdfJob(
  store: Store,
  job: PaperTranslation,
  paper: Paper,
  config: Config,
  signal?: AbortSignal,
) {
  if (job.version !== "ko-v4" || !job.leaseOwner)
    throw new Error("PDF 번역 작업 정보가 올바르지 않습니다.");
  const saved = checkpoint(job.draftJson) ?? {
    kind: "pdf",
    workId: randomUUID(),
  };
  const directory = resolve(config.dataDir, "pdf-translator", saved.workId);
  const persist = () => {
    if (
      !store.run(
        "UPDATE paperTranslations SET draftJson=?,updatedAt=? WHERE paperId=? AND leaseOwner=?",
        JSON.stringify(saved),
        Date.now(),
        paper.id,
        job.leaseOwner!,
      ).changes
    )
      throw new Error("번역 작업이 교체되어 중단했습니다.");
  };
  persist();
  await mkdir(directory, { recursive: true });
  if (process.platform === "linux") {
    // Existing protected metadata directories let the legacy sandbox enforce read-only access.
    for (const name of [".git", ".codex", ".agents"])
      await mkdir(resolve(directory, name), { recursive: true });
  }
  const source = await ensureOriginalPdf(paper, signal);
  await copyFile(source, resolve(directory, "source.pdf"));
  const fontsDirectory = resolve(directory, "fonts");
  await mkdir(fontsDirectory, { recursive: true });
  // Pass font files as assets, without prescribing how the model typesets the PDF.
  for (const name of ["NanumGothic-Regular.ttf", "NanumGothic-Bold.ttf"])
    await copyFile(
      resolve(bundledFontDirectory, name),
      resolve(fontsDirectory, name),
    );

  if (!saved.completed) {
    const codex = new Codex(pdfTranslationCodexOptions());
    const options: ThreadOptions = {
      model: job.model,
      workingDirectory: directory,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      modelReasoningEffort: "medium",
    };
    const thread = saved.threadId
      ? codex.resumeThread(saved.threadId, options)
      : codex.startThread(options);
    const timeout = AbortSignal.timeout(config.translation.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const started = Date.now();
    let lastEventAt = started,
      lastEvent = "요청 전송",
      completed = false;
    const progress = setInterval(
      () =>
        console.log(
          `[translation] ${paper.id}: PDF 번역 ${Math.round((Date.now() - started) / 1000)}초 · ${lastEvent} · 마지막 응답 ${Math.round((Date.now() - lastEventAt) / 1000)}초 전`,
        ),
      30000,
    );
    try {
      const run = await thread.runStreamed(
        saved.threadId
          ? `${PDF_TRANSLATION_PROMPT}\n이전에 중단된 작업입니다. 작업 폴더에 저장된 번역과 중간 파일부터 이어서 완성해 주세요.`
          : PDF_TRANSLATION_PROMPT,
        { signal: combined },
      );
      for await (const event of run.events) {
        lastEventAt = Date.now();
        lastEvent = event.type;
        if (event.type === "thread.started") {
          saved.threadId = event.thread_id;
          persist();
        }
        if (event.type === "turn.failed") throw new Error(event.error.message);
        if (event.type === "error") throw new Error(event.message);
        if (
          event.type === "item.started" ||
          event.type === "item.completed" ||
          event.type === "item.updated"
        )
          lastEvent = `${event.type}/${event.item.type}`;
        if (event.type === "turn.completed") {
          completed = true;
          console.log(
            `[translation] ${paper.id}: PDF 번역 응답 완료 · 입력 ${event.usage.input_tokens} / 출력 ${event.usage.output_tokens} 토큰`,
          );
        }
      }
      combined.throwIfAborted();
      if (!completed)
        throw new Error("Codex가 PDF 번역 완료를 반환하지 않았습니다.");
      await access(resolve(directory, "translated.pdf")).catch(() => {
        throw new Error(
          "Codex 응답은 끝났지만 translated.pdf가 생성되지 않았습니다.",
        );
      });
      saved.completed = true;
      persist();
    } catch (error) {
      if (timeout.aborted && !signal?.aborted) {
        const expired = new Error(
          `PDF 번역이 ${config.translation.timeoutMs / 1000}초 제한을 초과했습니다. 저장된 작업에서 이어서 재시도합니다.`,
        );
        expired.name = "TimeoutError";
        throw expired;
      }
      throw error;
    } finally {
      clearInterval(progress);
    }
  }

  signal?.throwIfAborted();
  const artifactId = randomUUID();
  const artifactDirectory = resolve(paper.directory, job.version, artifactId);
  console.log(`[translation] ${paper.id}: 완성된 PDF를 열람 이미지로 변환`);
  let result: { pageCount: number };
  try {
    result = await renderTranslatedPdf(
      resolve(directory, "translated.pdf"),
      artifactDirectory,
      signal,
    );
  } catch (error) {
    if (!signal?.aborted) {
      saved.completed = false;
      persist();
    }
    throw error;
  }
  signal?.throwIfAborted();
  return store.transaction(() => {
    if (
      !store.get(
        "SELECT 1 FROM paperTranslations WHERE paperId=? AND leaseOwner=?",
        paper.id,
        job.leaseOwner!,
      )
    )
      return false;
    store.run("DELETE FROM translatedPages WHERE paperId=?", paper.id);
    for (let page = 1; page <= result.pageCount; page++)
      store.run(
        "INSERT INTO translatedPages(paperId,page,contentJson,partCount,artifactId,createdAt,renderVersion) VALUES(?,?,?,1,?,?,?)",
        paper.id,
        page,
        "{}",
        artifactId,
        Date.now(),
        TRANSLATION_RENDER_VERSION,
      );
    store.run(
      `UPDATE paperTranslations SET status='ready',completedPages=?,attempts=0,nextAttemptAt=0,
      leaseOwner=NULL,leaseUntil=0,error=NULL,updatedAt=? WHERE paperId=? AND leaseOwner=?`,
      paper.pageCount,
      Date.now(),
      paper.id,
      job.leaseOwner!,
    );
    console.log(
      `[translation] ${paper.id}: 한국어 PDF ${result.pageCount}쪽 준비 완료`,
    );
    return true;
  });
}
