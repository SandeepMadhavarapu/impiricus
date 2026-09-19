import "server-only";
import { NextResponse } from "next/server";
import { SessionError } from "./sessions";
export async function sessionResponse(request: Request, action: (body: Record<string, unknown>) => unknown) {
  const headers = { "Cache-Control": "no-store" };
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
