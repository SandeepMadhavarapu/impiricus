import "server-only";
import {
  queryNppes,
  locationInZip,
  formatStreet,
  titleCase,
  isValidZip,
  type NppesRecord,
} from "@/shared/lib/nppes/client";

export { isValidZip };

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
 * The registry's two traps - a `postal_code` that matches mailing addresses,
 * and a bad query answering HTTP 200 with an `Errors` array - are handled once
 * in @/shared/lib/nppes/client and shared with the clinician lookup.
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
 * present them as in-network, as open, or as able to fill anything.
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

/**
 * Turns one registry row into a Pharmacy, or null if it fails any check.
 *
 * Returning null rather than a partly-filled row is deliberate: a pharmacy
 * with a blank name or a blank street is not something a person can choose
 * between, and rendering one would suggest the list is worse than it is.
 */
function toPharmacy(result: NppesRecord, zip: string): Pharmacy | null {
  const npi = String(result.number ?? "").trim();
  const name = (result.basic?.organization_name ?? "").trim();
  if (npi.length === 0 || name.length === 0) return null;

  const taxonomies = result.taxonomies ?? [];
  const primary = taxonomies.find((t) => t.primary) ?? taxonomies[0];
  if (!taxonomies.some((t) => isPharmacyTaxonomy(t.desc))) return null;

  const location = locationInZip(result, zip);
  if (!location) return null;

  const address = formatStreet(location);
  if (!address) return null;

  return {
    id: npi,
    name: titleCase(name),
    address,
    zip: (location.postal_code ?? "").trim().slice(0, 5),
    kind: classify(primary?.desc),
    // distanceMiles intentionally omitted: NPPES publishes no distance.
  };
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

  const query = await queryNppes(
    {
      enumeration_type: "NPI-2",
      taxonomy_description: "Pharmacy",
      postal_code: trimmed,
    },
    fetchImpl
  );

  if (query.status === "unavailable") {
    return { status: "unavailable", pharmacies: [], reason: query.reason };
  }

  const seen = new Set<string>();
  const pharmacies: Pharmacy[] = [];
  for (const raw of query.results) {
    const pharmacy = toPharmacy(raw, trimmed);
    if (!pharmacy || seen.has(pharmacy.id)) continue;
    seen.add(pharmacy.id);
    pharmacies.push(pharmacy);
  }

  pharmacies.sort((a, b) => a.name.localeCompare(b.name));
  return { status: "ok", pharmacies };
}
