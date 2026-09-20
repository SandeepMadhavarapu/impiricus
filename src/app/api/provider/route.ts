import { NextResponse } from "next/server";
import { lookupNpi } from "@/sources/lib/providers/nppes";

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
 */

export const runtime = "nodejs";

export async function GET(request: Request): Promise<NextResponse> {
  const npi = new URL(request.url).searchParams.get("npi")?.trim() ?? "";

  if (npi.length === 0) {
    return NextResponse.json(
      { error: "Provide an npi query parameter." },
      { status: 400 }
    );
  }

  // Bound the input before it reaches validation, so an oversized string is
  // never echoed back or logged.
  if (npi.length > 20) {
    return NextResponse.json({ error: "That is not an NPI." }, { status: 400 });
  }

  const result = await lookupNpi(npi);

  // A registry outage is a 503, not a 200 with an empty body: a client must be
  // able to tell "we could not check" from "this NPI is not registered".
  const status = result.outcome.state === "source-unavailable" ? 503 : 200;

  return NextResponse.json(result, {
    status,
    headers: {
      // The registry updates slowly; this keeps a retry loop off a public
      // service without making an answer meaningfully older.
      "Cache-Control": "public, max-age=3600",
    },
  });
}
