import type { SourceCheckResult } from "./state.js";

/**
 * Whether a refresh run should ingest, and why.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS CODE AND NOT A YAML EXPRESSION
 * ---------------------------------------------------------------------------
 * The decision used to live entirely in the workflow's `if:` line, fed by a
 * `grep` over the human-readable report:
 *
 *     if grep -qE "^checked .* changed [1-9]" refresh-report.txt
 *
 * Two problems. It could not be tested, so "scheduled runs never ingest" went
 * unnoticed for the whole life of the workflow. And it was coupled to the
 * wording of a report written for people, so rephrasing a log line would have
 * silently changed when the pipeline ingests.
 *
 * The decision is a small amount of logic with real consequences, so it lives
 * here, is exhaustively tested as a truth table, and the workflow calls it.
 * There is one definition of "should this run ingest".
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY KEPT APART
 * ---------------------------------------------------------------------------
 * "changed" and "refresh due" are different facts and neither implies the
 * other. A source can be provably unchanged and still be due because our copy
 * aged out; a source can have changed while we are not yet due to act. Both
 * are reasons to ingest, and the reason is reported so a reviewer can tell
 * which happened.
 *
 * Deciding to ingest is also NOT deciding to publish. This function's answer
 * ends at "produce a candidate for review".
 */

export type RefreshEvent = "schedule" | "workflow_dispatch";
export type RefreshMode = "check" | "refresh";

export interface TriggerInputs {
  event: RefreshEvent;
  /** Null on a scheduled run, where the input does not exist. */
  mode: RefreshMode | null;
  /** Null on a scheduled run. */
  force: boolean | null;
  /** Any source reported new content. */
  anyChanged: boolean;
  /** Any source is due regardless of change (aged out, or never retrieved). */
  anyRefreshDue: boolean;
  /** A source failed permanently, e.g. a rejected credential or a 404. */
  anyPermanentFailure: boolean;
}

export type RefreshReason =
  | "manual-force"
  | "manual-source-changed"
  | "manual-refresh-due"
  | "scheduled-source-changed"
  | "scheduled-refresh-due"
  | "check-only-requested"
  | "nothing-to-do"
  | "blocked-permanent-failure";

export interface TriggerDecision {
  /** Run ingestion and produce a candidate for review. */
  ingest: boolean;
  reason: RefreshReason;
  /** One line for the run summary. Never a promise that anything was published. */
  explanation: string;
}

const EXPLANATIONS: Record<RefreshReason, string> = {
  "manual-force":
    "Forced refresh requested. Ingesting regardless of whether any source changed.",
  "manual-source-changed": "Refresh requested and at least one source changed. Ingesting.",
  "manual-refresh-due":
    "Refresh requested and at least one source is due even though nothing changed. Ingesting.",
  "scheduled-source-changed":
    "Scheduled run: at least one source changed. Ingesting and opening a candidate for review.",
  "scheduled-refresh-due":
    "Scheduled run: at least one source is due (aged out or never retrieved). Ingesting and opening a candidate for review.",
  "check-only-requested": "Check-only run. Sources were compared; nothing was written.",
  "nothing-to-do": "No source changed and none is due. Nothing was written.",
  "blocked-permanent-failure":
    "A source failed permanently, so an ingest now would produce an inconsistent candidate. Nothing was written; the failure needs a person.",
};

function decision(ingest: boolean, reason: RefreshReason): TriggerDecision {
  return { ingest, reason, explanation: EXPLANATIONS[reason] };
}

/**
 * The truth table.
 *
 * Order matters and encodes the priorities:
 *
 *   1. An explicit check-only request always wins. Someone asking to look
 *      must never trigger a write.
 *   2. A permanent source failure blocks ingestion, even when forced. A
 *      candidate built while a source is broken would be internally
 *      inconsistent, and "force" means "ignore the no-change result", not
 *      "ignore that a source is down".
 *   3. Force ingests.
 *   4. Otherwise, changed or due ingests - on a schedule exactly as on a
 *      manual run. That equivalence is the point: the scheduled arm used to
 *      be excluded entirely, which is why nothing was ever ingested
 *      automatically.
 */
export function decideRefresh(input: TriggerInputs): TriggerDecision {
  const manual = input.event === "workflow_dispatch";

  if (manual && input.mode !== "refresh") return decision(false, "check-only-requested");

  if (input.anyPermanentFailure) return decision(false, "blocked-permanent-failure");

  if (manual && input.force === true) return decision(true, "manual-force");

  if (input.anyChanged) {
    return decision(true, manual ? "manual-source-changed" : "scheduled-source-changed");
  }
  if (input.anyRefreshDue) {
    return decision(true, manual ? "manual-refresh-due" : "scheduled-refresh-due");
  }
  return decision(false, "nothing-to-do");
}

/** Reads the facts `decideRefresh` needs out of a completed check run. */
export function triggerFactsFrom(results: SourceCheckResult[]): Pick<
  TriggerInputs,
  "anyChanged" | "anyRefreshDue" | "anyPermanentFailure"
> {
  return {
    anyChanged: results.some((r) => r.outcome === "changed"),
    anyRefreshDue: results.some((r) => r.refreshDue === true),
    // A retryable blip is not a blocker; it should simply be retried. Only a
    // permanent failure - a rejected credential, a document that moved - means
    // a person has to look before anything is ingested.
    anyPermanentFailure: results.some((r) => r.outcome === "failed-permanent"),
  };
}
