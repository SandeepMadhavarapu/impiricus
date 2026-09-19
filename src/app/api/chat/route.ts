import { NextResponse } from "next/server";
import { ChatRequestSchema } from "@/lib/chat/types";
import { answerQuestion } from "@/lib/chat/orchestrator";
import { rateLimit, clientKey } from "@/lib/security/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 20 questions per 5 minutes per client. */
const LIMIT = 20;
const WINDOW_MS = 5 * 60 * 1000;

/**
 * Chat endpoint.
 *
 * Responses are always no-store: an answer may reference what a person asked,
 * and must never land in a shared or public cache.
 *
 * Nothing in this handler logs message content. Medical questions are sensitive
 * and a prototype has no business retaining them.
 */
export async function POST(request: Request) {
  const key = await clientKey(request.headers);
  const limit = rateLimit(`chat:${key}`, LIMIT, WINDOW_MS);
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

  const parsed = ChatRequestSchema.safeParse(payload);
  if (!parsed.success) {
    // The validation issue is returned without echoing the submitted content.
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400, headers: { "cache-control": "no-store" } }
    );
  }

  try {
    const answer = await answerQuestion(parsed.data);
    return NextResponse.json(answer, {
      headers: { "cache-control": "no-store, private", "x-robots-tag": "noindex" },
    });
  } catch {
    // Deliberately opaque: an internal error message could echo prompt content.
    return NextResponse.json(
      { error: "The assistant is unavailable right now." },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
}
