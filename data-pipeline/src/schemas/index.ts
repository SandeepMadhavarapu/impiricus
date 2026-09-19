import { z } from "zod";

/**
 * The pipeline contract.
 *
 * Teammates consume the exported JSON. They do NOT need to install this
 * package: every export validates against the JSON Schema emitted by
 * `npm run export`, and the TypeScript types here can be copied or imported
 * from the generated `.d.ts`.
 *
 * Two ideas run through all of it:
 *
 *  1. Absence is typed. A field is never silently empty — it carries a reason
 *     (`not-present-in-source`, `retrieval-failed`, ...). An empty field must
 *     never read as "no risk" or "no interaction".
 *  2. Identity is earned. A product is `verified-match` only when concrete
 *     evidence says so; anything else is ambiguous, conflicting, unmatched or
 *     source-unavailable, and is never quietly upgraded.
 */

export const SCHEMA_VERSION = "1.0.0";

/* ------------------------------------------------------------- absence ---- */

export const MissingReasonSchema = z.enum([
  /** The source document genuinely does not contain this. */
  "not-present-in-source",
  /** The concept does not apply to this product (e.g. IFU for a plain tablet). */
  "not-applicable",
  /** We did not attempt to retrieve it. */
  "not-retrieved",
  /** We attempted and the source failed. */
  "retrieval-failed",
  /** Present, but we cannot tell which product/population it applies to. */
  "ambiguous-applicability",
]);
export type MissingReason = z.infer<typeof MissingReasonSchema>;

/** A value that may be legitimately absent, with the reason recorded. */
export const AbsentSchema = z.object({
  present: z.literal(false),
  reason: MissingReasonSchema,
  note: z.string().optional(),
});

export function absent(reason: MissingReason, note?: string) {
  return { present: false as const, reason, ...(note ? { note } : {}) };
}

export function presentValue<T>(value: T) {
  return { present: true as const, value };
}

/* ---------------------------------------------------------- provenance ---- */

export const ProvenanceSchema = z.object({
  sourceId: z.enum(["rxnav", "dailymed", "openfda", "drugsfda", "nppes"]),
  sourceName: z.string(),
  /** Sanitized URL — credentials are stripped before persistence. */
  url: z.string(),
  retrievedAt: z.string(),
  /**
   * The document's own publication / effective / update date. Null when the
   * source did not supply one. Retrieval time is NEVER substituted for this.
   */
  sourceEffectiveDate: z.string().nullable(),
  /** Source-native identifier, e.g. an SPL set id or an application number. */
  sourceIdentifier: z.string().nullable(),
  sourceVersion: z.string().nullable(),
  /** Pointer into the immutable raw capture. */
  rawPath: z.string(),
  contentHash: z.string(),
  captureId: z.string(),
  /** Which section/field of the source this fact came from. */
  locator: z.string().nullable(),
  parserVersion: z.string(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** A fact plus everything needed to check it. */
export const TracedSchema = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    value,
    provenance: z.array(ProvenanceSchema).min(1),
    /** Verbatim supporting text, when the fact came from prose. */
    supportingText: z.string().nullable(),
  });

/* ------------------------------------------------------------- identity --- */

export const ResolutionStateSchema = z.enum([
  "verified-match",
  "ambiguous",
  "conflicting",
  "unmatched",
  "source-unavailable",
]);
export type ResolutionState = z.infer<typeof ResolutionStateSchema>;

/** One concrete reason a match was accepted or rejected. Human-readable. */
export const MatchEvidenceSchema = z.object({
  dimension: z.enum([
    "ingredient",
    "active-moiety",
    "salt",
    "brand",
    "strength",
    "dose-form",
    "release-characteristic",
    "route",
    "labeler",
    "rxnorm-tty",
    "ndc",
    "application-number",
    "product-number",
    "spl-set-id",
  ]),
  expected: z.string(),
  observed: z.string(),
  agrees: z.boolean(),
  sourceId: z.string(),
  note: z.string().optional(),
});
export type MatchEvidence = z.infer<typeof MatchEvidenceSchema>;

export const StrengthSchema = z.object({
  /** e.g. 10 */
  numeratorValue: z.number(),
  /** e.g. "mg" */
  numeratorUnit: z.string(),
  /** e.g. 1 for a tablet, 1.5 for "2 mg/1.5 mL" */
  denominatorValue: z.number().nullable(),
  /** e.g. "mL", or null for a discrete unit */
  denominatorUnit: z.string().nullable(),
  /** Exactly as the source rendered it. */
  asStated: z.string(),
  /** Whether the strength is expressed as the salt or the active moiety. */
  basis: z.enum(["salt", "active-moiety", "unstated"]),
});
export type Strength = z.infer<typeof StrengthSchema>;

export const ProductIdentitySchema = z.object({
  /** Stable slug used as the export filename and join key. */
  productKey: z.string(),
  brandName: z.string().nullable(),
  genericName: z.string(),
  /** The ingredient as named by the labeler, which may be a salt. */
  labeledIngredient: z.string(),
  /** The active moiety when the source distinguishes it from the salt. */
  activeMoiety: z.string().nullable(),
  strength: z.array(StrengthSchema),
  dosageForm: z.string(),
  /** Extracted release characteristic; null when the form states none. */
  releaseCharacteristic: z.enum(["immediate", "extended", "delayed", "unstated"]),
  route: z.array(z.string()),
  labelerName: z.string().nullable(),
  productNdc: z.string().nullable(),
  ndc11List: z.array(z.string()),
  applicationNumber: z.string().nullable(),
  /** Product number WITHIN the application — never inherited across products. */
  fdaProductNumber: z.string().nullable(),
  marketingCategory: z.string().nullable(),
  rxcui: z.string().nullable(),
  rxnormTty: z.string().nullable(),
  unii: z.array(z.string()),
  splSetId: z.string().nullable(),
  splVersion: z.string().nullable(),
});
export type ProductIdentity = z.infer<typeof ProductIdentitySchema>;

export const ResolutionSchema = z.object({
  state: ResolutionStateSchema,
  identity: ProductIdentitySchema,
  evidence: z.array(MatchEvidenceSchema),
  /** Populated when state is ambiguous/conflicting. */
  competingCandidates: z.array(
    z.object({ label: z.string(), rxcui: z.string().nullable(), why: z.string() })
  ),
  /** Free-text explanation of why the state is what it is. */
  rationale: z.string(),
  resolvedAt: z.string(),
});
export type Resolution = z.infer<typeof ResolutionSchema>;

/* --------------------------------------------------------------- label ---- */

/** A table preserved as structure, not flattened into prose. */
export const LabelTableSchema = z.object({
  caption: z.string().nullable(),
  headers: z.array(z.array(z.string())),
  rows: z.array(z.array(z.string())),
});
export type LabelTable = z.infer<typeof LabelTableSchema>;

/**
 * How a section relates to the selected product.
 *
 * An empty product list must never be read as "applies to everything". A
 * document routinely covers several products, and a dosing table that belongs
 * to a 4 mg granule must not become an instruction for a 10 mg tablet.
 */
export const ApplicabilitySchema = z.enum([
  /** The section names, or is structurally bound to, this exact product. */
  "exact-product",
  /** The section explicitly covers several products including this one. */
  "explicitly-shared",
  /** The document did not scope it. Usable as source material, NOT as
   *  product-specific dosing or patient instruction. */
  "document-level-unresolved",
  /** The section concerns a different product in the same document. */
  "not-applicable",
]);
export type Applicability = z.infer<typeof ApplicabilitySchema>;

export const LabelSectionSchema: z.ZodType<LabelSection> = z.lazy(() =>
  z.object({
    /** LOINC code from the SPL, when present. */
    loincCode: z.string().nullable(),
    /** Section number as printed, e.g. "5.1". */
    printedNumber: z.string().nullable(),
    title: z.string().nullable(),
    /** Paragraph text in document order, tables excluded. */
    paragraphs: z.array(z.string()),
    /**
     * FDA "Highlights of Prescribing Information" summary text, from
     * <excerpt><highlight>. Kept SEPARATE from paragraphs because the label
     * itself states the highlights do not include all the information needed.
     */
    highlights: z.array(z.string()),
    tables: z.array(LabelTableSchema),
    /** Nested subsections, preserving hierarchy. */
    subsections: z.array(LabelSectionSchema),
    /**
     * Product names this section is scoped to, when the document scopes it.
     * Read `applicability` first — an empty list is not "applies to all".
     */
    appliesToProducts: z.array(z.string()),
    applicability: ApplicabilitySchema,
    /** Professional PI vs patient-directed labeling. */
    audience: z.enum(["professional", "patient", "unknown"]),
  })
);

export interface LabelSection {
  loincCode: string | null;
  printedNumber: string | null;
  title: string | null;
  paragraphs: string[];
  /** FDA Highlights summary text. A summary, not the full section. */
  highlights: string[];
  tables: LabelTable[];
  subsections: LabelSection[];
  appliesToProducts: string[];
  applicability: Applicability;
  audience: "professional" | "patient" | "unknown";
}

/* ------------------------------------------------------------ conflicts --- */

export const ConflictSchema = z.object({
  field: z.string(),
  /** Each side of the disagreement, with its own provenance. */
  claims: z
    .array(
      z.object({
        value: z.string(),
        sourceId: z.string(),
        sourceEffectiveDate: z.string().nullable(),
        sourceVersion: z.string().nullable(),
        rawPath: z.string(),
      })
    )
    .min(2),
  /** Why they differ, once investigated. */
  assessment: z.enum([
    "different-scope",
    "version-skew",
    "identity-mismatch",
    "genuine-disagreement",
    "uninvestigated",
  ]),
  /** Whether this blocks the affected claim from app-ready output. */
  blocksExport: z.boolean(),
  note: z.string(),
});
export type Conflict = z.infer<typeof ConflictSchema>;

/* -------------------------------------------------------------- recalls --- */

export const RecallMatchTierSchema = z.enum([
  /** Generic-name hit only. NOT established to be this product. */
  "discovery-candidate",
  /** The enforcement record declares this product's NDC. */
  "product-match",
  /** A specific package of this product is confirmed. */
  "package-match",
]);

export const ClassifiedRecallSchema = z.object({
  recallNumber: z.string(),
  tier: RecallMatchTierSchema,
  status: z.string(),
  classification: z.string().nullable(),
  reason: z.string(),
  reportDate: z.string().nullable(),
  recallInitiationDate: z.string().nullable(),
  productDescription: z.string(),
  recallingFirm: z.string().nullable(),
  distributionPattern: z.string().nullable(),
  declaredProductNdcs: z.array(z.string()),
  extractedPackageNdcs: z.array(z.string()),
  lotNumbers: z.array(z.string()),
  evidence: z.array(
    z.object({
      dimension: z.string(),
      observed: z.string(),
      agrees: z.boolean(),
      note: z.string().optional(),
    })
  ),
  rationale: z.string(),
});

/* -------------------------------------------------------------- record ---- */

export const ReadinessSchema = z.enum([
  /** Structurally complete and free of blocking conflicts. */
  "app-ready",
  /** Usable but something material is missing or unresolved. */
  "partial",
  /** Blocked by a conflict or a failed identity resolution. */
  "blocked",
]);

export const MedicationRecordSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  productKey: z.string(),
  resolution: ResolutionSchema,
  identity: ProductIdentitySchema,

  /** Full normalized labeling, hierarchy and tables preserved. */
  label: z.object({
    splSetId: z.string(),
    splVersion: z.string(),
    splEffectiveDate: z.string(),
    dailyMedPublishedDate: z.string().nullable(),
    documentTitle: z.string(),
    /** Every product this SPL covers — the multi-product case is explicit. */
    productsInDocument: z.array(z.string()),
    sections: z.array(LabelSectionSchema),
    /** Patient-directed documents, kept separate from professional PI. */
    patientLabeling: z.array(LabelSectionSchema),
    provenance: z.array(ProvenanceSchema),
  }),

  /** RxNorm identity graph. */
  rxnorm: z.union([
    z.object({
      present: z.literal(true),
      rxcui: z.string(),
      tty: z.string(),
      name: z.string(),
      isCurrent: z.boolean(),
      status: z.string(),
      related: z.record(z.string(), z.array(z.object({ rxcui: z.string(), name: z.string() }))),
      ndc11: z.array(z.string()),
      provenance: z.array(ProvenanceSchema),
    }),
    AbsentSchema,
  ]),

  /** Application-level facts, kept distinct from product-level facts. */
  approval: z.union([
    z.object({
      present: z.literal(true),
      applicationNumber: z.string(),
      sponsorName: z.string().nullable(),
      /** ONLY the product within the application that we matched. */
      matchedProduct: z.object({
        productNumber: z.string(),
        strength: z.string(),
        dosageForm: z.string(),
        route: z.string().nullable(),
        marketingStatus: z.string().nullable(),
      }),
      /** Other products in the same application — listed, never merged. */
      otherProductsInApplication: z.array(
        z.object({ productNumber: z.string(), strength: z.string(), dosageForm: z.string() })
      ),
      submissions: z.array(
        z.object({
          type: z.string(),
          number: z.string(),
          status: z.string().nullable(),
          date: z.string().nullable(),
        })
      ),
      provenance: z.array(ProvenanceSchema),
    }),
    AbsentSchema,
  ]),

  /** Supplemental, clearly fenced off from patient-facing claims. */
  supplemental: z.object({
    enforcement: z.union([
      z.object({
        present: z.literal(true),
        note: z.string(),
        records: z.array(
          z.object({
            recallNumber: z.string(),
            status: z.string(),
            classification: z.string().nullable(),
            reason: z.string(),
            reportDate: z.string().nullable(),
            productDescription: z.string(),
            matchedOnNdc: z.boolean(),
          })
        ),
        provenance: z.array(ProvenanceSchema),
      }),
      AbsentSchema,
    ]),
  }),

  /** How the product within the FDA application was selected, or why not. */
  approvalEvidence: z.array(z.string()),

  /**
   * Label-described interactions, kept distinct from an interaction-CHECKING
   * service, which is not available. Absence is never "no interactions".
   */
  interactions: z.object({
    availability: z.enum([
      "label-section-available",
      "label-section-empty",
      "no-label-section",
      "not-retrieved",
    ]),
    checkingServiceAvailable: z.literal(false),
    checkingServiceNote: z.string(),
    sections: z.array(LabelSectionSchema),
    namedSubstances: z.array(z.string()),
    caveats: z.array(z.string()),
  }),

  /** Recalls, tiered. Only `verified` are recalls of this exact product. */
  recalls: z
    .object({
      verified: z.array(ClassifiedRecallSchema),
      candidates: z.array(ClassifiedRecallSchema),
      searchStrategy: z.string(),
      caveats: z.array(z.string()),
    })
    .nullable(),

  /** Section counts by applicability state. */
  applicability: z.record(ApplicabilitySchema, z.number()),

  conflicts: z.array(ConflictSchema),
  readiness: ReadinessSchema,
  /** Always false unless a real, named, dated review is recorded. */
  clinicalReview: z.object({
    reviewed: z.literal(false),
    reviewedAt: z.null(),
    reviewedBy: z.null(),
    note: z.string(),
  }),
  ingestedAt: z.string(),
  parserVersion: z.string(),
});
export type MedicationRecord = z.infer<typeof MedicationRecordSchema>;

export const PARSER_VERSION = "pipeline-0.1.0";
