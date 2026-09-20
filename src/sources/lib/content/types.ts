import { z } from "zod";
import { SLUG_PATTERN } from "@/shared/lib/slug";

/**
 * Trust boundary: the source record is produced by scripts/fetch-label.mjs from
 * public FDA / NLM APIs. It is parsed through these schemas before any code
 * reads it, so a malformed or truncated fetch fails loudly instead of rendering
 * half a label.
 */

export const SourceSectionSchema = z.object({
  id: z.string().min(1),
  /** Section number as printed in the label, e.g. "5.1", or "BOXED WARNING". */
  labelSectionRef: z.string().min(1),
  title: z.string().min(1),
  text: z.string().min(1),
});
export type SourceSection = z.infer<typeof SourceSectionSchema>;

export const SourceRefSchema = z.object({
  name: z.string(),
  publisher: z.string(),
  url: z.string().url(),
  lastUpdated: z.string().nullable(),
});

export const SourceRecordSchema = z.object({
  recordId: z.string().min(1),
  schemaVersion: z.literal(1),
  product: z.object({
    brandName: z.string(),
    genericName: z.string(),
    labelerName: z.string(),
    productNdc: z.string(),
    dosageForm: z.string(),
    route: z.array(z.string()),
    strength: z.array(z.string()),
    applicationNumber: z.string(),
    marketingCategory: z.string(),
    packaging: z.array(z.object({ packageNdc: z.string(), description: z.string() })),
    rxcui: z.array(z.string()),
    unii: z.array(z.string()),
  }),
  document: z.object({
    splSetId: z.string(),
    splVersion: z.string(),
    splId: z.string(),
    effectiveDate: z.string().nullable(),
    dailyMedPublishedDate: z.string(),
    dailyMedTitle: z.string(),
    coversDosageForms: z.array(z.string()),
  }),
  provenance: z.object({
    retrievedAt: z.string(),
    sources: z.array(SourceRefSchema),
    humanReadable: z.object({
      dailyMed: z.string().url(),
      medicationGuide: z.string().url(),
    }),
    /**
     * Null unless a named clinician has actually reviewed the content on a
     * given date. "Retrieved on" is not "reviewed on" and the UI must not
     * present one as the other.
     */
    clinicallyReviewedAt: z.string().nullable(),
    clinicallyReviewedBy: z.string().nullable(),
  }),
  sections: z.array(SourceSectionSchema).min(1),
});
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

/**
 * A citation points at one retrieved source section and carries an exact quote
 * from it. The quote is verified to be a literal substring of that section's
 * text (see verifyCitation). This is what makes "the citation supports the
 * nearby claim" a checkable property rather than a promise.
 */
export const CitationSchema = z.object({
  sectionId: z.string().min(1),
  quote: z.string().min(12),
});
export type Citation = z.infer<typeof CitationSchema>;

export const PlainSectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** Plain-language restatement. Shown by default. */
  plain: z.array(z.string().min(1)).min(1),
  /** Optional deeper detail, collapsed by default. */
  detail: z.array(z.string().min(1)).optional(),
  citations: z.array(CitationSchema).min(1),
  /** Renders with warning emphasis. Used for boxed warning / serious risks. */
  emphasis: z.enum(["normal", "warning", "critical"]).default("normal"),
});
export type PlainSection = z.infer<typeof PlainSectionSchema>;

/**
 * A short fact shown directly under the headline.
 *
 * Fair balance lives here. The headline says what the product is for; these
 * carry the qualifiers that must travel with it, including the boxed warning.
 * `emphasis: "critical"` marks a bullet that must never be dropped, reordered
 * below a benefit, or rendered smaller than one.
 */
export const KeyPointSchema = z.object({
  text: z.string().min(1),
  emphasis: z.enum(["normal", "warning", "critical"]).default("normal"),
  /** Optional anchor id of the section that covers this in full. */
  seeSectionId: z.string().min(1).optional(),
});
export type KeyPoint = z.infer<typeof KeyPointSchema>;

export const MedicationRecordSchema = z.object({
  slug: z
    .string()
    .min(1)
    // One definition, in shared/lib/slug.ts. The slug joins the pipeline's
    // productKey, the URL, this record and every API request.
    .regex(SLUG_PATTERN, "slug must be lowercase alphanumeric with hyphens or underscores"),
  sourceRecordId: z.string().min(1),
  /**
   * One-sentence answer to "what is this?", shown above the fold.
   *
   * Indications only. Risks belong in keyPoints and in the sections, so that
   * the headline cannot be written to sell and cannot be written to alarm.
   */
  headline: z.string().min(1),
  /**
   * Balancing facts shown as bullets under the headline. A product carrying a
   * boxed warning must have a "critical" key point naming it.
   */
  keyPoints: z.array(KeyPointSchema).default([]),
  /**
   * Scope note. This record describes ONE strength/form. The underlying SPL may
   * cover more; saying so prevents a reader generalising to the chewable or
   * granule product.
   *
   * This is the precise version, kept for the clinician-facing screen.
   */
  scopeNote: z.string().min(1),
  /**
   * The same scope limit in short, everyday words, for the patient guide.
   *
   * The audience includes people reading in a second language and people
   * reading while unwell, so this is written to be understood on one pass:
   * short sentences, no clause stacking, no bracketed asides. Falls back to
   * scopeNote when a record has not supplied one yet.
   */
  plainScopeNote: z.string().min(1).optional(),
  sections: z.array(PlainSectionSchema).min(1),
});
export type MedicationRecord = z.infer<typeof MedicationRecordSchema>;

/** A medication record joined to its validated source record. */
export interface ResolvedMedication {
  record: MedicationRecord;
  source: SourceRecord;
}

/** The scope limit to show a patient: the plain version when one exists. */
export function patientScopeNote(record: MedicationRecord): string {
  return record.plainScopeNote ?? record.scopeNote;
}

/** Key points that must stay visible and above any benefit framing. */
export function criticalKeyPoints(record: MedicationRecord): KeyPoint[] {
  return record.keyPoints.filter((p) => p.emphasis === "critical");
}

/**
 * Wording that promotes rather than informs.
 *
 * Fair balance is mostly a review discipline, not something code can decide.
 * What code CAN do is refuse the small set of words that have no business in
 * a restatement of an FDA label: superlatives, efficacy claims the label does
 * not make, and comparative marketing language. tests/content.test.ts runs
 * this over every authored string, so a promotional edit fails the build
 * rather than reaching a patient.
 *
 * Quoted label text is exempt and is never passed through here: the label
 * says what it says, and altering a quote would break its citation.
 */
const PROMOTIONAL_PATTERNS: { pattern: RegExp; why: string }[] = [
  { pattern: /\b(best|safest|strongest|most effective|number one|#1)\b/i, why: "superlative" },
  { pattern: /\b(breakthrough|revolutionary|miracle|game[- ]chang)/i, why: "hype" },
  { pattern: /\b(proven to|guaranteed|guarantees|cures?)\b/i, why: "unsupported claim" },
  { pattern: /\b(better than|outperforms|superior to)\b/i, why: "comparative claim" },
  { pattern: /\b(ask your doctor (about|for)|talk to your doctor about) [A-Z]/, why: "product prompt" },
  { pattern: /\b(well[- ]tolerated|minimal side effects|few side effects)\b/i, why: "risk minimisation" },
];

export interface BalanceProblem {
  text: string;
  why: string;
}

/** Returns every promotional phrase found in the record's authored text. */
export function findPromotionalLanguage(record: MedicationRecord): BalanceProblem[] {
  const authored = [
    record.headline,
    record.scopeNote,
    ...(record.plainScopeNote ? [record.plainScopeNote] : []),
    ...record.keyPoints.map((p) => p.text),
    ...record.sections.flatMap((s) => [s.title, ...s.plain, ...(s.detail ?? [])]),
  ];
  const problems: BalanceProblem[] = [];
  for (const text of authored) {
    for (const { pattern, why } of PROMOTIONAL_PATTERNS) {
      if (pattern.test(text)) problems.push({ text, why });
    }
  }
  return problems;
}

/** Collapse whitespace so quote matching is not defeated by formatting. */
export function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export interface CitationProblem {
  sectionId: string;
  quote: string;
  reason: "unknown-section" | "quote-not-found";
}

/**
 * Verifies one citation against the retrieved source. Returns null when valid.
 *
 * This is deliberately strict: a quote that is not literally present in the
 * retrieved text is treated as a fabrication, whether it came from a human
 * author or a language model.
 */
export function verifyCitation(
  citation: Citation,
  source: SourceRecord
): CitationProblem | null {
  const section = source.sections.find((s) => s.id === citation.sectionId);
  if (!section) {
    return { sectionId: citation.sectionId, quote: citation.quote, reason: "unknown-section" };
  }
  const haystack = normalizeForMatch(section.text);
  const needle = normalizeForMatch(citation.quote);
  if (!haystack.includes(needle)) {
    return { sectionId: citation.sectionId, quote: citation.quote, reason: "quote-not-found" };
  }
  return null;
}

/** Verifies every citation in a medication record. Returns all problems found. */
export function verifyMedicationCitations(
  record: MedicationRecord,
  source: SourceRecord
): CitationProblem[] {
  const problems: CitationProblem[] = [];
  for (const section of record.sections) {
    for (const citation of section.citations) {
      const problem = verifyCitation(citation, source);
      if (problem) problems.push(problem);
    }
  }
  return problems;
}
