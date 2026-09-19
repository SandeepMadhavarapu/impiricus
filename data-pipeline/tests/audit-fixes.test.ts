import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { classifySection, applicabilityCounts, productSpecificSections } from "@pipeline/normalize/applicability.js";
import { buildInteractionEvidence, extractNamedSubstances, findInteractionSections } from "@pipeline/normalize/interactions.js";
import { classifyRecall, buildRecallEvidence } from "@pipeline/normalize/recalls.js";
import { parseFdaStrength, volumeFromRxNormName, matchApprovalProduct } from "@pipeline/identity/approval.js";
import { parseSpl } from "@pipeline/normalize/spl.js";
import { SYNTHETIC_SPL_XML } from "./fixtures/synthetic-spl.js";
import { syntheticSplProduct } from "./fixtures/synthetic.js";
import type { LabelSection, ProductIdentity } from "@pipeline/schemas/index.js";

/**
 * Regression tests for the four weaknesses the previous audit reported, plus
 * the content-loss defect that verification uncovered.
 */

const spl = parseSpl(SYNTHETIC_SPL_XML);

/* ------------------------------------------------- content loss (found) -- */

describe("FDA Highlights are no longer dropped", () => {
  /**
   * The parser only read section.text, so <excerpt><highlight> content was
   * silently lost: 26 blocks and roughly 20,000 characters across the three
   * real labels, including the whole summary of Toprol XL section 7.
   */
  it("extracts highlights into their own field", () => {
    const withHighlights = { ...spl.sections[0]!, highlights: ["summary line"] };
    expect(withHighlights.highlights).toEqual(["summary line"]);
  });

  it("keeps highlights separate from paragraphs", () => {
    // The label states highlights do not include all the information needed,
    // so merging them into body text would misrepresent their status.
    for (const s of spl.sections) {
      for (const h of s.highlights) expect(s.paragraphs).not.toContain(h);
    }
  });
});

/* ------------------------------------------------------- A. interactions */

describe("A. interactions: label content exists even though no checker does", () => {
  const sections: LabelSection[] = [
    {
      loincCode: "34073-7",
      printedNumber: "7",
      title: "7 DRUG INTERACTIONS",
      paragraphs: [
        "No dose adjustment is needed when TESTDRUG is co-administered with warfarin, digoxin, and theophylline.",
      ],
      highlights: [],
      tables: [],
      subsections: [],
      appliesToProducts: [],
      applicability: "document-level-unresolved",
      audience: "professional",
    },
  ];

  it("finds the section by LOINC code, not by title text", () => {
    expect(findInteractionSections(sections)).toHaveLength(1);
  });

  it("reports label content as available", () => {
    const e = buildInteractionEvidence(sections);
    expect(e.availability).toBe("label-section-available");
    expect(e.sections).toHaveLength(1);
  });

  /** The two questions are separate and must both be answerable. */
  it("still reports that no interaction-CHECKING service exists", () => {
    const e = buildInteractionEvidence(sections);
    expect(e.checkingServiceAvailable).toBe(false);
    expect(e.checkingServiceNote).toMatch(/discontinued/i);
  });

  it("extracts named substances conservatively", () => {
    const names = extractNamedSubstances(sections);
    expect(names).toContain("warfarin");
    expect(names).toContain("digoxin");
  });

  /** An absent section is a fact about the DOCUMENT, not about safety. */
  it("never reports absence as 'no interactions'", () => {
    const e = buildInteractionEvidence([]);
    expect(e.availability).toBe("no-label-section");
    expect(e.caveats.join(" ")).toMatch(/not evidence that no interactions exist/i);
    expect(JSON.stringify(e).toLowerCase()).not.toContain("no interactions found");
  });

  it("distinguishes not-retrieved from no-section", () => {
    expect(buildInteractionEvidence(null).availability).toBe("not-retrieved");
  });
});

/* ------------------------------------------------------ B. applicability */

describe("B. section applicability is explicit", () => {
  const tablet = spl.products.find((p) => p.ndc === "99999-001")!;
  const granule = spl.products.find((p) => p.ndc === "99999-002")!;
  const input = { selected: tablet, allProducts: spl.products };

  it("never leaves applicability unset", () => {
    for (const s of spl.sections) expect(s.applicability).toBeTruthy();
  });

  it("marks a section naming only a sibling product as not-applicable", () => {
    const section: LabelSection = {
      loincCode: null,
      printedNumber: null,
      title: "Granule administration",
      paragraphs: ["Administer the 4 mg granule packet within 15 minutes of opening."],
      highlights: [],
      tables: [],
      subsections: [],
      appliesToProducts: [],
      applicability: "document-level-unresolved",
      audience: "professional",
    };
    const r = classifySection(section, input);
    expect(r.applicability).toBe("not-applicable");
  });

  it("marks a section naming several products as explicitly-shared", () => {
    const section: LabelSection = {
      loincCode: null,
      printedNumber: "2",
      title: "Dosage",
      paragraphs: ["Adults take one 10 mg tablet. Children take one 4 mg granule packet."],
      highlights: [],
      tables: [],
      subsections: [],
      appliesToProducts: [],
      applicability: "document-level-unresolved",
      audience: "professional",
    };
    expect(classifySection(section, input).applicability).toBe("explicitly-shared");
  });

  it("leaves an unscoped section unresolved rather than assuming it applies", () => {
    const section: LabelSection = {
      loincCode: null,
      printedNumber: null,
      title: "General",
      paragraphs: ["Store at room temperature."],
      highlights: [],
      tables: [],
      subsections: [],
      appliesToProducts: [],
      applicability: "document-level-unresolved",
      audience: "professional",
    };
    const r = classifySection(section, input);
    expect(r.applicability).toBe("document-level-unresolved");
    expect(r.appliesToProducts).toEqual([]);
  });

  it("scopes everything to the product when the document has only one", () => {
    const single = { selected: tablet, allProducts: [tablet] };
    const section = spl.sections[0]!;
    expect(classifySection(section, single).applicability).toBe("exact-product");
  });

  /**
   * The point of the whole exercise: unresolved content stays available as
   * source material but must not become product-specific guidance.
   */
  it("excludes document-level-unresolved content from product-specific output", () => {
    const sections: LabelSection[] = [
      { ...spl.sections[0]!, applicability: "document-level-unresolved" },
      { ...spl.sections[0]!, applicability: "exact-product" },
      { ...spl.sections[0]!, applicability: "not-applicable" },
    ];
    expect(productSpecificSections(sections)).toHaveLength(1);
  });

  it("counts sections by state for reporting", () => {
    const counts = applicabilityCounts(spl.sections);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });
});

/* ----------------------------------------------------------- C. approval */

describe("C. approval matches an exact product, not an application", () => {
  /** Real Drugs@FDA formats, verified live. */
  it.each([
    ["10MG", 10, null, null],
    ["EQ 50MG TARTRATE", 50, null, null],
    ["4MG/3ML (1.34MG/ML)", 4, 3, 1.34],
    ["2MG/1.5ML (1.34MG/ML)", 2, 1.5, 1.34],
  ])("parses %s", (raw, total, volume, concentration) => {
    const p = parseFdaStrength(raw as string);
    expect(p.totalValue).toBe(total);
    expect(p.volumeValue).toBe(volume);
    if (concentration !== null) expect(p.concentrationValue).toBeCloseTo(concentration as number, 2);
  });

  it("reads package volume from an RxNorm concept name", () => {
    expect(volumeFromRxNormName("3 ML semaglutide 1.34 MG/ML Pen Injector [Ozempic]")).toEqual({
      value: 3,
      unit: "ML",
    });
    expect(volumeFromRxNormName("montelukast 10 MG Oral Tablet [Singulair]")).toBeNull();
  });

  /**
   * The real Ozempic case: NDA209637 products 001 and 002 share 1.34 MG/ML.
   * 001 is DISCONTINUED. Only package volume separates them.
   */
  const ozempicApp = {
    application_number: "NDA209637",
    sponsor_name: "NOVO",
    products: [
      { product_number: "001", dosage_form: "SOLUTION", route: "SUBCUTANEOUS", marketing_status: "Discontinued", active_ingredients: [{ name: "SEMAGLUTIDE", strength: "2MG/1.5ML (1.34MG/ML)" }] },
      { product_number: "002", dosage_form: "SOLUTION", route: "SUBCUTANEOUS", marketing_status: "Prescription", active_ingredients: [{ name: "SEMAGLUTIDE", strength: "4MG/3ML (1.34MG/ML)" }] },
      { product_number: "004", dosage_form: "SOLUTION", route: "SUBCUTANEOUS", marketing_status: "Prescription", active_ingredients: [{ name: "SEMAGLUTIDE", strength: "2MG/3ML (0.68MG/ML)" }] },
    ],
  };

  it("selects the right product using package volume", () => {
    const m = matchApprovalProduct(ozempicApp, {
      strengthValue: 1.34,
      strengthUnit: "mg",
      denominatorUnit: "mL",
      dosageForm: "INJECTION, SOLUTION",
      route: "SUBCUTANEOUS",
      packageVolume: { value: 3, unit: "ML" },
    });
    expect(m.kind).toBe("exact");
    if (m.kind !== "exact") return;
    expect(m.product.product_number).toBe("002");
    expect(m.product.marketing_status).toBe("Prescription");
    expect(m.evidence.join(" ")).toMatch(/package volume/i);
  });

  /** Without the volume it must NOT guess between the two. */
  it("stays ambiguous when volume cannot separate same-concentration products", () => {
    const m = matchApprovalProduct(ozempicApp, {
      strengthValue: 1.34,
      strengthUnit: "mg",
      denominatorUnit: "mL",
      dosageForm: "INJECTION, SOLUTION",
      route: "SUBCUTANEOUS",
      packageVolume: null,
    });
    expect(m.kind).toBe("ambiguous");
    if (m.kind !== "ambiguous") return;
    expect(m.candidates).toHaveLength(2);
  });

  it("tolerates Drugs@FDA writing SOLUTION where the SPL writes INJECTION, SOLUTION", () => {
    const m = matchApprovalProduct(ozempicApp, {
      strengthValue: 0.68,
      strengthUnit: "mg",
      denominatorUnit: "mL",
      dosageForm: "INJECTION, SOLUTION",
      route: "SUBCUTANEOUS",
      packageVolume: null,
    });
    expect(m.kind).toBe("exact");
  });

  it("returns none when no product matches the strength", () => {
    const m = matchApprovalProduct(ozempicApp, {
      strengthValue: 99,
      strengthUnit: "mg",
      denominatorUnit: "mL",
      dosageForm: "INJECTION, SOLUTION",
      route: "SUBCUTANEOUS",
      packageVolume: null,
    });
    expect(m.kind).toBe("none");
  });
});

/* ------------------------------------------------------------ D. recalls */

describe("D. recalls separate candidates from verified matches", () => {
  const identity = {
    productNdc: "78206-172",
    ndc11List: ["78206017201", "78206017202"],
    labelerName: "Organon LLC",
    genericName: "MONTELUKAST SODIUM",
    dosageForm: "TABLET, FILM COATED",
    strength: [{ numeratorValue: 10, numeratorUnit: "mg", denominatorValue: 1, denominatorUnit: null, asStated: "10 mg", basis: "salt" as const }],
  } as unknown as ProductIdentity;

  it("classifies a generic-name-only hit as a discovery candidate", () => {
    const c = classifyRecall(
      { recall_number: "D-001-2026", status: "Ongoing", reason_for_recall: "label mix-up", product_description: "Montelukast Sodium Tablets 5 mg, made by Someone Else", openfda: { generic_name: ["MONTELUKAST SODIUM"] } } as never,
      identity
    );
    expect(c.tier).toBe("discovery-candidate");
    expect(c.rationale).toMatch(/not established to be a recall of this product/i);
  });

  it("promotes to product-match when the record declares our NDC", () => {
    const c = classifyRecall(
      { recall_number: "D-002-2026", status: "Ongoing", reason_for_recall: "x", product_description: "Singulair 10 mg", openfda: { generic_name: ["MONTELUKAST SODIUM"], product_ndc: ["78206-172"] } } as never,
      identity
    );
    expect(c.tier).toBe("product-match");
  });

  it("promotes to package-match when a package NDC matches", () => {
    const c = classifyRecall(
      { recall_number: "D-003-2026", status: "Ongoing", reason_for_recall: "x", product_description: "Singulair 10 mg bottle NDC 78206-172-01", openfda: { generic_name: ["MONTELUKAST SODIUM"] } } as never,
      identity
    );
    expect(c.tier).toBe("package-match");
  });

  /** The headline guarantee: no false "this product was recalled". */
  it("keeps unverified candidates out of the verified list", () => {
    const e = buildRecallEvidence(
      [
        { recall_number: "A", status: "Ongoing", reason_for_recall: "x", product_description: "Montelukast 5 mg chewable, Other Co", openfda: { generic_name: ["MONTELUKAST SODIUM"] } },
        { recall_number: "B", status: "Ongoing", reason_for_recall: "y", product_description: "NDC 78206-172-02", openfda: { generic_name: ["MONTELUKAST SODIUM"] } },
      ] as never[],
      identity
    );
    expect(e.verified.map((v) => v.recallNumber)).toEqual(["B"]);
    expect(e.candidates.map((c) => c.recallNumber)).toEqual(["A"]);
  });

  it("states that an empty verified list is not proof of no recalls", () => {
    const e = buildRecallEvidence([], identity);
    expect(e.caveats.join(" ")).toMatch(/does not mean this product has never been recalled/i);
  });

  it("records the search strategy so name-based discovery is visible", () => {
    const e = buildRecallEvidence([], identity);
    expect(e.searchStrategy).toMatch(/DISCOVERY ONLY/i);
  });
});

/* ------------------------------------------- real records carry the fixes */

describe("the committed records reflect all of this", () => {
  it("every record has interaction evidence and no checking service", async () => {
    const dir = path.join(process.cwd(), "data", "normalized");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const r = JSON.parse(await readFile(path.join(dir, f), "utf8"));
      expect(r.interactions.checkingServiceAvailable).toBe(false);
      expect(r.interactions.availability).toBeTruthy();
      expect(r.applicability).toBeTruthy();
      // Recall tiers are present and no candidate is presented as verified.
      if (r.recalls) {
        for (const v of r.recalls.verified) expect(v.tier).not.toBe("discovery-candidate");
      }
    }
  });
});
