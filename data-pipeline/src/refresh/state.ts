/**
 * The refresh state machine.
 *
 * A refresh moves through explicit stages, and the whole point of naming them
 * is that failure at one stage must not look like success at another:
 *
 *   discovered -> fetched -> parsed -> validated -> candidate-export
 *              -> review-required | ready-for-publication -> published
 *
 * THE DISTINCTION THAT MATTERS MOST
 *
 * "The source did not change" and "we could not reach the source" are both
 * non-events, and both leave the exports untouched. They are completely
 * different facts, and collapsing them produces the worst failure this
 * pipeline can have: a stale export presented as freshly confirmed.
 *
 * So `no-change` and `failed` are separate outcomes, and the manifest records
 * `lastSuccessfulCheck` and `lastSuccessfulRetrieval` separately from the run
 * timestamp. A check that failed advances neither.
 */

export type RefreshStage =
  /** The source and its current version identifier were located. */
  | "discovered"
  /** Bytes were retrieved. */
  | "fetched"
  /** The bytes parsed into the expected structure. */
  | "parsed"
  /** Structural and semantic invariants passed. */
  | "validated"
  /** A candidate export was written to staging. */
  | "candidate-export"
  /** A human must look before this can be published. */
  | "review-required"
  /** Validated, no review blockers; publication may proceed. */
  | "ready-for-publication"
  /** Live in the committed export tree. */
  | "published";

/**
 * Why a refresh stopped.
 *
 * `no-change` is a SUCCESS: the source was reached and is identical. It is not
 * a failure and must never be reported as one.
 */
export type RefreshOutcome =
  | "no-change"
  | "changed"
  | "failed-retryable"
  | "failed-permanent"
  /** The adapter exists but was deliberately not run this pass. */
  | "skipped-not-due"
  /** No adapter exists. NOT a retrieval failure. */
  | "not-implemented";

/**
 * Whether a failure is worth retrying.
 *
 * Retrying a 401 forever burns a rate limit and hides a configuration problem
 * behind noise, so authentication and schema failures are terminal for the run
 * and surface as `failed-permanent`.
 */
export function classifyFailure(status: number | null, detail: string): RefreshOutcome {
  if (status === null) {
    // Network-level: transient far more often than not.
    return /abort|timeout|ENOTFOUND|ECONNRESET|EAI_AGAIN/i.test(detail)
      ? "failed-retryable"
      : "failed-retryable";
  }
  // Authentication, authorisation and "gone" are configuration facts, not luck.
  if (status === 401 || status === 403 || status === 410) return "failed-permanent";
  if (status === 404) return "failed-permanent";
  if (status === 429) return "failed-retryable";
  if (status >= 500) return "failed-retryable";
  if (status >= 400) return "failed-permanent";
  return "failed-retryable";
}

/**
 * A source's identity at a point in time.
 *
 * Whatever the source gives us that changes when its content changes: an
 * explicit version string, an ETag, a Last-Modified date, or a content hash.
 * Recorded together because different sources offer different subsets and a
 * missing one must not look like a match.
 */
export interface SourceVersion {
  /** Publisher's own version label, when it has one. */
  version: string | null;
  /** Publisher's stated publication or modification date. */
  publishedDate: string | null;
  /** HTTP validators, when the server offers them. */
  etag: string | null;
  lastModified: string | null;
  /** sha256 of the bytes, when we fetched them. */
  contentHash: string | null;
  /** How the identity was established, for the report. */
  method: "api-version-field" | "http-validator" | "content-hash" | "document-catalogue" | "none";
}

export function versionsMatch(a: SourceVersion | null, b: SourceVersion | null): boolean {
  if (!a || !b) return false;
  // Strongest signal first. Any ONE definite match is enough.
  if (a.contentHash && b.contentHash) return a.contentHash === b.contentHash;
  if (a.etag && b.etag) return a.etag === b.etag;
  if (a.version && b.version) return a.version === b.version;
  if (a.lastModified && b.lastModified) return a.lastModified === b.lastModified;
  if (a.publishedDate && b.publishedDate) return a.publishedDate === b.publishedDate;
  return false;
}

/** The result of checking one source. */
export interface SourceCheckResult {
  sourceId: string;
  /** Human label for the report. */
  label: string;
  stage: RefreshStage;
  outcome: RefreshOutcome;
  /** What the source reports now. Null when the check failed. */
  current: SourceVersion | null;
  /** What the last successful check recorded. */
  previous: SourceVersion | null;
  /** When this check ran. NOT evidence the source is fresh. */
  checkedAt: string;
  /**
   * When we last REACHED this source successfully. Carried forward on
   * failure, so a run summary cannot imply freshness it does not have.
   */
  lastSuccessfulCheck: string | null;
  /** When we last actually ingested content from it. */
  lastSuccessfulRetrieval: string | null;
  /** HTTP status, when there was one. */
  httpStatus: number | null;
  /** Safe, redacted description of what happened. */
  detail: string;
  /** How long the adapter considers this source's data acceptable. */
  maxAcceptableAgeHours: number;
  /** True when our copy is older than the maximum acceptable age. */
  stale: boolean;
  /**
   * Whether a full refresh should run.
   *
   * Deliberately separate from `outcome`. A source can be UNCHANGED and still
   * be due for refresh because our copy aged out or `--force` was passed.
   * Folding staleness into "changed" would report a source as having changed
   * when it demonstrably had not - which is the same class of lie as reporting
   * a failed check as fresh.
   */
  refreshDue: boolean;
  /** Why a refresh is due, when it is. */
  refreshDueReason: "source-changed" | "max-age-exceeded" | "never-retrieved" | "forced" | null;
  /**
   * Set when the source publishes something effective in the future.
   * Upcoming data is retained, never activated early.
   */
  upcoming: { version: string; effectiveDate: string } | null;
}

/** Aggregate of one refresh run. */
export interface RefreshRun {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  /** check-only never writes; refresh may produce candidates. */
  mode: "check-only" | "refresh" | "force-refresh";
  sources: SourceCheckResult[];
  counts: {
    checked: number;
    changed: number;
    unchanged: number;
    failed: number;
    notImplemented: number;
    skipped: number;
  };
  /** Set when any source needs a human before publication. */
  reviewBlockers: string[];
  /** The manifest id this run produced, if any. */
  candidateManifestId: string | null;
  /** The last manifest known to be good, for rollback. */
  lastKnownGoodManifestId: string | null;
}

export function emptyCounts(): RefreshRun["counts"] {
  return { checked: 0, changed: 0, unchanged: 0, failed: 0, notImplemented: 0, skipped: 0 };
}

export function tallyCounts(results: SourceCheckResult[]): RefreshRun["counts"] {
  const c = emptyCounts();
  for (const r of results) {
    c.checked++;
    switch (r.outcome) {
      case "changed":
        c.changed++;
        break;
      case "no-change":
        c.unchanged++;
        break;
      case "failed-retryable":
      case "failed-permanent":
        c.failed++;
        break;
      case "not-implemented":
        c.notImplemented++;
        break;
      case "skipped-not-due":
        c.skipped++;
        break;
    }
  }
  return c;
}
