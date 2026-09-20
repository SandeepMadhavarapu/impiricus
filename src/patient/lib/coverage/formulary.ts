import { z } from "zod";

/**
 * CMS Medicare Part D formulary evidence.
 *
 * This is REAL, plan-specific coverage data — not a payer API, and not a
 * simulation. CMS publishes the complete Part D formulary set monthly as public
 * domain data:
 *
 *   "Monthly Prescription Drug Plan Formulary and Pharmacy Network Information"
 *   https://data.cms.gov
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
 * ---------------------------------------------------------------------------
 * THREE THINGS THE LOOKUP MUST NOT CONFLATE
 * ---------------------------------------------------------------------------
 *
 * 1. A PLAN NAME IS NOT A PLAN. 39 plans in the 2026-08 release are named
 *    "AARP Medicare Rx Preferred from UHC (PDP)". When the form supplies an
 *    exact identity (contract + plan + segment + year, chosen from the CMS
 *    directory) the lookup uses ONLY that, and if that plan is absent it says
 *    so rather than sliding to a similarly named one. Fuzzy name matching is
 *    a fallback for a typed name, and it stays conservative.
 *
 * 2. A GENERIC LISTING IS NOT A BRAND LISTING. A formulary lists RxNorm
 *    concepts, and a product has more than one: the exact branded product
 *    (SBD) and the generic clinical drug of the same strength and form (SCD).
 *    Brand Singulair (153892) is on ONE formulary in the 2026-08 release;
 *    generic montelukast 10 mg (200224) is on hundreds. Both are searched,
 *    exact first, and the result carries WHICH one was found so the answer
 *    can say "the generic is listed; the brand is not" instead of "listed".
 *
 * 3. ONE PRODUCT'S RXCUIs, NOT EVERY PRODUCT'S. The snapshot holds rows for
 *    every product the app knows. An earlier version of this lookup searched
 *    all of them at once, so a Singulair check could match on an Ozempic row.
 *    The caller passes the concepts for the one product on the page.
 *
 * The dataset is ~2.2 GB compressed. The data-pipeline package extracts the
 * rows for our products and `npm run content:sync` converts that into the
 * committed snapshot at src/sources/content/coverage/. See scripts/sync-label-exports.mjs.
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
   * The contract year the release describes. A formulary is only evidence
   * for its own year; a request for another year is refused, not approximated.
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

/* ------------------------------------------------------------- identity */

/**
 * How closely a formulary row matches the product on the page.
 *
 *   exact-product   The branded product concept itself (SBD).
 *   clinical-drug   The generic clinical drug of the same strength and form
 *                   (SCD). Real evidence, but about the generic, and the
 *                   answer must say so.
 */
export type MatchGranularity = "exact-product" | "clinical-drug";

/** The RxNorm concepts that identify ONE product, for the lookup. */
export interface ProductConcepts {
  exact: { rxcui: string; name: string | null };
  clinicalDrug: Array<{ rxcui: string; name: string | null }>;
}

/**
 * Which plan to check.
 *
 * `planKey` is the exact identity from the CMS directory picker, in the form
 * the directory emits: "medicare-partd-<year>-<contract>-<plan>-<segment>".
 * When present it is authoritative. `insurer` and `planName` are what the
 * person typed, used only when no key was supplied.
 */
export interface PlanSelector {
  planKey?: string;
  insurer: string;
  planName: string;
  planYear: number;
}

const PLAN_KEY = /^medicare-partd-(\d{4})-([A-Za-z0-9]+)-([A-Za-z0-9]+)-([A-Za-z0-9]+)$/;

/** Parses a directory plan key. Null for anything that is not one. */
export function parsePlanKey(
  key: string
): { year: number; contractId: string; planId: string; segmentId: string } | null {
  const m = PLAN_KEY.exec(key);
  if (!m) return null;
  return { year: Number(m[1]), contractId: m[2]!, planId: m[3]!, segmentId: m[4]! };
}

/** Result of looking one plan up in the snapshot. */
export type FormularyLookup =
  | { kind: "no-snapshot" }
  /** The evidence is for a different contract year than was asked about. */
  | { kind: "year-mismatch"; requestedYear: number; coveredYear: number }
  /** The plan could not be identified — do NOT infer anything from this. */
  | { kind: "plan-not-matched"; candidates: string[] }
  /** Plan identified, no concept of this product on its formulary. */
  | { kind: "drug-not-listed"; plan: PlanRow }
  | {
      kind: "listed";
      plan: PlanRow;
      row: FormularyRow;
      granularity: MatchGranularity;
      /** The concept the row matched, for the answer to name. */
      concept: { rxcui: string; name: string | null };
    };

/* --------------------------------------------------------- plan matching */

/** Normalises a plan name for fuzzy comparison. */
function planNameKey(s: string): string {
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
  const q = new Set(planNameKey(query).split(" ").filter((t) => t.length > 2));
  const c = new Set(planNameKey(candidate).split(" ").filter((t) => t.length > 2));
  if (q.size === 0 || c.size === 0) return 0;
  let overlap = 0;
  for (const token of q) if (c.has(token)) overlap++;
  return overlap / q.size;
}

/** A match below this is treated as no match at all. */
export const MATCH_THRESHOLD = 0.6;

/** Exact identity, or null. Never falls back to a name. */
function planByKey(snapshot: FormularySnapshot, key: string): PlanRow | null {
  const parsed = parsePlanKey(key);
  if (!parsed) return null;
  return (
    snapshot.plans.find(
      (p) =>
        p.contractId === parsed.contractId &&
        p.planId === parsed.planId &&
        (p.segmentId ?? "000") === parsed.segmentId
    ) ?? null
  );
}

/** Best fuzzy name match above the threshold, or null. */
function planByName(snapshot: FormularySnapshot, insurer: string, planName: string): PlanRow | null {
  const query = `${insurer} ${planName}`;
  let best: { plan: PlanRow; score: number } | null = null;
  for (const plan of snapshot.plans) {
    const candidate = `${plan.organizationName ?? ""} ${plan.planName}`;
    const score = matchScore(query, candidate);
    if (!best || score > best.score) best = { plan, score };
  }
  return best && best.score >= MATCH_THRESHOLD ? best.plan : null;
}

/* ---------------------------------------------------------------- lookup */

/**
 * Looks up one plan's formulary entry for one product.
 *
 * Returns a discriminated result so the caller can distinguish "we could not
 * find your plan" from "your plan does not list this drug" from "your plan
 * lists the generic, not the brand" — conflating any two of those is exactly
 * how a coverage tool starts lying.
 */
export function lookupFormulary(
  snapshot: FormularySnapshot | null,
  selector: PlanSelector,
  concepts: ProductConcepts
): FormularyLookup {
  if (!snapshot) return { kind: "no-snapshot" };

  // A 2026 formulary says nothing about 2025 or 2027 coverage. Checked before
  // resolving the plan. A plan key carries its own year, and that must agree
  // with the evidence too.
  const coveredYear = snapshot.contractYear;
  if (selector.planYear !== coveredYear) {
    return { kind: "year-mismatch", requestedYear: selector.planYear, coveredYear };
  }
  const keyYear = selector.planKey ? parsePlanKey(selector.planKey)?.year : undefined;
  if (keyYear !== undefined && keyYear !== coveredYear) {
    return { kind: "year-mismatch", requestedYear: keyYear, coveredYear };
  }

  const plan = selector.planKey
    ? planByKey(snapshot, selector.planKey)
    : planByName(snapshot, selector.insurer, selector.planName);

  if (!plan) {
    return {
      kind: "plan-not-matched",
      candidates: snapshot.plans.slice(0, 5).map((p) => p.planName),
    };
  }

  const rows = snapshot.formulary.filter((f) => f.formularyId === plan.formularyId);

  // Exact product first. Only if the brand itself is absent do we report the
  // generic, and then as the generic.
  const exactRow = rows.find((f) => f.rxcui === concepts.exact.rxcui);
  if (exactRow) {
    return { kind: "listed", plan, row: exactRow, granularity: "exact-product", concept: concepts.exact };
  }
  for (const concept of concepts.clinicalDrug) {
    const row = rows.find((f) => f.rxcui === concept.rxcui);
    if (row) return { kind: "listed", plan, row, granularity: "clinical-drug", concept };
  }

  return { kind: "drug-not-listed", plan };
}

/**
 * Renders a quantity limit as published.
 *
 * Three cases, kept distinct: no limit flagged; a limit flagged with figures;
 * a limit flagged WITHOUT figures. The last is real (CMS sets the Y/N and
 * leaves amount and days blank), and it must not render as "Not available",
 * which reads as "we do not know whether there is a limit". There is one.
 */
export function describeQuantityLimit(row: FormularyRow): string | null {
  if (!row.quantityLimit) return "No limit published for this plan";
  return row.quantityLimitDescription ?? "Limit applies; amount not published";
}

/** "Organisation: Plan name (H1234-001-000)" — the identity that was checked. */
export function describePlan(plan: PlanRow): string {
  const id = [plan.contractId, plan.planId, plan.segmentId ?? "000"].join("-");
  const org = plan.organizationName ? `${plan.organizationName}: ` : "";
  return `${org}${plan.planName} (${id})`;
}
