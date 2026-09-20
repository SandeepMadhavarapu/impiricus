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

    /*
     * An empty box gets no suggestions.
     *
     * `searchPayers("")` means "no filter" and returns all 525 organizations,
     * which this route then truncated to 50. Alphabetically, those 50 are ALL
     * of the A's - ABSOLUTE TOTAL CARE through AMERICAN HEALTH PLAN OF UT.
     * Someone insured by Humana or UnitedHealthcare opened the picker, saw a
     * confident list of insurers, and did not see theirs. A truncated
     * alphabetical slice presented as suggestions is worse than no
     * suggestions: it reads as the whole list.
     *
     * The field's placeholder already tells someone what to type, and typing
     * two characters returns real matches, including on plan names.
     */
    const suggestions = q.trim().length === 0 ? [] : searchPayers(q).slice(0, 50);

    return NextResponse.json(
      {
        connected: isDirectoryConnected(),
        release: directoryRelease(),
        payers: suggestions,
        /** How many organizations exist, so a caller never mistakes 50 for all. */
        totalPayers: listPayers().length,
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
    return NextResponse.json({ pharmacies: findPharmacies(zip) }, { headers: NO_STORE });
  }

  return NextResponse.json(
    { error: "Unknown lookup.", connected: listPayers().length > 0 },
    { status: 400, headers: NO_STORE }
  );
}
