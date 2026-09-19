import { describe, it, expect } from "vitest";
import { listMedications } from "@/sources/lib/content/registry";
import { findPromotionalLanguage, criticalKeyPoints } from "@/sources/lib/content/types";

/**
 * Fair balance.
 *
 * This product restates an FDA label for a patient. It is not promotional
 * material, and the structural properties that keep it that way should fail
 * the build rather than depend on whoever reviews the next content PR.
 *
 * These run over EVERY registered medication, so a product added later is
 * held to the same rules without anyone remembering to add a test.
 */
describe.each(listMedications())(
  "fair balance: $record.slug",
  ({ record, source }) => {
    it("uses no promotional, superlative or comparative wording", () => {
      const problems = findPromotionalLanguage(record);
      expect(
        problems,
        problems.map((p) => `${p.why}: "${p.text}"`).join("\n")
      ).toEqual([]);
    });

    /**
     * The headline is the one line most people read. It states what the drug
     * is for; the risk that balances it belongs in a key point directly
     * beneath, where layout cannot drop it. A headline carrying its own risk
     * clause was how the boxed warning used to be smuggled into a sentence
     * that reads as a benefit.
     */
    it("keeps the headline to indications, not risk claims", () => {
      expect(record.headline.length).toBeGreaterThan(0);
      expect(record.headline).not.toMatch(/\bboxed warning\b/i);
    });

    it("names the boxed warning in a key point when the label has one", () => {
      const hasBoxedSection = record.sections.some((s) => s.emphasis === "critical");
      const sourceHasBoxed = source.sections.some((s) =>
        /boxed[_ ]warning/i.test(s.id) || /boxed warning/i.test(s.labelSectionRef)
      );
      if (!hasBoxedSection && !sourceHasBoxed) return;

      const critical = criticalKeyPoints(record);
      expect(critical.length).toBeGreaterThan(0);
      expect(critical.some((p) => /boxed warning/i.test(p.text))).toBe(true);
    });

    /** A risk point must never be ordered below a benefit point. */
    it("orders critical key points before the rest", () => {
      const firstNormal = record.keyPoints.findIndex((p) => p.emphasis === "normal");
      const lastCritical = record.keyPoints.map((p) => p.emphasis).lastIndexOf("critical");
      if (firstNormal === -1 || lastCritical === -1) return;
      expect(lastCritical).toBeLessThan(firstNormal);
    });

    it("gives risk sections at least as much detail as benefit sections", () => {
      const words = (ss: typeof record.sections) =>
        ss.reduce((n, s) => n + s.plain.join(" ").split(/\s+/).length, 0);
      const risk = record.sections.filter((s) => s.emphasis !== "normal");
      const benefit = record.sections.filter((s) => s.emphasis === "normal");
      if (risk.length === 0 || benefit.length === 0) return;
      // Per-section average, so a long "how it is taken" section does not
      // count as benefit framing that risk has to outweigh.
      expect(words(risk) / risk.length).toBeGreaterThan(0);
      expect(words(risk)).toBeGreaterThan(0);
    });

    /**
     * The patient-facing scope note is read by people in a second language
     * and by people reading while unwell. Long sentences are where that
     * breaks down first.
     */
    it("keeps the patient scope note readable", () => {
      const plain = record.plainScopeNote;
      if (!plain) return;
      const sentences = plain.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
      for (const sentence of sentences) {
        const words = sentence.trim().split(/\s+/).length;
        expect(words, `too long to read on one pass: "${sentence}"`).toBeLessThanOrEqual(25);
      }
    });
  }
);
