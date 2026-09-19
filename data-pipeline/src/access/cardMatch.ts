/**
 * Insurance-card field matching.
 *
 * A future UI may obtain card fields however it likes - OCR, manual entry, a
 * wallet pass. This module is independent of that: it takes fields and returns
 * what they do and do not establish. No image is read here, and no card
 * storage exists anywhere in this pipeline.
 *
 * WHAT A CARD ACTUALLY ESTABLISHES
 *
 * RxBIN routes a pharmacy claim to a processor. RxPCN selects a benefit
 * configuration within that processor. Neither is a formulary identifier, and
 * neither is unique to a plan: one BIN/PCN pair routinely serves hundreds of
 * employer groups with different drug lists. Treating a BIN/PCN as a plan is
 * the mechanism by which a tool shows someone another group's formulary.
 *
 * So the matcher reports a RESOLUTION LEVEL, and the levels are ordered by
 * what they license a caller to display:
 *
 *   insurer-identified      we know the carrier, nothing about the benefit
 *   routing-identified      we know where claims route; not which plan
 *   plan-family-identified  we know a group of plans; still ambiguous
 *   exact-plan-identified   one plan, one year - the plan question is settled
 *
 * Reaching the last level is NECESSARY BUT NOT SUFFICIENT for showing that
 * plan's formulary evidence. It settles which plan someone holds; it says
 * nothing about whether we hold usable evidence for that plan. Four further
 * conditions have to hold - a verified plan-to-formulary relationship, a
 * medication match at a granularity that actually covers this product, a plan
 * year and source version that are applicable, and a lookup that returned
 * usable evidence. `mayDisplayFormularyEvidence` checks all five together.
 *
 * Under no combination does any of this verify a person's benefits.
 *
 * PRIVACY
 *
 * Member ID and group number are accepted because a user may supply them, but
 * they are never persisted, never logged, never exported and never used as
 * match evidence. They identify a person, not a plan. `redactForLog` exists so
 * a caller can prove what it is safe to write down.
 */

import type { PlanIdentity } from "../schemas/insurance.js";

/** Fields a card may carry. Every one is optional; cards vary. */
export interface InsuranceCardFields {
  insurerName?: string | null;
  planName?: string | null;
  /** PERSONAL. Never stored, logged or exported. */
  memberId?: string | null;
  /** PERSONAL in practice; group numbers often identify an employer. */
  groupNumber?: string | null;
  rxBin?: string | null;
  rxPcn?: string | null;
  rxGroup?: string | null;
  /** Medicare cards print these directly; most commercial cards do not. */
  contractId?: string | null;
  planId?: string | null;
  segmentId?: string | null;
  planYear?: number | null;
  stateCode?: string | null;
}

export type CardResolutionLevel =
  | "nothing-identified"
  | "insurer-identified"
  | "routing-identified"
  | "plan-family-identified"
  | "exact-plan-identified";

export interface CardMatchEvidence {
  field: string;
  /** The value's ROLE, never the value itself when it is personal. */
  valueShown: string | null;
  establishes: string;
  doesNotEstablish: string;
}

export interface CardMatchResult {
  level: CardResolutionLevel;
  /**
   * True only at exact-plan-identified.
   *
   * NECESSARY BUT NOT SUFFICIENT for showing a plan's formulary evidence.
   * Knowing which plan someone holds says nothing about whether we hold usable
   * evidence for it. Call `mayDisplayFormularyEvidence` before displaying
   * anything; this flag only says the plan question is settled.
   */
  mayLookUpCoverage: boolean;
  /** Plans consistent with the fields supplied. */
  candidates: Array<{ planKey: string; planName: string | null; formularyId: string | null }>;
  /** Fields that would narrow the result, most useful first. */
  missingFields: string[];
  /** What each supplied field did and did not establish. */
  evidence: CardMatchEvidence[];
  /** Plain sentence a UI can render. */
  explanation: string;
  /** Fields the caller supplied that were deliberately ignored. */
  ignoredPersonalFields: string[];
  /** True when the user must choose between candidates. */
  requiresUserSelection: boolean;
}

/** Personal fields. Accepted, immediately discarded, never matched on. */
const PERSONAL_FIELDS = ["memberId", "groupNumber"] as const;

/**
 * Strips anything that identifies a person.
 *
 * Callers log THIS, never the raw fields. Returning a new object rather than
 * mutating means a caller cannot accidentally log the original.
 */
export function redactForLog(fields: InsuranceCardFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if ((PERSONAL_FIELDS as readonly string[]).includes(k)) {
      out[k] = v == null || v === "" ? "<absent>" : "<redacted>";
      continue;
    }
    out[k] = v ?? null;
  }
  return out;
}

function norm(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t.length === 0 ? null : t;
}

/**
 * Matches card fields against known plans.
 *
 * `plans` is the set this pipeline can actually resolve - currently the
 * Medicare Part D plans from the verified CMS release. A card from any other
 * market will not reach `exact-plan-identified`, and says so, rather than
 * being forced onto the nearest Part D plan.
 */
export function matchCard(
  fields: InsuranceCardFields,
  plans: PlanIdentity[]
): CardMatchResult {
  const evidence: CardMatchEvidence[] = [];
  const ignoredPersonalFields: string[] = [];

  for (const f of PERSONAL_FIELDS) {
    if (norm(fields[f])) {
      ignoredPersonalFields.push(f);
      evidence.push({
        field: f,
        valueShown: null,
        establishes: "Nothing about which plan this is.",
        doesNotEstablish:
          "This identifies a PERSON, not a benefit. It is discarded here and never " +
          "stored, logged, exported or used to match.",
      });
    }
  }

  const contractId = norm(fields.contractId);
  const planId = norm(fields.planId);
  const segmentId = norm(fields.segmentId);
  const insurerName = norm(fields.insurerName);
  const planName = norm(fields.planName);
  const rxBin = norm(fields.rxBin);
  const rxPcn = norm(fields.rxPcn);
  const rxGroup = norm(fields.rxGroup);

  if (rxBin) {
    evidence.push({
      field: "rxBin",
      valueShown: rxBin,
      establishes: "Which claims processor a pharmacy claim routes to.",
      doesNotEstablish:
        "Which plan, benefit design or formulary applies. One BIN serves many unrelated plans.",
    });
  }
  if (rxPcn) {
    evidence.push({
      field: "rxPcn",
      valueShown: rxPcn,
      establishes: "A benefit configuration within that processor.",
      doesNotEstablish:
        "A formulary. No public crosswalk maps BIN/PCN to a formulary id, and this pipeline " +
        "does not invent one.",
    });
  }
  if (rxGroup) {
    evidence.push({
      field: "rxGroup",
      valueShown: rxGroup,
      establishes: "The purchasing group the benefit belongs to.",
      doesNotEstablish:
        "Which drug list that group bought. Groups sharing a PBM often have different lists.",
    });
  }
  if (insurerName) {
    evidence.push({
      field: "insurerName",
      valueShown: insurerName,
      establishes: "The carrier.",
      doesNotEstablish: "Any particular plan. A carrier may offer hundreds.",
    });
  }
  if (planName) {
    evidence.push({
      field: "planName",
      valueShown: planName,
      establishes: "A marketing name.",
      doesNotEstablish:
        "A unique plan. In the verified CMS release, 39 distinct plans share the name " +
        '"AARP Medicare Rx Preferred from UHC (PDP)".',
    });
  }

  /* ---- Medicare identifiers are the only path to an exact plan. ---- */

  if (contractId && planId) {
    const withSegment = plans.filter(
      (p) =>
        p.contractId?.toUpperCase() === contractId.toUpperCase() &&
        p.planId === planId &&
        (segmentId ? p.segmentId === segmentId : true)
    );
    const yearFiltered = fields.planYear
      ? withSegment.filter((p) => p.planYear === fields.planYear)
      : withSegment;

    evidence.push({
      field: "contractId + planId" + (segmentId ? " + segmentId" : ""),
      valueShown: `${contractId}-${planId}${segmentId ? `-${segmentId}` : ""}`,
      establishes: "A Medicare contract and benefit package.",
      doesNotEstablish: segmentId
        ? "Anything about this person's enrolment or eligibility."
        : "A single plan when the contract has multiple segments; the segment id is still needed.",
    });

    if (yearFiltered.length === 1) {
      const only = yearFiltered[0]!;
      return {
        level: "exact-plan-identified",
        mayLookUpCoverage: true,
        candidates: [
          { planKey: only.planKey, planName: only.planName, formularyId: only.formularyId },
        ],
        missingFields: fields.planYear ? [] : ["planYear"],
        evidence,
        explanation:
          `Resolved to exactly one plan (${only.planKey}). Published formulary evidence for ` +
          "this plan can be shown. Nothing about this person's enrolment, eligibility or cost " +
          "is known.",
        ignoredPersonalFields,
        requiresUserSelection: false,
      };
    }

    if (yearFiltered.length > 1) {
      return {
        level: "plan-family-identified",
        mayLookUpCoverage: false,
        candidates: yearFiltered.slice(0, 25).map((p) => ({
          planKey: p.planKey,
          planName: p.planName,
          formularyId: p.formularyId,
        })),
        missingFields: [segmentId ? "planYear" : "segmentId"],
        evidence,
        explanation:
          `${yearFiltered.length} plans match these identifiers. Ask which one before showing ` +
          "any coverage information.",
        ignoredPersonalFields,
        requiresUserSelection: true,
      };
    }
  }

  /* ---- Name-based narrowing never resolves a plan. ---- */

  if (insurerName || planName) {
    const needle = (planName ?? insurerName)!.toLowerCase();
    const candidates = plans.filter(
      (p) =>
        (p.planName ?? "").toLowerCase().includes(needle) ||
        (p.organizationName ?? "").toLowerCase().includes(needle)
    );

    if (candidates.length > 0) {
      return {
        level: "plan-family-identified",
        mayLookUpCoverage: false,
        candidates: candidates.slice(0, 25).map((p) => ({
          planKey: p.planKey,
          planName: p.planName,
          formularyId: p.formularyId,
        })),
        missingFields: ["contractId", "planId", "segmentId", "planYear"],
        evidence,
        explanation:
          `${candidates.length} plans carry this name. A name is not an identifier: the ` +
          "contract, plan and segment numbers are needed before coverage can be shown.",
        ignoredPersonalFields,
        requiresUserSelection: true,
      };
    }

    return {
      level: "insurer-identified",
      mayLookUpCoverage: false,
      candidates: [],
      missingFields: ["contractId", "planId", "segmentId", "planYear"],
      evidence,
      explanation:
        "The carrier is recognisable but no plan in the checked source matches. This pipeline " +
        "resolves Medicare Part D plans only; a card from another market will not resolve here.",
      ignoredPersonalFields,
      requiresUserSelection: false,
    };
  }

  /* ---- Routing fields alone. ---- */

  if (rxBin || rxPcn || rxGroup) {
    return {
      level: "routing-identified",
      mayLookUpCoverage: false,
      candidates: [],
      missingFields: ["insurerName", "contractId", "planId", "segmentId", "planYear"],
      evidence,
      explanation:
        "These fields establish how a pharmacy claim routes, not which plan or drug list " +
        "applies. No public crosswalk maps RxBIN/RxPCN to a formulary, so no coverage can be " +
        "shown from them.",
      ignoredPersonalFields,
      requiresUserSelection: false,
    };
  }

  return {
    level: "nothing-identified",
    mayLookUpCoverage: false,
    candidates: [],
    missingFields: ["insurerName", "contractId", "planId", "segmentId", "planYear"],
    evidence,
    explanation:
      ignoredPersonalFields.length > 0
        ? "Only personal identifiers were supplied. Those identify a person, not a plan, and are " +
          "discarded. Plan identifiers are needed."
        : "No usable plan identifiers were supplied.",
    ignoredPersonalFields,
    requiresUserSelection: false,
  };
}


/* ------------------------------------------------------- display gating */

/**
 * Everything that must hold before a plan's formulary evidence may be shown.
 *
 * Resolving the plan is one of five conditions, not the decision. The others
 * fail independently and for unrelated reasons: the plan record may not carry
 * a formulary id, the evidence may be for a different formulary, the match may
 * be at ingredient level rather than this product, the evidence may be for
 * another plan year, or the source document may not be in force yet.
 */
export interface FormularyDisplayContext {
  /** From CardMatchResult.level. */
  planResolvedExactly: boolean;
  /** Formulary id recorded on the PLAN record. */
  formularyIdOnPlanRecord: string | null;
  /** Formulary id recorded on the EVIDENCE row. */
  formularyIdOnEvidence: string | null;
  /** How closely the listed concept matches this product. */
  medicationMatchGranularity:
    | "exact-product"
    | "clinical-drug"
    | "ingredient"
    | "drug-class"
    | "ambiguous-text"
    | null;
  /** The year the caller is asking about. */
  requestedPlanYear: number;
  /** The year the evidence belongs to. */
  evidencePlanYear: number | null;
  /** Whether the source document is in force. */
  sourceEffectivity: "currently-effective" | "upcoming" | "superseded" | "not-applicable";
  /** The coverage state the lookup returned. */
  coverageState: string;
}

export interface FormularyDisplayDecision {
  mayDisplay: boolean;
  /** Conditions that failed. Each one alone prevents display. */
  blockedBy: string[];
  /** Conditions that passed but constrain HOW it may be shown. */
  cautions: string[];
  /**
   * Always false. Nothing in this pipeline verifies a person's actual
   * benefits, and resolving their plan does not begin to.
   */
  personalBenefitsVerified: false;
  explanation: string;
}

/** States that mean we do not hold usable evidence. */
const UNUSABLE_COVERAGE_STATES = new Set([
  "source-unavailable",
  "ambiguous-plan",
  "ambiguous-drug",
  "stale-source",
]);

/**
 * Decides whether plan-specific formulary evidence may be displayed.
 *
 * Every condition is checked independently and all failures are reported, so a
 * caller sees the whole reason rather than the first one.
 */
export function mayDisplayFormularyEvidence(
  ctx: FormularyDisplayContext
): FormularyDisplayDecision {
  const blockedBy: string[] = [];
  const cautions: string[] = [];

  if (!ctx.planResolvedExactly) {
    blockedBy.push(
      "The plan is not resolved to exactly one contract, plan and segment in a known year."
    );
  }

  // A plan-to-formulary relationship has to be established, not assumed.
  if (!ctx.formularyIdOnPlanRecord) {
    blockedBy.push(
      "The plan record carries no formulary id, so no formulary can be attributed to it."
    );
  } else if (!ctx.formularyIdOnEvidence) {
    blockedBy.push("The evidence row carries no formulary id, so it cannot be tied to this plan.");
  } else if (ctx.formularyIdOnPlanRecord !== ctx.formularyIdOnEvidence) {
    blockedBy.push(
      `The evidence is for formulary ${ctx.formularyIdOnEvidence} but this plan uses ` +
        `${ctx.formularyIdOnPlanRecord}. It is another plan's drug list.`
    );
  }

  switch (ctx.medicationMatchGranularity) {
    case null:
      blockedBy.push("No medication match was recorded.");
      break;
    case "ambiguous-text":
      blockedBy.push(
        "The formulary entry is free text that could not be resolved to a drug concept."
      );
      break;
    case "drug-class":
      blockedBy.push(
        "The match is at drug-class level, which does not establish that this product is listed."
      );
      break;
    case "ingredient":
      cautions.push(
        "The match is at INGREDIENT level. It does not establish that this strength, form or " +
          "brand is listed. Say so wherever it is shown."
      );
      break;
    case "clinical-drug":
      cautions.push(
        "The match is a generic clinical-drug concept, NOT the branded product. A generic " +
          "listing does not establish that the brand is listed."
      );
      break;
    case "exact-product":
      break;
  }

  if (ctx.evidencePlanYear === null) {
    blockedBy.push("The evidence carries no plan year, so its applicability cannot be checked.");
  } else if (ctx.evidencePlanYear !== ctx.requestedPlanYear) {
    blockedBy.push(
      `The evidence is for plan year ${ctx.evidencePlanYear} but ${ctx.requestedPlanYear} was ` +
        "requested. Coverage is defined per plan year."
    );
  }

  if (ctx.sourceEffectivity === "upcoming") {
    blockedBy.push(
      "The source document is not in force yet. Showing it as current coverage would state " +
        "future rules as today's."
    );
  } else if (ctx.sourceEffectivity === "superseded") {
    blockedBy.push("The source document has been superseded by a newer effective version.");
  } else if (ctx.sourceEffectivity === "not-applicable") {
    blockedBy.push("The source document's effectivity was not established.");
  }

  if (UNUSABLE_COVERAGE_STATES.has(ctx.coverageState)) {
    blockedBy.push(`The lookup returned "${ctx.coverageState}", so no usable evidence was found.`);
  }

  const mayDisplay = blockedBy.length === 0;
  return {
    mayDisplay,
    blockedBy,
    cautions,
    personalBenefitsVerified: false,
    explanation: mayDisplay
      ? "Published formulary evidence for this plan and product may be shown" +
        (cautions.length > 0 ? ", with the cautions attached." : ".") +
        " This remains what the plan PUBLISHES. It is not this person's benefit, and nothing " +
        "here establishes their enrolment, eligibility, approval or cost."
      : "Plan-specific formulary evidence must not be displayed: " + blockedBy.join(" "),
  };
}
