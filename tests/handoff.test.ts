import { describe, it, expect } from "vitest";
import {
  normaliseQuestion,
  reasonForAnswerMode,
  handoffReasonLabel,
  type UnresolvedQuestion,
} from "@/doctor/lib/handoff";

/**
 * Regression tests for a confirmed defect: the chat -> provider handoff
 * discarded the user's unresolved question entirely. onOpenProvider took no
 * arguments, so what the person actually asked never reached the next step.
 *
 * The generic prompt list that once accompanied it has been removed from the
 * product, so what is asserted here is the part that matters: the person's
 * own question survives the handoff, verbatim.
 */
describe("the unresolved question survives the handoff", () => {
  it("carries the question through without rewording it", () => {
    const unresolved: UnresolvedQuestion = {
      question: "Are any of those side effects permanent?",
      reason: "not-covered",
    };
    expect(normaliseQuestion(unresolved.question)).toBe(
      "Are any of those side effects permanent?"
    );
  });

  it("does not put words in the patient's mouth", () => {
    // Punctuation is added; wording is untouched.
    expect(normaliseQuestion("can i drink alcohol on this stuff")).toBe(
      "can i drink alcohol on this stuff?"
    );
  });
});

describe("question normalisation", () => {
  it("collapses whitespace and adds terminal punctuation", () => {
    expect(normaliseQuestion("  what   about\n\n pregnancy ")).toBe("what about pregnancy?");
  });

  it("preserves existing terminal punctuation", () => {
    expect(normaliseQuestion("Is this safe for my daughter?")).toBe("Is this safe for my daughter?");
    expect(normaliseQuestion("I need to know this.")).toBe("I need to know this.");
  });

  it("caps an overlong question rather than carrying a wall of text", () => {
    const long = "a".repeat(500);
    const out = normaliseQuestion(long);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns empty for blank input, so nothing is carried", () => {
    expect(normaliseQuestion("   ")).toBe("");
    expect(normaliseQuestion("\n\t  \n")).toBe("");
  });
});

describe("which answers carry a question forward", () => {
  it("carries forward when the label did not cover it", () => {
    expect(reasonForAnswerMode("not-covered")).toBe("not-covered");
  });

  it("carries forward when the assistant failed", () => {
    expect(reasonForAnswerMode("unavailable")).toBe("assistant-unavailable");
  });

  it("carries forward an answered question when the user still escalates", () => {
    expect(reasonForAnswerMode("assistant")).toBe("answered-but-escalated");
    expect(reasonForAnswerMode("label-excerpts")).toBe("answered-but-escalated");
  });

  /**
   * Someone in crisis needs help immediately, not a question list to take to a
   * future appointment. Routing them into provider preparation would be wrong.
   */
  it("NEVER carries an urgent/crisis turn into provider preparation", () => {
    expect(reasonForAnswerMode("urgent")).toBeNull();
  });

  /** An unresolved pronoun is noise, not a question a clinician can act on. */
  it("does not carry an ambiguous question forward", () => {
    expect(reasonForAnswerMode("needs-clarification")).toBeNull();
  });

  it("has an explanatory line for every reason that carries a question", () => {
    for (const reason of ["not-covered", "assistant-unavailable", "answered-but-escalated"] as const) {
      expect(handoffReasonLabel(reason).length).toBeGreaterThan(0);
    }
    expect(handoffReasonLabel("user-initiated")).toBe("");
  });
});

describe("the carried question stays local", () => {
  /**
   * The handoff module must not acquire a transport. If a future change adds
   * one, this test should fail and force a confirm-before-send review.
   */
  it("exports no network or storage surface", async () => {
    const mod = await import("@/doctor/lib/handoff");
    const exported = Object.keys(mod).join(" ").toLowerCase();
    for (const forbidden of ["send", "post", "submit", "persist", "save", "store", "upload"]) {
      expect(exported, `handoff module exposes "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("module source contains no fetch, storage or beacon calls", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/doctor/lib/handoff/index.ts", "utf8");
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(src).not.toMatch(/sendBeacon/);
  });
});
