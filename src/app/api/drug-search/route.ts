import { NextResponse } from "next/server";
import { searchDrugLabels } from "@/sources/lib/content/drug-search";
import { rateLimit, clientKey } from "@/shared/lib/security/ratelimit";

/**
 * Search FDA drug labels by name.
 *
 * Server-side so the outbound query is built here rather than in the browser,
 * and so a typed search term never becomes part of a URL this app publishes.
 *
 * Responses are no-store. What someone searched for is not something to leave
 * in a shared cache, and none of it is logged.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * Tighter than the directory's 60/min: each request here is an outbound call
 * to a public federal API that this project does not want to hammer, and a
 * person typing a drug name does not need thirty tries a minute.
 */
const LIMIT = 30;
const WINDOW_MS = 60_000;

export async function GET(req: Request) {
  const key = await clientKey(req.headers);
  if (!rateLimit(`drug-search:${key}`, LIMIT, WINDOW_MS).allowed) {
    return NextResponse.json({ error: "Too many searches." }, { status: 429, headers: NO_STORE });
  }

  const q = new URL(req.url).searchParams.get("q") ?? "";
  const result = await searchDrugLabels(q);

  if (result.status === "unavailable") {
    if (result.reason === "query-too-short") {
      return NextResponse.json(
        { error: "Type at least two letters.", hits: [], totalMatches: 0 },
        { status: 400, headers: NO_STORE }
      );
    }
    /*
     * "We could not search" is not "no such medication". A 200 with an error
     * message keeps the distinction in the UI, which shows the message instead
     * of the empty-result wording.
     */
    return NextResponse.json(
      {
        hits: [],
        totalMatches: 0,
        error: "The FDA label service could not be reached just now. Try again in a moment.",
      },
      { status: 200, headers: NO_STORE }
    );
  }

  return NextResponse.json(
    { hits: result.hits, totalMatches: result.totalMatches },
    { headers: NO_STORE }
  );
}
