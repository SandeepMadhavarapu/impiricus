/**
 * MediZ access contract - v1.0.0 (access-1.0.0)
 *
 * Dependency-free types for `data-pipeline/data/exports/access/*.json`.
 *
 * ADDITIVE ONLY. This contract introduces new files and does not change
 * `medication-export.d.ts` or `insurance-export.d.ts`. Existing exports keep
 * their shapes and their meanings; nothing a consumer already reads has moved.
 *
 * WHAT THIS ANSWERS
 *
 *   What does this plan publish about this medication?   listingStatus
 *   What restriction applies?                            requirements[]
 *   What does the published policy require next?         actions[]
 *   Where is the official form or contact?               actions[].formUrl, contacts[]
 *   What is uncertain?                                   unknowns[], extractionLimitations[]
 *   Has the underlying information changed?              source-changes.json
 *
 * WHAT IT NEVER ANSWERS
 *
 * Whether a particular person is covered, eligible, or would be approved, and
 * what they would pay. `memberEligibilityDetermined` and `clinicallyReviewed`
 * are the literal `false` on every policy and cannot be set true without a
 * schema change a reviewer would see.
 */

export type BenefitProgram =
  | "medicare-part-d"
  | "medicaid-fee-for-service"
  | "medicaid-managed-care"
  | "marketplace-qhp"
  | "commercial";

/**
 * Whether a policy document is established to govern the plan in question.
 *
 * A national PBM policy is not automatically an employer plan's policy, and a
 * state fee-for-service list is not a managed-care plan's list. When the
 * relationship has not been established the value is
 * `policy-applicability-unresolved` and the policy must not be rendered as
 * this plan's requirement.
 */
export type PolicyApplicability =
  | "verified-for-this-plan"
  | "verified-for-this-market-segment"
  | "policy-applicability-unresolved"
  | "not-applicable-to-this-plan";

/** How completely a document became structured fields. */
export type ExtractionStatus =
  | "verified-public-evidence"
  | "incomplete-extraction"
  | "unresolved-applicability"
  | "source-unavailable"
  | "fixture-only"
  | "requires-authorized-member-integration";

/** Where an assertion came from, precisely enough to re-check by hand. */
export interface Evidence {
  sourceId: string;
  sourceOwner: string;
  documentTitle: string;
  url: string;
  documentVersion: string | null;
  effectiveDate: string | null;
  retrievedAt: string;
  /** sha256 of the retrieved bytes. */
  contentHash: string;
  /** e.g. "page 73, Non-Preferred Agents column". */
  locator: string | null;
  /** The source's own words. Never a paraphrase. Render this. */
  quotation: string | null;
}

export type RequirementKind =
  | "clinical"
  | "administrative"
  | "prescriber-qualification"
  | "documentation"
  | "quantity"
  | "age"
  | "indication"
  | "duration"
  | "unclassified";

/**
 * Whether a requirement governs starting therapy or continuing it.
 *
 * Applying initiation criteria to a renewal demands a baseline the patient can
 * no longer produce, so the two are never merged.
 */
export type TherapyPhase = "initiation" | "continuation" | "both" | "phase-not-stated";

export interface PolicyRequirement {
  id: string;
  kind: RequirementKind;
  phase: TherapyPhase;
  /** The requirement as published. This is the authoritative field. */
  statedText: string;
  /**
   * How this combines with its siblings. `unparsed` means the logic was not
   * safely recoverable and only `statedText` may be relied on.
   *
   * Turning OR into AND invents conditions: "a trial of metformin OR a
   * contraindication to it" becomes a demand for both.
   */
  logic: "all-of" | "any-of" | "not" | "standalone" | "unparsed";
  children: string[];
  /** Exceptions the source attaches, verbatim. Dropping these misleads. */
  exceptions: string[];
  /** e.g. "3 per 28 days". Units and window stay together. */
  quantityAsStated: string | null;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  evidence: Evidence;
}

export type Actor =
  | "patient"
  | "prescriber"
  | "pharmacy"
  | "plan-or-insurer"
  | "state-agency"
  | "program-operator";

/**
 * How strongly the source backs a next step. Display this distinction.
 *
 * `pipeline-suggested-navigation` is OURS, not the plan's, and must be
 * labelled as such wherever it is shown.
 */
export type ActionBasis =
  | "source-directed"
  | "pipeline-suggested-navigation"
  | "source-specifies-no-next-step";

export interface OfficialContact {
  label: string;
  organization: string;
  phone: string | null;
  fax: string | null;
  url: string | null;
  notes: string | null;
  evidence: Evidence;
  /**
   * Automated reachability check on `url`.
   *
   * `ok: false` with status 403 means the host refused a bot, NOT that the
   * page is gone. Do not hide such a link; show it with the caveat.
   */
  linkCheck: {
    checkedAt: string;
    httpStatus: number | null;
    ok: boolean;
    note: string;
  } | null;
}

export interface AccessAction {
  id: string;
  actor: Actor;
  basis: ActionBasis;
  action: string;
  respondsToRequirementId: string | null;
  /**
   * What KIND of form this is.
   *
   * `generic-model-template` is a regulator's MODEL document that a plan may
   * accept. It is NOT the plan's own form. Many sponsors publish their own and
   * some require it, so rendering a template as "this plan's submission route"
   * overstates what is known. A working `formUrl` proves the template is
   * AVAILABLE; it says nothing about whether this plan ACCEPTS it.
   */
  formType: "generic-model-template" | "plan-specific-form" | "not-a-form";
  /** Whether this route is established for the SPECIFIC plan. */
  routeApplicability:
    | "verified-for-this-plan"
    | "market-segment-standard-plan-form-may-differ"
    | "applicability-unresolved";
  formTitle: string | null;
  formUrl: string | null;
  submissionUrl: string | null;
  submissionFax: string | null;
  submissionPhone: string | null;
  /** Document categories the policy mentions. Never invented. */
  documentsMentioned: string[];
  /**
   * Timeframes as published, with which side they bind. Never a prediction of
   * how long something will take in practice.
   */
  statedTimeframes: Array<{ label: string; value: string; appliesTo: string }>;
  expedited: { available: boolean; statedText: string } | null;
  contacts: OfficialContact[];
  evidence: Evidence;
}

/**
 * Where a product sits on a plan's published list.
 *
 * Read these exactly:
 *
 *   non-preferred                    is NOT excluded; it usually means an
 *                                    authorization is required
 *   not-addressed-in-this-document   is NOT "not covered"; the document may
 *                                    cover only selected drug classes
 *   listed-with-restrictions         is NOT an approval
 */
export type ListingStatus =
  | "preferred"
  | "non-preferred"
  | "listed-without-preference-tiering"
  | "listed-with-restrictions"
  | "not-addressed-in-this-document"
  | "explicitly-excluded"
  | "unresolved";

export interface AccessPolicy {
  schemaVersion: "access-1.0.0";
  policyId: string;
  productKey: string;
  benefitProgram: BenefitProgram;
  /** Null for statewide rules that are not plan-specific. */
  planKey: string | null;
  scopeLabel: string;
  geography: string;
  planYear: number | null;

  applicability: PolicyApplicability;
  applicabilityRationale: string;

  /**
   * Which published version this describes, and whether it is in force.
   *
   * ONLY `currently-effective` may be presented as today's coverage.
   * Publishers issue a formulary weeks before it takes effect and keep
   * superseded versions online, so the newest published file is usually NOT
   * the one in force.
   */
  sourceEffectivity: {
    documentVersion: string;
    effectiveDate: string | null;
    status: "currently-effective" | "upcoming" | "superseded" | "not-applicable";
    asOfDate: string;
    note: string;
  };

  /**
   * Differences in the NEXT published version affecting this product.
   *
   * Carried alongside, never merged into `listingStatus` or `requirements`.
   * Until `takesEffectOn`, the current fields ARE the coverage.
   */
  upcomingChanges: Array<{
    takesEffectOn: string;
    documentVersion: string;
    summary: string;
    previousValue: string;
    newValue: string;
    locator: string | null;
  }>;

  /**
   * Corroboration from a SEPARATE document by the same authority.
   *
   * Position and typography inside one PDF are two encodings of one decision
   * in one file; their agreement checks the parser, not the fact.
   */
  independentCorroboration: {
    result:
      | "corroborated-preferred"
      | "consistent-with-non-preferred"
      | "contradicted"
      | "not-checked"
      | "not-applicable-drug-absent-from-pdl";
    documentTitle: string;
    documentVersion: string;
    documentUrl: string;
    contentHash: string;
    effectiveDate: string;
    quotation: string | null;
    locator: string | null;
    note: string;
  } | null;

  /** How each extraction disagreement touching this product was resolved. */
  extractionDisputes: Array<{
    locator: string;
    disputed: string;
    resolution: string;
    basis: string;
  }>;

  /**
   * Scope this must not be applied beyond. RENDER THIS PROMINENTLY.
   *
   * A Medicaid fee-for-service finding says nothing about a managed care plan,
   * and most Medicaid members are in managed care.
   */
  scopeWarning: string;

  listingStatus: ListingStatus;
  /** Plain sentence matched to the status. Safe to render. */
  listingStatusNote: string;

  requirements: PolicyRequirement[];
  actions: AccessAction[];

  extractionStatus: ExtractionStatus;
  /** Why extraction is incomplete. Empty when it is not. */
  extractionLimitations: string[];

  evidence: Evidence[];

  /** Always false. No member-specific determination happens anywhere. */
  memberEligibilityDetermined: false;
  /** Always false. No clinician has reviewed any of this. */
  clinicallyReviewed: false;

  /** Genuinely unknown, and worth showing. */
  unknowns: string[];
}

/** `data/exports/access/access-policies.json` */
export interface AccessPoliciesExport {
  schemaVersion: "access-1.0.0";
  generatedAt: string;
  supportedScope: unknown;
  note: string;
  linkCheck: {
    checked: number;
    failing: number;
    results: Array<{
      url: string;
      checkedAt: string;
      httpStatus: number | null;
      ok: boolean;
      note: string;
    }>;
  };
  policies: AccessPolicy[];
}

/* ------------------------------------------------------- source changes */

export type ChangeCategory =
  | "formulary-listing"
  | "tier"
  | "prior-authorization"
  | "step-therapy"
  | "quantity-limit"
  | "policy-requirement"
  | "assistance-terms"
  | "label-warning"
  | "patient-instruction"
  | "preference-status";

/**
 * What kind of difference this is.
 *
 * Only `source-content` describes the publisher changing something. The other
 * three exist so a reflowed PDF or a parser upgrade cannot become a medical
 * alert.
 */
export type ChangeNature =
  | "source-content"
  | "formatting-only"
  | "parser-induced"
  | "ambiguous-needs-review";

export interface SourceChange {
  id: string;
  category: ChangeCategory;
  nature: ChangeNature;
  subjectLabel: string;
  productKey: string | null;
  /**
   * Whether this difference is ALREADY IN FORCE or still to come.
   *
   * A diff between the newest two published documents is usually a diff
   * between today's rules and next quarter's. `upcoming` means it has NOT
   * happened; do not present it as a change that has occurred.
   */
  effectiveStatus: "in-effect" | "upcoming";
  /** The date the newer side takes (or took) effect. */
  takesEffectOn: string | null;
  previous: {
    documentVersion: string;
    effectiveDate: string | null;
    contentHash: string;
    statedText: string | null;
    locator: string | null;
  };
  current: {
    documentVersion: string;
    effectiveDate: string | null;
    contentHash: string;
    statedText: string | null;
    locator: string | null;
  };
  /** Differing versions across the two sides void the attribution. */
  parserVersion: string;
  verification: "verified-against-both-documents" | "unverified" | "needs-human-review";
  /**
   * Always false. A change record is an item for review, not a notification.
   * Deciding to tell a patient something changed is a clinical and product
   * decision this pipeline does not make.
   */
  isPatientNotification: false;
  note: string;
}

/** `data/exports/access/source-changes.json` */
export interface SourceChangesExport {
  schemaVersion: "access-1.0.0";
  generatedAt: string;
  comparison: {
    source: string;
    previous: { version: string; effectiveDate: string; url: string; contentHash: string };
    current: { version: string; effectiveDate: string; url: string; contentHash: string };
    parserVersion: string;
  };
  note: string;
  /**
   * Entry segmentation within a PDL column is not fully recoverable, so ADDED
   * and REMOVED records are review items. Records present in both versions
   * whose column differs are the higher-confidence class.
   */
  entrySegmentation: {
    complete: false;
    fragmentsFilteredFromNewerVersion: number;
    note: string;
  };
  summary: Record<ChangeNature, number>;
  changes: SourceChange[];
}

/* ------------------------------------------------------- card matching */

/**
 * What a set of insurance-card fields establishes.
 *
 * Gate every coverage lookup on `mayLookUpCoverage`. Only
 * `exact-plan-identified` licenses showing a plan's formulary evidence.
 *
 * RxBIN routes a claim to a processor and RxPCN selects a configuration within
 * it. Neither is a formulary identifier and neither is unique to a plan: one
 * BIN/PCN pair routinely serves hundreds of employer groups with different
 * drug lists. No public crosswalk maps them to a formulary, and this pipeline
 * does not invent one.
 *
 * `memberId` and `groupNumber` are accepted, immediately discarded, and never
 * stored, logged, exported or matched on. They identify a person, not a plan.
 */
export type CardResolutionLevel =
  | "nothing-identified"
  | "insurer-identified"
  | "routing-identified"
  | "plan-family-identified"
  | "exact-plan-identified";

export interface InsuranceCardFields {
  insurerName?: string | null;
  planName?: string | null;
  /** PERSONAL. Discarded; never used as match evidence. */
  memberId?: string | null;
  /** PERSONAL. Discarded; never used as match evidence. */
  groupNumber?: string | null;
  rxBin?: string | null;
  rxPcn?: string | null;
  rxGroup?: string | null;
  contractId?: string | null;
  planId?: string | null;
  segmentId?: string | null;
  planYear?: number | null;
  stateCode?: string | null;
}

export interface CardMatchResult {
  level: CardResolutionLevel;
  /**
   * True only at exact-plan-identified.
   *
   * NECESSARY BUT NOT SUFFICIENT. It settles WHICH PLAN someone holds; it says
   * nothing about whether usable evidence exists for that plan. Call
   * `mayDisplayFormularyEvidence` before displaying anything.
   */
  mayLookUpCoverage: boolean;
  candidates: Array<{ planKey: string; planName: string | null; formularyId: string | null }>;
  missingFields: string[];
  evidence: Array<{
    field: string;
    /** The value's role. Null when the field is personal. */
    valueShown: string | null;
    establishes: string;
    doesNotEstablish: string;
  }>;
  explanation: string;
  ignoredPersonalFields: string[];
  requiresUserSelection: boolean;
}

/**
 * The five conditions that must ALL hold before plan-specific formulary
 * evidence may be displayed.
 *
 * Resolving the plan is one of them, not the decision. The others fail
 * independently: the plan record may carry no formulary id, the evidence may
 * belong to a different formulary, the match may be at ingredient or class
 * level rather than this product, the evidence may be for another plan year,
 * or the source version may not be in force yet.
 */
export interface FormularyDisplayContext {
  planResolvedExactly: boolean;
  formularyIdOnPlanRecord: string | null;
  formularyIdOnEvidence: string | null;
  medicationMatchGranularity: MatchGranularity | null;
  requestedPlanYear: number;
  evidencePlanYear: number | null;
  sourceEffectivity: "currently-effective" | "upcoming" | "superseded" | "not-applicable";
  coverageState: string;
}

export interface FormularyDisplayDecision {
  mayDisplay: boolean;
  /** Conditions that failed. Each one alone prevents display. */
  blockedBy: string[];
  /** Conditions that passed but constrain HOW it may be shown. */
  cautions: string[];
  /**
   * Always false, whatever else holds. Nothing in this pipeline verifies a
   * person's actual benefits, and resolving their plan does not begin to.
   */
  personalBenefitsVerified: false;
  explanation: string;
}

/** Granularity of a formulary match; re-declared here for convenience. */
export type MatchGranularity =
  | "exact-product"
  | "clinical-drug"
  | "ingredient"
  | "drug-class"
  | "ambiguous-text";
