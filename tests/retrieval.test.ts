import { describe, it, expect } from "vitest";
import { searchPassages, getPassages, findPassageById, chunkSection, tokenize } from "@/lib/retrieval";
import { getMedication } from "@/lib/content/registry";

const { source } = getMedication("singulair-montelukast-10mg-tablet")!;

describe("chunking", () => {
  it("produces passages with stable, section-prefixed ids", () => {
    const passages = getPassages(source);
    expect(passages.length).toBeGreaterThan(50);
    for (const p of passages) {
      expect(p.id).toMatch(/^[a-z0-9_]+#\d+$/);
      expect(p.id.startsWith(p.sectionId + "#")).toBe(true);
      expect(p.text.length).toBeGreaterThan(0);
    }
  });

  it("keeps every passage traceable to a real source section", () => {
    const sectionIds = new Set(source.sections.map((s) => s.id));
    for (const p of getPassages(source)) {
      expect(sectionIds.has(p.sectionId)).toBe(true);
    }
  });

  it("is deterministic across calls", () => {
    expect(getPassages(source).map((p) => p.id)).toEqual(getPassages(source).map((p) => p.id));
  });

  it("bounds passage size", () => {
    for (const p of chunkSection("x", "X", "1", "A ".repeat(3000))) {
      expect(p.text.length).toBeLessThan(1400);
    }
  });

  it("resolves a passage by id and rejects an unknown one", () => {
    const first = getPassages(source)[0]!;
    expect(findPassageById(source, first.id)?.id).toBe(first.id);
    expect(findPassageById(source, "nope#0")).toBeNull();
  });
});

describe("query routing", () => {
  const cases: Array<[string, string]> = [
    ["What are the common side effects?", "adverse_reactions"],
    ["What are the most important warnings?", "boxed_warning"],
    ["Can it cause depression or suicidal thoughts?", "warnings_and_cautions"],
    ["What is this medication used for?", "indications_and_usage"],
    ["Can I take it while pregnant?", "pregnancy"],
    ["Does it interact with warfarin?", "drug_interactions"],
    ["When should I take it?", "dosage_and_administration"],
    ["What if I took too much?", "overdosage"],
    ["How does it work?", "mechanism_of_action"],
  ];

  it.each(cases)("routes %j to the %s section", (query, expectedSection) => {
    const results = searchPassages(source, query, { limit: 6 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((p) => p.sectionId === expectedSection)).toBe(true);
  });

  it("returns nothing for a question the label does not address", () => {
    for (const q of [
      "Does this cure diabetes?",
      "What is the capital of France?",
      "zzzzqqqq",
    ]) {
      expect(searchPassages(source, q), q).toEqual([]);
    }
  });

  it("returns nothing for an empty or stopword-only query", () => {
    expect(searchPassages(source, "")).toEqual([]);
    expect(searchPassages(source, "the and of to")).toEqual([]);
  });

  it("ranks results by score, highest first", () => {
    const results = searchPassages(source, "neuropsychiatric events depression", { limit: 6 });
    const scores = results.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("respects the result limit", () => {
    expect(searchPassages(source, "asthma", { limit: 3 }).length).toBeLessThanOrEqual(3);
  });
});

describe("tokenisation", () => {
  it("strips stopwords and light plurals", () => {
    const tokens = tokenize("What are the side effects of this medication?");
    expect(tokens).toContain("side");
    expect(tokens).toContain("effect");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("what");
  });

  it("does not emit stray non-ascii artefacts", () => {
    for (const t of tokenize("Warnings — précautions, 10 mg/1")) {
      expect(t).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
