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
 * The dataset is ~2.2 GB compressed, so it is NOT committed. An operator runs
 * scripts/ingest-formulary.mjs, which downloads it, extracts only the rows
 * matching this product's RXCUIs, and writes a compact snapshot here. Until
 * that snapshot exists the adapter reports itself unconfigured — missing DATA,
 * not missing integration code.
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
  /** The plan name could not be matched — do NOT infer anything from this. */
  | { kind: "plan-not-matched"; candidates: string[] }
  /** Plan matched, drug absent from its formulary. */
  | { kind: "drug-not-listed"; plan: PlanRow }
  | { kind: "listed"; plan: PlanRow; row: FormularyRow };

/** Normalises a plan name for fuzzy comparison. */
function planKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(inc|llc|the|plan|plans|health|insurance|company|co)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Scores how well a candidate plan matches the insurer + plan name the user
 * typed. Token overlap, deliberately conservative: a weak match returns
 * nothing rather than guessing at someone's plan.
 */
function matchScore(query: string, candidate: string): number {
  const q = new Set(planKey(query).split(" ").filter((t) => t.length > 2));
  const c = new Set(planKey(candidate).split(" ").filter((t) => t.length > 2));
  if (q.size === 0 || c.size === 0) return 0;
  let overlap = 0;
  for (const token of q) if (c.has(token)) overlap++;
  return overlap / q.size;
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
  rxcuis: string[]
): FormularyLookup {
  if (!snapshot) return { kind: "no-snapshot" };

  const query = `${insurer} ${planName}`;
  let best: { plan: PlanRow; score: number } | null = null;
  for (const plan of snapshot.plans) {
    const candidate = `${plan.organizationName ?? ""} ${plan.planName}`;
    const score = matchScore(query, candidate);
    if (!best || score > best.score) best = { plan, score };
  }

  if (!best || best.score < MATCH_THRESHOLD) {
    return {
      kind: "plan-not-matched",
      candidates: snapshot.plans.slice(0, 5).map((p) => p.planName),
    };
  }

  const wanted = new Set(rxcuis);
  const row = snapshot.formulary.find(
    (f) => f.formularyId === best!.plan.formularyId && wanted.has(f.rxcui)
  );

  return row
    ? { kind: "listed", plan: best.plan, row }
    : { kind: "drug-not-listed", plan: best.plan };
}

/** Renders a published quantity limit, or null when CMS did not publish one. */
export function describeQuantityLimit(row: FormularyRow): string | null {
  if (!row.quantityLimit) return "No limit published for this plan";
  return row.quantityLimitDescription;
}
