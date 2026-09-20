import { NextResponse } from "next/server";
import {
  listPayers,
  listPlans,
  findPharmacies,
  isDirectoryConnected,
  isValidZip,
  searchPayers,
  directoryRelease,
} from "@/patient/lib/coverage/directory";
import { findClinicians, isOfferedSpecialty } from "@/doctor/lib/providers/clinicians";
import { rateLimit, clientKey } from "@/shared/lib/security/ratelimit";

/**
 * Lookups behind the coverage form's pickers: insurers, a given insurer's
 * plans, and pharmacies near a ZIP.
 *
 * Server-side so that whatever directory gets licensed later keeps its
 * credentials here rather than shipping them to the browser, and so the
 * payer and plan lists are not bundled into every page load.
 *
 * Responses are no-store. A ZIP plus a plan name is the kind of pair that
 * should not sit in a shared cache, and none of it is logged.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
const LIMIT = 60;
const WINDOW_MS = 60_000;

export async function GET(req: Request) {
  const key = await clientKey(req.headers);
  if (!rateLimit(`directory:${key}`, LIMIT, WINDOW_MS).allowed) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: NO_STORE }
    );
  }

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");

  if (kind === "payers") {
    const q = url.searchParams.get("q") ?? "";
    // Capped: 525 organizations is more than a picker should ship at once,
    // and the client narrows as the person types.
    return NextResponse.json(
      {
        connected: isDirectoryConnected(),
        release: directoryRelease(),
        payers: searchPayers(q).slice(0, 50),
      },
      { headers: NO_STORE }
    );
  }

  if (kind === "plans") {
    const payerId = url.searchParams.get("payerId") ?? "";
    if (!payerId) {
      return NextResponse.json({ error: "payerId required" }, { status: 400, headers: NO_STORE });
    }
    // Every plan for the chosen organization, each carrying its contract,
    // plan and segment ids. A name alone cannot identify a plan: 39 share
    // one name in this release, so the form submits the key, not the name.
    return NextResponse.json({ plans: listPlans(payerId) }, { headers: NO_STORE });
  }

  if (kind === "pharmacies") {
    const zip = url.searchParams.get("zip") ?? "";
    if (!isValidZip(zip)) {
      // A malformed ZIP is a user-input problem, not a server error, and it
      // must not read as "no pharmacies near you".
      return NextResponse.json(
        { error: "Enter a 5-digit ZIP code.", pharmacies: [] },
        { status: 400, headers: NO_STORE }
      );
    }
    const lookup = await findPharmacies(zip);
    if (lookup.status === "unavailable") {
      /*
       * "We could not check" must never render as "there are none near you".
       * The form falls back to the pharmacy-type question, which still lets
       * the person finish, and says why rather than showing an empty picker.
       */
      return NextResponse.json(
        {
          pharmacies: [],
          error:
            "The pharmacy registry could not be reached just now. Pick a pharmacy type instead.",
        },
        { status: 200, headers: NO_STORE }
      );
    }
    return NextResponse.json({ pharmacies: lookup.pharmacies }, { headers: NO_STORE });
  }

  /*
   * Clinicians registered near a ZIP, for the "find a provider" route.
   *
   * Served from here rather than a route of its own so it inherits this
   * endpoint's rate limit and no-store handling, and so the ZIP never travels
   * anywhere the existing lookups do not already go.
   */
  if (kind === "clinicians") {
    const zip = url.searchParams.get("zip") ?? "";
    const specialty = url.searchParams.get("specialty") ?? "";

    if (!isValidZip(zip)) {
      return NextResponse.json(
        { error: "Enter a 5-digit ZIP code.", clinicians: [], totalInZip: 0 },
        { status: 400, headers: NO_STORE }
      );
    }
    if (!isOfferedSpecialty(specialty)) {
      return NextResponse.json(
        { error: "Choose a specialty from the list.", clinicians: [], totalInZip: 0 },
        { status: 400, headers: NO_STORE }
      );
    }

    const lookup = await findClinicians(zip, specialty);
    if (lookup.status === "unavailable") {
      // "We could not check" is not "there is nobody near you".
      return NextResponse.json(
        {
          clinicians: [],
          totalInZip: 0,
          error: "The provider registry could not be reached just now. The directories below still work.",
        },
        { status: 200, headers: NO_STORE }
      );
    }
    return NextResponse.json(
      { clinicians: lookup.clinicians, totalInZip: lookup.totalInZip },
      { headers: NO_STORE }
    );
  }

  return NextResponse.json(
    { error: "Unknown lookup.", connected: listPayers().length > 0 },
    { status: 400, headers: NO_STORE }
  );
}
