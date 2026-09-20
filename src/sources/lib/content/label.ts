import { z } from "zod";

/**
 * Adapter for the data-pipeline's medication exports.
 *
 * The pipeline reports what it found in an FDA label. This module decides
 * what a patient is shown. Those are different jobs on purpose, and every
 * narrowing rule below lives here rather than upstream.
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF GUIDE, AND WHY
 * ---------------------------------------------------------------------------
 * A product reaches the patient page one of two ways:
 *
 *   "authored"       A person wrote a plain-language layer and cited an exact
 *                    quote for every claim. Singulair has one.
 *
 *   "official-label" No such layer exists yet, so the page shows the label's
 *                    OWN words, verbatim, and says that is what it is.
 *
 * There is deliberately no third option where the app generates plain
 * language from the label. Writing patient-facing medical prose from a
 * source document is the single thing this codebase exists to not do, and a
 * language model doing it silently would be indistinguishable, to a reader,
 * from a clinician having written it.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN official-label GUIDE MAY AND MAY NOT SHOW
 * ---------------------------------------------------------------------------
 * MAY:
 *   - Structured identity: brand, ingredient, strength, form, route. These
 *     are fields, not prose, so rendering them invents nothing.
 *   - The boxed warning, verbatim, when the document has one.
 *   - Official patient-directed text, verbatim.
 *   - The document's scope: how many products this one label covers.
 *   - Links to the full label and Medication Guide.
 *
 * MAY NOT:
 *   - Dosing, administration steps, or patient directions. One SPL routinely
 *     covers several products dosed differently, and most sections are not
 *     structurally bound to any one of them. The pipeline marks those
 *     `document-level-unresolved`; we do not render them to a patient at all,
 *     rather than render them with a caveat nobody reads.
 *   - Any claim that a risk is absent. A missing section is a fact about the
 *     document, never evidence about the drug.
 *
 * ---------------------------------------------------------------------------
 * WHY patientSections() FILTERS ON APPLICABILITY
 * ---------------------------------------------------------------------------
 * An earlier version returned every patient section that had text. That was a
 * real defect, and it is worth recording precisely, because the shape of it
 * recurs:
 *
 *   Ozempic's SPL covers eight products. Its patient labeling carries four
 *   separate Instructions for Use, one per pen device. Three were marked
 *   `not-applicable` by the pipeline - the document itself ties them to other
 *   NDCs - and one was `document-level-unresolved`. All four rendered.
 *
 *   The page therefore showed a complete injection procedure for the 1 mg pen
 *   (NDC 0169-1310) on the page for a 1.34 mg/mL product, directly beneath a
 *   card reading "This page does not show doses... a dose shown here might
 *   belong to a different one."
 *
 * Pens differ in what they can dial: the 1 mg pen "delivers doses in 1 mg
 * increments only". Wrong-device instructions for an injectable are not a
 * cosmetic error.
 *
 * Two rules now apply, and both are enforced here rather than in the view, so
 * that every caller - patient page, clinician page, share preview - inherits
 * them:
 *
 *   1. `not-applicable` is never rendered. The document assigned that section
 *      to a different product; there is no reading under which it belongs on
 *      this one.
 *
 *   2. Instructions for Use are withheld unless the document binds them to
 *      THIS product (`exact-product`). IFU content is device administration,
 *      which is exactly what an official-label page promises not to show. An
 *      unresolved IFU is not evidence that it applies; it is evidence that the
 *      document did not say.
 *
 * What is withheld is COUNTED, not silently dropped - see
 * `withheldPatientSections`. A reader is told that sections exist and why they
 * are not shown, and pointed at the full label.
 */

/* ------------------------------------------------------------------ schema */

const TableSchema = z.object({
  caption: z.string().nullable(),
  headers: z.array(z.array(z.string())),
  rows: z.array(z.array(z.string())),
});

const ApplicabilitySchema = z.enum([
  "exact-product",
  "explicitly-shared",
  "document-level-unresolved",
  "not-applicable",
]);

export type LabelApplicability = z.infer<typeof ApplicabilitySchema>;

const SectionSchema: z.ZodType<LabelSectionView> = z.lazy(() =>
  z.object({
    loincCode: z.string().nullable(),
    printedNumber: z.string().nullable(),
    title: z.string().nullable(),
    paragraphs: z.array(z.string()),
    highlights: z.array(z.string()),
    tables: z.array(TableSchema),
    subsections: z.array(SectionSchema),
    applicability: ApplicabilitySchema,
    appliesToProducts: z.array(z.string()),
    audience: z.enum(["professional", "patient", "unknown"]),
  })
);

export interface LabelSectionView {
  loincCode: string | null;
  printedNumber: string | null;
  title: string | null;
  paragraphs: string[];
  highlights: string[];
  tables: Array<{ caption: string | null; headers: string[][]; rows: string[][] }>;
  subsections: LabelSectionView[];
  applicability: LabelApplicability;
  appliesToProducts: string[];
  audience: "professional" | "patient" | "unknown";
}

/**
 * Only the fields the app actually reads are modelled.
 *
 * `.passthrough()` is deliberate: the pipeline may add fields, and an app
 * that refuses to parse a record because it grew a field would fail closed on
 * a non-problem. Fields the app does read are strict.
 */
export const MedicationExportSchema = z
  .object({
    schemaVersion: z.string(),
    productKey: z.string().min(1),
    readiness: z.enum(["app-ready", "partial", "blocked"]),
    blockedReason: z.string().nullable(),
    display: z.object({
      brandName: z.string().nullable(),
      genericName: z.string(),
      labeledIngredient: z.string(),
      activeMoiety: z.string().nullable(),
      strengthDisplay: z.string(),
      dosageForm: z.string(),
      route: z.array(z.string()),
      labelerName: z.string().nullable(),
    }),
    identifiers: z.object({
      productNdc: z.string().nullable(),
      rxcui: z.string().nullable(),
      applicationNumber: z.string().nullable(),
      splSetId: z.string().nullable(),
      splVersion: z.string().nullable(),
    }),
    document: z.object({
      title: z.string(),
      splEffectiveDate: z.string(),
      productsInDocument: z.array(z.string()),
      sourceUrl: z.string(),
      medicationGuideUrl: z.string(),
    }),
    professionalLabeling: z.array(SectionSchema),
    patientLabeling: z.array(SectionSchema),
    verification: z.object({
      resolutionState: z.string(),
      rationale: z.string(),
    }),
    // Typed as the literal false upstream. Enforced again here, because the
    // app must never present a record as clinically reviewed.
    clinicalReview: z.object({ reviewed: z.literal(false), note: z.string() }),
    freshness: z.object({
      ingestedAt: z.string(),
      sourceEffectiveDate: z.string(),
    }),
    notProvided: z.array(z.string()),
  })
  .passthrough();

export type MedicationExport = z.infer<typeof MedicationExportSchema>;

/* ------------------------------------------------------------- narrowing */

/** LOINC code for the FDA boxed warning section. */
const BOXED_WARNING_LOINC = "34066-1";

function flatten(sections: LabelSectionView[]): LabelSectionView[] {
  return sections.flatMap((s) => [s, ...flatten(s.subsections)]);
}

function hasText(s: LabelSectionView): boolean {
  return (
    s.paragraphs.some((p) => p.trim().length > 0) ||
    s.tables.length > 0 ||
    s.highlights.some((h) => h.trim().length > 0)
  );
}

/**
 * The boxed warning, when the document carries one.
 *
 * Returns null when it does not, and the UI renders NOTHING in that case.
 * It must never render "no boxed warning": Toprol XL's current SPL has no
 * boxed-warning section while metoprolol is a drug class people associate
 * with one, so an absence statement here would be a confident claim built on
 * a parser result.
 *
 * Applicability is deliberately ignored for this one section. A boxed
 * warning is a risk statement about the drug, not dosing or administration,
 * so the `document-level-unresolved` rule does not apply: that rule exists to
 * stop one product's DOSE reaching another product's page. Withholding a
 * boxed warning because the document did not scope it to a single strength
 * would suppress the most important safety information on the label.
 */
export function boxedWarning(record: MedicationExport): LabelSectionView | null {
  const found = flatten(record.professionalLabeling).find(
    (s) => s.loincCode === BOXED_WARNING_LOINC && hasText(s)
  );
  return found ?? null;
}

/** LOINC for Instructions for Use: patient-facing device administration. */
const INSTRUCTIONS_FOR_USE_LOINC = "59845-8";

/** Why a patient section was withheld from the page. */
export type WithheldReason =
  /** The document ties this section to a different product. */
  | "belongs-to-another-product"
  /** Device administration steps the document did not bind to this product. */
  | "unbound-instructions-for-use"
  /** Nothing renderable survived parsing (usually an image-only figure). */
  | "no-extractable-text";

export interface WithheldSection {
  title: string | null;
  loincCode: string | null;
  applicability: LabelApplicability;
  reason: WithheldReason;
  /** Products the document DOES tie it to, when it says. */
  appliesToProducts: string[];
}

/** The rule, in one place, used by both the keep and the explain paths. */
function withholdReason(s: LabelSectionView): WithheldReason | null {
  if (!hasText(s)) return "no-extractable-text";
  if (s.applicability === "not-applicable") return "belongs-to-another-product";
  if (s.loincCode === INSTRUCTIONS_FOR_USE_LOINC && s.applicability !== "exact-product") {
    return "unbound-instructions-for-use";
  }
  return null;
}

/**
 * Official patient-directed sections worth showing, verbatim.
 *
 * See the note at the top of this file for why applicability is filtered here
 * and not in the view.
 *
 * Empty sections are dropped too: several Instructions for Use carry only an
 * image the parser could not turn into text, and an empty accordion reads as
 * missing information rather than as an unparseable figure.
 *
 * Anything left is still the label's own words. It is NOT a plain-language
 * rewrite, and the UI says so.
 */
export function patientSections(record: MedicationExport): LabelSectionView[] {
  return record.patientLabeling.filter((s) => withholdReason(s) === null);
}

/**
 * The sections that were NOT shown, and why.
 *
 * Withholding content silently is its own failure: a reader cannot tell the
 * difference between "this label says nothing about using the device" and
 * "we decided not to show you what it says". The count and the reason are
 * surfaced, and the full label is one link away.
 */
export function withheldPatientSections(record: MedicationExport): WithheldSection[] {
  const out: WithheldSection[] = [];
  for (const s of record.patientLabeling) {
    const reason = withholdReason(s);
    // An unparseable empty section is not worth reporting to a reader; there
    // was nothing to show and nothing was decided.
    if (reason === null || reason === "no-extractable-text") continue;
    out.push({
      title: s.title,
      loincCode: s.loincCode,
      applicability: s.applicability,
      reason,
      appliesToProducts: s.appliesToProducts,
    });
  }
  return out;
}

/**
 * How this one document scopes itself, as a sentence built from a count.
 *
 * Derived from `productsInDocument`, not written by hand and not written by a
 * model. One SPL covering four products is the normal case, and it is the
 * reason a reader must not carry anything here across to another strength.
 */
export function labelScopeNote(record: MedicationExport): string {
  const others = record.document.productsInDocument.length - 1;
  const self = `${record.display.strengthDisplay} ${record.display.dosageForm.toLowerCase()}`;
  if (others <= 0) {
    return `This page is about ${record.display.genericName.toLowerCase()} ${self}. Always check that the medicine you have matches.`;
  }
  return (
    `This page is about ${record.display.genericName.toLowerCase()} ${self}. ` +
    `The same FDA label also covers ${others} other product${others === 1 ? "" : "s"} ` +
    `at different strengths or in different forms. Those are taken differently. ` +
    `Do not use this page for them.`
  );
}

/** Product name for headings and share text, from fields only. */
export function labelProductName(record: MedicationExport): string {
  const brand = record.display.brandName?.trim();
  const generic = record.display.genericName.toLowerCase();
  const head = brand ? `${titleCase(brand)} (${generic})` : titleCase(generic);
  return `${head} ${record.display.strengthDisplay} ${record.display.dosageForm.toLowerCase()}`;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Parses and gates one exported record.
 *
 * Returns null for anything not `app-ready`. Readiness is the pipeline's own
 * verdict on whether a record is structurally consumable, and a blocked
 * record carries no label content by design, so there is nothing to render.
 */
export function parseLabelExport(raw: unknown): MedicationExport | null {
  const parsed = MedicationExportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Label export failed validation: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`
    );
  }
  return parsed.data.readiness === "app-ready" ? parsed.data : null;
}
