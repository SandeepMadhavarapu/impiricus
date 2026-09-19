import { describe, it, expect } from "vitest";
import {
  lookupFormulary,
  describeQuantityLimit,
  FormularySnapshotSchema,
  MATCH_THRESHOLD,
  type FormularySnapshot,
} from "@/patient/lib/coverage/formulary";
import { cmsFormularyAdapter, checkCoverageSafely } from "@/patient/lib/coverage/adapters";
import { formatCost, isPositiveEvidence, type CoverageRequest } from "@/patient/lib/coverage/types";

const RXCUI = "153892"; // montelukast 10 MG Oral Tablet [Singulair]

const snapshot: FormularySnapshot = {
  schemaVersion: 1,
  cmsRelease: "2026-08",
  sourceUrl: "https://data.cms.gov/sites/default/files/2026-08/example/2026_20260819.zip",
  retrievedAt: "2026-09-19T00:00:00.000Z",
  rxcuis: [RXCUI],
  plans: [
    {
      contractId: "S1234",
      planId: "001",
      segmentId: null,
      formularyId: "00025000",
      planName: "Example Rx Value Plan",
      organizationName: "Example Health",
    },
    {
      contractId: "S9999",
      planId: "002",
      segmentId: null,
      formularyId: "00099000",
      planName: "Northstar Senior Rx Premier",
      organizationName: "Northstar",
    },
  ],
  formulary: [
    {
      formularyId: "00025000",
      rxcui: RXCUI,
      tier: 1,
      priorAuthorization: false,
      stepTherapy: false,
      quantityLimit: false,
      quantityLimitDescription: null,
    },
    {
      formularyId: "00099000",
      rxcui: RXCUI,
      tier: 3,
      priorAuthorization: true,
      stepTherapy: false,
      quantityLimit: true,
      quantityLimitDescription: "30 per 30 days",
    },
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

const PRODUCT = "Singulair (montelukast sodium) 10 mg tablet, film coated";

describe("snapshot schema", () => {
  it("accepts a well-formed snapshot", () => {
    expect(FormularySnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("rejects a snapshot missing provenance", () => {
    const { sourceUrl: _drop, ...bad } = snapshot;
    expect(FormularySnapshotSchema.safeParse(bad).success).toBe(false);
  });
});

describe("plan matching is conservative", () => {
  it("matches the plan the user named", () => {
    const r = lookupFormulary(snapshot, "Example Health", "Example Rx Value Plan", [RXCUI]);
    expect(r.kind).toBe("listed");
  });

  /** Guessing at someone's plan is how a coverage tool starts lying. */
  it("refuses to guess when the plan name does not match", () => {
    const r = lookupFormulary(snapshot, "Totally Different Insurer", "Unrelated Gold PPO", [RXCUI]);
    expect(r.kind).toBe("plan-not-matched");
  });

  it("distinguishes 'plan not matched' from 'drug not listed'", () => {
    const notListed = lookupFormulary(
      { ...snapshot, formulary: [] },
      "Example Health",
      "Example Rx Value Plan",
      [RXCUI]
    );
    expect(notListed.kind).toBe("drug-not-listed");

    const noPlan = lookupFormulary(snapshot, "Nobody", "Nothing At All Here", [RXCUI]);
    expect(noPlan.kind).toBe("plan-not-matched");
  });

  it("reports no-snapshot when no data has been ingested", () => {
    expect(lookupFormulary(null, "Example Health", "Example Rx Value Plan", [RXCUI]).kind).toBe(
      "no-snapshot"
    );
  });

  it("uses a threshold high enough to reject weak overlap", () => {
    expect(MATCH_THRESHOLD).toBeGreaterThanOrEqual(0.5);
  });
});

describe("CMS adapter evidence states", () => {
  const adapter = cmsFormularyAdapter(snapshot);

  it("reports a clean listing as formulary-listed, not member coverage", async () => {
    const r = await adapter.check(baseReq, PRODUCT);
    expect(r.state).toBe("formulary-listed");
    // The strongest claim a formulary document can support.
    expect(r.state).not.toBe("member-benefit-response");
    expect(r.formularyListing.value).toBe("yes");
    expect(r.tier.value).toBe("Tier 1");
    expect(r.isSample).toBe(false);
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

  /** The single most important guarantee in this file. */
  it("NEVER produces a cost estimate from formulary data", async () => {
    for (const req of [
      baseReq,
      { ...baseReq, insurer: "Northstar", planName: "Northstar Senior Rx Premier" },
      { ...baseReq, insurer: "Nobody", planName: "No Such Plan" },
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
    const empty = cmsFormularyAdapter({ ...snapshot, formulary: [] });
    const r = await empty.check(baseReq, PRODUCT);
    expect(r.state).toBe("not-listed-on-checked-formulary");
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
});
