import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { buildPartDSnapshot, writePartDSnapshot, loadPartDSnapshot, snapshotProvenance } from "./snapshot.js";
import { lookupCoverage, type LookupRequest } from "./lookup.js";
import { DEMO_PLANS } from "../config/demoPlans.js";
import type { MatchGranularity } from "../schemas/insurance.js";

/** Collects the RXCUIs to search for one product, tagged by granularity. */
export function rxcuisForProduct(productKey: string): {
  exactRxcui: string | null;
  related: Array<{ rxcui: string; granularity: MatchGranularity; name: string | null }>;
} {
  const file = path.join("data", "normalized", `${productKey}.json`);
  const r = JSON.parse(readFileSync(file, "utf8"));
  if (!r.rxnorm?.present) return { exactRxcui: null, related: [] };

  const related: Array<{ rxcui: string; granularity: MatchGranularity; name: string | null }> = [];
  // SCD is the generic clinical drug; SBD the branded one. A listing for the
  // clinical drug concept is NOT a listing for the branded product.
  for (const c of r.rxnorm.related?.SCD ?? []) {
    related.push({ rxcui: c.rxcui, granularity: "clinical-drug", name: c.name });
  }
  for (const c of r.rxnorm.related?.IN ?? []) {
    related.push({ rxcui: c.rxcui, granularity: "ingredient", name: c.name });
  }
  return { exactRxcui: r.rxnorm.rxcui, related };
}

export function listProductKeys(): string[] {
  return readdirSync(path.join("data", "normalized"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

export async function cmdInsuranceIngest(): Promise<void> {
  const rx = new Set<string>();
  for (const key of listProductKeys()) {
    const r = JSON.parse(readFileSync(path.join("data", "normalized", `${key}.json`), "utf8"));
    if (!r.rxnorm?.present) continue;
    rx.add(r.rxnorm.rxcui);
    for (const tty of ["SCD", "SBD", "GPCK", "BPCK"]) {
      for (const c of r.rxnorm.related?.[tty] ?? []) rx.add(c.rxcui);
    }
  }
  console.log(`Fetching CMS Part D evidence for ${rx.size} RXCUIs...`);
  const snap = await buildPartDSnapshot([...rx], DEMO_PLANS);
  const p = await writePartDSnapshot(snap);
  console.log(`\nwrote ${path.relative(process.cwd(), p)}`);
  console.log(`  release        ${snap.release} (contract year ${snap.contractYear})`);
  console.log(`  archive        ${(snap.archiveBytes / 1073741824).toFixed(2)} GB`);
  console.log(`  fetched        ${(snap.bytesFetched / 1048576).toFixed(1)} MB by HTTP range`);
  console.log(`  formulary rows ${snap.formulary.length}`);
  console.log(`  plans          ${snap.plans.length}`);
  console.log(`  cost rules     ${snap.costs.length} (demo plans only)`);
}

export function cmdCoverage(args: string[]): void {
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const snapshot = loadPartDSnapshot();
  if (!snapshot) {
    console.log("No Part D snapshot. Run: npm run insurance:ingest");
    process.exitCode = 1;
    return;
  }

  const productKey = opt("product") ?? listProductKeys()[0]!;
  const { exactRxcui, related } = rxcuisForProduct(productKey);

  const req: LookupRequest = {
    productKey,
    exactRxcui,
    relatedRxcuis: related,
    planYear: Number(opt("year") ?? snapshot.contractYear ?? 2026),
    contractId: opt("contract"),
    planId: opt("plan"),
    segmentId: opt("segment"),
    planNameQuery: opt("planName"),
  };

  const result = lookupCoverage(snapshot, req, snapshotProvenance(snapshot));

  console.log(`\n=== ${productKey} ===`);
  console.log(`state:    ${result.state}`);
  console.log(`headline: ${result.headline}`);
  console.log(`\nCHECKED`);
  console.log(`  plan:        ${result.checked.plan?.planName ?? "(not resolved)"}`);
  console.log(`  plan key:    ${result.checked.plan?.planKey ?? "-"}`);
  console.log(`  formulary:   ${result.checked.plan?.formularyId ?? "-"}`);
  console.log(`  resolution:  ${result.checked.planResolution.state} - ${result.checked.planResolution.rationale}`);
  console.log(`  rxcuis:      ${result.checked.rxcuisSearched.map((r) => `${r.rxcui}(${r.granularity})`).join(", ")}`);
  if (result.checked.planResolution.candidates.length > 0) {
    console.log(`  candidates:`);
    for (const c of result.checked.planResolution.candidates.slice(0, 5)) {
      console.log(`    ${c.planKey} | formulary ${c.formularyId} | ${c.planName}`);
    }
    console.log(`  need:        ${result.checked.planResolution.missingDisambiguators.join(", ")}`);
  }

  console.log(`\nFOUND (${result.found.length})`);
  for (const f of result.found) {
    console.log(`  rxcui ${f.matchedRxcui} [${f.granularity}] exactProduct=${f.isExactProductMatch}`);
    console.log(`    tier ${f.policy.tier ?? "?"} | PA ${f.policy.priorAuthorization} | ST ${f.policy.stepTherapy} | QL ${f.policy.quantityLimit.asStated ?? f.policy.quantityLimit.present}`);
  }

  if (result.restrictions.length > 0) {
    console.log(`\nRESTRICTIONS`);
    for (const r of result.restrictions) console.log(`  - ${r}`);
  }
  console.log(`\nUNKNOWN`);
  for (const u of result.unknown) console.log(`  - ${u}`);
  console.log(`\nFRESHNESS  release ${result.freshness.sourceRelease} | retrieved ${result.freshness.retrievedAt} | yearMismatch ${result.freshness.yearMismatch}`);
  console.log(`MEMBER BENEFIT VERIFIED: ${result.memberBenefitVerified}`);
}
