import type { SourceRecord } from "@/sources/lib/content/types";

/**
 * Deterministic retrieval over one medication's label sections.
 *
 * This is the evidence layer. Both the no-AI "Label excerpt search" mode and
 * the model-backed assistant answer from exactly these passages, which is what
 * makes citation validation possible: a passage id either came from here or it
 * was invented.
 *
 * Scoring is BM25 over passage-level chunks, plus a per-section boost when the
 * query clearly targets a known label section (e.g. "side effects" -> section
 * 6). No embeddings, no network, no nondeterminism.
 */

export interface Passage {
  /** Stable id, e.g. "adverse_reactions#2". Used as the citation key. */
  id: string;
  sectionId: string;
  sectionTitle: string;
  labelSectionRef: string;
  text: string;
}

export interface ScoredPassage extends Passage {
  score: number;
}

const MAX_CHUNK_CHARS = 850;
const MIN_CHUNK_CHARS = 180;

/** Splits on sentence boundaries, keeping label cross-references intact. */
function splitSentences(text: string): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  // Split after "." when followed by a space and a capital or digit, but not
  // inside the label's "[see Warnings and Precautions (5.1)]" cross-references
  // or after common abbreviations.
  const parts = cleaned.split(/(?<![A-Z])(?<!e\.g)(?<!i\.e)(?<!No)\.\s+(?=[A-Z0-9])/);
  const out: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // A "sentence" longer than a whole chunk (label tables, chemical names, or
    // text with no terminal punctuation) is hard-split so no passage can grow
    // unbounded. An oversized passage would blow the model's context budget and
    // make citations uselessly broad.
    if (trimmed.length > MAX_CHUNK_CHARS) {
      out.push(...hardSplit(trimmed, MAX_CHUNK_CHARS));
    } else {
      out.push(trimmed);
    }
  }
  return out;
}

/** Splits on word boundaries near `size`, never mid-word where avoidable. */
function hardSplit(text: string, size: number): string[] {
  const pieces: string[] = [];
  let remaining = text;
  while (remaining.length > size) {
    let cut = remaining.lastIndexOf(" ", size);
    if (cut <= 0) cut = size;
    pieces.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) pieces.push(remaining);
  return pieces;
}

/** Chunks one section into non-overlapping passages of bounded size. */
export function chunkSection(
  sectionId: string,
  sectionTitle: string,
  labelSectionRef: string,
  text: string
): Passage[] {
  const sentences = splitSentences(text);
  const passages: Passage[] = [];
  let buf: string[] = [];
  let bufLen = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const body = buf.join(". ").replace(/\.\.+/g, ".").trim();
    passages.push({
      id: `${sectionId}#${passages.length}`,
      sectionId,
      sectionTitle,
      labelSectionRef,
      text: body.endsWith(".") ? body : body + ".",
    });
    buf = [];
    bufLen = 0;
  };

  for (const s of sentences) {
    if (bufLen + s.length > MAX_CHUNK_CHARS && bufLen >= MIN_CHUNK_CHARS) flush();
    buf.push(s);
    bufLen += s.length + 2;
    // A single oversized fragment must not sit in the buffer accumulating more.
    if (bufLen >= MAX_CHUNK_CHARS) flush();
  }
  flush();
  return passages;
}

/** Builds the full passage set for a source record. Pure and cacheable. */
export function buildPassages(source: SourceRecord): Passage[] {
  const out: Passage[] = [];
  for (const section of source.sections) {
    out.push(...chunkSection(section.id, section.title, section.labelSectionRef, section.text));
  }
  return out;
}

const passageCache = new Map<string, Passage[]>();

export function getPassages(source: SourceRecord): Passage[] {
  const key = `${source.recordId}@${source.document.splVersion}@${source.provenance.retrievedAt}`;
  let cached = passageCache.get(key);
  if (!cached) {
    cached = buildPassages(source);
    passageCache.set(key, cached);
  }
  return cached;
}

const STOPWORDS = new Set([
  "a","an","the","is","are","was","were","be","been","being","of","to","in","on","for","with","and",
  "or","it","its","this","that","these","those","i","you","my","me","can","do","does","did","what",
  "how","when","why","should","would","could","if","about","from","as","at","by","any",
]);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

/** Very light suffix stemmer — enough to match "effects"/"effect", "warnings"/"warning". */
function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 4 && t.endsWith("ses")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

/**
 * Query intents mapped to label sections, with a per-section weight so the
 * primary section for an intent outranks its supporting sections.
 *
 * Patterns are deliberately SPECIFIC. An earlier version matched a bare
 * "what is", which boosted the indications section for *any* question
 * beginning that way — including "What is the capital of France?", which then
 * returned confident-looking label passages for a question the label does not
 * address. A boost must express real topical intent, not sentence shape.
 */
const INTENT_BOOSTS: ReadonlyArray<{ pattern: RegExp; sections: Record<string, number> }> = [
  {
    pattern: /\b(side[- ]?effect|adverse (reaction|event)|tolerat|make me feel)/i,
    sections: { adverse_reactions: 4, spl_medguide: 2 },
  },
  {
    pattern: /\b(warning|risk|danger|serious|is it safe|safety|boxed|black box)/i,
    sections: { boxed_warning: 4, warnings_and_cautions: 4, spl_medguide: 2 },
  },
  {
    pattern:
      /\b(depress|suicid|mood|behavio|mental|psychiatric|anxiet|aggress|nightmare|sleep|agitat)/i,
    sections: { boxed_warning: 4.5, warnings_and_cautions: 4.5 },
  },
  {
    pattern:
      /\b(used (for|to)|used in|what.{0,12}(treat|for)|indicat|approved (for|to)|prescribed for|what does it do|purpose)/i,
    sections: { indications_and_usage: 5, spl_medguide: 3, description: 1.5 },
  },
  {
    pattern:
      /\b(how (do|should) i take|dose|dosage|dosing|when to take|how much|take it (in|at|with))/i,
    sections: { dosage_and_administration: 4.5 },
  },
  {
    pattern: /\b(interact|other (medication|drug|medicine)|together with|combin|along with)/i,
    sections: { drug_interactions: 4.5, clinical_pharmacology: 1.5 },
  },
  {
    pattern: /\b(pregnan|breastfeed|nursing|baby|child|kid|pediatric|elderly|older adult)/i,
    sections: {
      pregnancy: 4,
      pediatric_use: 4,
      geriatric_use: 4,
      use_in_specific_populations: 3,
    },
  },
  {
    pattern: /\b(should not take|contraindicat|who (can|cannot|should not)|allerg)/i,
    sections: { contraindications: 4.5, warnings_and_cautions: 2 },
  },
  {
    pattern: /\b(overdose|overdosage|too (much|many)|took extra)/i,
    sections: { overdosage: 5 },
  },
  {
    pattern:
      /\b(how does (it|this|the medication) work|mechanism|leukotriene|what kind of (drug|medicine))/i,
    sections: { mechanism_of_action: 5, clinical_pharmacology: 2, description: 1.5 },
  },
  {
    pattern: /\b(does it (work|help)|effective|efficacy|clinical (study|studies|trial))/i,
    sections: { clinical_studies: 4, indications_and_usage: 2 },
  },
  {
    pattern: /\b(ask (my|a) (pharmacist|doctor|provider)|what should i ask|counsel)/i,
    sections: { information_for_patients: 4.5, spl_medguide: 3 },
  },
];

export interface SearchOptions {
  limit?: number;
  /** Passages scoring below this fraction of the top score are dropped. */
  relativeCutoff?: number;
}

/**
 * BM25 search over the medication's passages, with intent boosts.
 *
 * Returns an empty array when nothing matches, which callers must surface as
 * "the label does not appear to cover this" rather than answering anyway.
 */
export function searchPassages(
  source: SourceRecord,
  query: string,
  options: SearchOptions = {}
): ScoredPassage[] {
  const limit = options.limit ?? 6;
  const relativeCutoff = options.relativeCutoff ?? 0.25;

  const passages = getPassages(source);
  const queryTerms = tokenize(query);

  // Per-section boosts for whichever intents this query genuinely expresses.
  const sectionBoost = new Map<string, number>();
  for (const intent of INTENT_BOOSTS) {
    if (!intent.pattern.test(query)) continue;
    for (const [section, weight] of Object.entries(intent.sections)) {
      sectionBoost.set(section, Math.max(sectionBoost.get(section) ?? 0, weight));
    }
  }

  // Neither lexical overlap nor topical intent: the label has nothing to say.
  if (queryTerms.length === 0 && sectionBoost.size === 0) return [];

  const docTokens = passages.map((p) => tokenize(p.text));
  const avgLen = docTokens.reduce((a, d) => a + d.length, 0) / Math.max(1, docTokens.length);
  const N = passages.length;

  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const k1 = 1.5;
  const b = 0.75;

  let anyLexicalMatch = false;

  const scored: ScoredPassage[] = passages.map((p, i) => {
    const tokens = docTokens[i]!;
    const len = tokens.length;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    let bm25 = 0;
    for (const term of queryTerms) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      bm25 += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgLen)));
    }
    if (bm25 > 0) anyLexicalMatch = true;

    return { ...p, score: bm25 + (sectionBoost.get(p.sectionId) ?? 0) };
  });

  // A query whose words match nothing in the label, and which expresses no
  // topical intent, gets no results rather than boost-only noise.
  if (!anyLexicalMatch && sectionBoost.size === 0) return [];

  const ranked = scored.filter((p) => p.score > 0).sort((a, b2) => b2.score - a.score);
  if (ranked.length === 0) return [];

  const top = ranked[0]!.score;
  return ranked.filter((p) => p.score >= top * relativeCutoff).slice(0, limit);
}

/** Looks up a passage by id. Used to validate model-produced citations. */
export function findPassageById(source: SourceRecord, id: string): Passage | null {
  return getPassages(source).find((p) => p.id === id) ?? null;
}
