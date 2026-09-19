import { fetchSource, type RawCapture } from "./http.js";
import { SOURCES } from "../config/sources.js";
import { PARSER_VERSION, type Provenance } from "../schemas/index.js";

/**
 * DailyMed SPL Web Services v2 adapter.
 *
 * The full SPL XML is the reason this adapter exists. openFDA's drug/label
 * endpoint returns each section as a flat array of strings, which destroys
 * table structure and subsection nesting — a dosing table becomes prose and you
 * can no longer tell which dose belongs to which age group. The XML preserves
 * both, so it is the source of record for label content here.
 *
 * Endpoints used (all probed live):
 *   /spls.json?setid={setid}            metadata
 *   /spls/{setid}.xml                   full structured SPL
 *   /spls/{setid}/history.json          version history
 *   /spls/{setid}/media.json            figures
 *   /spls/{setid}/packaging.json        package identifiers
 *   /drugnames.json?drug_name=...       name search
 *
 * Note: /spls/{setid}.json returns HTTP 415. Only .xml is served for the full
 * document; the .json variants are the sub-resources listed above.
 */

const BASE = SOURCES.dailymed.baseUrl;

export function dailyMedProvenance(
  capture: RawCapture,
  locator: string,
  setId: string | null,
  version: string | null,
  effectiveDate: string | null
): Provenance {
  return {
    sourceId: "dailymed",
    sourceName: SOURCES.dailymed.name,
    url: capture.sanitizedUrl,
    retrievedAt: capture.retrievedAt,
    sourceEffectiveDate: effectiveDate,
    sourceIdentifier: setId,
    sourceVersion: version,
    rawPath: capture.rawPath,
    contentHash: capture.contentHash,
    captureId: capture.captureId,
    locator,
    parserVersion: PARSER_VERSION,
  };
}

export interface SplMetadata {
  setId: string;
  splVersion: string;
  title: string;
  publishedDate: string;
  provenance: Provenance;
}

export async function getSplMetadata(setId: string, force = false): Promise<SplMetadata | null> {
  const url = `${BASE}/spls.json?setid=${setId}`;
  const { data, capture } = await fetchSource<{
    data?: Array<{ setid: string; spl_version: number; title: string; published_date: string }>;
  }>("dailymed", url, {
    label: `spl-meta-${setId.slice(0, 8)}`,
    force,
    lastUpdatedFrom: (d) =>
      (d as { metadata?: { db_published_date?: string } })?.metadata?.db_published_date ?? null,
  });

  const row = data.data?.[0];
  if (!row) return null;
  return {
    setId: row.setid,
    splVersion: String(row.spl_version),
    title: row.title,
    publishedDate: row.published_date,
    provenance: dailyMedProvenance(
      capture,
      "spls.json",
      row.setid,
      String(row.spl_version),
      row.published_date
    ),
  };
}

/** The full structured SPL document, as XML. This is the source of record. */
export async function getSplXml(setId: string, force = false) {
  const url = `${BASE}/spls/${setId}.xml`;
  const { data, capture } = await fetchSource<string>("dailymed", url, {
    as: "text",
    label: `spl-${setId.slice(0, 8)}`,
    force,
  });
  return { xml: data, capture };
}

/** Version history. Used to detect that a label changed under us. */
export async function getSplHistory(setId: string, force = false) {
  const url = `${BASE}/spls/${setId}/history.json`;
  const { data, capture } = await fetchSource<{
    data?: { history?: Array<{ spl_version: number; published_date: string }> };
  }>("dailymed", url, { label: `spl-history-${setId.slice(0, 8)}`, force });
  const history = (data.data?.history ?? []).map((h) => ({
    splVersion: String(h.spl_version),
    publishedDate: h.published_date,
  }));
  return {
    history,
    provenance: dailyMedProvenance(capture, "history.json", setId, null, null),
  };
}

/** Package identifiers as DailyMed holds them. */
export async function getSplPackaging(setId: string, force = false) {
  const url = `${BASE}/spls/${setId}/packaging.json`;
  const { data, capture } = await fetchSource<{
    data?: { products?: Array<Record<string, unknown>> };
  }>("dailymed", url, { label: `spl-packaging-${setId.slice(0, 8)}`, force });
  return {
    products: data.data?.products ?? [],
    provenance: dailyMedProvenance(capture, "packaging.json", setId, null, null),
  };
}

/** Name search. Candidate generation only — never accepted as a match alone. */
export async function searchDrugNames(name: string, force = false) {
  const url = `${BASE}/drugnames.json?drug_name=${encodeURIComponent(name)}`;
  const { data, capture } = await fetchSource<{ data?: Array<{ drug_name: string }> }>(
    "dailymed",
    url,
    { label: `drugnames-${name.slice(0, 20).replace(/\W+/g, "-")}`, force }
  );
  return {
    names: (data.data ?? []).map((d) => d.drug_name),
    provenance: dailyMedProvenance(capture, "drugnames.json", null, null, null),
  };
}

/** Human-readable destinations for a set id. */
export function humanReadableUrls(setId: string) {
  return {
    label: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${setId}`,
    medicationGuide: `https://dailymed.nlm.nih.gov/dailymed/medguide.cfm?setid=${setId}`,
  };
}
