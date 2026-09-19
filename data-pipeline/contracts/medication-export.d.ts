/**
 * MedBridge medication export contract — v1.0.0
 *
 * Dependency-free TypeScript types for the JSON written to
 * `data-pipeline/data/exports/<productKey>.json`.
 *
 * Copy this file into the app (or import it directly). It has no runtime code,
 * no imports and no dependency on the pipeline package, so consuming the data
 * never means adopting the pipeline's toolchain.
 *
 * READ THIS FIRST
 *
 *   `readiness: "app-ready"` means STRUCTURALLY CONSUMABLE. It does NOT mean
 *   clinically approved, clinically reviewed, or safe to present as advice.
 *   `clinicalReview.reviewed` is `false` on every record this pipeline can
 *   currently produce.
 *
 *   A record with `readiness: "blocked"` carries NO label content by design.
 *   Render `blockedReason`, not an empty page.
 */

export type Readiness = "app-ready" | "partial" | "blocked";

export type ResolutionState =
  | "verified-match"
  | "ambiguous"
  | "conflicting"
  | "unmatched"
  | "source-unavailable";

export type Audience = "professional" | "patient" | "unknown";

/** A table from the label, with structure intact. Never flatten this. */
export interface ExportedTable {
  caption: string | null;
  /** Header rows. Usually one row, occasionally more for grouped headers. */
  headers: string[][];
  /** Body rows. Cell order matches the header columns. */
  rows: string[][];
}

/**
 * One label section.
 *
 * Sections nest: "5.1 Neuropsychiatric Events" is a `subsection` of
 * "5 WARNINGS AND PRECAUTIONS". Render the hierarchy; do not flatten it.
 */
/**
 * How a section relates to the product this record describes.
 *
 * APPLICABILITY LIMITATION - read before generating any dosing text.
 *
 * One SPL routinely covers several products that share a label but not a dose:
 * Singulair's label covers the 10 mg tablet, the chewable tablets and the oral
 * granules, each dosed differently. Most sections in these documents are not
 * structurally bound to any one of them.
 *
 * Consequently `document-level-unresolved` is the MAJORITY state, and it means
 * only this: the document did not say which product the section is about. It
 * is not a weak yes. It is not "probably this product". Nothing in the data
 * upgrades it, because the information is absent from the source.
 *
 * Sections in that state MUST NOT be used to generate product-specific dosing
 * instructions, administration steps or patient directions, automatically or
 * otherwise. They remain available as source material to read and cite.
 *
 * Only `exact-product` and `explicitly-shared` sections are safe for
 * product-specific guidance. The pipeline enforces this on its side via
 * `productSpecificSections()`, which returns those two states and drops the
 * rest; a consumer that walks `professionalLabeling` directly is bypassing
 * that filter and must apply the same rule itself.
 */
export type Applicability =
  | "exact-product"
  | "explicitly-shared"
  | "document-level-unresolved"
  | "not-applicable";

export interface ExportedSection {
  /** LOINC code identifying the section type. Stable across labelers. */
  loincCode: string | null;
  /** Section number as printed, e.g. "5.1". Null when the label prints none. */
  printedNumber: string | null;
  title: string | null;
  /** Paragraph text in document order. Table content is NOT included here. */
  paragraphs: string[];
  /**
   * FDA "Highlights of Prescribing Information" summary text. The label itself
   * states highlights do not include all the information needed, so render them
   * as a summary, never as the section body.
   */
  highlights: string[];
  tables: ExportedTable[];
  subsections: ExportedSection[];
  applicability: Applicability;
  /** Products this section is scoped to. Empty + unresolved != "applies to all". */
  appliesToProducts: string[];
  audience: Audience;
}

export interface MedicationExport {
  schemaVersion: string;
  /** Stable join key and filename stem. */
  productKey: string;
  readiness: Readiness;
  /** Non-null only when readiness is "blocked". Show this to the user. */
  blockedReason: string | null;

  display: {
    brandName: string | null;
    genericName: string;
    /** The ingredient as the labeler names it. May be a salt. */
    labeledIngredient: string;
    /** The active moiety, when the label distinguishes it from the salt. */
    activeMoiety: string | null;
    /** Preformatted, e.g. "10 mg" or "1.34 mg/1 mL". Safe to render as-is. */
    strengthDisplay: string;
    dosageForm: string;
    releaseCharacteristic: "immediate" | "extended" | "delayed" | "unstated";
    route: string[];
    labelerName: string | null;
  };

  identifiers: {
    /** 10-digit hyphenated labeler-product code, e.g. "78206-172". */
    productNdc: string | null;
    /** 11-digit package codes, converted only where unambiguous. */
    ndc11: string[];
    rxcui: string | null;
    /** RxNorm term type, e.g. "SBD". Component types (SBDC) carry no NDCs. */
    rxnormTty: string | null;
    unii: string[];
    applicationNumber: string | null;
    /** Product number WITHIN the application. Never another product's. */
    fdaProductNumber: string | null;
    splSetId: string | null;
    splVersion: string | null;
  };

  document: {
    title: string;
    /** The label's own effective date. NOT when we fetched it. */
    splEffectiveDate: string;
    dailyMedPublishedDate: string | null;
    /**
     * Every product this one SPL describes. Often more than one. Content in
     * `professionalLabeling` may discuss any of them, so show this list when
     * presenting dosing.
     */
    productsInDocument: string[];
    sourceUrl: string;
    medicationGuideUrl: string;
  };

  /** Official prescribing information. Professional audience. */
  professionalLabeling: ExportedSection[];
  /** Official patient-directed text (Medication Guide, IFU). Prefer this for patients. */
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
        /** Listed so you can see the application is broader. Never merge these. */
        otherProductsInApplication: Array<{
          productNumber: string;
          strength: string;
          dosageForm: string;
        }>;
      }
    | { available: false; reason: string };

  /** Why we believe this is the right product. Auditable, no opaque score. */
  verification: {
    resolutionState: ResolutionState;
    rationale: string;
    evidence: Array<{
      dimension: string;
      expected: string;
      observed: string;
      agrees: boolean;
      source: string;
    }>;
    otherProductsConsidered: Array<{ label: string; why: string }>;
  };

  conflicts: Array<{
    field: string;
    assessment:
      | "different-scope"
      | "version-skew"
      | "identity-mismatch"
      | "genuine-disagreement"
      | "uninvestigated";
    blocksExport: boolean;
    note: string;
  }>;

  /**
   * Interactions DESCRIBED BY THIS LABEL.
   *
   * Two separate facts, both reported:
   *   - the label's own Drug Interactions section (often present and useful)
   *   - whether an interaction-CHECKING service exists (it does not; the RxNav
   *     Interaction API was discontinued)
   *
   * `availability: "no-label-section"` is a fact about the DOCUMENT. It is not
   * evidence that no interactions exist, and must never be rendered that way.
   */
  interactions: {
    availability:
      | "label-section-available"
      | "label-section-empty"
      | "no-label-section"
      | "not-retrieved";
    checkingServiceAvailable: false;
    checkingServiceNote: string;
    /**
     * The full interaction sections, verbatim. THIS IS THE EVIDENCE.
     * `mentions` below is an index into it, not a replacement for it.
     */
    sections: ExportedSection[];
    /**
     * Substances tied to the sentence they came from.
     *
     * CHECK `direction` BEFORE RENDERING. Two negative directions exist and
     * they are NOT interchangeable:
     *
     *   no-dose-adjustment-stated
     *     The label says the dose need not change. It says NOTHING about
     *     whether an interaction exists. Interaction status: UNKNOWN.
     *     Rendering this as "no interaction" asserts something the label
     *     never said.
     *
     *   no-interaction-observed-stated
     *     The label says an interaction was looked for and not observed, or
     *     was found not to be clinically significant.
     *
     * Singulair's substances are all the FIRST kind: they come from "No dose
     * adjustment is needed when SINGULAIR is co-administered with ... warfarin
     * ...". That sentence is dosing guidance. It neither warns about warfarin
     * nor clears it.
     */
    mentions: Array<{
      substance: string;
      direction:
        | "no-dose-adjustment-stated"
        | "no-interaction-observed-stated"
        | "other-affects-this"
        | "this-affects-other"
        | "interaction-described-direction-unclear"
        | "mentioned-unclassified";
      /** The sentence, verbatim. Render this, never the name alone. */
      supportingText: string;
      /** Qualifiers preserved from the sentence, e.g. "use with caution". */
      qualifiers: string[];
      /** True when the label describes an interaction. */
      isAdverseInteraction: boolean;
      /** True ONLY for an observed absence. Never true for dosing guidance. */
      assertsNoInteraction: boolean;
      /** True when the sentence is dosing guidance and status is unknown. */
      isDosingGuidanceOnly: boolean;
    }>;
    /**
     * Substances for which the label states no DOSE ADJUSTMENT is needed.
     *
     * Not a clearance. Interaction status for these is unknown.
     */
    noDoseAdjustmentStated: string[];
    /** Substances for which the label states no interaction was OBSERVED. */
    noInteractionObservedStated: string[];
    /** Substances with a described interaction. */
    describedInteraction: string[];
    /**
     * EXTRACTION COMPLETENESS - read before interpreting any count as zero.
     *
     * "0 adverse mentions extracted" means the extractor found none in the
     * sentences it could parse. It does NOT mean the label describes no
     * adverse interactions, and it is NOT evidence that none exist.
     *
     * The extractor only harvests names from explicit enumerations following a
     * coadministration phrase. Interactions written as prose, as a drug class,
     * inside a table, or in any other section are not counted. Toprol XL is a
     * live example: its interactions are largely prose, so the index is far
     * shorter than the section.
     *
     * `level` is the literal "index-only-not-exhaustive". There is no
     * "complete" value, because the extractor cannot reach completeness.
     * Treat `mentions`, `noDoseAdjustmentStated`, `noInteractionObservedStated`
     * and `describedInteraction` as INCOMPLETE INDEXES. `sections` is the
     * evidence.
     */
    completeness: {
      level: "index-only-not-exhaustive";
      sentencesScanned: number;
      sentencesWithCoadministrationPhrase: number;
      sentencesYieldingSubstances: number;
      /** Coadministration sentences that yielded nothing: the blind spot. */
      sentencesUnparsed: number;
      evidenceLocation: string;
      note: string;
    };
    caveats: string[];
  };

  /**
   * Recalls, tiered.
   *
   * Only `verified` entries are established recalls of THIS product. Entries in
   * `candidates` share a generic name and nothing more — they frequently belong
   * to a different manufacturer, strength or dose form. Never render a
   * candidate as "this medication was recalled".
   */
  recalls: {
    verified: Array<{
      recallNumber: string;
      tier: string;
      reason: string;
      reportDate: string | null;
      rationale: string;
    }>;
    candidates: Array<{
      recallNumber: string;
      tier: string;
      reason: string;
      productDescription: string;
      rationale: string;
    }>;
    searchStrategy: string;
    caveats: string[];
  } | null;

  /** Section counts by applicability state. */
  applicabilityCounts: Record<string, number>;

  /**
   * The ONLY sections safe to turn into product-specific dosing or patient
   * instructions. Pre-filtered by the pipeline to `exact-product` and
   * `explicitly-shared`.
   *
   * `document-level-unresolved` sections are excluded by construction. See the
   * APPLICABILITY LIMITATION note on `Applicability` for why. Generate dosing
   * text from this array, never from `professionalLabeling`, which still
   * carries every section so it can be read and cited.
   *
   * An empty `sections` array means the document scoped nothing to this
   * product. It does NOT mean there is no dosing information, and it is not a
   * licence to fall back to unresolved sections.
   */
  productSpecificGuidance: {
    sections: ExportedSection[];
    /** How many sections were held back. Makes the omission visible. */
    excludedUnresolvedCount: number;
    excludedNotApplicableCount: number;
    note: string;
  };

  /** Always false. Never render this record as clinically reviewed. */
  clinicalReview: { reviewed: false; note: string };

  freshness: {
    ingestedAt: string;
    splEffectiveDate: string;
    /** Source-document date. Compare against this, not ingestedAt. */
    sourceEffectiveDate: string;
  };

  /** Things this record deliberately does not establish. Worth surfacing. */
  notProvided: string[];
}

/** `data/exports/index.json` */
export interface ExportIndex {
  generatedAt: string;
  note: string;
  products: Array<{
    productKey: string;
    readiness: Readiness;
    blockedReason: string | null;
    brandName: string | null;
    genericName: string;
    strengthDisplay: string;
    dosageForm: string;
    rxcui: string | null;
    splSetId: string | null;
    /** Filename within data/exports/. */
    file: string;
    professionalSections: number;
    patientSections: number;
    tables: number;
  }>;
}

/* ------------------------------------------------------------------ scope */

/**
 * SUPPORTED SCOPE
 *
 * What this pipeline covers, stated once, plainly:
 *
 *   - Three selected medication products. Not a drug database.
 *   - Public formulary evidence from the verified CMS release.
 *   - Medicare Part D only. No Marketplace, Medicaid or commercial coverage.
 *   - No member-specific coverage verification and no copay verification.
 *   - No comprehensive interaction checker.
 *   - No clinical review.
 *
 * Anything outside that list is not supported, not partially supported, and
 * not approximated. The pipeline reports absence rather than filling it in.
 */
export interface SupportedScope {
  products: "three-selected-products";
  formularyEvidence: "public-formulary-evidence-from-verified-cms-release";
  markets: "medicare-part-d-only";
  memberSpecificCoverage: false;
  copayVerification: false;
  comprehensiveInteractionChecker: false;
  clinicalReview: false;
  /** The six statements above, as renderable sentences. */
  statements: string[];
}
