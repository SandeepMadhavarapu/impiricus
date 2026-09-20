import { z } from "zod";

/**
 * Adapter: pipeline formulary snapshot -> the application's snapshot shape.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Two CMS ingesters grew independently. `scripts/ingest-formulary.mjs` in the
 * web app wrote a small snapshot in one shape; this pipeline writes a larger,
 * richer one in another. The app validates what it loads, so the pipeline's
 * file could not be dropped in even after somebody copied it - the Zod parse
 * failed and the loader fell back to "no snapshot", which the coverage flow
 * reports as "unable to verify".
 *
 * The result was a system that HELD 979 formulary rows for the right drugs and
 * told every user it was "not connected to any formulary database".
 *
 * Rather than keep two incompatible formats alive, the pipeline now produces
 * the application's shape as a first-class export. The app schema is the
 * canonical application representation; this module is the only place that
 * knows how to get there from the pipeline's internal one.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not invent values. A tier the source did not publish becomes null,
 * not 0 and not "unknown". A quantity limit flagged without an amount keeps
 * the flag and gets a null description, because "there is a limit and we were
 * not told what it is" is a different fact from "there is no limit".
 *
 * It does not swallow malformed input. Every failure throws with the field
 * path, so a schema drift upstream stops the build instead of shipping a
 * half-empty formulary that the UI would render as "not on your plan's list".
 */

/* ------------------------------------------------------ pipeline input */

/**
 * Only the fields the transform reads are modelled, and the object is left
 * open: the pipeline snapshot carries cost and provenance data the app has no
 * use for, and rejecting it for being richer than needed would be wrong.
 */
const PipelineFormularyRowSchema = z
  .object({
    formularyId: z.string().min(1),
    rxcui: z.string().min(1),
    tierLevelValue: z.number().nullable().optional(),
    priorAuthorizationYn: z.boolean(),
    stepTherapyYn: z.boolean(),
    quantityLimitYn: z.boolean(),
    quantityLimitAmount: z.string().nullable().optional(),
    quantityLimitDays: z.string().nullable().optional(),
  })
  .passthrough();

const PipelinePlanRowSchema = z
  .object({
    contractId: z.string().min(1),
    planId: z.string().min(1),
    segmentId: z.string().nullable().optional(),
    formularyId: z.string().min(1),
    planName: z.string(),
    organizationName: z.string().nullable().optional(),
  })
  .passthrough();

export const PipelineSnapshotSchema = z
  .object({
    schemaVersion: z.number(),
    release: z.string().min(1),
    sourceUrl: z.string().url(),
    retrievedAt: z.string().min(1),
    modified: z.string().nullable().optional(),
    contractYear: z.union([z.string(), z.number()]).nullable().optional(),
    rxcuisFiltered: z.array(z.string()).min(1),
    plans: z.array(PipelinePlanRowSchema),
    formulary: z.array(PipelineFormularyRowSchema),
  })
  .passthrough();

/* ------------------------------------------------- application output */

/**
 * Mirrors `src/patient/lib/coverage/formulary.ts` in the web app.
 *
 * Kept in step by a test on the app side that parses the SHIPPED artifact with
 * the app's own schema. If the two ever drift, that test fails rather than the
 * coverage flow silently going quiet in production.
 */
export const AppFormularyRowSchema = z.object({
  formularyId: z.string().min(1),
  rxcui: z.string().min(1),
  tier: z.number().int().positive().nullable(),
  priorAuthorization: z.boolean(),
  stepTherapy: z.boolean(),
  quantityLimit: z.boolean(),
  quantityLimitDescription: z.string().nullable(),
});

export const AppPlanRowSchema = z.object({
  contractId: z.string().min(1),
  planId: z.string().min(1),
  segmentId: z.string().nullable(),
  formularyId: z.string().min(1),
  planName: z.string().min(1),
  organizationName: z.string().nullable(),
});

export const AppSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  cmsRelease: z.string().min(1),
  /**
   * The CMS contract year this release describes.
   *
   * Carried because the application had no way to tell whether a request's
   * plan year was the one the data covers. A 2026 drug list answers nothing
   * about a 2024 plan, and the coverage endpoint was answering anyway.
   */
  contractYear: z.number().int().min(2000).max(2100),
  sourceUrl: z.string().url(),
  retrievedAt: z.string().min(1),
  rxcuis: z.array(z.string()).min(1),
  plans: z.array(AppPlanRowSchema),
  formulary: z.array(AppFormularyRowSchema),
});

export type AppSnapshot = z.infer<typeof AppSnapshotSchema>;

/* ---------------------------------------------------------- transform */

/**
 * Builds the published quantity limit sentence.
 *
 * Both parts are required to say anything: "3 per null days" is worse than
 * silence, and the flag alone already tells the UI a limit exists. Units are
 * kept as the source published them - "3 per 28 days" is not "3 per month".
 */
export function quantityLimitDescription(
  amount: string | null | undefined,
  days: string | null | undefined
): string | null {
  const a = (amount ?? "").trim();
  const d = (days ?? "").trim();
  if (a.length === 0 || d.length === 0) return null;
  return `${a} per ${d} ${d === "1" ? "day" : "days"}`;
}

/**
 * Normalises a published tier to the app's contract.
 *
 * The app types tier as a POSITIVE integer or null. CMS uses 0 and blanks for
 * "not tiered"; mapping those to null keeps "no tier published" distinct from
 * "tier 0", which would render as a real tier number to a reader.
 */
export function normaliseTier(raw: number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (!Number.isFinite(raw)) return null;
  const n = Math.trunc(raw);
  return n > 0 ? n : null;
}

export interface AdaptResult {
  snapshot: AppSnapshot;
  stats: {
    plansIn: number;
    plansOut: number;
    formularyIn: number;
    formularyOut: number;
    plansDroppedNoName: number;
    tiersNulled: number;
    quantityLimitsWithoutDetail: number;
  };
}

/**
 * Transforms a pipeline snapshot into the application's shape.
 *
 * Throws on malformed input rather than returning a partial snapshot: an empty
 * or truncated formulary would be rendered by the UI as "we checked and your
 * drug is not on the list", which is a clinical claim this data would not
 * support.
 */
export function adaptPipelineSnapshot(raw: unknown): AdaptResult {
  const parsed = PipelineSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(
      `Pipeline snapshot failed validation, so no application snapshot was written. ` +
        `This usually means the CMS file layout changed. Issues: ${issues}`
    );
  }
  const src = parsed.data;

  let plansDroppedNoName = 0;
  const plans = src.plans
    .filter((p) => {
      // The app requires a non-empty plan name: it is the only thing a reader
      // can match against their card. A nameless row cannot be presented.
      if (p.planName.trim().length > 0) return true;
      plansDroppedNoName++;
      return false;
    })
    .map((p) => ({
      contractId: p.contractId,
      planId: p.planId,
      segmentId: p.segmentId ?? null,
      formularyId: p.formularyId,
      planName: p.planName.trim(),
      organizationName: p.organizationName?.trim() || null,
    }));

  let tiersNulled = 0;
  let quantityLimitsWithoutDetail = 0;
  const formulary = src.formulary.map((f) => {
    const tier = normaliseTier(f.tierLevelValue);
    if (tier === null) tiersNulled++;
    const description = quantityLimitDescription(f.quantityLimitAmount, f.quantityLimitDays);
    if (f.quantityLimitYn && description === null) quantityLimitsWithoutDetail++;
    return {
      formularyId: f.formularyId,
      rxcui: f.rxcui,
      tier,
      priorAuthorization: f.priorAuthorizationYn,
      stepTherapy: f.stepTherapyYn,
      quantityLimit: f.quantityLimitYn,
      quantityLimitDescription: description,
    };
  });

  const contractYear = Number(src.contractYear);
  if (!Number.isInteger(contractYear) || contractYear < 2000 || contractYear > 2100) {
    throw new Error(
      `Pipeline snapshot has an unusable contractYear (${JSON.stringify(src.contractYear)}). ` +
        `Refusing to write it: without a year the app cannot tell whether the data covers ` +
        `the plan year someone asked about.`
    );
  }

  const candidate = {
    schemaVersion: 1 as const,
    cmsRelease: src.release,
    contractYear,
    sourceUrl: src.sourceUrl,
    retrievedAt: src.retrievedAt,
    rxcuis: src.rxcuisFiltered,
    plans,
    formulary,
  };

  const out = AppSnapshotSchema.safeParse(candidate);
  if (!out.success) {
    const issues = out.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(
      `Transformed snapshot does not satisfy the application schema, so nothing was ` +
        `written. Issues: ${issues}`
    );
  }

  // A snapshot with plans but no formulary rows would let the UI answer
  // "not on your plan's list" for every drug. That is a false negative about
  // medication access, so it is treated as a failed build.
  if (out.data.formulary.length === 0) {
    throw new Error(
      "Transformed snapshot contains zero formulary rows. Refusing to write it: the " +
        "coverage flow would report every medication as not listed."
    );
  }
  if (out.data.plans.length === 0) {
    throw new Error("Transformed snapshot contains zero plans. Refusing to write it.");
  }

  return {
    snapshot: out.data,
    stats: {
      plansIn: src.plans.length,
      plansOut: plans.length,
      formularyIn: src.formulary.length,
      formularyOut: formulary.length,
      plansDroppedNoName,
      tiersNulled,
      quantityLimitsWithoutDetail,
    },
  };
}
