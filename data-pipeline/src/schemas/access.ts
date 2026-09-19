import { z } from "zod";

/**
 * Medication access: what a plan publishes, what it requires, and what the
 * published policy says to do next.
 *
 * The entities here are deliberately separate, because collapsing any two of
 * them produces a claim the sources do not support:
 *
 *   AccessPolicy      what a named plan publishes about a named product
 *   PolicyRequirement one published condition, with its logic intact
 *   AccessAction      a next step, attributed to whoever published it
 *   OfficialContact   a route to a real office, verified to resolve
 *   AssistanceProgram a program's own published terms
 *   SourceChange      a difference between two retrieved versions
 *
 * Nothing here decides whether a person meets a requirement. Requirements are
 * exported for a clinician to read.
 */

export const ACCESS_SCHEMA_VERSION = "access-1.0.0";

/* ------------------------------------------------------------ provenance */

/**
 * Where an assertion came from, precisely enough to re-check by hand.
 *
 * `locator` is the difference between a citation and a gesture: for a PDF it
 * carries the page, and for a delimited file the line.
 */
export const EvidenceSchema = z.object({
  sourceId: z.string(),
  sourceOwner: z.string(),
  documentTitle: z.string(),
  url: z.string(),
  /** The publisher's own version or effective-date label. */
  documentVersion: z.string().nullable(),
  effectiveDate: z.string().nullable(),
  retrievedAt: z.string(),
  /** sha256 of the retrieved bytes. */
  contentHash: z.string(),
  /** e.g. "page 73", "row 1482", "page 73, Non-Preferred Agents column". */
  locator: z.string().nullable(),
  /** The source's own words. Never a paraphrase. */
  quotation: z.string().nullable(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * How confident we are that a policy document governs a given plan.
 *
 * A national PBM policy is not automatically an employer plan's policy, and a
 * state Medicaid fee-for-service list is not a managed-care plan's list.
 */
export const PolicyApplicabilitySchema = z.enum([
  /** The document names this exact plan, or is the plan's own filing. */
  "verified-for-this-plan",
  /** The document governs the whole market segment and says so. */
  "verified-for-this-market-segment",
  /**
   * The document is real and relevant but its relationship to THIS plan is
   * not established. Never rendered as this plan's requirement.
   */
  "policy-applicability-unresolved",
  /** The document explicitly excludes this plan or benefit type. */
  "not-applicable-to-this-plan",
]);
export type PolicyApplicability = z.infer<typeof PolicyApplicabilitySchema>;

/** How completely a document was turned into structured fields. */
export const ExtractionStatusSchema = z.enum([
  "verified-public-evidence",
  "incomplete-extraction",
  "unresolved-applicability",
  "source-unavailable",
  "fixture-only",
  "requires-authorized-member-integration",
]);
export type ExtractionStatus = z.infer<typeof ExtractionStatusSchema>;

/* ------------------------------------------------------- requirements */

/**
 * The kind of condition a requirement expresses.
 *
 * `clinical` conditions describe the patient's situation; `administrative`
 * ones describe paperwork. Mixing them lets a form-filling step masquerade as
 * a medical judgement.
 */
export const RequirementKindSchema = z.enum([
  "clinical",
  "administrative",
  "prescriber-qualification",
  "documentation",
  "quantity",
  "age",
  "indication",
  "duration",
  "unclassified",
]);

/**
 * Whether a requirement governs starting therapy or continuing it.
 *
 * Applying initiation criteria to a renewal is a documented failure mode: it
 * demands a baseline the patient can no longer produce.
 */
export const TherapyPhaseSchema = z.enum([
  "initiation",
  "continuation",
  "both",
  "phase-not-stated",
]);

export const PolicyRequirementSchema = z.object({
  /** Stable within a policy, for referencing from an action. */
  id: z.string(),
  kind: RequirementKindSchema,
  phase: TherapyPhaseSchema,
  /**
   * The requirement as published, verbatim.
   *
   * This is the authoritative field. Everything else on this object is an
   * index into it.
   */
  statedText: z.string(),
  /**
   * How this requirement combines with its siblings.
   *
   * Preserved because converting OR into AND invents conditions: "a trial of
   * metformin OR a contraindication to it" becomes a demand for both.
   * `unparsed` means the logic was not safely recoverable and only
   * `statedText` may be relied on.
   */
  logic: z.enum(["all-of", "any-of", "not", "standalone", "unparsed"]),
  /** Nested conditions, when the source expresses them. */
  children: z.array(z.string()).default([]),
  /** Exceptions the source attaches to this requirement, verbatim. */
  exceptions: z.array(z.string()).default([]),
  /** e.g. "3 per 28 days". Units and window kept together. */
  quantityAsStated: z.string().nullable().default(null),
  effectiveStart: z.string().nullable().default(null),
  effectiveEnd: z.string().nullable().default(null),
  evidence: EvidenceSchema,
});
export type PolicyRequirement = z.infer<typeof PolicyRequirementSchema>;

/* ------------------------------------------------------------ actions */

/** Who performs a next step. */
export const ActorSchema = z.enum([
  "patient",
  "prescriber",
  "pharmacy",
  "plan-or-insurer",
  "state-agency",
  "program-operator",
]);

/**
 * How strongly the source backs a next step.
 *
 * The distinction is the point of this entity. A step the source spells out is
 * different from a reasonable suggestion, and both differ from an admission
 * that the source is silent.
 */
export const ActionBasisSchema = z.enum([
  /** The retrieved document explicitly directs this action. */
  "source-directed",
  /**
   * General navigation we are suggesting, not something the source says.
   * Must be labelled as ours wherever it is displayed.
   */
  "pipeline-suggested-navigation",
  /** The source describes the restriction but no next step for it. */
  "source-specifies-no-next-step",
]);

export const OfficialContactSchema = z.object({
  label: z.string(),
  organization: z.string(),
  phone: z.string().nullable().default(null),
  fax: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  /** Hours or routing notes, as published. */
  notes: z.string().nullable().default(null),
  evidence: EvidenceSchema,
  /** Result of the most recent automated reachability check on `url`. */
  linkCheck: z
    .object({
      checkedAt: z.string(),
      httpStatus: z.number().nullable(),
      ok: z.boolean(),
      note: z.string(),
    })
    .nullable()
    .default(null),
});
export type OfficialContact = z.infer<typeof OfficialContactSchema>;

export const AccessActionSchema = z.object({
  id: z.string(),
  actor: ActorSchema,
  basis: ActionBasisSchema,
  /** What to do, in the source's terms. */
  action: z.string(),
  /** The requirement this responds to, when it responds to one. */
  respondsToRequirementId: z.string().nullable().default(null),
  /**
   * What KIND of form this is.
   *
   * `generic-model-template` is a regulator's model document that a plan MAY
   * accept. It is not the plan's own form, and describing it as "this plan's
   * submission route" overstates it: many plans publish their own form and
   * some require it. A working URL proves the template is available, not that
   * this plan accepts it.
   *
   * `plan-specific-form` is the named plan's own published form, established
   * as such from the plan's own materials.
   */
  formType: z
    .enum(["generic-model-template", "plan-specific-form", "not-a-form"])
    .default("not-a-form"),
  /** Official form, when the source names one. */
  formTitle: z.string().nullable().default(null),
  formUrl: z.string().nullable().default(null),
  /**
   * Whether this route is established for the SPECIFIC plan in question.
   *
   * A federally standardised process applies to the market segment; it does
   * not establish which form a given sponsor accepts or where it wants it sent.
   */
  routeApplicability: z
    .enum([
      "verified-for-this-plan",
      "market-segment-standard-plan-form-may-differ",
      "applicability-unresolved",
    ])
    .default("applicability-unresolved"),
  /** Official portal or submission route. */
  submissionUrl: z.string().nullable().default(null),
  submissionFax: z.string().nullable().default(null),
  submissionPhone: z.string().nullable().default(null),
  /** Document categories the policy says may be required. Never invented. */
  documentsMentioned: z.array(z.string()).default([]),
  /**
   * Timeframes exactly as published, with which side they bind.
   * Never a prediction of how long something will take in practice.
   */
  statedTimeframes: z
    .array(z.object({ label: z.string(), value: z.string(), appliesTo: z.string() }))
    .default([]),
  /** Whether the source describes an expedited route, and on what terms. */
  expedited: z
    .object({ available: z.boolean(), statedText: z.string() })
    .nullable()
    .default(null),
  contacts: z.array(OfficialContactSchema).default([]),
  evidence: EvidenceSchema,
});
export type AccessAction = z.infer<typeof AccessActionSchema>;

/* ------------------------------------------------------------- policy */

/** Which benefit a policy governs. Not interchangeable. */
export const BenefitProgramSchema = z.enum([
  "medicare-part-d",
  "medicaid-fee-for-service",
  "medicaid-managed-care",
  "marketplace-qhp",
  "commercial",
]);

/**
 * What a named plan publishes about a named product.
 *
 * `listingStatus` says where the product sits on the published list. It never
 * says whether a claim would be paid.
 */
export const AccessPolicySchema = z.object({
  schemaVersion: z.literal(ACCESS_SCHEMA_VERSION),
  policyId: z.string(),
  productKey: z.string(),
  benefitProgram: BenefitProgramSchema,
  /** Plan key when the policy is plan-specific; null for statewide rules. */
  planKey: z.string().nullable(),
  /** Human label for what this policy governs. */
  scopeLabel: z.string(),
  geography: z.string(),
  planYear: z.number().nullable(),

  applicability: PolicyApplicabilitySchema,
  applicabilityRationale: z.string(),

  /**
   * Which published version this policy describes, and whether it is in force.
   *
   * `currently-effective` is the only value a consumer may present as today's
   * coverage.
   */
  sourceEffectivity: z.object({
    documentVersion: z.string(),
    effectiveDate: z.string().nullable(),
    status: z.enum(["currently-effective", "upcoming", "superseded", "not-applicable"]),
    asOfDate: z.string(),
    note: z.string(),
  }),

  /**
   * Differences in the NEXT published version that affect this product.
   *
   * Carried alongside, never merged into `listingStatus` or `requirements`.
   * Until `takesEffectOn`, the current fields are the coverage.
   */
  upcomingChanges: z
    .array(
      z.object({
        takesEffectOn: z.string(),
        documentVersion: z.string(),
        summary: z.string(),
        previousValue: z.string(),
        newValue: z.string(),
        locator: z.string().nullable(),
      })
    )
    .default([]),

  /**
   * Corroboration from a SEPARATE document by the same authority.
   *
   * Position and typography inside one PDF are two encodings of one decision
   * in one file; their agreement checks the parser, not the fact. Real
   * corroboration requires a different document.
   */
  independentCorroboration: z
    .object({
      result: z.enum([
        "corroborated-preferred",
        "consistent-with-non-preferred",
        "contradicted",
        "not-checked",
        "not-applicable-drug-absent-from-pdl",
      ]),
      documentTitle: z.string(),
      documentVersion: z.string(),
      documentUrl: z.string(),
      contentHash: z.string(),
      effectiveDate: z.string(),
      quotation: z.string().nullable(),
      locator: z.string().nullable(),
      note: z.string(),
    })
    .nullable()
    .default(null),

  /**
   * How each extraction disagreement touching this product was resolved.
   *
   * Recorded so a reviewer can see that a dispute was decided, and on what
   * basis, rather than silently going one way.
   */
  extractionDisputes: z
    .array(
      z.object({
        locator: z.string(),
        disputed: z.string(),
        resolution: z.string(),
        basis: z.string(),
      })
    )
    .default([]),

  /**
   * Scope this policy must not be applied beyond.
   *
   * Rendered prominently, because a Medicaid fee-for-service finding says
   * nothing about a managed care plan and the two are easy to conflate.
   */
  scopeWarning: z.string(),

  listingStatus: z.enum([
    "preferred",
    "non-preferred",
    "listed-without-preference-tiering",
    "listed-with-restrictions",
    "not-addressed-in-this-document",
    "explicitly-excluded",
    "unresolved",
  ]),
  listingStatusNote: z.string(),

  requirements: z.array(PolicyRequirementSchema),
  actions: z.array(AccessActionSchema),

  extractionStatus: ExtractionStatusSchema,
  /** Why extraction is incomplete, when it is. Empty when it is not. */
  extractionLimitations: z.array(z.string()).default([]),

  evidence: z.array(EvidenceSchema),

  /** Always false. No member-specific determination is performed anywhere. */
  memberEligibilityDetermined: z.literal(false),
  /** Always false. No clinician has reviewed any of this. */
  clinicallyReviewed: z.literal(false),

  unknowns: z.array(z.string()).default([]),
});
export type AccessPolicy = z.infer<typeof AccessPolicySchema>;

/* ------------------------------------------------------- source change */

export const ChangeCategorySchema = z.enum([
  "formulary-listing",
  "tier",
  "prior-authorization",
  "step-therapy",
  "quantity-limit",
  "policy-requirement",
  "assistance-terms",
  "label-warning",
  "patient-instruction",
  "preference-status",
]);

/**
 * What kind of difference this is.
 *
 * Separating these is what keeps a reformatted PDF from generating a medical
 * alert. Only `source-content` differences describe the publisher changing
 * something.
 */
export const ChangeNatureSchema = z.enum([
  "source-content",
  "formatting-only",
  "parser-induced",
  "ambiguous-needs-review",
]);

export const SourceChangeSchema = z.object({
  id: z.string(),
  category: ChangeCategorySchema,
  nature: ChangeNatureSchema,
  subjectLabel: z.string(),
  productKey: z.string().nullable().default(null),
  previous: z.object({
    documentVersion: z.string(),
    effectiveDate: z.string().nullable(),
    contentHash: z.string(),
    statedText: z.string().nullable(),
    locator: z.string().nullable(),
  }),
  current: z.object({
    documentVersion: z.string(),
    effectiveDate: z.string().nullable(),
    contentHash: z.string(),
    statedText: z.string().nullable(),
    locator: z.string().nullable(),
  }),
  /**
   * Whether this difference is ALREADY IN FORCE or still to come.
   *
   * Publishers issue a formulary weeks before it takes effect, so a diff
   * between the newest two published documents is usually a diff between
   * today's rules and next quarter's. Presenting that as a change that has
   * happened states future coverage as current.
   */
  effectiveStatus: z.enum(["in-effect", "upcoming"]),
  /** The date the newer side takes (or took) effect. */
  takesEffectOn: z.string().nullable(),
  /** Parser build that produced both sides. Differing versions void a diff. */
  parserVersion: z.string(),
  verification: z.enum(["verified-against-both-documents", "unverified", "needs-human-review"]),
  /**
   * Always false. A change record is an item for review, not a notification.
   * Deciding to tell a patient something changed is a clinical and product
   * decision this pipeline does not make.
   */
  isPatientNotification: z.literal(false),
  note: z.string(),
});
export type SourceChange = z.infer<typeof SourceChangeSchema>;

/* ---------------------------------------------------------- assistance */

export const AssistanceProgramTypeSchema = z.enum([
  /** Reduces what the patient pays. */
  "manufacturer-savings-card",
  /** Free or reduced-cost product for qualifying patients. */
  "manufacturer-patient-assistance",
  /** Government subsidy. */
  "government-subsidy",
  /** State-run assistance. */
  "state-assistance",
  /** Independent charity. */
  "independent-charity",
  /**
   * Spreads the SAME total cost across the year. It is not a discount and
   * must never be described as savings.
   */
  "payment-smoothing",
]);

export const AssistanceProgramSchema = z.object({
  id: z.string(),
  name: z.string(),
  operator: z.string(),
  type: AssistanceProgramTypeSchema,
  /** Products the program's own page names. */
  appliesToProducts: z.array(z.string()),
  /** Eligibility exactly as published. Never summarised into a promise. */
  statedEligibility: z.array(z.string()).default([]),
  /** Exclusions as published. Omitting these is how people are misled. */
  statedExclusions: z.array(z.string()).default([]),
  /** Whether government-insured patients are excluded, when stated. */
  governmentInsuranceEligibility: z
    .enum(["eligible", "excluded", "not-stated"])
    .default("not-stated"),
  commercialInsuranceEligibility: z
    .enum(["eligible", "excluded", "required", "not-stated"])
    .default("not-stated"),
  uninsuredEligibility: z.enum(["eligible", "excluded", "not-stated"]).default("not-stated"),
  incomeRequirement: z
    .object({
      statedText: z.string(),
      basis: z.string().nullable(),
      householdSizeDependent: z.boolean(),
      year: z.string().nullable(),
    })
    .nullable()
    .default(null),
  residencyRequirement: z.string().nullable().default(null),
  ageRequirement: z.string().nullable().default(null),
  maximumBenefitAsStated: z.string().nullable().default(null),
  durationAsStated: z.string().nullable().default(null),
  expirationAsStated: z.string().nullable().default(null),
  renewalTermsAsStated: z.string().nullable().default(null),
  requiredDocumentCategories: z.array(z.string()).default([]),
  applicationUrl: z.string().nullable().default(null),
  contacts: z.array(OfficialContactSchema).default([]),
  /**
   * What this pipeline will say about a person and this program.
   *
   * Never "you qualify". Only the operator can determine eligibility.
   */
  determination: z.literal("program-to-investigate"),
  /** Set when the program's own page publishes a disqualifying rule. */
  publishedExclusionApplies: z.boolean().default(false),
  evidence: z.array(EvidenceSchema),
  extractionStatus: ExtractionStatusSchema,
});
export type AssistanceProgram = z.infer<typeof AssistanceProgramSchema>;
