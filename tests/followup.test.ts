import { describe, it, expect } from "vitest";
import { buildContextualQuery, isElliptical, priorUserMessages } from "@/sources/lib/retrieval/context";
import { searchPassages } from "@/sources/lib/retrieval";
import { getMedication } from "@/sources/lib/content/registry";
import { answerQuestion } from "@/patient/lib/chat/orchestrator";

const SLUG = "singulair-montelukast-10mg-tablet";
const { source } = getMedication(SLUG)!;

/**
 * Regression tests for a confirmed defect: retrieval ran on the latest message
 * alone (orchestrator.ts used `searchPassages(source, req.message)`), so
 * follow-up questions either missed real evidence or matched on noise words.
 *
 * Measured against the real label BEFORE the fix:
 *   "Are any of those permanent?" -> 0 hits -> "not covered"
 *   "Is that the same for her?"   -> 3 confident hits in Dosage and
 *                                    Administration, from a pronoun-only query
 */

const SIDE_EFFECTS_CONTEXT = ["What are the common side effects?"];

describe("elliptical detection", () => {
  it.each([
    "Are any of those permanent?",
    "Which ones are serious?",
    "Is that the same for her?",
    "And while pregnant?",
    "What about for my daughter?",
    "How common is that?",
    "ok and the warnings",
  ])("recognises %j as depending on earlier context", (msg) => {
    expect(isElliptical(msg)).toBe(true);
  });

  it.each([
    "What are the common side effects?",
    "Can I take this while pregnant?",
    "Does montelukast interact with warfarin?",
    "What are the most important warnings?",
  ])("recognises %j as self-contained", (msg) => {
    expect(isElliptical(msg)).toBe(false);
  });
});

describe("context is merged only when needed", () => {
  it("leaves a self-contained question untouched", () => {
    const q = buildContextualQuery("What are the most important warnings?", SIDE_EFFECTS_CONTEXT);
    expect(q.usedContext).toBe(false);
    expect(q.text).toBe("What are the most important warnings?");
  });

  it("merges the previous topic into an elliptical follow-up", () => {
    const q = buildContextualQuery("Are any of those permanent?", SIDE_EFFECTS_CONTEXT);
    expect(q.usedContext).toBe(true);
    expect(q.text).toContain("Are any of those permanent?");
    expect(q.text).toContain("side");
    expect(q.text).toContain("effect");
  });

  it("keeps the current message first so its own terms keep weight", () => {
    const q = buildContextualQuery("And while pregnant?", SIDE_EFFECTS_CONTEXT);
    expect(q.text.startsWith("And while pregnant?")).toBe(true);
  });

  it("skips elliptical prior turns when recovering the topic", () => {
    const q = buildContextualQuery("Are those permanent?", [
      "What are the common side effects?",
      "Which ones are serious?",
    ]);
    expect(q.usedContext).toBe(true);
    expect(q.text).toContain("effect");
  });

  it("extracts prior USER turns only, ignoring assistant boilerplate", () => {
    const history = [
      { role: "user" as const, content: "What are the common side effects?" },
      { role: "assistant" as const, content: "Here are the sections of the FDA label..." },
    ];
    expect(priorUserMessages(history)).toEqual(["What are the common side effects?"]);
  });
});

describe("the measured failures are fixed", () => {
  /** Before: 0 hits. The label DOES address this. */
  it('"Are any of those permanent?" now finds the persistence evidence', () => {
    const before = searchPassages(source, "Are any of those permanent?", { limit: 6 });
    expect(before.length).toBe(0); // the original defect, still reproducible

    const q = buildContextualQuery("Are any of those permanent?", [
      "Can this cause mood changes or depression?",
    ]);
    const after = searchPassages(source, q.text, { limit: 6 });
    expect(after.length).toBeGreaterThan(0);
    expect(
      after.some((p) => p.sectionId === "warnings_and_cautions" || p.sectionId === "boxed_warning")
    ).toBe(true);
  });

  /** Before: confident hits in the dosage section from a pronoun-only query. */
  it('"Is that the same for her?" is no longer answered from noise', async () => {
    const answer = await answerQuestion(
      { slug: SLUG, message: "Is that the same for her?", history: [] },
      { adapter: null }
    );
    expect(answer.mode).toBe("needs-clarification");
    expect(answer.citations).toHaveLength(0);
    expect(answer.paragraphs.join(" ")).toMatch(/not sure what that refers to/i);
  });

  it("a follow-up with context is answered from the right section", async () => {
    const history = [
      { role: "user" as const, content: "What are the common side effects?" },
      { role: "assistant" as const, content: "Here are the sections of the FDA label..." },
    ];
    const answer = await answerQuestion(
      { slug: SLUG, message: "Are any of those permanent?", history },
      { adapter: null }
    );
    expect(answer.mode).toBe("label-excerpts");
    expect(answer.citations.length).toBeGreaterThan(0);
  });
});

describe("clarification instead of guessing", () => {
  it("asks rather than answering when a pronoun has no antecedent", async () => {
    for (const msg of ["Is that the same for her?", "what about those", "and them?"]) {
      const answer = await answerQuestion(
        { slug: SLUG, message: msg, history: [] },
        { adapter: null }
      );
      expect(answer.mode, msg).toBe("needs-clarification");
      expect(answer.citations, msg).toHaveLength(0);
    }
  });

  it("does not offer a provider handoff for an ambiguous question", async () => {
    const answer = await answerQuestion(
      { slug: SLUG, message: "Is that the same for her?", history: [] },
      { adapter: null }
    );
    // There is no coherent question to carry to a clinician yet.
    expect(answer.offerProviderConnection).toBe(false);
  });

  it("never asks for clarification on a self-contained question", async () => {
    for (const msg of [
      "What are the common side effects?",
      "Can I take this while pregnant?",
      "What are the most important warnings?",
    ]) {
      const answer = await answerQuestion(
        { slug: SLUG, message: msg, history: [] },
        { adapter: null }
      );
      expect(answer.mode, msg).not.toBe("needs-clarification");
    }
  });

  /** Urgency still outranks everything, including clarification. */
  it("still routes a crisis immediately even if phrased elliptically", async () => {
    const answer = await answerQuestion(
      { slug: SLUG, message: "I took too many of those", history: [] },
      { adapter: null }
    );
    expect(answer.mode).toBe("urgent");
    expect(answer.urgent!.resources.some((r) => r.href === "tel:18002221222")).toBe(true);
  });
});
