#!/usr/bin/env node
/**
 * Fetches FDA-approved labeling for the configured product and writes a
 * provenance-stamped source record to src/sources/content/sources/.
 *
 * Every field written here comes from a public API response. Nothing in this
 * script authors clinical text; it only transcribes and records where the text
 * came from, which document version it belongs to, and when it was retrieved.
 *
 * Sources:
 *   - openFDA drug/label   (structured product labeling, FDA)
 *   - openFDA drug/ndc     (NDC directory - product identity, packaging)
 *   - DailyMed v2 spls     (NLM - independent corroboration of SPL version)
 *
 * Usage: npm run content:fetch -- <medication-slug>
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const slug = process.argv[2] ?? "singulair-montelukast-10mg-tablet";
const supported = ["singulair-montelukast-10mg-tablet", "toprol-xl-metoprolol-succinate-50mg-er-tablet", "ozempic-semaglutide-1_34mg-per-ml-injection"];
if (!supported.includes(slug)) throw new Error("Unknown medication slug");
const exported = JSON.parse(await readFile(new URL(`../src/sources/content/label-exports/${slug}.json`, import.meta.url), "utf8"));
const TARGET = {
  recordId: slug,
  splSetId: exported.identifiers.splSetId,
  productNdc: exported.identifiers.productNdc,
  applicationNumber: exported.identifiers.applicationNumber,
};

const UA = "mediz-hackathon-prototype/0.1 (content fetch script)";

async function getJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error("GET " + url + " -> HTTP " + res.status);
  return res.json();
}

/** openFDA returns each label section as an array of strings. */
const flat = (v) =>
  Array.isArray(v) ? v.join("\n\n").trim() : typeof v === "string" ? v.trim() : "";

/**
 * Label sections we transcribe, with the numbering used in the printed label
 * so citations can point a reader at the right place.
 */
const SECTION_MAP = [
  ["boxed_warning", "BOXED WARNING", "Boxed Warning"],
  ["indications_and_usage", "1", "Indications and Usage"],
  ["dosage_and_administration", "2", "Dosage and Administration"],
  ["dosage_forms_and_strengths", "3", "Dosage Forms and Strengths"],
  ["contraindications", "4", "Contraindications"],
  ["warnings_and_cautions", "5", "Warnings and Precautions"],
  ["adverse_reactions", "6", "Adverse Reactions"],
  ["drug_interactions", "7", "Drug Interactions"],
  ["use_in_specific_populations", "8", "Use in Specific Populations"],
  ["pregnancy", "8.1", "Pregnancy"],
  ["pediatric_use", "8.4", "Pediatric Use"],
  ["geriatric_use", "8.5", "Geriatric Use"],
  ["overdosage", "10", "Overdosage"],
  ["description", "11", "Description"],
  ["clinical_pharmacology", "12", "Clinical Pharmacology"],
  ["mechanism_of_action", "12.1", "Mechanism of Action"],
  ["clinical_studies", "14", "Clinical Studies"],
  ["how_supplied", "16", "How Supplied/Storage and Handling"],
  ["information_for_patients", "17", "Patient Counseling Information"],
  ["spl_medguide", "MEDGUIDE", "Medication Guide"],
];

async function main() {
  const retrievedAt = new Date().toISOString();

  const labelUrl =
    "https://api.fda.gov/drug/label.json?search=set_id:%22" + TARGET.splSetId + "%22&limit=1";
  const ndcUrl =
    "https://api.fda.gov/drug/ndc.json?search=product_ndc:%22" + TARGET.productNdc + "%22&limit=1";
  const dailyMedUrl =
    "https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?setid=" + TARGET.splSetId;

  console.log("Fetching openFDA label, openFDA NDC, DailyMed metadata...");
  const [labelRes, ndcRes, dmRes] = await Promise.all([
    getJson(labelUrl),
    getJson(ndcUrl),
    getJson(dailyMedUrl),
  ]);

  const label = labelRes.results && labelRes.results[0];
  const ndc = ndcRes.results && ndcRes.results[0];
  const dm = dmRes.data && dmRes.data[0];
  if (!label) throw new Error("openFDA returned no label for the configured SPL set id");
  if (!ndc) throw new Error("openFDA NDC directory returned no product for the configured NDC");
  if (!dm) throw new Error("DailyMed returned no SPL for the configured set id");

  // Guard: the product identity must match what we think we are publishing.
  if (ndc.application_number !== TARGET.applicationNumber) {
    throw new Error(
      "NDC application number mismatch: expected " +
        TARGET.applicationNumber +
        ", got " +
        ndc.application_number
    );
  }
  const xmlUrl = `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/${TARGET.splSetId}.xml`;
  const xmlResponse = await fetch(xmlUrl, { signal: AbortSignal.timeout(30000) });
  if (!xmlResponse.ok) throw new Error("Unable to verify SPL product identity");
  const xml = await xmlResponse.text();
  if (label.set_id !== TARGET.splSetId || !xml.includes(`code="${TARGET.productNdc}"`)) {
    throw new Error("Label does not identify the selected product NDC");
  }
  // Guard: openFDA and DailyMed must agree on the SPL version, otherwise one
  // source is stale and we must not silently pick a winner.
  if (String(label.version) !== String(dm.spl_version)) {
    throw new Error(
      "SPL version disagreement - openFDA v" +
        label.version +
        " vs DailyMed v" +
        dm.spl_version +
        ". Reconcile manually before publishing."
    );
  }

  const sections = [];
  for (const entry of SECTION_MAP) {
    const key = entry[0];
    const text = flat(label[key]);
    if (!text) continue;
    sections.push({ id: key, labelSectionRef: entry[1], title: entry[2], text });
  }

  const eff = String(label.effective_time || "");
  const effectiveDate =
    eff.length === 8 ? eff.slice(0, 4) + "-" + eff.slice(4, 6) + "-" + eff.slice(6, 8) : null;

  const record = {
    recordId: TARGET.recordId,
    schemaVersion: 1,
    product: {
      brandName: ndc.brand_name,
      genericName: ndc.generic_name,
      labelerName: ndc.labeler_name,
      productNdc: ndc.product_ndc,
      dosageForm: ndc.dosage_form,
      route: Array.isArray(ndc.route) ? ndc.route : [ndc.route].filter(Boolean),
      strength: (ndc.active_ingredients || []).map((a) => a.name + " " + a.strength),
      applicationNumber: ndc.application_number,
      marketingCategory: ndc.marketing_category,
      packaging: (ndc.packaging || []).map((p) => ({
        packageNdc: p.package_ndc,
        description: p.description,
      })),
      rxcui: ((label.openfda && label.openfda.rxcui) || []).slice(0, 12),
      unii: (label.openfda && label.openfda.unii) || [],
    },
    // The SPL document this text belongs to.
    document: {
      splSetId: label.set_id,
      splVersion: String(label.version),
      splId: label.id,
      effectiveDate,
      dailyMedPublishedDate: dm.published_date,
      dailyMedTitle: dm.title,
      // Record the products covered by this SPL so downstream code can warn
      // rather than silently generalise across forms.
      coversDosageForms: exported.document.productsInDocument,
    },
    provenance: {
      retrievedAt,
      sources: [
        {
          name: "openFDA Drug Label API",
          publisher: "U.S. Food & Drug Administration",
          url: labelUrl,
          lastUpdated: (labelRes.meta && labelRes.meta.last_updated) || null,
        },
        {
          name: "openFDA NDC Directory API",
          publisher: "U.S. Food & Drug Administration",
          url: ndcUrl,
          lastUpdated: (ndcRes.meta && ndcRes.meta.last_updated) || null,
        },
        {
          name: "DailyMed SPL Service v2",
          publisher: "U.S. National Library of Medicine",
          url: dailyMedUrl,
          lastUpdated: (dmRes.metadata && dmRes.metadata.db_published_date) || null,
        },
      ],
      humanReadable: {
        dailyMed:
          "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=" + label.set_id,
        medicationGuide:
          "https://dailymed.nlm.nih.gov/dailymed/medguide.cfm?setid=" + label.set_id,
      },
      // Deliberately null. No clinician has reviewed this prototype's content.
      // Never populate this without a real, named, dated review.
      clinicallyReviewedAt: null,
      clinicallyReviewedBy: null,
    },
    sections,
  };

  const outDir = path.join(process.cwd(), "src", "sources", "content", "sources");
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, TARGET.recordId + ".json");
  await writeFile(outFile, JSON.stringify(record, null, 2) + "\n", "utf8");

  console.log("\nWrote " + path.relative(process.cwd(), outFile));
  console.log("  product      " + record.product.brandName + " " + record.product.strength.join(", ") + " " + record.product.dosageForm);
  console.log("  application  " + record.product.applicationNumber);
  console.log("  SPL          set " + record.document.splSetId + " v" + record.document.splVersion);
  console.log("  effective    " + record.document.effectiveDate + " (DailyMed published " + record.document.dailyMedPublishedDate + ")");
  console.log("  sections     " + record.sections.length);
  console.log("  retrievedAt  " + record.provenance.retrievedAt);
}

main().catch((err) => {
  console.error("\nFetch failed:", err.message);
  process.exit(1);
});
