import { z } from "zod";
import type { Passage } from "@/sources/lib/retrieval";

/**
 * Evidence selection: the model picks passages, the server supplies the text.
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 * The orchestrator asked a model to WRITE the answer and then tried to verify
 * it afterwards, by matching citation markers against the passages it had been
 * given. Verification-after-the-fact has a hole that cannot be closed by
 * tightening the check: prose carrying NO citation markers at all produced
 * `citations: []` and `rejected: []`, which satisfied neither branch of the
 * withholding rule, so unsourced model prose about a medicine shipped as an
 * "assistant" answer. Claims sitting beside one good citation shipped too.
 *
 * So for this flow the model no longer writes medical text. It returns
 * IDENTIFIERS. The server resolves them against the exact passages it built
 * and returns its own stored source text. There is nothing to verify because
 * nothing was authored: the words a reader sees came from the label.
 *
 * The model cannot supply answer text, source URLs, medication identity,
 * strength, citation metadata or recommendations. All of those are server-held.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT CLAIM
 * ---------------------------------------------------------------------------
 * A model choosing a passage is not proof that the passage answers the
 * question. It narrows; it does not adjudicate. `insufficient-evidence`
 * therefore remains reachable and is not a failure state.
 */

/**
 * The only thing the model is allowed to return.
 *
 * `.strict()` so an adapter that starts volunteering an `answer` field fails
 * validation instead of having it quietly ignored - the day that field appears
 * is the day someone renders it.
 */
export const PassageSelectionSchema = z
  .object({
    /** Composite passage identifiers, exactly as supplied. */
    passageIds: z.array(z.string().min(1).max(200)).max(6),
    /** The model's own report that nothing supplied is relevant. */
    noRelevantEvidence: z.boolean(),
  })
  .strict();

export type PassageSelection = z.infer<typeof PassageSelectionSchema>;

/**
 * A passage identifier that cannot collide across products or label versions.
 *
 * A bare `adverse_reactions#2` is stable only within one record. Two label
 * versions of the same product both have one, and so does every other product,
 * so a model returning an ID from an obsolete version - or from another
 * medicine's record - would resolve against the current one and silently
 * answer from the wrong text.
 *
 * Composite identity makes that impossible to express: an ID that does not
 * name this exact record and version simply is not in the eligible map.
 */
export function compositePassageId(
  recordId: string,
  splVersion: string,
  passageId: string
): string {
  return `${recordId}@v${splVersion}#${passageId}`;
}

/** An eligible passage: server-built, server-scoped, server-owned text. */
export interface EligiblePassage extends Passage {
  /** The composite id the model is shown and must return. */
  compositeId: string;
}

export type SelectionResolution =
  | { status: "source-excerpts"; passages: EligiblePassage[] }
  | {
      status: "insufficient-evidence";
      passages: [];
      /** Why, for a controlled template. Never shown as the model's words. */
      reason:
        | "model-reported-none"
        | "empty-selection"
        | "unknown-passage-id"
        | "no-eligible-passages";
    };

/**
 * Resolves a model selection against the passages the server actually offered.
 *
 * Strict by construction. Any identifier that is not in the eligible set
 * invalidates the WHOLE selection rather than being dropped, because a model
 * that invented one of six ids has demonstrated it is guessing, and the
 * remaining five carry no more warrant than the one that was caught. Partial
 * trust in a result that is provably part-fabricated is how a fabricated
 * passage reaches a reader.
 *
 * Duplicates are collapsed before the check so a repeated id is not treated as
 * two selections, and order is preserved so the reader sees the model's
 * ranking rather than the server's.
 */
export function resolveSelection(
  selection: PassageSelection,
  eligiblePassages: EligiblePassage[]
): SelectionResolution {
  if (eligiblePassages.length === 0) {
    return { status: "insufficient-evidence", passages: [], reason: "no-eligible-passages" };
  }

  const byId = new Map(eligiblePassages.map((p) => [p.compositeId, p]));
  const ids = [...new Set(selection.passageIds)];

  if (selection.noRelevantEvidence) {
    return { status: "insufficient-evidence", passages: [], reason: "model-reported-none" };
  }
  if (ids.length === 0) {
    return { status: "insufficient-evidence", passages: [], reason: "empty-selection" };
  }
  if (ids.some((id) => !byId.has(id))) {
    return { status: "insufficient-evidence", passages: [], reason: "unknown-passage-id" };
  }

  return {
    status: "source-excerpts",
    // Non-null asserted: every id was just proven present.
    passages: ids.map((id) => byId.get(id)!),
  };
}

/**
 * Parses whatever the model returned.
 *
 * Tolerates a fenced code block, because models wrap JSON in one and rejecting
 * that would send a working selection to the fallback. Tolerates nothing else:
 * a trailing sentence, a missing field or an extra key is a failed parse.
 */
export function parseSelection(raw: string): PassageSelection | null {
  for (const candidate of jsonCandidates(raw)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const parsed = PassageSelectionSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * The substrings of a model reply that might be the selection object.
 *
 * Real models wrap JSON in a fence, and sometimes precede it with a line of
 * prose however firmly the prompt says not to. Rejecting those would send a
 * perfectly good selection to the deterministic fallback, so the whole feature
 * would quietly degrade to plain retrieval with nobody noticing.
 *
 * Extracting an object from surrounding prose is safe HERE, and only here,
 * because the security property does not live in this function. Whatever comes
 * out is still only a list of ids, and `resolveSelection` checks every one of
 * them against the passages the server itself built. Prose around the JSON is
 * discarded, never rendered.
 */
function jsonCandidates(raw: string): string[] {
  const out: string[] = [];
  const text = raw.trim();
  if (text.length === 0) return out;

  out.push(text);

  // A fenced block, with or without a language tag.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) out.push(fenced[1].trim());

  // The first balanced {...}, for a reply with a preamble.
  const start = text.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          out.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Controlled explanations for every insufficient-evidence reason.
 *
 * Generated here, never taken from the model. A model-supplied refusal reason
 * rendered as-is is model-authored medical text arriving through the one door
 * this design closed.
 *
 * The wording keeps apart facts that read alike and mean opposite things:
 * "nothing in the material checked addresses this" is not "the label says this
 * does not happen", and neither is "the label contains no information".
 */
export function insufficientEvidenceExplanation(
  reason: Exclude<SelectionResolution, { status: "source-excerpts" }>["reason"],
  productName: string
): string {
  switch (reason) {
    case "no-eligible-passages":
      return `No passage from the FDA label for ${productName} was eligible to answer this. That is a statement about what was checked, not about the medicine.`;
    case "model-reported-none":
    case "empty-selection":
      return `No relevant passage was found in the material checked here for ${productName}. The label may still address this elsewhere, and a pharmacist can answer what it does not cover.`;
    case "unknown-passage-id":
      // Deliberately does not repeat what the model returned.
      return `The assistant referred to label text that was not among the passages provided, so its selection was discarded. Nothing it suggested is shown below.`;
  }
}
