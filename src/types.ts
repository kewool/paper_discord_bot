import type { TranslationState } from "./translation-types.js";

export const GRADING_VERSION = "paper-league-v2";

export const RUBRIC = [
  { key: "understanding", label: "문제와 핵심 기여", max: 25 },
  { key: "methodology", label: "방법론 이해", max: 25 },
  { key: "evidence", label: "결과와 근거", max: 25 },
  { key: "limitations", label: "한계와 비판적 사고", max: 15 },
  { key: "clarity", label: "정리의 명료성", max: 10 },
] as const;
export type RubricKey = (typeof RUBRIC)[number]["key"];
export interface Grade {
  criteria: {
    key: RubricKey;
    score: number;
    feedback: string;
    evidence?: {
      page: number;
      location: string;
      relation: "supported" | "contradicted" | "omitted" | "unverifiable";
    }[];
  }[];
  strengths: string[];
  improvements: string[];
  overall: string;
  total: number;
  model: string;
  rubricVersion: string;
  demo: boolean;
}
export interface PaperInput {
  id: string;
  title: string;
  authors: string;
  sourceUrl: string;
  license: string;
  pageCount: number;
  text: string;
  directory: string;
  demo: boolean;
}
export interface Paper extends PaperInput {
  createdAt: number;
}
export interface Round {
  id: string;
  day: string;
  paperId: string;
  opensAt: number;
  closesAt: number;
  readingMinutes: number;
  writingMinutes: number;
  model: string;
  rubricVersion: string;
}
export interface User {
  id: string;
  displayName: string;
}
export interface GuildSettings {
  guildId: string;
  channelId: string;
  allowedRoleId: string;
  updatedAt: number;
}
export interface Attempt {
  id: string;
  userId: string;
  roundId: string;
  startedAt: number;
  readingEndsAt: number;
  submitBy: number;
  submittedAt: number | null;
  summary: string | null;
  gradingStatus: "none" | "queued" | "grading" | "graded" | "failed";
  gradeJson: string | null;
  score: number | null;
  gradingAttempts: number;
  nextGradeAt: number;
  gradingStartedAt: number | null;
  error: string | null;
}
export interface LeaderboardEntry {
  rank: number;
  displayName: string;
  score: number;
  count: number;
  isMe: boolean;
}
export interface AttemptView {
  id: string;
  phase:
    | "reading"
    | "writing"
    | "queued"
    | "grading"
    | "graded"
    | "failed"
    | "expired";
  startedAt: number;
  readingEndsAt: number;
  submitBy: number;
  paperTitle: string;
  pageCount: number;
  summary: string | null;
  grade: Grade | null;
}
export interface AppState {
  serverNow: number;
  demo: boolean;
  authenticated: boolean;
  discordUrl: string | null;
  user: User | null;
  csrfToken: string | null;
  round: Omit<Round, "paperId" | "model" | "rubricVersion"> | null;
  attempt: ReaderAttemptView | null;
  translation: TranslationState | null;
  timeZone: string;
  releaseHour: number;
}

export type ReaderAttemptView = Omit<AttemptView, "summary" | "grade">;
