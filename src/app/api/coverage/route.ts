import { NextResponse } from "next/server";
import { CoverageRequestSchema } from "@/patient/lib/coverage/types";
import { getCoverageAdapter, checkCoverageSafely } from "@/patient/lib/coverage/adapters";
import {
  getGuide,
  guideProductName,
  coverageRequestMatchesProduct,
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

  /*
   * Resolved through the CATALOGUE, not the authored registry.
   *
   * The registry holds only medications with a hand-written plain-language
   * layer - one product today. Resolving here meant the coverage endpoint
   * returned "Unknown medication" for the two label-sourced pages, even though
   * both render the same "Check coverage" button and both have real formulary
   * rows in the CMS snapshot. Two of the three medication pages had a visible
   * control that could never succeed.
   */
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
  /*
   * Structured comparison against the product's own identity.
   *
   * The form never asks for a strength - it sends the page's product - so this
   * is about the API contract: both values are echoed back in the result's
   * "Fill" line beside real formulary facts, and a caller must not be able to
   * describe a different product there.
   */
  const match = coverageRequestMatchesProduct(
    parsed.data.slug,
    parsed.data.strength,
    parsed.data.dosageForm
  );
  if (!match.ok) {
    const message =
      match.reason === "dosage-form-differs"
        ? "The requested dosage form does not match this medication page. An extended-release product is not the same as an immediate-release one, so we will not answer for a different form."
        : match.reason === "requested-strength-not-a-strength"
          ? "The requested strength is not a strength. Give an amount with a unit, for example \"10 mg\"."
          : "The requested strength does not match this medication page. Coverage varies by strength, so we will not answer for a different one.";
    return NextResponse.json(
      { error: message, reason: match.reason },
      { status: 400, headers: { "cache-control": "no-store" } }
    );
  }

  const adapter = getCoverageAdapter();
  const result = await checkCoverageSafely(adapter, parsed.data, guideProductName(guide));

  return NextResponse.json(result, {
    headers: { "cache-control": "no-store, private", "x-robots-tag": "noindex" },
  });
}
