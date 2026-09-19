#!/usr/bin/env node
// Loaded before anything else: adapters read process.env at call time, but
// a config module could read it at import time, and then order would matter.
import { loadPipelineEnv, describeSecret, PIPELINE_ROOT } from "./config/env.js";
loadPipelineEnv();
import { mkdir, writeFile, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { PRODUCTS, findProduct } from "./config/products.js";
import { SOURCES } from "./config/sources.js";
import { SUPPORTED_SCOPE } from "./config/scope.js";
import { SECRET_ENV_NAMES } from "./config/env.js";
import { runChecks, renderRunReport, renderCadenceTable, buildCandidateManifest } from "./refresh/run.js";
import {
  listManifests,
  lastKnownGood,
  rollbackTo,
  verifyManifestAgainstTree,
  hashTree,
  EXPORTS_DIR as PUBLISHED_EXPORTS_DIR,
} from "./refresh/manifest.js";
import { exportAccess } from "./access/exportAccess.js";
import { resolveProduct } from "./identity/resolve.js";
import { buildRecord, summarize } from "./normalize/record.js";
import { toExport, exportStats } from "./export/appExport.js";
import { MedicationRecordSchema, type MedicationRecord } from "./schemas/index.js";
import { lookupProviders } from "./sources/nppes.js";
import { interactionApiStatus } from "./sources/rxnav.js";
import { SourceUnavailableError } from "./sources/http.js";
import { cmdInsuranceIngest, cmdCoverage } from "./insurance/cli.js";
import { exportInsurance } from "./insurance/exportInsurance.js";
import { buildVerificationReport } from "./verify/report.js";

/**
 * Pipeline CLI.
 *
 * Every command is idempotent and safe to re-run. Writes are atomic (write to
 * a temp file, then rename) so an interrupted run never leaves a half-written
 * record that later looks like real data.
 *
 * On refresh failure the last known good record is preserved; the failure is
 * reported rather than silently replacing good data with nothing.
 */

const NORMALIZED_DIR = path.join(process.cwd(), "data", "normalized");
const EXPORTS_DIR = path.join(process.cwd(), "data", "exports");
const REPORTS_DIR = path.join(process.cwd(), "data", "reports");

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, filePath);
}

const log = (...args: unknown[]) => console.log(...args);

/* ------------------------------------------------------------- commands -- */

async function cmdSources(): Promise<void> {
  log("Configured sources\n");
  for (const s of Object.values(SOURCES)) {
    log(`${s.name}`);
    log(`  publisher   ${s.publisher}`);
    log(`  docs        ${s.docs}`);
    log(`  base        ${s.baseUrl}`);
    log(`  auth        ${s.auth}`);
    log(`  rate limit  ${s.documentedLimit}`);
    log(`  cadence     ${s.updateCadence}`);
    log(`  establishes ${s.establishes.length} things; cannot establish ${s.cannotEstablish.length}`);
    log("");
  }
  const interaction = await interactionApiStatus();
  log(`RxNav interaction API: available=${interaction.available} http=${interaction.httpStatus}`);
  log(`  ${interaction.note}`);
}

async function cmdResolve(productKey: string | undefined, force: boolean): Promise<void> {
  const specs = productKey ? [findProduct(productKey)].filter(Boolean) : PRODUCTS;
  if (specs.length === 0) {
    throw new Error(`Unknown product "${productKey}". Known: ${PRODUCTS.map((p) => p.productKey).join(", ")}`);
  }
  for (const spec of specs as NonNullable<(typeof specs)[number]>[]) {
    log(`\n=== ${spec.productKey} ===`);
    const { resolution } = await resolveProduct(spec, force);
    log(`state: ${resolution.state}`);
    log(`why:   ${resolution.rationale}`);
    log("evidence:");
    for (const e of resolution.evidence) {
      log(`  ${e.agrees ? "OK  " : "FAIL"} ${e.dimension.padEnd(24)} expected="${e.expected}" observed="${e.observed}" [${e.sourceId}]`);
    }
    if (resolution.competingCandidates.length > 0) {
      log("other products in the same document (never merged):");
      for (const c of resolution.competingCandidates) log(`  - ${c.label}`);
    }
  }
}

async function cmdIngest(productKey: string | undefined, force: boolean): Promise<void> {
  const specs = productKey ? [findProduct(productKey)].filter(Boolean) : PRODUCTS;
  if (specs.length === 0) {
    throw new Error(`Unknown product "${productKey}".`);
  }

  for (const spec of specs as NonNullable<(typeof specs)[number]>[]) {
    log(`\n=== ingest ${spec.productKey} ===`);
    const target = path.join(NORMALIZED_DIR, `${spec.productKey}.json`);
    try {
      const record = await buildRecord(spec, force);
      const parsed = MedicationRecordSchema.parse(record);
      await atomicWrite(target, JSON.stringify(parsed, null, 2) + "\n");
      const s = summarize(parsed);
      log(`  resolution     ${s.resolutionState}`);
      log(`  readiness      ${s.readiness}`);
      log(`  sections       ${s.sectionsTop} top / ${s.sectionsTotal} total, ${s.tables} tables`);
      log(`  patient docs   ${s.patientDocs}`);
      log(`  products in doc ${s.productsInDocument}`);
      log(`  rxnorm         ${s.rxnorm}`);
      log(`  approval       ${s.approval}`);
      log(`  conflicts      ${s.conflicts} (${s.blockingConflicts} blocking)`);
      log(`  wrote          ${path.relative(process.cwd(), target)}`);
    } catch (err) {
      // Last known good data is preserved: we simply do not overwrite it.
      const detail = err instanceof SourceUnavailableError ? err.message : String(err);
      log(`  FAILED: ${detail}`);
      log(`  Existing record (if any) left untouched at ${path.relative(process.cwd(), target)}`);
      process.exitCode = 1;
    }
  }
}

async function loadRecords(): Promise<MedicationRecord[]> {
  let files: string[];
  try {
    files = (await readdir(NORMALIZED_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: MedicationRecord[] = [];
  for (const f of files) {
    const raw = JSON.parse(await readFile(path.join(NORMALIZED_DIR, f), "utf8"));
    out.push(MedicationRecordSchema.parse(raw));
  }
  return out;
}

async function cmdValidate(): Promise<void> {
  const records = await loadRecords();
  if (records.length === 0) {
    log("No normalized records found. Run: npm run ingest");
    process.exitCode = 1;
    return;
  }
  let problems = 0;
  for (const r of records) {
    const issues: string[] = [];
    if (r.resolution.state !== "verified-match") {
      issues.push(`resolution is "${r.resolution.state}"`);
    }
    for (const c of r.conflicts.filter((c) => c.blocksExport)) {
      issues.push(`blocking conflict on ${c.field}`);
    }
    if (r.clinicalReview.reviewed !== false) issues.push("clinicalReview.reviewed must be false");
    if (r.label.sections.length === 0) issues.push("no label sections");

    log(`${issues.length === 0 ? "PASS" : "WARN"}  ${r.productKey}  (${r.readiness})`);
    for (const i of issues) log(`      - ${i}`);
    problems += issues.length;
  }
  log(`\n${records.length} record(s) validated against the schema; ${problems} issue(s) surfaced.`);
}

async function cmdExport(): Promise<void> {
  const records = await loadRecords();
  if (records.length === 0) {
    log("No normalized records. Run: npm run ingest");
    process.exitCode = 1;
    return;
  }
  const index: Array<Record<string, unknown>> = [];

  for (const r of records) {
    const e = toExport(r);
    const target = path.join(EXPORTS_DIR, `${r.productKey}.json`);
    await atomicWrite(target, JSON.stringify(e, null, 2) + "\n");
    const stats = exportStats(e);
    index.push({
      productKey: e.productKey,
      readiness: e.readiness,
      blockedReason: e.blockedReason,
      brandName: e.display.brandName,
      genericName: e.display.genericName,
      strengthDisplay: e.display.strengthDisplay,
      dosageForm: e.display.dosageForm,
      rxcui: e.identifiers.rxcui,
      splSetId: e.identifiers.splSetId,
      file: `${e.productKey}.json`,
      ...stats,
    });
    log(`wrote ${path.relative(process.cwd(), target)}  [${e.readiness}] ${stats.professionalSections} prof / ${stats.patientSections} patient sections, ${stats.tables} tables`);
  }

  const indexPath = path.join(EXPORTS_DIR, "index.json");
  await atomicWrite(
    indexPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          "'app-ready' means structurally consumable, NOT clinically approved. " +
          "Blocked records intentionally contain no label content.",
        supportedScope: SUPPORTED_SCOPE,
        products: index,
      },
      null,
      2
    ) + "\n"
  );
  log(`wrote ${path.relative(process.cwd(), indexPath)}`);
}

async function cmdReport(): Promise<void> {
  const records = await loadRecords();
  if (records.length === 0) {
    log("No normalized records. Run: npm run ingest");
    process.exitCode = 1;
    return;
  }

  const lines: string[] = [];
  lines.push("# Completeness and conflict report");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Completeness by product and source");
  lines.push("");
  lines.push("| Product | Resolution | Readiness | SPL sections | Tables | Patient docs | RxNorm | Drugs@FDA | Recalls |");
  lines.push("|---|---|---|---:|---:|---:|---|---|---|");
  for (const r of records) {
    const s = summarize(r);
    lines.push(
      `| ${r.productKey} | ${s.resolutionState} | ${s.readiness} | ${s.sectionsTotal} | ${s.tables} | ${s.patientDocs} | ${s.rxnorm} | ${s.approval} | ${r.supplemental.enforcement.present ? `${r.supplemental.enforcement.records.length} record(s)` : `absent (${r.supplemental.enforcement.reason})`} |`
    );
  }

  lines.push("");
  lines.push("## Conflicts and unresolved items");
  lines.push("");
  const anyConflicts = records.some((r) => r.conflicts.length > 0);
  if (!anyConflicts) {
    lines.push("No conflicts were detected across the ingested records.");
  } else {
    for (const r of records) {
      if (r.conflicts.length === 0) continue;
      lines.push(`### ${r.productKey}`);
      lines.push("");
      for (const c of r.conflicts) {
        lines.push(`- **${c.field}** — ${c.assessment}${c.blocksExport ? " (BLOCKS EXPORT)" : ""}`);
        lines.push(`  - ${c.note}`);
        for (const claim of c.claims) {
          lines.push(
            `  - \`${claim.sourceId}\` says "${claim.value}" (effective ${claim.sourceEffectiveDate ?? "unknown"}, version ${claim.sourceVersion ?? "n/a"})`
          );
        }
      }
      lines.push("");
    }
  }

  lines.push("## Products sharing a source document");
  lines.push("");
  for (const r of records) {
    if (r.label.productsInDocument.length <= 1) continue;
    lines.push(`- **${r.productKey}** — its SPL describes ${r.label.productsInDocument.length} products:`);
    for (const p of r.label.productsInDocument) lines.push(`  - ${p}`);
  }

  const target = path.join(REPORTS_DIR, "completeness.md");
  await atomicWrite(target, lines.join("\n") + "\n");
  log(`wrote ${path.relative(process.cwd(), target)}`);
  log(lines.slice(4, 12).join("\n"));
}

async function cmdRefresh(force: boolean): Promise<void> {
  log("Refreshing all products (existing records preserved on failure)...");
  const before = await loadRecords();
  const versions = new Map(before.map((r) => [r.productKey, r.label.splVersion]));

  await cmdIngest(undefined, force);

  const after = await loadRecords();
  for (const r of after) {
    const old = versions.get(r.productKey);
    if (old && old !== r.label.splVersion) {
      log(
        `\nSOURCE VERSION CHANGED for ${r.productKey}: SPL v${old} -> v${r.label.splVersion}. ` +
          `Any derived summaries built against v${old} must be revalidated before reuse.`
      );
    }
  }
}

async function cmdNppes(args: string[]): Promise<void> {
  const query: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    const value = args[i + 1];
    if (key && value) query[key] = value;
  }
  const result = await lookupProviders({
    number: query.number,
    lastName: query.lastName,
    firstName: query.firstName,
    organizationName: query.organizationName,
    taxonomyDescription: query.taxonomy,
    state: query.state,
    city: query.city,
    limit: query.limit ? Number(query.limit) : undefined,
  });

  log(`NPPES results: ${result.resultCount}`);
  for (const p of result.providers) {
    log(`  ${p.npi}  ${p.isIndividual ? "individual" : "organization"}  ${p.name}${p.credential ? `, ${p.credential}` : ""}`);
    log(`        taxonomy: ${p.primaryTaxonomy?.description ?? "none recorded"}`);
    log(`        location: ${[p.practiceLocation?.city, p.practiceLocation?.state].filter(Boolean).join(", ") || "not published"}`);
    log(`        enumerated ${p.enumerationDate ?? "?"}, last updated ${p.lastUpdated ?? "?"}`);
  }
  log("\nLimitations that travel with every NPPES result:");
  for (const l of result.limitations) log(`  - ${l}`);

  const target = path.join(REPORTS_DIR, "nppes-lookup.json");
  await atomicWrite(target, JSON.stringify(result, null, 2) + "\n");
  log(`\nwrote ${path.relative(process.cwd(), target)}`);
}

/* ----------------------------------------------------------------- main -- */

function usage(): void {
  log(`medbridge data-pipeline

Commands:
  sources                          List configured sources and probe the RxNav interaction API
  resolve [productKey] [--force]   Resolve product identity and print the evidence table
  ingest  [productKey] [--force]   Retrieve, normalize and write data/normalized/<key>.json
  validate                         Re-validate stored records against the schema
  refresh [--force]                Re-ingest everything; flags SPL version changes
  export                           Write app-consumable JSON to data/exports/
  report                           Write the completeness/conflict report
  nppes --lastName Smith --state CA [--taxonomy Pharmacist] [--limit 5]
  verify:report [--live]           Highlights/interaction/scope accounting; --live checks for a newer CMS release
  insurance:ingest                 Fetch CMS Part D formulary evidence (range-fetches ~9 MB of a 2.1 GB archive)
  coverage --product <key> --contract S5820 --plan 034 --segment 000 [--year 2026]
  coverage --product <key> --planName "AARP"     Candidates only; a name never resolves a plan

Known products:
${PRODUCTS.map((p) => `  ${p.productKey}`).join("\n")}

Notes:
  --force bypasses the 12-hour response cache.
  OPENFDA_API_KEY is optional and raises openFDA's daily limit.
  Put it in data-pipeline/.env.local (git-ignored); run 'npm run env:check' to confirm.`);
}

/** Repeatable flag, e.g. --source openfda --source rxnav. */
function argValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) out.push(args[i + 1]!);
  }
  return out;
}

function argValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1]! : null;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const force = rest.includes("--force");
  const positional = rest.filter((a) => !a.startsWith("--"));

  switch (command) {
    case "sources":
      return cmdSources();
    case "resolve":
      return cmdResolve(positional[0], force);
    case "ingest":
      return cmdIngest(positional[0], force);
    case "validate":
      return cmdValidate();
    case "refresh":
      return cmdRefresh(force);
    case "export":
      return cmdExport();
    case "report":
      return cmdReport();
    case "nppes":
      return cmdNppes(rest);
    case "insurance:ingest":
      return cmdInsuranceIngest();
    case "coverage":
      return cmdCoverage(rest);
    case "verify:report": {
      const out = await buildVerificationReport(rest.includes("--live"));
      log(`wrote ${path.relative(process.cwd(), out)}`);
      return;
    }
    case "insurance:export": {
      const files = await exportInsurance();
      for (const f of files) log(`wrote ${path.relative(process.cwd(), f)}`);
      return;
    }
    case "refresh:check": {
      // Reaches every source, compares versions, writes nothing.
      const only = argValues(rest, "--source");
      const run = await runChecks({
        mode: "check-only",
        only,
        dryRun: rest.includes("--dry-run"),
      });
      log(renderRunReport(run));
      // A permanent failure is a configuration problem and should fail CI.
      const permanent = run.sources.filter((s) => s.outcome === "failed-permanent");
      if (permanent.length > 0) process.exitCode = 2;
      return;
    }

    case "refresh:cadence": {
      log(renderCadenceTable());
      return;
    }

    case "refresh:run": {
      const only = argValues(rest, "--source");
      const force = rest.includes("--force");
      const run = await runChecks({ mode: force ? "force-refresh" : "refresh", only });
      log(renderRunReport(run));

      if (run.counts.changed === 0) {
        log("");
        log("No source changed. Nothing to stage; existing exports are left untouched.");
        return;
      }

      // Candidates are described, never published: publication of medical and
      // coverage content is a reviewed step.
      const files = await hashTree(PUBLISHED_EXPORTS_DIR);
      const m = await buildCandidateManifest(run, [], files);
      log("");
      log(`candidate manifest ${m.manifestId}  status=${m.status}`);
      if (m.reviewBlockers.length > 0) {
        log(`${m.reviewBlockers.length} review blocker(s); publication is not automatic.`);
      }
      return;
    }

    case "refresh:manifests": {
      const all = await listManifests();
      const good = await lastKnownGood();
      if (all.length === 0) {
        log("No manifests yet. Run `npm run refresh:run` to create a candidate.");
        return;
      }
      for (const m of all) {
        log(
          `${m.manifestId}  ${m.status.padEnd(22)} files=${String(m.files.length).padStart(3)}  ` +
            `blockers=${m.reviewBlockers.length}  ${m.createdAt}`
        );
      }
      log("");
      log(`last known good: ${good?.manifestId ?? "(none)"}`);
      return;
    }

    case "refresh:verify": {
      const good = await lastKnownGood();
      if (!good) {
        log("No published manifest to verify against.");
        return;
      }
      const v = await verifyManifestAgainstTree(good);
      log(`manifest ${good.manifestId}: ${v.ok ? "MATCHES the export tree" : "MISMATCH"}`);
      for (const f of v.missing) log(`  missing  ${f}`);
      for (const f of v.modified) log(`  modified ${f}`);
      if (!v.ok) process.exitCode = 3;
      return;
    }

    case "refresh:rollback": {
      const id = argValue(rest, "--manifest");
      if (!id) {
        log("Usage: refresh:rollback --manifest <manifestId>");
        process.exitCode = 1;
        return;
      }
      const r = await rollbackTo(id);
      log(r.detail);
      if (!r.ok) process.exitCode = 4;
      return;
    }

    case "env:check": {
      // Reports CONFIGURATION, never values. Safe to run in CI and to paste
      // into an issue.
      const env = loadPipelineEnv();
      log(`pipeline root   ${PIPELINE_ROOT}`);
      log(`env files read  ${env.filesRead.length > 0 ? env.filesRead.join(", ") : "(none)"}`);
      if (env.filesMissing.length > 0) log(`not present     ${env.filesMissing.join(", ")}`);
      if (env.namesSkippedProcessWins.length > 0) {
        log(
          `process wins    ${env.namesSkippedProcessWins.join(", ")} ` +
            `(already set in the environment; the file value was ignored)`
        );
      }
      log("");
      for (const name of SECRET_ENV_NAMES) {
        const d = describeSecret(name);
        log(
          `${name.padEnd(18)} ${d.configured ? "configured" : "NOT CONFIGURED"}` +
            (d.configured ? `  (length ${d.length}, from ${d.source})` : "")
        );
      }
      if (!describeSecret("OPENFDA_API_KEY").configured) {
        log("");
        log("openFDA works without a key at a lower rate limit.");
        log('To add one:  cp .env.example .env.local   then paste the key after "=".');
      }
      return;
    }

    case "access:export": {
      const files = await exportAccess();
      for (const f of files) log(`wrote ${path.relative(process.cwd(), f)}`);
      return;
    }
    default:
      usage();
      if (command) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nCommand failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
