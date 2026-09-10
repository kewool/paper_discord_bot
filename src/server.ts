import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Auth } from "./auth.js";
import { AppError, League } from "./league.js";
import type { Config } from "./config.js";
import type { User } from "./types.js";
import { renderPage } from "./papers.js";

export function createApp(league: League, config: Config) {
  const app = express();
  const auth = new Auth(league, config);
  app.disable("x-powered-by");
  app.disable("etag");
  app.set("trust proxy", config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "blob:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.publicUrl.startsWith("https:")
            ? []
            : null,
        },
      },
      referrerPolicy: { policy: "no-referrer" },
      strictTransportSecurity: config.publicUrl.startsWith("https:"),
    }),
  );
  app.use((_req, res, next) => {
    res.set("Cache-Control", "private, no-store, max-age=0");
    res.set("Pragma", "no-cache");
    next();
  });
  app.use(
    rateLimit({
      windowMs: 60000,
      limit: 2400,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
    }),
  );
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.use(["/api", "/auth/logout"], async (req, res, next) => {
    res.locals.session = await auth.read(req);
    next();
  });
  const requireSession = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!res.locals.session)
      throw new AppError(401, "디스코드 봇에서 전용 열람 링크를 받아 주세요.");
    next();
  };
  const protect = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    auth.csrf(req, res.locals.session.csrfToken as string);
    if (!req.is("application/json"))
      throw new AppError(415, "JSON 형식으로 요청해 주세요.");
    next();
  };
  const mutationLimit = rateLimit({
    windowMs: 60000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req, res) =>
      res.locals.session?.user.id || ipKeyGenerator(req.ip || "127.0.0.1"),
    message: { error: "변경 요청이 너무 많습니다. 잠시 기다려 주세요." },
  });
  const loginLimit = rateLimit({
    windowMs: 60000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "로그인 요청이 너무 많습니다. 잠시 기다려 주세요." },
  });
  app.get("/api/state", (_req, res) =>
    res.json(
      league.state(
        res.locals.session?.user || null,
        res.locals.session?.csrfToken || null,
        res.locals.session?.guildId || "",
        res.locals.session?.channelId || "",
      ),
    ),
  );
  app.post("/api/access/redeem", loginLimit, (req, res) => {
    auth.redeem(req, res, req.body?.token);
    res.json({ ok: true });
  });
  app.post("/api/demo-login", loginLimit, (req, res) => {
    auth.demo(req, res);
    res.json({ ok: true });
  });
  app.post("/auth/logout", requireSession, protect, (req, res) => {
    auth.logout(req, res);
    res.json({ ok: true });
  });
  app.post(
    "/api/attempt/start",
    mutationLimit,
    requireSession,
    protect,
    (_req, res) => {
      res.json({
        attempt: league.readerView(
          league.start(res.locals.session.user as User),
        ),
      });
    },
  );
  app.post(
    "/api/attempt/finish",
    mutationLimit,
    requireSession,
    protect,
    (req, res) => {
      if (typeof req.body?.attemptId !== "string")
        throw new AppError(422, "종료할 열람 기록이 필요합니다.");
      res.json({
        attempt: league.readerView(
          league.finish(
            res.locals.session.user.id as string,
            req.body.attemptId,
            req.body.focusLostAt,
          ),
        ),
      });
    },
  );
  app.get("/api/attempt/page/:page", requireSession, async (req, res) => {
    if (!/^\d{1,2}$/.test(String(req.params.page)))
      throw new AppError(404, "존재하지 않는 페이지입니다.");
    const userId = res.locals.session.user.id as string;
    const { paper, attempt } = league.readable(userId);
    const page = Number(req.params.page);
    if (page < 1 || page > paper.pageCount)
      throw new AppError(404, "존재하지 않는 페이지입니다.");
    const stamp = `DISCORD ${userId} | ${attempt.roundId} | EXPIRES ${new Date(attempt.readingEndsAt).toISOString()}`;
    const png = await renderPage(paper, page, stamp);
    const fresh = league.readable(userId);
    if (fresh.attempt.id !== attempt.id)
      throw new AppError(410, "이 라운드의 열람이 종료되었습니다.");
    res.type("png").set("Content-Disposition", "inline").send(png);
  });
  app.get(
    "/api/attempt/translation/:page",
    requireSession,
    async (req, res) => {
      if (!config.translation.enabled)
        throw new AppError(404, "한국어 번역이 비활성화되어 있습니다.");
      if (
        !/^\d{1,3}$/.test(String(req.params.page)) ||
        !/^\d{1,2}$/.test(String(req.query.part ?? "1"))
      )
        throw new AppError(404, "존재하지 않는 번역 페이지입니다.");
      const userId = res.locals.session.user.id as string;
      const { paper, attempt } = league.readable(userId);
      const page = Number(req.params.page),
        part = Number(req.query.part ?? "1");
      const versionRow = league.store.get<{ version: string }>(
        "SELECT version FROM paperTranslations WHERE paperId=? AND status='ready'",
        paper.id,
      );
      if (!versionRow) throw new AppError(409, "한국어 번역을 준비 중입니다.");
      const maxPage = versionRow.version === "ko-v4" ? 120 : paper.pageCount;
      if (page < 1 || page > maxPage || part < 1 || part > 32)
        throw new AppError(404, "존재하지 않는 번역 페이지입니다.");
      const translation = league.store.get<{
        partCount: number;
        artifactId: string;
      }>(
        "SELECT partCount,artifactId FROM translatedPages WHERE paperId=? AND page=?",
        paper.id,
        page,
      );
      if (!translation) throw new AppError(409, "한국어 번역을 준비 중입니다.");
      if (part > translation.partCount)
        throw new AppError(404, "존재하지 않는 번역 페이지입니다.");
      const stamp = `DISCORD ${userId} | ${attempt.roundId} | EXPIRES ${new Date(attempt.readingEndsAt).toISOString()}`;
      const png = await renderPage(paper, page, stamp, {
        artifactId: translation.artifactId,
        part,
        version: versionRow.version,
      });
      const fresh = league.readable(userId);
      if (fresh.attempt.id !== attempt.id)
        throw new AppError(410, "이 라운드의 열람이 종료되었습니다.");
      res
        .type("png")
        .set("Content-Disposition", "inline")
        .set("X-Page-Parts", String(translation.partCount))
        .send(png);
    },
  );
  // Only this asset directory is public; paper images and extracted text are never mounted.
  const publicDir = resolve(
    fileURLToPath(new URL("../../public/", import.meta.url)),
  );
  const sourcePublicDir = resolve(
    fileURLToPath(new URL("../public/", import.meta.url)),
  );
  const assets = import.meta.url.includes("/dist/src/")
    ? publicDir
    : sourcePublicDir;
  app.use(
    express.static(assets, {
      etag: false,
      lastModified: false,
      dotfiles: "deny",
      cacheControl: false,
    }),
  );
  app.use((_req, _res) => {
    throw new AppError(404, "요청하신 페이지가 없습니다.");
  });
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (res.headersSent) return;
      if (error instanceof AppError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof SyntaxError) {
        res.status(400).json({ error: "요청 형식이 올바르지 않습니다." });
        return;
      }
      console.error(
        "[web] 요청 처리 실패:",
        error instanceof Error ? error.name : "UnknownError",
      );
      res.status(500).json({
        error: "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
      });
    },
  );
  return app;
}
