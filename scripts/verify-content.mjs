#!/usr/bin/env node
/**
 * Checks whether the stored medication source records are still current.
 *
 * Drug labels change. A stored record that is several versions behind is a real
 * safety problem, not a stale cache, so this exits non-zero when the live SPL
 * version no longer matches what is committed. Run it in CI on a schedule.
 *
 * Usage: npm run content:verify
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const UA = "mediz-hackathon-prototype/0.1 (content verify script)";
// Kept in step with scripts/fetch-label.mjs, which writes these records. The
// domain reorganisation moved them under src/sources/ and this path was missed,
// so the check ran against an empty directory and reported nothing to verify -
// a staleness check that cannot see the records is not a staleness check.
const SOURCE_DIR = path.join(process.cwd(), "src", "sources", "content", "sources");
const STALE_AFTER_DAYS = 90;

async function getJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error("GET " + url + " -> HTTP " + res.status);
  return res.json();
}

async function main() {
  const files = (await readdir(SOURCE_DIR)).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.error("No source records found in " + SOURCE_DIR);
    process.exit(1);
  }

  let problems = 0;

  for (const file of files) {
    const record = JSON.parse(await readFile(path.join(SOURCE_DIR, file), "utf8"));
    const setId = record.document.splSetId;
    const storedVersion = String(record.document.splVersion);

    console.log("\n" + record.recordId);
    console.log("  stored SPL version   v" + storedVersion + " (effective " + record.document.effectiveDate + ")");

    const ageDays = Math.floor(
      (Date.now() - Date.parse(record.provenance.retrievedAt)) / 86400000
    );
    console.log("  retrieved            " + ageDays + " days ago");
    if (ageDays > STALE_AFTER_DAYS) {
      console.warn("  WARNING              older than " + STALE_AFTER_DAYS + " days; the app shows a staleness notice");
      problems++;
    }

    try {
      const [fda, dm] = await Promise.all([
        getJson("https://api.fda.gov/drug/label.json?search=set_id:%22" + setId + "%22&limit=1"),
        getJson("https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?setid=" + setId),
      ]);

      const liveFda = String(fda.results?.[0]?.version ?? "unknown");
      const liveDm = String(dm.data?.[0]?.spl_version ?? "unknown");
      console.log("  live openFDA         v" + liveFda);
      console.log("  live DailyMed        v" + liveDm);

      if (liveFda !== storedVersion || liveDm !== storedVersion) {
        console.error("  OUT OF DATE          the label has been revised. Run: npm run content:fetch");
        problems++;
      } else {
        console.log("  OK                   still the current label version");
      }
    } catch (err) {
      console.error("  CHECK FAILED         " + err.message);
      problems++;
    }
  }

  console.log("");
  if (problems > 0) {
    console.error(problems + " problem(s) found.");
    process.exit(1);
  }
  console.log("All source records are current.");
}

main().catch((err) => {
  console.error("\nVerification failed:", err.message);
  process.exit(1);
});
