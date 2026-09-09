import { randomInt } from "node:crypto";

export type PublicationTier = "preferred" | "published" | "unconfirmed";
export type PublicationMetadata = {
  journalRef?: string | null;
  comment?: string | null;
};
export type PaperSelectionWeights = {
  preferred: number;
  published: number;
  unconfirmed: number;
};

/** Configurable policy defaults; this is not an official venue ranking. */
export const DEFAULT_PREFERRED_VENUES = [
  "NeurIPS",
  "NIPS",
  "ICML",
  "ICLR",
  "CVPR",
  "ICCV",
  "ACL",
  "EMNLP",
  "KDD",
  "SIGMOD",
  "VLDB",
  "STOC",
  "FOCS",
  "SOSP",
  "OSDI",
  "NSDI",
  "USENIX Security",
  "CCS",
  "Nature",
  "Science",
  "Cell",
  "PNAS",
  "Physical Review Letters",
  "Phys. Rev. Lett.",
  "Physical Review X",
  "PRX",
  "Nature Physics",
  "Nature Astronomy",
  "Annals of Mathematics",
  "Inventiones Mathematicae",
  "Journal of the American Mathematical Society",
  "Astrophysical Journal",
  "Monthly Notices of the Royal Astronomical Society",
  "Econometrica",
  "American Economic Review",
] as const satisfies readonly string[];

const NEGATIVE =
  /\b(?:submitted|under\s+review|in\s+review|rejected|withdrawn|submission|not\s+(?:yet\s+)?(?:accepted|published))\b/i;
const VENUE_ALIASES = [
  [
    "NeurIPS",
    "NIPS",
    "Advances in Neural Information Processing Systems",
    "Neural Information Processing Systems",
  ],
  ["ICML", "International Conference on Machine Learning"],
  ["ICLR", "International Conference on Learning Representations"],
  ["CVPR", "Conference on Computer Vision and Pattern Recognition"],
  ["ICCV", "International Conference on Computer Vision"],
  ["PNAS", "Proceedings of the National Academy of Sciences"],
  ["Physical Review Letters", "Phys. Rev. Lett.", "PRL"],
  ["Physical Review X", "Phys. Rev. X", "PRX"],
];
function clean(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function preferredMatch(
  text: string,
  venues: readonly string[],
): string | null {
  const normalized = clean(text);
  if (/\bworkshops?\b/.test(normalized)) return null;
  for (const entry of venues
    .flatMap((venue) => {
      const aliases = VENUE_ALIASES.find((group) =>
        group.some((alias) => clean(alias) === clean(venue)),
      ) ?? [venue];
      return aliases.map((alias) => ({ venue, normalized: clean(alias) }));
    })
    .filter((x) => x.normalized)
    .sort((a, b) => b.normalized.length - a.normalized.length)) {
    const escaped = entry.normalized.split(" ").map(escapeRegExp).join("\\s+");
    // Conference acronyms are commonly suffixed directly with a year
    // (NeurIPS2026) as well as separated by a space.
    const boundary = new RegExp(
      `(?:^|\\s)${escaped}(?=$|\\s|\\d{4}(?=\\s|$))`,
      "i",
    );
    if (!boundary.test(normalized)) continue;
    if (
      ["nature", "science", "cell", "prx"].includes(entry.normalized) &&
      (new RegExp(`\\b${escaped}\\s+[\\p{L}]`, "u").test(normalized) ||
        !new RegExp(`^(?:the\\s+)?${escaped}(?=$|\\s|\\d)`, "u").test(
          normalized,
        ))
    )
      continue;
    return entry.venue;
  }
  return null;
}

function commentEvidence(
  comment: string,
  venues: readonly string[],
): { venue: string | null; reason: string } | null {
  if (NEGATIVE.test(comment)) return null;
  const attached =
    /\b(?:accepted|published|presented)\s+(?:at|in|by|to)\s+([^,;().]+)|\bto\s+appear\s+in\s+([^,;().]+)|\baccepted\s+for\s+publication\s+in\s+([^,;().]+)/i.exec(
      comment,
    ) ??
    /\baccepted\s+as\s+(?:(?:a|an)\s+)?(?:(?:regular|full|short)\s+)?(?:paper|poster|oral(?:\s+presentation)?|spotlight)\s+(?:at|in|to)\s+([^,;().]+)/i.exec(
      comment,
    );
  if (attached) {
    const venueText = (attached[1] ?? attached[2] ?? attached[3] ?? "").trim();
    return {
      venue: (preferredMatch(venueText, venues) ?? venueText) || null,
      reason: "comment states publication or acceptance",
    };
  }
  const proceedings =
    /\bproceedings\s+of\s+(?:the\s+)?([^,;().]+)|\b([^,;().]+)\s+proceedings\b/i.exec(
      comment,
    );
  if (proceedings) {
    const venueText = (proceedings[1] ?? proceedings[2] ?? "").trim();
    return {
      venue: (preferredMatch(venueText, venues) ?? venueText) || null,
      reason: "comment cites proceedings",
    };
  }
  if (/\baccepted\s+for\s+publication\b/i.test(comment)) {
    return { venue: null, reason: "comment states publication or acceptance" };
  }
  return null;
}

export function classifyPublication(
  meta: PublicationMetadata,
  preferredVenues: readonly string[] = DEFAULT_PREFERRED_VENUES,
): { tier: PublicationTier; venue: string | null; reason: string } {
  const journalRef = meta.journalRef?.trim() ?? "";
  if (journalRef && !NEGATIVE.test(journalRef)) {
    const preferred = preferredMatch(journalRef, preferredVenues);
    return preferred
      ? {
          tier: "preferred",
          venue: preferred,
          reason: "journal reference names a preferred venue",
        }
      : {
          tier: "published",
          venue: journalRef,
          reason: "non-empty journal reference",
        };
  }
  const comment = meta.comment?.trim() ?? "";
  const evidence = comment ? commentEvidence(comment, preferredVenues) : null;
  if (evidence) {
    const preferred =
      evidence.venue && !/\bworkshops?\b/i.test(comment)
        ? preferredMatch(evidence.venue, preferredVenues)
        : null;
    return preferred
      ? { tier: "preferred", venue: preferred, reason: evidence.reason }
      : { tier: "published", venue: evidence.venue, reason: evidence.reason };
  }
  return {
    tier: "unconfirmed",
    venue: null,
    reason: "no unambiguous publication evidence",
  };
}

function defaultRandom(): number {
  return randomInt(0, 2 ** 32) / 2 ** 32;
}
function checkedWeight<T>(item: T, weightOf: (item: T) => number): number {
  const weight = weightOf(item);
  if (!Number.isFinite(weight) || weight <= 0)
    throw new RangeError("weights must be positive finite numbers");
  return weight;
}

export function pickWeightedIndex<T>(
  items: readonly T[],
  weightOf: (item: T) => number,
  random: () => number = defaultRandom,
): number {
  if (items.length === 0) return -1;
  const weights = items.map((item) => checkedWeight(item, weightOf));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1)
    throw new RangeError("random must return a value in [0, 1)");
  let threshold = value * total;
  for (let index = 0; index < weights.length; index += 1) {
    threshold -= weights[index];
    if (threshold < 0) return index;
  }
  return weights.length - 1;
}

export function weightedOrder<T>(
  items: readonly T[],
  weightOf: (item: T) => number,
  random: () => number = defaultRandom,
): T[] {
  const remaining = items.map((item) => ({
    item,
    weight: checkedWeight(item, weightOf),
  }));
  const result: T[] = [];
  while (remaining.length) {
    const index = pickWeightedIndex(remaining, (entry) => entry.weight, random);
    result.push(remaining.splice(index, 1)[0].item);
  }
  return result;
}
