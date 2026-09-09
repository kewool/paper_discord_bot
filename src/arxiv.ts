import { randomInt, randomUUID } from "node:crypto";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { XMLParser } from "fast-xml-parser";
import type { Config } from "./config.js";
import type { League } from "./league.js";
import { importPaper } from "./papers.js";
import { classifyPublication, weightedOrder } from "./paper-selection.js";

const API = "https://export.arxiv.org/api/query";
const REQUEST_GAP_MS = 3_000;
const HOUR_MS = 60 * 60 * 1_000;
const MAX_ATOM_BYTES = 2 * 1024 * 1024;
const MAX_HTML_BYTES = 1 * 1024 * 1024;
const MAX_PDF_BYTES = 40 * 1024 * 1024;
const MODERN_ID = /^(\d{4}\.\d{4,5})v(\d+)$/;

type Candidate = {
  baseId: string;
  versionedId: string;
  title: string;
  authors: string;
  summary: string;
  category: string;
  journalRef: string;
  comment: string;
};
type SyncResult = { imported: number; skipped: number; cached: boolean };

class RetryableArxivError extends Error {}

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && "#text" in value)
    return text((value as Record<string, unknown>)["#text"]);
  return "";
}
function contained(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !rel.includes(":");
}

function parseAtom(xml: string): Candidate[] {
  if (xml.length > MAX_ATOM_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("arXiv Atom 응답 형식이 안전하지 않습니다.");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    removeNSPrefix: true,
    parseTagValue: false,
  });
  const parsed = parser.parse(xml) as { feed?: { entry?: unknown } };
  return asArray(parsed.feed?.entry).flatMap((raw): Candidate[] => {
    const entry = raw as Record<string, unknown>;
    const match = text(entry.id).match(/(?:abs\/)?(\d{4}\.\d{4,5}v\d+)\/?$/);
    if (!match) return [];
    const id = match[1].match(MODERN_ID);
    const title = text(entry.title).replace(/\s+/g, " ");
    const summary = text(entry.summary).replace(/\s+/g, " ");
    if (!id || !title || !summary || /^withdrawn\b/i.test(title)) return [];
    const authors = asArray(entry.author)
      .map((author) => text((author as Record<string, unknown>).name))
      .filter(Boolean)
      .join(", ");
    if (!authors) return [];
    const categories = asArray(entry.category);
    const primary = entry.primary_category as
      Record<string, unknown> | undefined;
    const category = String(
      primary?.["@_term"] ??
        (categories[0] as Record<string, unknown> | undefined)?.["@_term"] ??
        "",
    );
    return [
      {
        baseId: id[1],
        versionedId: match[1],
        title,
        authors,
        summary,
        category,
        journalRef: text(entry.journal_ref),
        comment: text(entry.comment),
      },
    ];
  });
}

function allowedLicense(html: string): string | undefined {
  if (html.length > MAX_HTML_BYTES)
    throw new Error("arXiv 라이선스 페이지가 너무 큽니다.");
  for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gi))
      attributes.set(match[1].toLowerCase(), match[3]);
    if (
      !/\blicense\b/i.test(attributes.get("rel") ?? "") &&
      !/\bhas_license\b/i.test(attributes.get("class") ?? "")
    )
      continue;
    const href = attributes.get("href");
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    if (url.hostname !== "creativecommons.org") continue;
    if (
      /^\/licenses\/by\/(2\.0|3\.0|4\.0)\/$/.test(url.pathname) ||
      url.pathname === "/publicdomain/zero/1.0/"
    )
      return href;
  }
  return undefined;
}

function atomicState(
  league: League,
  now: number,
  success: boolean,
  error: string | null,
): void {
  league.store.run(
    `INSERT INTO syncState(name,lastAttemptAt,lastSuccessAt,error) VALUES ('arxiv',?,?,?)
    ON CONFLICT(name) DO UPDATE SET lastAttemptAt=excluded.lastAttemptAt,lastSuccessAt=CASE WHEN ? THEN excluded.lastSuccessAt ELSE syncState.lastSuccessAt END,error=excluded.error`,
    now,
    success ? now : null,
    error,
    Number(success),
  );
}

function cache(
  league: League,
  candidate: Candidate,
  status: string,
  reason: string | null,
  paperId: string | null,
): void {
  league.store.run(
    `INSERT INTO arxivImports(arxivId,paperId,category,journalRef,comment,status,reason,updatedAt) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(arxivId) DO UPDATE SET paperId=excluded.paperId,category=excluded.category,journalRef=excluded.journalRef,comment=excluded.comment,status=excluded.status,reason=excluded.reason,updatedAt=excluded.updatedAt`,
    candidate.baseId,
    paperId,
    candidate.category,
    candidate.journalRef,
    candidate.comment,
    status,
    reason,
    league.now(),
  );
}

async function readBody(response: Response, limit: number): Promise<Buffer> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel();
    throw new Error("응답이 허용 크기를 초과했습니다.");
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > limit) throw new Error("응답이 허용 크기를 초과했습니다.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

function allowedRedirect(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    (url.hostname === "arxiv.org" || url.hostname === "export.arxiv.org")
  );
}

function requestGate(userAgent: string, signal?: AbortSignal) {
  let lastRequestAt = Date.now();
  return async (
    url: string,
    maxBytes: number,
  ): Promise<{ response: Response; body: Buffer }> => {
    for (
      let redirects = 0, current = new URL(url);
      redirects < 4;
      redirects += 1
    ) {
      if (!allowedRedirect(current))
        throw new Error("허용되지 않은 arXiv 요청 주소입니다.");
      const wait = Math.max(0, lastRequestAt + REQUEST_GAP_MS - Date.now());
      if (wait) await delay(wait, undefined, { signal });
      lastRequestAt = Date.now();
      const timeout = AbortSignal.timeout(30_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetch(current, {
          redirect: "manual",
          signal: combined,
          headers: { "User-Agent": userAgent },
        });
      } catch (error) {
        throw new Error(
          `arXiv 요청에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (response.status === 403 || response.status === 429) {
        await response.body?.cancel();
        throw new RetryableArxivError(
          `arXiv이 요청을 제한했습니다 (HTTP ${response.status}).`,
        );
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("arXiv 리디렉션 주소가 없습니다.");
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`arXiv 응답 오류: HTTP ${response.status}`);
      }
      return { response, body: await readBody(response, maxBytes) };
    }
    throw new Error("arXiv 리디렉션이 너무 많습니다.");
  };
}

export function arxivCandidateQueries(config: Config, now: number): URL[] {
  const from = new Date(now - config.arxiv.lookbackDays * 86_400_000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
  const to = new Date(now).toISOString().slice(0, 10).replaceAll("-", "");
  const dateQuery = `submittedDate:[${from}0000 TO ${to}2359]`;
  const general = new URL(API);
  general.searchParams.set("search_query", dateQuery);
  general.searchParams.set("start", String(randomInt(301)));
  general.searchParams.set("max_results", "80");
  general.searchParams.set("sortBy", "submittedDate");
  general.searchParams.set("sortOrder", "descending");
  const { weights, preferredVenues } = config.paperSelection;
  if (weights.preferred <= Math.min(weights.published, weights.unconfirmed))
    return [general];
  // Rotate a small set of venue names so the additional query stays bounded.
  const names = weightedOrder(preferredVenues, () => 1).slice(0, 4);
  const preferred = new URL(API);
  preferred.searchParams.set(
    "search_query",
    `${dateQuery} AND (${names
      .map((name) => `(jr:"${name}" OR co:"${name}")`)
      .join(" OR ")})`,
  );
  preferred.searchParams.set("start", "0");
  preferred.searchParams.set("max_results", "80");
  preferred.searchParams.set("sortBy", "lastUpdatedDate");
  preferred.searchParams.set("sortOrder", "descending");
  return [general, preferred];
}

export async function fetchArxivCandidates(
  config: Config,
  now: number,
  request: (url: string, maxBytes: number) => Promise<{ body: Buffer }>,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  const candidates = new Map<string, Candidate>();
  let lastError: unknown;
  for (const query of arxivCandidateQueries(config, now)) {
    signal?.throwIfAborted();
    try {
      const feed = await request(query.href, MAX_ATOM_BYTES);
      for (const candidate of parseAtom(feed.body.toString("utf8"))) {
        const previous = candidates.get(candidate.baseId);
        const version = (value: Candidate) =>
          Number(value.versionedId.split("v")[1]);
        if (!previous || version(candidate) > version(previous))
          candidates.set(candidate.baseId, candidate);
      }
    } catch (error) {
      if (signal?.aborted || error instanceof RetryableArxivError) throw error;
      lastError = error;
      console.warn("[arxiv] 일부 후보 검색을 완료하지 못했습니다.");
    }
  }
  if (!candidates.size)
    throw lastError ?? new Error("arXiv 응답에서 논문 후보를 찾지 못했습니다.");
  const { weights, preferredVenues } = config.paperSelection;
  return weightedOrder(
    [...candidates.values()],
    (candidate) =>
      weights[classifyPublication(candidate, preferredVenues).tier],
  );
}

export async function syncArxiv(
  league: League,
  config: Config,
  options: { force?: boolean; count?: number; signal?: AbortSignal } = {},
): Promise<SyncResult> {
  if (config.demo || !config.arxiv.enabled)
    return { imported: 0, skipped: 0, cached: true };
  const wanted = options.count ?? 2;
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > 5)
    throw new Error("arXiv 동기화 개수는 1~5여야 합니다.");
  const now = league.now();
  const state = league.store.get<{ lastAttemptAt: number }>(
    "SELECT lastAttemptAt FROM syncState WHERE name='arxiv'",
  );
  const unused = league.store.get<{
    count: number;
  }>(`SELECT COUNT(*) AS count FROM arxivImports ai
    JOIN papers p ON p.id=ai.paperId LEFT JOIN rounds r ON r.paperId=p.id
    WHERE ai.status='imported' AND ai.paperId IS NOT NULL AND r.paperId IS NULL`)!.count;
  if (
    !options.force &&
    ((state && now - state.lastAttemptAt < HOUR_MS) ||
      unused >= config.arxiv.poolTarget)
  )
    return { imported: 0, skipped: 0, cached: true };
  const limit = Math.min(wanted, Math.max(0, config.arxiv.poolTarget - unused));
  if (!limit) return { imported: 0, skipped: 0, cached: true };
  const owner = randomUUID();
  const claimed = league.store.transaction(() => {
    const lock = league.store.get<{ expiresAt: number }>(
      "SELECT expiresAt FROM sourceLocks WHERE name='arxiv'",
    );
    if (lock && lock.expiresAt > now) return false;
    league.store.run(
      "INSERT INTO sourceLocks VALUES ('arxiv',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expiresAt=excluded.expiresAt",
      owner,
      now + 10 * 60000,
    );
    return true;
  });
  if (!claimed) return { imported: 0, skipped: 0, cached: true };
  let imported = 0;
  let skipped = 0;
  const request = requestGate(config.arxiv.userAgent, options.signal);
  try {
    atomicState(league, now, false, null);
    const candidates = await fetchArxivCandidates(
      config,
      now,
      request,
      options.signal,
    );
    let absAttempts = 0;
    for (const candidate of candidates) {
      if (imported >= limit || absAttempts >= 12) break;
      if (options.signal?.aborted)
        throw (
          options.signal.reason ?? new Error("arXiv 동기화가 중단되었습니다.")
        );
      if (
        league.store.get<{ arxivId: string }>(
          "SELECT arxivId FROM arxivImports WHERE arxivId=?",
          candidate.baseId,
        )
      ) {
        skipped += 1;
        continue;
      }
      absAttempts += 1;
      const abs = await request(
        `https://arxiv.org/abs/${candidate.versionedId}`,
        MAX_HTML_BYTES,
      );
      const license = allowedLicense(abs.body.toString("utf8"));
      if (!license) {
        cache(
          league,
          candidate,
          "skipped",
          "허용된 Creative Commons 라이선스를 확인할 수 없습니다.",
          null,
        );
        skipped += 1;
        continue;
      }
      const pdf = await request(
        `https://arxiv.org/pdf/${candidate.versionedId}`,
        MAX_PDF_BYTES,
      );
      if (!pdf.body.subarray(0, 5).equals(Buffer.from("%PDF-")))
        throw new Error("arXiv PDF 응답이 올바르지 않습니다.");
      const workDir = resolve(config.dataDir, "import-work");
      const tempPath = resolve(workDir, `${randomUUID()}.pdf`);
      if (!contained(workDir, tempPath))
        throw new Error("임시 PDF 경로를 만들 수 없습니다.");
      let paperDirectory: string | undefined;
      try {
        await mkdir(workDir, { recursive: true });
        await writeFile(tempPath, pdf.body, { flag: "wx" });
        const paper = await importPaper(
          tempPath,
          {
            title: candidate.title,
            authors: candidate.authors,
            sourceUrl: `https://arxiv.org/abs/${candidate.versionedId}`,
            license,
          },
          config.dataDir,
        );
        paperDirectory = paper.directory;
        league.store.transaction(() => {
          league.store.addPaper(paper);
          cache(league, candidate, "imported", null, paper.id);
        });
        imported += 1;
      } catch (error) {
        if (paperDirectory) {
          if (contained(resolve(config.dataDir, "papers"), paperDirectory))
            await rm(paperDirectory, { recursive: true, force: true });
          throw error;
        }
        cache(
          league,
          candidate,
          "skipped",
          `PDF 변환 미지원: ${error instanceof Error ? error.message.slice(0, 300) : "오류"}`,
          null,
        );
        skipped += 1;
      } finally {
        await unlink(tempPath).catch(() => undefined);
      }
    }
    atomicState(league, league.now(), true, null);
    return { imported, skipped, cached: false };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.slice(0, 500)
        : String(error).slice(0, 500);
    atomicState(league, league.now(), false, message);
    throw error;
  } finally {
    league.store.run(
      "DELETE FROM sourceLocks WHERE name='arxiv' AND owner=?",
      owner,
    );
  }
}

export function startArxivWorker(
  league: League,
  config: Config,
): { stop: () => Promise<void> } {
  if (config.demo || !config.arxiv.enabled)
    return { stop: async () => undefined };
  const controller = new AbortController();
  let stopped = false;
  let running: Promise<unknown> | undefined;
  const run = () => {
    if (stopped || running) return;
    running = syncArxiv(league, config, { signal: controller.signal })
      .then((result) => {
        if (result.imported)
          console.log(
            `[arxiv] 논문 ${result.imported}편을 후보에 추가했습니다.`,
          );
      })
      .catch(() => {
        if (!stopped)
          console.error(
            "[arxiv] 수집을 완료하지 못했습니다. npm run admin -- status에서 확인해 주세요.",
          );
      })
      .finally(() => {
        running = undefined;
      });
  };
  run();
  const interval = setInterval(run, HOUR_MS);
  return {
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      controller.abort(new Error("arXiv 작업자가 종료되었습니다."));
      await running;
    },
  };
}
