import { describe, it, expect } from "vitest";
import {
  parseStrength,
  strengthsEqual,
  dosageFormCompatible,
} from "@/sources/lib/content/strength";
import {
  productPresentation,
  coverageRequestMatchesProduct,
  listGuides,
} from "@/sources/lib/content/catalogue";

/**
 * A denominator is not a strength.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * openFDA writes a solid oral dose as `<INGREDIENT> <amount>/<per>`, so
 * Singulair's stored strength is "MONTELUKAST SODIUM 10 mg/1". The "/1" counts
 * dosage units. The old guard searched a concatenation of every strength string
 * the product had, first by substring and then by whole number, so "1" - the
 * denominator - was accepted as the strength of a 10 mg tablet.
 *
 * ---------------------------------------------------------------------------
 * THE ORACLE
 * ---------------------------------------------------------------------------
 * Expected values are derived from validated product identity, not from the
 * comparator under test:
 *
 *   Singulair   10 mg, TABLET, FILM COATED, ORAL          (openFDA "10 mg/1")
 *   Toprol XL   50 mg, TABLET, EXTENDED RELEASE, ORAL
 *   Ozempic     1.34 mg per 1 mL, INJECTION, SOLUTION     (a CONCENTRATION;
 *               the pen holds 3 mL, which is container content, not strength)
 *
 * corroborated by the RxNorm names retrieved 2026-09-20:
 *   153892  montelukast 10 MG Oral Tablet [Singulair]
 *   866438  24 HR metoprolol succinate 50 MG Extended Release Oral Tablet [Toprol]
 *   2398842 3 ML semaglutide 1.34 MG/ML Pen Injector [Ozempic]
 */

const SINGULAIR = "singulair-montelukast-10mg-tablet";
const TOPROL = "toprol-xl-metoprolol-succinate-50mg-er-tablet";
const OZEMPIC = "ozempic-semaglutide-1_34mg-per-ml-injection";

describe("parsing a strength", () => {
  it("drops a unitless denominator, and records that it saw one", () => {
    const p = parseStrength("MONTELUKAST SODIUM 10 mg/1")!;
    expect(p.numerator).toMatchObject({ base: 10, dimension: "mass" });
    expect(p.denominator, "a /1 denominator must not become a quantity").toBeNull();
    expect(p.hadUnitlessDenominator).toBe(true);
  });

  it("keeps a denominator that carries a unit, because that is a concentration", () => {
    const p = parseStrength("1.34 mg/1 mL")!;
    expect(p.numerator).toMatchObject({ base: 1.34, dimension: "mass" });
    expect(p.denominator).toMatchObject({ base: 1, dimension: "volume" });
  });

  it.each([
    ["a bare number", "10"],
    ["a decimal with no unit", "1.34"],
    ["a unit with no number", "mg"],
    ["whitespace", "   "],
    ["empty", ""],
    ["zero", "0 mg"],
    ["negative", "-10 mg"],
    ["an unrecognised unit", "10 sprinkles"],
  ])("refuses %s", (_label, text) => {
    expect(parseStrength(text)).toBeNull();
  });

  it("never infers a missing unit", () => {
    // "10" could be 10 mg or 10 mcg. Guessing is how a thousandfold error
    // enters a medication record.
    expect(parseStrength("10")).toBeNull();
    expect(parseStrength("0.5")).toBeNull();
  });

  it("reads leading and trailing zeros as the same number", () => {
    expect(strengthsEqual(parseStrength("010 mg")!, parseStrength("10 mg")!)).toBe(true);
    expect(strengthsEqual(parseStrength("10.0 mg")!, parseStrength("10 mg")!)).toBe(true);
    expect(strengthsEqual(parseStrength("1.340 mg/mL")!, parseStrength("1.34 mg/1 mL")!)).toBe(true);
  });

  it("refuses a denominator it cannot parse rather than dropping it", () => {
    // Dropping it would silently turn a concentration into a dose.
    expect(parseStrength("1.34 mg/0 mL")).toBeNull();
  });
});

describe("unit equivalence is only within a dimension", () => {
  it("converts mass to mass", () => {
    expect(strengthsEqual(parseStrength("10 mg")!, parseStrength("10000 mcg")!)).toBe(true);
    expect(strengthsEqual(parseStrength("1 g")!, parseStrength("1000 mg")!)).toBe(true);
  });

  it("converts volume to volume", () => {
    expect(strengthsEqual(parseStrength("1 L")!, parseStrength("1000 mL")!)).toBe(true);
  });

  it("never converts mass to volume", () => {
    expect(strengthsEqual(parseStrength("10 mg")!, parseStrength("10 mL")!)).toBe(false);
  });

  it("treats a dose and a concentration as different claims", () => {
    expect(strengthsEqual(parseStrength("1.34 mg")!, parseStrength("1.34 mg/1 mL")!)).toBe(false);
  });

  it("compares concentrations as ratios", () => {
    expect(strengthsEqual(parseStrength("1.34 mg/1 mL")!, parseStrength("1340 mcg/1 mL")!)).toBe(true);
    expect(strengthsEqual(parseStrength("1.34 mg/1 mL")!, parseStrength("2.68 mg/2 mL")!)).toBe(true);
    expect(strengthsEqual(parseStrength("1.34 mg/1 mL")!, parseStrength("1.34 mg/2 mL")!)).toBe(false);
  });
});

describe("canonical product identity", () => {
  it.each([
    [SINGULAIR, 10, "mass", null, "TABLET, FILM COATED"],
    [TOPROL, 50, "mass", null, "TABLET, EXTENDED RELEASE"],
    [OZEMPIC, 1.34, "mass", 1, "INJECTION, SOLUTION"],
  ])("resolves %s", (slug, amount, dimension, denom, form) => {
    const p = productPresentation(slug as string)!;
    expect(p.strength).not.toBeNull();
    expect(p.strength!.numerator.base).toBeCloseTo(amount as number, 9);
    expect(p.strength!.numerator.dimension).toBe(dimension);
    if (denom === null) expect(p.strength!.denominator).toBeNull();
    else expect(p.strength!.denominator!.base).toBeCloseTo(denom as number, 9);
    expect(p.dosageForm).toBe(form);
  });

  it("returns null for a product the catalogue does not publish", () => {
    expect(productPresentation("not-a-real-slug")).toBeNull();
  });
});

describe("the denominator can no longer masquerade as a strength", () => {
  it.each(["1", "1 ", " 1", "01"])("refuses %s for the 10 mg tablet", (requested) => {
    const r = coverageRequestMatchesProduct(SINGULAIR, requested);
    expect(r.ok, `"${requested}" was accepted as a strength`).toBe(false);
  });

  it("refuses 1 mg, which is a real strength and the wrong one", () => {
    expect(coverageRequestMatchesProduct(SINGULAIR, "1 mg").ok).toBe(false);
  });
});

describe("the coverage request guard, per product", () => {
  it("accepts exactly what each page submits today", () => {
    // These are the values the page passes to CoverageSheet. A mismatch here
    // breaks the real flow, so this bounds the tightening.
    for (const [slug, strength, form] of [
      [SINGULAIR, "10 mg", "TABLET, FILM COATED"],
      [TOPROL, "50 mg", "TABLET, EXTENDED RELEASE"],
      [OZEMPIC, "1.34 mg/1 mL", "INJECTION, SOLUTION"],
    ] as const) {
      const r = coverageRequestMatchesProduct(slug, strength, form);
      expect(r.ok, `${slug} rejects its own submission: ${JSON.stringify(r)}`).toBe(true);
    }
  });

  it.each([
    [SINGULAIR, "1 mg"],
    [SINGULAIR, "5 mg"],
    [SINGULAIR, "4 mg"],
    [SINGULAIR, "100 mg"],
    [TOPROL, "25 mg"],
    [TOPROL, "50 mcg"],
    [OZEMPIC, "1.34 mg"],
    [OZEMPIC, "3 mL"],
    [OZEMPIC, "2.68 mg/1 mL"],
  ])("refuses %s at %s", (slug, strength) => {
    expect(coverageRequestMatchesProduct(slug as string, strength as string).ok).toBe(false);
  });

  it("accepts a valid equivalent unit", () => {
    expect(coverageRequestMatchesProduct(SINGULAIR, "10000 mcg").ok).toBe(true);
    expect(coverageRequestMatchesProduct(TOPROL, "0.05 g").ok).toBe(true);
  });

  it.each([
    ["excessively long", "9".repeat(400) + " mg"],
    ["malformed", "mg 10"],
    ["a range", "5-10"],
    ["punctuation", "///"],
  ])("refuses %s input", (_label, strength) => {
    expect(coverageRequestMatchesProduct(SINGULAIR, strength).ok).toBe(false);
  });
});

describe("dosage form and release characteristics", () => {
  it("rejects an extended-release request against an immediate-release product", () => {
    const r = coverageRequestMatchesProduct(SINGULAIR, "10 mg", "TABLET, EXTENDED RELEASE");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("dosage-form-differs");
  });

  it("rejects an outright different form", () => {
    for (const form of ["CAPSULE", "INJECTION, SOLUTION", "SOLUTION", "GRANULE"]) {
      expect(
        coverageRequestMatchesProduct(SINGULAIR, "10 mg", form).ok,
        `${form} was accepted for a film-coated tablet`
      ).toBe(false);
    }
  });

  it("allows a vaguer form, which is under-specified rather than wrong", () => {
    expect(coverageRequestMatchesProduct(TOPROL, "50 mg", "tablet").ok).toBe(true);
    expect(coverageRequestMatchesProduct(SINGULAIR, "10 mg", "tablet").ok).toBe(true);
  });

  it("compares forms case- and punctuation-insensitively", () => {
    expect(dosageFormCompatible("tablet, film coated", "TABLET, FILM COATED")).toBe(true);
    expect(dosageFormCompatible("TABLET FILM COATED", "TABLET, FILM COATED")).toBe(true);
    expect(dosageFormCompatible("", "TABLET")).toBe(false);
  });

  it("does not check a form the caller did not send", () => {
    // Omitting it is not the same as contradicting it.
    expect(coverageRequestMatchesProduct(SINGULAIR, "10 mg").ok).toBe(true);
  });
});

describe("every published product is guarded", () => {
  it("has a parseable canonical strength, so the guard can never be vacuous", () => {
    for (const guide of listGuides()) {
      const p = productPresentation(guide.slug);
      expect(p, `${guide.slug} has no presentation`).not.toBeNull();
      expect(p!.strength, `${guide.slug} has no parseable strength`).not.toBeNull();
    }
  });

  it("refuses every other product's strength", () => {
    const own: Record<string, string> = {
      [SINGULAIR]: "10 mg",
      [TOPROL]: "50 mg",
      [OZEMPIC]: "1.34 mg/1 mL",
    };
    for (const [slug, strength] of Object.entries(own)) {
      for (const [otherSlug, otherStrength] of Object.entries(own)) {
        if (slug === otherSlug) continue;
        expect(
          coverageRequestMatchesProduct(slug, otherStrength).ok,
          `${slug} accepted ${otherSlug}'s strength ${otherStrength}`
        ).toBe(false);
      }
      expect(coverageRequestMatchesProduct(slug, strength).ok).toBe(true);
    }
  });
});
