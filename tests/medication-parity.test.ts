import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import MedicationPage from "@/app/medications/[slug]/page";
import { listGuides, getGuide } from "@/sources/lib/content/catalogue";
import { patientGuide, guideSource } from "@/sources/lib/content/patient-guide";
import { answerQuestion } from "@/patient/lib/chat/orchestrator";
import { INFORMATION_PENDING } from "@/shared/lib/content-status";

const guides = listGuides();
const first = patientGuide(getGuide("singulair-montelukast-10mg-tablet")!);

describe("one patient experience for every medication", () => {
  it.each(guides)("keeps the complete interface for $slug", async guide => {
    const html = renderToStaticMarkup(await MedicationPage({ params: Promise.resolve({ slug: guide.slug }) }));
    for (const section of first.sections) expect(html).toContain(`id="sec-${section.id}"`);
    for (const label of ["Learn more: ask about this medication", "Connect with a provider", "Check coverage", "Where this comes from"]) {
      expect(html).toContain(label);
    }
    const view = patientGuide(guide);
    for (const section of view.sections) {
      for (const citation of section.citations) {
        expect(view.source.sections.find(s => s.id === citation.sectionId)?.text).toContain(citation.quote);
      }
    }
    if (guide.mode === "official-label") {
      expect(html).toContain(INFORMATION_PENDING);
      expect(html).toContain("<summary>More detail</summary>");
      expect(html).not.toContain("serious mental-health and behavior changes");
      expect(html).not.toContain("not a rescue inhaler");
    }
  });

  it.each(guides)("answers with only the correct label for $slug", async guide => {
    const source = guideSource(guide);
    for (const message of ["What is this medication used for?", "What are the common side effects?", "What are the most important warnings?"]) {
      const answer = await answerQuestion({ slug: guide.slug, message, history: [] }, { adapter: null });
      expect(answer.mode).toBe("label-excerpts");
      expect(answer.citations.length).toBeGreaterThan(0);
      for (const citation of answer.citations) {
        expect(citation.sourceUrl).toContain(source.document.splSetId);
        const section = source.sections.find(s => citation.passageId.startsWith(`${s.id}#`));
        expect(section?.text.replace(/\s+/g, " ")).toContain(citation.excerpt.slice(0, 60).replace(/\s+/g, " "));
      }
    }
  });

  it.each(guides)("supports follow-ups and urgent help for $slug", async guide => {
    const answer = await answerQuestion({ slug: guide.slug, message: "Are any of those permanent?", history: [{ role: "user", content: "What are the side effects?" }] }, { adapter: null });
    expect(answer.mode).toBe("label-excerpts");
    expect(answer.citations.length).toBeGreaterThan(0);
    const urgent = await answerQuestion({ slug: guide.slug, message: "I cannot breathe", history: [] }, { adapter: null });
    expect(urgent.mode).toBe("urgent");
    expect(urgent.citations).toEqual([]);
  });

  it.each(guides.filter(g => g.mode === "official-label"))("does not infer exact-product instructions for $slug", async guide => {
    const answer = await answerQuestion({ slug: guide.slug, message: "How much should I take?", history: [] }, { adapter: null });
    expect(answer.mode).toBe("not-covered");
    expect(answer.paragraphs).toContain(INFORMATION_PENDING);
    expect(answer.citations).toEqual([]);
    const risk = await answerQuestion({ slug: guide.slug, message: "Does it cause depression?", history: [] }, { adapter: null });
    expect(JSON.stringify(risk.crisisFooter)).not.toMatch(/singulair|montelukast/i);
  });
});
