import { describe, it, expect, beforeEach } from "vitest";
import { loadFormularySnapshot, resetFormularySnapshotCache } from "@/patient/lib/coverage/snapshot";
import { productConcepts } from "@/patient/lib/coverage/concepts";
import { getCoverageAdapter, cmsFormularyAdapter } from "@/patient/lib/coverage/adapters";
import { lookupFormulary } from "@/patient/lib/coverage/formulary";
import { listGuideSlugs } from "@/sources/lib/content/catalogue";
import { directoryRelease, getPlan, listPayers } from "@/patient/lib/coverage/directory";
import type { CoverageRequest } from "@/patient/lib/coverage/types";

/**
 * The COMMITTED snapshot, checked end to end.
 *
 * Every other coverage test uses a synthetic snapshot. This one loads the
 * real file the deployment ships, and checks the six demo scenarios against
 * the answers the data-pipeline computed for the same CMS release
 * (data-pipeline/data/exports/insurance/coverage-examples.json). The pipeline
 * is the oracle: if these two disagree, one of them is wrong about a real
 * plan's real drug list.
 */

const AARP = { planKey: "medicare-partd-2026-S5820-034-000", insurer: "UnitedHealthcare", planName: "AARP Medicare Rx Preferred from UHC (PDP)" };
const HAMASPIK = { planKey: "medicare-partd-2026-H0034-001-000", insurer: "Hamaspik", planName: "Hamaspik Medicare Select (HMO D-SNP)" };

const SINGULAIR = "singulair-montelukast-10mg-tablet";
const TOPROL = "toprol-xl-metoprolol-succinate-50mg-er-tablet";
const OZEMPIC = "ozempic-semaglutide-1_34mg-per-ml-injection";

/** From the pipeline's coverage-examples.json for release 2026-08. */
const ORACLE = [
  { slug: OZEMPIC, plan: AARP, state: "restrictions-indicated", granularity: "exact-product", rxcui: "2398842", tier: "Tier 3", pa: "yes", st: "no", ql: "3 per 28 days" },
  { slug: OZEMPIC, plan: HAMASPIK, state: "restrictions-indicated", granularity: "exact-product", rxcui: "2398842", tier: "Tier 1", pa: "yes", st: "no", ql: "3 per 28 days" },
  { slug: SINGULAIR, plan: AARP, state: "restrictions-indicated", granularity: "clinical-drug", rxcui: "200224", tier: "Tier 1", pa: "no", st: "no", ql: "30 per 30 days" },
  { slug: SINGULAIR, plan: HAMASPIK, state: "formulary-listed", granularity: "exact-product", rxcui: "153892", tier: "Tier 1", pa: "no", st: "no", ql: "No limit published for this plan" },
  { slug: TOPROL, plan: AARP, state: "formulary-listed", granularity: "clinical-drug", rxcui: "866436", tier: "Tier 1", pa: "no", st: "no", ql: "No limit published for this plan" },
  { slug: TOPROL, plan: HAMASPIK, state: "formulary-listed", granularity: "exact-product", rxcui: "866438", tier: "Tier 1", pa: "no", st: "no", ql: "No limit published for this plan" },
] as const;

function req(slug: string, plan: typeof AARP): CoverageRequest {
  return {
    slug,
    ...plan,
    planYear: 2026,
    strength: "n/a",
    dosageForm: "n/a",
    quantity: 30,
    daysSupply: 30,
    pharmacyType: "unspecified",
  };
}

beforeEach(() => resetFormularySnapshotCache());

describe("the committed snapshot", () => {
  it("parses, and describes the same release and year as the plan directory", () => {
    const snap = loadFormularySnapshot();
    expect(snap).not.toBeNull();
    const dir = directoryRelease();
    expect(snap!.cmsRelease).toBe(dir.sourceRelease);
    expect(snap!.contractYear).toBe(dir.contractYear);
    expect(snap!.plans.length).toBe(listPayers().reduce((n, p) => n + p.planCount, 0));
    expect(snap!.formulary.length).toBeGreaterThan(0);
  });

  it("is what getCoverageAdapter() selects, so real data wins over sample and unconfigured", () => {
    expect(getCoverageAdapter().id).toBe("cms-part-d-formulary");
  });

  it("has a concept identity for every catalogued guide", () => {
    for (const slug of listGuideSlugs()) {
      const c = productConcepts(slug);
      expect(c, slug).not.toBeNull();
      expect(c!.exact.rxcui).toMatch(/^\d+$/);
    }
  });

  it("has every demo plan in the directory the picker shows, under the same key", () => {
    for (const plan of [AARP, HAMASPIK]) {
      const found = getPlan(plan.planKey);
      expect(found, plan.planKey).not.toBeNull();
      expect(found!.name).toBe(plan.planName);
    }
  });
});

describe("agrees with the pipeline on every demo scenario", () => {
  it.each(ORACLE)("$slug on $plan.planKey -> $state ($granularity)", async (o) => {
    const snap = loadFormularySnapshot()!;
    const lookup = lookupFormulary(snap, { ...o.plan, planYear: 2026 }, productConcepts(o.slug)!);
    expect(lookup.kind).toBe("listed");
    if (lookup.kind !== "listed") return;
    expect(lookup.granularity).toBe(o.granularity);
    expect(lookup.row.rxcui).toBe(o.rxcui);

    const r = await cmsFormularyAdapter(snap).check(req(o.slug, o.plan), o.slug);
    expect(r.state).toBe(o.state);
    expect(r.matchGranularity).toBe(o.granularity);
    expect(r.tier.value).toBe(o.tier);
    expect(r.priorAuthorization.value).toBe(o.pa);
    expect(r.stepTherapy.value).toBe(o.st);
    expect(r.quantityLimits.value).toBe(o.ql);
    expect(r.costEstimate).toBeNull();
    expect(r.isSample).toBe(false);
    // The answer names the exact plan checked, with identifiers.
    expect(r.scope.plan).toContain(o.plan.planKey.replace("medicare-partd-2026-", ""));
  });

  it("a brand-only listing and a generic-only listing are told apart in the headline", async () => {
    const snap = loadFormularySnapshot()!;
    const adapter = cmsFormularyAdapter(snap);
    const brand = await adapter.check(req(SINGULAIR, HAMASPIK), SINGULAIR);
    const generic = await adapter.check(req(SINGULAIR, AARP), SINGULAIR);
    expect(brand.headline).not.toMatch(/generic/i);
    expect(generic.headline).toMatch(/generic/i);
    expect(generic.caveats.join(" ")).toMatch(/brand-name product itself is not on this plan/i);
  });

  it("a plan name shared by 39 plans resolves by key, not by name", async () => {
    const snap = loadFormularySnapshot()!;
    const namesakes = snap.plans.filter((p) => p.planName === AARP.planName);
    expect(namesakes.length).toBeGreaterThan(1);
    const r = await cmsFormularyAdapter(snap).check(req(OZEMPIC, AARP), OZEMPIC);
    expect(r.scope.plan).toContain("S5820-034-000");
  });

  it("a year the release does not cover is refused", async () => {
    const snap = loadFormularySnapshot()!;
    const r = await cmsFormularyAdapter(snap).check({ ...req(OZEMPIC, AARP), planYear: 2025 }, OZEMPIC);
    expect(r.state).toBe("unable-to-verify");
    expect(r.headline).toContain("2026");
  });
});
