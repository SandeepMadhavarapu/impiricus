import "server-only";

/**
 * NPPES NPI lookup, for confirming a prescriber the user ALREADY has.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A LOOKUP AND NOT A DIRECTORY
 * ---------------------------------------------------------------------------
 * NPPES is the only free, authoritative, national registry of healthcare
 * providers, and it is tempting to turn it into a "find a doctor near you"
 * feature. That would be wrong, and the reason is in what the registry can and
 * cannot answer.
 *
 * It CAN answer: is this NPI enumerated, is it a person or an organisation,
 * what taxonomy did they select, what practice address and phone did they
 * register, and when did they last attest to it.
 *
 * It CANNOT answer: are they licensed right now, are they credentialed, are
 * they in your insurance network, are they accepting patients, are they still
 * at that address, or are they even still practising. CMS states this plainly
 * on the NPI file distribution page:
 *
 *   "Issuance of an NPI does not ensure or validate that the Health Care
 *    Provider is Licensed or Credentialed."
 *
 * A directory built on data that cannot answer those questions sends people to
 * clinicians who may not take their insurance, may not be accepting patients,
 * and may have moved. So this module supports ONE operation: look up an NPI
 * the user already holds - from a prescription label, a discharge summary, a
 * business card - and report what the registry says about it, with its age.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT RETURNED
 * ---------------------------------------------------------------------------
 * `authorized_official_*`  Organisation records name a real individual and
 *                          give their direct phone number. That person did not
 *                          publish it to be surfaced in a patient app, and it
 *                          is not needed to confirm a pharmacy exists.
 *
 * `taxonomies[].license`   NPPES carries a self-reported licence number that
 *                          CMS does not validate. Displaying a licence number
 *                          beside a provider's name reads as verification to
 *                          almost every reader. Whether one is on file is
 *                          reported as a boolean; the number is not returned.
 *
 * The staleness signals ARE returned and are the most important fields here.
 * `certification_date` is when the provider last attested the record is
 * correct; a record certified years ago may name an address they have left.
 */

/** NPPES requires an explicit API version; omitting it returns an error. */
const NPPES_VERSION = "2.1";
const NPPES_BASE = "https://npiregistry.cms.hhs.gov/api/";
const TIMEOUT_MS = 10_000;

/**
 * CMS's own words, carried with every result.
 *
 * Quoted rather than paraphrased: a paraphrase of a disclaimer tends to soften
 * it, and this one is the whole basis for how the result may be displayed.
 */
export const CMS_NPI_DISCLAIMER =
  "Issuance of an NPI does not ensure or validate that the Health Care Provider is Licensed or Credentialed.";

export const NPPES_LIMITATIONS: readonly string[] = [
  "Being registered is not proof of a current licence.",
  "NPPES does not credential providers or check hospital privileges.",
  "NPPES cannot confirm that the person is who the record says they are.",
  "It says nothing about whether they take your insurance or are accepting patients.",
  "It establishes no relationship between a provider and any patient.",
  "Addresses, phone numbers and specialties are entered by the provider and can be out of date.",
];

/** Registration status, as NPPES reports it. */
export type NppesStatus =
  /** Active enumeration. */
  | "active"
  /**
   * The NPI exists but is deactivated. Deactivation happens on death,
   * dissolution of an organisation, fraud, or at the provider's request.
   */
  | "deactivated"
  /** A status code we do not recognise. Reported rather than guessed at. */
  | "unrecognised";

export interface NppesLookup {
  npi: string;
  status: NppesStatus;
  /** The raw single-letter code, so an unrecognised value is still visible. */
  statusCode: string | null;
  isIndividual: boolean;
  /** Formatted name. Organisation name for NPI-2. */
  name: string;
  credential: string | null;
  /** Self-selected specialty. NOT evidence of board certification. */
  primarySpecialty: string | null;
  allSpecialties: string[];
  /** The practice address as registered, not as verified. */
  practiceLocation: {
    city: string | null;
    state: string | null;
    postalCode: string | null;
    phone: string | null;
  } | null;
  /** Whether a self-reported licence number is on file. Never the number. */
  hasSelfReportedLicense: boolean;
  licenseStates: string[];
  enumerationDate: string | null;
  lastUpdated: string | null;
  /** When the provider last attested the record is correct. */
  certificationDate: string | null;
  /** Whole years since certification, or null when never certified. */
  yearsSinceCertification: number | null;
  /** True when the record has not been attested in over two years. */
  possiblyStale: boolean;
}

export type NppesOutcome =
  | { state: "found"; provider: NppesLookup }
  /** A syntactically valid NPI that is not in the registry. */
  | { state: "not-found"; npi: string }
  /** Failed the check-digit test, so it was never sent. */
  | { state: "invalid-npi"; reason: string }
  /** NPPES could not be reached or refused. Never confused with not-found. */
  | { state: "source-unavailable"; reason: string };

export interface NppesResponse {
  outcome: NppesOutcome;
  disclaimer: string;
  limitations: readonly string[];
  checkedAt: string;
}

/* ------------------------------------------------------------ validation */

/**
 * Validates an NPI with the Luhn check digit CMS specifies.
 *
 * An NPI is 10 digits; the last is a check digit computed over the first nine
 * prefixed with 80840 (the NPI's assigned issuer identifier). Checking locally
 * means a typo is reported as a typo instead of consuming a request and coming
 * back as "not found", which reads as "this prescriber does not exist".
 */
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;

  const digits = npi.split("").map(Number);
  const check = digits[9]!;
  // 80840 is constant, and its contribution to the Luhn sum is 24.
  let sum = 24;

  for (let i = 0; i < 9; i++) {
    // Double every other digit, counting from the rightmost of the first nine.
    const double = (9 - i) % 2 === 1;
    let d = digits[i]!;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }

  return (10 - (sum % 10)) % 10 === check;
}

/* -------------------------------------------------------------- mapping */

interface RawTaxonomy {
  code?: string;
  desc?: string;
  license?: string | null;
  primary?: boolean;
  state?: string | null;
}

interface RawAddress {
  address_purpose?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  telephone_number?: string;
}

interface RawBasic {
  status?: string;
  first_name?: string;
  last_name?: string;
  credential?: string;
  organization_name?: string;
  enumeration_date?: string;
  last_updated?: string;
  certification_date?: string;
}

interface RawResult {
  number?: string | number;
  enumeration_type?: string;
  basic?: RawBasic;
  taxonomies?: RawTaxonomy[];
  addresses?: RawAddress[];
}

function mapStatus(code: string | null): NppesStatus {
  if (code === "A") return "active";
  // NPPES omits or blanks status on deactivated records in some responses.
  if (code === null || code === "" || code === "D") return "deactivated";
  return "unrecognised";
}

function yearsSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / (365.25 * 24 * 3600 * 1000));
}

/**
 * Same rule as the label display casing: preserve deliberate capitals.
 *
 * NPPES stores names in upper case, and organisation names routinely end in
 * LLC, INC or PC. Lowercasing then capitalising produced "Llc".
 */
function titleCase(s: string): string {
  if (/[a-z]/.test(s)) return s;
  return s
    .split(/(\s+)/)
    .map((tok) => {
      if (/^\s+$/.test(tok) || tok.length === 0) return tok;
      if (tok.length <= 3) return tok;
      return tok[0]! + tok.slice(1).toLowerCase();
    })
    .join("");
}

export function mapNppesResult(raw: RawResult): NppesLookup {
  const basic = raw.basic ?? {};
  const isIndividual = raw.enumeration_type !== "NPI-2";
  const statusCode = basic.status ?? null;

  const taxonomies = raw.taxonomies ?? [];
  const primary = taxonomies.find((t) => t.primary) ?? taxonomies[0] ?? null;

  // LOCATION is the practice address; MAILING is often a billing service.
  const location =
    (raw.addresses ?? []).find((a) => a.address_purpose === "LOCATION") ?? null;

  const certificationDate = basic.certification_date ?? null;
  const years = yearsSince(certificationDate);

  const name = isIndividual
    ? titleCase([basic.first_name, basic.last_name].filter(Boolean).join(" "))
    : titleCase(basic.organization_name ?? "");

  return {
    npi: String(raw.number ?? ""),
    status: mapStatus(statusCode),
    statusCode,
    isIndividual,
    name: name.trim(),
    credential: basic.credential?.trim() || null,
    primarySpecialty: primary?.desc ?? null,
    allSpecialties: [...new Set(taxonomies.map((t) => t.desc).filter((d): d is string => !!d))],
    practiceLocation: location
      ? {
          city: location.city ? titleCase(location.city) : null,
          state: location.state ?? null,
          postalCode: location.postal_code ?? null,
          phone: formatPhone(location.telephone_number ?? null),
        }
      : null,
    // Presence only. The number itself is deliberately not carried.
    hasSelfReportedLicense: taxonomies.some((t) => (t.license ?? "").trim().length > 0),
    licenseStates: [...new Set(taxonomies.map((t) => t.state).filter((s): s is string => !!s))],
    enumerationDate: basic.enumeration_date ?? null,
    lastUpdated: basic.last_updated ?? null,
    certificationDate,
    yearsSinceCertification: years,
    // Two years is the threshold at which a registered address stops being
    // something a patient should rely on without calling first.
    possiblyStale: years === null || years >= 2,
  };
}

function formatPhone(raw: string | null): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, "");
  if (d.length !== 10) return raw;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

/* --------------------------------------------------------------- lookup */

/**
 * Looks up one NPI.
 *
 * Deliberately takes an NPI and nothing else. A name-and-state search would be
 * the first step towards a directory, and would return near-matches that a
 * reader would treat as "their" clinician.
 */
export async function lookupNpi(npiRaw: string): Promise<NppesResponse> {
  const checkedAt = new Date().toISOString();
  const envelope = {
    disclaimer: CMS_NPI_DISCLAIMER,
    limitations: NPPES_LIMITATIONS,
    checkedAt,
  };

  const npi = npiRaw.replace(/\D/g, "");

  if (!isValidNpi(npi)) {
    return {
      ...envelope,
      outcome: {
        state: "invalid-npi",
        reason:
          npi.length === 10
            ? "That is 10 digits but fails the NPI check digit, so it is likely a typo."
            : "An NPI is exactly 10 digits.",
      },
    };
  }

  const url = `${NPPES_BASE}?version=${NPPES_VERSION}&number=${encodeURIComponent(npi)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      // NPPES data changes slowly; a short cache keeps a retry from hammering
      // a public service without making the result meaningfully older.
      next: { revalidate: 3600 },
    });

    if (!res.ok) {
      return {
        ...envelope,
        outcome: {
          state: "source-unavailable",
          reason: `The NPI registry returned HTTP ${res.status}.`,
        },
      };
    }

    const json: unknown = await res.json();
    const body = json as { result_count?: number; results?: RawResult[]; Errors?: unknown[] };

    if (Array.isArray(body.Errors) && body.Errors.length > 0) {
      return {
        ...envelope,
        outcome: { state: "source-unavailable", reason: "The NPI registry rejected the request." },
      };
    }

    // A valid NPI that returns nothing is genuinely not in the registry. That
    // is a real answer, and it is kept distinct from a failed request.
    if (!body.results || body.results.length === 0 || body.result_count === 0) {
      return { ...envelope, outcome: { state: "not-found", npi } };
    }

    return { ...envelope, outcome: { state: "found", provider: mapNppesResult(body.results[0]!) } };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ...envelope,
      outcome: {
        state: "source-unavailable",
        reason: aborted
          ? "The NPI registry did not respond in time."
          : "The NPI registry could not be reached.",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
