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
 * The pipeline's normalized snapshot carries plan identities, the formulary
 * rows for our products' RXCUIs, and (for demo plans) cost-sharing rules. The
 * app reads a narrower shape, defined by FormularySnapshotSchema in
 * src/patient/lib/coverage/formulary.ts. Converting HERE, at the seam, keeps
 * the pipeline free to grow its record and the app free to stay strict.
 *
 * This file used to be gitignored as "operator-generated", which meant it
 * simply did not exist on Vercel and every coverage check answered "not
 * connected to any formulary database" while 979 real rows sat in the
 * pipeline's committed output. It is committed now for the same reason
 * plans.json is: the app imports it, and the build container has no CMS
 * access and no pipeline checkout.
 */
const COVERAGE_TO = path.join("src", "sources", "content", "coverage");
await mkdir(COVERAGE_TO, { recursive: true });

const pipelineSnapshot = JSON.parse(
  await readFile(
    path.join("data-pipeline", "data", "normalized", "insurance", "cms-part-d-snapshot.json"),
    "utf8"
  )
);
if (pipelineSnapshot.sourceId !== "cms-part-d-monthly-formulary") {
  throw new Error(`Expected a CMS Part D snapshot, got "${pipelineSnapshot.sourceId}". Refusing to sync.`);
}
const contractYear = Number.parseInt(pipelineSnapshot.contractYear, 10);
if (!Number.isInteger(contractYear)) {
  throw new Error(`Snapshot contractYear is unusable: ${pipelineSnapshot.contractYear}`);
}
if (pipelineSnapshot.release !== plans.sourceRelease) {
  // Plans and formulary rows must come from the same monthly release, or a
  // formulary id in one may not mean the same document in the other.
  throw new Error(
    `Snapshot release ${pipelineSnapshot.release} != plan directory release ${plans.sourceRelease}. Re-run the pipeline ingest.`
  );
}

const quantityLimitDescription = (row) => {
  if (!row.quantityLimitYn) return null;
  if (row.quantityLimitAmount && row.quantityLimitDays) {
    return `${row.quantityLimitAmount} per ${row.quantityLimitDays} days`;
  }
  // CMS flagged a limit but published no figures. Say that, rather than
  // rendering "null per null days" or pretending there is no limit.
  return "Limit applies; amount not published";
};

const appSnapshot = {
  schemaVersion: 1,
  cmsRelease: pipelineSnapshot.release,
  contractYear,
  sourceUrl: pipelineSnapshot.sourceUrl,
  retrievedAt: pipelineSnapshot.retrievedAt,
  rxcuis: [...pipelineSnapshot.rxcuisFiltered].sort(),
  plans: pipelineSnapshot.plans.map((p) => ({
    contractId: p.contractId,
    planId: p.planId,
    segmentId: p.segmentId ?? null,
    formularyId: p.formularyId,
    planName: p.planName,
    organizationName: p.organizationName ?? null,
  })),
  formulary: pipelineSnapshot.formulary.map((r) => ({
    formularyId: r.formularyId,
    rxcui: r.rxcui,
    tier: Number.isInteger(r.tierLevelValue) && r.tierLevelValue > 0 ? r.tierLevelValue : null,
    priorAuthorization: Boolean(r.priorAuthorizationYn),
    stepTherapy: Boolean(r.stepTherapyYn),
    quantityLimit: Boolean(r.quantityLimitYn),
    quantityLimitDescription: quantityLimitDescription(r),
  })),
};
await writeFile(
  path.join(COVERAGE_TO, "cms-part-d-snapshot.json"),
  JSON.stringify(appSnapshot, null, 2) + "\n",
  "utf8"
);
console.log(
  `synced CMS Part D snapshot: ${appSnapshot.formulary.length} formulary rows across ${appSnapshot.plans.length} plans (release ${appSnapshot.cmsRelease})`
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
