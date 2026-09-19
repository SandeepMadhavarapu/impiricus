import type {
  CoverageLookupResult,
  FormularyEvidence,
  MatchGranularity,
  PlanIdentity,
  PlanResolution,
  AccessPolicy,
} from "../schemas/insurance.js";
import { INSURANCE_SCHEMA_VERSION } from "../schemas/insurance.js";
import type { Provenance } from "../schemas/index.js";
import type { PartDSnapshot, SnapshotPlan } from "./snapshot.js";
import type { CoverageState } from "../schemas/insurance.js";

/**
 * Coverage lookup.
 *
 * Takes an EXACT plan selection and an exact medication identity, and reports
 * what was checked, what was found, what is restricted, and what is unknown.
 *
 * Rules enforced here, each of which corresponds to a way coverage tools lie:
 *
 *   "not found" is not "not covered"          -> not-found-in-checked-source
 *   "non-preferred" is not "excluded"         -> preferredStatus, never a state
 *   "PA required" is not "approved"           -> conditional
 *   "listed" is not a payment guarantee       -> memberBenefitVerified: false
 *   a generic listing is not a brand listing  -> MatchGranularity
 *   a tier is not a dollar amount             -> CostBasis on every number
 */

export interface LookupRequest {
  productKey: string;
  /** Product-level RXCUI for this exact product. */
  exactRxcui: string | null;
  /** Broader concepts, used only to report non-exact matches. */
  relatedRxcuis: Array<{ rxcui: string; granularity: MatchGranularity; name: string | null }>;
  planYear: number;
  /** Medicare selectors. */
  contractId?: string;
  planId?: string;
  segmentId?: string;
  /** Free-text fallback, used ONLY to produce candidates, never to resolve. */
  planNameQuery?: string;
}

const UNKNOWN_POLICY: AccessPolicy = {
  priorAuthorization: "unknown",
  stepTherapy: "unknown",
  quantityLimit: { present: "unknown", amount: null, days: null, asStated: null },
  tier: null,
  tierLabel: null,
  preferredStatus: "unknown",
  specialtyPharmacyRequired: "unknown",
  ageRestriction: null,
  indicationCriteria: null,
  benefitScope: "pharmacy",
  effectiveStart: null,
  effectiveEnd: null,
  exceptionProcessUrl: null,
  notes: [],
};

/* ------------------------------------------------------- plan resolution */

export function resolvePlan(snapshot: PartDSnapshot, req: LookupRequest): PlanResolution {
  const year = req.planYear;

  if (req.contractId && req.planId) {
    const matches = snapshot.plans.filter(
      (p) =>
        p.contractId === req.contractId &&
        p.planId === req.planId &&
        (req.segmentId === undefined || p.segmentId === req.segmentId)
    );

    if (matches.length === 1) {
      return {
        state: "resolved",
        plan: toPlanIdentity(matches[0]!, year),
        candidates: [],
        missingDisambiguators: [],
        rationale: `Resolved by contract ${req.contractId}, plan ${req.planId}${
          req.segmentId ? `, segment ${req.segmentId}` : ""
        }.`,
      };
    }
    if (matches.length > 1) {
      return {
        state: "ambiguous",
        plan: null,
        candidates: matches.slice(0, 10).map((p) => ({
          planKey: planKey(p, year),
          planName: p.planName,
          formularyId: p.formularyId,
        })),
        missingDisambiguators: ["segmentId"],
        rationale: `${matches.length} plans share contract ${req.contractId} and plan ${req.planId}. A segment id is needed.`,
      };
    }
    return {
      state: "not-found",
      plan: null,
      candidates: [],
      missingDisambiguators: [],
      rationale: `No plan with contract ${req.contractId} and plan ${req.planId} in the ${snapshot.release} release.`,
    };
  }

  // Name search produces CANDIDATES ONLY. An insurer name never resolves a plan.
  if (req.planNameQuery) {
    const q = req.planNameQuery.toLowerCase();
    const matches = snapshot.plans.filter(
      (p) =>
        (p.planName ?? "").toLowerCase().includes(q) ||
        (p.organizationName ?? "").toLowerCase().includes(q)
    );
    return {
      state: matches.length === 0 ? "not-found" : "ambiguous",
      plan: null,
      candidates: matches.slice(0, 10).map((p) => ({
        planKey: planKey(p, year),
        planName: p.planName,
        formularyId: p.formularyId,
      })),
      missingDisambiguators: ["contractId", "planId", "segmentId"],
      rationale:
        matches.length === 0
          ? `No plan name or organisation matched "${req.planNameQuery}".`
          : `${matches.length} plans matched "${req.planNameQuery}". A plan name is not an identifier; ` +
            `supply contract id, plan id and segment id to resolve exactly.`,
    };
  }

  return {
    state: "not-found",
    plan: null,
    candidates: [],
    missingDisambiguators: ["contractId", "planId", "segmentId"],
    rationale: "No plan selector was supplied.",
  };
}

export function planKey(p: SnapshotPlan, year: number): string {
  return `medicare-partd-${year}-${p.contractId}-${p.planId}-${p.segmentId ?? "000"}`;
}

function toPlanIdentity(p: SnapshotPlan, year: number): PlanIdentity {
  return {
    planKey: planKey(p, year),
    market: "medicare-part-d",
    planYear: year,
    contractId: p.contractId,
    planId: p.planId,
    segmentId: p.segmentId,
    formularyId: p.formularyId,
    hiosIssuerId: null,
    hiosPlanId: null,
    planVariant: null,
    stateCode: null,
    medicaidProgram: null,
    managedCarePlanId: null,
    organizationName: p.organizationName,
    planName: p.planName,
    serviceArea: null,
  };
}

/* ------------------------------------------------------------- the lookup */

export function lookupCoverage(
  snapshot: PartDSnapshot,
  req: LookupRequest,
  provenance: Provenance[]
): CoverageLookupResult {
  const planResolution = resolvePlan(snapshot, req);
  const plan = planResolution.plan;

  const rxcuisSearched = [
    ...(req.exactRxcui
      ? [{ rxcui: req.exactRxcui, granularity: "exact-product" as MatchGranularity, name: null }]
      : []),
    ...req.relatedRxcuis,
  ];

  const yearMismatch =
    snapshot.contractYear !== null && Number(snapshot.contractYear) !== req.planYear;

  const freshness = {
    sourceRelease: snapshot.release,
    sourcePublished: snapshot.modified,
    retrievedAt: snapshot.retrievedAt,
    planYear: req.planYear,
    yearMismatch,
  };

  const baseCaveats = [
    "This is the plan's PUBLISHED formulary, not a member's benefit. Enrolment, eligibility and " +
      "deductible status were not checked.",
    "Listing is not a guarantee of payment. Only an adjudicated pharmacy claim is binding.",
    "Tier numbers are plan-defined. A tier is not a dollar amount.",
  ];

  const memberBenefitNote =
    "No member-specific benefit verification was performed. This pipeline has no authorised " +
    "eligibility or real-time benefit integration, and no patient information was supplied or required.";

  const nextSteps = [
    {
      label: "Ask the pharmacy to run a test claim",
      detail: "A trial claim returns the actual amount for this member, which no formulary document can.",
      url: null,
    },
    {
      label: "Medicare Plan Finder",
      detail: "Official CMS tool for checking drug coverage and costs by plan.",
      url: "https://www.medicare.gov/plan-compare/",
    },
    {
      label: "Call the plan's member services",
      detail: "The number on the member's card. Ask about this exact strength, form and quantity.",
      url: null,
    },
  ];

  // Plan not resolved: report that, and check nothing.
  if (!plan) {
    return {
      schemaVersion: INSURANCE_SCHEMA_VERSION,
      state: planResolution.state === "source-unavailable" ? "source-unavailable" : "ambiguous-plan",
      headline:
        planResolution.state === "not-found"
          ? "That plan was not found in the checked CMS release."
          : "The plan could not be identified exactly, so nothing was checked.",
      checked: {
        plan: null,
        planResolution,
        medicationProductKey: req.productKey,
        medicationRxcui: req.exactRxcui,
        rxcuisSearched,
        sourceIds: ["cms-part-d-monthly-formulary"],
        planYear: req.planYear,
      },
      found: [],
      restrictions: [],
      unknown: [
        "Formulary status was not checked because the plan is not identified.",
        ...planResolution.missingDisambiguators.map((d) => `Missing disambiguator: ${d}`),
      ],
      freshness,
      memberBenefitVerified: false,
      memberBenefitNote,
      nextSteps,
      caveats: baseCaveats,
    };
  }

  // Explicit exclusion beats absence.
  const excluded = snapshot.excluded.filter(
    (e) =>
      e.formularyId === plan.formularyId &&
      rxcuisSearched.some((r) => r.rxcui === e.rxcui)
  );

  const rows = snapshot.formulary.filter((f) => f.formularyId === plan.formularyId);
  const matched = rows.filter((f) => rxcuisSearched.some((r) => r.rxcui === f.rxcui));

  const found: FormularyEvidence[] = matched.map((row) => {
    const searched = rxcuisSearched.find((r) => r.rxcui === row.rxcui);
    const granularity = searched?.granularity ?? "ambiguous-text";
    const isExact = granularity === "exact-product" && row.rxcui === req.exactRxcui;

    const costRules = snapshot.costs
      .filter(
        (c) =>
          c.contractId === plan.contractId &&
          c.planId === plan.planId &&
          (c.tier === null || c.tier === row.tierLevelValue)
      )
      .slice(0, 6)
      .map((c) => ({
        basis: "published-plan-cost-sharing-rule" as const,
        coverageLevel: c.coverageLevel,
        daysSupply: c.daysSupply,
        costType: c.costTypePref,
        amount: c.costAmtPref,
        pharmacyTier: "preferred" as const,
        caveat:
          "This is the plan's published cost-sharing RULE for this tier. It is not a price for any " +
          "individual: deductible status, pharmacy contract and coverage phase all change the amount.",
      }));

    const policy: AccessPolicy = {
      ...UNKNOWN_POLICY,
      priorAuthorization: row.priorAuthorizationYn ? "yes" : "no",
      stepTherapy: row.stepTherapyYn ? "yes" : "no",
      quantityLimit: {
        present: row.quantityLimitYn ? "yes" : "no",
        amount: row.quantityLimitAmount,
        days: row.quantityLimitDays,
        asStated:
          row.quantityLimitYn && row.quantityLimitAmount && row.quantityLimitDays
            ? `${row.quantityLimitAmount} per ${row.quantityLimitDays} days`
            : null,
      },
      tier: row.tierLevelValue,
      tierLabel: null,
      // CMS publishes a tier number, not a preferred/non-preferred label.
      preferredStatus: "unknown",
      benefitScope: "pharmacy",
      notes: [
        "Tier meaning is defined by the plan, not by CMS. Check the plan's Evidence of Coverage.",
        "Quantity-limit units come from the source: an amount per a number of DAYS, not per month.",
      ],
      exceptionProcessUrl: "https://www.medicare.gov/claims-appeals/how-do-i-file-an-appeal",
    };

    return {
      matchedRxcui: row.rxcui,
      matchedConceptName: searched?.name ?? null,
      granularity,
      isExactProductMatch: isExact,
      formularyId: row.formularyId,
      formularyVersion: row.formularyVersion,
      policy,
      costSharing: costRules,
      provenance,
      supportingRow: {
        FORMULARY_ID: row.formularyId,
        RXCUI: row.rxcui,
        TIER_LEVEL_VALUE: row.tierLevelValue !== null ? String(row.tierLevelValue) : null,
        PRIOR_AUTHORIZATION_YN: row.priorAuthorizationYn ? "Y" : "N",
        STEP_THERAPY_YN: row.stepTherapyYn ? "Y" : "N",
        QUANTITY_LIMIT_YN: row.quantityLimitYn ? "Y" : "N",
        QUANTITY_LIMIT_AMOUNT: row.quantityLimitAmount,
        QUANTITY_LIMIT_DAYS: row.quantityLimitDays,
        CONTRACT_YEAR: row.contractYear,
      },
    };
  });

  const restrictions: string[] = [];
  for (const e of found) {
    if (e.policy.priorAuthorization === "yes") {
      restrictions.push(
        `Prior authorisation required (tier ${e.policy.tier ?? "?"}). This means the prescriber must ` +
          "submit information BEFORE the plan will pay. It is not an approval."
      );
    }
    if (e.policy.stepTherapy === "yes") {
      restrictions.push("Step therapy required: another medicine must usually be tried first.");
    }
    if (e.policy.quantityLimit.present === "yes" && e.policy.quantityLimit.asStated) {
      restrictions.push(`Quantity limit: ${e.policy.quantityLimit.asStated}.`);
    }
  }

  let state: CoverageLookupResult["state"];
  let headline: string;

  if (excluded.length > 0) {
    state = "explicitly-excluded";
    headline = `This plan's published formulary explicitly excludes this drug.`;
  } else if (found.length === 0) {
    state = "not-found-in-checked-source";
    headline =
      "Not found on this plan's published formulary. That is not the same as 'not covered': an " +
      "exception process may apply, and a different strength or form may be listed.";
  } else if (restrictions.length > 0) {
    state = "conditional";
    headline = `Listed on this plan's formulary, with ${restrictions.length} restriction(s).`;
  } else {
    state = "listed";
    headline = "Listed on this plan's published formulary with no restrictions recorded.";
  }

  if (yearMismatch && state !== "not-found-in-checked-source") {
    state = "stale-source";
    headline =
      `Evidence is from contract year ${snapshot.contractYear}, but plan year ${req.planYear} was requested. ` +
      "Formularies change between years, so this is reported as stale rather than applied.";
  }

  const exactMatches = found.filter((f) => f.isExactProductMatch);
  const unknown: string[] = [];
  if (found.length > 0 && exactMatches.length === 0) {
    unknown.push(
      "No EXACT product match. The listing(s) found are for a broader concept (clinical drug or " +
        "ingredient). A generic listing does not establish that the branded product is listed."
    );
  }
  unknown.push("Member eligibility, enrolment and deductible status: not checked.");
  unknown.push("The actual amount this person would pay: not determined.");
  if (found.some((f) => f.policy.tier !== null)) {
    unknown.push("The plan-defined meaning of the tier number: not in this dataset.");
  }

  return {
    schemaVersion: INSURANCE_SCHEMA_VERSION,
    state,
    headline,
    checked: {
      plan,
      planResolution,
      medicationProductKey: req.productKey,
      medicationRxcui: req.exactRxcui,
      rxcuisSearched,
      sourceIds: ["cms-part-d-monthly-formulary"],
      planYear: req.planYear,
    },
    found,
    restrictions: [...new Set(restrictions)],
    unknown,
    freshness,
    memberBenefitVerified: false,
    memberBenefitNote,
    nextSteps,
    caveats: baseCaveats,
  };
}
