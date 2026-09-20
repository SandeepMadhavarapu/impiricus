import { describe, it, expect } from "vitest";
import {
  listPayers,
  listPlans,
  getPlan,
  planCandidatesByName,
  searchPayers,
  searchPlans,
  findPharmacies,
  isValidZip,
  isDirectoryConnected,
  directoryRelease,
} from "@/patient/lib/coverage/directory";

/**
 * The coverage pickers run on real CMS Part D plan identities. The property
 * that matters is not that the data loads, it is that a plan NAME is never
 * allowed to stand in for a plan.
 */
describe("the plan directory", () => {
  it("is loaded, and says which release it is showing", () => {
    expect(isDirectoryConnected()).toBe(true);
    const release = directoryRelease();
    expect(release.market).toBe("medicare-part-d");
    expect(release.sourceRelease).toMatch(/^\d{4}-\d{2}$/);
    expect(release.contractYear).toBeGreaterThan(2000);
  });

  it("carries the full set of organizations", () => {
    const payers = listPayers();
    expect(payers.length).toBeGreaterThan(100);
    expect(payers.every((p) => p.name.length > 0 && p.planCount > 0)).toBe(true);
  });

  it("sorts organizations so a picker is scannable", () => {
    const names = listPayers().map((p) => p.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  it("returns an organization's own plans, and only those", () => {
    const payer = listPayers().find((p) => p.planCount > 5)!;
    const plans = listPlans(payer.id);
    expect(plans.length).toBe(payer.planCount);
    expect(plans.every((p) => p.payerId === payer.id)).toBe(true);
  });

  it("returns nothing for an unknown organization rather than a near match", () => {
    expect(listPlans("NOT A REAL INSURER")).toEqual([]);
    expect(listPlans("")).toEqual([]);
  });

  /**
   * The rule the whole picker exists to honour. 39 plans in the 2026-08
   * release share one name, so a name must produce candidates, never an
   * answer.
   */
  it("treats a shared plan name as candidates, not as an identity", () => {
    const counts = new Map<string, number>();
    for (const payer of listPayers()) {
      for (const plan of listPlans(payer.id)) {
        counts.set(plan.name, (counts.get(plan.name) ?? 0) + 1);
      }
    }
    const shared = [...counts.entries()].filter(([, n]) => n > 1);
    expect(shared.length).toBeGreaterThan(0);

    const [name, n] = shared.sort((a, b) => b[1] - a[1])[0]!;
    const candidates = planCandidatesByName(name);
    expect(candidates.length).toBe(n);
    expect(candidates.length).toBeGreaterThan(1);
  });

  it("gives every plan a key that is unique, unlike its name", () => {
    const keys = new Set<string>();
    let total = 0;
    for (const payer of listPayers()) {
      for (const plan of listPlans(payer.id)) {
        keys.add(plan.id);
        total++;
      }
    }
    expect(keys.size).toBe(total);
  });

  it("shows the identifiers next to the name, so a card can be matched", () => {
    const payer = listPayers()[0]!;
    const plan = listPlans(payer.id)[0]!;
    expect(plan.label).toContain(plan.name);
    expect(plan.label).toContain(plan.contractId);
    expect(plan.label).toContain(plan.planId);
    expect(plan.label).toContain(plan.segmentId);
  });

  it("resolves a plan by its exact key only", () => {
    const payer = listPayers()[0]!;
    const plan = listPlans(payer.id)[0]!;
    expect(getPlan(plan.id)?.id).toBe(plan.id);
    expect(getPlan(plan.name)).toBeNull();
    expect(getPlan(`${plan.id}-nope`)).toBeNull();
  });

  it("searches organizations case- and punctuation-insensitively", () => {
    const payer = listPayers().find((p) => /humana/i.test(p.name));
    expect(payer).toBeDefined();
    expect(searchPayers("humana").length).toBeGreaterThan(0);
    expect(searchPayers("HUMANA").length).toBe(searchPayers("humana").length);
  });
});

describe("pharmacy search", () => {
  /**
   * No pharmacy dataset is licensed, so this must stay empty. Inventing
   * nearby pharmacies would put fictional addresses in front of someone
   * deciding where to fill a prescription.
   */
  it("returns nothing rather than inventing pharmacies", () => {
    expect(findPharmacies("22030")).toEqual([]);
  });

  it("rejects anything that is not a 5-digit ZIP", () => {
    expect(isValidZip("22030")).toBe(true);
    expect(isValidZip(" 22030 ")).toBe(true);
    for (const bad of ["2203", "220301", "abcde", "", "2203a", "22030-1234"]) {
      expect(isValidZip(bad), bad).toBe(false);
    }
  });

  it("does not run a lookup for a malformed ZIP", () => {
    expect(findPharmacies("abc")).toEqual([]);
    expect(findPharmacies("")).toEqual([]);
  });
});

/**
 * Searching for what is printed on the card.
 *
 * A Part D card usually shows the PRODUCT name, not the legal entity that
 * files it with CMS. Searching organizations alone, "AARP" - which appears in
 * 496 plan names in the 2026-08 release and in no organization name - returned
 * nothing, and the coverage form dead-ended for everyone holding one.
 */
describe("insurer search reaches plans, not just companies", () => {
  it("finds insurers by a brand that only appears in plan names", () => {
    const results = searchPayers("AARP");
    expect(results.length).toBeGreaterThan(0);
    // Every one of them got there via a plan, because no company is named AARP.
    expect(results.every((p) => p.matchedVia === "plan-name")).toBe(true);
    for (const p of results) {
      expect(p.matchedPlanExample?.toLowerCase()).toContain("aarp");
    }
  });

  it("still finds insurers by their own name, and ranks those first", () => {
    const results = searchPayers("United");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.matchedVia).toBe("organization");
    // Organization matches must not be interleaved with plan-name ones.
    const firstPlanMatch = results.findIndex((p) => p.matchedVia === "plan-name");
    if (firstPlanMatch >= 0) {
      expect(results.slice(firstPlanMatch).every((p) => p.matchedVia === "plan-name")).toBe(true);
    }
  });

  it("matches a full plan name someone copied off their card", () => {
    const results = searchPayers("AARP Medicare Rx Preferred");
    expect(results.length).toBeGreaterThan(0);
  });

  it("never reports the same insurer twice", () => {
    for (const q of ["Wellcare", "Humana", "AARP", "United"]) {
      const ids = searchPayers(q).map((p) => p.id);
      expect(new Set(ids).size, `duplicate insurer for query "${q}"`).toBe(ids.length);
    }
  });

  it("returns everything for an empty query, unannotated", () => {
    const all = searchPayers("");
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((p) => p.matchedVia === undefined)).toBe(true);
  });

  it("caps plan search so a one-letter query cannot ship thousands of rows", () => {
    expect(searchPlans("e").length).toBeLessThanOrEqual(50);
    expect(searchPlans("e", 10).length).toBeLessThanOrEqual(10);
    expect(searchPlans("").length).toBe(0);
  });

  it("plan search returns plans carrying their own identifiers", () => {
    const plans = searchPlans("AARP Medicare Rx Preferred", 5);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      // A name cannot identify a plan, so every result must carry the ids.
      expect(plan.contractId.length).toBeGreaterThan(0);
      expect(plan.planId.length).toBeGreaterThan(0);
      expect(plan.label).toContain(plan.contractId);
    }
  });
});

/**
 * A query that contains characters must never be treated as an empty box.
 *
 * `normalise` strips everything that is not a letter or digit, so "%%%" and
 * "---" collapsed to "" and hit the same branch as no input at all: the
 * function returned every payer, and the route capped that at 50. Someone who
 * typed something specific was shown an unfiltered list as though it matched.
 */
describe("queries that normalise away", () => {
  it("returns nothing for a punctuation-only query", () => {
    for (const q of ["%%%", "---", "!!!", "   &&&   ", "+/+"]) {
      expect(searchPayers(q), `"${q}" should match nothing`).toEqual([]);
    }
  });

  it("still returns the whole list for a genuinely empty box", () => {
    expect(searchPayers("").length).toBeGreaterThan(0);
    expect(searchPayers("   ").length).toBeGreaterThan(0);
  });

  it("is unaffected for a query with any searchable character", () => {
    expect(searchPayers("!AARP!").length).toBeGreaterThan(0);
    expect(searchPayers("aetna...").length).toBeGreaterThan(0);
  });

  it("plan search agrees", () => {
    expect(searchPlans("%%%")).toEqual([]);
    expect(searchPlans("")).toEqual([]);
  });
});
