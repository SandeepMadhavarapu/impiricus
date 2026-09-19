import { describe, it, expect } from "vitest";
import {
  CoverageRequestSchema,
  formatCost,
  isPositiveEvidence,
  EVIDENCE_LABELS,
  type CoverageRequest,
  type CoverageResult,
} from "@/patient/lib/coverage/types";
import {
  unconfiguredAdapter,
  sampleAdapter,
  checkCoverageSafely,
  type CoverageAdapter,
} from "@/patient/lib/coverage/adapters";

const baseReq: CoverageRequest = {
  slug: "singulair-montelukast-10mg-tablet",
  insurer: "Example Health",
  planName: "Example PPO 2000",
  planYear: 2026,
  state: "CA",
  strength: "10 mg",
  dosageForm: "TABLET, FILM COATED",
  quantity: 30,
  daysSupply: 30,
  pharmacyType: "retail",
};

const PRODUCT = "Singulair (montelukast sodium) 10 mg tablet, film coated";

/** Every field that could be mistaken for a positive coverage signal. */
function assertNoFabricatedFields(r: CoverageResult) {
  expect(r.costEstimate).toBeNull();
  expect(formatCost(r.costEstimate)).toBe("Not available");
  for (const field of [
    r.formularyListing,
    r.tier,
    r.priorAuthorization,
    r.stepTherapy,
    r.quantityLimits,
    r.pharmacyRestrictions,
  ]) {
    expect(field.value).toBeNull();
    expect(field.source).toBeNull();
  }
}

describe("coverage request validation", () => {
  it("requires the fields that actually change the answer", () => {
    const partial = { slug: baseReq.slug, insurer: "Example Health" };
    expect(CoverageRequestSchema.safeParse(partial).success).toBe(false);
  });

  it("rejects a nonsense quantity or days supply", () => {
    expect(CoverageRequestSchema.safeParse({ ...baseReq, quantity: 0 }).success).toBe(false);
    expect(CoverageRequestSchema.safeParse({ ...baseReq, daysSupply: -1 }).success).toBe(false);
    expect(CoverageRequestSchema.safeParse({ ...baseReq, daysSupply: 4000 }).success).toBe(false);
  });

  it("rejects an implausible plan year rather than guessing", () => {
    expect(CoverageRequestSchema.safeParse({ ...baseReq, planYear: 1999 }).success).toBe(false);
  });

  it("normalises the state code", () => {
    const parsed = CoverageRequestSchema.parse({ ...baseReq, state: "ca" });
    expect(parsed.state).toBe("CA");
  });

  it("does not accept member identifiers: they are never collected here", () => {
    const parsed = CoverageRequestSchema.parse({
      ...baseReq,
      memberId: "123456789",
      dateOfBirth: "1980-01-01",
      ssn: "000-00-0000",
    } as unknown as CoverageRequest);
    expect(parsed).not.toHaveProperty("memberId");
    expect(parsed).not.toHaveProperty("dateOfBirth");
    expect(parsed).not.toHaveProperty("ssn");
  });
});

describe("unconfigured adapter", () => {
  it("returns unable-to-verify and fabricates nothing", async () => {
    const r = await unconfiguredAdapter.check(baseReq, PRODUCT);
    expect(r.state).toBe("unable-to-verify");
    expect(r.isSample).toBe(false);
    assertNoFabricatedFields(r);
  });

  it("does not imply the drug is uncovered", async () => {
    const r = await unconfiguredAdapter.check(baseReq, PRODUCT);
    const text = (r.headline + " " + r.caveats.join(" ")).toLowerCase();
    expect(text).toContain("not a statement that the medication is uncovered");
    expect(isPositiveEvidence(r.state)).toBe(false);
  });

  it("still gives the user real next steps", async () => {
    const r = await unconfiguredAdapter.check(baseReq, PRODUCT);
    expect(r.nextSteps.length).toBeGreaterThanOrEqual(3);
    expect(r.nextSteps.some((s) => /test claim/i.test(s.label))).toBe(true);
    // Any link offered must be a real, official destination.
    for (const step of r.nextSteps) {
      if (step.href) expect(step.href).toMatch(/^https:\/\/(www\.)?medicare\.gov\//);
    }
  });

  it("echoes back the exact fill the answer applies to", async () => {
    const r = await unconfiguredAdapter.check(baseReq, PRODUCT);
    expect(r.scope.strength).toBe("10 mg");
    expect(r.scope.quantity).toBe(30);
    expect(r.scope.daysSupply).toBe(30);
    expect(r.scope.planYear).toBe(2026);
    expect(r.scope.plan).toContain("Example PPO 2000");
  });
});

describe("sample mode", () => {
  it("always flags itself as sample data", async () => {
    for (const req of [
      baseReq,
      { ...baseReq, daysSupply: 90, quantity: 90 },
      { ...baseReq, dosageForm: "TABLET, CHEWABLE" },
    ]) {
      const r = await sampleAdapter.check(req, PRODUCT);
      expect(r.isSample).toBe(true);
      expect(r.caveats.join(" ").toLowerCase()).toContain("sample data");
    }
  });

  it("never invents a copay, even when the drug is listed", async () => {
    const r = await sampleAdapter.check(baseReq, PRODUCT);
    expect(r.state).toBe("formulary-listed");
    // A formulary listing does not establish a price.
    expect(r.costEstimate).toBeNull();
    expect(formatCost(r.costEstimate)).toBe("Not available");
    expect(formatCost(r.costEstimate)).not.toBe("$0.00");
  });

  it("never presents a formulary listing as verified member coverage", async () => {
    const r = await sampleAdapter.check(baseReq, PRODUCT);
    expect(r.state).not.toBe("member-benefit-response");
    expect(r.caveats.join(" ")).toMatch(/not confirmation of your personal coverage/i);
  });

  it("treats 'not listed' as inconclusive, not as 'not covered'", async () => {
    const r = await sampleAdapter.check({ ...baseReq, dosageForm: "TABLET, CHEWABLE" }, PRODUCT);
    expect(r.state).toBe("not-listed-on-checked-formulary");
    expect(r.caveats.join(" ")).toMatch(/does not mean the medication is definitively not covered/i);
    expect(EVIDENCE_LABELS[r.state]).toMatch(/formulary we checked/i);
  });

  it("lets quantity and days' supply change the answer", async () => {
    const thirty = await sampleAdapter.check(baseReq, PRODUCT);
    const ninety = await sampleAdapter.check({ ...baseReq, quantity: 90, daysSupply: 90 }, PRODUCT);
    expect(thirty.state).not.toBe(ninety.state);
    expect(ninety.state).toBe("restrictions-indicated");
    expect(ninety.quantityLimits.value).toBeTruthy();
  });

  it("carries the plan year into the result rather than assuming the current year", async () => {
    const r = await sampleAdapter.check({ ...baseReq, planYear: 2024 }, PRODUCT);
    expect(r.scope.planYear).toBe(2024);
    expect(r.effectiveDates.value).toContain("2024");
  });
});

describe("failure handling", () => {
  const throwingAdapter: CoverageAdapter = {
    id: "throwing",
    displayName: "Throws",
    async check() {
      throw new Error("upstream exploded");
    },
  };

  const hangingAdapter: CoverageAdapter = {
    id: "hanging",
    displayName: "Hangs",
    check() {
      return new Promise(() => {});
    },
  };

  /**
   * A cheerful adapter that returns a positive result is fine — but a BROKEN
   * one must never produce one. These two tests are the core guarantee.
   */
  it("turns a thrown error into unable-to-verify, never a positive result", async () => {
    const r = await checkCoverageSafely(throwingAdapter, baseReq, PRODUCT);
    expect(r.state).toBe("unable-to-verify");
    expect(isPositiveEvidence(r.state)).toBe(false);
    assertNoFabricatedFields(r);
    expect(r.headline).toMatch(/failed/i);
  });

  it("turns a timeout into unable-to-verify, never a positive result", async () => {
    const r = await checkCoverageSafely(hangingAdapter, baseReq, PRODUCT, 50);
    expect(r.state).toBe("unable-to-verify");
    expect(isPositiveEvidence(r.state)).toBe(false);
    assertNoFabricatedFields(r);
    expect(r.headline).toMatch(/timed out/i);
  });

  it("a failed lookup never silently becomes sample data", async () => {
    const r = await checkCoverageSafely(throwingAdapter, baseReq, PRODUCT);
    expect(r.isSample).toBe(false);
  });

  it("still provides next steps when everything failed", async () => {
    const r = await checkCoverageSafely(hangingAdapter, baseReq, PRODUCT, 50);
    expect(r.nextSteps.length).toBeGreaterThan(0);
  });
});

describe("cost formatting", () => {
  it("never renders a missing estimate as zero", () => {
    expect(formatCost(null)).toBe("Not available");
  });

  it("renders a real estimate", () => {
    expect(
      formatCost({ amountCents: 1250, currency: "USD", basis: "30-day retail", source: "test" })
    ).toBe("$12.50");
  });

  it("renders a genuine zero copay as zero, not as missing", () => {
    expect(
      formatCost({ amountCents: 0, currency: "USD", basis: "30-day retail", source: "test" })
    ).toBe("$0.00");
  });
});

describe("evidence state labels", () => {
  it("has a label for every state and none of them says plain 'covered'", () => {
    for (const [state, label] of Object.entries(EVIDENCE_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
      expect(label.toLowerCase()).not.toBe("covered");
      expect(state.length).toBeGreaterThan(0);
    }
  });
});
