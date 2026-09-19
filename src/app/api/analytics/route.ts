import { NextResponse } from "next/server";
import { sanitizeEvent } from "@/lib/analytics/events";
import { getAnalyticsConfig } from "@/lib/config";
import { rateLimit, clientKey } from "@/lib/security/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Analytics sink.
 *
 * Events are sanitised against an allow-list before anything is recorded, so an
 * unexpected property (chat text, a slug, a plan name) is dropped at the
 * boundary rather than relied on to be absent.
 *
 * With ANALYTICS_ENABLED unset, events are accepted and discarded. Nothing is
 * forwarded to a third party from this prototype.
 */
export async function POST(request: Request) {
  const key = await clientKey(request.headers);
  const limit = rateLimit(`analytics:${key}`, 120, 60_000);
  if (!limit.allowed) {
    return new NextResponse(null, { status: 429, headers: { "cache-control": "no-store" } });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  const name = (payload as { event?: unknown })?.event;
  const properties = (payload as { properties?: unknown })?.properties;
  if (typeof name !== "string") {
    return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  const sanitized = sanitizeEvent(name, properties);
  if (!sanitized) {
    return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  if (getAnalyticsConfig().enabled) {
    // Only the sanitised name + allow-listed properties. No IP, no user agent,
    // no referrer URL, no identifier of any kind.
    console.log(
      JSON.stringify({ kind: "analytics", event: sanitized.event, properties: sanitized.properties })
    );
  }

  return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
}
