import { describe, it, expect } from "vitest";
import { lookupCoverage, resolvePlan, type LookupRequest } from "@pipeline/insurance/lookup.js";
import { parseFormularyFile, parsePlanFile, parsePipeDelimited } from "@pipeline/sources/cmsPartD.js";
import { parseCentralDirectory } from "@pipeline/sources/zipRange.js";
import type { PartDSnapshot } from "@pipeline/insurance/snapshot.js";

/**
 * Insurance tests. Fixture-driven; no network.
 *
 * The snapshot below is SYNTHETIC but mirrors the shape of the real CMS data,
 * including the specific traps found in it: three plans sharing one name, a
 * brand concept listed on only one formulary, and utilisation management.
 */

const SNAPSHOT: PartDSnapshot = {
  schemaVersion: 1,
  sourceId: "cms-part-d-monthly-formulary",
  release: "2026-08",
  sourceUrl: "https://data.cms.gov/sites/default/files/2026-08/example/2026_20260819.zip",
  modified: "2026-08-26",
  contractYear: "2026",
  retrievedAt: "2026-09-19T00:00:00.000Z",
  bytesFetched: 9_227_000,
  archiveBytes: 2_294_444_179,
  memberHashes: { "basic drugs formulary file.zip": "a".repeat(64) },
  rxcuisFiltered: ["153892", "200224", "2398842"],
  plans: [
    { contractId: "S5820", planId: "034", segmentId: "000", organizationName: "UHC", planName: "AARP Medicare Rx Preferred", formularyId: "00026000", premium: "40.00", deductible: "590" },
    { contractId: "S5820", planId: "035", segmentId: "000", organizationName: "UHC", planName: "AARP Medicare Rx Preferred", formularyId: "00026000", premium: "40.00", deductible: "590" },
    { contractId: "S5820", planId: "036", segmentId: "000", organizationName: "UHC", planName: "AARP Medicare Rx Preferred", formularyId: "00026000", premium: "40.00", deductible: "590" },
    { contractId: "H0034", planId: "001", segmentId: "000", organizationName: "Hamaspik", planName: "Hamaspik Medicare Select", formularyId: "00026303", premium: "0.00", deductible: "0" },
  ],
  formulary: [
    // Brand Singulair: only on the Hamaspik formulary.
    { formularyId: "00026303", formularyVersion: "1", contractYear: "2026", rxcui: "153892", tierLevelValue: 1, quantityLimitYn: false, quantityLimitAmount: null, quantityLimitDays: null, priorAuthorizationYn: false, stepTherapyYn: false },
    // Generic montelukast: on both.
    { formularyId: "00026303", formularyVersion: "1", contractYear: "2026", rxcui: "200224", tierLevelValue: 1, quantityLimitYn: false, quantityLimitAmount: null, quantityLimitDays: null, priorAuthorizationYn: false, stepTherapyYn: false },
    { formularyId: "00026000", formularyVersion: "22", contractYear: "2026", rxcui: "200224", tierLevelValue: 2, quantityLimitYn: false, quantityLimitAmount: null, quantityLimitDays: null, priorAuthorizationYn: false, stepTherapyYn: true },
    // Ozempic exact product, with UM.
    { formularyId: "00026000", formularyVersion: "22", contractYear: "2026", rxcui: "2398842", tierLevelValue: 3, quantityLimitYn: true, quantityLimitAmount: "3", quantityLimitDays: "28", priorAuthorizationYn: true, stepTherapyYn: false },
  ],
  costs: [
    { contractId: "S5820", planId: "034", segmentId: "000", coverageLevel: "1", tier: 3, daysSupply: "30", costTypePref: "2", costAmtPref: "0.25" },
  ],
  excluded: [],
};

const OZEMPIC: LookupRequest = {
  productKey: "ozempic",
  exactRxcui: "2398842",
  relatedRxcuis: [{ rxcui: "2398841", granularity: "clinical-drug", name: "generic pen" }],
  planYear: 2026,
  contractId: "S5820",
  planId: "034",
  segmentId: "000",
};

const SINGULAIR: LookupRequest = {
  productKey: "singulair",
  exactRxcui: "153892",
  relatedRxcuis: [{ rxcui: "200224", granularity: "clinical-drug", name: "montelukast 10 MG tablet" }],
  planYear: 2026,
  contractId: "S5820",
  planId: "034",
  segmentId: "000",
};

describe("plan identity", () => {
  it("resolves on contract + plan + segment", () => {
    const r = resolvePlan(SNAPSHOT, OZEMPIC);
    expect(r.state).toBe("resolved");
    expect(r.plan?.formularyId).toBe("00026000");
  });

  /** An insurer or plan NAME never identifies a plan. */
  it("refuses to resolve from a plan name, returning candidates instead", () => {
    const r = resolvePlan(SNAPSHOT, { ...OZEMPIC, contractId: undefined, planId: undefined, planNameQuery: "AARP Medicare Rx Preferred" });
    expect(r.state).toBe("ambiguous");
    expect(r.plan).toBeNull();
    expect(r.candidates.length).toBe(3);
    expect(r.missingDisambiguators).toContain("contractId");
  });

  it("reports not-found for a plan absent from the release", () => {
    expect(resolvePlan(SNAPSHOT, { ...OZEMPIC, contractId: "S9999", planId: "999" }).state).toBe("not-found");
  });

  it("keeps identifiers as strings so leading zeros survive", () => {
    const r = resolvePlan(SNAPSHOT, OZEMPIC);
    expect(r.plan?.planId).toBe("034");
    expect(r.plan?.segmentId).toBe("000");
  });
});

describe("coverage states", () => {
  it("reports conditional when utilisation management applies", () => {
    const r = lookupCoverage(SNAPSHOT, OZEMPIC, []);
    expect(r.state).toBe("conditional");
    expect(r.restrictions.some((x) => /prior authorisation/i.test(x))).toBe(true);
    expect(r.restrictions.some((x) => /3 per 28 days/.test(x))).toBe(true);
  });

  /** PA required is NOT approval. */
  it("never describes prior authorisation as approved", () => {
    const r = lookupCoverage(SNAPSHOT, OZEMPIC, []);
    expect(r.restrictions.join(" ")).toMatch(/It is not an approval/i);
    expect(r.headline.toLowerCase()).not.toContain("approved");
  });

  it("reports listed when nothing restricts it", () => {
    const r = lookupCoverage(SNAPSHOT, { ...SINGULAIR, contractId: "H0034", planId: "001" }, []);
    expect(r.state).toBe("listed");
  });

  /** "Not found" must never be phrased as "not covered". */
  it("says not-found-in-checked-source, not 'not covered'", () => {
    const r = lookupCoverage(
      SNAPSHOT,
      { ...OZEMPIC, contractId: "H0034", planId: "001" },
      []
    );
    expect(r.state).toBe("not-found-in-checked-source");
    expect(r.headline).toMatch(/not the same as 'not covered'/i);
  });

  it("reports ambiguous-plan and checks nothing when the plan is unresolved", () => {
    const r = lookupCoverage(SNAPSHOT, { ...OZEMPIC, contractId: undefined, planId: undefined, planNameQuery: "AARP" }, []);
    expect(r.state).toBe("ambiguous-plan");
    expect(r.found).toHaveLength(0);
    expect(r.unknown.join(" ")).toMatch(/not checked because the plan is not identified/i);
  });

  it("reports stale-source for a different plan year rather than applying it", () => {
    const r = lookupCoverage(SNAPSHOT, { ...OZEMPIC, planYear: 2025 }, []);
    expect(r.state).toBe("stale-source");
    expect(r.freshness.yearMismatch).toBe(true);
  });

  it("treats an explicit exclusion differently from absence", () => {
    const excluded: PartDSnapshot = {
      ...SNAPSHOT,
      excluded: [{ formularyId: "00026000", rxcui: "2398842" }],
    };
    const r = lookupCoverage(excluded, OZEMPIC, []);
    expect(r.state).toBe("explicitly-excluded");
  });
});

describe("brand versus generic", () => {
  /**
   * The real case: on formulary 00026000 only the generic clinical-drug concept
   * is listed. That is NOT a listing for branded Singulair.
   */
  it("does not treat a generic listing as a brand listing", () => {
    const r = lookupCoverage(SNAPSHOT, SINGULAIR, []);
    expect(r.found.length).toBeGreaterThan(0);
    expect(r.found.every((f) => f.isExactProductMatch === false)).toBe(true);
    expect(r.unknown.join(" ")).toMatch(/No EXACT product match/i);
  });

  it("records an exact product match when the brand concept really is listed", () => {
    const r = lookupCoverage(SNAPSHOT, { ...SINGULAIR, contractId: "H0034", planId: "001" }, []);
    expect(r.found.some((f) => f.isExactProductMatch)).toBe(true);
  });

  it("labels every match with its granularity", () => {
    const r = lookupCoverage(SNAPSHOT, SINGULAIR, []);
    for (const f of r.found) expect(["exact-product", "clinical-drug", "ingredient"]).toContain(f.granularity);
  });
});

describe("costs and member benefit", () => {
  /** A tier is not a dollar amount. */
  it("tags every cost figure with its basis", () => {
    const r = lookupCoverage(SNAPSHOT, OZEMPIC, []);
    for (const f of r.found) {
      for (const c of f.costSharing) {
        expect(c.basis).toBe("published-plan-cost-sharing-rule");
        expect(c.caveat).toMatch(/not a price for any individual/i);
      }
    }
  });

  it("never claims member benefit was verified", () => {
    for (const req of [OZEMPIC, SINGULAIR]) {
      const r = lookupCoverage(SNAPSHOT, req, []);
      expect(r.memberBenefitVerified).toBe(false);
      expect(r.memberBenefitNote).toMatch(/no authorised/i);
    }
  });

  it("states that listing is not a payment guarantee", () => {
    const r = lookupCoverage(SNAPSHOT, OZEMPIC, []);
    expect(r.caveats.join(" ")).toMatch(/not a guarantee of payment/i);
  });

  it("requires no patient identifiers anywhere in the request", () => {
    const keys = Object.keys(OZEMPIC).join(" ").toLowerCase();
    for (const forbidden of ["member", "patient", "dob", "ssn", "name", "diagnosis"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("quantity limit units", () => {
  it("preserves the amount and the DAYS period, not 'per month'", () => {
    const r = lookupCoverage(SNAPSHOT, OZEMPIC, []);
    const ql = r.found[0]!.policy.quantityLimit;
    expect(ql.amount).toBe("3");
    expect(ql.days).toBe("28");
    expect(ql.asStated).toBe("3 per 28 days");
    expect(ql.asStated).not.toMatch(/month/i);
  });
});

describe("CMS file parsing", () => {
  const formularyText = [
    "FORMULARY_ID|FORMULARY_VERSION|CONTRACT_YEAR|RXCUI|NDC|TIER_LEVEL_VALUE|QUANTITY_LIMIT_YN|QUANTITY_LIMIT_AMOUNT|QUANTITY_LIMIT_DAYS|PRIOR_AUTHORIZATION_YN|STEP_THERAPY_YN",
    "00026000|22|2026|2398842||3|Y|3|28|Y|N",
    "00026000|22|2026|999999||1|N|||N|N",
  ].join("\n");

  it("filters to the requested RXCUIs", () => {
    const rows = parseFormularyFile(formularyText, new Set(["2398842"]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rxcui).toBe("2398842");
  });

  it("parses Y/N flags and keeps limit units", () => {
    const row = parseFormularyFile(formularyText, new Set(["2398842"]))[0]!;
    expect(row.priorAuthorizationYn).toBe(true);
    expect(row.stepTherapyYn).toBe(false);
    expect(row.quantityLimitAmount).toBe("3");
    expect(row.quantityLimitDays).toBe("28");
  });

  it("raises on schema drift rather than guessing columns", () => {
    expect(() => parseFormularyFile("WRONG|HEADERS\na|b", new Set(["1"]))).toThrow(/missing FORMULARY_ID or RXCUI/i);
  });

  it("keeps plan identifiers as strings", () => {
    const planText = [
      "CONTRACT_ID|PLAN_ID|SEGMENT_ID|CONTRACT_NAME|PLAN_NAME|FORMULARY_ID|PREMIUM|DEDUCTIBLE",
      "S5820|034|000|UHC|AARP Medicare Rx Preferred|00026000|40.00|590",
    ].join("\n");
    const rows = parsePlanFile(planText);
    expect(rows[0]!.planId).toBe("034");
    expect(rows[0]!.segmentId).toBe("000");
    expect(rows[0]!.formularyId).toBe("00026000");
  });

  it("handles an empty file without inventing rows", () => {
    expect(parsePipeDelimited("").rows).toHaveLength(0);
  });
});

describe("zip central directory parsing", () => {
  it("returns nothing for a buffer with no central directory signature", () => {
    expect(parseCentralDirectory(Buffer.alloc(64))).toHaveLength(0);
  });
});
