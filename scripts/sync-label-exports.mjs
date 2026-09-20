#!/usr/bin/env node
/**
 * Copies the data-pipeline's app-ready exports into the app's source tree.
 *
 * Why copy rather than import across the package boundary:
 *
 *   The app deploys on its own. Vercel builds this package, not the sibling
 *   pipeline, and reaching up out of src/ for JSON at build time is exactly
 *   the kind of path that works locally and fails in a build container. The
 *   exports are small, already committed, and change only when someone runs
 *   an ingest, so vendoring them keeps the deploy self-contained and the
 *   diff reviewable.
 *
 * This is the same pattern src/sources/content/sources/*.json already uses:
 *   generated, committed, never hand-edited.
 *
 * Run: npm run content:sync
 *
 * A record that is not "app-ready" is NOT copied. Readiness is the pipeline's
 * own gate, and a blocked or partial record carries no label content by
 * design. Filtering here means the app never has to hold a half-record.
 */

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const FROM = path.join("data-pipeline", "data", "exports");
const TO = path.join("src", "sources", "content", "label-exports");

const files = (await readdir(FROM)).filter((f) => f.endsWith(".json") && f !== "index.json");

await mkdir(TO, { recursive: true });
// Clear first, so a product removed upstream does not linger in the app.
for (const stale of await readdir(TO).catch(() => [])) {
  await rm(path.join(TO, stale));
}

const written = [];
const skipped = [];

for (const file of files) {
  const raw = JSON.parse(await readFile(path.join(FROM, file), "utf8"));

  if (raw.readiness !== "app-ready") {
    skipped.push(`${raw.productKey}: readiness=${raw.readiness} (${raw.blockedReason ?? "no reason given"})`);
    continue;
  }
  if (raw.clinicalReview?.reviewed !== false) {
    // The contract types this as the literal false. If it is ever anything
    // else, something has gone badly wrong upstream and the app must not
    // quietly present the record as reviewed.
    throw new Error(`${raw.productKey}: clinicalReview.reviewed is not false. Refusing to sync.`);
  }

  await writeFile(path.join(TO, file), JSON.stringify(raw, null, 2) + "\n", "utf8");
  written.push(raw.productKey);
}

/*
 * Medicare Part D plan identities.
 *
 * Copied server-side only. It is ~1.6 MB, so it must never be imported by a
 * client component; src/patient/lib/coverage/directory.ts is "server-only"
 * and /api/directory is what the form talks to.
 */
const INSURANCE_FROM = path.join("data-pipeline", "data", "exports", "insurance");
const INSURANCE_TO = path.join("src", "sources", "content", "insurance");
await mkdir(INSURANCE_TO, { recursive: true });

const plans = JSON.parse(await readFile(path.join(INSURANCE_FROM, "plans.json"), "utf8"));
if (plans.market !== "medicare-part-d") {
  throw new Error(`Expected medicare-part-d plan data, got "${plans.market}". Refusing to sync.`);
}
await writeFile(
  path.join(INSURANCE_TO, "plans.json"),
  JSON.stringify(plans, null, 2) + "\n",
  "utf8"
);

/*
 * Medicare Part D formulary snapshot.
 *
 * The app loads this at runtime and validates it with its own Zod schema; if
 * the parse fails it falls back to "no snapshot" and the coverage flow reports
 * "unable to verify". For a long time that is exactly what happened, because
 * this file was never copied at all - the app told every user it had no
 * formulary database while the pipeline held 979 real rows for the right drugs.
 *
 * The transform lives in the pipeline (`npm run app:snapshot` in
 * data-pipeline), which validates BOTH sides with Zod: the pipeline shape on
 * the way in, and the application shape on the way out. This script therefore
 * does not re-declare a third copy of the schema. It asserts the invariants
 * that would make the artifact dangerous rather than merely wrong, and refuses
 * to write anything it cannot stand behind.
 *
 * The authoritative application-side check is tests/coverage-snapshot.test.ts,
 * which parses this shipped file with the app's real schema.
 */
const SNAPSHOT_FROM = path.join(
  "data-pipeline",
  "data",
  "exports",
  "app",
  "cms-part-d-snapshot.json"
);
const SNAPSHOT_TO = path.join("src", "sources", "content", "coverage", "cms-part-d-snapshot.json");

let snapshotNote;
try {
  const raw = await readFile(SNAPSHOT_FROM, "utf8");
  const snap = JSON.parse(raw);

  const problems = [];
  if (snap.schemaVersion !== 1) problems.push(`schemaVersion is ${snap.schemaVersion}, expected 1`);
  if (typeof snap.cmsRelease !== "string" || snap.cmsRelease.length === 0) {
    problems.push("cmsRelease is missing");
  }
  if (typeof snap.sourceUrl !== "string" || !snap.sourceUrl.startsWith("http")) {
    problems.push("sourceUrl is missing or not a URL");
  }
  if (!Array.isArray(snap.rxcuis) || snap.rxcuis.length === 0) problems.push("rxcuis is empty");
  // An empty formulary is the dangerous case: the UI would answer "not on your
  // plan's list" for every medication, which is a false claim about access.
  if (!Array.isArray(snap.formulary) || snap.formulary.length === 0) {
    problems.push("formulary has no rows - the UI would report every drug as not listed");
  }
  if (!Array.isArray(snap.plans) || snap.plans.length === 0) problems.push("plans has no rows");

  const row = Array.isArray(snap.formulary) ? snap.formulary[0] : null;
  if (row) {
    for (const field of ["formularyId", "rxcui", "priorAuthorization", "stepTherapy", "quantityLimit"]) {
      if (!(field in row)) problems.push(`formulary rows are missing "${field}" - shape looks pre-adapter`);
    }
    if ("tierLevelValue" in row || "priorAuthorizationYn" in row) {
      problems.push("formulary rows are in the PIPELINE shape, not the app shape - run app:snapshot");
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to ship the coverage snapshot:\n  - ${problems.join("\n  - ")}\n` +
        `Regenerate it with: cd data-pipeline && npm run app:snapshot`
    );
  }

  await mkdir(path.dirname(SNAPSHOT_TO), { recursive: true });
  await writeFile(SNAPSHOT_TO, JSON.stringify(snap, null, 2) + "\n", "utf8");
  snapshotNote =
    `coverage snapshot: ${snap.plans.length} plans, ${snap.formulary.length} formulary rows, ` +
    `CMS release ${snap.cmsRelease}`;
} catch (err) {
  if (err && err.code === "ENOENT") {
    // Absent is different from broken. The app already treats a missing
    // snapshot as "no formulary data" and says so, so this is a warning and
    // not a failed sync - but it is never silent.
    snapshotNote =
      `coverage snapshot NOT SHIPPED: ${SNAPSHOT_FROM} does not exist. ` +
      `Run: cd data-pipeline && npm run insurance:ingest && npm run app:snapshot`;
  } else {
    throw err;
  }
}

console.log(
  `synced ${plans.planCount} Part D plan identities (release ${plans.sourceRelease}, year ${plans.contractYear})`
);

const manifest = {
  note: "Generated by npm run content:sync. Do not edit by hand.",
  syncedAt: new Date().toISOString(),
  products: written,
  insurance: {
    market: plans.market,
    sourceRelease: plans.sourceRelease,
    contractYear: plans.contractYear,
    planCount: plans.planCount,
  },
};
await writeFile(path.join(TO, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

for (const key of written) console.log(`synced ${key}`);
for (const s of skipped) console.log(`SKIPPED ${s}`);
console.log(`\n${written.length} app-ready record(s) in ${TO}`);


console.log(snapshotNote);
