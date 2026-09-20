import "server-only";
import { isOfferedSpecialty } from "./specialties";
import {
  queryNppes,
  locationInZip,
  formatStreet,
  formatPhone,
  telHref,
  titleCasePersonName,
  isValidZip,
  type NppesRecord,
} from "@/shared/lib/nppes/client";

/**
 * Clinicians registered near a ZIP code, from the CMS NPPES NPI Registry.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The "find a provider" route offered two links to national directories and
 * nothing else. Both are good destinations, and both leave the site and start
 * the search over. NPPES is the federal register those directories are built
 * from, it is public domain, and it carries a practice address and a telephone
 * number for every enumerated clinician - so the strongest real step, a phone
 * number someone can actually call, can sit on the page.
 *
 * ---------------------------------------------------------------------------
 * WHAT A LISTING PROVES, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * It proves this clinician enumerated with CMS at this address. It does NOT
 * prove they are currently licensed, board certified, credentialed at any
 * facility, accepting new patients, participating in any insurance network, or
 * still at that address. Names, specialties and addresses are self-reported.
 *
 * None of that is a caveat to bury. A list of named doctors reads as a
 * recommendation unless it is told otherwise, and this list is not a
 * recommendation: it is a register, filtered to one ZIP code. LISTING_MEANS
 * below travels with every result and the UI renders it.
 *
 * This is also NOT a referral. Nothing is transmitted, no appointment is made,
 * and no clinician is told anything.
 */

/*
 * The offered specialties and the caveat list live in ./specialties, which is
 * not server-only, so the picker and this validator read the same list.
 */
export { LISTING_MEANS, PATIENT_SPECIALTIES, isOfferedSpecialty } from "./specialties";

export interface Clinician {
  /** The individual's NPI. */
  id: string;
  /** "Gregory Beato", cased for reading. */
  name: string;
  /** "D.O.", "M.D.", "NP" - as registered, or null. */
  credential: string | null;
  /** Registered primary taxonomy description. */
  specialty: string | null;
  address: string;
  /** Formatted for reading, e.g. "(540) 951-3311". */
  phone: string | null;
  /** `tel:` target, or null when the number cannot be dialled. */
  phoneHref: string | null;
}

export type ClinicianLookup =
  /** The query ran. `clinicians` may be empty: that is a real answer. */
  | { status: "ok"; clinicians: Clinician[]; totalInZip: number }
  | {
      status: "unavailable";
      clinicians: [];
      totalInZip: 0;
      reason: "invalid-zip" | "unknown-specialty" | "timeout" | "upstream-error" | "malformed-response";
    };

/**
 * How many to return.
 *
 * A ZIP can hold dozens. A list that long buries the caveats above it and
 * turns a page someone opened with a question into a directory to scroll. The
 * count of everything found is returned alongside, so the UI can say how many
 * there are without rendering them all.
 */
const MAX_RESULTS = 6;

/**
 * Turns one registry row into a Clinician, or null if it fails any check.
 *
 * A row without a name, a practice address in this ZIP, or an active status is
 * dropped rather than part-filled. Someone scanning for a doctor to call
 * cannot use a blank.
 */
function toClinician(record: NppesRecord, zip: string): Clinician | null {
  const npi = String(record.number ?? "").trim();
  const basic = record.basic ?? {};
  const first = (basic.first_name ?? "").trim();
  const last = (basic.last_name ?? "").trim();
  if (npi.length === 0 || first.length === 0 || last.length === 0) return null;

  // "A" is active. Anything else is deactivated or in an unknown state, and a
  // deactivated NPI is not someone to send a person to call.
  if ((basic.status ?? "A").trim().toUpperCase() !== "A") return null;

  const location = locationInZip(record, zip);
  if (!location) return null;

  const address = formatStreet(location);
  if (!address) return null;

  const taxonomies = record.taxonomies ?? [];
  const primary = taxonomies.find((t) => t.primary) ?? taxonomies[0];

  const credential = (basic.credential ?? "").trim();

  return {
    id: npi,
    name: titleCasePersonName(`${first} ${last}`),
    credential: credential.length > 0 ? credential : null,
    specialty: (primary?.desc ?? "").trim() || null,
    address,
    phone: formatPhone(location.telephone_number),
    phoneHref: telHref(location.telephone_number),
  };
}

/**
 * Clinicians of one specialty whose registered practice is in this exact ZIP.
 *
 * The ZIP filter is load-bearing. NPPES matches `postal_code` against mailing
 * addresses too, and for physicians a THIRD of rows come back with a practice
 * location elsewhere - a Blacksburg search returned a practice two hours away
 * in Charlottesville. Without the filter, "near you" is false.
 *
 * Sorted by surname, which is how a register reads. No ranking is implied and
 * none is possible: NPPES publishes no distance, no rating and no availability.
 */
export async function findClinicians(
  zip: string,
  specialty: string,
  fetchImpl: typeof fetch = fetch
): Promise<ClinicianLookup> {
  const trimmed = zip.trim();
  if (!isValidZip(trimmed)) {
    return { status: "unavailable", clinicians: [], totalInZip: 0, reason: "invalid-zip" };
  }
  // Only the offered taxonomies, so an arbitrary string cannot be used to run
  // whatever query it likes through this server.
  if (!isOfferedSpecialty(specialty)) {
    return { status: "unavailable", clinicians: [], totalInZip: 0, reason: "unknown-specialty" };
  }

  const query = await queryNppes(
    {
      enumeration_type: "NPI-1",
      taxonomy_description: specialty,
      postal_code: trimmed,
    },
    fetchImpl
  );

  if (query.status === "unavailable") {
    return { status: "unavailable", clinicians: [], totalInZip: 0, reason: query.reason };
  }

  const seen = new Set<string>();
  const all: Clinician[] = [];
  for (const raw of query.results) {
    const clinician = toClinician(raw, trimmed);
    if (!clinician || seen.has(clinician.id)) continue;
    seen.add(clinician.id);
    all.push(clinician);
  }

  all.sort((a, b) => {
    const surname = (n: string) => n.split(" ").slice(-1)[0] ?? n;
    return surname(a.name).localeCompare(surname(b.name)) || a.name.localeCompare(b.name);
  });

  return { status: "ok", clinicians: all.slice(0, MAX_RESULTS), totalInZip: all.length };
}
