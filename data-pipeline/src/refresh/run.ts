/**
 * Refresh orchestration.
 *
 * `check` reaches every source, compares versions, and writes nothing.
 * `refresh` additionally rebuilds candidates in staging when something changed.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not publish. Publication moves a validated candidate into the export
 * tree, and for medical and coverage content that step requires a human. The
 * workflow opens a pull request; a reviewer merges it. "Automatic detection and
 * preparation, reviewed publication" is the honest description.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PIPELINE_ROOT } from "../config/env.js";
import { PRODUCTS } from "../config/products.js";
import { SCHEMA_VERSION } from "../schemas/index.js";
import { INSURANCE_SCHEMA_VERSION } from "../schemas/insurance.js";
import { ACCESS_SCHEMA_VERSION } from "../schemas/access.js";
import { PARSER_VERSION } from "../access/changes.js";
import {
  checkCmsPartD,
  checkDailyMed,
  checkOpenFda,
  checkRxNorm,
  checkVirginiaLandingPage,
  checkVirginiaMedicaid,
  SOURCE_POLICIES,
  type CheckContext,
} from "./sourceChecks.js";
import {
  tallyCounts,
  type RefreshRun,
  type SourceCheckResult,
  type SourceVersion,
} from "./state.js";
import {
  lastKnownGood,
  listManifests,
  newManifestId,
  sourcesFromChecks,
  writeManifest,
  type PublicationManifest,
  type ValidationResult,
} from "./manifest.js";

/** Where the last successful check/retrieval per source is remembered. */
const STATE_FILE = path.join(PIPELINE_ROOT, "data", "refresh-state.json");

interface PersistedSourceState {
  version: SourceVersion | null;
  lastSuccessfulCheck: string | null;
  lastSuccessfulRetrieval: string | null;
}
type PersistedState = Record<string, PersistedSourceState>;

export async function loadState(): Promise<PersistedState> {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    // A corrupt state file makes everything look changed, which is safe: it
    // causes extra work, never a false "unchanged".
    return {};
  }
}

export async function saveState(state: PersistedState): Promise<void> {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, STATE_FILE);
}

export interface RunOptions {
  mode: "check-only" | "refresh" | "force-refresh";
  /** Leave no trace: do not persist observed versions. */
  dryRun?: boolean;
  /** Restrict to these source ids. Empty means all. */
  only?: string[];
  asOf?: string;
}

/** Runs every configured source check. */
export async function runChecks(opts: RunOptions): Promise<RefreshRun> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const asOf = opts.asOf ?? startedAt.slice(0, 10);
  const state = await loadState();
  const force = opts.mode === "force-refresh";

  const ctxFor = (id: string): CheckContext => ({
    previous: state[id]?.version ?? null,
    lastSuccessfulCheck: state[id]?.lastSuccessfulCheck ?? null,
    lastSuccessfulRetrieval: state[id]?.lastSuccessfulRetrieval ?? null,
    force,
  });

  const setIds = PRODUCTS.map((p: any) => p.splSetId).filter(Boolean);

  const wanted = (id: string) => !opts.only || opts.only.length === 0 || opts.only.includes(id);

  const tasks: Array<[string, () => Promise<SourceCheckResult>]> = [
    ["openfda", () => checkOpenFda(ctxFor("openfda"))],
    ["dailymed", () => checkDailyMed(ctxFor("dailymed"), setIds)],
    ["rxnav", () => checkRxNorm(ctxFor("rxnav"))],
    ["cms-part-d", () => checkCmsPartD(ctxFor("cms-part-d"))],
    ["vamedicaid", () => checkVirginiaMedicaid(ctxFor("vamedicaid"), asOf)],
    ["vamedicaid-landing", () => checkVirginiaLandingPage(ctxFor("vamedicaid-landing"))],
  ];

  const results: SourceCheckResult[] = [];
  for (const [id, fn] of tasks) {
    if (!wanted(id)) continue;
    try {
      results.push(await fn());
    } catch (err) {
      // An adapter throwing is a bug, not a source failure; it is reported as
      // a failure of THIS source and never aborts the other checks.
      const { redactSecrets } = await import("../config/env.js");
      results.push({
        sourceId: id,
        label: SOURCE_POLICIES[id]?.label ?? id,
        stage: "discovered",
        outcome: "failed-retryable",
        current: null,
        previous: state[id]?.version ?? null,
        checkedAt: new Date().toISOString(),
        lastSuccessfulCheck: state[id]?.lastSuccessfulCheck ?? null,
        lastSuccessfulRetrieval: state[id]?.lastSuccessfulRetrieval ?? null,
        httpStatus: null,
        detail: redactSecrets(
          `Adapter error: ${err instanceof Error ? err.message : String(err)}`
        ),
        maxAcceptableAgeHours: SOURCE_POLICIES[id]?.maxAcceptableAgeHours ?? 24 * 7,
        stale: true,
        refreshDue: false,
        refreshDueReason: null,
        upcoming: null,
      });
    }
  }

  // Persist ONLY what succeeded. A failed check must not advance a timestamp,
  // or the next run would believe the source was reached.
  for (const r of results) {
    if (r.outcome === "failed-retryable" || r.outcome === "failed-permanent") continue;
    state[r.sourceId] = {
      version: r.current ?? state[r.sourceId]?.version ?? null,
      lastSuccessfulCheck: r.checkedAt,
      lastSuccessfulRetrieval: state[r.sourceId]?.lastSuccessfulRetrieval ?? null,
    };
  }
  // Observed versions are persisted even by check-only. The state file is an
  // observation log, not an export: without it a daily check could never
  // report "no change", because it would have nothing to compare against.
  // `--dry-run` exists for when a run genuinely must leave no trace.
  if (!opts.dryRun) await saveState(state);

  const good = await lastKnownGood();

  return {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    mode: opts.mode,
    sources: results,
    counts: tallyCounts(results),
    reviewBlockers: reviewBlockersFor(results),
    candidateManifestId: null,
    lastKnownGoodManifestId: good?.manifestId ?? null,
  };
}

/**
 * What must be looked at by a person before anything is published.
 *
 * Unknown categories default to review-required. That default is the point:
 * an unclassified change to medical or coverage content is exactly the case
 * where automation should stop.
 */
export function reviewBlockersFor(results: SourceCheckResult[]): string[] {
  const blockers: string[] = [];
  for (const r of results) {
    if (r.outcome === "changed") {
      blockers.push(
        `${r.sourceId}: source content changed and the resulting diff has not been reviewed.`
      );
    }
    if (r.outcome === "failed-permanent") {
      blockers.push(
        `${r.sourceId}: permanent failure (${r.httpStatus ?? "no status"}). ` +
          "Publishing a bundle that depends on it would rest on unverified data."
      );
    }
    if (r.upcoming) {
      blockers.push(
        `${r.sourceId}: a future-effective document exists (${r.upcoming.version}, effective ` +
          `${r.upcoming.effectiveDate}). It must stay staged as upcoming, not activated.`
      );
    }
  }
  return blockers;
}

/**
 * Builds a candidate manifest describing what a refresh WOULD publish.
 *
 * Deliberately does not publish: it records validations and blockers so a
 * reviewer, and the PR body, can see exactly what is proposed.
 */
export async function buildCandidateManifest(
  run: RefreshRun,
  validations: ValidationResult[],
  files: PublicationManifest["files"]
): Promise<PublicationManifest> {
  const blocking = validations.filter((v) => !v.passed && v.severity === "blocking");
  const blockers = [...run.reviewBlockers, ...blocking.map((v) => `validation: ${v.name} - ${v.detail}`)];
  const previous = await lastKnownGood();

  const m: PublicationManifest = {
    schemaVersion: "manifest-1.0.0",
    manifestId: newManifestId(run.runId),
    createdAt: new Date().toISOString(),
    runId: run.runId,
    mode: run.mode === "check-only" ? "refresh" : run.mode,
    sources: sourcesFromChecks(run.sources),
    versions: {
      parser: PARSER_VERSION,
      medicationSchema: SCHEMA_VERSION,
      insuranceSchema: INSURANCE_SCHEMA_VERSION,
      accessSchema: ACCESS_SCHEMA_VERSION,
    },
    files,
    validations,
    reviewBlockers: blockers,
    status: blockers.length > 0 ? "review-required" : "ready-for-publication",
    publishedAt: null,
    supersedes: previous?.manifestId ?? null,
  };
  await writeManifest(m);
  return m;
}

/** A compact, secret-free run report for logs and workflow summaries. */
export function renderRunReport(run: RefreshRun): string {
  const lines: string[] = [];
  lines.push(`run ${run.runId}`);
  lines.push(`mode ${run.mode}   started ${run.startedAt}   finished ${run.finishedAt ?? "-"}`);
  lines.push("");
  lines.push(
    `checked ${run.counts.checked}  changed ${run.counts.changed}  unchanged ${run.counts.unchanged}  ` +
      `failed ${run.counts.failed}  not-implemented ${run.counts.notImplemented}  skipped ${run.counts.skipped}`
  );
  lines.push("");
  lines.push(
    "source".padEnd(20) +
      "outcome".padEnd(14) +
      "refresh due".padEnd(22) +
      "version".padEnd(26) +
      "last ok check"
  );
  lines.push("-".repeat(112));
  for (const r of run.sources) {
    lines.push(
      r.sourceId.padEnd(20) +
        r.outcome.padEnd(14) +
        (r.refreshDue ? (r.refreshDueReason ?? "yes") : "no").padEnd(22) +
        (r.current?.version ?? "-").slice(0, 24).padEnd(26) +
        (r.lastSuccessfulCheck ?? "never").slice(0, 19)
    );
  }
  lines.push("");
  lines.push("detail:");
  for (const r of run.sources) lines.push(`  ${r.sourceId}: ${r.detail}`);
  if (run.reviewBlockers.length > 0) {
    lines.push("");
    lines.push(`REVIEW REQUIRED (${run.reviewBlockers.length}):`);
    for (const b of run.reviewBlockers) lines.push(`  - ${b}`);
  }
  lines.push("");
  lines.push(`last known good manifest: ${run.lastKnownGoodManifestId ?? "(none yet)"}`);
  lines.push("");
  lines.push(
    "NOTE: every source above is POLLED. None offers a webhook. The check cadence is ours; " +
      "the publication cadence is the publisher's, and they are listed separately in ACCESS.md."
  );
  return lines.join("\n");
}

/** Per-source cadence, for the handoff docs and the workflow summary. */
export function renderCadenceTable(): string {
  const rows = Object.values(SOURCE_POLICIES).map(
    (p) =>
      `| ${p.sourceId} | ${p.checkCadence} | ${p.publisherCadence} | ${Math.round(
        p.maxAcceptableAgeHours / 24
      )} days | ${p.requiresCredential ? "yes" : "no"} |`
  );
  return [
    "| source | we check | publisher releases | max acceptable age | needs key |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}
