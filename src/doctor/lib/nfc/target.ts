import "server-only";
import { getGuide, guideProductName } from "@/sources/lib/content/catalogue";
import { buildShareUrl } from "@/doctor/lib/share";
import { validateNfcUrl, type NfcTarget } from "./protocol";

/** Called by the server-rendered doctor flow, using validated configuration. */
export function createNfcTarget(slug: string, origin: string): NfcTarget | null {
  const guide = getGuide(slug);
  if (!guide) return null;
  try {
    return { slug: guide.slug, name: guideProductName(guide), url: validateNfcUrl(buildShareUrl(origin, guide.slug)) };
  } catch { return null; }
}
