import { describe, it, expect } from "vitest";
import {
  PassageSelectionSchema,
  parseSelection,
  resolveSelection,
  compositePassageId,
  insufficientEvidenceExplanation,
  type EligiblePassage,
} from "@/patient/lib/chat/selection";
import { answerQuestion } from "@/patient/lib/chat/orchestrator";
import type { ChatRequest } from "@/patient/lib/chat/types";
import type { AssistantAdapter } from "@/patient/lib/chat/providers";

/**
 * The model selects evidence; the server supplies the words.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS REPLACED
 * ---------------------------------------------------------------------------
 * The orchestrator asked a model to WRITE an answer and validated it
 * afterwards by matching citation markers. Prose containing NO markers
 * produced zero valid AND zero rejected citations, so it satisfied neither
 * branch of the withholding rule and shipped as an "assistant" answer.
 *
 * Reproduced against the pre-change code with a stub adapter returning:
 *
 *   "Montelukast is generally very safe and most people have no side effects
 *    whatsoever. You can stop it at any time without consulting anyone."
 *
 * Observed: mode "assistant", citations 0, validationNote none. For a drug
 * carrying a boxed warning for neuropsychiatric events. The first test below
 * pins that this can never happen again.
 */

const SLUG = "singulair-montelukast-10mg-tablet";

function stubAdapter(text: string): AssistantAdapter {
  return {
    id: "stub",
    displayName: "Stub model",
    complete: async () => ({ ok: true, text }),
  } as AssistantAdapter;
}

function failingAdapter(reason: string): AssistantAdapter {
  return {
    id: "stub",
    displayName: "Stub model",
    complete: async () => ({ ok: false, reason }),
  } as unknown as AssistantAdapter;
}

const req = (message: string): ChatRequest =>
  ({ slug: SLUG, message, history: [] }) as ChatRequest;

const ask = (text: string, message = "what are the side effects?") =>
  answerQuestion(req(message), { adapter: stubAdapter(text) });

/* ------------------------------------------------------ the selection unit */

function passage(id: string, text = "Some label text about adverse reactions."): EligiblePassage {
  return {
    id,
    compositeId: compositePassageId("rec-1", "20", id),
    sectionId: id.split("#")[0]!,
    sectionTitle: "Adverse Reactions",
    labelSectionRef: "6",
    text,
  };
}

const eligible = [passage("adverse_reactions#0"), passage("adverse_reactions#1"), passage("warnings#0")];

describe("the model can only return identifiers", () => {
  it("accepts a well-formed selection", () => {
    const r = PassageSelectionSchema.safeParse({ passageIds: ["a"], noRelevantEvidence: false });
    expect(r.success).toBe(true);
  });

  /** The day an `answer` field appears is the day somebody renders it. */
  it("rejects any extra field, including one carrying answer text", () => {
    for (const extra of [
      { answer: "Take two and call me in the morning." },
      { text: "prose" },
      { sourceUrl: "https://example.org" },
      { strength: "10 mg" },
      { citations: [] },
    ]) {
      const r = PassageSelectionSchema.safeParse({
        passageIds: ["a"],
        noRelevantEvidence: false,
        ...extra,
      });
      expect(r.success, `accepted an extra field: ${Object.keys(extra)[0]}`).toBe(false);
    }
  });

  it("caps how many passages can be selected", () => {
    const ids = Array.from({ length: 7 }, (_, i) => `p${i}`);
    expect(PassageSelectionSchema.safeParse({ passageIds: ids, noRelevantEvidence: false }).success).toBe(false);
  });

  it.each([
    ["not JSON at all", "I think the answer is probably fine."],
    ["JSON of the wrong shape", '{"answer":"take it with food"}'],
    ["a missing field", '{"passageIds":["a"]}'],
    ["an extra field", '{"passageIds":["a"],"noRelevantEvidence":false,"answer":"x"}'],
    ["an empty string", ""],
    ["prose that merely looks structured", "passageIds: adverse_reactions#0"],
  ])("fails to parse %s", (_label, raw) => {
    expect(parseSelection(raw)).toBeNull();
  });

  /*
   * Shapes a real model actually emits.
   *
   * Rejecting these would send a perfectly good selection to the deterministic
   * fallback, and the feature would quietly degrade to plain retrieval with
   * nobody noticing - green tests, silently worse product. Extracting the
   * object is safe because every id is still checked against the server's own
   * passages; the surrounding prose is discarded and never rendered.
   */
  it.each([
    ["a fenced block", '```json\n{"passageIds":["a"],"noRelevantEvidence":false}\n```'],
    ["an unlabelled fence", '```\n{"passageIds":["a"],"noRelevantEvidence":false}\n```'],
    ["a preamble", 'Here is the selection:\n{"passageIds":["a"],"noRelevantEvidence":false}'],
    ["a trailing sentence", '{"passageIds":["a"],"noRelevantEvidence":false}\n\nHope that helps!'],
    ["surrounding whitespace", '   {"passageIds":["a"],"noRelevantEvidence":false}   '],
  ])("recovers the selection from %s", (_label, raw) => {
    expect(parseSelection(raw)?.passageIds).toEqual(["a"]);
  });

  it("does not let prose around the JSON become answer text", () => {
    const parsed = parseSelection(
      'The label says this drug is completely safe.\n{"passageIds":["a"],"noRelevantEvidence":false}'
    );
    expect(parsed).toEqual({ passageIds: ["a"], noRelevantEvidence: false });
    expect(JSON.stringify(parsed)).not.toMatch(/completely safe/);
  });
});

describe("resolution is strict by construction", () => {
  it("returns server-held passages for a valid selection", () => {
    const r = resolveSelection(
      { passageIds: [eligible[0]!.compositeId], noRelevantEvidence: false },
      eligible
    );
    expect(r.status).toBe("source-excerpts");
    if (r.status === "source-excerpts") expect(r.passages[0]!.text).toBe(eligible[0]!.text);
  });

  it("preserves the model's ordering", () => {
    const r = resolveSelection(
      { passageIds: [eligible[2]!.compositeId, eligible[0]!.compositeId], noRelevantEvidence: false },
      eligible
    );
    if (r.status !== "source-excerpts") throw new Error("expected excerpts");
    expect(r.passages.map((p) => p.compositeId)).toEqual([
      eligible[2]!.compositeId,
      eligible[0]!.compositeId,
    ]);
  });

  it("collapses duplicates rather than repeating a passage", () => {
    const id = eligible[0]!.compositeId;
    const r = resolveSelection({ passageIds: [id, id, id], noRelevantEvidence: false }, eligible);
    if (r.status !== "source-excerpts") throw new Error("expected excerpts");
    expect(r.passages).toHaveLength(1);
  });

  /**
   * One fabricated id invalidates the whole selection. A model that invented
   * one has shown it is guessing, and the others carry no more warrant than
   * the one that was caught.
   */
  it("discards the entire selection when any id is unknown", () => {
    const r = resolveSelection(
      { passageIds: [eligible[0]!.compositeId, "fabricated#9"], noRelevantEvidence: false },
      eligible
    );
    expect(r.status).toBe("insufficient-evidence");
    if (r.status === "insufficient-evidence") expect(r.reason).toBe("unknown-passage-id");
  });

  it("honours an honest report of nothing relevant", () => {
    const r = resolveSelection(
      { passageIds: [eligible[0]!.compositeId], noRelevantEvidence: true },
      eligible
    );
    expect(r.status).toBe("insufficient-evidence");
    if (r.status === "insufficient-evidence") expect(r.reason).toBe("model-reported-none");
  });

  it("treats an empty selection as insufficient, not as success", () => {
    const r = resolveSelection({ passageIds: [], noRelevantEvidence: false }, eligible);
    expect(r.status).toBe("insufficient-evidence");
  });

  it("reports no-eligible-passages when nothing was offered", () => {
    const r = resolveSelection({ passageIds: ["x"], noRelevantEvidence: false }, []);
    expect(r.status).toBe("insufficient-evidence");
    if (r.status === "insufficient-evidence") expect(r.reason).toBe("no-eligible-passages");
  });
});

describe("composite identity prevents cross-product and cross-version answers", () => {
  it("a bare passage id never resolves", () => {
    const r = resolveSelection({ passageIds: ["adverse_reactions#0"], noRelevantEvidence: false }, eligible);
    expect(r.status).toBe("insufficient-evidence");
  });

  it("an id from another product never resolves", () => {
    const other = compositePassageId("other-product", "20", "adverse_reactions#0");
    const r = resolveSelection({ passageIds: [other], noRelevantEvidence: false }, eligible);
    expect(r.status).toBe("insufficient-evidence");
  });

  it("an id from an obsolete label version never resolves", () => {
    const old = compositePassageId("rec-1", "19", "adverse_reactions#0");
    expect(old).not.toBe(eligible[0]!.compositeId);
    const r = resolveSelection({ passageIds: [old], noRelevantEvidence: false }, eligible);
    expect(r.status).toBe("insufficient-evidence");
  });
});

describe("explanations are generated, never taken from the model", () => {
  it("keeps apart facts that read alike and mean opposite things", () => {
    const text = [
      insufficientEvidenceExplanation("model-reported-none", "Singulair"),
      insufficientEvidenceExplanation("no-eligible-passages", "Singulair"),
      insufficientEvidenceExplanation("unknown-passage-id", "Singulair"),
    ].join(" ");
    // Never a claim about the medicine itself.
    expect(text).not.toMatch(/no risk|does not cause|is safe|contains no information/i);
    expect(text).toMatch(/material checked|what was checked|not among the passages/i);
  });

  it("does not echo what the model produced", () => {
    expect(insufficientEvidenceExplanation("unknown-passage-id", "Singulair")).not.toMatch(
      /because the model said|reason:/i
    );
  });
});

/* -------------------------------------------------- end to end, real record */

describe("the orchestrator never renders model-authored medical text", () => {
  /** The exact reproduction that shipped before this change. */
  it("discards unsourced prose entirely", async () => {
    const dangerous =
      "Montelukast is generally very safe and most people have no side effects whatsoever. You can stop it at any time without consulting anyone.";
    const a = await ask(dangerous);

    expect(a.mode).not.toBe("assistant");
    expect(a.paragraphs.join(" ")).not.toContain("generally very safe");
    expect(a.paragraphs.join(" ")).not.toContain("stop it at any time");
    // And it discloses that the fallback chose these passages.
    expect(a.validationNote ?? "").toMatch(/did not return a usable selection/i);
  });

  it.each([
    ["prose with a valid-looking citation marker", "Side effects are mild [[adverse_reactions#0]]."],
    ["mixed valid and fabricated markers", "Mild [[adverse_reactions#0]] and safe [[invented#9]]."],
    ["a bare refusal", "I cannot answer that."],
  ])("discards %s", async (_label, text) => {
    const a = await ask(text);
    expect(a.mode).not.toBe("assistant");
    expect(a.paragraphs.join(" ")).not.toMatch(/Side effects are mild|and safe|I cannot answer/);
  });

  it("returns verbatim label text for a valid selection", async () => {
    // Discover a real composite id the way the server builds them.
    const probe = await ask('{"passageIds":[],"noRelevantEvidence":true}');
    expect(probe.mode).toBe("insufficient-evidence");

    // A selection naming a real passage produces citations carrying source text.
    const real = await answerQuestion(req("what are the side effects?"), {
      adapter: {
        id: "stub",
        displayName: "Stub model",
        complete: async ({ system }: { system: string }) => {
          const id = system.match(/<passage id="([^"]+)"/)?.[1];
          return { ok: true, text: JSON.stringify({ passageIds: id ? [id] : [], noRelevantEvidence: !id }) };
        },
      } as unknown as AssistantAdapter,
    });

    expect(real.mode).toBe("label-excerpts");
    expect(real.citations.length).toBeGreaterThan(0);
    expect(real.citations[0]!.excerpt.length).toBeGreaterThan(0);
    // Provenance must say a model did not write it.
    expect(real.provenanceNote).toMatch(/No answer text was written by a model/i);
  });

  it("falls back deterministically when the model fails, and says so", async () => {
    const a = await answerQuestion(req("what are the side effects?"), {
      adapter: failingAdapter("timeout"),
    });
    expect(a.mode).toBe("unavailable");
    expect(a.validationNote ?? "").toMatch(/unavailable right now \(timeout\)/);
    expect(a.validationNote ?? "").toMatch(/chosen by the label search/i);
  });

  it("never claims the label says something does not occur", async () => {
    const a = await ask('{"passageIds":[],"noRelevantEvidence":true}');
    const all = [...a.paragraphs, a.provenanceNote].join(" ");
    expect(all).not.toMatch(/no risk|does not cause|the label contains no information|safe for you/i);
    expect(all).toMatch(/statement about what was checked/i);
  });

  it("keeps insufficient-evidence distinct from nothing-retrieved", async () => {
    const insufficient = await ask('{"passageIds":[],"noRelevantEvidence":true}');
    expect(insufficient.mode).toBe("insufficient-evidence");

    // A question with no lexical or topical purchase retrieves nothing at all.
    const nothing = await answerQuestion(req("qqzzxx wibble frobnicate"), {
      adapter: stubAdapter('{"passageIds":[],"noRelevantEvidence":true}'),
    });
    expect(nothing.mode).toBe("not-covered");
    expect(nothing.mode).not.toBe(insufficient.mode);
  });
});
