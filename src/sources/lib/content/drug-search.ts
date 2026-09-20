import "server-only";
import { listGuides, guideProductName } from "./catalogue";
import { guideSource } from "./patient-guide";

/**
 * Search every FDA drug label, not only the three this app has guides for.
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 * The medication library lists three products. openFDA publishes 262,883 drug
 * labels. A clinician looking for a fourth medication had no way to find out
 * whether this app knew anything about it, and the honest answer for most
 * drugs - "there is a real FDA label, but no patient guide has been written" -
 * could not be given because nothing was looked up.
 *
 * ---------------------------------------------------------------------------
 * WHAT A RESULT IS, AND IS NOT
 * ---------------------------------------------------------------------------
 * A result is one Structured Product Label as the FDA publishes it. It is
 * enough to establish identity - what the product is called, who makes it,
 * how it is given, and whether it carries a boxed warning - and it is NOT a
 * patient guide. The three catalogued products have a reviewed, plain-language
 * guide with citations and shareable links behind them; a searched drug has a
 * label and a link to the official source, and the caller must not present the
 * two as the same thing.
 *
 * No label text is rewritten here and none is summarised. The full text stays
 * where it is authoritative, at DailyMed.
 */

const ENDPOINT = "https://api.fda.gov/drug/label.json";

/** A slow search must not hang the library. */
const TIMEOUT_MS = 6_000;

/** More than a person scans, fewer than a page needs to render. */
const MAX_RESULTS = 8;

/**
 * Product types that are medicines someone could be prescribed or buy.
 *
 * Needed because a prefix search on a name matches things that are not drugs:
 * "singul*" returns "Singular Wipes" alongside SINGULAIR. The wipes have an
 * FDA label; they are not what someone searching for a medication means.
 */
const DRUG_PRODUCT_TYPES = new Set([
  "HUMAN PRESCRIPTION DRUG",
  "HUMAN OTC DRUG",
]);

export interface DrugSearchHit {
  /** SPL set id: stable across versions of the same label. */
  setId: string;
  /**
   * EVERY brand this label covers, not the first one.
   *
   * One SPL can cover several products: the semaglutide label lists both
   * OZEMPIC and RYBELSUS, which are an injection and a tablet. Showing
   * `brand_name[0]` would label an oral product as Ozempic.
   */
  brandNames: string[];
  genericNames: string[];
  manufacturer: string | null;
  routes: string[];
  /** True when the label carries an FDA boxed warning. */
  hasBoxedWarning: boolean;
  /** The official label, where the full text is authoritative. */
  dailyMedUrl: string;
  /**
   * Set when this label is one of the catalogued products, so the caller can
   * offer the real guide instead of a bare identity.
   */
  guide: { slug: string; name: string } | null;
}

export type DrugSearchResult =
  /** The search ran. `hits` may be empty: that is a real answer. */
  | { status: "ok"; hits: DrugSearchHit[]; totalMatches: number }
  | {
      status: "unavailable";
      hits: [];
      totalMatches: 0;
      reason: "query-too-short" | "timeout" | "upstream-error" | "malformed-response";
    };

/**
 * Reduces what a person typed to something safe to put in a query.
 *
 * The term goes into openFDA's Lucene-style search parameter, where quotes,
 * colons, braces and boolean keywords all have meaning. Stripping them rather
 * than escaping them keeps this simple to reason about: what is left is a
 * plain word, and a plain word cannot change the shape of the query.
 */
export function sanitiseTerm(raw: string): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/** Catalogued products, indexed by the SPL set id their export records. */
function cataloguedBySetId(): Map<string, { slug: string; name: string }> {
  const map = new Map<string, { slug: string; name: string }>();
  for (const guide of listGuides()) {
    const setId =
      guide.mode === "official-label"
        ? guide.label.identifiers?.splSetId
        : guide.authored.source.document?.splSetId;
    if (typeof setId === "string" && setId.length > 0) {
      map.set(setId.toLowerCase(), { slug: guide.slug, name: guideProductName(guide) });
    }
  }
  return map;
}

interface RawLabel {
  /**
   * Present on every label. `openfda.spl_set_id` is not: openFDA only adds its
   * harmonised block to labels it has enriched, and our own Ozempic SPL has no
   * openfda block at all. Keying on this field instead means a catalogued
   * product is still recognised when openFDA has not indexed it.
   */
  set_id?: string;
  openfda?: {
    brand_name?: string[];
    generic_name?: string[];
    manufacturer_name?: string[];
    route?: string[];
    product_type?: string[];
    spl_set_id?: string[];
  };
  boxed_warning?: string[];
}

function toHit(
  raw: RawLabel,
  catalogue: Map<string, { slug: string; name: string }>
): DrugSearchHit | null {
  const of = raw.openfda ?? {};
  const setId = raw.set_id ?? (of.spl_set_id ?? [])[0];
  if (!setId) return null;

  // Not a medicine. See DRUG_PRODUCT_TYPES.
  const types = of.product_type ?? [];
  if (!types.some((t) => DRUG_PRODUCT_TYPES.has((t ?? "").toUpperCase()))) return null;

  const brandNames = unique(of.brand_name ?? []);
  const genericNames = unique(of.generic_name ?? []);
  if (brandNames.length === 0 && genericNames.length === 0) return null;

  return {
    setId,
    brandNames,
    genericNames,
    manufacturer: (of.manufacturer_name ?? [])[0] ?? null,
    routes: unique(of.route ?? []).map((r) => r.toLowerCase()),
    // openFDA omits the field entirely when there is no boxed warning.
    hasBoxedWarning: Array.isArray(raw.boxed_warning) && raw.boxed_warning.length > 0,
    dailyMedUrl: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${encodeURIComponent(setId)}`,
    guide: catalogue.get(setId.toLowerCase()) ?? null,
  };
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = (v ?? "").trim();
    if (t.length === 0) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Catalogued products whose own name matches what was typed.
 *
 * The local catalogue is authoritative for its own three products, and openFDA
 * is not: our Ozempic SPL carries no `openfda` block, so a brand-name search
 * of the federal index cannot find it however it is spelled. Leaving that to
 * the upstream index would mean a product this app has a full guide for is
 * missing from a search for its own name.
 *
 * Matched here, from data already in memory, so the guide is always offered.
 */
function catalogueMatches(term: string): DrugSearchHit[] {
  const needle = term.toLowerCase();
  const out: DrugSearchHit[] = [];
  for (const guide of listGuides()) {
    // guideSource normalises both guide modes to one record, so this does not
    // have to know which kind it is looking at.
    const source = guideSource(guide);
    const setId = source.document.splSetId;
    const brand = (source.product.brandName ?? "").trim();
    const generic = (source.product.genericName ?? "").trim();

    const haystack = [brand, generic, guide.slug.replace(/-/g, " ")].join(" ").toLowerCase();
    // Prefix-aware, so "montelu" finds montelukast the same way the remote
    // search does and local and remote behave alike as someone types.
    if (!haystack.split(/[\s-]+/).some((word) => word.startsWith(needle))) continue;

    out.push({
      setId,
      brandNames: brand ? [brand] : [],
      genericNames: generic ? [generic] : [],
      manufacturer: null,
      routes: source.product.route ?? [],
      // Never guessed: the stored record says whether the label has a boxed
      // warning, and that is the value used.
      hasBoxedWarning: source.sections.some((section) => section.id === "boxed_warning"),
      dailyMedUrl: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${encodeURIComponent(setId)}`,
      guide: { slug: guide.slug, name: guideProductName(guide) },
    });
  }
  return out;
}

/**
 * Searches FDA labels by brand or generic name.
 *
 * A prefix search, because people type "montelu" and not the exact registered
 * name. Two characters is the floor: one letter matches most of the catalogue
 * and tells nobody anything.
 *
 * `fetchImpl` exists so the tests can drive every branch without a network.
 */
export async function searchDrugLabels(
  term: string,
  fetchImpl: typeof fetch = fetch
): Promise<DrugSearchResult> {
  const clean = sanitiseTerm(term);
  if (clean.length < 2) {
    return { status: "unavailable", hits: [], totalMatches: 0, reason: "query-too-short" };
  }

  // Prefix match on either name. The whole phrase is one token here, so a
  // multi-word term searches for that phrase rather than any of its words.
  const escaped = clean.replace(/ /g, "+");
  const search = `openfda.brand_name:${escaped}*+OR+openfda.generic_name:${escaped}*`;
  const url = `${ENDPOINT}?search=${search}&limit=${MAX_RESULTS * 3}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    return { status: "unavailable", hits: [], totalMatches: 0, reason: "timeout" };
  } finally {
    clearTimeout(timer);
  }

  /*
   * openFDA answers "nothing matched" with HTTP 404, not an empty list.
   *
   * Treated as an error, every search for a drug that does not exist would
   * read as "the search is broken" instead of "there is no such medication",
   * and the person would try again rather than check the spelling.
   */
  if (response.status === 404) {
    // Nothing in the federal index matched. A catalogued product still can.
    const local = catalogueMatches(clean);
    return { status: "ok", hits: local, totalMatches: local.length };
  }
  if (!response.ok) {
    return { status: "unavailable", hits: [], totalMatches: 0, reason: "upstream-error" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "unavailable", hits: [], totalMatches: 0, reason: "malformed-response" };
  }
  if (typeof body !== "object" || body === null) {
    return { status: "unavailable", hits: [], totalMatches: 0, reason: "malformed-response" };
  }

  const envelope = body as { results?: unknown; meta?: { results?: { total?: number } } };
  if (!Array.isArray(envelope.results)) {
    return { status: "ok", hits: [], totalMatches: 0 };
  }

  const catalogue = cataloguedBySetId();
  const seen = new Set<string>();
  const hits: DrugSearchHit[] = [];

  /*
   * Catalogued products first, from local data.
   *
   * A product this app has a guide for is the only result that leads anywhere
   * beyond identity, so it must never be buried under look-alike generics -
   * and it must appear even when openFDA cannot find it, which for our own
   * Ozempic SPL it cannot.
   */
  for (const hit of catalogueMatches(clean)) {
    if (seen.has(hit.setId)) continue;
    seen.add(hit.setId);
    hits.push(hit);
  }

  for (const raw of envelope.results as RawLabel[]) {
    const hit = toHit(raw, catalogue);
    if (!hit || seen.has(hit.setId)) continue;
    seen.add(hit.setId);
    hits.push(hit);
  }

  hits.sort((a, b) => Number(Boolean(b.guide)) - Number(Boolean(a.guide)));

  return {
    status: "ok",
    hits: hits.slice(0, MAX_RESULTS),
    totalMatches: envelope.meta?.results?.total ?? hits.length,
  };
}
