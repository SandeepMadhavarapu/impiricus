import { z } from "zod";

/**
 * CMS Medicare Part D formulary evidence.
 *
 * This is REAL, plan-specific coverage data — not a payer API, and not a
 * simulation. CMS publishes the complete Part D formulary set monthly as public
 * domain data:
 *
 *   "Monthly Prescription Drug Plan Formulary and Pharmacy Network Information"
 *   https://data.cms.gov  (see scripts/ingest-formulary.mjs)
 *
 * Within it, two pipe-delimited files carry what we need:
 *   basic drugs formulary file -> FORMULARY_ID, RXCUI, TIER_LEVEL_VALUE,
 *                                 PRIOR_AUTHORIZATION_YN, STEP_THERAPY_YN,
 *                                 QUANTITY_LIMIT_YN, QUANTITY_LIMIT_AMOUNT,
 *                                 QUANTITY_LIMIT_DAYS
 *   plan information file      -> CONTRACT_ID, PLAN_ID, FORMULARY_ID,
 *                                 PLAN_NAME, SEGMENT_ID
 *
 * WHAT THIS ESTABLISHES, AND WHAT IT DOES NOT.
 *
 * A row here proves the drug appears on a named plan's published formulary,
 * with its tier and utilisation-management flags. That is genuine, verifiable,
 * plan-specific evidence, and far stronger than "unable to verify".
 *
 * It is still NOT member coverage. It does not know whether a given person is
 * enrolled, whether their deductible is met, or what they would actually pay.
 * So a hit here resolves to "formulary-listed" or "restrictions-indicated" —
 * never "member-benefit-response", and never a cost estimate. Only a pharmacy
 * claim produces a price.
 *
 * The CMS release is ~2.2 GB compressed, so only the extracted subset ships:
 * the rows matching the catalogue's RXCUIs plus the plan index, about 1.5 MB.
 * That subset IS committed, at src/sources/content/coverage/, and is produced
 * by the data pipeline (`npm run app:snapshot`, then `npm run content:sync`).
 *
 * It used to be operator-generated and gitignored, which meant a deployment
 * never had it and the coverage flow reported "unable to verify" for every
 * request while telling the reader it was "not connected to any formulary
 * database". A snapshot that only exists on somebody's laptop is not data the
 * product has.
 *
 * A snapshot that fails validation is still treated as absent, and absence
 * still means missing DATA, never "not covered".
 */

export const FormularyRowSchema = z.object({
  /** CMS formulary identifier the plan points at. */
  formularyId: z.string().min(1),
  rxcui: z.string().min(1),
  /** Tier number as published, e.g. 1. Null when the file omitted it. */
  tier: z.number().int().positive().nullable(),
  priorAuthorization: z.boolean(),
  stepTherapy: z.boolean(),
  quantityLimit: z.boolean(),
  /** e.g. "30 per 30 days" when published, otherwise null. */
  quantityLimitDescription: z.string().nullable(),
});
export type FormularyRow = z.infer<typeof FormularyRowSchema>;

export const PlanRowSchema = z.object({
  contractId: z.string().min(1),
  planId: z.string().min(1),
  segmentId: z.string().nullable(),
  formularyId: z.string().min(1),
  planName: z.string().min(1),
  /** Organisation marketing name, used for insurer matching. */
  organizationName: z.string().nullable(),
});
export type PlanRow = z.infer<typeof PlanRowSchema>;

export const FormularySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  /** The CMS release this was extracted from, e.g. "2026-08". */
  cmsRelease: z.string().min(1),
  /**
   * The CMS contract year this release describes.
   *
   * A 2026 drug list says nothing about a 2024 plan. The endpoint used to
   * accept any planYear between 2020 and 2100 and answer from whatever
   * release was loaded, without ever comparing the two.
   */
  contractYear: z.number().int().min(2000).max(2100),
  /** Source file URL, recorded so the claim is checkable. */
  sourceUrl: z.string().url(),
  retrievedAt: z.string().min(1),
  /** RXCUIs this snapshot was filtered to. */
  rxcuis: z.array(z.string()).min(1),
  plans: z.array(PlanRowSchema),
  formulary: z.array(FormularyRowSchema),
});
export type FormularySnapshot = z.infer<typeof FormularySnapshotSchema>;

/** Result of looking one plan up in the snapshot. */
export type FormularyLookup =
  | { kind: "no-snapshot" }
  /**
   * The plan name could not be matched to exactly one drug list — do NOT infer
   * anything from this. `reason` separates "nothing looked like your plan" from
   * "several plans matched equally well and they do not share a drug list", so
   * the UI can say which happened.
   */
  | {
      kind: "plan-not-matched";
      candidates: string[];
      reason:
        /** Nothing resembled the name given. */
        | "no-match"
        /** Several plans matched and their evidence for this drug disagrees. */
        | "ambiguous-evidence"
        /** Several plans matched and at least one has no usable drug list. */
        | "missing-formulary-mapping";
    }
  /** The request's plan year is not the year this release describes. */
  | { kind: "year-not-covered"; requestedYear: number; coveredYear: number }
  /** Plan matched, drug absent from its formulary. */
  | { kind: "drug-not-listed"; plan: PlanRow; identity: PlanIdentity }
  | { kind: "listed"; plan: PlanRow; row: FormularyRow; identity: PlanIdentity };

/**
 * How confidently the plan was identified.
 *
 * A shared drug list makes the ANSWER the same whichever tied plan is meant.
 * It does not establish WHICH plan the person is enrolled in, and it says
 * nothing at all about their eligibility, their own restrictions or what they
 * pay. Those are different claims and this type keeps them apart, so a caller
 * cannot present a drug-list answer as a resolved enrolment.
 */
export interface PlanIdentity {
  /** True only when exactly one plan row matched best. */
  resolved: boolean;
  /** How many plans tied at the best score. */
  matchedPlanCount: number;
  /** Distinct contract ids among them, for a caller that wants to say so. */
  contractIds: string[];
  /**
   * What the answer rests on.
   *
   *   "exact-plan"     one plan matched, so the evidence is that plan's.
   *   "shared-evidence" several plans matched and every one of them publishes
   *                    the same thing about this drug. The DRUG answer is
   *                    therefore the same whichever is meant - but which plan
   *                    the person holds is still unknown, and nothing about
   *                    their eligibility or cost has been established.
   */
  evidenceBasis: "exact-plan" | "shared-evidence";
  /** Distinct formulary ids the tied plans point at. */
  formularyIds: string[];
}

/** Normalises a plan name for fuzzy comparison. */
function planKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(inc|llc|the|plan|plans|health|insurance|company|co)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Scores how well a candidate plan matches the insurer + plan name typed.
 *
 * SYMMETRIC, and that is the whole point. The score used to be
 * `overlap / query.size`, which counts the query words that matched and
 * charges nothing for the ones that did not. A query naming a COMMERCIAL plan
 * therefore scored on the words it shared with a Medicare plan and got no
 * penalty for the word that made it commercial:
 *
 *   "UnitedHealthcare / UHC Choice Plus Commercial"
 *      -> 3 of 5 query tokens matched = 0.600, exactly the threshold
 *      -> matched three Medicare D-SNP plans, a different market entirely
 *
 * The harmonic mean of precision and recall charges for both directions: words
 * in the query the plan does not have, and words in the plan the query does
 * not have. The same query scores 0.429 and is rejected, while every exact
 * plan name measured against the 2026-08 release still scores 1.000.
 *
 * It remains deliberately conservative. A weak match returns nothing rather
 * than guessing at someone's plan.
 */
function matchScore(query: string, candidate: string): number {
  const q = new Set(planKey(query).split(" ").filter((t) => t.length > 2));
  const c = new Set(planKey(candidate).split(" ").filter((t) => t.length > 2));
  if (q.size === 0 || c.size === 0) return 0;
  let overlap = 0;
  for (const token of q) if (c.has(token)) overlap++;
  if (overlap === 0) return 0;
  const precision = overlap / q.size;
  const recall = overlap / c.size;
  return (2 * precision * recall) / (precision + recall);
}

/** A match below this is treated as no match at all. */
export const MATCH_THRESHOLD = 0.6;

/**
 * Looks up one plan's formulary entry for any of the product's RXCUIs.
 *
 * Returns a discriminated result so the caller can distinguish "we could not
 * find your plan" from "your plan does not list this drug" — conflating those
 * two is exactly how a coverage tool starts lying.
 */
export function lookupFormulary(
  snapshot: FormularySnapshot | null,
  insurer: string,
  planName: string,
  rxcuis: string[],
  /** When given, must be the year this release describes. */
  requestedYear?: number
): FormularyLookup {
  if (!snapshot) return { kind: "no-snapshot" };

  /*
   * A drug list is only about one contract year.
   *
   * `planYear` was accepted (2020-2100), echoed back in the result, and never
   * compared with the release. A request about a 2024 plan was answered from
   * the 2026 file as though the two were the same thing.
   */
  if (requestedYear !== undefined && requestedYear !== snapshot.contractYear) {
    return {
      kind: "year-not-covered",
      requestedYear,
      coveredYear: snapshot.contractYear,
    };
  }

  const query = `${insurer} ${planName}`;

  /*
   * EVERY plan at the top score, not the first one that reached it.
   *
   * `matchScore` divides by the query's token count, so a short query that is
   * wholly contained in a long plan name scores a perfect 1.0. Typing
   * "Humana" and "Humana Gold Plus HMO" scored 1.000 against 308 different
   * plans in the 2026-08 release, spanning FOUR different formularies - and
   * the old code returned whichever of the 308 happened to come first in the
   * file. The tier, prior authorisation and quantity limit a reader saw were
   * decided by row order.
   *
   * The rule this codebase already states about plan names applies here: a
   * name produces candidates, never an identity. Ties are only safe when every
   * tied plan points at the SAME drug list, because then the answer is the
   * same whichever one is meant - which is why the AARP case (39 plans, one
   * formulary) was correct and this one was not.
   */
  let topScore = 0;
  let tied: PlanRow[] = [];
  for (const plan of snapshot.plans) {
    const candidate = `${plan.organizationName ?? ""} ${plan.planName}`;
    const score = matchScore(query, candidate);
    if (score > topScore) {
      topScore = score;
      tied = [plan];
    } else if (score === topScore && topScore > 0) {
      tied.push(plan);
    }
  }

  if (tied.length === 0 || topScore < MATCH_THRESHOLD) {
    return {
      kind: "plan-not-matched",
      // The near-misses, not the first five rows in the file.
      candidates: uniqueNames(tied).slice(0, 5),
      reason: "no-match",
    };
  }

  const wanted = new Set(rxcuis);
  const formularyIds = [...new Set(tied.map((p) => p.formularyId))].sort();

  /*
   * A shared answer is allowed only when every candidate actually agrees.
   *
   * The earlier rule was "same formularyId", which is narrower AND weaker than
   * it looks. Narrower, because two different drug lists that publish the same
   * thing about this drug give the same answer. Weaker, because pointing at
   * the same list is not the same as that list HAVING a usable entry: a plan
   * whose formulary id appears nowhere in the formulary table has no evidence
   * at all, and silently borrowing a sibling's row would invent one.
   *
   * So the test is on the evidence itself: every tied plan must have a
   * mapping, and the rows they publish for this product must match.
   */
  const perPlan = tied.map((plan) => {
    const rowsOnFormulary = snapshot.formulary.filter((f) => f.formularyId === plan.formularyId);
    return {
      plan,
      /** False when this plan's drug list is absent from the release. */
      hasMapping: rowsOnFormulary.length > 0,
      row: rowsOnFormulary.find((f) => wanted.has(f.rxcui)) ?? null,
    };
  });

  if (perPlan.some((p) => !p.hasMapping)) {
    return {
      kind: "plan-not-matched",
      candidates: uniqueNames(tied).slice(0, 5),
      reason: "missing-formulary-mapping",
    };
  }

  // Compare the published evidence, not the identifier it came from. Row order
  // cannot affect this: it is a set of value signatures.
  const signatures = new Set(perPlan.map((p) => evidenceSignature(p.row)));
  if (signatures.size > 1) {
    return {
      kind: "plan-not-matched",
      candidates: uniqueNames(tied).slice(0, 5),
      reason: "ambiguous-evidence",
    };
  }

  const identity: PlanIdentity = {
    resolved: tied.length === 1,
    matchedPlanCount: tied.length,
    contractIds: [...new Set(tied.map((p) => p.contractId))].sort(),
    evidenceBasis: tied.length === 1 ? "exact-plan" : "shared-evidence",
    formularyIds,
  };

  const plan = tied[0]!;
  const row = perPlan[0]!.row;

  return row
    ? { kind: "listed", plan, row, identity }
    : { kind: "drug-not-listed", plan, identity };
}

/**
 * A value signature for "what this plan publishes about this product".
 *
 * Absence is a signature too, and a different one from any presence: half the
 * candidates listing a drug and half not is a disagreement, not a detail.
 */
function evidenceSignature(row: FormularyRow | null): string {
  if (row === null) return "absent";
  return JSON.stringify([
    row.tier,
    row.priorAuthorization,
    row.stepTherapy,
    row.quantityLimit,
    row.quantityLimitDescription,
  ]);
}

/** Distinct plan names, preserving order, for showing someone what was near. */
function uniqueNames(plans: PlanRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of plans) {
    if (seen.has(p.planName)) continue;
    seen.add(p.planName);
    out.push(p.planName);
  }
  return out;
}

/** Renders a published quantity limit, or null when CMS did not publish one. */
export function describeQuantityLimit(row: FormularyRow): string | null {
  if (!row.quantityLimit) return "No limit published for this plan";
  return row.quantityLimitDescription;
}
