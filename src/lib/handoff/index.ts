/**
 * Professional handoff: preserving the unresolved question.
 *
 * The failure this fixes: someone asks something the label does not answer,
 * gets "I can't answer that", taps "Connect with a healthcare provider" — and
 * the thing they actually wanted to know evaporates. They arrive at the
 * provider step holding six generic questions and not their own.
 *
 * The question is carried forward verbatim, shown first, and marked as the
 * reason they are here.
 *
 * PRIVACY: this is local-only state. The question is never transmitted, never
 * stored, and never attached to an analytics event. It lives in React state
 * until the sheet closes. There is no recipient, so there is nothing to
 * confirm before sending — see docs/INTEGRATIONS.md for where a
 * confirm-before-send step belongs if a referral integration is ever added.
 */

/** Why the question is still open. Drives the explanatory line in the UI. */
export type UnresolvedReason =
  /** Retrieval found nothing in the label addressing it. */
  | "not-covered"
  /** The assistant was configured but failed. */
  | "assistant-unavailable"
  /** Answered from label text, but the user still wanted a person. */
  | "answered-but-escalated"
  /** They opened the provider step directly, with no question pending. */
  | "user-initiated";

export interface UnresolvedQuestion {
  /** The user's own words, unmodified. */
  question: string;
  reason: UnresolvedReason;
}

/** One line explaining to the user why this question is being carried over. */
export function handoffReasonLabel(reason: UnresolvedReason): string {
  switch (reason) {
    case "not-covered":
      return "The FDA label does not cover this, so it is a good question for a person.";
    case "assistant-unavailable":
      return "The assistant could not answer this, so it is worth asking directly.";
    case "answered-but-escalated":
      return "You asked this just now. Bringing it with you keeps the thread.";
    case "user-initiated":
      return "";
  }
}

/**
 * Normalises a carried question into something worth reading aloud in a
 * consulting room, without changing what was asked.
 *
 * Deliberately conservative: it trims, collapses whitespace, caps length and
 * ensures terminal punctuation. It does NOT rewrite, expand, or "improve" the
 * question — putting words in the patient's mouth would defeat the purpose.
 */
export function normaliseQuestion(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "";
  const capped = collapsed.length > 300 ? collapsed.slice(0, 297).trimEnd() + "…" : collapsed;
  return /[.?!…]$/.test(capped) ? capped : capped + "?";
}

/** The generic prompts offered alongside whatever the user actually asked. */
export function baselineQuestions(productName: string): string[] {
  return [
    `Is ${productName} a good fit for my situation, given my history?`,
    "This medication has a boxed warning about mood and behaviour changes. What should I watch for?",
    "Are there alternatives I should consider first?",
    "How will we know whether it is working?",
    "What should I do if I notice side effects?",
    "How does this interact with the other medicines I take?",
  ];
}

/**
 * Builds the question list for the handoff.
 *
 * The carried question always comes FIRST — it is the reason the person is
 * here. Baseline prompts follow, with any near-duplicate of the carried
 * question removed so the list does not read as repetitive.
 */
export function buildHandoffQuestions(
  productName: string,
  unresolved: UnresolvedQuestion | null
): string[] {
  const baseline = baselineQuestions(productName);
  if (!unresolved) return baseline;

  const carried = normaliseQuestion(unresolved.question);
  if (carried.length === 0) return baseline;

  const key = comparisonKey(carried);
  const deduped = baseline.filter((q) => comparisonKey(q) !== key);
  return [carried, ...deduped];
}

/** Loose key for duplicate detection: letters and digits only, lowercased. */
function comparisonKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Maps an answer mode to a handoff reason.
 *
 * Only genuinely unresolved states carry a question forward automatically. An
 * urgent/crisis answer never does: that person needs help now, not a question
 * list, and routing them into a provider-preparation flow would be wrong.
 */
export function reasonForAnswerMode(
  mode:
    | "assistant"
    | "label-excerpts"
    | "not-covered"
    | "needs-clarification"
    | "unavailable"
    | "urgent"
): UnresolvedReason | null {
  switch (mode) {
    case "not-covered":
      return "not-covered";
    // An unresolved pronoun ("is that the same for her?") is not a question a
    // clinician can act on. Carrying it would hand over noise.
    case "needs-clarification":
      return null;
    case "unavailable":
      return "assistant-unavailable";
    case "assistant":
    case "label-excerpts":
      return "answered-but-escalated";
    case "urgent":
      return null;
  }
}
