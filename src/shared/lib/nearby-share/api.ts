import "server-only";
import { NextResponse } from "next/server";
import { SessionError } from "./sessions";
import { rateLimit, clientKey } from "@/shared/lib/security/ratelimit";

/*
 * Every other route in this app is rate limited; these three were not.
 *
 * The session token is stateless - an AES-256-GCM payload, not a row in a
 * store - so unbounded requests cannot grow anything server-side. What they
 * can do is burn CPU on encryption and decryption for free. The limit is
 * generous, because a clinician sharing to several patients in a row is a
 * normal minute of work, not abuse.
 *
 * As everywhere else here, this is an in-process counter: on a serverless host
 * each warm instance counts separately, so it raises the cost of casual abuse
 * and is not a global quota.
 */
const LIMIT = 40;
const WINDOW_MS = 60_000;

export async function sessionResponse(request: Request, action: (body: Record<string, unknown>) => unknown) {
  const headers = { "Cache-Control": "no-store" };
  const key = await clientKey(request.headers);
  if (!rateLimit(`nearby:${key}`, LIMIT, WINDOW_MS).allowed) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429, headers });
  }
  try {
    const raw = await request.text();
    if (raw.length > 1024) return NextResponse.json({ error: "Request too large." }, { status: 413, headers });
    const body: unknown = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new SyntaxError();
    return NextResponse.json(action(body as Record<string, unknown>), { headers });
  } catch (error) {
    const status = error instanceof SessionError ? error.status : 400;
    return NextResponse.json({ error: error instanceof SessionError ? error.message : "Invalid request." }, { status, headers });
  }
}
