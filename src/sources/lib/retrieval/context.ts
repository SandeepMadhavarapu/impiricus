import { tokenize } from "./index";

/**
 * Conversation-aware retrieval queries.
 *
 * The defect this fixes: retrieval ran on the latest message alone, so a
 * follow-up that depends on what came before either missed real evidence or —
 * worse — matched on noise words and returned a confident wrong section.
 *
 * Measured against the real label before this existed:
 *   "Are any of those permanent?"  -> 0 hits, answered "not covered", even
 *                                    though the label says NP symptoms
 *                                    sometimes persist after discontinuation.
 *   "Is that the same for her?"    -> 3 confident hits in Dosage and
 *                                    Administration, from a pronoun-only query.
 *
 * The fix is deliberately narrow: context is merged ONLY when the current
 * message cannot stand on its own. A self-contained question is never diluted
 * with the previous topic, because "what are the warnings?" after a question
 * about side effects should retrieve warnings, not both.
 */

/**
 * Words that point at something said EARLIER rather than naming it.
 *
 * Deliberately excludes "this", "it", "its", "these" and "one". On a page about
 * a single fixed medication those refer to the drug itself, which is never
 * ambiguous — treating them as anaphors made self-contained questions like
 * "Can I take this while pregnant?" demand clarification.
 */
const ANAPHORS = [
  "that",
  "those",
  "they",
  "them",
  "their",
  "he",
  "him",
  "his",
  "she",
  "her",
  "ones",
  "same",
  "either",
  "both",
  "each",
];

const ANAPHOR_PATTERN = new RegExp(
  `\\b(${ANAPHORS.map((a) => a.replace(/ /g, "\\s+")).join("|")})\\b`,
  "i"
);

/** Follow-up openers that signal continuation of the previous topic. */
const CONTINUATION_PATTERN =
  /^\s*(and|but|what about|how about|ok(ay)?[, ]|also|then|so)\b/i;

export interface ContextualQuery {
  /** The text actually handed to the retriever. */
  text: string;
  /** True when prior turns were merged in. */
  usedContext: boolean;
  /** True when the message cannot stand alone. */
  isElliptical: boolean;
  /**
   * True when the message needs context but none is available — the caller
   * should ask what the person means rather than guess.
   */
  needsClarification: boolean;
}

/**
 * Decides whether a message can stand on its own as a search query.
 *
 * Two independent signals, either sufficient:
 *   - it contains an anaphor or a continuation opener, or
 *   - it carries NO content-bearing tokens at all after stopword removal.
 *
 * The token threshold is zero, not one or two. Stopword removal is aggressive:
 * "What are the warnings?" reduces to a single token yet is perfectly
 * self-contained, so anything stricter forces needless clarification.
 */
export function isElliptical(message: string): boolean {
  if (ANAPHOR_PATTERN.test(message)) return true;
  if (CONTINUATION_PATTERN.test(message)) return true;
  return tokenize(message).length === 0;
}

/**
 * Builds the retrieval query for a message given the conversation so far.
 *
 * `priorUserMessages` should be earlier USER turns, oldest first. Assistant
 * text is deliberately excluded: it is largely boilerplate ("Here are the
 * sections of the label...") and would swamp the real topic.
 */
export function buildContextualQuery(
  message: string,
  priorUserMessages: string[] = []
): ContextualQuery {
  const elliptical = isElliptical(message);

  if (!elliptical) {
    return {
      text: message,
      usedContext: false,
      isElliptical: false,
      needsClarification: false,
    };
  }

  // Most recent prior turns that carry actual topic terms.
  const contextTerms: string[] = [];
  for (let i = priorUserMessages.length - 1; i >= 0 && contextTerms.length < 8; i--) {
    const prior = priorUserMessages[i];
    if (!prior || isElliptical(prior)) continue;
    for (const token of tokenize(prior)) {
      if (!contextTerms.includes(token)) contextTerms.push(token);
    }
  }

  if (contextTerms.length === 0) {
    // Nothing to anchor to. Retrieving anyway is how "Is that the same for
    // her?" ended up confidently pointing at the dosage section.
    return {
      text: message,
      usedContext: false,
      isElliptical: true,
      needsClarification: true,
    };
  }

  // The current message stays first so its own terms keep their weight; the
  // recovered topic is appended once.
  return {
    text: `${message} ${contextTerms.join(" ")}`,
    usedContext: true,
    isElliptical: true,
    needsClarification: false,
  };
}

/** Extracts prior user turns from a chat history, oldest first. */
export function priorUserMessages(
  history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>
): string[] {
  return history.filter((t) => t.role === "user").map((t) => t.content);
}
