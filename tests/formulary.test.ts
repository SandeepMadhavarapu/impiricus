import { describe, it, expect } from "vitest";
import {
  lookupFormulary,
  describeQuantityLimit,
  describePlan,
  parsePlanKey,
  FormularySnapshotSchema,
  MATCH_THRESHOLD,
  type FormularySnapshot,
  type ProductConcepts,
} from "@/patient/lib/coverage/formulary";
import { cmsFormularyAdapter, checkCoverageSafely } from "@/patient/lib/coverage/adapters";
import { formatCost, isPositiveEvidence, type CoverageRequest } from "@/patient/lib/coverage/types";

const BRAND = "153892"; // montelukast 10 MG Oral Tablet [Singulair]
const GENERIC = "200224"; // montelukast 10 MG Oral Tablet
const OTHER_PRODUCT = "2398842"; // Ozempic — in the snapshot, NOT this product

const singulair: ProductConcepts = {
  exact: { rxcui: BRAND, name: "montelukast 10 MG Oral Tablet [Singulair]" },
  clinicalDrug: [{ rxcui: GENERIC, name: "montelukast 10 MG Oral Tablet" }],
};
const conceptsFor = (slug: string) => (slug === "singulair-montelukast-10mg-tablet" ? singulair : null);

const snapshot: FormularySnapshot = {
  schemaVersion: 1,
  cmsRelease: "2026-08",
  contractYear: 2026,
  sourceUrl: "https://data.cms.gov/sites/default/files/2026-08/example/2026_20260819.zip",
  retrievedAt: "2026-09-19T00:00:00.000Z",
  rxcuis: [BRAND, GENERIC, OTHER_PRODUCT],
  plans: [
    // Brand listed, no restrictions.
    {
      contractId: "S1234",
      planId: "001",
      segmentId: null,
      formularyId: "00025000",
      planName: "Example Rx Value Plan",
      organizationName: "Example Health",
    },
    // Brand listed, with restrictions.
    {
      contractId: "S9999",
      planId: "002",
      segmentId: null,
      formularyId: "00099000",
      planName: "Northstar Senior Rx Premier",
      organizationName: "Northstar",
    },
    // Generic listed, brand absent. Two plans share this NAME on purpose.
    {
      contractId: "S5820",
      planId: "034",
      segmentId: "000",
      formularyId: "00026000",
      planName: "Shared Name Rx (PDP)",
      organizationName: "BigCo",
    },
    // Same name, different formulary, lists ONLY an unrelated product.
    {
      contractId: "S5820",
      planId: "035",
      segmentId: "000",
      formularyId: "00026999",
      planName: "Shared Name Rx (PDP)",
      organizationName: "BigCo",
    },
  ],
  formulary: [
    { formularyId: "00025000", rxcui: BRAND, tier: 1, priorAuthorization: false, stepTherapy: false, quantityLimit: false, quantityLimitDescription: null },
    { formularyId: "00099000", rxcui: BRAND, tier: 3, priorAuthorization: true, stepTherapy: false, quantityLimit: true, quantityLimitDescription: "30 per 30 days" },
    { formularyId: "00026000", rxcui: GENERIC, tier: 1, priorAuthorization: false, stepTherapy: false, quantityLimit: true, quantityLimitDescription: "30 per 30 days" },
    // Another product's row on every formulary: must never satisfy a Singulair lookup.
    { formularyId: "00025000", rxcui: OTHER_PRODUCT, tier: 3, priorAuthorization: true, stepTherapy: false, quantityLimit: true, quantityLimitDescription: "3 per 28 days" },
    { formularyId: "00026000", rxcui: OTHER_PRODUCT, tier: 3, priorAuthorization: true, stepTherapy: false, quantityLimit: true, quantityLimitDescription: "3 per 28 days" },
    { formularyId: "00026999", rxcui: OTHER_PRODUCT, tier: 3, priorAuthorization: true, stepTherapy: false, quantityLimit: true, quantityLimitDescription: "3 per 28 days" },
  ],
};

const baseReq: CoverageRequest = {
  slug: "singulair-montelukast-10mg-tablet",
  insurer: "Example Health",
  planName: "Example Rx Value Plan",
  planYear: 2026,
  strength: "10 mg",
  dosageForm: "TABLET, FILM COATED",
  quantity: 30,
  daysSupply: 30,
  pharmacyType: "retail",
};
const byName = { insurer: baseReq.insurer, planName: baseReq.planName, planYear: 2026 };

const PRODUCT = "Singulair (montelukast sodium) 10 mg tablet, film coated";

describe("snapshot schema", () => {
  it("accepts a well-formed snapshot", () => {
    expect(FormularySnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("rejects a snapshot missing provenance", () => {
    const { sourceUrl: _drop, ...bad } = snapshot;
    expect(FormularySnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a snapshot that does not say which year it describes", () => {
    const { contractYear: _drop, ...bad } = snapshot;
    expect(FormularySnapshotSchema.safeParse(bad).success).toBe(false);
  });
});

describe("plan keys", () => {
  it("parses the directory's key format", () => {
    expect(parsePlanKey("medicare-partd-2026-S5820-034-000")).toEqual({
      year: 2026,
      contractId: "S5820",
      planId: "034",
      segmentId: "000",
    });
  });

  it.each(["", "S5820-034-000", "medicare-partd-S5820-034-000", "medicare-partd-2026-S5820-034", "../etc"])(
    "rejects %j",
    (key) => expect(parsePlanKey(key)).toBeNull()
  );

  it("describes the plan that was checked with its identifiers", () => {
    expect(describePlan(snapshot.plans[2]!)).toBe("BigCo: Shared Name Rx (PDP) (S5820-034-000)");
    expect(describePlan(snapshot.plans[0]!)).toBe("Example Health: Example Rx Value Plan (S1234-001-000)");
  });
});

describe("plan matching is conservative", () => {
  it("matches the plan the user named", () => {
    const r = lookupFormulary(snapshot, byName, singulair);
    expect(r.kind).toBe("listed");
  });

  /** Guessing at someone's plan is how a coverage tool starts lying. */
  it("refuses to guess when the plan name does not match", () => {
    const r = lookupFormulary(
      snapshot,
      { insurer: "Totally Different Insurer", planName: "Unrelated Gold PPO", planYear: 2026 },
      singulair
    );
    expect(r.kind).toBe("plan-not-matched");
  });

  it("distinguishes 'plan not matched' from 'drug not listed'", () => {
    const notListed = lookupFormulary({ ...snapshot, formulary: [] }, byName, singulair);
    expect(notListed.kind).toBe("drug-not-listed");

    const noPlan = lookupFormulary(
      snapshot,
      { insurer: "Nobody", planName: "Nothing At All Here", planYear: 2026 },
      singulair
    );
    expect(noPlan.kind).toBe("plan-not-matched");
  });

  it("reports no-snapshot when no data has been ingested", () => {
    expect(lookupFormulary(null, byName, singulair).kind).toBe("no-snapshot");
  });

  it("uses a threshold high enough to reject weak overlap", () => {
    expect(MATCH_THRESHOLD).toBeGreaterThanOrEqual(0.5);
  });

  /**
   * 39 plans in the real release share one name. An exact key must select
   * exactly that plan, and a key for a plan that is absent must NOT slide to
   * a namesake.
   */
  it("uses the exact plan key when one is supplied, ignoring the typed name", () => {
    const r = lookupFormulary(
      snapshot,
      { planKey: "medicare-partd-2026-S5820-034-000", insurer: "wrong", planName: "also wrong", planYear: 2026 },
      singulair
    );
    expect(r.kind).toBe("listed");
    if (r.kind === "listed") expect(r.plan.planId).toBe("034");
  });

  it("two plans with the same name give different answers when selected by key", () => {
    const a = lookupFormulary(snapshot, { planKey: "medicare-partd-2026-S5820-034-000", insurer: "BigCo", planName: "Shared Name Rx (PDP)", planYear: 2026 }, singulair);
    const b = lookupFormulary(snapshot, { planKey: "medicare-partd-2026-S5820-035-000", insurer: "BigCo", planName: "Shared Name Rx (PDP)", planYear: 2026 }, singulair);
    expect(a.kind).toBe("listed");
    expect(b.kind).toBe("drug-not-listed");
  });

  it("does not fall back to a name match when the keyed plan is absent", () => {
    const r = lookupFormulary(
      snapshot,
      { planKey: "medicare-partd-2026-S5820-099-000", insurer: "BigCo", planName: "Shared Name Rx (PDP)", planYear: 2026 },
      singulair
    );
    expect(r.kind).toBe("plan-not-matched");
  });
});

describe("year", () => {
  it("refuses to answer for a year the evidence does not describe", () => {
    const r = lookupFormulary(snapshot, { ...byName, planYear: 2025 }, singulair);
    expect(r).toEqual({ kind: "year-mismatch", requestedYear: 2025, coveredYear: 2026 });
  });

  it("refuses a plan key whose year disagrees with the evidence", () => {
    const r = lookupFormulary(
      snapshot,
      { planKey: "medicare-partd-2027-S5820-034-000", insurer: "BigCo", planName: "Shared Name Rx (PDP)", planYear: 2026 },
      singulair
    );
    expect(r).toEqual({ kind: "year-mismatch", requestedYear: 2027, coveredYear: 2026 });
  });
});

describe("product identity", () => {
  /** The bug this replaces: searching every product's RXCUIs at once. */
  it("never matches on another product's row", () => {
    const r = lookupFormulary(
      snapshot,
      { planKey: "medicare-partd-2026-S5820-035-000", insurer: "BigCo", planName: "Shared Name Rx (PDP)", planYear: 2026 },
      singulair
    );
    // 00026999 lists only OTHER_PRODUCT.
    expect(r.kind).toBe("drug-not-listed");
  });

  it("prefers the exact branded concept when present", () => {
    const r = lookupFormulary(snapshot, byName, singulair);
    expect(r.kind).toBe("listed");
    if (r.kind === "listed") {
      expect(r.granularity).toBe("exact-product");
      expect(r.row.rxcui).toBe(BRAND);
    }
  });

  it("reports a generic-only listing as clinical-drug, never as the brand", () => {
    const r = lookupFormulary(
      snapshot,
      { planKey: "medicare-partd-2026-S5820-034-000", insurer: "BigCo", planName: "Shared Name Rx (PDP)", planYear: 2026 },
      singulair
    );
    expect(r.kind).toBe("listed");
    if (r.kind === "listed") {
      expect(r.granularity).toBe("clinical-drug");
      expect(r.row.rxcui).toBe(GENERIC);
      expect(r.concept.name).toBe("montelukast 10 MG Oral Tablet");
    }
  });
});

describe("CMS adapter evidence states", () => {
  const adapter = cmsFormularyAdapter(snapshot, conceptsFor);

  it("reports a clean listing as formulary-listed, not member coverage", async () => {
    const r = await adapter.check(baseReq, PRODUCT);
    expect(r.state).toBe("formulary-listed");
    // The strongest claim a formulary document can support.
    expect(r.state).not.toBe("member-benefit-response");
    expect(r.formularyListing.value).toBe("yes");
    expect(r.tier.value).toBe("Tier 1");
    expect(r.matchGranularity).toBe("exact-product");
    expect(r.isSample).toBe(false);
  });

  it("echoes the plan that was actually checked, with identifiers", async () => {
    const r = await adapter.check(baseReq, PRODUCT);
    expect(r.scope.plan).toBe("Example Health: Example Rx Value Plan (S1234-001-000)");
  });

  it("reports utilisation management as restrictions-indicated", async () => {
    const r = await adapter.check(
      { ...baseReq, insurer: "Northstar", planName: "Northstar Senior Rx Premier" },
      PRODUCT
    );
    expect(r.state).toBe("restrictions-indicated");
    expect(r.priorAuthorization.value).toBe("yes");
    expect(r.quantityLimits.value).toBe("30 per 30 days");
  });

  it("says in the headline when only the generic is listed", async () => {
    const r = await adapter.check(
      { ...baseReq, planKey: "medicare-partd-2026-S5820-034-000", insurer: "BigCo", planName: "Shared Name Rx (PDP)" },
      PRODUCT
    );
    expect(r.state).toBe("restrictions-indicated");
    expect(r.matchGranularity).toBe("clinical-drug");
    expect(r.headline).toMatch(/generic/i);
    expect(r.headline).toContain("montelukast 10 MG Oral Tablet");
    expect(r.caveats.join(" ")).toMatch(/brand-name product itself is not on this plan/i);
  });

  it("a keyed plan that is absent is unable-to-verify and says the plan was not found", async () => {
    const r = await adapter.check(
      { ...baseReq, planKey: "medicare-partd-2026-S5820-099-000" },
      PRODUCT
    );
    expect(r.state).toBe("unable-to-verify");
    expect(r.headline).toMatch(/not in the CMS dataset/i);
  });

  it("a year the data does not cover is unable-to-verify, and says which year it does cover", async () => {
    const r = await adapter.check({ ...baseReq, planYear: 2025 }, PRODUCT);
    expect(r.state).toBe("unable-to-verify");
    expect(r.headline).toContain("2026");
    expect(r.headline).toContain("2025");
    expect(r.formularyListing.value).toBeNull();
  });

  it("a product with no concept identity is unable-to-verify, never a guess", async () => {
    const r = await adapter.check({ ...baseReq, slug: "unknown-thing" }, PRODUCT);
    expect(r.state).toBe("unable-to-verify");
    expect(r.headline).toMatch(/could not identify this product/i);
  });

  /** The single most important guarantee in this file. */
  it("NEVER produces a cost estimate from formulary data", async () => {
    for (const req of [
      baseReq,
      { ...baseReq, insurer: "Northstar", planName: "Northstar Senior Rx Premier" },
      { ...baseReq, insurer: "Nobody", planName: "No Such Plan" },
      { ...baseReq, planKey: "medicare-partd-2026-S5820-034-000" },
      { ...baseReq, planYear: 2025 },
    ]) {
      const r = await adapter.check(req, PRODUCT);
      expect(r.costEstimate).toBeNull();
      expect(formatCost(r.costEstimate)).toBe("Not available");
      expect(formatCost(r.costEstimate)).not.toBe("$0.00");
    }
  });

  it("always states that personal benefit was not checked", async () => {
    const r = await adapter.check(baseReq, PRODUCT);
    expect(r.caveats.join(" ")).toMatch(/not your personal benefit|eligibility, enrolment status/i);
  });

  it("an unmatched plan is unable-to-verify, never a negative result", async () => {
    const r = await adapter.check({ ...baseReq, insurer: "Nobody", planName: "No Such Plan" }, PRODUCT);
    expect(r.state).toBe("unable-to-verify");
    expect(isPositiveEvidence(r.state)).toBe(false);
    expect(r.formularyListing.value).toBeNull();
    expect(r.caveats.join(" ")).toMatch(/not a statement that the medication is uncovered/i);
  });

  it("a matched plan without the drug says not-listed, and says why that is not final", async () => {
    const empty = cmsFormularyAdapter({ ...snapshot, formulary: [] }, conceptsFor);
    const r = await empty.check(baseReq, PRODUCT);
    expect(r.state).toBe("not-listed-on-checked-formulary");
    expect(r.matchGranularity).toBeNull();
    expect(r.caveats.join(" ")).toMatch(/does not mean the medication is definitively not covered/i);
  });

  it("carries CMS provenance on every result", async () => {
    const r = await adapter.check(baseReq, PRODUCT);
    expect(r.sourceTimestamp).toContain("CMS Part D");
    expect(r.sourceTimestamp).toContain("2026-08");
    expect(r.adapter).toBe("cms-part-d-formulary");
  });

  it("leaves pharmacy restrictions unknown rather than inventing them", async () => {
    const r = await adapter.check(baseReq, PRODUCT);
    // CMS basic drugs file does not publish network restrictions.
    expect(r.pharmacyRestrictions.value).toBeNull();
  });

  it("still degrades to unable-to-verify if the adapter throws", async () => {
    const broken = { ...adapter, check: async () => { throw new Error("boom"); } };
    const r = await checkCoverageSafely(broken, baseReq, PRODUCT);
    expect(r.state).toBe("unable-to-verify");
    expect(r.costEstimate).toBeNull();
    expect(r.isSample).toBe(false);
  });
});

describe("quantity limit rendering", () => {
  it("describes a published limit", () => {
    expect(describeQuantityLimit(snapshot.formulary[1]!)).toBe("30 per 30 days");
  });

  it("says no limit was published rather than implying none exists", () => {
    expect(describeQuantityLimit(snapshot.formulary[0]!)).toMatch(/no limit published/i);
  });

  it("a limit flagged without figures still says a limit applies", () => {
    const flaggedOnly = { ...snapshot.formulary[1]!, quantityLimitDescription: null };
    expect(describeQuantityLimit(flaggedOnly)).toMatch(/limit applies/i);
    expect(describeQuantityLimit(flaggedOnly)).not.toBeNull();
  });
});
