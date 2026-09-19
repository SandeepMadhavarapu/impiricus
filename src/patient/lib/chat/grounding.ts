import type { SourceRecord } from "@/sources/lib/content/types";
import { findPassageById, type ScoredPassage } from "@/sources/lib/retrieval";
import type { AnswerCitation } from "./types";

/**
 * Citation validation.
 *
 * A model is asked to cite passages by id. Those ids are checked against the
 * passages that were actually retrieved for THIS question. An id the model
 * invented, or one belonging to a passage we did not supply, is dropped.
 *
 * This is the difference between "the answer has citations" and "the answer's
 * citations exist".
 */

export interface ValidationResult {
  citations: AnswerCitation[];
  /** Ids the model produced that were not in the retrieved set. */
  rejected: string[];
}

/** Matches [[passage_id]] markers in model output. */
const CITATION_MARKER = /\[\[([a-z0-9_]+#\d+)\]\]/gi;

export function extractCitedIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(CITATION_MARKER)) {
    const id = match[1];
    if (id) ids.add(id.toLowerCase());
  }
  return [...ids];
}

/** Strips citation markers, leaving readable prose. */
export function stripCitationMarkers(text: string): string {
  return text.replace(CITATION_MARKER, "").replace(/[ \t]{2,}/g, " ").replace(/ +([.,;:])/g, "$1");
}

export function sourceUrlForSection(source: SourceRecord, sectionId: string): string {
  return sectionId === "spl_medguide"
    ? source.provenance.humanReadable.medicationGuide
    : source.provenance.humanReadable.dailyMed;
}

export function toCitation(
  source: SourceRecord,
  passage: { id: string; sectionTitle: string; labelSectionRef: string; text: string; sectionId: string }
): AnswerCitation {
  return {
    passageId: passage.id,
    sectionTitle: passage.sectionTitle,
    labelSectionRef: passage.labelSectionRef,
    excerpt: passage.text.length > 700 ? passage.text.slice(0, 700).trimEnd() + "…" : passage.text,
    sourceUrl: sourceUrlForSection(source, passage.sectionId),
  };
}

/**
 * Validates the ids a model cited against the passages supplied to it.
 *
 * `supplied` is the authoritative allow-list: even a real passage id that was
 * NOT retrieved for this question is rejected, because the model could not have
 * read it and therefore cannot be relying on it.
 */
export function validateCitations(
  source: SourceRecord,
  answerText: string,
  supplied: ScoredPassage[]
): ValidationResult {
  const allowed = new Map(supplied.map((p) => [p.id.toLowerCase(), p]));
  const citations: AnswerCitation[] = [];
  const rejected: string[] = [];

  for (const id of extractCitedIds(answerText)) {
    const passage = allowed.get(id);
    if (!passage) {
      rejected.push(id);
      continue;
    }
    citations.push(toCitation(source, passage));
  }
  return { citations, rejected };
}

/**
 * Last-resort integrity check: confirms a passage id really exists in the
 * source record. Used by tests and by the label-excerpt mode.
 */
export function passageExists(source: SourceRecord, id: string): boolean {
  return findPassageById(source, id) !== null;
}
