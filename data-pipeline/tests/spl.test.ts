import { describe, it, expect } from "vitest";
import { parseSpl, walkSections, countTables } from "@pipeline/normalize/spl.js";
import { SYNTHETIC_SPL_XML } from "./fixtures/synthetic-spl.js";

const spl = parseSpl(SYNTHETIC_SPL_XML);

describe("document metadata", () => {
  it("reads set id, version and effective date", () => {
    expect(spl.setId).toBe("00000000-0000-0000-0000-000000000000");
    expect(spl.splVersion).toBe("3");
    expect(spl.effectiveDate).toBe("2026-01-01");
  });

  it("reads the labeler", () => {
    expect(spl.labeler).toBe("Synthetic Labs, Inc.");
  });

  /** Version must stay a string: "03" and 3 are not interchangeable. */
  it("keeps the version as a string", () => {
    expect(typeof spl.splVersion).toBe("string");
  });
});

describe("multiple products in one document", () => {
  it("extracts every product, not just the first", () => {
    expect(spl.products).toHaveLength(2);
    expect(spl.products.map((p) => p.ndc)).toEqual(["99999-001", "99999-002"]);
  });

  it("keeps each product's own form and strength", () => {
    const tablet = spl.products.find((p) => p.ndc === "99999-001")!;
    const granule = spl.products.find((p) => p.ndc === "99999-002")!;
    expect(tablet.formDisplay).toBe("TABLET, FILM COATED");
    expect(tablet.activeIngredients[0]!.numeratorValue).toBe("10");
    expect(granule.formDisplay).toBe("GRANULE");
    expect(granule.activeIngredients[0]!.numeratorValue).toBe("4");
  });

  it("captures package NDCs per product", () => {
    expect(spl.products[0]!.packageNdcs).toEqual(["99999-001-30"]);
    expect(spl.products[1]!.packageNdcs).toEqual(["99999-002-30"]);
  });

  it("reads the route from the outer product node", () => {
    expect(spl.products[0]!.route).toEqual(["ORAL"]);
  });
});

describe("salt versus active moiety", () => {
  it("keeps both the labeled ingredient and the active moiety", () => {
    const ai = spl.products[0]!.activeIngredients[0]!;
    expect(ai.name).toBe("TESTOLOL SUCCINATE");
    expect(ai.activeMoiety).toBe("TESTOLOL");
  });

  it("excludes inactive ingredients", () => {
    const names = spl.products[0]!.activeIngredients.map((i) => i.name);
    expect(names).not.toContain("LACTOSE");
  });
});

describe("section hierarchy is preserved", () => {
  it("nests subsections under their parent rather than flattening", () => {
    const dosage = spl.sections.find((s) => s.title?.startsWith("2 DOSAGE"))!;
    expect(dosage.subsections).toHaveLength(1);
    expect(dosage.subsections[0]!.title).toBe("2.1 Renal Impairment");
  });

  it("extracts printed section numbers without inventing them", () => {
    const dosage = spl.sections.find((s) => s.title?.startsWith("2 DOSAGE"))!;
    expect(dosage.printedNumber).toBe("2");
    expect(dosage.subsections[0]!.printedNumber).toBe("2.1");
  });

  it("walks the full tree", () => {
    expect(walkSections(spl.sections).length).toBeGreaterThan(spl.sections.length);
  });
});

describe("tables keep their structure", () => {
  /**
   * The central requirement. Flattening this table to prose would lose which
   * dose belongs to which age group — the error that turns a paediatric row
   * into an adult instruction.
   */
  it("preserves headers and rows with the population column intact", () => {
    const dosage = spl.sections.find((s) => s.title?.startsWith("2 DOSAGE"))!;
    expect(dosage.tables).toHaveLength(1);
    const table = dosage.tables[0]!;
    expect(table.caption).toBe("Table 1: Recommended Dosage by Age");
    expect(table.headers[0]).toEqual(["Age", "Dose"]);
    expect(table.rows).toEqual([
      ["Adults 15 years and older", "one 10 mg tablet"],
      ["Children 2 to 5 years", "one 4 mg granule packet"],
    ]);
  });

  it("does not leak table cell text into the paragraph stream", () => {
    const dosage = spl.sections.find((s) => s.title?.startsWith("2 DOSAGE"))!;
    expect(dosage.paragraphs.join(" ")).toContain("Administer once daily");
    expect(dosage.paragraphs.join(" ")).not.toContain("one 4 mg granule packet");
  });

  it("counts tables across the tree", () => {
    expect(countTables(spl.sections)).toBe(1);
  });
});

describe("patient-directed labeling is separated", () => {
  it("routes the Medication Guide to patientLabeling", () => {
    expect(spl.patientLabeling).toHaveLength(1);
    expect(spl.patientLabeling[0]!.loincCode).toBe("42231-1");
    expect(spl.patientLabeling[0]!.audience).toBe("patient");
  });

  it("keeps professional sections out of patientLabeling", () => {
    expect(spl.sections.every((s) => s.audience !== "patient")).toBe(true);
  });
});

describe("scoping", () => {
  /**
   * An empty appliesToProducts means the document did not scope the section.
   * It must NOT be read as "applies to every product".
   */
  it("records unscoped sections as an empty list", () => {
    const dosage = spl.sections.find((s) => s.title?.startsWith("2 DOSAGE"))!;
    expect(dosage.appliesToProducts).toEqual([]);
  });
});

describe("idempotency", () => {
  it("produces identical output when parsed twice", () => {
    expect(JSON.stringify(parseSpl(SYNTHETIC_SPL_XML))).toBe(
      JSON.stringify(parseSpl(SYNTHETIC_SPL_XML))
    );
  });
});

describe("malformed input", () => {
  it("raises rather than returning an empty-but-plausible document", () => {
    expect(() => parseSpl("<nope/>")).toThrow(/no <document> root/i);
  });
});
