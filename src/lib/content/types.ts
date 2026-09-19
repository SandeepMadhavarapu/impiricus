import { z } from "zod";

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

export const MedicationRecordSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with hyphens"),
  sourceRecordId: z.string().min(1),
  /** One-sentence answer to "what is this?", shown above the fold. */
  headline: z.string().min(1),
  /**
   * Scope note. This record describes ONE strength/form. The underlying SPL may
   * cover more; saying so prevents a reader generalising to the chewable or
   * granule product.
   */
  scopeNote: z.string().min(1),
  sections: z.array(PlainSectionSchema).min(1),
});
export type MedicationRecord = z.infer<typeof MedicationRecordSchema>;

/** A medication record joined to its validated source record. */
export interface ResolvedMedication {
  record: MedicationRecord;
  source: SourceRecord;
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
