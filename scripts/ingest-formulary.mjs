#!/usr/bin/env node
/**
 * Ingests real CMS Medicare Part D formulary data for the configured product.
 *
 * Source: "Monthly Prescription Drug Plan Formulary and Pharmacy Network
 * Information", published by the Centers for Medicare & Medicaid Services as
 * public domain data. The release is located at run time from the CMS open
 * data catalogue (https://data.cms.gov/data.json) so this does not rot against
 * a hardcoded URL.
 *
 * The download is LARGE (~2.2 GB compressed). That is why the extracted
 * snapshot is committed-by-the-operator rather than shipped: we keep only the
 * rows matching this product's RXCUIs plus the plan index, which is a few
 * hundred KB.
 *
 * Usage:
 *   npm run coverage:ingest                # download, extract, write snapshot
 *   npm run coverage:ingest -- --dry-run   # resolve the release only, no download
 *   npm run coverage:ingest -- --keep      # keep the downloaded zip for re-runs
 *
 * Requires: unzip available on PATH (Git Bash on Windows provides it), or set
 * FORMULARY_ZIP to a zip you already downloaded.
 */
import { writeFile, mkdir, readdir, readFile, stat, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const UA = "medbridge-hackathon-prototype/0.1 (formulary ingest)";
const CATALOG = "https://data.cms.gov/data.json";
const DATASET_TITLE = "Monthly Prescription Drug Plan Formulary and Pharmacy Network Information";

/** RXCUIs for the product this app publishes. Keep in sync with the source record. */
const SOURCE_RECORD = "src/sources/content/sources/singulair-montelukast-10mg-tablet.json";

const OUT_PATH = path.join("src", "sources", "content", "coverage", "cms-part-d-snapshot.json");

const keepZip = process.argv.includes("--keep");
/** Resolves the live CMS release and reports it, without downloading. */
const dryRun = process.argv.includes("--dry-run");

async function findRelease() {
  console.log("Locating the current CMS release...");
  const res = await fetch(CATALOG, {
    headers: { Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`CMS catalogue -> HTTP ${res.status}`);
  const catalog = await res.json();
  const dataset = (catalog.dataset || []).find((d) => (d.title || "").trim() === DATASET_TITLE);
  if (!dataset) throw new Error(`Dataset not found in catalogue: ${DATASET_TITLE}`);

  const dist = (dataset.distribution || []).find((d) =>
    (d.downloadURL || d.accessURL || "").endsWith(".zip")
  );
  if (!dist) throw new Error("No zip distribution found for the dataset");

  const url = dist.downloadURL || dist.accessURL;
  // Release label from the path, e.g. ".../2026-08/..." -> "2026-08".
  const match = url.match(/\/(\d{4}-\d{2})\//);
  return { url, release: match ? match[1] : "unknown", modified: dataset.modified || null };
}

async function download(url, dest) {
  const head = await fetch(url, { method: "HEAD", headers: { "User-Agent": UA } });
  const size = Number(head.headers.get("content-length") || 0);
  console.log(`Downloading ${(size / 1048576).toFixed(0)} MB — this takes a while.`);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok || !res.body) throw new Error(`Download failed -> HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const written = await stat(dest);
  console.log(`  wrote ${(written.size / 1048576).toFixed(0)} MB to ${dest}`);
}

/** Splits a CMS pipe-delimited line. */
const cols = (line) => line.split("|").map((c) => c.trim());

const yn = (v) => String(v).toUpperCase() === "Y";

async function main() {
  const record = JSON.parse(await readFile(SOURCE_RECORD, "utf8"));
  const rxcuis = (record.product.rxcui || []).map(String);
  if (rxcuis.length === 0) throw new Error("Source record has no RXCUIs to match on");
  console.log(`Matching RXCUIs: ${rxcuis.join(", ")}`);

  const { url, release, modified } = await findRelease();
  console.log(`  release ${release}${modified ? ` (modified ${modified})` : ""}`);
  console.log(`  ${url}`);

  if (dryRun) {
    const head = await fetch(url, { method: "HEAD", headers: { "User-Agent": UA } });
    const size = Number(head.headers.get("content-length") || 0);
    console.log(`
Dry run. Release resolved and reachable:`);
    console.log(`  HTTP ${head.status}, ${(size / 1048576).toFixed(0)} MB`);
    console.log(`  Run without --dry-run to download and write ${OUT_PATH}.`);
    return;
  }

  const workDir = path.join(os.tmpdir(), "medbridge-formulary");
  await mkdir(workDir, { recursive: true });
  const zipPath = process.env.FORMULARY_ZIP || path.join(workDir, `${release}.zip`);

  if (!process.env.FORMULARY_ZIP) {
    await download(url, zipPath);
  } else {
    console.log(`Using existing zip: ${zipPath}`);
  }

  const extractDir = path.join(workDir, "extract");
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });

  // Extract only the two files we need, by name pattern.
  console.log("Extracting formulary and plan files...");
  execFileSync("unzip", ["-o", "-j", zipPath, "*basic*drugs*formulary*", "*plan*information*", "-d", extractDir], {
    stdio: "inherit",
  });

  const files = await readdir(extractDir);
  const formularyFile = files.find((f) => /basic.*drugs.*formulary/i.test(f));
  const planFile = files.find((f) => /plan.*information/i.test(f));
  if (!formularyFile || !planFile) {
    throw new Error(`Expected files not found in archive. Got: ${files.join(", ")}`);
  }

  // --- plans -------------------------------------------------------------
  const planText = await readFile(path.join(extractDir, planFile), "utf8");
  const planLines = planText.split(/\r?\n/).filter(Boolean);
  const planHeader = cols(planLines[0]).map((h) => h.toUpperCase());
  const pIdx = (name) => planHeader.indexOf(name);

  const plans = [];
  const seenPlan = new Set();
  for (const line of planLines.slice(1)) {
    const c = cols(line);
    const formularyId = c[pIdx("FORMULARY_ID")];
    const planName = c[pIdx("PLAN_NAME")];
    if (!formularyId || !planName) continue;
    const key = `${c[pIdx("CONTRACT_ID")]}|${c[pIdx("PLAN_ID")]}|${formularyId}`;
    if (seenPlan.has(key)) continue;
    seenPlan.add(key);
    plans.push({
      contractId: c[pIdx("CONTRACT_ID")] || "",
      planId: c[pIdx("PLAN_ID")] || "",
      segmentId: c[pIdx("SEGMENT_ID")] || null,
      formularyId,
      planName,
      organizationName:
        pIdx("ORGANIZATION_NAME") >= 0 ? c[pIdx("ORGANIZATION_NAME")] || null : null,
    });
  }
  console.log(`  plans indexed: ${plans.length}`);

  // --- formulary rows, filtered to our RXCUIs ----------------------------
  const wanted = new Set(rxcuis);
  const formText = await readFile(path.join(extractDir, formularyFile), "utf8");
  const formLines = formText.split(/\r?\n/).filter(Boolean);
  const fHeader = cols(formLines[0]).map((h) => h.toUpperCase());
  const fIdx = (name) => fHeader.indexOf(name);

  const formulary = [];
  for (const line of formLines.slice(1)) {
    const c = cols(line);
    const rxcui = c[fIdx("RXCUI")];
    if (!wanted.has(rxcui)) continue;
    const tierRaw = Number(c[fIdx("TIER_LEVEL_VALUE")]);
    const qlAmount = fIdx("QUANTITY_LIMIT_AMOUNT") >= 0 ? c[fIdx("QUANTITY_LIMIT_AMOUNT")] : "";
    const qlDays = fIdx("QUANTITY_LIMIT_DAYS") >= 0 ? c[fIdx("QUANTITY_LIMIT_DAYS")] : "";
    const hasQl = yn(c[fIdx("QUANTITY_LIMIT_YN")]);
    formulary.push({
      formularyId: c[fIdx("FORMULARY_ID")] || "",
      rxcui,
      tier: Number.isFinite(tierRaw) && tierRaw > 0 ? tierRaw : null,
      priorAuthorization: yn(c[fIdx("PRIOR_AUTHORIZATION_YN")]),
      stepTherapy: yn(c[fIdx("STEP_THERAPY_YN")]),
      quantityLimit: hasQl,
      quantityLimitDescription:
        hasQl && qlAmount && qlDays ? `${qlAmount} per ${qlDays} days` : null,
    });
  }
  console.log(`  formulary rows for this product: ${formulary.length}`);

  if (formulary.length === 0) {
    console.warn(
      "\nNo rows matched. The snapshot will NOT be written — an empty snapshot would make every\n" +
        "plan look like 'not listed', which is exactly the false negative we must never produce."
    );
    process.exit(1);
  }

  // Keep only plans whose formulary actually appears, to bound file size.
  const usedFormularies = new Set(formulary.map((f) => f.formularyId));
  const relevantPlans = plans.filter((p) => usedFormularies.has(p.formularyId));

  const snapshot = {
    schemaVersion: 1,
    cmsRelease: release,
    sourceUrl: url,
    retrievedAt: new Date().toISOString(),
    rxcuis,
    plans: relevantPlans,
    formulary,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");

  const written = await stat(OUT_PATH);
  console.log(`\nWrote ${OUT_PATH} (${(written.size / 1024).toFixed(0)} KB)`);
  console.log(`  plans covering this product: ${relevantPlans.length}`);
  console.log(`  release: ${release}`);
  console.log("\nThe coverage flow will now return real, plan-specific formulary evidence.");

  if (!keepZip && !process.env.FORMULARY_ZIP) {
    await rm(zipPath, { force: true });
  }
  await rm(extractDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("\nIngest failed:", err.message);
  console.error("The app keeps reporting 'unable to verify' — no fabricated data is substituted.");
  process.exit(1);
});
