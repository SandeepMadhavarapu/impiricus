import { describe, it, expect } from "vitest";
import {
  listPayers,
  listPlans,
  getPlan,
  planCandidatesByName,
  searchPayers,
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
   * Pharmacies now come from the CMS NPPES registry rather than an honest
   * empty. The invariant that replaced "must stay empty" is stronger and is
   * enforced in tests/pharmacy-lookup.test.ts: every row returned is one the
   * registry published, filtered to the searched ZIP, and no row is ever
   * synthesised or partly filled.
   *
   * What is asserted here is that no lookup leaves the process for input that
   * was never a ZIP - checked without a network, so a failure means the guard
   * broke rather than that a registry was slow.
   */
  it("does not reach the registry for a malformed ZIP", async () => {
    let called = false;
    const never: typeof fetch = async () => {
      called = true;
      throw new Error("the registry must not be called for a malformed ZIP");
    };
    for (const bad of ["abc", "", "2203", "220301", "22030-1234"]) {
      const result = await findPharmacies(bad, never);
      expect(result.status, bad).toBe("unavailable");
      expect(result.pharmacies, bad).toEqual([]);
    }
    expect(called).toBe(false);
  });

  it("rejects anything that is not a 5-digit ZIP", () => {
    expect(isValidZip("22030")).toBe(true);
    expect(isValidZip(" 22030 ")).toBe(true);
    for (const bad of ["2203", "220301", "abcde", "", "2203a", "22030-1234"]) {
      expect(isValidZip(bad), bad).toBe(false);
    }
  });

  it("reports an invalid ZIP as unavailable, never as an empty neighbourhood", async () => {
    // "We did not search" and "there are none near you" are different facts,
    // and only one of them is an answer about the reader's neighbourhood.
    const result = await findPharmacies("abc", async () => {
      throw new Error("unreachable");
    });
    expect(result).toEqual({ status: "unavailable", pharmacies: [], reason: "invalid-zip" });
  });
});
