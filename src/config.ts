import "dotenv/config";
import { resolve } from "node:path";
import { DateTime } from "luxon";
import {
  DEFAULT_PREFERRED_VENUES,
  type PaperSelectionWeights,
} from "./paper-selection.js";

export interface Config {
  demo: boolean;
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  dbPath: string;
  readingMinutes: number;
  writingMinutes: number;
  timeZone: string;
  releaseHour: number;
  model: string;
  codexTimeoutMs: number;
  trustProxy: number;
  paperSelection: {
    weights: PaperSelectionWeights;
    preferredVenues: readonly string[];
  };
  arxiv: {
    enabled: boolean;
    poolTarget: number;
    lookbackDays: number;
    userAgent: string;
  };
  discord: {
    botToken: string;
    clientId: string;
    /** Legacy single-guild settings retained for migration compatibility. */
    guildId?: string;
    channelId?: string;
    allowedRoleId?: string;
  };
}
export function loadConfig(env = process.env): Config {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value =
      env[key] === undefined || env[key] === "" ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`${key}: ${min}~${max} 정수가 필요합니다.`);
    return value;
  };
  const demo = env.DEMO_MODE === "true";
  if (demo && env.NODE_ENV === "production")
    throw new Error("운영 환경에서는 DEMO_MODE를 사용할 수 없습니다.");
  const port = integer("PORT", 3000, 1, 65535);
  const publicUrl = (env.PUBLIC_URL || `http://localhost:${port}`).replace(
    /\/$/,
    "",
  );
  const url = new URL(publicUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("PUBLIC_URL은 경로 없는 사이트 주소여야 합니다.");
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw new Error("외부 서비스의 PUBLIC_URL에는 HTTPS가 필요합니다.");
  const host = env.HOST || "127.0.0.1";
  if (demo && (!local || !["127.0.0.1", "localhost", "::1"].includes(host)))
    throw new Error("데모는 로컬 주소에서만 실행할 수 있습니다.");
  const dataDir = resolve(
    env.DATA_DIR || (demo ? "data/demo" : "data/production"),
  );
  const timeZone = env.TIME_ZONE || "Asia/Seoul";
  if (!DateTime.now().setZone(timeZone).isValid)
    throw new Error("TIME_ZONE이 올바르지 않습니다.");
  const preferredVenues = env.PAPER_PREFERRED_VENUES?.trim()
    ? [
        ...new Set(
          env.PAPER_PREFERRED_VENUES.split(",")
            .map((name) => name.trim())
            .filter(Boolean),
        ),
      ]
    : [...DEFAULT_PREFERRED_VENUES];
  if (
    !preferredVenues.length ||
    preferredVenues.length > 64 ||
    preferredVenues.some(
      (name) => name.length > 120 || /["\\\u0000-\u001f]/.test(name),
    )
  )
    throw new Error(
      "PAPER_PREFERRED_VENUES는 쉼표로 구분한 학회·저널 이름 1~64개여야 합니다.",
    );
  return {
    demo,
    port,
    host,
    publicUrl,
    dataDir,
    dbPath: resolve(dataDir, "league.sqlite"),
    readingMinutes: integer("READING_MINUTES", 30, 1, 180),
    writingMinutes: integer("WRITING_MINUTES", 20, 1, 180),
    releaseHour: integer("DAILY_RELEASE_HOUR", 9, 0, 23),
    timeZone,
    model: env.CODEX_MODEL || "gpt-5.6-terra",
    codexTimeoutMs: integer("CODEX_TIMEOUT_SECONDS", 180, 15, 600) * 1000,
    trustProxy: integer("TRUST_PROXY_HOPS", 0, 0, 5),
    paperSelection: {
      weights: {
        preferred: integer("PAPER_WEIGHT_PREFERRED", 5, 1, 100),
        published: integer("PAPER_WEIGHT_PUBLISHED", 2, 1, 100),
        unconfirmed: integer("PAPER_WEIGHT_UNCONFIRMED", 1, 1, 100),
      },
      preferredVenues,
    },
    arxiv: {
      enabled: !demo && env.ARXIV_ENABLED !== "false",
      poolTarget: integer("ARXIV_POOL_TARGET", 7, 1, 30),
      lookbackDays: integer("ARXIV_LOOKBACK_DAYS", 365, 7, 3650),
      userAgent:
        env.ARXIV_USER_AGENT ||
        "PaperLeague/0.1 (private daily research reading app)",
    },
    discord: {
      botToken: env.DISCORD_BOT_TOKEN || "",
      clientId: env.DISCORD_CLIENT_ID || "",
      guildId: env.DISCORD_GUILD_ID || undefined,
      channelId: env.DISCORD_CHANNEL_ID || undefined,
      allowedRoleId: env.DISCORD_ALLOWED_ROLE_ID || undefined,
    },
  };
}
