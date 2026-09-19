import { sessionResponse } from "@/shared/lib/nearby-share/api";
import { createSession } from "@/shared/lib/nearby-share/sessions";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return sessionResponse(request, body => createSession(typeof body.medicationSlug === "string" ? body.medicationSlug : ""));
}
