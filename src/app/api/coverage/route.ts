import { NextResponse } from "next/server";
import { CoverageRequestSchema } from "@/patient/lib/coverage/types";
import { getCoverageAdapter, checkCoverageSafely } from "@/patient/lib/coverage/adapters";
import {
  getGuide,
  guideProductName,
  guideStrengthText,
} from "@/sources/lib/content/catalogue";
import { rateLimit, clientKey } from "@/shared/lib/security/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 15;
const WINDOW_MS = 5 * 60 * 1000;

/**
 * Coverage endpoint.
 *
 * Always no-store. Plan details are personal-ish and must never be cached by a
 * CDN, a browser cache, or a service worker.
 *
 * Every failure path returns an "unable to verify" result rather than an error
 * the client might render ambiguously. A broken lookup must never look like a
 * coverage answer.
 */
export async function POST(request: Request) {
  const key = await clientKey(request.headers);
  const limit = rateLimit(`coverage:${key}`, LIMIT, WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "cache-control": "no-store", "retry-after": String(limit.retryAfter) },
      }
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON" },
      { status: 400, headers: { "cache-control": "no-store" } }
    );
  }

  const parsed = CoverageRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400, headers: { "cache-control": "no-store" } }
    );
  }

  // The catalogue, not the authored-only registry: coverage is a generic
  // question about a product, and it applies just as well to a product whose
  // patient page shows label text.
  const guide = getGuide(parsed.data.slug);
  if (!guide) {
    return NextResponse.json(
      { error: "Unknown medication" },
      { status: 404, headers: { "cache-control": "no-store" } }
    );
  }

  /**
   * Guard against a mismatch between the requested fill and the product this
   * page actually describes. Answering about a different strength or form would
   * be worse than not answering.
   */
  const expectedStrength = guideStrengthText(guide);
  if (!expectedStrength.toLowerCase().includes(parsed.data.strength.toLowerCase())) {
    return NextResponse.json(
      {
        error:
          "The requested strength does not match this medication page. Coverage varies by strength, so we will not answer for a different one.",
      },
      { status: 400, headers: { "cache-control": "no-store" } }
    );
  }

  const adapter = getCoverageAdapter();
  const result = await checkCoverageSafely(adapter, parsed.data, guideProductName(guide));

  return NextResponse.json(result, {
    headers: { "cache-control": "no-store, private", "x-robots-tag": "noindex" },
  });
}
