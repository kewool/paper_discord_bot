import { randomUUID } from "node:crypto";
import { translationState } from "./translation.js";
import { DateTime } from "luxon";
import type { Config } from "./config.js";
import { Store } from "./store.js";
import {
  classifyPublication,
  pickWeightedIndex,
  type PublicationMetadata,
} from "./paper-selection.js";
import {
  type AppState,
  type Attempt,
  type AttemptView,
  type Grade,
  type LeaderboardEntry,
  type ReaderAttemptView,
  type Round,
  type User,
} from "./types.js";

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function roundWindow(
  now: number,
  config: Pick<Config, "timeZone" | "releaseHour">,
) {
  const local = DateTime.fromMillis(now, { zone: config.timeZone });
  let open = local.startOf("day").set({ hour: config.releaseHour });
  if (local < open) open = open.minus({ days: 1 });
  return {
    day: open.toISODate()!,
    opensAt: open.toMillis(),
    closesAt: open.plus({ days: 1 }).toMillis(),
  };
}
export class League {
  constructor(
    public store: Store,
    public config: Config,
    public now: () => number = Date.now,
  ) {}
  ensureRound(): Round | null {
    const window = roundWindow(this.now(), this.config);
    return this.store.transaction(() => {
      const existing = this.store.getRound(window.day);
      if (existing) return existing;
      const papers = this.store.all<{ id: string } & PublicationMetadata>(
        `SELECT p.id,ai.journalRef,ai.comment FROM papers p
         LEFT JOIN arxivImports ai ON ai.arxivId=(
           SELECT arxivId FROM arxivImports WHERE paperId=p.id AND status='imported'
           ORDER BY updatedAt DESC LIMIT 1
         ) WHERE p.demo=? ORDER BY p.id`,
        Number(this.config.demo),
      );
      if (!papers.length) return null;
      const recent = this.store.all<{ paperId: string }>(
        "SELECT paperId FROM rounds ORDER BY opensAt DESC LIMIT ?",
        Math.max(0, papers.length - 1),
      );
      let pool = papers.filter((p) => !recent.some((r) => r.paperId === p.id));
      if (!pool.length) pool = papers;
      const round: Round = {
        id: window.day,
        ...window,
        paperId:
          pool[
            pickWeightedIndex(pool, (paper) => {
              const { tier } = classifyPublication(
                paper,
                this.config.paperSelection.preferredVenues,
              );
              return this.config.paperSelection.weights[tier];
            })
          ].id,
        readingMinutes: this.config.readingMinutes,
        writingMinutes: this.config.writingMinutes,
        model: this.config.model,
        rubricVersion: "paper-league-v1",
      };
      this.store.run(
        "INSERT INTO rounds VALUES (?,?,?,?,?,?,?,?,?)",
        round.id,
        round.day,
        round.paperId,
        round.opensAt,
        round.closesAt,
        round.readingMinutes,
        round.writingMinutes,
        round.model,
        round.rubricVersion,
      );
      return round;
    });
  }
  currentAttempt(userId: string): Attempt | undefined {
    const round = this.ensureRound();
    return round
      ? this.store.get<Attempt>(
          "SELECT * FROM attempts WHERE userId=? AND roundId=?",
          userId,
          round.id,
        )
      : undefined;
  }
  view(attempt: Attempt): AttemptView {
    const paper = this.store.getPaper(
      this.store.getRound(attempt.roundId)!.paperId,
    )!;
    const phase =
      attempt.submittedAt !== null
        ? (attempt.gradingStatus as AttemptView["phase"])
        : this.now() >= attempt.submitBy
          ? "expired"
          : this.now() >= attempt.readingEndsAt
            ? "writing"
            : "reading";
    return {
      id: attempt.id,
      phase,
      startedAt: attempt.startedAt,
      readingEndsAt: attempt.readingEndsAt,
      submitBy: attempt.submitBy,
      paperTitle: paper.title,
      pageCount: paper.pageCount,
      summary: attempt.summary,
      grade: attempt.gradeJson
        ? (JSON.parse(attempt.gradeJson) as Grade)
        : null,
    };
  }
  readerView(view: AttemptView): ReaderAttemptView {
    const { summary: _summary, grade: _grade, ...reading } = view;
    return reading;
  }
  start(user: User): AttemptView {
    const round = this.ensureRound();
    if (!round)
      throw new AppError(
        503,
        "아직 등록된 논문이 없습니다. 운영자에게 알려 주세요.",
      );
    return this.store.transaction(() => {
      this.store.upsertUser(user);
      const existing = this.store.get<Attempt>(
        "SELECT * FROM attempts WHERE userId=? AND roundId=?",
        user.id,
        round.id,
      );
      if (existing) return this.view(existing);
      if (
        this.config.translation.enabled &&
        translationState(this.store, round.paperId, true).status !== "ready"
      )
        throw new AppError(
          503,
          "한국어 번역을 준비 중입니다. 완료되면 읽기를 시작할 수 있으며, 아직 제한시간은 시작되지 않았습니다.",
        );
      const now = this.now();
      if (now < round.opensAt || now >= round.closesAt)
        throw new AppError(410, "오늘 라운드가 마감되었습니다.");
      const duration = (round.readingMinutes + round.writingMinutes) * 60000;
      if (now + duration > round.closesAt)
        throw new AppError(
          410,
          "충분한 열람·제출 시간이 남지 않아 새 참여가 마감되었습니다. 다음 라운드에 참여해 주세요.",
        );
      const id = randomUUID();
      this.store.run(
        "INSERT INTO attempts(id,userId,roundId,startedAt,readingEndsAt,submitBy) VALUES (?,?,?,?,?,?)",
        id,
        user.id,
        round.id,
        now,
        now + round.readingMinutes * 60000,
        now + duration,
      );
      return this.view(this.store.getAttempt(id)!);
    });
  }
  finish(
    userId: string,
    expectedAttemptId?: string,
    focusLostAt?: number,
  ): AttemptView {
    const attempt = this.currentAttempt(userId);
    if (!attempt) throw new AppError(409, "먼저 열람을 시작해 주세요.");
    if (expectedAttemptId !== undefined && attempt.id !== expectedAttemptId)
      throw new AppError(410, "이 라운드의 열람은 이미 종료되었습니다.");
    if (
      focusLostAt !== undefined &&
      (!Number.isSafeInteger(focusLostAt) || focusLostAt < 0)
    )
      throw new AppError(422, "열람 종료 시각이 올바르지 않습니다.");
    return this.store.transaction(() => {
      const fresh = this.store.getAttempt(attempt.id)!;
      const endedAt = Math.max(
        fresh.startedAt,
        Math.min(this.now(), focusLostAt ?? this.now()),
      );
      if (fresh.submittedAt !== null || endedAt >= fresh.readingEndsAt)
        return this.view(fresh);
      const round = this.store.getRound(fresh.roundId)!;
      this.store.run(
        "UPDATE attempts SET readingEndsAt=?,submitBy=? WHERE id=?",
        endedAt,
        Math.min(
          fresh.submitBy,
          endedAt + round.writingMinutes * 60000,
          round.closesAt,
        ),
        fresh.id,
      );
      return this.view(this.store.getAttempt(fresh.id)!);
    });
  }
  submissionTarget(userId: string, expectedAttemptId?: string): Attempt {
    return this.checkedSubmission(
      this.currentAttempt(userId),
      expectedAttemptId,
    );
  }
  private checkedSubmission(
    attempt: Attempt | undefined,
    expectedAttemptId?: string,
  ): Attempt {
    if (!attempt)
      throw new AppError(409, "먼저 /paper로 오늘 논문을 읽어 주세요.");
    if (expectedAttemptId !== undefined && attempt.id !== expectedAttemptId)
      throw new AppError(
        410,
        "이 작성 창의 라운드가 종료되었습니다. /submit으로 다시 확인해 주세요.",
      );
    if (attempt.submittedAt !== null)
      throw new AppError(
        409,
        "이미 제출하셨습니다. 하루 한 번만 제출할 수 있습니다.",
      );
    const now = this.now();
    if (now >= attempt.submitBy)
      throw new AppError(410, "제출 시간이 종료되었습니다.");
    if (now < attempt.readingEndsAt)
      throw new AppError(
        409,
        "아직 열람 중입니다. 웹에서 읽기를 종료하거나 열람 시간이 끝난 뒤 /submit을 사용해 주세요.",
      );
    return attempt;
  }
  submit(
    userId: string,
    summary: string,
    expectedAttemptId?: string,
  ): AttemptView {
    const clean = summary.trim();
    if (clean.length < 150 || clean.length > 12000)
      throw new AppError(422, "정리 내용을 150~12,000자로 작성해 주세요.");
    const attempt = this.currentAttempt(userId);
    return this.store.transaction(() => {
      const fresh = this.checkedSubmission(
        attempt ? this.store.getAttempt(attempt.id) : undefined,
        expectedAttemptId,
      );
      const now = this.now();
      this.store.run(
        "UPDATE attempts SET summary=?,submittedAt=?,readingEndsAt=MIN(readingEndsAt,?),gradingStatus='queued',nextGradeAt=? WHERE id=? AND submittedAt IS NULL",
        clean,
        now,
        now,
        now,
        fresh.id,
      );
      return this.view(this.store.getAttempt(fresh.id)!);
    });
  }
  readable(userId: string) {
    const attempt = this.currentAttempt(userId);
    if (!attempt)
      throw new AppError(403, "열람을 시작한 계정만 볼 수 있습니다.");
    if (attempt.submittedAt !== null || this.now() >= attempt.readingEndsAt)
      throw new AppError(410, "열람 시간이 종료되었습니다.");
    const paper = this.store.getPaper(
      this.store.getRound(attempt.roundId)!.paperId,
    )!;
    return { attempt, paper };
  }
  leaderboard(period: "today" | "week", userId?: string): LeaderboardEntry[] {
    const current = this.ensureRound();
    if (!current) return [];
    const from =
      period === "today"
        ? current.opensAt
        : DateTime.fromMillis(current.opensAt, { zone: this.config.timeZone })
            .minus({ days: 6 })
            .toMillis();
    const rows = this.store.all<{
      userId: string;
      displayName: string;
      score: number;
      count: number;
    }>(
      `
      SELECT a.userId,u.displayName,SUM(a.score) AS score,COUNT(*) AS count
      FROM attempts a JOIN users u ON a.userId=u.id JOIN rounds r ON a.roundId=r.id
      WHERE a.gradingStatus='graded' AND r.opensAt>=? AND r.opensAt<=?
      GROUP BY a.userId ORDER BY score DESC, u.displayName ASC LIMIT 100`,
      from,
      current.opensAt,
    );
    let rank = 0;
    return rows.map((row, i) => {
      if (!i || row.score !== rows[i - 1].score) rank = i + 1;
      return {
        rank,
        displayName: row.displayName,
        score: row.score,
        count: row.count,
        isMe: row.userId === userId,
      };
    });
  }
  state(
    user: User | null,
    csrfToken: string | null,
    guildId = "",
    channelId = "",
  ): AppState {
    const round = this.ensureRound();
    const guild =
      user && guildId ? this.store.getGuildSettings(guildId) : undefined;
    const returnChannelId = channelId || guild?.channelId;
    const attempt =
      user && round
        ? this.store.get<Attempt>(
            "SELECT * FROM attempts WHERE userId=? AND roundId=?",
            user.id,
            round.id,
          )
        : undefined;
    return {
      serverNow: this.now(),
      demo: this.config.demo,
      authenticated: Boolean(user),
      discordUrl:
        user && guildId && returnChannelId
          ? `https://discord.com/channels/${guildId}/${returnChannelId}`
          : null,
      user,
      csrfToken,
      round: round
        ? {
            id: round.id,
            day: round.day,
            opensAt: round.opensAt,
            closesAt: round.closesAt,
            readingMinutes: round.readingMinutes,
            writingMinutes: round.writingMinutes,
          }
        : null,
      attempt: attempt ? this.readerView(this.view(attempt)) : null,
      translation:
        user && round
          ? translationState(
              this.store,
              round.paperId,
              this.config.translation.enabled,
            )
          : null,
      timeZone: this.config.timeZone,
      releaseHour: this.config.releaseHour,
    };
  }
  claimGrade(): Attempt | null {
    return this.store.transaction(() => {
      const now = this.now();
      this.store.run(
        "UPDATE attempts SET gradingStatus=CASE WHEN gradingAttempts>=3 THEN 'failed' ELSE 'queued' END, error='평가 작업이 중단되었습니다.',nextGradeAt=? WHERE gradingStatus='grading' AND gradingStartedAt<?",
        now,
        now - this.config.codexTimeoutMs - 60000,
      );
      const attempt = this.store.get<Attempt>(
        "SELECT * FROM attempts WHERE gradingStatus='queued' AND nextGradeAt<=? ORDER BY submittedAt LIMIT 1",
        now,
      );
      if (!attempt) return null;
      this.store.run(
        "UPDATE attempts SET gradingStatus='grading',gradingStartedAt=?,gradingAttempts=gradingAttempts+1 WHERE id=?",
        now,
        attempt.id,
      );
      return this.store.getAttempt(attempt.id)!;
    });
  }
  completeGrade(attempt: Attempt, grade: Grade) {
    this.store.run(
      "UPDATE attempts SET gradingStatus='graded',gradeJson=?,score=?,error=NULL WHERE id=? AND gradingStatus='grading' AND gradingAttempts=?",
      JSON.stringify(grade),
      grade.total,
      attempt.id,
      attempt.gradingAttempts,
    );
  }
  failGrade(attempt: Attempt) {
    const retry = attempt.gradingAttempts < 3;
    this.store.run(
      "UPDATE attempts SET gradingStatus=?,error=?,nextGradeAt=? WHERE id=? AND gradingStatus=? AND gradingAttempts=?",
      retry ? "queued" : "failed",
      "평가 연결에 실패했습니다. 운영자가 확인할 수 있습니다.",
      this.now() + 60000 * attempt.gradingAttempts,
      attempt.id,
      "grading",
      attempt.gradingAttempts,
    );
  }
}
