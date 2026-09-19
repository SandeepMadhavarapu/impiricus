import "server-only";

/**
 * Directory of payers, their plans, and pharmacies near a ZIP code.
 *
 * This is the lookup layer behind the coverage form's three pickers: choose an
 * insurer, then one of that insurer's plans, then a pharmacy near you. It is
 * deliberately EMPTY right now. No payer directory, plan list or pharmacy
 * dataset has been licensed for this prototype, and inventing one would put
 * plausible-looking plan names in front of someone deciding whether they can
 * afford a medication.
 *
 * Empty is a supported state, not a broken one: the UI falls back to free-text
 * entry and says the list is not connected yet.
 *
 * ---------------------------------------------------------------------------
 * WIRING THIS UP
 * ---------------------------------------------------------------------------
 * Replace the three loader bodies below. Each returns a plain array, so the
 * source can be a bundled JSON file, a database, or a licensed API:
 *
 *   listPayers()                -> every insurer offered in the first picker
 *   listPlans(payerId)          -> that insurer's plans, for the second
 *   findPharmacies(zip)         -> pharmacies near a ZIP, nearest first
 *
 * Keep the shapes below. The form, the request schema and the adapters all
 * read these fields, so a loader that fills them needs no UI change.
 *
 * Two rules survive whatever you connect:
 *   - A pharmacy distance is only shown when the data source actually gives
 *     one. Never estimate it.
 *   - A plan appearing in this directory says nothing about whether it covers
 *     a drug. Coverage answers come from the formulary adapters, and a missing
 *     plan is "unable to verify", never "not covered".
 */

export interface Payer {
  /** Stable id used as the form value, e.g. a HIOS issuer id. */
  id: string;
  name: string;
  /** Optional alternate spellings, so search matches what people type. */
  aliases?: string[];
}

export interface Plan {
  id: string;
  payerId: string;
  name: string;
  /** e.g. "Medicare Part D", "Commercial", "Medicaid". */
  planType?: string;
  /** Plan years this plan's formulary is known to cover. */
  years?: number[];
}

export interface Pharmacy {
  id: string;
  name: string;
  address: string;
  zip: string;
  /** Miles from the searched ZIP. Only set when the source provides it. */
  distanceMiles?: number;
  kind: "retail" | "mail-order" | "specialty";
}

/** True once a real directory is connected, which the UI surfaces honestly. */
export function isDirectoryConnected(): boolean {
  return listPayers().length > 0;
}

export function listPayers(): Payer[] {
  // Connect a payer directory here.
  return [];
}

export function listPlans(payerId: string): Plan[] {
  // Connect a plan directory here, filtered to this payer.
  void payerId;
  return [];
}

/**
 * Pharmacies near a ZIP code, nearest first.
 *
 * The ZIP is used to run this lookup and is not stored or logged. A 5-digit
 * ZIP is coarse enough not to identify a person on its own, and nothing here
 * pairs it with anything that would.
 */
export function findPharmacies(zip: string): Pharmacy[] {
  if (!isValidZip(zip)) return [];
  // Connect a pharmacy dataset here.
  return [];
}

/** US ZIP, 5 digits. Rejects anything else rather than guessing. */
export function isValidZip(zip: string): boolean {
  return /^\d{5}$/.test(zip.trim());
}

/** Case- and punctuation-insensitive match for the insurer type-ahead. */
export function searchPayers(query: string, payers: Payer[] = listPayers()): Payer[] {
  const q = normalise(query);
  if (q.length === 0) return payers;
  return payers.filter((p) =>
    [p.name, ...(p.aliases ?? [])].some((n) => normalise(n).includes(q))
  );
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
