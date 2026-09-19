import { fetchSource, withOpenFdaKey, type RawCapture } from "./http.js";
import { SOURCES, MAX_PAGES } from "../config/sources.js";
import { PARSER_VERSION, type Provenance } from "../schemas/index.js";

/**
 * openFDA adapter: drug/ndc, drug/drugsfda, drug/label, drug/enforcement.
 *
 * Four things this adapter keeps strictly apart, because conflating them is how
 * a pipeline starts claiming FDA approval it cannot support:
 *
 *   drug/label       a SUBMITTED label, harmonized. Not proof of approval.
 *   drug/ndc         an NDC DIRECTORY ENTRY. Listing is not approval either.
 *   drug/drugsfda    an APPROVAL RECORD, at application AND product level.
 *   drug/enforcement RECALLS. Supplemental; never a patient-facing safety claim.
 *
 * drug/event (FAERS) is deliberately NOT implemented. Spontaneous reports have
 * no denominator, so they cannot support incidence, causation or comparative
 * safety, and there is no honest patient-facing use for them here.
 */

const BASE = SOURCES.openfda.baseUrl;

function lastUpdatedFrom(d: unknown): string | null {
  return (d as { meta?: { last_updated?: string } })?.meta?.last_updated ?? null;
}

export function openFdaProvenance(
  capture: RawCapture,
  locator: string,
  sourceIdentifier: string | null,
  effectiveDate: string | null,
  sourceId: "openfda" | "drugsfda" = "openfda"
): Provenance {
  return {
    sourceId,
    sourceName: sourceId === "drugsfda" ? SOURCES.drugsfda.name : SOURCES.openfda.name,
    url: capture.sanitizedUrl,
    retrievedAt: capture.retrievedAt,
    sourceEffectiveDate: effectiveDate ?? capture.sourceLastUpdated,
    sourceIdentifier,
    sourceVersion: null,
    rawPath: capture.rawPath,
    contentHash: capture.contentHash,
    captureId: capture.captureId,
    locator,
    parserVersion: PARSER_VERSION,
  };
}

/** Generic, page-safe query. Never follows more than MAX_PAGES pages. */
async function query<T>(
  endpoint: string,
  search: string,
  label: string,
  limit = 100,
  force = false
): Promise<{ results: T[]; captures: RawCapture[]; total: number }> {
  const results: T[] = [];
  const captures: RawCapture[] = [];
  let skip = 0;
  let total = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = withOpenFdaKey(
      `${BASE}${endpoint}?search=${encodeURIComponent(search)}&limit=${limit}&skip=${skip}`
    );
    let payload: { results?: T[]; meta?: { results?: { total?: number } } };
    let capture: RawCapture;
    try {
      const out = await fetchSource<typeof payload>("openfda", url, {
        label: `${label}-p${page}`,
        force,
        lastUpdatedFrom,
      });
      payload = out.data;
      capture = out.capture;
    } catch (err) {
      // openFDA returns 404 for "no matches". That is a legitimate empty
      // result, not a failure — but only on the FIRST page.
      const status = (err as { status?: number }).status;
      if (status === 404 && page === 0) return { results: [], captures: [], total: 0 };
      throw err;
    }

    captures.push(capture);
    const batch = payload.results ?? [];
    results.push(...batch);
    total = payload.meta?.results?.total ?? results.length;

    if (batch.length < limit || results.length >= total) break;
    skip += limit;
  }

  return { results, captures, total };
}

/* ------------------------------------------------------------ drug/ndc ---- */

export interface NdcDirectoryEntry {
  product_ndc: string;
  generic_name?: string;
  brand_name?: string;
  labeler_name?: string;
  dosage_form?: string;
  route?: string[];
  marketing_category?: string;
  application_number?: string;
  active_ingredients?: Array<{ name: string; strength: string }>;
  packaging?: Array<{ package_ndc: string; description: string; marketing_start_date?: string }>;
  openfda?: { rxcui?: string[]; unii?: string[]; spl_set_id?: string[] };
  marketing_start_date?: string;
  listing_expiration_date?: string;
}

export async function ndcByProductNdc(productNdc: string, force = false) {
  const { results, captures } = await query<NdcDirectoryEntry>(
    "/drug/ndc.json",
    `product_ndc:"${productNdc}"`,
    `ndc-${productNdc.replace(/\W+/g, "")}`,
    10,
    force
  );
  return {
    entries: results,
    provenance: captures.map((c) =>
      openFdaProvenance(c, "drug/ndc", productNdc, c.sourceLastUpdated)
    ),
  };
}

export async function ndcSearch(searchExpr: string, label: string, force = false) {
  const { results, captures, total } = await query<NdcDirectoryEntry>(
    "/drug/ndc.json",
    searchExpr,
    `ndc-search-${label}`,
    100,
    force
  );
  return {
    entries: results,
    total,
    provenance: captures.map((c) => openFdaProvenance(c, "drug/ndc", null, c.sourceLastUpdated)),
  };
}

/* ---------------------------------------------------------- drug/label ---- */

export async function labelBySetId(setId: string, force = false) {
  const { results, captures } = await query<Record<string, unknown>>(
    "/drug/label.json",
    `set_id:"${setId}"`,
    `label-${setId.slice(0, 8)}`,
    1,
    force
  );
  const entry = results[0] ?? null;
  const effective = entry ? String(entry["effective_time"] ?? "") : null;
  return {
    entry,
    provenance: captures.map((c) =>
      openFdaProvenance(
        c,
        "drug/label",
        setId,
        effective && effective.length === 8
          ? `${effective.slice(0, 4)}-${effective.slice(4, 6)}-${effective.slice(6, 8)}`
          : null
      )
    ),
  };
}

/* -------------------------------------------------------- drug/drugsfda --- */

export interface DrugsFdaProduct {
  product_number: string;
  reference_drug?: string;
  brand_name?: string;
  active_ingredients?: Array<{ name: string; strength: string }>;
  dosage_form?: string;
  route?: string;
  marketing_status?: string;
  te_code?: string;
}

export interface DrugsFdaApplication {
  application_number: string;
  sponsor_name?: string;
  openfda?: Record<string, unknown>;
  products?: DrugsFdaProduct[];
  submissions?: Array<{
    submission_type?: string;
    submission_number?: string;
    submission_status?: string;
    submission_status_date?: string;
    submission_class_code?: string;
  }>;
}

export async function drugsFdaByApplication(applicationNumber: string, force = false) {
  const { results, captures } = await query<DrugsFdaApplication>(
    "/drug/drugsfda.json",
    `application_number:"${applicationNumber}"`,
    `drugsfda-${applicationNumber}`,
    10,
    force
  );
  return {
    applications: results,
    provenance: captures.map((c) =>
      openFdaProvenance(c, "drug/drugsfda", applicationNumber, c.sourceLastUpdated, "drugsfda")
    ),
  };
}

/* ------------------------------------------------------ drug/enforcement -- */

export interface EnforcementRecord {
  recall_number: string;
  status: string;
  classification?: string;
  reason_for_recall: string;
  report_date?: string;
  product_description: string;
  openfda?: { product_ndc?: string[]; generic_name?: string[] };
}

/**
 * Recall records. Supplemental only.
 *
 * Product matching here is weak: enforcement records describe products in free
 * text and the openfda block is often absent. Each record is therefore returned
 * with an explicit `matchedOnNdc` flag so a loose text match is never presented
 * as a confirmed recall of the exact product.
 */
export async function enforcementForProduct(
  genericName: string,
  productNdc: string | null,
  force = false
) {
  const { results, captures } = await query<EnforcementRecord>(
    "/drug/enforcement.json",
    `openfda.generic_name:"${genericName}"`,
    `enforcement-${genericName.replace(/\W+/g, "-").slice(0, 24)}`,
    50,
    force
  );

  const records = results.map((r) => ({
    recallNumber: r.recall_number,
    status: r.status,
    classification: r.classification ?? null,
    reason: r.reason_for_recall,
    reportDate: r.report_date ?? null,
    productDescription: r.product_description,
    matchedOnNdc: Boolean(productNdc && (r.openfda?.product_ndc ?? []).includes(productNdc)),
  }));

  return {
    records,
    provenance: captures.map((c) =>
      openFdaProvenance(c, "drug/enforcement", genericName, c.sourceLastUpdated)
    ),
  };
}

/**
 * Deliberately not implemented.
 *
 * Exported so the omission is visible in code review and in the audit, rather
 * than being a silent gap someone later "fixes" by adding incidence maths.
 */
export const FAERS_POLICY = {
  implemented: false,
  endpoint: "https://api.fda.gov/drug/event.json",
  reason:
    "FAERS holds spontaneous adverse-event reports with no denominator and no verified causality. " +
    "It cannot support incidence, causation, or comparative safety, and this pipeline feeds " +
    "patient-facing content. Counting these reports would manufacture a statistic that does not exist.",
} as const;
