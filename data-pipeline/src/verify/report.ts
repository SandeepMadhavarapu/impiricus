import { readFileSync, readdirSync, existsSync } from "node:fs";
import { writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { parseSpl } from "../normalize/spl.js";
import { auditHighlights, renderHighlightsAudit } from "../normalize/highlightsAudit.js";
import { auditInteractions, renderInteractionAudit } from "../normalize/interactionAudit.js";
import { loadPartDSnapshot } from "../insurance/snapshot.js";
import { findPartDRelease } from "../sources/cmsPartD.js";

/**
 * The verification report.
 *
 * Produces the accounting the pipeline's claims rest on:
 *   1. Highlights extraction reconciliation, block by block
 *   2. Interaction substances with direction and supporting text
 *   3. Part D dataset scope: filters, members, rows read/retained/rejected
 *   4. Source vs retrieval dates, kept distinct
 */

async function atomicWrite(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, file);
}

export async function buildVerificationReport(checkLive: boolean): Promise<string> {
  const lines: string[] = [];
  lines.push("# Verification report");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    "Every number here is produced by code in `src/verify/` and `src/normalize/*Audit.ts`, " +
      "re-runnable with `npm run verify:report`."
  );
  lines.push("");

  /* 1. Highlights reconciliation */
  const rawDir = path.join("data", "raw", "dailymed");
  if (existsSync(rawDir)) {
    const reports = readdirSync(rawDir)
      .filter((f) => f.endsWith(".xml"))
      .map((f) => {
        const xml = readFileSync(path.join(rawDir, f), "utf8");
        const spl = parseSpl(xml);
        return auditHighlights(xml, [...spl.sections, ...spl.patientLabeling]);
      });
    lines.push(renderHighlightsAudit(reports));
  } else {
    lines.push("## FDA Highlights extraction accounting");
    lines.push("");
    lines.push(
      "Raw captures are gitignored and absent here. Run `npm run ingest -- --force` to regenerate " +
        "them, then re-run this report."
    );
  }
  lines.push("");

  /* 2. Interaction substances */
  const normDir = path.join("data", "normalized");
  const records = readdirSync(normDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(normDir, f), "utf8")));

  lines.push(
    renderInteractionAudit(
      records.map((r) => ({
        productKey: r.productKey,
        result: auditInteractions(r.interactions.sections, [
          r.identity.brandName ?? "",
          r.identity.genericName,
          r.identity.activeMoiety ?? "",
        ]),
      }))
    )
  );
  lines.push("");

  /* 3. Part D scope */
  const snap = loadPartDSnapshot();
  lines.push("## Medicare Part D dataset scope");
  lines.push("");
  if (!snap) {
    lines.push("No snapshot present. Run `npm run insurance:ingest`.");
  } else {
    const s = snap.scope;
    lines.push("| Measure | Value |");
    lines.push("|---|---:|");
    lines.push(`| Archive size | ${(snap.archiveBytes / 1073741824).toFixed(2)} GB |`);
    lines.push(`| Bytes fetched (HTTP range) | ${(snap.bytesFetched / 1048576).toFixed(1)} MB |`);
    lines.push(`| Formulary rows READ | ${s.formularyRowsRead.toLocaleString()} |`);
    lines.push(`| Formulary rows RETAINED | ${s.formularyRowsRetained.toLocaleString()} |`);
    lines.push(`| Rejected by RXCUI filter | ${s.formularyRowsRejectedRxcuiFilter.toLocaleString()} |`);
    lines.push(`| Plan rows READ | ${s.planRowsRead.toLocaleString()} |`);
    lines.push(`| Plan rows unique | ${s.planRowsUnique.toLocaleString()} |`);
    lines.push(`| Plan rows rejected (incomplete) | ${s.planRowsRejectedIncomplete} |`);
    lines.push(`| Plans RETAINED | ${s.plansRetained.toLocaleString()} |`);
    lines.push(`| Plans dropped (no matching formulary) | ${s.plansDroppedNoMatchingFormulary} |`);
    lines.push(`| Cost rules retained / available | ${s.costRulesRetained} / ${s.costRulesAvailable.toLocaleString()} |`);
    lines.push(`| Explicit exclusion rows | ${s.excludedRowsRead} |`);
    lines.push("");

    lines.push("### What the two headline numbers actually mean");
    lines.push("");
    lines.push(
      `**The ${s.formularyRowsRetained} formulary rows** are rows from the ${snap.release} release of ` +
        `the CMS basic drugs formulary file whose RXCUI is one of the ${snap.rxcuisFiltered.length} ` +
        `concepts linked to our three products. They are not all Part D formulary rows, and they are ` +
        `not a nationwide coverage statement.`
    );
    lines.push("");
    lines.push(
      `**The ${s.plansRetained} plans** are plans in the same release whose FORMULARY_ID appears on at ` +
        `least one retained row. A plan appearing here means its formulary carries one of our drugs at ` +
        `SOME match granularity - most often the generic clinical-drug concept, not the branded ` +
        `product. Branded Singulair and Toprol XL each appear on exactly one formulary in this release.`
    );
    lines.push("");

    lines.push("### Members fetched");
    lines.push("");
    lines.push("| Member | Compressed | Uncompressed |");
    lines.push("|---|---:|---:|");
    for (const m of s.membersFetched) {
      lines.push(
        `| ${m.name.replace(/\s+/g, " ")} | ${(m.compressedBytes / 1048576).toFixed(1)} MB | ${(m.uncompressedBytes / 1048576).toFixed(1)} MB |`
      );
    }
    lines.push("");
    const skippedGb =
      s.membersSkipped.reduce((n, m) => n + m.uncompressedBytes, 0) / 1073741824;
    lines.push(`### Members deliberately skipped (${s.membersSkipped.length}, ${skippedGb.toFixed(2)} GB)`);
    lines.push("");
    for (const m of s.membersSkipped.slice(0, 8)) {
      lines.push(
        `- ${m.name.replace(/\s+/g, " ")} (${(m.uncompressedBytes / 1048576).toFixed(0)} MB) - ${m.reason}`
      );
    }
    lines.push("");

    lines.push("### Unmatched identifiers and completeness checks");
    lines.push("");
    if (s.rxcuisWithNoMatch.length > 0) {
      lines.push(
        `- **RXCUIs searched with no formulary row anywhere (${s.rxcuisWithNoMatch.length}):** ` +
          `${s.rxcuisWithNoMatch.join(", ")}. A real finding, not an error - these concepts are ` +
          `genuinely absent from every formulary in the release.`
      );
    } else {
      lines.push("- Every searched RXCUI matched at least one formulary row.");
    }
    lines.push(
      s.formularyIdsWithoutPlan.length === 0
        ? "- **Referential integrity: PASS.** Every FORMULARY_ID on a retained row resolves to a plan."
        : `- **Referential integrity: ${s.formularyIdsWithoutPlan.length} FORMULARY_IDs resolve to no plan.**`
    );
    const arithmeticOk =
      s.formularyRowsRetained + s.formularyRowsRejectedRxcuiFilter === s.formularyRowsRead;
    lines.push(
      `- **Row arithmetic: ${arithmeticOk ? "PASS" : "FAIL"}.** retained ${s.formularyRowsRetained} + ` +
        `rejected ${s.formularyRowsRejectedRxcuiFilter.toLocaleString()} = ` +
        `${(s.formularyRowsRetained + s.formularyRowsRejectedRxcuiFilter).toLocaleString()} ` +
        `(read ${s.formularyRowsRead.toLocaleString()}).`
    );

    /* 4. Dates */
    lines.push("");
    lines.push("## Source dates, kept distinct");
    lines.push("");
    lines.push("| Field | Value | Meaning |");
    lines.push("|---|---|---|");
    lines.push(`| Dataset release | ${snap.release} | CMS release label from the file path |`);
    lines.push(`| Source published | ${snap.modified ?? "unknown"} | CMS catalogue \`modified\` date |`);
    lines.push(`| Contract year | ${snap.contractYear ?? "unknown"} | The plan year the rows apply to |`);
    lines.push(`| Retrieved at | ${snap.retrievedAt} | When WE fetched it. Never a substitute for the above |`);
    lines.push(
      `| Applicable effective dates | ${snap.contractYear}-01-01 to ${snap.contractYear}-12-31 | Part D plan year |`
    );
    lines.push("");

    if (checkLive) {
      try {
        const live = await findPartDRelease();
        const newer = live.release !== snap.release || live.modified !== snap.modified;
        lines.push(
          `**Live catalogue check:** current release is \`${live.release}\` (modified ${live.modified}). ` +
            (newer
              ? "A NEWER release is available. Run `npm run insurance:ingest` to refresh."
              : "Our snapshot is current.")
        );
      } catch (err) {
        lines.push(
          `**Live catalogue check FAILED:** ${String(err)}. The committed snapshot is unchanged and ` +
            "its recorded dates still apply."
        );
      }
    } else {
      lines.push("_Live catalogue check skipped. Pass `--live` to check for a newer CMS release._");
    }
  }

  const out = path.join("data", "reports", "verification.md");
  await atomicWrite(out, lines.join("\n") + "\n");
  return out;
}
