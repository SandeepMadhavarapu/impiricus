import { walkSections } from "../normalize/spl.js";
import { SCHEMA_VERSION, type LabelSection, type MedicationRecord } from "../schemas/index.js";

/**
 * App-consumable export.
 *
 * "app-ready" here means STRUCTURALLY consumable — the shape is stable and the
 * fields mean what the integration guide says. It does NOT mean clinically
 * approved, and `clinicalReview.reviewed` is false on every record this
 * pipeline can currently produce.
 *
 * A record that did not reach verified-match, or that carries a blocking
 * conflict, is exported with readiness "blocked" and its label content omitted.
 * Teammates get the reason instead of content they might render.
 */

export interface ExportedSection {
  loincCode: string | null;
  printedNumber: string | null;
  title: string | null;
  paragraphs: string[];
  tables: Array<{ caption: string | null; headers: string[][]; rows: string[][] }>;
  subsections: ExportedSection[];
  audience: "professional" | "patient" | "unknown";
}

export interface MedicationExport {
  schemaVersion: string;
  productKey: string;
  readiness: "app-ready" | "partial" | "blocked";
  /** Present only when readiness !== "blocked". */
  blockedReason: string | null;

  display: {
    brandName: string | null;
    genericName: string;
    labeledIngredient: string;
    activeMoiety: string | null;
    strengthDisplay: string;
    dosageForm: string;
    releaseCharacteristic: string;
    route: string[];
    labelerName: string | null;
  };

  identifiers: {
    productNdc: string | null;
    ndc11: string[];
    rxcui: string | null;
    rxnormTty: string | null;
    unii: string[];
    applicationNumber: string | null;
    fdaProductNumber: string | null;
    splSetId: string | null;
    splVersion: string | null;
  };

  document: {
    title: string;
    splEffectiveDate: string;
    dailyMedPublishedDate: string | null;
    /** Every product this one document describes. */
    productsInDocument: string[];
    sourceUrl: string;
    medicationGuideUrl: string;
  };

  /** Professional prescribing information, hierarchy and tables preserved. */
  professionalLabeling: ExportedSection[];
  /** Patient-directed official text, kept separate from the above. */
  patientLabeling: ExportedSection[];

  approval:
    | {
        available: true;
        applicationNumber: string;
        sponsorName: string | null;
        productNumber: string;
        strength: string;
        dosageForm: string;
        marketingStatus: string | null;
        approvalDates: Array<{ type: string; status: string | null; date: string | null }>;
        otherProductsInApplication: Array<{
          productNumber: string;
          strength: string;
          dosageForm: string;
        }>;
      }
    | { available: false; reason: string };

  /** How certain we are this is the right product, and why. */
  verification: {
    resolutionState: string;
    rationale: string;
    evidence: Array<{ dimension: string; expected: string; observed: string; agrees: boolean; source: string }>;
    otherProductsConsidered: Array<{ label: string; why: string }>;
  };

  conflicts: Array<{ field: string; assessment: string; blocksExport: boolean; note: string }>;

  /** Always false. Never render this record as clinically reviewed. */
  clinicalReview: { reviewed: false; note: string };

  /** Freshness. `stale` is computed by the consumer against its own policy. */
  freshness: {
    ingestedAt: string;
    splEffectiveDate: string;
    /** Source-document date, NOT retrieval time. */
    sourceEffectiveDate: string;
  };

  /** Everything the app must NOT infer from this record. */
  notProvided: string[];
}

function exportSection(s: LabelSection): ExportedSection {
  return {
    loincCode: s.loincCode,
    printedNumber: s.printedNumber,
    title: s.title,
    paragraphs: s.paragraphs,
    tables: s.tables,
    subsections: s.subsections.map(exportSection),
    audience: s.audience,
  };
}

function strengthDisplay(record: MedicationRecord): string {
  const s = record.identity.strength[0];
  if (!s) return "";
  if (s.denominatorUnit) {
    return `${s.numeratorValue} ${s.numeratorUnit}/${s.denominatorValue ?? 1} ${s.denominatorUnit}`;
  }
  return `${s.numeratorValue} ${s.numeratorUnit}`;
}

export const NOT_PROVIDED: readonly string[] = [
  "No patient prescription, dose, or regimen. This is public labeling only.",
  "No patient-specific suitability assessment.",
  "No insurance coverage, formulary status, copay or cost.",
  "No clinician instructions and no clinician relationship.",
  "No drug-drug interaction checking. The RxNav Interaction API was discontinued; this pipeline produces none.",
  "No adverse-event incidence or causation. FAERS is deliberately not ingested.",
  "No clinical review. Content is official labeling text, not reviewed advice.",
];

export function toExport(record: MedicationRecord): MedicationExport {
  const blocked = record.readiness === "blocked";
  const blockingConflicts = record.conflicts.filter((c) => c.blocksExport);

  const blockedReason = blocked
    ? record.resolution.state !== "verified-match"
      ? `Identity resolution state is "${record.resolution.state}": ${record.resolution.rationale}`
      : `Blocking conflict(s): ${blockingConflicts.map((c) => `${c.field} — ${c.note}`).join(" | ")}`
    : null;

  const setId = record.label.splSetId;

  return {
    schemaVersion: SCHEMA_VERSION,
    productKey: record.productKey,
    readiness: record.readiness,
    blockedReason,

    display: {
      brandName: record.identity.brandName,
      genericName: record.identity.genericName,
      labeledIngredient: record.identity.labeledIngredient,
      activeMoiety: record.identity.activeMoiety,
      strengthDisplay: strengthDisplay(record),
      dosageForm: record.identity.dosageForm,
      releaseCharacteristic: record.identity.releaseCharacteristic,
      route: record.identity.route,
      labelerName: record.identity.labelerName,
    },

    identifiers: {
      productNdc: record.identity.productNdc,
      ndc11: record.identity.ndc11List,
      rxcui: record.identity.rxcui,
      rxnormTty: record.identity.rxnormTty,
      unii: record.identity.unii,
      applicationNumber: record.identity.applicationNumber,
      fdaProductNumber: record.identity.fdaProductNumber,
      splSetId: record.identity.splSetId,
      splVersion: record.identity.splVersion,
    },

    document: {
      title: record.label.documentTitle,
      splEffectiveDate: record.label.splEffectiveDate,
      dailyMedPublishedDate: record.label.dailyMedPublishedDate,
      productsInDocument: record.label.productsInDocument,
      sourceUrl: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${setId}`,
      medicationGuideUrl: `https://dailymed.nlm.nih.gov/dailymed/medguide.cfm?setid=${setId}`,
    },

    // Blocked records ship no label content. A consumer cannot accidentally
    // render text from a product we could not confirm.
    professionalLabeling: blocked ? [] : record.label.sections.map(exportSection),
    patientLabeling: blocked ? [] : record.label.patientLabeling.map(exportSection),

    approval: record.approval.present
      ? {
          available: true,
          applicationNumber: record.approval.applicationNumber,
          sponsorName: record.approval.sponsorName,
          productNumber: record.approval.matchedProduct.productNumber,
          strength: record.approval.matchedProduct.strength,
          dosageForm: record.approval.matchedProduct.dosageForm,
          marketingStatus: record.approval.matchedProduct.marketingStatus,
          approvalDates: record.approval.submissions
            .filter((s) => s.status === "AP" || /approval/i.test(s.type))
            .map((s) => ({ type: s.type, status: s.status, date: s.date })),
          otherProductsInApplication: record.approval.otherProductsInApplication,
        }
      : { available: false, reason: record.approval.reason },

    verification: {
      resolutionState: record.resolution.state,
      rationale: record.resolution.rationale,
      evidence: record.resolution.evidence.map((e) => ({
        dimension: e.dimension,
        expected: e.expected,
        observed: e.observed,
        agrees: e.agrees,
        source: e.sourceId,
      })),
      otherProductsConsidered: record.resolution.competingCandidates.map((c) => ({
        label: c.label,
        why: c.why,
      })),
    },

    conflicts: record.conflicts.map((c) => ({
      field: c.field,
      assessment: c.assessment,
      blocksExport: c.blocksExport,
      note: c.note,
    })),

    clinicalReview: {
      reviewed: false,
      note: record.clinicalReview.note,
    },

    freshness: {
      ingestedAt: record.ingestedAt,
      splEffectiveDate: record.label.splEffectiveDate,
      sourceEffectiveDate: record.label.splEffectiveDate,
    },

    notProvided: [...NOT_PROVIDED],
  };
}

/** Counts, used by the completeness report. */
export function exportStats(e: MedicationExport) {
  const count = (sections: ExportedSection[]): number =>
    sections.reduce((n, s) => n + 1 + count(s.subsections), 0);
  const tables = (sections: ExportedSection[]): number =>
    sections.reduce((n, s) => n + s.tables.length + tables(s.subsections), 0);
  return {
    professionalSections: count(e.professionalLabeling),
    patientSections: count(e.patientLabeling),
    tables: tables(e.professionalLabeling) + tables(e.patientLabeling),
  };
}

export { walkSections };
