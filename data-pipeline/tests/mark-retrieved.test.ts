import { describe, it, expect } from "vitest";
import { markRetrieved, type PersistedState } from "@pipeline/refresh/run.js";
import type { RefreshRun, SourceCheckResult, SourceVersion } from "@pipeline/refresh/state.js";
import { triggerFactsFrom } from "@pipeline/refresh/decide.js";

/**
 * The retrieval baseline.
 *
 * `refreshDue` is derived from `lastSuccessfulRetrieval`, and until this
 * function existed nothing ever wrote it: `runChecks` carried it forward
 * unchanged and the ingest/export commands never touched the state file. So
 * every source was "never retrieved" forever, and a scheduled run acting on
 * refreshDue would have regenerated and re-pushed its PR every day.
 *
 * These tests use canned check results and an in-memory state. No network,
 * no real state file.
 */

const v = (version: string): SourceVersion => ({
  version,
  publishedDate: null,
  etag: null,
  lastModified: null,
  contentHash: null,
  method: "api-version-field",
});

function result(sourceId: string, outcome: SourceCheckResult["outcome"], version: string | null): SourceCheckResult {
  return {
    sourceId,
    label: sourceId,
    stage: "discovered",
    outcome,
    current: version ? v(version) : null,
    previous: null,
    checkedAt: "2026-09-20T07:20:00.000Z",
    lastSuccessfulCheck: null,
    lastSuccessfulRetrieval: null,
    httpStatus: outcome.startsWith("failed") ? 500 : 200,
    detail: "",
    maxAcceptableAgeHours: 24,
    stale: true,
    refreshDue: true,
    refreshDueReason: "never-retrieved",
    upcoming: null,
  };
}

function runOf(sources: SourceCheckResult[]): RefreshRun {
  return {
    runId: "test",
    startedAt: "2026-09-20T07:20:00.000Z",
    finishedAt: "2026-09-20T07:20:01.000Z",
    mode: "check-only",
    sources,
    counts: { checked: sources.length, changed: 0, unchanged: 0, failed: 0, notImplemented: 0, skipped: 0 },
    reviewBlockers: [],
    candidateManifestId: null,
    lastKnownGoodManifestId: null,
  };
}

const NOW = "2026-09-20T07:25:00.000Z";

function harness(sources: SourceCheckResult[], initial: PersistedState = {}) {
  let saved: PersistedState | null = null;
  const state: PersistedState = structuredClone(initial);
  const deps = {
    check: async () => runOf(sources),
    load: async () => state,
    save: async (s: PersistedState) => {
      saved = structuredClone(s);
    },
    now: () => NOW,
  };
  return { deps, saved: () => saved };
}

describe("markRetrieved", () => {
  it("sets lastSuccessfulRetrieval and the observed version for every source that checked cleanly", async () => {
    const h = harness([result("openfda", "no-change", "2026-09-18"), result("dailymed", "changed", "v2")]);
    const { marks } = await markRetrieved({}, h.deps);

    expect(marks.map((m) => [m.sourceId, m.marked])).toEqual([
      ["openfda", true],
      ["dailymed", true],
    ]);
    const saved = h.saved()!;
    expect(saved.openfda!.lastSuccessfulRetrieval).toBe(NOW);
    expect(saved.openfda!.lastSuccessfulCheck).toBe(NOW);
    expect(saved.openfda!.version?.version).toBe("2026-09-18");
    expect(saved.dailymed!.lastSuccessfulRetrieval).toBe(NOW);
    expect(saved.dailymed!.version?.version).toBe("v2");
  });

  /** A failed check must never advance a timestamp. */
  it("leaves a source that failed its check exactly as it was", async () => {
    const before: PersistedState = {
      rxnav: { version: v("old"), lastSuccessfulCheck: "2026-09-01T00:00:00.000Z", lastSuccessfulRetrieval: "2026-08-01T00:00:00.000Z" },
    };
    const h = harness(
      [result("openfda", "no-change", "2026-09-18"), result("rxnav", "failed-retryable", null)],
      before
    );
    const { marks } = await markRetrieved({}, h.deps);

    const rx = marks.find((m) => m.sourceId === "rxnav")!;
    expect(rx.marked).toBe(false);
    expect(rx.reason).toBe("check-failed");
    expect(rx.lastSuccessfulRetrieval).toBe("2026-08-01T00:00:00.000Z");
    expect(h.saved()!.rxnav).toEqual(before.rxnav);
    // The healthy source still advances; one failure does not hold the others hostage.
    expect(h.saved()!.openfda!.lastSuccessfulRetrieval).toBe(NOW);
  });

  it("treats a permanent failure the same way", async () => {
    const h = harness([result("cms-part-d", "failed-permanent", null)]);
    const { marks } = await markRetrieved({}, h.deps);
    expect(marks[0]).toMatchObject({ marked: false, reason: "check-failed", lastSuccessfulRetrieval: null });
    expect(h.saved()!["cms-part-d"]).toBeUndefined();
  });

  it("does not mark a source that was not actually checked", async () => {
    const h = harness([result("vamedicaid-landing", "not-implemented", null), result("openfda", "skipped-not-due", null)]);
    const { marks } = await markRetrieved({}, h.deps);
    for (const m of marks) {
      expect(m.marked).toBe(false);
      expect(m.reason).toBe("not-checked");
    }
    expect(h.saved()).toEqual({});
  });

  it("dry-run computes the marks but writes nothing", async () => {
    const h = harness([result("openfda", "no-change", "x")]);
    const { marks } = await markRetrieved({ dryRun: true }, h.deps);
    expect(marks[0]!.marked).toBe(true);
    expect(h.saved()).toBeNull();
  });

  it("asks the checker for a dry run, so recording the baseline cannot itself write check state twice", async () => {
    let seen: unknown = null;
    const h = harness([result("openfda", "no-change", "x")]);
    await markRetrieved({ only: ["openfda"] }, {
      ...h.deps,
      check: async (opts) => {
        seen = opts;
        return runOf([result("openfda", "no-change", "x")]);
      },
    });
    expect(seen).toEqual({ mode: "check-only", only: ["openfda"], dryRun: true });
  });

  /**
   * The point of all of this: after a mark, the same sources are no longer
   * due, so the next scheduled decision is "nothing-to-do" rather than
   * another regeneration.
   */
  it("clears refreshDue for the next decision", async () => {
    // Before: never retrieved -> due.
    const before = [result("openfda", "no-change", "2026-09-18")];
    expect(triggerFactsFrom(before).anyRefreshDue).toBe(true);

    // After a mark, a subsequent check of an unchanged source is not due.
    const h = harness(before);
    await markRetrieved({}, h.deps);
    const after: SourceCheckResult = {
      ...before[0]!,
      lastSuccessfulRetrieval: h.saved()!.openfda!.lastSuccessfulRetrieval,
      stale: false,
      refreshDue: false,
      refreshDueReason: null,
    };
    expect(triggerFactsFrom([after])).toEqual({ anyChanged: false, anyRefreshDue: false, anyPermanentFailure: false });
  });
});
