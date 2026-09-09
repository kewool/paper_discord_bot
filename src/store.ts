import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Attempt,
  GuildSettings,
  Paper,
  PaperInput,
  Round,
  User,
} from "./types.js";

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS papers (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, authors TEXT NOT NULL, sourceUrl TEXT NOT NULL,
        license TEXT NOT NULL, pageCount INTEGER NOT NULL, text TEXT NOT NULL,
        directory TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rounds (
        id TEXT PRIMARY KEY, day TEXT NOT NULL UNIQUE, paperId TEXT NOT NULL REFERENCES papers(id),
        opensAt INTEGER NOT NULL, closesAt INTEGER NOT NULL, readingMinutes REAL NOT NULL,
        writingMinutes REAL NOT NULL, model TEXT NOT NULL, rubricVersion TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, displayName TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), roundId TEXT NOT NULL REFERENCES rounds(id),
        startedAt INTEGER NOT NULL, readingEndsAt INTEGER NOT NULL, submitBy INTEGER NOT NULL,
        submittedAt INTEGER, summary TEXT, gradingStatus TEXT NOT NULL DEFAULT 'none',
        gradeJson TEXT, score INTEGER CHECK(score BETWEEN 0 AND 100), gradingAttempts INTEGER NOT NULL DEFAULT 0,
        nextGradeAt INTEGER NOT NULL DEFAULT 0, gradingStartedAt INTEGER, error TEXT,
        UNIQUE(userId, roundId)
      );
      CREATE INDEX IF NOT EXISTS attempts_queue ON attempts(gradingStatus,nextGradeAt);
      CREATE TABLE IF NOT EXISTS sessions (
        tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), csrfToken TEXT NOT NULL, expiresAt INTEGER NOT NULL, roundId TEXT NOT NULL,
        guildId TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS accessTokens (
        tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), roundId TEXT NOT NULL REFERENCES rounds(id),
        expiresAt INTEGER NOT NULL, usedAt INTEGER, guildId TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS announcements (
        roundId TEXT PRIMARY KEY REFERENCES rounds(id), status TEXT NOT NULL,
        updatedAt INTEGER NOT NULL, messageId TEXT
      );
      CREATE TABLE IF NOT EXISTS guildSettings (
        guildId TEXT PRIMARY KEY, channelId TEXT NOT NULL,
        allowedRoleId TEXT NOT NULL DEFAULT '', updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS guildAnnouncements (
        guildId TEXT NOT NULL REFERENCES guildSettings(guildId),
        roundId TEXT NOT NULL REFERENCES rounds(id), channelId TEXT NOT NULL,
        status TEXT NOT NULL, updatedAt INTEGER NOT NULL, messageId TEXT,
        PRIMARY KEY(guildId,roundId,channelId)
      );
      CREATE TABLE IF NOT EXISTS arxivImports (
        arxivId TEXT PRIMARY KEY, paperId TEXT REFERENCES papers(id), category TEXT NOT NULL,
        journalRef TEXT NOT NULL, comment TEXT NOT NULL, status TEXT NOT NULL,
        reason TEXT, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS syncState (
        name TEXT PRIMARY KEY, lastAttemptAt INTEGER NOT NULL, lastSuccessAt INTEGER, error TEXT
      );
      CREATE TABLE IF NOT EXISTS sourceLocks (
        name TEXT PRIMARY KEY, owner TEXT NOT NULL, expiresAt INTEGER NOT NULL
      );
    `);
    this.transaction(() => {
      for (const [table, column] of [
        ["sessions", "roundId"],
        ["sessions", "guildId"],
        ["accessTokens", "guildId"],
      ]) {
        if (
          !this.all<{ name: string }>(`PRAGMA table_info(${table})`).some(
            (c) => c.name === column,
          )
        )
          this.db.exec(
            `ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`,
          );
      }
      this.db.exec("PRAGMA user_version=3");
    });
  }
  get<T>(sql: string, ...args: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  all<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  run(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).run(...args);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  addPaper(paper: PaperInput): void {
    this.run(
      "INSERT INTO papers VALUES (?,?,?,?,?,?,?,?,?,?)",
      paper.id,
      paper.title,
      paper.authors,
      paper.sourceUrl,
      paper.license,
      paper.pageCount,
      paper.text.replace(/\u0000/g, " "),
      paper.directory,
      Number(paper.demo),
      Date.now(),
    );
  }
  getPaper(id: string): Paper | undefined {
    const row = this.get<Paper & { rawText: Uint8Array }>(
      "SELECT *,CAST(text AS BLOB) AS rawText FROM papers WHERE id=?",
      id,
    );
    if (!row) return undefined;
    const { rawText, ...paper } = row;
    return {
      ...paper,
      text: Buffer.from(rawText)
        .toString("utf8")
        .replace(/\u0000/g, " "),
      demo: Boolean(paper.demo),
    };
  }
  getRound(id: string) {
    return this.get<Round>("SELECT * FROM rounds WHERE id=?", id);
  }
  getAttempt(id: string) {
    return this.get<Attempt>("SELECT * FROM attempts WHERE id=?", id);
  }
  upsertUser(user: User) {
    this.run(
      "INSERT INTO users VALUES (?,?) ON CONFLICT(id) DO UPDATE SET displayName=excluded.displayName",
      user.id,
      user.displayName,
    );
  }
  getGuildSettings(guildId: string) {
    return this.get<GuildSettings>(
      "SELECT * FROM guildSettings WHERE guildId=?",
      guildId,
    );
  }
  listGuildSettings() {
    return this.all<GuildSettings>(
      "SELECT * FROM guildSettings ORDER BY guildId",
    );
  }
  saveGuildSettings(
    guildId: string,
    channelId: string,
    allowedRoleId = "",
    updatedAt = Date.now(),
  ) {
    this.run(
      `INSERT INTO guildSettings(guildId,channelId,allowedRoleId,updatedAt) VALUES (?,?,?,?)
       ON CONFLICT(guildId) DO UPDATE SET channelId=excluded.channelId,
         allowedRoleId=excluded.allowedRoleId,updatedAt=excluded.updatedAt`,
      guildId,
      channelId,
      allowedRoleId,
      updatedAt,
    );
  }
  importLegacyGuild(guildId?: string, channelId?: string, allowedRoleId = "") {
    if (!guildId || !channelId) return;
    this.transaction(() => {
      if (this.getGuildSettings(guildId)) return;
      this.saveGuildSettings(guildId, channelId, allowedRoleId);
      this.run(
        `INSERT INTO guildAnnouncements(guildId,roundId,channelId,status,updatedAt,messageId)
         SELECT ?,roundId,?,status,updatedAt,messageId FROM announcements`,
        guildId,
        channelId,
      );
      this.run("UPDATE sessions SET guildId=? WHERE guildId=''", guildId);
      this.run("UPDATE accessTokens SET guildId=? WHERE guildId=''", guildId);
    });
  }
  close() {
    this.db.close();
  }
}
