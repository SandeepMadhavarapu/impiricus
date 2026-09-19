import rawSingulair from "@/sources/content/sources/singulair-montelukast-10mg-tablet.json";
import { singulair10mgTablet } from "@/sources/content/medications/singulair-montelukast-10mg-tablet";
import {
  MedicationRecordSchema,
  SourceRecordSchema,
  type ResolvedMedication,
  type SourceRecord,
  type MedicationRecord,
} from "./types";

/**
 * The content registry. Both the fetched source record and the authored
 * plain-language record are parsed through their schemas at module load, so a
 * bad content change fails immediately rather than rendering a broken page.
 *
 * ---------------------------------------------------------------------------
 * ADDING A MEDICATION
 * ---------------------------------------------------------------------------
 * Every product needs two files, and both are joined by id here:
 *
 *   1. The SOURCE record: fetched, not written by hand.
 *        npm run content:fetch -- <setid>
 *      writes src/sources/content/sources/<slug>.json with the label text,
 *      the SPL version, and a retrieval timestamp.
 *
 *   2. The AUTHORED record: the plain-language layer, written by a person,
 *      at src/sources/content/medications/<slug>.ts. Every claim in it cites
 *      an exact quote from (1). See the authoring rules at the top of the
 *      Singulair file, which apply to every product.
 *
 * Then add the import and the array entry below. Nothing else needs changing:
 * routes, static generation, retrieval, the doctor's library and the share
 * links all read from these arrays.
 *
 * The schema parse is the gate. A record missing a boxed-warning key point,
 * carrying a quote that is not in the source, or using promotional wording
 * fails here or in tests/content.test.ts rather than reaching a patient.
 *
 * ---------------------------------------------------------------------------
 * CONNECTING THE data-pipeline EXPORT
 * ---------------------------------------------------------------------------
 * The sibling data-pipeline package emits a `MedicationExport` (see
 * data-pipeline/src/export/appExport.ts). Its shape is NOT this shape, and the
 * gap is deliberate: the pipeline reports what it found, this layer decides
 * what a patient is shown. An adapter belongs here, not in the pipeline.
 *
 * Three fields on the export must survive that adapter, because dropping any
 * of them turns a careful pipeline result into a confident wrong answer:
 *
 *   readiness      Only "app-ready" may be registered. "partial" and
 *                  "blocked" carry no renderable label content, and a blocked
 *                  record exists precisely because something about it could
 *                  not be verified.
 *
 *   applicability  A section marked "document-level-unresolved" was not
 *                  resolved to THIS product. It must never be rendered as
 *                  product-specific dosing or patient instruction. One SPL
 *                  covers several strengths and forms, which is the same
 *                  hazard scopeNote exists to prevent.
 *
 *   clinicalReview `reviewed` is false on everything the pipeline can
 *                  currently produce, and the UI already states that. It must
 *                  not become "reviewed" by passing through an adapter.
 *
 * The authored plain-language layer stays hand-written per product. The
 * pipeline supplies source text and provenance; it does not write the words a
 * patient reads, and nothing here should start generating them.
 */

const sourceRecords: SourceRecord[] = [
  SourceRecordSchema.parse(rawSingulair),
  // Add fetched source records here.
];

const medicationRecords: MedicationRecord[] = [
  MedicationRecordSchema.parse(singulair10mgTablet),
  // Add authored medication records here.
];

const sourceById = new Map(sourceRecords.map((s) => [s.recordId, s]));

/** All medication slugs, for static generation and the index page. */
export function listMedicationSlugs(): string[] {
  return medicationRecords.map((m) => m.slug);
}

export function listMedications(): ResolvedMedication[] {
  return medicationRecords.map((record) => resolveOrThrow(record));
}

/**
 * Resolves a slug to its medication + source record.
 *
 * Returns null for an unknown slug. Callers must render a real "not found"
 * state rather than falling back to some other medication — showing the wrong
 * drug is the most damaging failure this app could have.
 */
export function getMedication(slug: string): ResolvedMedication | null {
  const record = medicationRecords.find((m) => m.slug === slug);
  if (!record) return null;
  return resolveOrThrow(record);
}

function resolveOrThrow(record: MedicationRecord): ResolvedMedication {
  const source = sourceById.get(record.sourceRecordId);
  if (!source) {
    throw new Error(
      `Medication "${record.slug}" references missing source record "${record.sourceRecordId}"`
    );
  }
  return { record, source };
}

/** The medication the root route features. */
export const DEFAULT_MEDICATION_SLUG = "singulair-montelukast-10mg-tablet";

/**
 * Extracts the dose from an openFDA active-ingredient strength string.
 *
 * openFDA formats these as "<INGREDIENT NAME> <amount>/<per>", e.g.
 * "MONTELUKAST SODIUM 10 mg/1". The ingredient name can be several words and
 * the "/1" denominator is noise for a solid oral dose form, so both are
 * dropped. Returns the input unchanged if no dose pattern is found, rather than
 * guessing.
 */
export function formatStrength(strengthEntry: string | undefined): string {
  if (!strengthEntry) return "";
  const match = strengthEntry.match(/(\d[\d.,]*)\s*(mcg|mg|g|mL|units?|%)\b/i);
  if (!match) return strengthEntry;
  return `${match[1]} ${match[2]}`;
}

/** The primary strength for a medication, formatted for display. */
export function displayStrength(source: SourceRecord): string {
  return formatStrength(source.product.strength[0]);
}

/**
 * Dosage form in sentence case, e.g. "TABLET, FILM COATED" -> "tablet, film
 * coated". Kept faithful to the label rather than prettified into something
 * that could blur two different forms together.
 */
export function displayDosageForm(source: SourceRecord): string {
  return source.product.dosageForm.toLowerCase();
}

/** Human-readable product identity line, e.g. for headers and share text. */
export function productLabel(source: SourceRecord): string {
  return `${titleCase(source.product.brandName)} (${lower(source.product.genericName)}) ${displayStrength(
    source
  )} ${displayDosageForm(source)}`;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function lower(s: string): string {
  return s.toLowerCase();
}

/**
 * How old is this evidence? Used to surface a staleness notice rather than
 * silently presenting an old label as current.
 */
export function evidenceAgeDays(source: SourceRecord, now: Date = new Date()): number {
  const retrieved = new Date(source.provenance.retrievedAt).getTime();
  if (Number.isNaN(retrieved)) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - retrieved) / 86_400_000);
}

/** Content refreshed longer ago than this is flagged as possibly stale. */
export const STALE_AFTER_DAYS = 90;

export function isStale(source: SourceRecord, now: Date = new Date()): boolean {
  return evidenceAgeDays(source, now) > STALE_AFTER_DAYS;
}
