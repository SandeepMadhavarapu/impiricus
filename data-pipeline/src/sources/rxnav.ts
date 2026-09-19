import { fetchSource, type RawCapture } from "./http.js";
import { SOURCES } from "../config/sources.js";
import { PARSER_VERSION, type Provenance } from "../schemas/index.js";

/**
 * RxNav / RxNorm adapter.
 *
 * RxNorm normalizes drug identity and relationships. It is NOT a monograph
 * source and NOT an interaction engine — the RxNav Drug Interaction API was
 * discontinued and now returns HTTP 404, which `interactionApiStatus()` reports
 * honestly rather than papering over.
 *
 * Endpoints used (all probed live, see docs/SOURCES.md):
 *   /REST/rxcui.json?name=...
 *   /REST/rxcui/{rxcui}/properties.json
 *   /REST/rxcui/{rxcui}/historystatus.json
 *   /REST/rxcui/{rxcui}/allrelated.json
 *   /REST/rxcui/{rxcui}/ndcs.json
 *   /REST/ndcstatus.json?ndc=...
 *   /REST/approximateTerm.json?term=...
 */

const BASE = SOURCES.rxnav.baseUrl;

export function rxnavProvenance(
  capture: RawCapture,
  locator: string,
  sourceIdentifier: string | null = null
): Provenance {
  return {
    sourceId: "rxnav",
    sourceName: SOURCES.rxnav.name,
    url: capture.sanitizedUrl,
    retrievedAt: capture.retrievedAt,
    // RxNav responses carry no per-concept publication date. Recording null is
    // correct; substituting retrievedAt would be a lie about the data's age.
    sourceEffectiveDate: null,
    sourceIdentifier,
    sourceVersion: null,
    rawPath: capture.rawPath,
    contentHash: capture.contentHash,
    captureId: capture.captureId,
    locator,
    parserVersion: PARSER_VERSION,
  };
}

export interface RxNormConcept {
  rxcui: string;
  name: string;
  tty: string;
  synonym: string | null;
}

export interface RxNormIdentity {
  concept: RxNormConcept;
  isCurrent: boolean;
  status: string;
  /** TTY -> concepts. SBD, SCD, IN, PIN, BN, DF, SBDF, SCDF, ... */
  related: Record<string, Array<{ rxcui: string; name: string }>>;
  ndc11: string[];
  provenance: Provenance[];
}

/** Exact-name lookup. Returns every RXCUI RxNorm maps the string to. */
export async function findRxcuiByName(name: string, force = false): Promise<{
  rxcuis: string[];
  provenance: Provenance;
}> {
  const url = `${BASE}/rxcui.json?name=${encodeURIComponent(name)}`;
  const { data, capture } = await fetchSource<{ idGroup?: { rxnormId?: string[] } }>(
    "rxnav",
    url,
    { label: "rxcui-by-name" , force }
  );
  return {
    rxcuis: data.idGroup?.rxnormId ?? [],
    provenance: rxnavProvenance(capture, `rxcui.json?name=${name}`),
  };
}

/** Approximate match — used ONLY to generate candidates, never to accept one. */
export async function approximateTerm(term: string, maxEntries = 10, force = false) {
  const url = `${BASE}/approximateTerm.json?term=${encodeURIComponent(term)}&maxEntries=${maxEntries}`;
  const { data, capture } = await fetchSource<{
    approximateGroup?: { candidate?: Array<{ rxcui: string; score: string; rank: string }> };
  }>("rxnav", url, { label: "approximate", force });
  return {
    candidates: data.approximateGroup?.candidate ?? [],
    provenance: rxnavProvenance(capture, `approximateTerm.json?term=${term}`),
  };
}

export async function getProperties(rxcui: string, force = false) {
  const url = `${BASE}/rxcui/${rxcui}/properties.json`;
  const { data, capture } = await fetchSource<{
    properties?: { rxcui: string; name: string; tty: string; synonym?: string };
  }>("rxnav", url, { label: `properties-${rxcui}`, force });
  if (!data.properties) return null;
  return {
    concept: {
      rxcui: data.properties.rxcui,
      name: data.properties.name,
      tty: data.properties.tty,
      synonym: data.properties.synonym || null,
    } satisfies RxNormConcept,
    provenance: rxnavProvenance(capture, "properties", rxcui),
  };
}

/**
 * Status and history.
 *
 * An RXCUI can be obsolete or remapped. Treating an old identifier as current
 * is one of the failure modes this pipeline must not have.
 */
export async function getHistoryStatus(rxcui: string, force = false) {
  const url = `${BASE}/rxcui/${rxcui}/historystatus.json`;
  const { data, capture } = await fetchSource<{
    rxcuiStatusHistory?: {
      metaData?: { status?: string; isCurrent?: string; remappedDate?: string };
    };
  }>("rxnav", url, { label: `history-${rxcui}`, force });
  const meta = data.rxcuiStatusHistory?.metaData;
  return {
    status: meta?.status ?? "unknown",
    isCurrent: (meta?.isCurrent ?? "").toUpperCase() === "YES",
    remappedDate: meta?.remappedDate || null,
    provenance: rxnavProvenance(capture, "historystatus", rxcui),
  };
}

export async function getAllRelated(rxcui: string, force = false) {
  const url = `${BASE}/rxcui/${rxcui}/allrelated.json`;
  const { data, capture } = await fetchSource<{
    allRelatedGroup?: {
      conceptGroup?: Array<{
        tty: string;
        conceptProperties?: Array<{ rxcui: string; name: string }>;
      }>;
    };
  }>("rxnav", url, { label: `allrelated-${rxcui}`, force });

  const related: Record<string, Array<{ rxcui: string; name: string }>> = {};
  for (const group of data.allRelatedGroup?.conceptGroup ?? []) {
    if (!group.conceptProperties?.length) continue;
    related[group.tty] = group.conceptProperties.map((c) => ({ rxcui: c.rxcui, name: c.name }));
  }
  return { related, provenance: rxnavProvenance(capture, "allrelated", rxcui) };
}

/** NDCs RxNorm associates with a concept. RxNav returns 11-digit form. */
export async function getNdcs(rxcui: string, force = false) {
  const url = `${BASE}/rxcui/${rxcui}/ndcs.json`;
  const { data, capture } = await fetchSource<{ ndcGroup?: { ndcList?: { ndc?: string[] } } }>(
    "rxnav",
    url,
    { label: `ndcs-${rxcui}`, force }
  );
  return {
    ndc11: data.ndcGroup?.ndcList?.ndc ?? [],
    provenance: rxnavProvenance(capture, "ndcs", rxcui),
  };
}

/** Status of a specific NDC, including whether RxNorm still considers it active. */
export async function getNdcStatus(ndc: string, force = false) {
  const url = `${BASE}/ndcstatus.json?ndc=${encodeURIComponent(ndc)}`;
  const { data, capture } = await fetchSource<{
    ndcStatus?: {
      ndc11?: string;
      status?: string;
      active?: string;
      rxcui?: string;
      conceptName?: string;
      conceptStatus?: string;
    };
  }>("rxnav", url, { label: `ndcstatus-${ndc.replace(/\D/g, "")}`, force });
  const s = data.ndcStatus;
  return {
    ndc11: s?.ndc11 ?? null,
    status: s?.status ?? "UNKNOWN",
    active: (s?.active ?? "").toUpperCase() === "YES",
    rxcui: s?.rxcui ?? null,
    conceptName: s?.conceptName ?? null,
    provenance: rxnavProvenance(capture, "ndcstatus", ndc),
  };
}

/** Assembles the full RxNorm identity for one RXCUI. */
export async function buildIdentity(rxcui: string, force = false): Promise<RxNormIdentity | null> {
  const props = await getProperties(rxcui, force);
  if (!props) return null;

  const [history, allRelated, ndcs] = await Promise.all([
    getHistoryStatus(rxcui, force),
    getAllRelated(rxcui, force),
    getNdcs(rxcui, force),
  ]);

  return {
    concept: props.concept,
    isCurrent: history.isCurrent,
    status: history.status,
    related: allRelated.related,
    ndc11: ndcs.ndc11,
    provenance: [
      props.provenance,
      history.provenance,
      allRelated.provenance,
      ndcs.provenance,
    ],
  };
}

/**
 * Reports the real state of the RxNav interaction service.
 *
 * NLM discontinued it. This function probes rather than asserting from memory,
 * so the audit reflects what is true at run time.
 */
export async function interactionApiStatus(): Promise<{
  available: boolean;
  httpStatus: number | null;
  note: string;
}> {
  const url = `${BASE}/interaction/interaction.json?rxcui=153892`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    return {
      available: res.ok,
      httpStatus: res.status,
      note: res.ok
        ? "Interaction endpoint responded. Verify scope before relying on it."
        : `Interaction endpoint returned HTTP ${res.status}. NLM discontinued this service; no interaction data is produced by this pipeline.`,
    };
  } catch (err) {
    return {
      available: false,
      httpStatus: null,
      note: `Interaction endpoint unreachable (${String(err)}). No interaction data is produced.`,
    };
  }
}
