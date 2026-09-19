/**
 * Link verification for the routes we publish.
 *
 * A next step whose form URL 404s is worse than no next step: it sends a
 * patient or a prescriber down a dead end while looking authoritative. Every
 * URL exported as an action or a contact is checked, and the check result
 * travels with the link so a consumer can tell when it was last known good.
 *
 * Two outcomes are deliberately distinguished from a dead link:
 *
 *   - a host that refuses automated requests (403) is NOT evidence the page is
 *     gone; ssa.gov does this. It is reported as blocked, and the link is kept
 *     with that status rather than quietly dropped.
 *   - a network failure is reported as such, not as a 404.
 */

import { REQUEST_TIMEOUT_MS, USER_AGENT } from "../config/sources.js";

export interface LinkCheckResult {
  url: string;
  checkedAt: string;
  httpStatus: number | null;
  ok: boolean;
  note: string;
}

/**
 * Checks one URL.
 *
 * Uses GET rather than HEAD: several government hosts answer HEAD with 405
 * while serving the page perfectly well, which would produce a false dead
 * link. The body is discarded without being read.
 */
export async function checkLink(url: string): Promise<LinkCheckResult> {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      redirect: "follow",
      signal: controller.signal,
    });
    try {
      await res.body?.cancel();
    } catch {
      // Nothing depends on draining the body.
    }

    if (res.ok) {
      return { url, checkedAt, httpStatus: res.status, ok: true, note: `HTTP ${res.status}.` };
    }
    if (res.status === 403 || res.status === 429) {
      return {
        url,
        checkedAt,
        httpStatus: res.status,
        ok: false,
        note:
          `HTTP ${res.status}: the host refused an automated request. This is NOT evidence the ` +
          "page is gone; it should be opened in a browser to confirm.",
      };
    }
    return {
      url,
      checkedAt,
      httpStatus: res.status,
      ok: false,
      note: `HTTP ${res.status}. Treat this link as unverified and do not present it as official.`,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      url,
      checkedAt,
      httpStatus: null,
      ok: false,
      note: aborted
        ? `Timed out after ${REQUEST_TIMEOUT_MS}ms. Reachability unknown, not a dead link.`
        : `Request failed: ${String(err)}. Reachability unknown, not a dead link.`,
    };
  }
}

/** Checks a set of URLs sequentially, so no host is hammered. */
export async function checkLinks(urls: string[]): Promise<Map<string, LinkCheckResult>> {
  const out = new Map<string, LinkCheckResult>();
  for (const url of [...new Set(urls)]) {
    out.set(url, await checkLink(url));
  }
  return out;
}

/** Every URL an action set would publish, for checking. */
export function urlsFromTemplates(
  templates: Array<{ formUrl?: string | null; submissionUrl?: string | null }>,
  documents: Record<string, { url: string }>
): string[] {
  const urls: string[] = [];
  for (const t of templates) {
    if (t.formUrl) urls.push(t.formUrl);
    if (t.submissionUrl) urls.push(t.submissionUrl);
  }
  for (const d of Object.values(documents)) urls.push(d.url);
  return [...new Set(urls)];
}
