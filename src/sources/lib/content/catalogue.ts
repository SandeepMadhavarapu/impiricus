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
import rawConcepts from "@/sources/content/rxnorm/product-concepts.json";
import {
  parseStrength,
  strengthsEqual,
  dosageFormCompatible,
  type ParsedStrength,
} from "./strength";

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

/* ------------------------------------------------------- product identity */

export interface RxNormConcept {
  rxcui: string;
  /** RxNorm term type. SBD is a branded product, SCD a generic one. */
  tty: string;
  name: string;
}

/**
 * What a published product IS, and what it is interchangeable with.
 *
 * `exact` is the concept this page is about. `genericEquivalent` is a
 * DIFFERENT product: same ingredient, strength and form, without the brand.
 * They are kept apart deliberately, because a plan can list one and not the
 * other, and presenting the generic's tier as the brand's is a false statement
 * about what the reader would pay.
 */
export interface ProductConcepts {
  exact: RxNormConcept | null;
  genericEquivalent: RxNormConcept | null;
}

const conceptsBySlug = new Map<string, ProductConcepts>(
  Object.entries((rawConcepts as { products: Record<string, ProductConcepts> }).products ?? {})
);

/**
 * The RxNorm concepts for a published product, from the retrieved RxNav
 * artifact (src/sources/content/rxnorm/product-concepts.json).
 *
 * NOTHING HERE IS INFERRED FROM A NAME. The previous resolver returned the
 * authored record's whole `product.rxcui` array, which for Singulair holds
 * eight concepts across four presentations - 10 mg tablet, 5 mg chewable,
 * 4 mg chewable and 4 mg oral granules - so a question about a 10 mg
 * film-coated tablet could be answered from a row for 4 mg granules. It also
 * mixed the branded and generic concepts together and let whichever matched
 * first win, which is why the Singulair page reported "Tier 1, no prior
 * authorisation, 30 per 30 days" from row 200224: the GENERIC.
 *
 * Returning null means the product cannot be looked up. That is a real state
 * and must never be read as "not covered".
 */
export function productConcepts(slug: string): ProductConcepts | null {
  if (!getGuide(slug)) return null;
  return conceptsBySlug.get(slug) ?? null;
}

/**
 * Every RXCUI that legitimately identifies this product or its same-strength,
 * same-form generic.
 *
 * Kept for callers that only need "can this be looked up at all". Any caller
 * that presents a formulary ANSWER must use `productConcepts` instead, so the
 * brand and the generic stay distinguishable in what the reader is told.
 */
export function productRxcuis(slug: string): string[] {
  const c = productConcepts(slug);
  if (!c) return [];
  return [c.exact?.rxcui, c.genericEquivalent?.rxcui].filter(
    (r): r is string => typeof r === "string" && r.trim().length > 0
  );
}

/* --------------------------------------------------- canonical presentation */

export interface ProductPresentation {
  /** The product's strength, parsed. Null when no source states one. */
  strength: ParsedStrength | null;
  /** As the label writes it, e.g. "TABLET, EXTENDED RELEASE". */
  dosageForm: string;
  route: string[];
  /** The exact text the strength was parsed from, for diagnostics. */
  strengthSource: string | null;
}

/**
 * The product's own identity, structured.
 *
 * This is the canonical answer to "what is this page about", and it is what a
 * coverage request is checked against. The previous helper joined every
 * strength string the product had into one blob -
 * "MONTELUKAST SODIUM 10 mg/1 10 mg" - and the guard searched that text. The
 * "/1" is openFDA's denominator, counting dosage units, and searching made it
 * indistinguishable from a real 1 mg strength.
 *
 * The label export is preferred where present because it carries the cleaned
 * display form ("10 mg", "1.34 mg/1 mL"); the authored record's raw openFDA
 * string is the fallback. Both parse to the same structure.
 */
export function productPresentation(slug: string): ProductPresentation | null {
  const guide = getGuide(slug);
  if (!guide) return null;

  const candidates: string[] = [];
  let dosageForm = "";
  let route: string[] = [];

  if (guide.mode === "authored") {
    if (guide.label) candidates.push(guide.label.display.strengthDisplay);
    candidates.push(...guide.authored.source.product.strength);
    dosageForm = guide.label?.display.dosageForm ?? guide.authored.source.product.dosageForm;
    route = guide.label?.display.route ?? guide.authored.source.product.route;
  } else {
    candidates.push(guide.label.display.strengthDisplay);
    dosageForm = guide.label.display.dosageForm;
    route = guide.label.display.route;
  }

  for (const text of candidates) {
    const parsed = parseStrength(text);
    if (parsed !== null) {
      return { strength: parsed, dosageForm, route, strengthSource: text };
    }
  }
  // No parseable strength is a real state. The caller must refuse to answer
  // rather than fall through to "close enough".
  return { strength: null, dosageForm, route, strengthSource: candidates[0] ?? null };
}

/**
 * Whether a coverage request describes the product on this page.
 *
 * ---------------------------------------------------------------------------
 * WHY A GUARD EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * The form does not ask for a strength. It sends the page's own product
 * identity, so in the normal flow this always agrees. The guard is for the
 * API contract: `strength` and `dosageForm` are echoed back in the result's
 * "Fill" line beside real formulary facts, so a caller must not be able to put
 * a different product's description there.
 *
 * It compares STRUCTURE, never text:
 *
 *   - numerator amount and unit, converted only within a dimension
 *   - denominator, when the source writes one with a unit (a concentration)
 *   - dosage form, rejecting contradiction but allowing under-specification
 *
 * A bare number is not a strength, because a unit is never inferred. A
 * denominator is not a strength, which is the defect this replaced.
 */
export function coverageRequestMatchesProduct(
  slug: string,
  requestedStrength: string,
  requestedDosageForm?: string
): { ok: true } | { ok: false; reason: string } {
  const presentation = productPresentation(slug);
  if (presentation === null) return { ok: false, reason: "unknown-product" };
  if (presentation.strength === null) {
    return { ok: false, reason: "product-has-no-parseable-strength" };
  }

  const wanted = parseStrength(requestedStrength);
  if (wanted === null) return { ok: false, reason: "requested-strength-not-a-strength" };
  if (!strengthsEqual(wanted, presentation.strength)) {
    return { ok: false, reason: "strength-differs" };
  }

  if (requestedDosageForm !== undefined && requestedDosageForm.trim().length > 0) {
    if (!dosageFormCompatible(requestedDosageForm, presentation.dosageForm)) {
      return { ok: false, reason: "dosage-form-differs" };
    }
  }
  return { ok: true };
}

/** Back-compatible boolean wrapper. */
export function strengthMatchesProduct(slug: string, requested: string): boolean {
  return coverageRequestMatchesProduct(slug, requested).ok;
}
