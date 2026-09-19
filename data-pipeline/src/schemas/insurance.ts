import { z } from "zod";
import { ProvenanceSchema } from "./index.js";

/**
 * Insurance schemas.
 *
 * Five concepts are kept deliberately separate, because collapsing any two of
 * them is how a coverage tool starts making claims it cannot support:
 *
 *   1. PLAN IDENTITY          which exact plan, in which year
 *   2. FORMULARY MEMBERSHIP   is this drug on that plan's published drug list
 *   3. ACCESS POLICY          PA / step therapy / quantity limits / restrictions
 *   4. COST-SHARING RULE      what the plan PUBLISHES for a tier
 *   5. MEMBER BENEFIT         what a specific person would actually pay
 *
 * This pipeline can reach 1-4 from public documents. It cannot reach 5 at all,
 * and nothing here may be presented as 5.
 */

export const INSURANCE_SCHEMA_VERSION = "1.0.0";

/* ------------------------------------------------------------ plan market */

export const PlanMarketSchema = z.enum([
  "medicare-part-d",
  "medicare-advantage-pd",
  "marketplace-qhp",
  "medicaid-ffs",
  "medicaid-managed-care",
  "commercial",
]);
export type PlanMarket = z.infer<typeof PlanMarketSchema>;

/**
 * Exact plan identity.
 *
 * Identifiers are STRINGS. Plan ids like "007" and segment ids like "000" lose
 * meaning as numbers. An insurer name alone never identifies a plan: "Aetna"
 * maps to hundreds of distinct formularies and benefit designs.
 */
export const PlanIdentitySchema = z.object({
  /** Stable join key, e.g. "medicare-partd-2026-H0028-007-000". */
  planKey: z.string(),
  market: PlanMarketSchema,
  /** The plan year the evidence belongs to. Never inferred from "newest". */
  planYear: z.number().int(),

  /* Medicare */
  contractId: z.string().nullable(),
  planId: z.string().nullable(),
  segmentId: z.string().nullable(),
  formularyId: z.string().nullable(),

  /* Marketplace */
  hiosIssuerId: z.string().nullable(),
  hiosPlanId: z.string().nullable(),
  /** CSR variant, e.g. "01", "04". Different variants, different cost sharing. */
  planVariant: z.string().nullable(),

  /* Medicaid */
  stateCode: z.string().nullable(),
  medicaidProgram: z.string().nullable(),
  managedCarePlanId: z.string().nullable(),

  /* Display */
  organizationName: z.string().nullable(),
  planName: z.string().nullable(),
  serviceArea: z.string().nullable(),
});
export type PlanIdentity = z.infer<typeof PlanIdentitySchema>;

/** Returned when a plan cannot be pinned down. */
export const PlanResolutionSchema = z.object({
  state: z.enum(["resolved", "ambiguous", "not-found", "source-unavailable"]),
  plan: PlanIdentitySchema.nullable(),
  /** Candidates when ambiguous, capped for readability. */
  candidates: z.array(
    z.object({ planKey: z.string(), planName: z.string().nullable(), formularyId: z.string().nullable() })
  ),
  /** Which inputs would disambiguate. */
  missingDisambiguators: z.array(z.string()),
  rationale: z.string(),
});
export type PlanResolution = z.infer<typeof PlanResolutionSchema>;

/* ------------------------------------------------------ match granularity */

/**
 * What the SOURCE actually listed.
 *
 * Verified live: Singulair's branded RXCUI 153892 appears on 1 Part D formulary,
 * while the generic montelukast clinical-drug concepts appear on ~328. A
 * listing for the generic concept is NOT a listing for the branded product, and
 * a broad match is never promoted to an exact one.
 */
export const MatchGranularitySchema = z.enum([
  "exact-product",
  "clinical-drug",
  "ingredient",
  "drug-class",
  "ambiguous-text",
]);
export type MatchGranularity = z.infer<typeof MatchGranularitySchema>;

/* --------------------------------------------------------- tri-state ----- */

export const TriStateSchema = z.enum(["yes", "no", "unknown", "not-applicable"]);
export type TriState = z.infer<typeof TriStateSchema>;

/* ----------------------------------------------------------- quantity ---- */

export const QuantityLimitSchema = z.object({
  present: TriStateSchema,
  /** Numeric amount as published. */
  amount: z.string().nullable(),
  /** Period in days as published. Units matter: 3 per 28 days != 3 per month. */
  days: z.string().nullable(),
  /** Rendered exactly as the source expresses it. */
  asStated: z.string().nullable(),
});

/* ------------------------------------------------------- access policy --- */

export const AccessPolicySchema = z.object({
  priorAuthorization: TriStateSchema,
  stepTherapy: TriStateSchema,
  quantityLimit: QuantityLimitSchema,
  /** Plan-defined tier NUMBER. Its meaning varies by plan. */
  tier: z.number().int().nullable(),
  /** The plan's own label for the tier, when published. */
  tierLabel: z.string().nullable(),
  preferredStatus: z.enum(["preferred", "non-preferred", "unknown", "not-applicable"]),
  specialtyPharmacyRequired: TriStateSchema,
  ageRestriction: z.string().nullable(),
  indicationCriteria: z.string().nullable(),
  /** pharmacy benefit vs medical benefit. */
  benefitScope: z.enum(["pharmacy", "medical", "unknown"]),
  effectiveStart: z.string().nullable(),
  effectiveEnd: z.string().nullable(),
  /** Official exception / appeal route. */
  exceptionProcessUrl: z.string().nullable(),
  notes: z.array(z.string()),
});
export type AccessPolicy = z.infer<typeof AccessPolicySchema>;

/* ---------------------------------------------------------- cost basis --- */

/**
 * Cost information, tagged by what KIND of number it is.
 *
 * A tier does not imply a dollar amount. Coinsurance without a price basis is
 * not a price. Wholesale/benchmark prices are never a patient's out-of-pocket.
 */
export const CostBasisSchema = z.enum([
  "published-plan-cost-sharing-rule",
  "cash-price",
  "discount-card-price",
  "public-price-estimate",
  "member-specific-estimate",
  "adjudicated-claim",
]);

export const CostSharingRuleSchema = z.object({
  basis: CostBasisSchema,
  coverageLevel: z.string().nullable(),
  daysSupply: z.string().nullable(),
  /** "COPAY" or "COINSURANCE" as published. */
  costType: z.string().nullable(),
  /** Amount as published; a copay in dollars or a coinsurance percentage. */
  amount: z.string().nullable(),
  pharmacyTier: z.enum(["preferred", "non-preferred", "unknown"]),
  caveat: z.string(),
});

/* -------------------------------------------------------- coverage state */

export const CoverageStateSchema = z.enum([
  /** On the checked plan's published formulary. */
  "listed",
  /** The source explicitly excludes it. Different from not-found. */
  "explicitly-excluded",
  /** Absent from the source we checked. NOT "not covered". */
  "not-found-in-checked-source",
  /** Listed but subject to PA / step therapy / limits. */
  "conditional",
  /** The plan could not be pinned down. */
  "ambiguous-plan",
  /** The drug could not be pinned down at the requested granularity. */
  "ambiguous-drug",
  /** Evidence exists but is out of date for the requested plan year. */
  "stale-source",
  /** The source could not be reached. */
  "source-unavailable",
]);
export type CoverageState = z.infer<typeof CoverageStateSchema>;

/* ----------------------------------------------------------- the result -- */

export const FormularyEvidenceSchema = z.object({
  /** Which RXCUI the source row actually matched. */
  matchedRxcui: z.string().nullable(),
  matchedConceptName: z.string().nullable(),
  granularity: MatchGranularitySchema,
  /** True only when the matched concept IS our exact product concept. */
  isExactProductMatch: z.boolean(),
  formularyId: z.string().nullable(),
  formularyVersion: z.string().nullable(),
  policy: AccessPolicySchema,
  costSharing: z.array(CostSharingRuleSchema),
  provenance: z.array(ProvenanceSchema),
  /** The source row, verbatim, so a reader can check the parse. */
  supportingRow: z.record(z.string(), z.string().nullable()),
});
export type FormularyEvidence = z.infer<typeof FormularyEvidenceSchema>;

export const CoverageLookupResultSchema = z.object({
  schemaVersion: z.literal(INSURANCE_SCHEMA_VERSION),
  state: CoverageStateSchema,
  /** Plain sentence matched to the state. Safe to render. */
  headline: z.string(),

  /** Exactly what was checked. */
  checked: z.object({
    plan: PlanIdentitySchema.nullable(),
    planResolution: PlanResolutionSchema,
    medicationProductKey: z.string(),
    medicationRxcui: z.string().nullable(),
    /** Every RXCUI we searched for, and at what granularity. */
    rxcuisSearched: z.array(
      z.object({ rxcui: z.string(), granularity: MatchGranularitySchema, name: z.string().nullable() })
    ),
    sourceIds: z.array(z.string()),
    planYear: z.number().int(),
  }),

  /** What was found, with its evidence. */
  found: z.array(FormularyEvidenceSchema),

  /** Restrictions, summarised without flattening the detail away. */
  restrictions: z.array(z.string()),

  /** What remains genuinely unknown. */
  unknown: z.array(z.string()),

  /** Source freshness. */
  freshness: z.object({
    sourceRelease: z.string().nullable(),
    sourcePublished: z.string().nullable(),
    retrievedAt: z.string(),
    planYear: z.number().int(),
    /** True when the evidence year differs from the requested plan year. */
    yearMismatch: z.boolean(),
  }),

  /** Member-specific benefit is never verified by this pipeline. */
  memberBenefitVerified: z.literal(false),
  memberBenefitNote: z.string(),

  /** Official next steps the user can actually take. */
  nextSteps: z.array(z.object({ label: z.string(), detail: z.string(), url: z.string().nullable() })),

  caveats: z.array(z.string()),
});
export type CoverageLookupResult = z.infer<typeof CoverageLookupResultSchema>;

/* ------------------------------------------------------- source register */

export const SourceAccessSchema = z.enum([
  "public-open",
  "public-registration-required",
  "restricted",
  "paid",
  "obsolete",
  "unavailable",
]);

export const RetrievalStatusSchema = z.enum([
  /** We found and read the documentation, but have not retrieved records. */
  "discovered",
  /** We retrieved records and validated their structure. */
  "retrieved-validated",
  /** We retrieved records and checked values against the original document. */
  "verified-against-original",
  /** We tried and failed. */
  "retrieval-failed",
  /** Deliberately not retrieved, with a reason. */
  "not-attempted",
]);

export const SourceRegisterEntrySchema = z.object({
  id: z.string(),
  owner: z.string(),
  title: z.string(),
  officialUrl: z.string(),
  sourceType: z.enum([
    "formulary-dataset",
    "plan-crosswalk",
    "pharmacy-network",
    "cost-sharing",
    "plan-attributes",
    "policy-document",
    "preferred-drug-list",
    "assistance-program",
    "benefit-api",
    "machine-readable-index",
  ]),
  market: PlanMarketSchema.nullable(),
  populationCovered: z.string(),
  geography: z.string(),
  planYear: z.number().int().nullable(),
  datasetVersion: z.string().nullable(),
  effectiveStart: z.string().nullable(),
  effectiveEnd: z.string().nullable(),
  publishedDate: z.string().nullable(),
  retrievedAt: z.string().nullable(),
  access: SourceAccessSchema,
  accessNotes: z.string(),
  updateCadence: z.string(),
  format: z.string(),
  parser: z.string().nullable(),
  licensing: z.string(),
  knownGaps: z.array(z.string()),
  retrievalStatus: RetrievalStatusSchema,
  /** Size, so a reader can judge before downloading. */
  approximateSize: z.string().nullable(),
  verificationNotes: z.string(),
});
export type SourceRegisterEntry = z.infer<typeof SourceRegisterEntrySchema>;

/**
 * Supported scope, carried in the exports so consumers do not have to trust a
 * doc that may drift from the data.
 */
export const SupportedScopeSchema = z.object({
  products: z.literal("three-selected-products"),
  formularyEvidence: z.literal("public-formulary-evidence-from-verified-cms-release"),
  markets: z.literal("medicare-part-d-only"),
  memberSpecificCoverage: z.literal(false),
  copayVerification: z.literal(false),
  comprehensiveInteractionChecker: z.literal(false),
  clinicalReview: z.literal(false),
  statements: z.array(z.string()),
});

export const SourceRegisterSchema = z.object({
  schemaVersion: z.literal(INSURANCE_SCHEMA_VERSION),
  generatedAt: z.string(),
  note: z.string(),
  /** What this pipeline covers. Medicare Part D only; no member benefit. */
  supportedScope: SupportedScopeSchema,
  entries: z.array(SourceRegisterEntrySchema),
});
export type SourceRegister = z.infer<typeof SourceRegisterSchema>;
