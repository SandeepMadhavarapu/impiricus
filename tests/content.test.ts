import { describe, it, expect } from "vitest";
import {
  getMedication,
  listMedications,
  listMedicationSlugs,
  DEFAULT_MEDICATION_SLUG,
  productLabel,
  isStale,
  evidenceAgeDays,
} from "@/sources/lib/content/registry";
import { verifyMedicationCitations, verifyCitation } from "@/sources/lib/content/types";

describe("content registry", () => {
  it("loads and schema-validates every medication record", () => {
    const meds = listMedications();
    expect(meds.length).toBeGreaterThan(0);
    for (const { record, source } of meds) {
      expect(record.slug).toMatch(/^[a-z0-9-]+$/);
      expect(source.sections.length).toBeGreaterThan(0);
    }
  });

  it("returns null for an unknown slug instead of falling back to another drug", () => {
    expect(getMedication("no-such-medication")).toBeNull();
    expect(getMedication("")).toBeNull();
    // A near-miss on a real slug must not resolve. Showing the wrong product is
    // the most damaging failure mode this app has.
    expect(getMedication("singulair-montelukast-5mg-tablet")).toBeNull();
    expect(getMedication("SINGULAIR-MONTELUKAST-10MG-TABLET")).toBeNull();
  });

  it("resolves the default medication featured by the root route", () => {
    const resolved = getMedication(DEFAULT_MEDICATION_SLUG);
    expect(resolved).not.toBeNull();
    expect(resolved!.record.slug).toBe(DEFAULT_MEDICATION_SLUG);
  });
});

describe("citation integrity", () => {
  it("every authored citation quote exists verbatim in the retrieved source", () => {
    for (const { record, source } of listMedications()) {
      const problems = verifyMedicationCitations(record, source);
      expect(
        problems,
        `Unsupported citations in "${record.slug}":\n` +
          problems
            .map((p) => `  [${p.reason}] ${p.sectionId}: "${p.quote.slice(0, 80)}..."`)
            .join("\n")
      ).toEqual([]);
    }
  });

  it("every section carries at least one citation", () => {
    for (const { record } of listMedications()) {
      for (const section of record.sections) {
        expect(section.citations.length, `${record.slug}/${section.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("rejects a fabricated quote", () => {
    const { source } = listMedications()[0]!;
    const problem = verifyCitation(
      {
        sectionId: "boxed_warning",
        quote: "Montelukast is proven safe for all patients with no meaningful risk.",
      },
      source
    );
    expect(problem?.reason).toBe("quote-not-found");
  });

  it("rejects a citation pointing at a section that was never retrieved", () => {
    const { source } = listMedications()[0]!;
    const problem = verifyCitation(
      { sectionId: "section_that_does_not_exist", quote: "anything at all here" },
      source
    );
    expect(problem?.reason).toBe("unknown-section");
  });

  it("matches quotes across whitespace and case differences only", () => {
    const { source } = listMedications()[0]!;
    const ok = verifyCitation(
      {
        sectionId: "contraindications",
        quote:
          "SINGULAIR   is contraindicated\n in patients with hypersensitivity to any of its components.",
      },
      source
    );
    expect(ok).toBeNull();
  });
});

describe("product identity guards", () => {
  it("pins the exact product this content describes", () => {
    const { source } = getMedication(DEFAULT_MEDICATION_SLUG)!;
    // If any of these drift, the plain-language content may no longer describe
    // the product it claims to describe.
    expect(source.product.productNdc).toBe("78206-172");
    expect(source.product.applicationNumber).toBe("NDA020829");
    expect(source.product.dosageForm).toBe("TABLET, FILM COATED");
    expect(source.product.strength.join()).toContain("10 mg");
    expect(source.document.splSetId).toBe("482dcc92-b47f-4ea6-854a-f5ac2aea7842");
  });

  it("records a boxed warning for a product whose label has one", () => {
    const { source, record } = getMedication(DEFAULT_MEDICATION_SLUG)!;
    expect(source.sections.some((s) => s.id === "boxed_warning")).toBe(true);
    // ...and surfaces it as a critical section rather than burying it.
    const boxed = record.sections.find((s) => s.emphasis === "critical");
    expect(boxed).toBeDefined();
    // The boxed warning must be the first thing after the headline.
    expect(record.sections[0]!.id).toBe(boxed!.id);
  });

  it("states the dosage-form scope so readers do not generalise across forms", () => {
    const { record, source } = getMedication(DEFAULT_MEDICATION_SLUG)!;
    expect(record.scopeNote.toLowerCase()).toContain("10 mg");
    expect(record.scopeNote.toLowerCase()).toContain("chewable");
    // The underlying SPL genuinely covers more than one form.
    expect(source.document.coversDosageForms.length).toBeGreaterThan(1);
  });

  it("never claims a clinical review that did not happen", () => {
    for (const { source } of listMedications()) {
      expect(source.provenance.clinicallyReviewedAt).toBeNull();
      expect(source.provenance.clinicallyReviewedBy).toBeNull();
      // Retrieval, by contrast, is real and must be recorded.
      expect(Number.isNaN(Date.parse(source.provenance.retrievedAt))).toBe(false);
    }
  });

  it("builds a product label scoped to one strength and form", () => {
    const { source } = getMedication(DEFAULT_MEDICATION_SLUG)!;
    const label = productLabel(source);
    expect(label).toContain("Singulair");
    expect(label).toContain("montelukast");
    expect(label).toContain("10 mg");
  });
});

describe("staleness", () => {
  it("does not flag freshly retrieved content", () => {
    const { source } = getMedication(DEFAULT_MEDICATION_SLUG)!;
    const justAfter = new Date(Date.parse(source.provenance.retrievedAt) + 1000);
    expect(isStale(source, justAfter)).toBe(false);
    expect(evidenceAgeDays(source, justAfter)).toBe(0);
  });

  it("flags content retrieved long ago", () => {
    const { source } = getMedication(DEFAULT_MEDICATION_SLUG)!;
    const muchLater = new Date(Date.parse(source.provenance.retrievedAt) + 200 * 86_400_000);
    expect(isStale(source, muchLater)).toBe(true);
    expect(evidenceAgeDays(source, muchLater)).toBe(200);
  });
});

describe("slug listing", () => {
  it("lists slugs for static generation", () => {
    expect(listMedicationSlugs()).toContain(DEFAULT_MEDICATION_SLUG);
  });
});
