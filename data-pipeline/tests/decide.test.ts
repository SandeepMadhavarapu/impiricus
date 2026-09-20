import { describe, it, expect } from "vitest";
import {
  decideRefresh,
  triggerFactsFrom,
  type TriggerInputs,
  type RefreshEvent,
  type RefreshMode,
} from "@pipeline/refresh/decide.js";
import type { SourceCheckResult, SourceVersion } from "@pipeline/refresh/state.js";

/**
 * The trigger truth table.
 *
 * The decision used to live only in a workflow `if:` expression fed by a grep
 * over a human-readable report. Nothing could test it, which is how "the
 * scheduled run can never ingest" survived for the whole life of the workflow
 * while every run reported green.
 *
 * Expected values below are written from the stated policy, not produced by
 * calling the function under test.
 */

const base: TriggerInputs = {
  event: "schedule",
  mode: null,
  force: null,
  anyChanged: false,
  anyRefreshDue: false,
  anyPermanentFailure: false,
};

describe("scheduled runs", () => {
  it("ingests when a source changed", () => {
    const d = decideRefresh({ ...base, anyChanged: true });
    expect(d.ingest).toBe(true);
    expect(d.reason).toBe("scheduled-source-changed");
  });

  /**
   * A source can be provably unchanged and still be due, because our copy aged
   * out or was never retrieved. The old workflow ignored this entirely.
   */
  it("ingests when a source is due even though nothing changed", () => {
    const d = decideRefresh({ ...base, anyRefreshDue: true });
    expect(d.ingest).toBe(true);
    expect(d.reason).toBe("scheduled-refresh-due");
  });

  it("does nothing when nothing changed and nothing is due", () => {
    const d = decideRefresh(base);
    expect(d.ingest).toBe(false);
    expect(d.reason).toBe("nothing-to-do");
  });

  /** The regression that started all of this. */
  it("is not gated on being a manual run", () => {
    const scheduled = decideRefresh({ ...base, anyChanged: true });
    const manual = decideRefresh({
      ...base,
      event: "workflow_dispatch",
      mode: "refresh",
      force: false,
      anyChanged: true,
    });
    expect(scheduled.ingest).toBe(manual.ingest);
    expect(scheduled.ingest).toBe(true);
  });
});

describe("manual runs", () => {
  const manual = (over: Partial<TriggerInputs> = {}): TriggerInputs => ({
    ...base,
    event: "workflow_dispatch",
    mode: "refresh",
    force: false,
    ...over,
  });

  it("check-only never ingests, whatever the sources say", () => {
    for (const over of [
      { anyChanged: true },
      { anyRefreshDue: true },
      { anyChanged: true, anyRefreshDue: true },
    ]) {
      const d = decideRefresh(manual({ mode: "check", ...over }));
      expect(d.ingest, `check-only ingested with ${JSON.stringify(over)}`).toBe(false);
      expect(d.reason).toBe("check-only-requested");
    }
  });

  it("treats a null mode as check-only rather than as a refresh", () => {
    const d = decideRefresh(manual({ mode: null, anyChanged: true }));
    expect(d.ingest).toBe(false);
    expect(d.reason).toBe("check-only-requested");
  });

  it("force ingests when nothing changed and nothing is due", () => {
    const d = decideRefresh(manual({ force: true }));
    expect(d.ingest).toBe(true);
    expect(d.reason).toBe("manual-force");
  });

  it("ingests on change and on refresh-due", () => {
    expect(decideRefresh(manual({ anyChanged: true })).reason).toBe("manual-source-changed");
    expect(decideRefresh(manual({ anyRefreshDue: true })).reason).toBe("manual-refresh-due");
  });
});

describe("a permanent source failure blocks ingestion", () => {
  /**
   * "Force" means "ignore the no-change result", not "ignore that a source is
   * down". A candidate built while one source is broken is internally
   * inconsistent, and publishing it would mix a fresh release with a stale one.
   */
  it("blocks even a forced manual refresh", () => {
    const d = decideRefresh({
      ...base,
      event: "workflow_dispatch",
      mode: "refresh",
      force: true,
      anyChanged: true,
      anyPermanentFailure: true,
    });
    expect(d.ingest).toBe(false);
    expect(d.reason).toBe("blocked-permanent-failure");
  });

  it("blocks a scheduled run that would otherwise ingest", () => {
    expect(decideRefresh({ ...base, anyChanged: true, anyPermanentFailure: true }).ingest).toBe(false);
    expect(decideRefresh({ ...base, anyRefreshDue: true, anyPermanentFailure: true }).ingest).toBe(false);
  });

  it("does not turn a check-only request into a failure report", () => {
    const d = decideRefresh({
      ...base,
      event: "workflow_dispatch",
      mode: "check",
      anyPermanentFailure: true,
    });
    expect(d.reason).toBe("check-only-requested");
  });
});

/** Every combination, so no case is reachable without a stated expectation. */
describe("exhaustive truth table", () => {
  const events: RefreshEvent[] = ["schedule", "workflow_dispatch"];
  const modes: Array<RefreshMode | null> = ["check", "refresh", null];
  const bools = [false, true];

  it("covers all 96 combinations with a deterministic, explained answer", () => {
    let count = 0;
    for (const event of events)
      for (const mode of modes)
        for (const force of bools)
          for (const anyChanged of bools)
            for (const anyRefreshDue of bools)
              for (const anyPermanentFailure of bools) {
                const input: TriggerInputs = {
                  event,
                  mode: event === "schedule" ? null : mode,
                  force: event === "schedule" ? null : force,
                  anyChanged,
                  anyRefreshDue,
                  anyPermanentFailure,
                };
                const d = decideRefresh(input);
                count++;

                // Independent restatement of the policy, not a call to the
                // function under test.
                const manual = event === "workflow_dispatch";
                const expectIngest = manual && input.mode !== "refresh"
                  ? false
                  : anyPermanentFailure
                    ? false
                    : manual && force
                      ? true
                      : anyChanged || anyRefreshDue;

                expect(d.ingest, `unexpected for ${JSON.stringify(input)}`).toBe(expectIngest);
                expect(d.explanation.length).toBeGreaterThan(0);
                // No explanation may claim anything was published.
                expect(d.explanation.toLowerCase()).not.toMatch(/\bpublished\b|\bmerged\b/);
              }
    expect(count).toBe(96);
  });
});

/* ------------------------------------------------------------- fact reading */

function version(): SourceVersion {
  return {
    version: "v1",
    publishedDate: null,
    etag: null,
    lastModified: null,
    contentHash: null,
    method: "api-version-field",
  };
}

function result(over: Partial<SourceCheckResult> = {}): SourceCheckResult {
  return {
    sourceId: "openfda",
    label: "openFDA",
    stage: "discovered",
    outcome: "no-change",
    current: version(),
    previous: version(),
    checkedAt: "2026-09-20T00:00:00.000Z",
    lastSuccessfulCheck: "2026-09-20T00:00:00.000Z",
    lastSuccessfulRetrieval: "2026-09-19T00:00:00.000Z",
    httpStatus: 200,
    detail: "unchanged",
    maxAcceptableAgeHours: 168,
    stale: false,
    refreshDue: false,
    refreshDueReason: null,
    upcoming: null,
    ...over,
  };
}

describe("facts are read from the check results, not from a report's wording", () => {
  it("separates changed from refresh-due", () => {
    expect(triggerFactsFrom([result({ outcome: "changed" })])).toMatchObject({
      anyChanged: true,
      anyRefreshDue: false,
    });
    expect(
      triggerFactsFrom([result({ outcome: "no-change", refreshDue: true })])
    ).toMatchObject({ anyChanged: false, anyRefreshDue: true });
  });

  it("treats only a permanent failure as a blocker", () => {
    expect(triggerFactsFrom([result({ outcome: "failed-retryable" })]).anyPermanentFailure).toBe(false);
    expect(triggerFactsFrom([result({ outcome: "failed-permanent" })]).anyPermanentFailure).toBe(true);
  });

  it("reports nothing for an empty run rather than defaulting to ingest", () => {
    const facts = triggerFactsFrom([]);
    expect(facts).toEqual({ anyChanged: false, anyRefreshDue: false, anyPermanentFailure: false });
    expect(decideRefresh({ ...base, ...facts }).ingest).toBe(false);
  });
});
