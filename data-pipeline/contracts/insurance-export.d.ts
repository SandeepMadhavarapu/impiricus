/**
 * MedBridge insurance contract — v1.0.0
 *
 * Dependency-free types for `data-pipeline/data/exports/insurance/*.json`.
 * No runtime code, no imports. Copy it or import it directly.
 *
 * FIVE THINGS THIS CONTRACT KEEPS SEPARATE, because collapsing any two of them
 * is how a coverage tool starts making claims it cannot support:
 *
 *   1. PLAN IDENTITY          which exact plan, in which year
 *   2. FORMULARY MEMBERSHIP   is the drug on that plan's published list
 *   3. ACCESS POLICY          PA / step therapy / quantity limits
 *   4. COST-SHARING RULE      what the plan PUBLISHES for a tier
 *   5. MEMBER BENEFIT         what a specific person would actually pay
 *
 * This pipeline reaches 1-4 from public documents. It cannot reach 5 at all.
 * `memberBenefitVerified` is `false` on every result.
 */

export type PlanMarket =
  | "medicare-part-d"
  | "medicare-advantage-pd"
  | "marketplace-qhp"
  | "medicaid-ffs"
  | "medicaid-managed-care"
  | "commercial";

/**
 * Coverage state.
 *
 * Read the distinctions carefully — each exists because the obvious shorthand
 * would be a lie:
 *
 *   not-found-in-checked-source  is NOT "not covered"
 *   conditional                  PA required is NOT approval
 *   listed                       is NOT a guarantee of payment
 *   explicitly-excluded          the source really does exclude it
 *   stale-source                 evidence is from a different plan year
 */
export type CoverageState =
  | "listed"
  | "explicitly-excluded"
  | "not-found-in-checked-source"
  | "conditional"
  | "ambiguous-plan"
  | "ambiguous-drug"
  | "stale-source"
  | "source-unavailable";

/**
 * What the SOURCE actually listed.
 *
 * Verified within the CMS 2026-08 release, filtered to our products' RXCUIs:
 * branded Singulair (RXCUI 153892) appears on exactly ONE of the formularies
 * retained, while generic montelukast concepts appear on hundreds. A
 * `clinical-drug` match is NOT a brand listing. These counts describe that
 * release and that filter, not Part D as a whole.
 */
export type MatchGranularity =
  | "exact-product"
  | "clinical-drug"
  | "ingredient"
  | "drug-class"
  | "ambiguous-text";

export type TriState = "yes" | "no" | "unknown" | "not-applicable";

/** Identifiers are STRINGS. "034" and "000" lose meaning as numbers. */
export interface PlanIdentity {
  planKey: string;
  market: PlanMarket;
  planYear: number;
  contractId: string | null;
  planId: string | null;
  segmentId: string | null;
  formularyId: string | null;
  hiosIssuerId: string | null;
  hiosPlanId: string | null;
  planVariant: string | null;
  stateCode: string | null;
  medicaidProgram: string | null;
  managedCarePlanId: string | null;
  organizationName: string | null;
  planName: string | null;
  serviceArea: string | null;
}

/**
 * Plan resolution.
 *
 * A plan NAME never resolves a plan: 39 plans in the 2026-08 release share the
 * name "AARP Medicare Rx Preferred from UHC (PDP)". When unresolved you get
 * candidates and the fields needed to disambiguate — never a coverage answer.
 */
export interface PlanResolution {
  state: "resolved" | "ambiguous" | "not-found" | "source-unavailable";
  plan: PlanIdentity | null;
  candidates: Array<{ planKey: string; planName: string | null; formularyId: string | null }>;
  missingDisambiguators: string[];
  rationale: string;
}

export interface AccessPolicy {
  priorAuthorization: TriState;
  stepTherapy: TriState;
  quantityLimit: {
    present: TriState;
    amount: string | null;
    /** Period in DAYS as published. "3 per 28 days" is not "3 per month". */
    days: string | null;
    asStated: string | null;
  };
  /** Plan-defined tier NUMBER. Its meaning varies by plan and is not a price. */
  tier: number | null;
  tierLabel: string | null;
  preferredStatus: "preferred" | "non-preferred" | "unknown" | "not-applicable";
  specialtyPharmacyRequired: TriState;
  ageRestriction: string | null;
  indicationCriteria: string | null;
  benefitScope: "pharmacy" | "medical" | "unknown";
  effectiveStart: string | null;
  effectiveEnd: string | null;
  exceptionProcessUrl: string | null;
  notes: string[];
}

/** Every cost figure is tagged with WHAT KIND of number it is. */
export type CostBasis =
  | "published-plan-cost-sharing-rule"
  | "cash-price"
  | "discount-card-price"
  | "public-price-estimate"
  | "member-specific-estimate"
  | "adjudicated-claim";

export interface CostSharingRule {
  basis: CostBasis;
  coverageLevel: string | null;
  daysSupply: string | null;
  costType: string | null;
  amount: string | null;
  pharmacyTier: "preferred" | "non-preferred" | "unknown";
  caveat: string;
}

export interface FormularyEvidence {
  matchedRxcui: string | null;
  matchedConceptName: string | null;
  granularity: MatchGranularity;
  /** True ONLY when the matched concept is this exact product. */
  isExactProductMatch: boolean;
  formularyId: string | null;
  formularyVersion: string | null;
  policy: AccessPolicy;
  costSharing: CostSharingRule[];
  provenance: Array<{
    sourceName: string;
    url: string;
    retrievedAt: string;
    sourceEffectiveDate: string | null;
    contentHash: string;
    locator: string | null;
  }>;
  /** The source row verbatim, so the parse is checkable. */
  supportingRow: Record<string, string | null>;
}

export interface CoverageLookupResult {
  schemaVersion: string;
  state: CoverageState;
  /** Plain sentence matched to the state. Safe to render. */
  headline: string;

  checked: {
    plan: PlanIdentity | null;
    planResolution: PlanResolution;
    medicationProductKey: string;
    medicationRxcui: string | null;
    rxcuisSearched: Array<{ rxcui: string; granularity: MatchGranularity; name: string | null }>;
    sourceIds: string[];
    planYear: number;
  };

  found: FormularyEvidence[];
  restrictions: string[];
  /** What remains genuinely unknown. Worth surfacing to the user. */
  unknown: string[];

  freshness: {
    sourceRelease: string | null;
    sourcePublished: string | null;
    retrievedAt: string;
    planYear: number;
    /** True when evidence year differs from the requested plan year. */
    yearMismatch: boolean;
  };

  /** Always false. No authorised member-specific integration exists. */
  memberBenefitVerified: false;
  memberBenefitNote: string;

  nextSteps: Array<{ label: string; detail: string; url: string | null }>;
  caveats: string[];
}

/* ------------------------------------------------------- source register */

export type SourceAccess =
  | "public-open"
  | "public-registration-required"
  | "restricted"
  | "paid"
  | "obsolete"
  | "unavailable";

/**
 * Discovery is not retrieval.
 *
 * Only `retrieved-validated` and `verified-against-original` sources
 * contributed data to any export.
 */
export type RetrievalStatus =
  | "discovered"
  | "retrieved-validated"
  | "verified-against-original"
  | "retrieval-failed"
  | "not-attempted";

export interface SourceRegisterEntry {
  id: string;
  owner: string;
  title: string;
  officialUrl: string;
  sourceType: string;
  market: PlanMarket | null;
  populationCovered: string;
  geography: string;
  planYear: number | null;
  datasetVersion: string | null;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  publishedDate: string | null;
  retrievedAt: string | null;
  access: SourceAccess;
  accessNotes: string;
  updateCadence: string;
  format: string;
  parser: string | null;
  licensing: string;
  knownGaps: string[];
  retrievalStatus: RetrievalStatus;
  approximateSize: string | null;
  verificationNotes: string;
}

export interface SourceRegister {
  schemaVersion: string;
  generatedAt: string;
  note: string;
  entries: SourceRegisterEntry[];
}

/** `data/exports/insurance/plans.json` */
export interface PlanIndex {
  schemaVersion: string;
  market: string;
  sourceRelease: string;
  contractYear: string | null;
  retrievedAt: string;
  note: string;
  planCount: number;
  plans: Array<{
    planKey: string;
    contractId: string;
    planId: string;
    segmentId: string | null;
    formularyId: string;
    organizationName: string | null;
    planName: string | null;
  }>;
}

/** `data/exports/insurance/coverage-examples.json` */
export interface CoverageExamples {
  schemaVersion: string;
  generatedAt: string;
  note: string;
  examples: Array<{
    scenario: string;
    exercises: string;
    request: Record<string, unknown>;
    response: CoverageLookupResult;
  }>;
}
