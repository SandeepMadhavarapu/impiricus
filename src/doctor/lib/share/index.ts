/**
 * Share URL construction.
 *
 * Hard rule: a share URL, its QR code, and its preview text contain the public
 * medication path and nothing else. No identifiers, no conversation, no
 * insurance details, no session tokens, no query parameters at all.
 *
 * URLs leak. They land in messaging app previews, screenshots, server logs,
 * browser history, and the clipboard of whoever the link is forwarded to.
 */

export interface ShareTarget {
  url: string;
  title: string;
  text: string;
}

/** Characters a slug may contain. Anything else is rejected, not sanitised. */
const SLUG_PATTERN = /^[a-z0-9-]+$/;

export class InvalidShareTargetError extends Error {}

export function medicationPath(slug: string): string {
  if (!SLUG_PATTERN.test(slug)) {
    throw new InvalidShareTargetError(`Refusing to build a share URL for slug: ${slug}`);
  }
  return `/medications/${slug}`;
}

/**
 * Builds the absolute public URL for a medication.
 *
 * `origin` must come from validated configuration, never from a request header.
 */
export function buildShareUrl(origin: string, slug: string): string {
  const path = medicationPath(slug);
  const base = new URL(origin);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
    throw new InvalidShareTargetError("Share origin must be https outside local development");
  }
  const url = new URL(path, base.origin);
  // Belt and braces: strip anything that could have ridden along.
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * The payload handed to navigator.share.
 *
 * Text is about the medication only — never about the person sharing it, and
 * never phrased as a recommendation to take the drug.
 */
export function buildShareTarget(origin: string, slug: string, productName: string): ShareTarget {
  return {
    url: buildShareUrl(origin, slug),
    title: `${productName}: what it is, benefits and risks`,
    text: `Plain-language information about ${productName}, sourced from the FDA-approved label.`,
  };
}

/** True when a URL carries anything beyond the bare public path. */
export function urlCarriesExtraData(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.search.length > 0 || url.hash.length > 0;
  } catch {
    return true;
  }
}
