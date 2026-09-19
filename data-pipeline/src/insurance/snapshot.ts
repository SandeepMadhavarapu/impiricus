import { readFileSync, existsSync } from "node:fs";
import { writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { extractPartD } from "../sources/cmsPartD.js";
import { PARSER_VERSION, type Provenance } from "../schemas/index.js";

/**
 * The committed Part D evidence snapshot.
 *
 * The CMS archive is 2.14 GB, but only ~8.8 MB of it is relevant and the
 * formulary rows are filtered to our products' RXCUIs at parse time. What lands
 * on disk is small enough to commit, so teammates consume real coverage
 * evidence without running any ingestion.
 *
 * A snapshot that fails schema validation is treated as ABSENT rather than
 * partially trusted. Half-read coverage data is worse than none.
 */

export const SnapshotPlanSchema = z.object({
  contractId: z.string(),
  planId: z.string(),
  segmentId: z.string().nullable(),
  organizationName: z.string().nullable(),
  planName: z.string().nullable(),
  formularyId: z.string(),
  premium: z.string().nullable(),
  deductible: z.string().nullable(),
});
export type SnapshotPlan = z.infer<typeof SnapshotPlanSchema>;

export const SnapshotFormularySchema = z.object({
  formularyId: z.string(),
  formularyVersion: z.string().nullable(),
  contractYear: z.string().nullable(),
  rxcui: z.string(),
  tierLevelValue: z.number().int().nullable(),
  quantityLimitYn: z.boolean(),
  quantityLimitAmount: z.string().nullable(),
  quantityLimitDays: z.string().nullable(),
  priorAuthorizationYn: z.boolean(),
  stepTherapyYn: z.boolean(),
});

export const SnapshotCostSchema = z.object({
  contractId: z.string(),
  planId: z.string(),
  segmentId: z.string().nullable(),
  coverageLevel: z.string().nullable(),
  tier: z.number().int().nullable(),
  daysSupply: z.string().nullable(),
  costTypePref: z.string().nullable(),
  costAmtPref: z.string().nullable(),
});

export const PartDSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  sourceId: z.literal("cms-part-d-monthly-formulary"),
  release: z.string(),
  sourceUrl: z.string(),
  modified: z.string().nullable(),
  /** Contract year as published in the formulary rows. */
  contractYear: z.string().nullable(),
  retrievedAt: z.string(),
  /** Bytes actually transferred, vs the full archive size. */
  bytesFetched: z.number(),
  archiveBytes: z.number(),
  /** sha256 per extracted member, so a re-run is checkable. */
  memberHashes: z.record(z.string(), z.string()),
  rxcuisFiltered: z.array(z.string()),
  /** Row-level accounting: what was read, retained and rejected. */
  scope: z.object({
    membersFetched: z.array(z.object({ name: z.string(), compressedBytes: z.number(), uncompressedBytes: z.number() })),
    membersSkipped: z.array(z.object({ name: z.string(), uncompressedBytes: z.number(), reason: z.string() })),
    formularyRowsRead: z.number(),
    formularyRowsRetained: z.number(),
    formularyRowsRejectedRxcuiFilter: z.number(),
    planRowsRead: z.number(),
    planRowsUnique: z.number(),
    planRowsRejectedIncomplete: z.number(),
    costRowsRead: z.number(),
    excludedRowsRead: z.number(),
    rxcuisWithNoMatch: z.array(z.string()),
    formularyIdsWithoutPlan: z.array(z.string()),
    /** Plans retained after filtering to formularies carrying our drugs. */
    plansRetained: z.number(),
    /** Plans dropped because their formulary carries none of our drugs. */
    plansDroppedNoMatchingFormulary: z.number(),
    /** Cost rules retained (demo plans only) and the full file size. */
    costRulesRetained: z.number(),
    costRulesAvailable: z.number(),
  }),
  plans: z.array(SnapshotPlanSchema),
  formulary: z.array(SnapshotFormularySchema),
  costs: z.array(SnapshotCostSchema),
  excluded: z.array(z.object({ formularyId: z.string(), rxcui: z.string() })),
});
export type PartDSnapshot = z.infer<typeof PartDSnapshotSchema>;

const SNAPSHOT_PATH = path.join(
  process.cwd(),
  "data",
  "normalized",
  "insurance",
  "cms-part-d-snapshot.json"
);

let cached: PartDSnapshot | null | undefined;

export function loadPartDSnapshot(): PartDSnapshot | null {
  if (cached !== undefined) return cached;
  try {
    if (!existsSync(SNAPSHOT_PATH)) {
      cached = null;
      return cached;
    }
    const parsed = PartDSnapshotSchema.safeParse(JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")));
    if (!parsed.success) {
      console.warn(
        "[insurance] Part D snapshot failed schema validation; treating as absent. " +
          "Coverage lookups will report source-unavailable rather than using partial data."
      );
      cached = null;
      return cached;
    }
    cached = parsed.data;
    return cached;
  } catch {
    cached = null;
    return cached;
  }
}

export function resetSnapshotCache(): void {
  cached = undefined;
}

/**
 * Builds the snapshot from live CMS data.
 *
 * `plansToKeep` bounds the committed plan index: the full file has 5,518 rows,
 * and only plans whose formulary actually contains one of our drugs are useful
 * for lookups.
 */
export async function buildPartDSnapshot(
  rxcuis: string[],
  /**
   * Plans whose tier COST-SHARING RULES are retained.
   *
   * The full beneficiary cost file is 172,660 rows (~23 MB) because generic
   * montelukast is on nearly every formulary. Cost-sharing rules are secondary
   * evidence — they are plan rules, never a member's price — so the committed
   * snapshot keeps them only for explicitly named demo plans. The full file is
   * always re-fetchable with `npm run insurance:ingest`.
   */
  costPlans: Array<{ contractId: string; planId: string }> = []
): Promise<PartDSnapshot> {
  const wanted = new Set(rxcuis);
  const extract = await extractPartD(wanted);

  const usedFormularies = new Set(extract.formularyRows.map((r) => r.formularyId));
  const plans = extract.planRows
    .filter((p) => usedFormularies.has(p.formularyId))
    .map((p) => ({
      contractId: p.contractId,
      planId: p.planId,
      segmentId: p.segmentId,
      organizationName: p.contractName,
      planName: p.planName,
      formularyId: p.formularyId,
      premium: p.premium,
      deductible: p.deductible,
    }));

  const costKeys = new Set(costPlans.map((p) => `${p.contractId}|${p.planId}`));
  const costs = extract.costRows
    .filter((c) => costKeys.has(`${c.contractId}|${c.planId}`))
    .map((c) => ({
      contractId: c.contractId,
      planId: c.planId,
      segmentId: c.segmentId,
      coverageLevel: c.coverageLevel,
      tier: c.tier,
      daysSupply: c.daysSupply,
      costTypePref: c.costTypePref,
      costAmtPref: c.costAmtPref,
    }));

  const contractYear =
    extract.formularyRows.find((r) => r.contractYear)?.contractYear ?? null;

  return {
    schemaVersion: 1,
    sourceId: "cms-part-d-monthly-formulary",
    release: extract.release.release,
    sourceUrl: extract.release.url,
    modified: extract.release.modified,
    contractYear,
    retrievedAt: extract.retrievedAt,
    bytesFetched: extract.bytesFetched,
    archiveBytes: extract.release.totalBytes,
    memberHashes: extract.memberHashes,
    rxcuisFiltered: [...wanted].sort(),
    scope: {
      ...extract.scope,
      plansRetained: plans.length,
      plansDroppedNoMatchingFormulary: extract.planRows.length - plans.length,
      costRulesRetained: costs.length,
      costRulesAvailable: extract.costRows.length,
    },
    plans,
    formulary: extract.formularyRows,
    costs,
    excluded: extract.excludedRows,
  };
}

export async function writePartDSnapshot(snapshot: PartDSnapshot): Promise<string> {
  await mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true });
  const tmp = `${SNAPSHOT_PATH}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  await rename(tmp, SNAPSHOT_PATH);
  resetSnapshotCache();
  return SNAPSHOT_PATH;
}

/** Provenance entries for a snapshot, one per extracted member. */
export function snapshotProvenance(snapshot: PartDSnapshot): Provenance[] {
  return Object.entries(snapshot.memberHashes).map(([member, hash]) => ({
    sourceId: "openfda" as const, // registry id; see sourceIds on the result
    sourceName: `CMS Monthly Prescription Drug Plan Formulary (${member})`,
    url: snapshot.sourceUrl,
    retrievedAt: snapshot.retrievedAt,
    sourceEffectiveDate: snapshot.modified,
    sourceIdentifier: snapshot.release,
    sourceVersion: snapshot.contractYear,
    rawPath: "data/normalized/insurance/cms-part-d-snapshot.json",
    contentHash: hash,
    captureId: snapshot.release,
    locator: member,
    parserVersion: PARSER_VERSION,
  }));
}

export { SNAPSHOT_PATH };
