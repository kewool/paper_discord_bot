import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { Config } from "./config.js";
import { AppError, League } from "./league.js";
import type { User } from "./types.js";

const SESSION_COOKIE = "paper_session";
const token = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const equal = (a: string, b: string) => {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
};
interface Session {
  tokenHash: string;
  userId: string;
  csrfToken: string;
  expiresAt: number;
  roundId: string;
  guildId: string;
}
interface AccessToken {
  tokenHash: string;
  userId: string;
  roundId: string;
  expiresAt: number;
  usedAt: number | null;
  guildId: string;
}

// Called only after Discord has authenticated the interaction and checked membership.
export function issueAccess(
  league: League,
  user: User,
  guildId = "",
): { url: string; expiresAt: number } {
  if (guildId && !league.store.getGuildSettings(guildId))
    throw new AppError(
      403,
      "서버 관리자가 /setup으로 공지 채널을 먼저 설정해 주세요.",
    );
  const round = league.ensureRound();
  if (!round)
    throw new AppError(
      503,
      "아직 등록된 논문이 없습니다. 운영자에게 알려 주세요.",
    );
  const raw = token();
  const now = league.now();
  const expiresAt = Math.min(now + 15 * 60000, round.closesAt);
  league.store.transaction(() => {
    league.store.upsertUser(user);
    league.store.run(
      "DELETE FROM accessTokens WHERE expiresAt<=? OR (userId=? AND roundId=? AND usedAt IS NULL)",
      now,
      user.id,
      round.id,
    );
    league.store.run(
      "INSERT INTO accessTokens(tokenHash,userId,roundId,expiresAt,usedAt,guildId) VALUES (?,?,?,?,NULL,?)",
      digest(raw),
      user.id,
      round.id,
      expiresAt,
      guildId,
    );
  });
  return { url: `${league.config.publicUrl}/#access=${raw}`, expiresAt };
}

export class Auth {
  constructor(
    private league: League,
    private config: Config,
  ) {}
  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.publicUrl.startsWith("https:"),
      sameSite: "lax" as const,
      path: "/",
    };
  }
  async read(req: Request) {
    const value: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof value !== "string" || value.length > 100) return null;
    const session = this.league.store.get<Session>(
      "SELECT * FROM sessions WHERE tokenHash=? AND expiresAt>?",
      digest(value),
      this.league.now(),
    );
    if (!session || session.roundId !== this.league.ensureRound()?.id)
      return null;
    const user = this.league.store.get<User>(
      "SELECT * FROM users WHERE id=?",
      session.userId,
    );
    return user
      ? { user, csrfToken: session.csrfToken, guildId: session.guildId }
      : null;
  }
  sameOrigin(req: Request) {
    if (req.get("Origin") !== this.config.publicUrl)
      throw new AppError(
        403,
        "요청 출처를 확인하지 못했습니다. 서비스 주소에서 다시 열어 주세요.",
      );
  }
  csrf(req: Request, csrfToken: string) {
    this.sameOrigin(req);
    if (!equal(req.get("X-CSRF-Token") || "", csrfToken))
      throw new AppError(
        403,
        "세션 확인에 실패했습니다. 페이지를 새로고침해 주세요.",
      );
  }
  private setSession(
    req: Request,
    res: Response,
    user: User,
    roundId: string,
    expiresAt: number,
    guildId = "",
  ) {
    const old: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof old === "string")
      this.league.store.run(
        "DELETE FROM sessions WHERE tokenHash=?",
        digest(old),
      );
    const raw = token();
    this.league.store.upsertUser(user);
    this.league.store.run(
      "INSERT INTO sessions(tokenHash,userId,csrfToken,expiresAt,roundId,guildId) VALUES (?,?,?,?,?,?)",
      digest(raw),
      user.id,
      token(),
      expiresAt,
      roundId,
      guildId,
    );
    this.league.store.run(
      "DELETE FROM sessions WHERE expiresAt<=?",
      this.league.now(),
    );
    res.cookie(SESSION_COOKIE, raw, {
      ...this.cookieOptions(),
      maxAge: Math.max(0, expiresAt - this.league.now()),
    });
  }
  redeem(req: Request, res: Response, raw: unknown) {
    this.sameOrigin(req);
    if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw))
      throw new AppError(
        400,
        "개인 링크가 올바르지 않습니다. 디스코드에서 /paper로 다시 받아 주세요.",
      );
    const round = this.league.ensureRound();
    this.league.store.transaction(() => {
      const record = this.league.store.get<AccessToken>(
        "SELECT * FROM accessTokens WHERE tokenHash=?",
        digest(raw),
      );
      if (
        !record ||
        record.usedAt !== null ||
        record.expiresAt <= this.league.now() ||
        record.roundId !== round?.id
      ) {
        throw new AppError(
          410,
          "이미 사용했거나 만료된 링크입니다. 디스코드에서 /paper로 새 링크를 받아 주세요.",
        );
      }
      this.league.store.run(
        "UPDATE accessTokens SET usedAt=? WHERE tokenHash=? AND usedAt IS NULL",
        this.league.now(),
        record.tokenHash,
      );
      const user = this.league.store.get<User>(
        "SELECT * FROM users WHERE id=?",
        record.userId,
      )!;
      this.setSession(
        req,
        res,
        user,
        record.roundId,
        round!.closesAt,
        record.guildId,
      );
    });
  }
  demo(req: Request, res: Response) {
    if (!this.config.demo)
      throw new AppError(404, "요청하신 페이지가 없습니다.");
    this.sameOrigin(req);
    const round = this.league.ensureRound();
    if (!round) throw new AppError(503, "데모 논문을 준비 중입니다.");
    this.setSession(
      req,
      res,
      { id: "demo-reader", displayName: "데모 참가자" },
      round.id,
      round.closesAt,
    );
  }
  logout(req: Request, res: Response) {
    const value: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof value === "string")
      this.league.store.run(
        "DELETE FROM sessions WHERE tokenHash=?",
        digest(value),
      );
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
    res.setHeader("Clear-Site-Data", '"cache", "storage"');
  }
}
