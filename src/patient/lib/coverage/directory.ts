import "server-only";
import plansData from "@/sources/content/insurance/plans.json";

/**
 * Directory of payers, their plans, and pharmacies near a ZIP code.
 *
 * This is the lookup layer behind the coverage form's pickers, and everything
 * it returns is real. Payers and plans are 5,517 exact Medicare Part D plan
 * identities from the verified CMS release, synced by `npm run content:sync`.
 * Pharmacies are registered organisations from the CMS NPPES registry, looked
 * up live in ./pharmacies - which documents what a registration does and does
 * not prove. Nothing in either list is invented.
 *
 * ---------------------------------------------------------------------------
 * A PLAN NAME IS NOT AN IDENTIFIER
 * ---------------------------------------------------------------------------
 * 39 plans in the 2026-08 release share the name "AARP Medicare Rx Preferred
 * from UHC (PDP)". A name therefore produces CANDIDATES, never an answer.
 *
 * Every plan here is keyed by contractId + planId + segmentId + year, and the
 * form submits that key rather than a typed string. The label shown next to
 * it carries the identifiers too, so someone can match it against the card in
 * their hand instead of guessing from a name that repeats.
 *
 * ---------------------------------------------------------------------------
 * SIZE AND PLACEMENT
 * ---------------------------------------------------------------------------
 * The plan file is ~1.6 MB. This module is "server-only" so it can never be
 * pulled into a client bundle; the browser talks to /api/directory, which
 * returns at most a page of results.
 */

export interface Payer {
  /** Stable id used as the form value. The CMS organization name. */
  id: string;
  name: string;
  /** How many plans this organization offers in the loaded release. */
  planCount: number;
}

export interface Plan {
  /** contractId-planId-segmentId-year. The only safe way to name a plan. */
  id: string;
  payerId: string;
  name: string;
  contractId: string;
  planId: string;
  segmentId: string;
  formularyId: string;
  year: number;
  /**
   * Name plus identifiers, for a picker. Two plans can share `name`, so a
   * label without the identifiers would be genuinely ambiguous on screen.
   */
  label: string;
}

/*
 * Pharmacies come from the CMS NPPES registry and live in ./pharmacies, which
 * owns the lookup, the caveats about what a registration proves, and the
 * strict filtering that keeps "near you" true. Re-exported here so this module
 * stays the one place the coverage form's directory is reached through.
 */
export type { Pharmacy, PharmacyLookup } from "./pharmacies";
export { findPharmacies, isValidZip } from "./pharmacies";

interface RawPlan {
  planKey: string;
  contractId: string;
  planId: string;
  segmentId: string;
  formularyId: string;
  organizationName: string;
  planName: string;
}

interface PlansFile {
  market: string;
  sourceRelease: string;
  /** CMS writes this as a string, e.g. "2026". Parsed once, below. */
  contractYear: string;
  planCount: number;
  plans: RawPlan[];
}

const file = plansData as unknown as PlansFile;

/**
 * Plan year as a number.
 *
 * A coverage answer is only valid for the year its evidence came from, so a
 * year that will not parse is a hard failure rather than a silent NaN that
 * would later compare unequal to every requested year and look like a
 * mismatch in the data.
 */
const contractYear: number = (() => {
  const n = Number.parseInt(file.contractYear, 10);
  if (!Number.isInteger(n) || n < 2000 || n > 2100) {
    throw new Error(`Part D plan data has an unusable contractYear: ${file.contractYear}`);
  }
  return n;
})();

/** Which CMS release the pickers are showing. Surfaced, never implied. */
export function directoryRelease(): { market: string; sourceRelease: string; contractYear: number } {
  return {
    market: file.market,
    sourceRelease: file.sourceRelease,
    contractYear,
  };
}

const payers: Payer[] = (() => {
  const counts = new Map<string, number>();
  for (const p of file.plans) {
    counts.set(p.organizationName, (counts.get(p.organizationName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, planCount]) => ({ id: name, name, planCount }))
    .sort((a, b) => a.name.localeCompare(b.name));
})();

const plansByPayer = (() => {
  const map = new Map<string, Plan[]>();
  for (const p of file.plans) {
    const plan: Plan = {
      id: p.planKey,
      payerId: p.organizationName,
      name: p.planName,
      contractId: p.contractId,
      planId: p.planId,
      segmentId: p.segmentId,
      formularyId: p.formularyId,
      year: contractYear,
      label: `${p.planName} (${p.contractId}-${p.planId}-${p.segmentId})`,
    };
    const list = map.get(p.organizationName);
    if (list) list.push(plan);
    else map.set(p.organizationName, [plan]);
  }
  for (const list of map.values()) list.sort((a, b) => a.label.localeCompare(b.label));
  return map;
})();

/** True once a real directory is loaded, which the UI surfaces honestly. */
export function isDirectoryConnected(): boolean {
  return payers.length > 0;
}

export function listPayers(): Payer[] {
  return payers;
}

export function listPlans(payerId: string): Plan[] {
  return plansByPayer.get(payerId) ?? [];
}

/** One plan by its exact key, or null. Never a best guess. */
export function getPlan(planKey: string): Plan | null {
  for (const list of plansByPayer.values()) {
    const hit = list.find((p) => p.id === planKey);
    if (hit) return hit;
  }
  return null;
}

/**
 * Plans matching a name, as CANDIDATES.
 *
 * Returns every match, because returning one would be asserting an identity
 * the name cannot establish. A caller with more than one result must ask for
 * the contract, plan and segment ids rather than pick.
 */
export function planCandidatesByName(name: string): Plan[] {
  const q = normalise(name);
  if (q.length === 0) return [];
  const out: Plan[] = [];
  for (const list of plansByPayer.values()) {
    for (const p of list) if (normalise(p.name) === q) out.push(p);
  }
  return out;
}

/** Case- and punctuation-insensitive match for the insurer type-ahead. */
export function searchPayers(query: string, source: Payer[] = payers): Payer[] {
  const q = normalise(query);
  if (q.length === 0) return source;
  return source.filter((p) => normalise(p.name).includes(q));
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
