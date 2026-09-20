import "server-only";

/**
 * Shared client for the CMS NPPES NPI Registry.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE CLIENT
 * ---------------------------------------------------------------------------
 * Two features read this registry: the pharmacy picker in the coverage form
 * and the clinician list in the provider sheet. The registry has two traps,
 * and duplicating the handling of either is how one copy quietly loses it.
 *
 *   1. `postal_code` matches the MAILING address as well as the practice
 *      location. Measured: 1 in 7 pharmacy rows and 1 in 3 physician rows come
 *      back with a practice location in a DIFFERENT ZIP from the one searched.
 *      One result for Blacksburg was a practice two hours away in
 *      Charlottesville. Filtering on the location address is the only thing
 *      that keeps "near you" true.
 *
 *   2. A bad query answers HTTP 200 with an `Errors` array rather than an
 *      error status. Read as an empty result, that tells someone there is
 *      nobody near them when nothing was ever searched.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN NPPES RECORD PROVES
 * ---------------------------------------------------------------------------
 * That the provider enumerated with CMS at that address, and nothing else. It
 * is NOT proof of current licensure, of credentialing, of board certification,
 * of accepting new patients, or of participating in any insurance network.
 * Names, addresses and specialties are self-reported and can be out of date.
 *
 * Callers must carry those limitations to the reader. This module hands back
 * raw registry facts; it never decides they are safe to present bare.
 *
 * ---------------------------------------------------------------------------
 * PRIVACY
 * ---------------------------------------------------------------------------
 * The five-digit ZIP is sent to a CMS-operated registry from the SERVER, so no
 * reader's IP address reaches it. The ZIP is neither stored nor logged.
 */

const ENDPOINT = "https://npiregistry.cms.hhs.gov/api/";

/** NPPES caps `limit` at 200. */
const PAGE_LIMIT = 200;

/**
 * A slow registry must not hold a form open. Both callers treat the list as an
 * optional refinement and degrade to something usable without it.
 */
const TIMEOUT_MS = 5_000;

export type NppesFailure = "timeout" | "upstream-error" | "malformed-response";

export type NppesQueryResult =
  /** The query ran. `results` may be empty: that is a real answer. */
  | { status: "ok"; results: NppesRecord[] }
  /** The query could not be run or could not be trusted. Never "none found". */
  | { status: "unavailable"; results: []; reason: NppesFailure };

export interface NppesAddress {
  address_purpose?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  telephone_number?: string;
}

export interface NppesTaxonomy {
  desc?: string;
  primary?: boolean;
}

export interface NppesRecord {
  number?: string | number;
  enumeration_type?: string;
  basic?: {
    organization_name?: string;
    first_name?: string;
    last_name?: string;
    credential?: string;
    status?: string;
  };
  addresses?: NppesAddress[];
  taxonomies?: NppesTaxonomy[];
}

/** US ZIP, exactly five digits. Anything else is rejected, never guessed at. */
export function isValidZip(zip: string): boolean {
  return /^\d{5}$/.test(zip.trim());
}

/**
 * Runs one registry query.
 *
 * `fetchImpl` exists so tests can drive every branch without a network.
 */
export async function queryNppes(
  params: Record<string, string>,
  fetchImpl: typeof fetch = fetch
): Promise<NppesQueryResult> {
  const search = new URLSearchParams({ version: "2.1", limit: String(PAGE_LIMIT), ...params });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(`${ENDPOINT}?${search.toString()}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    // An abort and a DNS failure are the same thing to the reader: the list
    // could not be checked. Neither is reported as "nobody near you".
    return { status: "unavailable", results: [], reason: "timeout" };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) return { status: "unavailable", results: [], reason: "upstream-error" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "unavailable", results: [], reason: "malformed-response" };
  }

  if (typeof body !== "object" || body === null) {
    return { status: "unavailable", results: [], reason: "malformed-response" };
  }

  const envelope = body as { results?: unknown; Errors?: unknown };
  // Trap 2: a bad query answers 200 with Errors rather than an error status.
  if (Array.isArray(envelope.Errors) && envelope.Errors.length > 0) {
    return { status: "unavailable", results: [], reason: "upstream-error" };
  }
  // A query that matched nothing omits `results` entirely. That is a real
  // answer about the neighbourhood, not a failure.
  if (!Array.isArray(envelope.results)) return { status: "ok", results: [] };

  return { status: "ok", results: envelope.results as NppesRecord[] };
}

/**
 * The practice location, and only if it is in the ZIP that was searched.
 *
 * Trap 1 lives here. Returns null for a record whose practice is elsewhere,
 * however well its mailing address matched.
 */
export function locationInZip(record: NppesRecord, zip: string): NppesAddress | null {
  const location = (record.addresses ?? []).find((a) => a.address_purpose === "LOCATION");
  if (!location) return null;
  if ((location.postal_code ?? "").trim().slice(0, 5) !== zip) return null;
  return location;
}

/** A one-line street address, or null when the registry has no usable one. */
export function formatStreet(location: NppesAddress): string | null {
  const street = [location.address_1, location.address_2]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const city = (location.city ?? "").trim();
  if (street.length === 0 || city.length === 0) return null;
  const state = (location.state ?? "").trim().toUpperCase();
  const zip = (location.postal_code ?? "").trim().slice(0, 5);
  return `${titleCase(street)}, ${titleCase(city)}, ${state} ${zip}`;
}

/**
 * A US telephone number as a person reads it, or null.
 *
 * The registry writes them inconsistently - "5409513311", "540-951-3311",
 * "(540) 951-3311". Anything that is not ten digits after stripping is
 * returned unchanged rather than forced into a shape it does not have.
 */
export function formatPhone(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (value.length === 0) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith("1")) {
    const d = digits.slice(1);
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return value;
}

/** `tel:` target for a formatted number, or null when it cannot be dialled. */
export function telHref(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `tel:+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `tel:+${digits}`;
  return null;
}

/**
 * Short all-capital tokens that are ordinary words rather than initialisms.
 *
 * NPPES shouts everything, so "ST" could be the word "Street" or an
 * initialism. Guessing by shape alone gets one of them wrong every time, so
 * the ambiguous short tokens are enumerated instead.
 */
const CASED_SHORT_WORDS = new Set([
  // Street and unit suffixes.
  "ST", "AVE", "RD", "DR", "LN", "CT", "PL", "HWY", "WAY",
  "TER", "CIR", "SQ", "RTE", "STE", "APT",
  // Company suffixes and connectives. LLC, LLP, LTD and PC are absent on
  // purpose: those read correctly as capitals.
  "INC", "CO", "AND", "OF", "THE", "AT", "ON", "IN",
  // Ordinary three-letter words common in names, which would otherwise be
  // mistaken for initialisms - "NEW River Pharmacy" was the case that showed
  // this list was needed.
  "NEW", "OLD", "ONE", "TWO", "SUN", "OAK", "ELM", "BAY",
  "RED", "TOP", "ALL", "OUR", "MID", "BIG", "DAY", "KEY",
]);

/**
 * Acronyms of four letters or more that must survive casing.
 *
 * The three-letter rule cannot catch these, and "AIDS Healthcare Foundation"
 * rendered as "Aids Healthcare Foundation" misnames a real organisation.
 */
const PRESERVED_ACRONYMS = new Set(["AIDS", "HIV", "DME", "IHS", "VAMC"]);

/**
 * NPPES stores names and streets in upper case. Rendered as-is they read as
 * shouting in a list someone is scanning, so they are cased for display only -
 * the underlying registry value is never altered.
 *
 * A token is left exactly as published when it is an all-capital word of three
 * letters or fewer that is not in CASED_SHORT_WORDS, so "CVS", "RX", "HEB" and
 * "LLC" survive, or when it contains a digit. Three is the cut-off because
 * four-letter capitals are overwhelmingly ordinary words - MAIN, ACME, EAST,
 * PARK - while genuine initialisms are almost all two or three.
 */
/**
 * A PERSON's name, cased for reading.
 *
 * Separate from titleCase because the initialism rule there is about
 * organisation names - "CVS", "RX", "HEB" - and is actively wrong for people.
 * NPPES stores first and last names in their own fields, where a short
 * all-capital token is a name and not an abbreviation, so "BEN" must become
 * "Ben" and not stay shouted.
 *
 * Internal capitals that real surnames carry are preserved: after an
 * apostrophe (O'Neill, D'Angelo), after a hyphen (Mary-Ann), and the Mc and
 * Mac prefixes (McDonald, MacArthur). These are people's names on a page they
 * did not ask to be on; getting them visibly wrong is its own small harm.
 *
 * It does not attempt every case. Names like "van der Berg" or "de la Cruz"
 * have conventions this cannot infer from upper-case input, and they come out
 * capitalised rather than mangled.
 */
export function titleCasePersonName(value: string): string {
  const capitaliseParts = (word: string, separator: string) =>
    word
      .split(separator)
      .map((part) => (part.length === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(separator);

  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      let word = token.toLowerCase();
      word = word.charAt(0).toUpperCase() + word.slice(1);
      word = capitaliseParts(word, "-");
      word = capitaliseParts(word, "'");
      // Mc/Mac only when something follows, so "Mac" alone stays "Mac".
      word = word.replace(/^(Mc|Mac)([a-z])/, (_m, p, c: string) => p + c.toUpperCase());
      return word;
    })
    .join(" ");
}

export function titleCase(value: string): string {
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
