import "server-only";
import plansData from "@/sources/content/insurance/plans.json";

/**
 * Directory of payers, their plans, and pharmacies near a ZIP code.
 *
 * This is the lookup layer behind the coverage form's pickers. Payers and
 * plans are REAL: 5,517 exact Medicare Part D plan identities from the
 * verified CMS release, synced by `npm run content:sync`. Pharmacies are not,
 * because no pharmacy dataset has been licensed, and that stays an honest
 * empty rather than a plausible invention.
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
  /**
   * How the search reached this payer.
   *
   * "organization" means the query matched the legal entity's name.
   * "plan-name" means it did not, and the payer was reached because one of its
   * PLANS matched - which is what happens when somebody types the brand
   * printed on their card. Undefined when no query was given.
   */
  matchedVia?: "organization" | "plan-name";
  /**
   * One plan name that caused a "plan-name" match, so the picker can explain
   * why an unfamiliar legal entity is being offered. Never shown as the
   * person's plan: it is an example, and the plan picker still asks.
   */
  matchedPlanExample?: string;
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

export interface Pharmacy {
  id: string;
  name: string;
  address: string;
  zip: string;
  /** Miles from the searched ZIP. Only set when the source provides one. */
  distanceMiles?: number;
  kind: "retail" | "mail-order" | "specialty";
}

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

/**
 * Pharmacies near a ZIP code, nearest first.
 *
 * No pharmacy dataset has been licensed for this prototype, so this returns
 * empty and the form falls back to asking for a pharmacy type and says the
 * search is not connected. Inventing nearby pharmacies would put fictional
 * addresses in front of someone deciding where to fill a prescription.
 *
 * The ZIP is used to run the lookup and is not stored or logged. Five digits
 * is coarse enough not to identify a person on its own, and nothing here
 * pairs it with anything that would.
 *
 * To connect one: return real rows here. Set `distanceMiles` only when the
 * source provides a distance. Never estimate it.
 */
export function findPharmacies(zip: string): Pharmacy[] {
  if (!isValidZip(zip)) return [];
  return [];
}

/** US ZIP, 5 digits. Rejects anything else rather than guessing. */
export function isValidZip(zip: string): boolean {
  return /^\d{5}$/.test(zip.trim());
}

/**
 * Insurer type-ahead, matching on the organization name AND on plan names.
 *
 * WHY PLAN NAMES ARE SEARCHED TOO
 * -------------------------------
 * The name on a Part D card is usually the PRODUCT, not the legal entity that
 * files it with CMS. In the 2026-08 release "AARP" appears in 496 plan names
 * and in zero organization names: searching organizations alone, the single
 * most recognisable brand in Medicare Part D returned nothing at all, and the
 * form silently dead-ended for anyone holding one of those cards.
 *
 * Organization matches rank first, because a person who types their insurer's
 * actual name means that insurer. Plan-name matches follow, each labelled with
 * the plan that caused it so an unfamiliar entity like "PHYSICIANS HEALTH
 * CHOICE OF TEXAS, LLC" is explained rather than merely appearing.
 *
 * This still resolves to a SET of candidates. It never picks one.
 */
export function searchPayers(query: string, source: Payer[] = payers): Payer[] {
  const raw = query.trim();
  const q = normalise(query);

  /*
   * An empty box means "show me the list". A box with characters in it means
   * "find these" - even when none of those characters survive normalisation.
   *
   * These were the same branch, so "%%%" or "---" normalised to "" and
   * returned every payer, capped at 50. Someone who typed something specific
   * got an unfiltered list presented as matches, which is a worse answer than
   * an honest none.
   */
  if (raw.length === 0) return source;
  if (q.length === 0) return [];

  const byOrg: Payer[] = [];
  const orgIds = new Set<string>();
  for (const p of source) {
    if (normalise(p.name).includes(q)) {
      byOrg.push({ ...p, matchedVia: "organization" });
      orgIds.add(p.id);
    }
  }

  // Walk plans once, recording the first matching plan name per organization.
  const viaPlan = new Map<string, string>();
  for (const [payerId, list] of plansByPayer) {
    if (orgIds.has(payerId)) continue;
    for (const plan of list) {
      if (normalise(plan.name).includes(q)) {
        viaPlan.set(payerId, plan.name);
        break;
      }
    }
  }

  const byPlan: Payer[] = [];
  for (const p of source) {
    const example = viaPlan.get(p.id);
    if (example !== undefined) {
      byPlan.push({ ...p, matchedVia: "plan-name", matchedPlanExample: example });
    }
  }

  return [...byOrg, ...byPlan];
}

/**
 * Plans whose name CONTAINS the query, as candidates.
 *
 * Distinct from `planCandidatesByName`, which requires an exact normalised
 * match and exists to resolve a name somebody already committed to. This one
 * backs searching, so it is deliberately loose - and deliberately capped,
 * because "e" matches thousands of plans and a picker cannot show them.
 */
export function searchPlans(query: string, limit = 50): Plan[] {
  const q = normalise(query);
  if (q.length === 0) return [];
  const out: Plan[] = [];
  for (const list of plansByPayer.values()) {
    for (const plan of list) {
      if (normalise(plan.name).includes(q)) {
        out.push(plan);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
