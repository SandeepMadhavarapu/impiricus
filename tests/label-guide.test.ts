import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  listGuides,
  getGuide,
  listGuideSlugs,
  guideProductName,
} from "@/sources/lib/content/catalogue";
import {
  patientSections,
  labelScopeNote,
  parseLabelExport,
} from "@/sources/lib/content/label";
import MedicationPage from "@/app/medications/[slug]/page";

const AUTHORED = "singulair-montelukast-10mg-tablet";
const LABEL_ONLY = "toprol-xl-metoprolol-succinate-50mg-er-tablet";
const OZEMPIC = "ozempic-semaglutide-1_34mg-per-ml-injection";

async function render(slug: string) {
  return renderToStaticMarkup(await MedicationPage({ params: Promise.resolve({ slug }) }));
}

describe("the catalogue", () => {
  it("carries every synced product", () => {
    const slugs = listGuideSlugs();
    expect(slugs).toContain(AUTHORED);
    expect(slugs).toContain(LABEL_ONLY);
    expect(slugs).toContain(OZEMPIC);
  });

  it("prefers the authored layer when one exists", () => {
    expect(getGuide(AUTHORED)?.mode).toBe("authored");
  });

  it("falls back to label text when no authored layer exists", () => {
    expect(getGuide(LABEL_ONLY)?.mode).toBe("official-label");
    expect(getGuide(OZEMPIC)?.mode).toBe("official-label");
  });

  it("returns null for an unknown slug rather than a near match", () => {
    expect(getGuide("metoprolol")).toBeNull();
    expect(getGuide("toprol-xl")).toBeNull();
    expect(getGuide("")).toBeNull();
  });

  /**
   * Readiness is the pipeline's own gate. A blocked record carries no label
   * content by design, so registering one would put an empty page in the
   * library rather than keeping it out.
   */
  it("refuses a record that is not app-ready", () => {
    const blocked = { readiness: "blocked" as const };
    expect(parseLabelExport({ ...validShape(), ...blocked })).toBeNull();
  });

  it("throws rather than guessing when a record does not match the contract", () => {
    expect(() => parseLabelExport({ productKey: "x" })).toThrow(/failed validation/);
  });

  it("refuses a record claiming a clinical review", () => {
    expect(() =>
      parseLabelExport({ ...validShape(), clinicalReview: { reviewed: true, note: "" } })
    ).toThrow(/failed validation/);
  });
});

describe("boxed warnings", () => {
  it("surfaces the boxed warning when the document has one", () => {
    const g = getGuide(OZEMPIC);
    if (g?.mode !== "official-label") throw new Error("expected label guide");
    expect(g.boxedWarning).not.toBeNull();
    expect(g.boxedWarning!.title).toMatch(/WARNING/i);
  });

  /**
   * Toprol XL's current SPL carries no boxed-warning section: the abrupt
   * cessation text lives in 5.1 Warnings and Precautions. Metoprolol is a
   * drug class people associate with a boxed warning, so the page must stay
   * SILENT rather than assert an absence it cannot establish.
   */
  it("says nothing at all when the document has none", async () => {
    const g = getGuide(LABEL_ONLY);
    if (g?.mode !== "official-label") throw new Error("expected label guide");
    expect(g.boxedWarning).toBeNull();

    const html = await render(LABEL_ONLY);
    expect(html).not.toMatch(/no boxed warning/i);
    expect(html).not.toMatch(/without a boxed warning/i);
    expect(html).not.toMatch(/has no warning/i);
  });

  it("renders a present boxed warning verbatim on the patient page", async () => {
    const g = getGuide(OZEMPIC);
    if (g?.mode !== "official-label") throw new Error("expected label guide");
    const html = await render(OZEMPIC);
    for (const p of g.boxedWarning!.paragraphs.filter((x) => x.trim().length > 0)) {
      expect(html).toContain(renderToStaticMarkup(p));
    }
  });
});

describe("what a label-sourced page refuses to do", () => {
  /**
   * One SPL routinely covers several products dosed differently, and most
   * sections are not bound to any one of them. Rather than render a dose with
   * a caveat, the page renders no dose at all.
   */
  it.each([LABEL_ONLY, OZEMPIC])("shows no dosing for %s", async (slug) => {
    const html = await render(slug);
    expect(html).toContain("This page does not show doses");
    expect(html).not.toMatch(/\bDOSAGE AND ADMINISTRATION\b/);
    expect(html).not.toMatch(/\brecommended dosage\b/i);
  });

  it.each([LABEL_ONLY, OZEMPIC])("never claims the text is plain language for %s", async (slug) => {
    const html = await render(slug);
    expect(html).toContain("in the label");
    expect(html).toMatch(/own words/);
    // The authored page's promise must not appear on a label-sourced page.
    expect(html).not.toMatch(/plain-language guide/i);
  });

  it.each([LABEL_ONLY, OZEMPIC])("states the document's real scope for %s", async (slug) => {
    const g = getGuide(slug);
    if (g?.mode !== "official-label") throw new Error("expected label guide");
    const others = g.label.document.productsInDocument.length - 1;
    expect(others).toBeGreaterThan(0);
    const html = await render(slug);
    expect(html).toContain(`${others} other product`);
    expect(html).toContain("Do not use this page for them");
  });

  it.each([LABEL_ONLY, OZEMPIC])("never presents %s as clinically reviewed", async (slug) => {
    const g = getGuide(slug);
    if (g?.mode !== "official-label") throw new Error("expected label guide");
    expect(g.label.clinicalReview.reviewed).toBe(false);

    const html = await render(slug);
    // States it outright in the provenance block, as a value, not as prose
    // that could be skimmed past.
    expect(html).toContain("Clinically reviewed");
    expect(html).toContain("<dd>No</dd>");
    // And never the opposite. The footer's honest negative ("Nothing here has
    // been reviewed by a clinician") must not be what satisfies this.
    expect(html).not.toMatch(/has been reviewed by a clinician(?!\.)/i);
    expect(html).not.toMatch(/clinician[- ]reviewed/i);
    expect(html).not.toMatch(/reviewed and approved/i);
  });

  it.each([LABEL_ONLY, OZEMPIC])("links to the full official label for %s", async (slug) => {
    const g = getGuide(slug);
    if (g?.mode !== "official-label") throw new Error("expected label guide");
    const html = await render(slug);
    expect(html).toContain(g.label.document.sourceUrl);
  });
});

describe("the authored page is unchanged by any of this", () => {
  it("still renders its authored plain-language sections", async () => {
    const g = getGuide(AUTHORED);
    if (g?.mode !== "authored") throw new Error("expected authored guide");
    const html = await render(AUTHORED);
    for (const section of g.authored.record.sections) {
      expect(html).toContain(`id="sec-${section.id}"`);
    }
  });

  it("still carries its authored key points, boxed warning first", async () => {
    const html = await render(AUTHORED);
    expect(html).toContain("FDA boxed warning");
    expect(html).not.toContain("This page does not show doses");
  });
});

describe("scope notes are derived, never written", () => {
  it("counts the other products in the document", () => {
    const g = getGuide(OZEMPIC);
    if (g?.mode !== "official-label") throw new Error("expected label guide");
    const note = labelScopeNote(g.label);
    expect(note).toContain(String(g.label.document.productsInDocument.length - 1));
  });
});

describe("only text-bearing patient sections are shown", () => {
  it.each([LABEL_ONLY, OZEMPIC])("drops empty sections for %s", (slug) => {
    const g = getGuide(slug);
    if (g?.mode !== "official-label") throw new Error("expected label guide");
    for (const s of patientSections(g.label)) {
      const hasText =
        s.paragraphs.some((p) => p.trim().length > 0) ||
        s.tables.length > 0 ||
        s.highlights.some((h) => h.trim().length > 0);
      expect(hasText).toBe(true);
    }
  });
});

describe("names come from fields, not from prose", () => {
  it.each(listGuides().map((g) => g.slug))("builds a product name for %s", (slug) => {
    const g = getGuide(slug)!;
    const name = guideProductName(g);
    expect(name.length).toBeGreaterThan(0);
    expect(name).not.toMatch(/undefined|null|NaN/);
  });
});

/** Minimal record that satisfies the contract, for negative tests. */
function validShape() {
  return {
    schemaVersion: "1.0.0",
    productKey: "test-product",
    readiness: "app-ready",
    blockedReason: null,
    display: {
      brandName: "Test",
      genericName: "testolol",
      labeledIngredient: "TESTOLOL SUCCINATE",
      activeMoiety: "TESTOLOL",
      strengthDisplay: "10 mg",
      dosageForm: "TABLET",
      route: ["ORAL"],
      labelerName: "Test Labs",
    },
    identifiers: {
      productNdc: "99999-001",
      rxcui: "1",
      applicationNumber: "NDA000000",
      splSetId: "set",
      splVersion: "1",
    },
    document: {
      title: "TEST",
      splEffectiveDate: "2026-01-01",
      productsInDocument: ["Test 10mg TABLET"],
      sourceUrl: "https://example.invalid/label",
      medicationGuideUrl: "https://example.invalid/medguide",
    },
    professionalLabeling: [],
    patientLabeling: [],
    verification: { resolutionState: "verified-match", rationale: "ok" },
    clinicalReview: { reviewed: false, note: "not reviewed" },
    freshness: { ingestedAt: "2026-01-01T00:00:00Z", sourceEffectiveDate: "2026-01-01" },
    notProvided: [],
  };
}
