import { getMedication, listMedications, productLabel } from "./registry";
import {
  parseLabelExport,
  labelProductName,
  boxedWarning,
  patientSections,
  withheldPatientSections,
  type WithheldSection,
  labelScopeNote,
  type MedicationExport,
  type LabelSectionView,
} from "./label";
import type { ResolvedMedication } from "./types";

import rawSingulair from "@/sources/content/label-exports/singulair-montelukast-10mg-tablet.json";
import rawToprol from "@/sources/content/label-exports/toprol-xl-metoprolol-succinate-50mg-er-tablet.json";
import rawOzempic from "@/sources/content/label-exports/ozempic-semaglutide-1_34mg-per-ml-injection.json";

/**
 * The catalogue: every medication the app can show, in either form.
 *
 * ---------------------------------------------------------------------------
 * ADDING A MEDICATION
 * ---------------------------------------------------------------------------
 *   1. Ingest it in the pipeline, then `npm run content:sync` from the app.
 *   2. Add the import and the array entry below. It now appears in the
 *      clinician's library and gets a patient page built from the label's own
 *      words.
 *   3. OPTIONALLY, author a plain-language layer for it (see registry.ts).
 *      The moment a slug has one, this module prefers it automatically and
 *      the page upgrades from "official-label" to "authored".
 *
 * Step 3 is a person writing prose against a source document, with a verified
 * quote behind every claim. It is not a step that can be automated, and
 * nothing here should try.
 */

const labelExports: MedicationExport[] = [
  rawSingulair,
  rawToprol,
  rawOzempic,
  // Add synced label exports here.
]
  .map((raw) => parseLabelExport(raw))
  // parseLabelExport returns null for anything not app-ready.
  .filter((r): r is MedicationExport => r !== null);

const labelBySlug = new Map(labelExports.map((r) => [r.productKey, r]));

/**
 * How a guide's content was produced. The patient page renders this
 * differently and says which one it is, because "a person wrote this in plain
 * language" and "this is the label's own text" are different promises.
 */
export type ContentMode = "authored" | "official-label";

export interface AuthoredGuide {
  mode: "authored";
  slug: string;
  /** The authored plain-language layer joined to its verified source record. */
  authored: ResolvedMedication;
  /** Present when the pipeline also covers this product. */
  label: MedicationExport | null;
}

export interface LabelGuide {
  mode: "official-label";
  slug: string;
  label: MedicationExport;
  productName: string;
  scopeNote: string;
  /** Null when the document has no boxed warning. Never means "no risk". */
  boxedWarning: LabelSectionView | null;
  /** Official patient-directed text, verbatim. May be empty. */
  patientSections: LabelSectionView[];
  /** Patient sections deliberately not shown, with the reason. */
  withheldSections: WithheldSection[];
}

export type Guide = AuthoredGuide | LabelGuide;

/**
 * Every guide, authored ones first.
 *
 * Authored guides lead because they are the ones written for a lay reader.
 * A clinician scanning the library should reach those first.
 */
export function listGuides(): Guide[] {
  const authoredSlugs = new Set(listMedications().map((m) => m.record.slug));

  const authored: Guide[] = listMedications().map((m) => ({
    mode: "authored" as const,
    slug: m.record.slug,
    authored: m,
    label: labelBySlug.get(m.record.slug) ?? null,
  }));

  const labelOnly: Guide[] = labelExports
    .filter((r) => !authoredSlugs.has(r.productKey))
    .map(toLabelGuide);

  return [...authored, ...labelOnly];
}

export function getGuide(slug: string): Guide | null {
  const authored = getMedication(slug);
  if (authored) {
    return {
      mode: "authored",
      slug,
      authored,
      label: labelBySlug.get(slug) ?? null,
    };
  }
  const label = labelBySlug.get(slug);
  return label ? toLabelGuide(label) : null;
}

export function listGuideSlugs(): string[] {
  return listGuides().map((g) => g.slug);
}

function toLabelGuide(label: MedicationExport): LabelGuide {
  return {
    mode: "official-label",
    slug: label.productKey,
    label,
    productName: labelProductName(label),
    scopeNote: labelScopeNote(label),
    boxedWarning: boxedWarning(label),
    patientSections: patientSections(label),
    withheldSections: withheldPatientSections(label),
  };
}

/** Display name for either kind of guide. */
export function guideProductName(guide: Guide): string {
  return guide.mode === "authored" ? productLabel(guide.authored.source) : guide.productName;
}
