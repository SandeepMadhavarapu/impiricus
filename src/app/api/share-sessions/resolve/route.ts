import { sessionResponse } from "@/shared/lib/nearby-share/api";
import { resolveSession } from "@/shared/lib/nearby-share/sessions";
export const runtime = "nodejs";
// POST keeps bearer tokens out of URL histories and ordinary access logs.
export async function POST(request: Request) {
  return sessionResponse(request, body => resolveSession(typeof body.token === "string" ? body.token : ""));
}
