import "server-only";

/**
 * Pharmacy lookup, backed by the CMS NPPES NPI Registry.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SOURCE
 * ---------------------------------------------------------------------------
 * NPPES is the federal registry every US healthcare provider must appear in to
 * bill Medicare. It is published by CMS, it is in the public domain, it needs
 * no key or licence, and it carries the legal business name and practice
 * address of each pharmacy organisation. That makes it the one pharmacy list
 * this project can use without either paying for a commercial directory or
 * inventing addresses.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN NPPES ROW PROVES, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * It proves the organisation registered with CMS at that address. It does NOT
 * prove the pharmacy is still open, still at that address, currently stocks a
 * medication, is in network for a given plan, or would fill a given
 * prescription. Registrations are self-reported and are not removed promptly
 * when a location closes.
 *
 * So this returns candidate pharmacies to pick from, and the caller must not
 * present them as in-network, as open, or as able to fill anything. The same
 * caveat the provider routes make about NPI listings applies here.
 *
 * ---------------------------------------------------------------------------
 * PRIVACY
 * ---------------------------------------------------------------------------
 * The five-digit ZIP is sent to a CMS-operated registry to run the query, from
 * the server, so the reader's IP address is never exposed to it. The ZIP is
 * not stored and not logged, here or anywhere on the path. Five digits is too
 * coarse to identify a person on its own, and nothing here pairs it with
 * anything that would.
 */

/** A pharmacy the reader could choose. Never invented, never estimated. */
export interface Pharmacy {
  /** The organisation's NPI. Stable, and unique per registered location. */
  id: string;
  name: string;
  address: string;
  zip: string;
  /**
   * Miles from the searched ZIP.
   *
   * NPPES publishes no distance and no coordinates, so this is always absent.
   * The field stays because a licensed directory would supply one; it must
   * only ever be set from a source that measured it. An estimate rendered as
   * "1.2 mi" is indistinguishable from a measurement to the person reading it.
   */
  distanceMiles?: number;
  /** Mapped from the registered primary taxonomy. See `classify`. */
  kind: "retail" | "mail-order" | "specialty" | "unspecified";
}

export type PharmacyLookup =
  /** The query ran. `pharmacies` may still be empty: that is a real answer. */
  | { status: "ok"; pharmacies: Pharmacy[] }
  /**
   * The query could not be run or could not be trusted. Distinct from "ok with
   * none", because "we could not check" and "there are none" must never render
   * as the same sentence to someone deciding where to fill a prescription.
   */
  | {
      status: "unavailable";
      pharmacies: [];
      reason: "invalid-zip" | "timeout" | "upstream-error" | "malformed-response";
    };

const ENDPOINT = "https://npiregistry.cms.hhs.gov/api/";

/** NPPES caps `limit` at 200. One page is far more than any ZIP contains. */
const PAGE_LIMIT = 200;

/**
 * A slow registry must not hold the coverage form open.
 *
 * The picker is an optional refinement - the form works without it - so
 * failing fast and letting the caller fall back to the pharmacy-type question
 * is better than a spinner that never resolves.
 */
const TIMEOUT_MS = 5_000;

/**
 * NUCC taxonomy description to the vocabulary the coverage form already uses.
 *
 * Only the three descriptions that state the dispensing model are mapped. A
 * survey of 109 registered pharmacy organisations across eight ZIP codes found
 * the bare description "Pharmacy" to be the second largest group, at 41 rows -
 * too many to discard, and not evidence of a retail counter. Those become
 * `unspecified`, which the form already accepts, rather than being guessed
 * into `retail` to make the list look tidier.
 */
function classify(description: string | null | undefined): Pharmacy["kind"] {
  switch ((description ?? "").trim()) {
    case "Pharmacy, Community/Retail Pharmacy":
      return "retail";
    case "Pharmacy, Mail Order Pharmacy":
      return "mail-order";
    case "Pharmacy, Specialty Pharmacy":
      return "specialty";
    default:
      return "unspecified";
  }
}

/**
 * Whether a registered taxonomy is a pharmacy at all.
 *
 * The endpoint is asked for pharmacies, but it matches on any of an
 * organisation's taxonomies, so rows such as "Clinic/Center, Infusion Therapy"
 * come back too. "Pharmacy Technician" is excluded by name: it is a person's
 * credential, not a place that dispenses.
 */
function isPharmacyTaxonomy(description: string | null | undefined): boolean {
  const d = (description ?? "").trim();
  return d.startsWith("Pharmacy") && d !== "Pharmacy Technician";
}

/** US ZIP, exactly five digits. Anything else is rejected, never guessed at. */
export function isValidZip(zip: string): boolean {
  return /^\d{5}$/.test(zip.trim());
}

/* ------------------------------------------------- the registry's own shape */

interface NppesAddress {
  address_purpose?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
}

interface NppesTaxonomy {
  desc?: string;
  primary?: boolean;
}

interface NppesResult {
  number?: string | number;
  basic?: { organization_name?: string; name?: string };
  addresses?: NppesAddress[];
  taxonomies?: NppesTaxonomy[];
}

/**
 * Turns one registry row into a Pharmacy, or null if it fails any check.
 *
 * Returning null rather than a partly-filled row is deliberate: a pharmacy
 * with a blank name or a blank street is not something a person can choose
 * between, and rendering one would suggest the list is worse than it is.
 */
function toPharmacy(result: NppesResult, zip: string): Pharmacy | null {
  const npi = String(result.number ?? "").trim();
  const name = (result.basic?.organization_name ?? "").trim();
  if (npi.length === 0 || name.length === 0) return null;

  const taxonomies = result.taxonomies ?? [];
  const primary = taxonomies.find((t) => t.primary) ?? taxonomies[0];
  if (!taxonomies.some((t) => isPharmacyTaxonomy(t.desc))) return null;

  /*
   * The practice location, never the mailing address.
   *
   * NPPES matches `postal_code` against BOTH, so a chain whose billing office
   * sits in the searched ZIP comes back however far away its counter is. In a
   * survey of 109 rows across eight ZIP codes, 15 of them - one in seven - had
   * a practice location in a different ZIP from the one searched. Filtering on
   * the location address is what keeps "near you" true.
   */
  const location = (result.addresses ?? []).find((a) => a.address_purpose === "LOCATION");
  if (!location) return null;

  const locationZip = (location.postal_code ?? "").trim().slice(0, 5);
  if (locationZip !== zip) return null;

  const street = [location.address_1, location.address_2]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const city = (location.city ?? "").trim();
  const state = (location.state ?? "").trim();
  if (street.length === 0 || city.length === 0) return null;

  return {
    id: npi,
    name: titleCase(name),
    address: `${titleCase(street)}, ${titleCase(city)}, ${state.toUpperCase()} ${locationZip}`,
    zip: locationZip,
    kind: classify(primary?.desc),
    // distanceMiles intentionally omitted: NPPES publishes no distance.
  };
}

/**
 * Short all-capital tokens that are ordinary words rather than initialisms.
 *
 * NPPES shouts everything, so "ST" could be the word "Street" or could be an
 * initialism. Guessing by shape alone gets one of them wrong every time, so
 * the ambiguous short tokens are enumerated instead: street suffixes and
 * company suffixes get cased, and anything else short and capitalised is left
 * alone as an initialism.
 *
 * Compass directionals are deliberately absent. "1445 N Main St" is how USPS
 * writes it, and "1445 N. Main St" is how someone reads it aloud either way.
 */
const CASED_SHORT_WORDS = new Set([
  // Street and unit suffixes.
  "ST", "AVE", "RD", "DR", "LN", "CT", "PL", "HWY", "WAY",
  "TER", "CIR", "SQ", "RTE", "STE", "APT",
  // Company suffixes and connectives. LLC, LLP, LTD and PC are absent on
  // purpose: those read correctly as capitals.
  "INC", "CO", "AND", "OF", "THE", "AT", "ON", "IN",
  // Ordinary three-letter words common in business names, which would
  // otherwise be mistaken for initialisms - "NEW River Pharmacy" was the
  // case that showed this list was needed.
  "NEW", "OLD", "ONE", "TWO", "SUN", "OAK", "ELM", "BAY",
  "RED", "TOP", "ALL", "OUR", "MID", "BIG", "DAY", "KEY",
]);

/**
 * Acronyms of four letters or more that must survive casing.
 *
 * The three-letter rule below cannot catch these, and "AIDS Healthcare
 * Foundation" rendered as "Aids Healthcare Foundation" misnames a real
 * organisation. Kept deliberately short: only acronyms actually seen in
 * registered pharmacy names go here.
 */
const PRESERVED_ACRONYMS = new Set(["AIDS", "HIV", "DME", "IHS", "VAMC"]);

/**
 * NPPES stores names and streets in upper case. Rendered as-is they read as
 * shouting in a list someone is scanning, so they are cased for display only -
 * the underlying registry value is never altered.
 *
 * A token is left exactly as published when it is an all-capital word of three
 * letters or fewer that is not in CASED_SHORT_WORDS, so "CVS", "RX", "HEB" and
 * "LLC" survive, or when it contains a digit, so "1445" and "24060" are never
 * touched. Three is the cut-off because four-letter capitals are overwhelmingly
 * ordinary words - MAIN, ACME, EAST, PARK - while genuine initialisms in
 * pharmacy names are almost all two or three.
 */
function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      // Street ordinals: "29TH" and "8TH" are numbers, not shouting.
      const ordinal = token.match(/^(\d+)(ST|ND|RD|TH)$/i);
      if (ordinal) return `${ordinal[1]}${ordinal[2]!.toLowerCase()}`;
      if (/\d/.test(token)) return token;
      if (PRESERVED_ACRONYMS.has(token)) return token;
      const isShortAllCaps =
        token.length <= 3 && token === token.toUpperCase() && /^[A-Z]+$/.test(token);
      if (isShortAllCaps && !CASED_SHORT_WORDS.has(token)) return token;
      return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
    })
    .join(" ");
}

/**
 * Pharmacies whose registered practice location is in this exact ZIP.
 *
 * Sorted by name, NOT by distance, because NPPES supplies no distance and
 * every row returned is in the same ZIP anyway. Presenting an arbitrary order
 * as "nearest first" would be a claim the data cannot support.
 *
 * `fetchImpl` exists so the tests can drive every branch without a network.
 */
export async function findPharmacies(
  zip: string,
  fetchImpl: typeof fetch = fetch
): Promise<PharmacyLookup> {
  const trimmed = zip.trim();
  if (!isValidZip(trimmed)) {
    return { status: "unavailable", pharmacies: [], reason: "invalid-zip" };
  }

  const url =
    `${ENDPOINT}?version=2.1&enumeration_type=NPI-2` +
    `&taxonomy_description=${encodeURIComponent("Pharmacy")}` +
    `&postal_code=${encodeURIComponent(trimmed)}` +
    `&limit=${PAGE_LIMIT}`;

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
    // An abort and a DNS failure are the same thing to the reader: the list
    // could not be checked. Neither is reported as "no pharmacies near you".
    return { status: "unavailable", pharmacies: [], reason: "timeout" };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return { status: "unavailable", pharmacies: [], reason: "upstream-error" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "unavailable", pharmacies: [], reason: "malformed-response" };
  }

  /*
   * NPPES answers a bad query with HTTP 200 and an `Errors` array, so the
   * status code alone does not mean the query ran. Treating that as an empty
   * result would tell someone there are no pharmacies near them when in fact
   * nothing was ever searched.
   */
  if (typeof body !== "object" || body === null) {
    return { status: "unavailable", pharmacies: [], reason: "malformed-response" };
  }
  const envelope = body as { results?: unknown; Errors?: unknown };
  if (Array.isArray(envelope.Errors) && envelope.Errors.length > 0) {
    return { status: "unavailable", pharmacies: [], reason: "upstream-error" };
  }
  if (!Array.isArray(envelope.results)) {
    // A query that matched nothing omits `results` entirely. That is a real
    // answer - this ZIP has no registered pharmacy - not a failure.
    return { status: "ok", pharmacies: [] };
  }

  const seen = new Set<string>();
  const pharmacies: Pharmacy[] = [];
  for (const raw of envelope.results as NppesResult[]) {
    const pharmacy = toPharmacy(raw, trimmed);
    if (!pharmacy || seen.has(pharmacy.id)) continue;
    seen.add(pharmacy.id);
    pharmacies.push(pharmacy);
  }

  pharmacies.sort((a, b) => a.name.localeCompare(b.name));
  return { status: "ok", pharmacies };
}
