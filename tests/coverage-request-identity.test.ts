import { describe, it, expect } from "vitest";
import {
  lookupFormulary,
  type FormularySnapshot,
  type ProductConcepts,
} from "@/patient/lib/coverage/formulary";
import { cmsFormularyAdapter } from "@/patient/lib/coverage/adapters";
import { parseStrength, strengthsEqual, dosageFormsEqual, formatStrength } from "@/sources/lib/content/strength";
import type { CoverageRequest } from "@/patient/lib/coverage/types";

/**
 * Two questions a coverage answer has to get right before its tier means
 * anything: WHICH PRODUCT was asked about, and WHOSE PLAN was checked.
 *
 * Both were previously unenforced. `strength` and `dosageForm` arrived from
 * the client, were echoed into the answer's scope and its next steps, and were
 * never compared with the product - so "1", "mg" and "10 MG" all returned the
 * real product's tier. And a typed plan name was resolved by token overlap to
 * whichever plan happened to sort first, so "Humana Gold Plus" produced a
 * dual-eligible special needs plan's tier.
 */

const BRAND = "153892"; // montelukast 10 MG Oral Tablet [Singulair]
const GENERIC = "200224";
const SINGULAIR = "singulair-montelukast-10mg-tablet";

/** The real catalogue entry, so the adapter's own guide lookup resolves. */
const REAL_STRENGTH = "10 mg";
const REAL_FORM = "tablet, film coated";

const concepts: ProductConcepts = {
  exact: { rxcui: BRAND, name: "montelukast 10 MG Oral Tablet [Singulair]" },
  clinicalDrug: [{ rxcui: GENERIC, name: "montelukast 10 MG Oral Tablet" }],
};
const conceptsFor = (slug: string) => (slug === SINGULAIR ? concepts : null);

function plan(contractId: string, planId: string, formularyId: string, planName: string, org: string) {
  return { contractId, planId, segmentId: "000", formularyId, planName, organizationName: org };
}

const snapshot: FormularySnapshot = {
  schemaVersion: 1,
  cmsRelease: "2026-08",
  contractYear: 2026,
  sourceUrl: "https://data.cms.gov/sites/default/files/2026-08/example/2026_20260819.zip",
  retrievedAt: "2026-09-19T00:00:00.000Z",
  rxcuis: [BRAND, GENERIC],
  plans: [
    // Three plans in one family. A typed family name fits all three equally.
    plan("H0028", "007", "00030000", "Gold Plus SNP-DE (HMO D-SNP)", "Vantage"),
    plan("H0028", "012", "00030000", "Gold Plus Regional (HMO)", "Vantage"),
    plan("H0028", "020", "00030000", "Gold Plus Choice (PPO)", "Vantage"),
    // A plan whose name nothing else resembles.
    plan("S7777", "001", "00030000", "Solitary Rx Distinctive", "Onlyco"),
  ],
  formulary: [
    { formularyId: "00030000", rxcui: BRAND, tier: 2, priorAuthorization: false, stepTherapy: false, quantityLimit: false, quantityLimitDescription: null },
  ],
};

function req(over: Partial<CoverageRequest> = {}): CoverageRequest {
  return {
    slug: SINGULAIR,
    // Exact identity by default, so a test about STRENGTH is not also a test
    // about plan ambiguity. The plan-identity tests below opt out explicitly.
    planKey: "medicare-partd-2026-H0028-007-000",
    insurer: "Vantage",
    planName: "Gold Plus SNP-DE (HMO D-SNP)",
    planYear: 2026,
    strength: REAL_STRENGTH,
    dosageForm: REAL_FORM,
    quantity: 30,
    daysSupply: 30,
    pharmacyType: "unspecified",
    ...over,
  };
}

const check = (over: Partial<CoverageRequest> = {}) =>
  cmsFormularyAdapter(snapshot, conceptsFor).check(req(over), "Singulair");

/* =========================================================== the strength == */

describe("parsing a written strength", () => {
  it("reads a plain dose", () => {
    expect(parseStrength("10 mg")).toEqual({ amount: 10, unit: "mg" });
  });

  it("reads the same dose however it is spaced or cased", () => {
    for (const written of ["10 mg", "10mg", "10 MG", "  10   Mg  "]) {
      expect(strengthsEqual(written, "10 mg"), written).toBe(true);
    }
  });

  /**
   * openFDA writes strength as amount/per. A denominator with NO unit is
   * bookkeeping - "10 mg/1" means one tablet holds 10 mg - and the authored
   * record for this product is literally "MONTELUKAST SODIUM 10 mg/1".
   */
  it("drops a unitless denominator and ignores the ingredient name", () => {
    expect(strengthsEqual("MONTELUKAST SODIUM 10 mg/1", "10 mg")).toBe(true);
  });

  /** A denominator WITH a unit is a concentration, and is kept. */
  it("keeps a concentration whole", () => {
    expect(parseStrength("1.34 mg/1 mL")).toEqual({
      amount: 1.34,
      unit: "mg",
      per: { amount: 1, unit: "ml" },
    });
    expect(strengthsEqual("1.34 mg/1 mL", "1.34 mg/mL")).toBe(true);
  });

  /**
   * The failure this module exists to prevent: 10 mg in a tablet and 10 mg in
   * every millilitre are different quantities of medicine.
   */
  it("never equates a dose with a concentration", () => {
    expect(strengthsEqual("10 mg", "10 mg/1 mL")).toBe(false);
    expect(strengthsEqual("1.34 mg/1 mL", "1.34 mg")).toBe(false);
  });

  it("rejects a signed value rather than dropping the sign", () => {
    // Without this the digits parse and "-10 mg" becomes a confident "10 mg".
    expect(parseStrength("-10 mg")).toBeNull();
    expect(strengthsEqual("-10 mg", "10 mg")).toBe(false);
  });

  it.each(["", "   ", "1", "10", "mg", "n/a", "tablet", "--"])(
    "reads %o as no strength at all",
    (raw) => {
      expect(parseStrength(raw)).toBeNull();
    }
  );

  /**
   * Two unparseable values are two absences of a strength, not agreement that
   * the strength matches.
   */
  it("does not call two unparseable values equal, even when identical", () => {
    expect(strengthsEqual("n/a", "n/a")).toBe(false);
    expect(strengthsEqual("mg", "mg")).toBe(false);
  });

  it("renders a strength for a sentence without its ingredient or noise", () => {
    expect(formatStrength("MONTELUKAST SODIUM 10 mg/1")).toBe("10 mg");
    expect(formatStrength("1.34 mg/1 mL")).toBe("1.34 mg/ml");
    expect(formatStrength("n/a")).toBeNull();
  });
});

describe("dose forms", () => {
  it("ignores case and punctuation", () => {
    expect(dosageFormsEqual("TABLET, FILM COATED", "tablet, film coated")).toBe(true);
  });

  it("does not treat one form as another", () => {
    // A plan can list the extended-release form and not the plain tablet.
    expect(dosageFormsEqual("TABLET", "TABLET, EXTENDED RELEASE")).toBe(false);
    expect(dosageFormsEqual("INJECTION, SOLUTION", "TABLET")).toBe(false);
  });

  it("is not a match when nothing was stated", () => {
    expect(dosageFormsEqual("", "TABLET")).toBe(false);
  });
});

/* ============================================ the gate, through the adapter */

describe("a request must be about the product it names", () => {
  it("answers when the strength and form are the product's own", async () => {
    const r = await check();
    expect(r.state).toBe("formulary-listed");
    expect(r.tier.value).toBe("Tier 2");
  });

  /**
   * The reported defect. Each of these returned the real product's tier.
   */
  it.each(["1", "10", "mg", "n/a", "", "5 mg", "10 mcg", "-10 mg"])(
    "refuses to answer when the strength is %o",
    async (strength) => {
      const r = await check({ strength });
      expect(r.state).toBe("unable-to-verify");
      expect(r.headline).toMatch(/strength/i);
      // Nothing about the plan's actual row may leak through the refusal.
      expect(r.tier.value).toBeNull();
      expect(r.formularyListing.value).toBeNull();
    }
  );

  it("accepts the strength however the source happens to write it", async () => {
    for (const strength of ["10 mg", "10mg", "10 MG", "MONTELUKAST SODIUM 10 mg/1"]) {
      const r = await check({ strength });
      expect(r.state, strength).toBe("formulary-listed");
    }
  });

  it("refuses when the form is not this product's form", async () => {
    const r = await check({ dosageForm: "injection, solution" });
    expect(r.state).toBe("unable-to-verify");
    expect(r.headline).toMatch(/form/i);
    expect(r.tier.value).toBeNull();
  });

  it("names the product's real strength rather than the submitted one", async () => {
    const r = await check({ strength: "1" });
    // The refusal quotes what was asked AND what this page is about, so the
    // reader can see which of the two is wrong.
    expect(r.caveats.join(" ")).toContain("10 mg");
    expect(r.caveats.join(" ")).toContain('"1"');
  });
});

/* ================================================== whose plan was checked */

describe("a typed plan name is not a plan identity", () => {
  /**
   * Token overlap scores every "Gold Plus" plan identically, so the previous
   * code returned whichever came first and reported its tier as the reader's.
   */
  it("refuses when the typed name fits several plans equally", async () => {
    const r = await check({ planKey: undefined, planName: "Gold Plus" });
    expect(r.state).toBe("unable-to-verify");
    expect(r.headline).toMatch(/more than one plan/i);
    expect(r.tier.value).toBeNull();
  });

  it("names the plans it could not choose between", async () => {
    const r = await check({ planKey: undefined, planName: "Gold Plus" });
    const said = r.caveats.join(" ");
    expect(said).toContain("SNP-DE");
    expect(said).toContain("Regional");
    expect(said).toContain("Choice");
  });

  it("reports ambiguity at the lookup, distinct from no match at all", () => {
    const ambiguous = lookupFormulary(
      snapshot,
      { insurer: "Vantage", planName: "Gold Plus", planYear: 2026 },
      concepts
    );
    expect(ambiguous.kind).toBe("plan-ambiguous");

    const missing = lookupFormulary(
      snapshot,
      { insurer: "Nobody", planName: "Nonexistent Plan", planYear: 2026 },
      concepts
    );
    expect(missing.kind).toBe("plan-not-matched");
  });

  it("answers when a typed name fits exactly one plan, and says it was inferred", async () => {
    const r = await check({ planKey: undefined, insurer: "Onlyco", planName: "Solitary Rx Distinctive" });
    expect(r.state).toBe("formulary-listed");
    expect(r.caveats.join(" ")).toMatch(/matched from the name typed/i);
  });

  it("makes no such caveat when the plan was chosen from the list", async () => {
    const r = await check({ planKey: "medicare-partd-2026-H0028-007-000" });
    expect(r.state).toBe("formulary-listed");
    expect(r.caveats.join(" ")).not.toMatch(/matched from the name typed/i);
  });

  it("checks the plan that was chosen, not one that merely resembles it", async () => {
    // The key names the SNP-DE plan; the typed name says something else.
    const r = await check({
      planKey: "medicare-partd-2026-H0028-012-000",
      insurer: "Vantage",
      planName: "Gold Plus SNP-DE (HMO D-SNP)",
    });
    expect(r.scope.plan).toContain("H0028-012");
    expect(r.scope.plan).toContain("Regional");
  });
});
