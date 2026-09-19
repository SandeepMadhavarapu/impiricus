import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyFailure, tallyCounts, versionsMatch, type SourceCheckResult, type SourceVersion } from "@pipeline/refresh/state.js";
import { reviewBlockersFor } from "@pipeline/refresh/run.js";
import { parseEnvFile, redactSecrets } from "@pipeline/config/env.js";
import { hashTree, verifyManifestAgainstTree, type PublicationManifest } from "@pipeline/refresh/manifest.js";

/**
 * Adversarial tests for automatic refresh. Network-free.
 *
 * Each names a specific way an automated refresh could corrupt or misrepresent
 * the data, and pins the behaviour that prevents it.
 */

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

function result(over: Partial<SourceCheckResult> = {}): SourceCheckResult {
  return {
    sourceId: "openfda",
    label: "openFDA",
    stage: "discovered",
    outcome: "no-change",
    current: version(),
    previous: version(),
    checkedAt: "2026-09-19T00:00:00.000Z",
    lastSuccessfulCheck: "2026-09-19T00:00:00.000Z",
    lastSuccessfulRetrieval: "2026-09-18T00:00:00.000Z",
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

describe("failure classification", () => {
  /** Retrying a rejected credential forever hides a configuration problem. */
  it("treats authentication and authorisation failures as permanent", () => {
    expect(classifyFailure(401, "unauthorized")).toBe("failed-permanent");
    expect(classifyFailure(403, "forbidden")).toBe("failed-permanent");
    expect(classifyFailure(410, "gone")).toBe("failed-permanent");
  });

  it("treats rate limiting and server errors as retryable", () => {
    expect(classifyFailure(429, "too many")).toBe("failed-retryable");
    expect(classifyFailure(500, "boom")).toBe("failed-retryable");
    expect(classifyFailure(503, "unavailable")).toBe("failed-retryable");
  });

  it("treats a network failure as retryable", () => {
    expect(classifyFailure(null, "AbortError: timed out")).toBe("failed-retryable");
    expect(classifyFailure(null, "ENOTFOUND api.fda.gov")).toBe("failed-retryable");
  });

  it("treats a moved document (404) as permanent, needing a catalogue update", () => {
    expect(classifyFailure(404, "not found")).toBe("failed-permanent");
  });
});

describe("no-change is not failure, and failure is not freshness", () => {
  it("counts an unchanged source as a success, not a failure", () => {
    const c = tallyCounts([result({ outcome: "no-change" })]);
    expect(c.unchanged).toBe(1);
    expect(c.failed).toBe(0);
  });

  it("counts a missing adapter separately from a retrieval failure", () => {
    const c = tallyCounts([
      result({ sourceId: "marketplace", outcome: "not-implemented" }),
      result({ sourceId: "cms-part-d", outcome: "failed-retryable" }),
    ]);
    expect(c.notImplemented).toBe(1);
    expect(c.failed).toBe(1);
  });

  /**
   * The worst failure mode available to this pipeline: a check that could not
   * reach the source must not advance the evidence of freshness.
   */
  it("does not advance last-successful-check on a failed check", () => {
    const failed = result({
      outcome: "failed-retryable",
      current: null,
      lastSuccessfulCheck: "2026-09-01T00:00:00.000Z",
      checkedAt: "2026-09-19T00:00:00.000Z",
    });
    expect(failed.lastSuccessfulCheck).toBe("2026-09-01T00:00:00.000Z");
    expect(failed.lastSuccessfulCheck).not.toBe(failed.checkedAt);
  });

  it("keeps a failed source out of refresh-due, since it established nothing", () => {
    const failed = result({ outcome: "failed-permanent", refreshDue: false, refreshDueReason: null });
    expect(failed.refreshDue).toBe(false);
  });
});

describe("changed versus refresh-due", () => {
  /**
   * A source can be provably unchanged and still be due for refresh because
   * our copy aged out. Reporting that as "changed" would assert the publisher
   * did something it did not.
   */
  it("keeps staleness out of the changed outcome", () => {
    const stale = result({
      outcome: "no-change",
      stale: true,
      refreshDue: true,
      refreshDueReason: "max-age-exceeded",
    });
    expect(stale.outcome).toBe("no-change");
    expect(stale.refreshDue).toBe(true);
    expect(tallyCounts([stale]).changed).toBe(0);
  });

  it("distinguishes never-retrieved from aged-out", () => {
    expect(result({ refreshDueReason: "never-retrieved" }).refreshDueReason).toBe("never-retrieved");
    expect(result({ refreshDueReason: "max-age-exceeded" }).refreshDueReason).toBe("max-age-exceeded");
  });
});

describe("version comparison", () => {
  it("matches on the strongest available signal", () => {
    expect(versionsMatch(version({ contentHash: "a" }), version({ contentHash: "a" }))).toBe(true);
    expect(versionsMatch(version({ contentHash: "a" }), version({ contentHash: "b" }))).toBe(false);
  });

  /** Two nulls are not a match: absence of evidence is not sameness. */
  it("refuses to call two unknowns equal", () => {
    const blank = version({ version: null, publishedDate: null, etag: null, lastModified: null, contentHash: null });
    expect(versionsMatch(blank, blank)).toBe(false);
    expect(versionsMatch(null, null)).toBe(false);
    expect(versionsMatch(version(), null)).toBe(false);
  });
});

describe("review gating", () => {
  it("requires review whenever source content changed", () => {
    const b = reviewBlockersFor([result({ outcome: "changed" })]);
    expect(b.length).toBeGreaterThan(0);
    expect(b.join(" ")).toMatch(/has not been reviewed/i);
  });

  /** Future-effective data must be staged, never activated early. */
  it("blocks publication while a future-effective document exists", () => {
    const b = reviewBlockersFor([
      result({
        sourceId: "vamedicaid",
        outcome: "no-change",
        upcoming: { version: "10/01/2026 v2", effectiveDate: "2026-10-01" },
      }),
    ]);
    expect(b.join(" ")).toMatch(/future-effective/i);
    expect(b.join(" ")).toMatch(/not activated/i);
  });

  it("blocks publication on a permanent source failure", () => {
    const b = reviewBlockersFor([result({ outcome: "failed-permanent", httpStatus: 403 })]);
    expect(b.join(" ")).toMatch(/permanent failure/i);
  });

  it("does not block when everything is unchanged and nothing is pending", () => {
    expect(reviewBlockersFor([result({ outcome: "no-change" })])).toHaveLength(0);
  });

  /** A retryable blip should not demand human review; it should just retry. */
  it("does not demand review for a transient failure", () => {
    const b = reviewBlockersFor([result({ outcome: "failed-retryable", httpStatus: 503 })]);
    expect(b).toHaveLength(0);
  });
});

describe("secret handling", () => {
  it("parses env files without interpolation surprises", () => {
    const m = parseEnvFile(
      [
        "# a comment",
        "",
        "export QUOTED='abc'",
        'DQUOTED="def"',
        "PLAIN=ghi",
        "WITH_EQUALS=a=b=c",
        "bad name=x",
        "NOVALUE=",
      ].join("\n")
    );
    expect(m.get("QUOTED")).toBe("abc");
    expect(m.get("DQUOTED")).toBe("def");
    expect(m.get("PLAIN")).toBe("ghi");
    expect(m.get("WITH_EQUALS")).toBe("a=b=c");
    expect(m.has("bad name")).toBe(false);
    expect(m.get("NOVALUE")).toBe("");
  });

  it("redacts a configured secret out of arbitrary text", () => {
    const prior = process.env.OPENFDA_API_KEY;
    process.env.OPENFDA_API_KEY = "supersecretvalue1234567890";
    try {
      const msg = redactSecrets("failed with key supersecretvalue1234567890 in the url");
      expect(msg).not.toContain("supersecretvalue1234567890");
      expect(msg).toContain("<OPENFDA_API_KEY:REDACTED>");
    } finally {
      if (prior === undefined) delete process.env.OPENFDA_API_KEY;
      else process.env.OPENFDA_API_KEY = prior;
    }
  });

  /** Substituting a very short value would corrupt unrelated text. */
  it("does not substitute implausibly short values", () => {
    const prior = process.env.OPENFDA_API_KEY;
    process.env.OPENFDA_API_KEY = "abc";
    try {
      expect(redactSecrets("abcdefg")).toBe("abcdefg");
    } finally {
      if (prior === undefined) delete process.env.OPENFDA_API_KEY;
      else process.env.OPENFDA_API_KEY = prior;
    }
  });
});

describe("manifest integrity", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "manifest-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("hashes a tree deterministically and relatively", async () => {
    await mkdir(path.join(dir, "sub"), { recursive: true });
    await writeFile(path.join(dir, "a.json"), "one");
    await writeFile(path.join(dir, "sub", "b.json"), "two");

    const first = await hashTree(dir);
    const second = await hashTree(dir);
    expect(first).toEqual(second);
    expect(first.map((f) => f.path)).toEqual(["a.json", "sub/b.json"]);
  });

  /** A manifest that no longer matches its tree must say so loudly. */
  it("detects a modified file", async () => {
    await writeFile(path.join(dir, "a.json"), "one");
    const files = await hashTree(dir);
    const m = { files } as PublicationManifest;

    expect((await verifyManifestAgainstTree(m, dir)).ok).toBe(true);

    await writeFile(path.join(dir, "a.json"), "tampered");
    const after = await verifyManifestAgainstTree(m, dir);
    expect(after.ok).toBe(false);
    expect(after.modified).toEqual(["a.json"]);
  });

  it("detects a missing file", async () => {
    await writeFile(path.join(dir, "a.json"), "one");
    const m = { files: await hashTree(dir) } as PublicationManifest;
    await rm(path.join(dir, "a.json"));
    const after = await verifyManifestAgainstTree(m, dir);
    expect(after.ok).toBe(false);
    expect(after.missing).toEqual(["a.json"]);
  });
});

describe("workflow safety", () => {
  const wf = (name: string) =>
    readFile(path.join(process.cwd(), "..", ".github", "workflows", name), "utf8");

  /**
   * The test workflow runs pull-request code. If it ever gains a secret or
   * write permission, submitted code could exfiltrate the credential.
   */
  it("keeps secrets and write access out of the PR-triggered workflow", async () => {
    const y = await wf("pipeline-tests.yml");
    expect(y).toContain("permissions:\n  contents: read");
    expect(y).not.toMatch(/secrets\./);
    expect(y).not.toMatch(/pull_request_target/);
    expect(y).not.toMatch(/contents:\s*write/);
  });

  it("grants write access only to the publication job", async () => {
    const y = await wf("pipeline-refresh.yml");
    // Default is read-only.
    expect(y).toMatch(/^permissions:\n  contents: read$/m);
    // Exactly one job raises it.
    expect(y.match(/contents: write/g) ?? []).toHaveLength(1);
    expect(y).not.toMatch(/pull_request_target/);
  });

  it("never auto-merges", async () => {
    const y = await wf("pipeline-refresh.yml");
    expect(y).not.toMatch(/gh pr merge|auto-merge|--auto/);
  });

  it("restricts the refresh PR to generated data paths", async () => {
    const y = await wf("pipeline-refresh.yml");
    expect(y).toContain("add-paths:");
    expect(y).toContain("data-pipeline/data/exports/**");
    // Source, workflows and app files must not be in the allowlist.
    expect(y).not.toMatch(/add-paths:[\s\S]*data-pipeline\/src/);
    expect(y).not.toMatch(/add-paths:[\s\S]*\.github/);
  });

  it("pins external actions to a commit sha rather than a moving tag", async () => {
    for (const name of ["pipeline-tests.yml", "pipeline-refresh.yml"]) {
      const y = await wf(name);
      for (const use of y.match(/uses: \S+/g) ?? []) {
        expect(use).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it("bounds every job with a timeout and serialises publication", async () => {
    const y = await wf("pipeline-refresh.yml");
    expect(y).toMatch(/concurrency:\n  group: pipeline-refresh/);
    expect(y).toMatch(/cancel-in-progress: false/);
    expect((y.match(/timeout-minutes:/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  /**
   * Scheduled workflows only run from the default branch. The file must say so
   * rather than letting a reader assume the cron is already firing.
   */
  it("documents that the schedule is inactive until merged to the default branch", async () => {
    const y = await wf("pipeline-refresh.yml");
    expect(y).toMatch(/ONLY from the DEFAULT\n#                      branch/);
    expect(y).toMatch(/NOT running on a schedule yet/);
  });
});
