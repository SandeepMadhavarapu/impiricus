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

/**
 * Coverage evidence and product identity are synced here too, in the same
 * generated-committed-never-hand-edited way. See the two sections at the end.
 */

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
console.log(
  `synced ${plans.planCount} Part D plan identities (release ${plans.sourceRelease}, year ${plans.contractYear})`
);

/*
 * CMS Part D formulary snapshot.
 *
 * Produced by the pipeline's `npm run app:snapshot`, which is the ONE place
 * the pipeline's record is transformed into the shape the app validates
 * (data-pipeline/src/insurance/appSnapshot.ts, unit-tested there and
 * exercised end to end by tests/refresh.harness.test.ts). This script copies
 * it and refuses anything that does not look like that shape.
 *
 * This file used to be gitignored as "operator-generated", which meant it
 * simply did not exist on Vercel and every coverage check answered "not
 * connected to any formulary database" while 979 real rows sat in the
 * pipeline's committed output. It is committed now for the same reason
 * plans.json is: the app imports it, and the build container has no CMS
 * access and no pipeline checkout.
 *
 * A missing snapshot is a HARD failure, not a note. Shipping the app without
 * it would silently restore the exact defect above, and the app's static
 * import would fail the build anyway; better to say why here.
 */
const COVERAGE_TO = path.join("src", "sources", "content", "coverage");
await mkdir(COVERAGE_TO, { recursive: true });

const SNAPSHOT_FROM = path.join("data-pipeline", "data", "exports", "app", "cms-part-d-snapshot.json");
let appSnapshot;
try {
  appSnapshot = JSON.parse(await readFile(SNAPSHOT_FROM, "utf8"));
} catch (err) {
  if (err && err.code === "ENOENT") {
    throw new Error(
      `${SNAPSHOT_FROM} does not exist, so the coverage snapshot cannot be synced.\n` +
        `Run: cd data-pipeline && npm run insurance:ingest && npm run app:snapshot`
    );
  }
  throw err;
}

{
  const problems = [];
  if (appSnapshot.schemaVersion !== 1) problems.push(`schemaVersion is ${appSnapshot.schemaVersion}, expected 1`);
  if (typeof appSnapshot.cmsRelease !== "string" || !appSnapshot.cmsRelease) problems.push("cmsRelease is missing");
  if (!Number.isInteger(appSnapshot.contractYear)) problems.push("contractYear is missing or not an integer");
  if (typeof appSnapshot.sourceUrl !== "string" || !appSnapshot.sourceUrl.startsWith("http")) problems.push("sourceUrl is missing");
  if (!Array.isArray(appSnapshot.rxcuis) || appSnapshot.rxcuis.length === 0) problems.push("rxcuis is empty");
  if (!Array.isArray(appSnapshot.plans) || appSnapshot.plans.length === 0) problems.push("plans has no rows");
  if (!Array.isArray(appSnapshot.formulary) || appSnapshot.formulary.length === 0) {
    problems.push("formulary has no rows - the app would report every drug as not listed");
  }
  const row = Array.isArray(appSnapshot.formulary) ? appSnapshot.formulary[0] : null;
  if (row) {
    for (const field of ["formularyId", "rxcui", "tier", "priorAuthorization", "stepTherapy", "quantityLimit", "quantityLimitDescription"]) {
      if (!(field in row)) problems.push(`formulary rows are missing "${field}"`);
    }
    if ("tierLevelValue" in row || "priorAuthorizationYn" in row) {
      problems.push("formulary rows are in the PIPELINE shape, not the app shape - run app:snapshot");
    }
  }
  if (appSnapshot.cmsRelease !== plans.sourceRelease) {
    // Plans and formulary rows must come from the same monthly release, or a
    // formulary id in one may not mean the same document in the other.
    problems.push(
      `snapshot release ${appSnapshot.cmsRelease} != plan directory release ${plans.sourceRelease}; re-run the pipeline ingest and exports together`
    );
  }
  if (problems.length > 0) {
    throw new Error(`Refusing to sync the coverage snapshot:\n  - ${problems.join("\n  - ")}`);
  }
}

await writeFile(
  path.join(COVERAGE_TO, "cms-part-d-snapshot.json"),
  JSON.stringify(appSnapshot, null, 2) + "\n",
  "utf8"
);
console.log(
  `synced CMS Part D snapshot: ${appSnapshot.formulary.length} formulary rows across ${appSnapshot.plans.length} plans (release ${appSnapshot.cmsRelease}, year ${appSnapshot.contractYear})`
);

/*
 * Product concept identities, for the coverage lookup.
 *
 * A formulary lists RxNorm concepts, and a product has more than one: the
 * exact branded product (SBD, e.g. 153892 "montelukast 10 MG Oral Tablet
 * [Singulair]") and the generic clinical drug of the same strength and form
 * (SCD, 200224 "montelukast 10 MG Oral Tablet"). Brand Singulair is on ONE
 * formulary in the 2026-08 release; generic montelukast is on hundreds. The
 * lookup must search both and say which one it found, so this records both,
 * tagged. Ingredient-level concepts (IN) are deliberately left out: a
 * formulary never lists an ingredient, and matching on one would merge
 * every strength and form of a drug into one answer.
 *
 * Read from the pipeline's normalized records, which resolved these against
 * live RxNav and verified them against the SPL and NDC.
 */
const concepts = {};
for (const key of written) {
  const normalized = JSON.parse(
    await readFile(path.join("data-pipeline", "data", "normalized", `${key}.json`), "utf8")
  );
  const rx = normalized.rxnorm;
  if (!rx?.present || !rx.rxcui) {
    throw new Error(`${key}: no resolved RxNorm concept. Coverage cannot be looked up for it. Refusing to sync.`);
  }
  concepts[key] = {
    exact: { rxcui: rx.rxcui, name: rx.name ?? null, tty: rx.tty ?? null },
    clinicalDrug: (rx.related?.SCD ?? [])
      .filter((c) => c.rxcui !== rx.rxcui)
      .map((c) => ({ rxcui: c.rxcui, name: c.name ?? null })),
  };
}
await writeFile(
  path.join(COVERAGE_TO, "product-concepts.json"),
  JSON.stringify(
    {
      note: "Generated by npm run content:sync from data-pipeline/data/normalized. Do not edit by hand.",
      products: concepts,
    },
    null,
    2
  ) + "\n",
  "utf8"
);
console.log(`synced RxNorm concept identities for ${Object.keys(concepts).length} product(s)`);

const manifest = {
  note: "Generated by npm run content:sync. Do not edit by hand.",
  syncedAt: new Date().toISOString(),
  products: written,
  insurance: {
    market: plans.market,
    sourceRelease: plans.sourceRelease,
    contractYear: plans.contractYear,
    planCount: plans.planCount,
    formularyRows: appSnapshot.formulary.length,
  },
};
await writeFile(path.join(TO, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

for (const key of written) console.log(`synced ${key}`);
for (const s of skipped) console.log(`SKIPPED ${s}`);
console.log(`\n${written.length} app-ready record(s) in ${TO}`);
