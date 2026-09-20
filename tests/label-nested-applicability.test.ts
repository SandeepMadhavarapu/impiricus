import { describe, it, expect } from "vitest";
import {
  patientSections,
  withheldPatientSections,
  nestedWithheldCount,
  parseLabelExport,
  type MedicationExport,
  type LabelSectionView,
} from "@/sources/lib/content/label";
import { listGuides } from "@/sources/lib/content/catalogue";
import rawSingulair from "@/sources/content/label-exports/singulair-montelukast-10mg-tablet.json";

/**
 * Applicability has to hold at every depth, not just the outermost section.
 *
 * The filter inspected only top-level sections while the renderer walks
 * `subsections` all the way down. A section the document ties to THIS product
 * can contain a child it ties to a different one: in the Singulair SPL,
 * "2.5 Instructions for Administration of Oral Granules" is `not-applicable`
 * and sits inside "2 DOSAGE AND ADMINISTRATION". Showing the parent showed the
 * child, which puts oral-granule instructions on a 10 mg tablet page.
 *
 * Today's patient labeling is flat, so nothing leaked in practice. These tests
 * exist because that is a property of the current data, not of the code, and a
 * single new nested section would have reintroduced the defect silently.
 *
 * SYNTHETIC FIXTURES are built by nesting sections into a REAL export, so the
 * surrounding shape is genuine and only the nesting is constructed. They are
 * labelled as such below.
 */

const real = parseLabelExport(rawSingulair)!;

function section(over: Partial<LabelSectionView> = {}): LabelSectionView {
  return {
    loincCode: "34076-0",
    printedNumber: null,
    title: "A section",
    paragraphs: ["Some patient-directed text."],
    highlights: [],
    tables: [],
    subsections: [],
    applicability: "exact-product",
    appliesToProducts: [],
    audience: "patient",
    ...over,
  };
}

/** SYNTHETIC: a real export with a hand-built patientLabeling tree. */
function withTree(tree: LabelSectionView[]): MedicationExport {
  return { ...real, patientLabeling: tree };
}

const INSTRUCTIONS_FOR_USE_LOINC = "59845-8";

describe("nested sections obey the same applicability rule", () => {
  it("drops a not-applicable child of a shown parent", () => {
    const doc = withTree([
      section({
        title: "2 DOSAGE AND ADMINISTRATION",
        subsections: [
          section({ title: "2.4 Tablets", applicability: "exact-product" }),
          section({
            title: "2.5 Instructions for Administration of Oral Granules",
            applicability: "not-applicable",
            appliesToProducts: ["montelukast 4 mg oral granules"],
          }),
        ],
      }),
    ]);

    const shown = patientSections(doc);
    expect(shown).toHaveLength(1);
    const titles = shown[0]!.subsections.map((s) => s.title);
    expect(titles).toContain("2.4 Tablets");
    expect(
      titles,
      "granule instructions reached a tablet page through its parent"
    ).not.toContain("2.5 Instructions for Administration of Oral Granules");
  });

  it("drops an Instructions for Use child that is not bound to this product", () => {
    const doc = withTree([
      section({
        title: "Using your medicine",
        subsections: [
          section({
            title: "How to use the pen",
            loincCode: INSTRUCTIONS_FOR_USE_LOINC,
            applicability: "document-level-unresolved",
          }),
        ],
      }),
    ]);
    expect(patientSections(doc)[0]!.subsections).toHaveLength(0);
  });

  it("keeps an Instructions for Use child that IS bound to this product", () => {
    const doc = withTree([
      section({
        title: "Using your medicine",
        subsections: [
          section({
            title: "How to use it",
            loincCode: INSTRUCTIONS_FOR_USE_LOINC,
            applicability: "exact-product",
          }),
        ],
      }),
    ]);
    expect(patientSections(doc)[0]!.subsections).toHaveLength(1);
  });

  it("prunes at any depth, not only the first", () => {
    const doc = withTree([
      section({
        title: "Top",
        subsections: [
          section({
            title: "Middle",
            subsections: [
              section({ title: "Deep, ours", applicability: "exact-product" }),
              section({ title: "Deep, theirs", applicability: "not-applicable" }),
            ],
          }),
        ],
      }),
    ]);
    const deep = patientSections(doc)[0]!.subsections[0]!.subsections.map((s) => s.title);
    expect(deep).toEqual(["Deep, ours"]);
  });

  it("does not remove a withheld parent's children twice over", () => {
    // A withheld parent takes its subtree with it; nothing should survive it.
    const doc = withTree([
      section({
        title: "Theirs",
        applicability: "not-applicable",
        subsections: [section({ title: "Ours, but orphaned", applicability: "exact-product" })],
      }),
    ]);
    expect(patientSections(doc)).toHaveLength(0);
    // ...and the top-level withhold is still reported by name.
    expect(withheldPatientSections(doc).map((w) => w.title)).toContain("Theirs");
  });

  it("leaves a tree with nothing to prune exactly as it was", () => {
    const doc = withTree([
      section({ title: "A", subsections: [section({ title: "A.1" })] }),
    ]);
    const shown = patientSections(doc);
    expect(shown[0]!.subsections.map((s) => s.title)).toEqual(["A.1"]);
  });
});

describe("pruning is never silent", () => {
  it("counts what it removed from inside a shown section", () => {
    const doc = withTree([
      section({
        title: "Shown",
        subsections: [
          section({ title: "ok" }),
          section({ title: "theirs", applicability: "not-applicable" }),
          section({
            title: "unbound IFU",
            loincCode: INSTRUCTIONS_FOR_USE_LOINC,
            applicability: "explicitly-shared",
          }),
        ],
      }),
    ]);
    expect(nestedWithheldCount(doc)).toBe(2);
  });

  it("does not count children of an already-withheld parent", () => {
    // Those are reported by the parent's own withhold entry; counting them
    // again would overstate how much was removed.
    const doc = withTree([
      section({
        title: "Theirs",
        applicability: "not-applicable",
        subsections: [section({ title: "child", applicability: "not-applicable" })],
      }),
    ]);
    expect(nestedWithheldCount(doc)).toBe(0);
  });

  it("does not count an empty section as a decision", () => {
    const doc = withTree([
      section({
        title: "Shown",
        subsections: [section({ title: "figure only", paragraphs: [], highlights: [], tables: [] })],
      }),
    ]);
    // There was nothing to show, so nothing was withheld from anyone.
    expect(nestedWithheldCount(doc)).toBe(0);
  });
});

describe("the real published labels", () => {
  it("expose no withheld section at any depth to a patient", () => {
    for (const guide of listGuides()) {
      if (guide.mode !== "official-label") continue;
      const walk = (sections: LabelSectionView[]): number => {
        let bad = 0;
        for (const s of sections) {
          if (s.applicability === "not-applicable") bad++;
          if (s.loincCode === INSTRUCTIONS_FOR_USE_LOINC && s.applicability !== "exact-product") bad++;
          bad += walk(s.subsections);
        }
        return bad;
      };
      expect(walk(guide.patientSections), `${guide.slug} shows a withheld section`).toBe(0);
    }
  });

  it("still shows something, so the filter has not emptied the page", () => {
    for (const guide of listGuides()) {
      if (guide.mode !== "official-label") continue;
      expect(guide.patientSections.length, `${guide.slug} has no patient sections left`).toBeGreaterThan(0);
    }
  });
});
