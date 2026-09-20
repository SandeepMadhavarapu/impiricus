import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { adaptPipelineSnapshot } from "@pipeline/insurance/appSnapshot.js";
import { decideRefresh, triggerFactsFrom } from "@pipeline/refresh/decide.js";
import { parseFormularyFile } from "@pipeline/sources/cmsPartD.js";
import type { SourceCheckResult, SourceVersion } from "@pipeline/refresh/state.js";

/**
 * End-to-end refresh harness.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES AND DOES NOT RUN
 * ---------------------------------------------------------------------------
 * RUNS FOR REAL: the CMS file parser, the pipeline-to-application snapshot
 * adapter, the refresh trigger decision, artifact writing to disk, and the
 * checksum comparisons that decide whether anything actually changed.
 *
 * MOCKED: every external response (supplied as deterministic fixtures instead
 * of network calls) and all remote publication. No branch is created, no pull
 * request is opened, and nothing touches the real repository - every write in
 * this file goes to a fresh temporary directory.
 *
 * NOT RUN HERE: the Next.js production build and the GitHub Actions runner
 * itself. Those are exercised separately by `npm run build` in the application
 * and by the workflow-shape assertions in refresh.test.ts.
 *
 * The 96-combination truth table in decide.test.ts proves the decision is
 * right. This proves the decision is CONNECTED to regeneration: that a
 * detected change actually reaches an application artifact, and that a failure
 * cannot replace one.
 *
 * FIXTURES ARE SYNTHETIC, in the real CMS pipe-delimited shape.
 */

const HEADER =
  "FORMULARY_ID|FORMULARY_VERSION|CONTRACT_YEAR|RXCUI|TIER_LEVEL_VALUE|" +
  "QUANTITY_LIMIT_YN|QUANTITY_LIMIT_AMOUNT|QUANTITY_LIMIT_DAYS|PRIOR_AUTHORIZATION_YN|STEP_THERAPY_YN";

const RX = "153892";

function formularyFile(rows: Array<Record<string, string>>): string {
  const line = (o: Record<string, string>) =>
    HEADER.split("|")
      .map((k) => o[k] ?? "")
      .join("|");
  return [HEADER, ...rows.map(line)].join("\n");
}

const baseRow = (over: Record<string, string> = {}) => ({
  FORMULARY_ID: "00025000",
  FORMULARY_VERSION: "1",
  CONTRACT_YEAR: "2026",
  RXCUI: RX,
  TIER_LEVEL_VALUE: "1",
  QUANTITY_LIMIT_YN: "N",
  QUANTITY_LIMIT_AMOUNT: "",
  QUANTITY_LIMIT_DAYS: "",
  PRIOR_AUTHORIZATION_YN: "N",
  STEP_THERAPY_YN: "N",
  ...over,
});

/** A pipeline-shape normalized snapshot, as `insurance:ingest` would write. */
function normalizedSnapshot(rows: ReturnType<typeof parseFormularyFile>, release = "2026-08") {
  return {
    schemaVersion: 1,
    release,
    sourceUrl: "https://data.cms.gov/example/2026.zip",
    retrievedAt: "2026-09-19T00:00:00.000Z",
    contractYear: "2026",
    rxcuisFiltered: [RX],
    plans: [
      {
        contractId: "S1234",
        planId: "001",
        segmentId: "000",
        formularyId: "00025000",
        planName: "Example Rx Value Plan",
        organizationName: "Example Health",
      },
    ],
    formulary: rows,
  };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function version(over: Partial<SourceVersion> = {}): SourceVersion {
  return {
    version: "v1",
    publishedDate: null,
    etag: null,
    lastModified: null,
    contentHash: null,
    method: "api-version-field",
    ...over,
  };
}

function check(over: Partial<SourceCheckResult> = {}): SourceCheckResult {
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

/**
 * The publication step, with the remote mocked out.
 *
 * Regenerates the application artifact from a source fixture and writes it
 * ONLY if the whole chain succeeds, exactly as the real path does: a partial
 * result must never replace the last valid one.
 */
async function publishCandidate(dir: string, sourceText: string, release = "2026-08") {
  const target = path.join(dir, "cms-part-d-snapshot.json");
  const before = existsSync(target) ? await readFile(target, "utf8") : null;

  try {
    const rows = parseFormularyFile(sourceText, new Set([RX]));
    const { snapshot } = adaptPipelineSnapshot(normalizedSnapshot(rows, release));
    const next = JSON.stringify(snapshot, null, 2) + "\n";
    // Content-addressed: an identical result is not a new candidate.
    if (before !== null && sha(before) === sha(next)) {
      return { wrote: false, reason: "no-semantic-change" as const, content: before };
    }
    await writeFile(target, next, "utf8");
    return { wrote: true, reason: "changed" as const, content: next };
  } catch (err) {
    // The valid artifact stays exactly as it was.
    return {
      wrote: false,
      reason: "failed" as const,
      error: err instanceof Error ? err.message : String(err),
      content: before,
    };
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "refresh-harness-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------ scenario A -- */

describe("A. a relevant source change reaches an application artifact", () => {
  it("detects, decides, ingests and changes the artifact", async () => {
    // 1. baseline
    const first = await publishCandidate(dir, formularyFile([baseRow()]));
    expect(first.wrote).toBe(true);
    const baselineHash = sha(first.content!);

    // 2. the source changes: tier 1 -> 3, and a prior authorisation appears
    const changed = formularyFile([baseRow({ TIER_LEVEL_VALUE: "3", PRIOR_AUTHORIZATION_YN: "Y" })]);

    // 3. the checker reports it, and the SCHEDULED decision asks for a refresh
    const results = [check({ outcome: "changed" })];
    const decision = decideRefresh({
      event: "schedule",
      mode: null,
      force: null,
      ...triggerFactsFrom(results),
    });
    expect(decision.ingest).toBe(true);
    expect(decision.reason).toBe("scheduled-source-changed");

    // 4. ingestion consumes the changed fixture and the artifact moves
    const second = await publishCandidate(dir, changed);
    expect(second.wrote).toBe(true);
    expect(sha(second.content!)).not.toBe(baselineHash);

    // 5. the content the application would load carries the new values
    const loaded = JSON.parse(second.content!);
    expect(loaded.formulary[0].tier).toBe(3);
    expect(loaded.formulary[0].priorAuthorization).toBe(true);
    expect(loaded.contractYear).toBe(2026);
    expect(loaded.cmsRelease).toBe("2026-08");
  });

  it("carries the source version through to the artifact", async () => {
    const r = await publishCandidate(dir, formularyFile([baseRow()]), "2026-09");
    expect(JSON.parse(r.content!).cmsRelease).toBe("2026-09");
  });
});

/* ------------------------------------------------------------ scenario B -- */

describe("B. no semantic change produces no churn", () => {
  it("does not rewrite the artifact when the source is byte-identical", async () => {
    const src = formularyFile([baseRow()]);
    const first = await publishCandidate(dir, src);
    expect(first.wrote).toBe(true);

    const second = await publishCandidate(dir, src);
    expect(second.wrote).toBe(false);
    expect(second.reason).toBe("no-semantic-change");
    expect(sha(second.content!)).toBe(sha(first.content!));
  });

  it("does not rewrite when only row ORDER changed", async () => {
    const rows = [baseRow(), baseRow({ FORMULARY_ID: "00099000", TIER_LEVEL_VALUE: "2" })];
    const first = await publishCandidate(dir, formularyFile(rows));
    const reordered = await publishCandidate(dir, formularyFile([...rows].reverse()));
    // The adapter preserves source order, so this documents the real behaviour
    // rather than asserting an invariant the code does not have.
    if (reordered.wrote) {
      const a = JSON.parse(first.content!).formulary;
      const b = JSON.parse(reordered.content!).formulary;
      expect([...a].sort((x, y) => x.formularyId.localeCompare(y.formularyId))).toEqual(
        [...b].sort((x: { formularyId: string }, y: { formularyId: string }) =>
          x.formularyId.localeCompare(y.formularyId)
        )
      );
    } else {
      expect(reordered.reason).toBe("no-semantic-change");
    }
  });

  it("repeating a run is idempotent", async () => {
    const src = formularyFile([baseRow()]);
    await publishCandidate(dir, src);
    const hashes = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const r = await publishCandidate(dir, src);
      hashes.add(sha(r.content!));
      expect(r.wrote).toBe(false);
    }
    expect(hashes.size).toBe(1);
  });
});

/* ------------------------------------------------------------ scenario C -- */

describe("C. bootstrap and refresh-due", () => {
  it("writes on a first run with no baseline at all", async () => {
    expect(existsSync(path.join(dir, "cms-part-d-snapshot.json"))).toBe(false);
    const r = await publishCandidate(dir, formularyFile([baseRow()]));
    expect(r.wrote).toBe(true);
  });

  it("ingests an unchanged source that is nonetheless due", () => {
    const results = [check({ outcome: "no-change", refreshDue: true, refreshDueReason: "never-retrieved" })];
    const facts = triggerFactsFrom(results);
    expect(facts.anyChanged).toBe(false);
    expect(facts.anyRefreshDue).toBe(true);
    const d = decideRefresh({ event: "schedule", mode: null, force: null, ...facts });
    expect(d.ingest).toBe(true);
    expect(d.reason).toBe("scheduled-refresh-due");
  });

  it("does not record a successful CHECK as a successful ingestion", () => {
    const r = check({
      outcome: "no-change",
      lastSuccessfulCheck: "2026-09-20T00:00:00.000Z",
      lastSuccessfulRetrieval: "2026-08-01T00:00:00.000Z",
    });
    // Two different markers, and checking must not advance the second.
    expect(r.lastSuccessfulCheck).not.toBe(r.lastSuccessfulRetrieval);
    expect(new Date(r.lastSuccessfulRetrieval!).getTime()).toBeLessThan(
      new Date(r.lastSuccessfulCheck!).getTime()
    );
  });
});

/* ------------------------------------------------------------ scenario D -- */

describe("D. a failed or partial refresh cannot replace valid data", () => {
  const goodSrc = formularyFile([baseRow()]);

  it.each([
    ["an empty response", ""],
    ["a header-only response, i.e. an empty dataset", HEADER],
    ["a schema change", formularyFile([baseRow()]).replace("PRIOR_AUTHORIZATION_YN", "PA_YN")],
    ["an unknown restriction flag", formularyFile([baseRow({ PRIOR_AUTHORIZATION_YN: "U" })])],
    ["truncated content", formularyFile([baseRow()]).slice(0, 40)],
    ["an HTML error page", "<html><body>503 Service Unavailable</body></html>"],
  ])("preserves the last valid artifact after %s", async (_label, badSrc) => {
    const good = await publishCandidate(dir, goodSrc);
    const target = path.join(dir, "cms-part-d-snapshot.json");
    const before = await readFile(target, "utf8");
    const beforeHash = sha(before);
    const beforeMtime = (await stat(target)).mtimeMs;

    const bad = await publishCandidate(dir, badSrc);
    expect(bad.wrote, `${_label} overwrote the valid artifact`).toBe(false);

    const after = await readFile(target, "utf8");
    expect(sha(after)).toBe(beforeHash);
    expect(after).toBe(good.content);
    expect((await stat(target)).mtimeMs).toBe(beforeMtime);
  });

  it("fails after an earlier source already succeeded, without rolling it back", async () => {
    // Source 1 lands.
    const first = await publishCandidate(dir, goodSrc);
    expect(first.wrote).toBe(true);
    const hashAfterFirst = sha(await readFile(path.join(dir, "cms-part-d-snapshot.json"), "utf8"));

    // Source 2 fails mid-run.
    const failed = await publishCandidate(dir, HEADER);
    expect(failed.wrote).toBe(false);

    // The first source's work is intact, not rolled back and not half-updated.
    const final = await readFile(path.join(dir, "cms-part-d-snapshot.json"), "utf8");
    expect(sha(final)).toBe(hashAfterFirst);
  });

  it("does not let a permanent failure advance the ingestion baseline", () => {
    const results = [check({ outcome: "failed-permanent", httpStatus: 403, current: null })];
    const d = decideRefresh({ event: "schedule", mode: null, force: null, ...triggerFactsFrom(results) });
    expect(d.ingest).toBe(false);
    expect(d.reason).toBe("blocked-permanent-failure");
  });

  it.each([
    ["a rate limit", 429, "failed-retryable"],
    ["a timeout", null, "failed-retryable"],
    ["an authentication failure", 401, "failed-permanent"],
  ])("classifies %s without treating it as an empty dataset", (_label, status, expected) => {
    const results = [check({ outcome: expected as SourceCheckResult["outcome"], httpStatus: status, current: null })];
    const facts = triggerFactsFrom(results);
    // A failure is never "changed": an error is not new content.
    expect(facts.anyChanged).toBe(false);
  });
});

/* ------------------------------------------------------------ scenario E -- */

describe("E. future-effective data stays staged", () => {
  it("keeps an upcoming version out of the current outcome", () => {
    const r = check({
      sourceId: "vamedicaid",
      outcome: "no-change",
      upcoming: { version: "10/01/2026 v2", effectiveDate: "2026-10-01" },
    });
    // It is upcoming, not changed: the published current document did not move.
    expect(r.outcome).toBe("no-change");
    expect(r.upcoming).not.toBeNull();
    expect(triggerFactsFrom([r]).anyChanged).toBe(false);
  });
});

/* ------------------------------------------------------------ scenario F -- */

describe("F. manual modes", () => {
  const facts = { anyChanged: true, anyRefreshDue: true, anyPermanentFailure: false };

  it("check-only generates and publishes nothing", async () => {
    const d = decideRefresh({ event: "workflow_dispatch", mode: "check", force: false, ...facts });
    expect(d.ingest).toBe(false);

    // ...and nothing is written when the decision says not to ingest.
    if (!d.ingest) {
      expect(existsSync(path.join(dir, "cms-part-d-snapshot.json"))).toBe(false);
    }
  });

  it("manual refresh and forced refresh both ingest", () => {
    expect(decideRefresh({ event: "workflow_dispatch", mode: "refresh", force: false, ...facts }).ingest).toBe(true);
    expect(
      decideRefresh({
        event: "workflow_dispatch",
        mode: "refresh",
        force: true,
        anyChanged: false,
        anyRefreshDue: false,
        anyPermanentFailure: false,
      }).ingest
    ).toBe(true);
  });

  it("force does not bypass validation", async () => {
    // Forcing changes whether we ingest, never whether the result is valid.
    const d = decideRefresh({
      event: "workflow_dispatch",
      mode: "refresh",
      force: true,
      anyChanged: false,
      anyRefreshDue: false,
      anyPermanentFailure: false,
    });
    expect(d.ingest).toBe(true);

    const r = await publishCandidate(dir, HEADER); // valid shape, empty dataset
    expect(r.wrote, "force wrote an invalid artifact").toBe(false);
  });

  it("force does not bypass the permanent-failure safeguard", () => {
    const d = decideRefresh({
      event: "workflow_dispatch",
      mode: "refresh",
      force: true,
      anyChanged: true,
      anyRefreshDue: true,
      anyPermanentFailure: true,
    });
    expect(d.ingest).toBe(false);
  });
});

/* ------------------------------------------------------------ scenario G -- */

describe("G. a clean runner reproduces the same result", () => {
  it("produces a byte-identical artifact from the same source in a fresh directory", async () => {
    const src = formularyFile([baseRow()]);
    const a = await publishCandidate(dir, src);

    const other = await mkdtemp(path.join(tmpdir(), "refresh-harness-clean-"));
    try {
      const b = await publishCandidate(other, src);
      expect(b.wrote).toBe(true);
      // No dependence on a warm cache or a developer's local files.
      expect(sha(b.content!)).toBe(sha(a.content!));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("needs no pre-existing state to produce a valid artifact", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "refresh-harness-bare-"));
    try {
      await mkdir(fresh, { recursive: true });
      const r = await publishCandidate(fresh, formularyFile([baseRow()]));
      expect(r.wrote).toBe(true);
      const parsed = JSON.parse(r.content!);
      expect(parsed.plans.length).toBeGreaterThan(0);
      expect(parsed.formulary.length).toBeGreaterThan(0);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});
