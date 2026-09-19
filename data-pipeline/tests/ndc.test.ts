import { describe, it, expect } from "vitest";
import {
  toNdc11,
  ndcEquivalent,
  productNdcFromPackage,
  formatNdc11,
} from "@pipeline/identity/ndc.js";

/**
 * NDC conversion. The headline requirement is that an ambiguous input is
 * REFUSED rather than silently resolved to one of three possible codes.
 */

describe("unambiguous conversion from hyphenated NDCs", () => {
  it.each([
    ["78206-172-01", "78206017201", "5-3-2"], // verified live: Singulair
    ["70842-111-02", "70842011102", "5-3-2"], // verified live: Toprol XL
    ["0169-4130-13", "00169413013", "4-4-2"], // verified live: Ozempic
  ])("converts %s to %s via %s", (input, expected, layout) => {
    const r = toNdc11(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ndc11).toBe(expected);
    expect(r.layout).toBe(layout);
    expect(r.derivation).toBeTruthy();
  });

  it("passes an 11-digit code through unchanged", () => {
    const r = toNdc11("78206017201");
    expect(r.ok && r.ndc11).toBe("78206017201");
  });

  it("handles the 5-4-1 layout by padding the package segment", () => {
    const r = toNdc11("12345-6789-1");
    expect(r.ok && r.ndc11).toBe("12345678901");
  });
});

describe("ambiguous input is refused, never guessed", () => {
  /**
   * This is the important test. "7820617201" could be 4-4-2, 5-3-2 or 5-4-1,
   * producing three different 11-digit codes. Picking one invents data.
   */
  it("refuses a 10-digit NDC with no hyphens", () => {
    const r = toNdc11("7820617201");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("ambiguous-layout");
    expect(r.possibilities.length).toBeGreaterThan(1);
    expect(r.detail).toMatch(/does not encode its segment layout/i);
  });

  it("lists every code the ambiguous input could mean", () => {
    const r = toNdc11("1234567890");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.possibilities).toContain("01234567890"); // 4-4-2
    expect(r.possibilities).toContain("12345067890"); // 5-3-2
    expect(r.possibilities).toContain("12345678900"); // 5-4-1
  });

  it.each(["", "abc", "12-34", "78206-172-01-99", "78206-abc-01"])(
    "rejects malformed input %j",
    (bad) => {
      const r = toNdc11(bad);
      expect(r.ok).toBe(false);
    }
  );
});

describe("equivalence comparison", () => {
  it("matches the same package across hyphenated and 11-digit forms", () => {
    const r = ndcEquivalent("78206-172-01", "78206017201");
    expect(r.comparable).toBe(true);
    expect(r.equal).toBe(true);
  });

  it("reports different packages as different", () => {
    const r = ndcEquivalent("78206-172-01", "78206-172-02");
    expect(r.comparable).toBe(true);
    expect(r.equal).toBe(false);
  });

  /** An ambiguous side must never produce a match. */
  it("refuses to compare when either side is ambiguous", () => {
    const r = ndcEquivalent("7820617201", "78206017201");
    expect(r.comparable).toBe(false);
    expect(r.equal).toBe(false);
    expect(r.detail).toMatch(/cannot compare/i);
  });
});

describe("helpers", () => {
  it("extracts the product NDC from a package NDC", () => {
    expect(productNdcFromPackage("78206-172-01")).toBe("78206-172");
    expect(productNdcFromPackage("78206017201")).toBeNull();
  });

  it("formats an 11-digit code as 5-4-2", () => {
    expect(formatNdc11("78206017201")).toBe("78206-0172-01");
    expect(formatNdc11("782060172")).toBeNull();
  });
});
