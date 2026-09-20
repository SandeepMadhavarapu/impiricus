import { NextResponse } from "next/server";
import { lookupNpi } from "@/sources/lib/providers/nppes";
import { rateLimit, clientKey } from "@/shared/lib/security/ratelimit";

/**
 * NPI lookup.
 *
 * Takes one NPI and reports what the CMS registry says about it. It is not a
 * search endpoint: there is no name, city or specialty parameter, because a
 * near-match returned for a name query is read as "my doctor" by almost
 * everyone, and NPPES cannot support that reading.
 *
 * The NPI itself is not personal data about the requester, and nothing about
 * the request is stored. The response carries CMS's own disclaimer so a client
 * cannot render the result without it.
 *
 * PRODUCTION INTENT
 * -----------------
 * This is a PATIENT-facing feature despite the provider code living under
 * src/doctor/: ProviderSheet is rendered from the patient ActionBar, so someone
 * can check the NPI their prescriber gave them. It is therefore NOT gated by
 * servesClinicianWorkspace(), unlike /doctor.
 *
 * It is an unauthenticated proxy in front of a free public CMS service, which
 * makes it the easiest thing here to abuse, so it is rate limited.
 *
 * WHAT THAT LIMIT ACTUALLY IS. The limiter is an in-process map. On a
 * serverless host each concurrent instance keeps its own counter and a cold
 * start begins at zero, so the effective ceiling is "20 per minute per warm
 * instance", NOT a global 20 per minute. It raises the cost of casual abuse;
 * it is not a quota and must not be described as one. A real global limit
 * needs a shared store, which this prototype does not have - see
 * docs/LIMITATIONS.md.
 *
 * The cache header is deliberately `public`: an NPI and the registry's answer
 * about it are both public record, and nothing in the request identifies who
 * asked. Do not add a parameter that carries anything about the requester
 * without revisiting that.
 */

export const runtime = "nodejs";

/**
 * Deliberately tighter than /api/directory's 60/min. That one answers from a
 * file already in memory; every request here can reach out to CMS. Per warm
 * instance, not global - see the note above.
 */
const LIMIT = 20;
const WINDOW_MS = 60_000;

export async function GET(request: Request): Promise<NextResponse> {
  const key = await clientKey(request.headers);
  if (!rateLimit(`provider:${key}`, LIMIT, WINDOW_MS).allowed) {
    return NextResponse.json(
      { error: "Too many lookups. Wait a minute and try again." },
      // Never cached: a 429 is about this client right now, and a shared cache
      // would serve it to everyone behind the same address.
      { status: 429, headers: { "Cache-Control": "no-store" } }
    );
  }

  const npi = new URL(request.url).searchParams.get("npi")?.trim() ?? "";

  if (npi.length === 0) {
    return NextResponse.json(
      { error: "Provide an npi query parameter." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Bound the input before it reaches validation, so an oversized string is
  // never echoed back or logged.
  if (npi.length > 20) {
    return NextResponse.json(
      { error: "That is not an NPI." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const result = await lookupNpi(npi);

  // A registry outage is a 503, not a 200 with an empty body: a client must be
  // able to tell "we could not check" from "this NPI is not registered".
  const status = result.outcome.state === "source-unavailable" ? 503 : 200;

  return NextResponse.json(result, {
    status,
    headers: {
      // The registry updates slowly, so a real answer caches for an hour and
      // keeps retry loops off a public service. An outage must NOT cache:
      // storing "we could not check" for an hour would keep reporting it long
      // after CMS came back.
      "Cache-Control": status === 503 ? "no-store" : "public, max-age=3600",
    },
  });
}
