import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  parseLabelExport,
  patientSections,
  withheldPatientSections,
  boxedWarning,
  type MedicationExport,
  type LabelSectionView,
} from "@/sources/lib/content/label";
import { listGuides } from "@/sources/lib/content/catalogue";

/**
 * Applicability containment for patient-facing label content.
 *
 * The defect these pin: every patient section with text used to render,
 * including Instructions for Use that the document assigned to OTHER products.
 * Ozempic's page showed a full injection procedure for the 1 mg pen
 * (NDC 0169-1310) while describing a 1.34 mg/mL product, directly under a card
 * promising it would not show doses.
 *
 * The previous "no dosing" test passed throughout, because it looked for
 * professional-label phrasing ("DOSAGE AND ADMINISTRATION", "recommended
 * dosage") that never appears in a patient IFU. These tests look at the data
 * the page actually renders.
 */

const EXPORT_DIR = path.join(process.cwd(), "src", "sources", "content", "label-exports");

function loadAll(): MedicationExport[] {
  return readdirSync(EXPORT_DIR)
    .filter((f) => f.endsWith(".json") && f !== "manifest.json")
    .map((f) => parseLabelExport(JSON.parse(readFileSync(path.join(EXPORT_DIR, f), "utf8"))))
    .filter((r): r is MedicationExport => r !== null);
}

function flatten(sections: LabelSectionView[]): LabelSectionView[] {
  return sections.flatMap((s) => [s, ...flatten(s.subsections)]);
}

const INSTRUCTIONS_FOR_USE_LOINC = "59845-8";

describe("no other product's content reaches a patient page", () => {
  const records = loadAll();

  it("has records to check", () => {
    expect(records.length).toBeGreaterThan(0);
  });

  /**
   * The hard rule. `not-applicable` means the document itself tied the section
   * to a different product; there is no reading under which it belongs here.
   */
  it.each(loadAll().map((r) => [r.productKey, r] as const))(
    "%s renders no not-applicable section",
    (_key, record) => {
      for (const s of flatten(patientSections(record))) {
        expect(s.applicability).not.toBe("not-applicable");
      }
    }
  );

  /**
   * Device administration steps are precisely what an official-label page
   * promises not to show. An unresolved IFU is not evidence that it applies -
   * it is evidence that the document did not say.
   */
  it.each(loadAll().map((r) => [r.productKey, r] as const))(
    "%s renders no Instructions for Use unless bound to this exact product",
    (_key, record) => {
      for (const s of patientSections(record)) {
        if (s.loincCode !== INSTRUCTIONS_FOR_USE_LOINC) continue;
        expect(s.applicability).toBe("exact-product");
      }
    }
  );

  /** The specific historical leak, named so a regression is unmistakable. */
  it("Ozempic does not render the 1 mg pen instructions", () => {
    const ozempic = records.find((r) => r.productKey.startsWith("ozempic"));
    expect(ozempic).toBeDefined();

    const rendered = JSON.stringify(patientSections(ozempic!));
    expect(rendered).not.toMatch(/Prepare your pen with a new needle/i);
    expect(rendered).not.toMatch(/1 mg dose \(pen delivers doses in 1 mg increments only\)/i);
    expect(rendered).not.toMatch(/0169-1310/);

    // And the document really does still contain it, so this is containment,
    // not an artefact of the fixture changing.
    const raw = JSON.stringify(ozempic!.patientLabeling);
    expect(raw).toMatch(/Prepare your pen with a new needle/i);
  });

  it("Singulair renders neither of its not-applicable sections", () => {
    const singulair = records.find((r) => r.productKey.startsWith("singulair"));
    expect(singulair).toBeDefined();
    const titles = patientSections(singulair!).map((s) => (s.title ?? "").toUpperCase());
    expect(titles).not.toContain("INSTRUCTIONS FOR USE");
    expect(titles.some((t) => t.includes("PATIENT COUNSELING"))).toBe(false);
  });
});

describe("withholding is reported, not silent", () => {
  /**
   * A reader must be able to tell "the label says nothing about this" apart
   * from "we chose not to show you what it says".
   */
  it("counts and explains every withheld section", () => {
    const ozempic = loadAll().find((r) => r.productKey.startsWith("ozempic"))!;
    const withheld = withheldPatientSections(ozempic);

    expect(withheld.length).toBeGreaterThan(0);
    for (const w of withheld) {
      expect(["belongs-to-another-product", "unbound-instructions-for-use"]).toContain(w.reason);
    }
    // The three sibling-product IFUs are the reason this exists.
    expect(withheld.filter((w) => w.reason === "belongs-to-another-product").length).toBe(3);
  });

  it("does not report unparseable empty sections as decisions", () => {
    for (const record of loadAll()) {
      for (const w of withheldPatientSections(record)) {
        expect(w.reason).not.toBe("no-extractable-text");
      }
    }
  });

  it("names the products a withheld section does belong to, when the document says", () => {
    const ozempic = loadAll().find((r) => r.productKey.startsWith("ozempic"))!;
    const named = withheldPatientSections(ozempic).filter((w) => w.appliesToProducts.length > 0);
    expect(named.length).toBeGreaterThan(0);
    expect(JSON.stringify(named)).toMatch(/0169-1310/);
  });
});

describe("the guides exposed to both views", () => {
  const guides = listGuides();

  it("builds a guide for every app-ready product", () => {
    expect(guides.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * The clinician page renders the same `patientSections` array as the patient
   * page, so containment has to hold for the object both of them read - not
   * for a filter applied in one view.
   */
  it("carries no not-applicable section on any guide, either view", () => {
    for (const g of guides) {
      if (g.mode !== "official-label") continue;
      for (const s of flatten(g.patientSections)) {
        expect(s.applicability).not.toBe("not-applicable");
      }
    }
  });

  it("carries the withheld list alongside, so a view can explain the gap", () => {
    const ozempic = guides.find((g) => g.slug.startsWith("ozempic"));
    expect(ozempic).toBeDefined();
    if (ozempic!.mode !== "official-label") throw new Error("expected an official-label guide");
    expect(ozempic!.withheldSections.length).toBeGreaterThan(0);
  });
});

describe("boxed warning handling is unchanged", () => {
  /**
   * Deliberately NOT applicability-filtered: a boxed warning is a risk
   * statement about the drug, not administration. Withholding one because the
   * document did not scope it to a strength would suppress the most important
   * safety text on the label.
   */
  it("still surfaces a boxed warning that is document-level-unresolved", () => {
    const withBoxed = loadAll()
      .map((r) => ({ key: r.productKey, bw: boxedWarning(r) }))
      .filter((x) => x.bw !== null);
    expect(withBoxed.length).toBeGreaterThan(0);
  });

  it("never states that a boxed warning is absent", () => {
    const toprol = loadAll().find((r) => r.productKey.startsWith("toprol"))!;
    // Toprol XL's current SPL has no boxed-warning section. The helper returns
    // null and the view renders nothing; it must not synthesise a denial.
    const bw = boxedWarning(toprol);
    expect(bw === null || bw.paragraphs.length > 0).toBe(true);
  });
});
