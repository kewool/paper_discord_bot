import { z } from "zod";

export const TRANSLATION_VERSION = "ko-v1";
export const translationBlockSchema = z
  .object({
    kind: z.enum([
      "heading",
      "paragraph",
      "caption",
      "equation",
      "table",
      "reference",
    ]),
    text: z.string().max(12000),
    rows: z.array(z.array(z.string().max(1200)).min(1).max(12)).max(100),
  })
  .strict();
export type TranslationBlock = z.infer<typeof translationBlockSchema>;

export const translationPageSchema = z
  .object({
    page: z.number().int().min(1).max(40),
    complete: z.boolean(),
    blocks: z.array(translationBlockSchema).min(1).max(180),
    glossary: z
      .array(
        z
          .object({
            source: z.string().min(1).max(120),
            korean: z.string().min(1).max(160),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type TranslationPage = z.infer<typeof translationPageSchema>;
export interface TranslationState {
  status: "disabled" | "pending" | "translating" | "ready" | "failed";
  readyPages: number;
  totalPages: number;
}
export interface PaperTranslation {
  paperId: string;
  status: Exclude<TranslationState["status"], "disabled">;
  model: string;
  version: string;
  completedPages: number;
  glossaryJson: string;
  attempts: number;
  nextAttemptAt: number;
  leaseOwner: string | null;
  leaseUntil: number;
  updatedAt: number;
  error: string | null;
}
