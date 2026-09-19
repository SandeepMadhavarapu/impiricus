/**
 * Lightweight source version probes.
 *
 * Each adapter answers one question as cheaply as the source allows: "has this
 * changed since we last looked?" Full ingestion only runs when the answer is
 * yes, or when the configured maximum age has expired.
 *
 * NONE OF THESE SOURCES OFFER WEBHOOKS. Every one is polled. The report
 * therefore keeps two numbers apart: how often WE check, and how often the
 * publisher actually releases. A daily check against a monthly release is not
 * a daily update, and calling it "real-time" would be false.
 *
 * Conditional requests are used where the server supports them, so an
 * unchanged source usually costs a 304 and no body.
 */

import { createHash } from "node:crypto";
import { REQUEST_TIMEOUT_MS, USER_AGENT } from "../config/sources.js";
import { withOpenFdaKey, sanitizeUrl } from "../sources/http.js";
import { redactSecrets } from "../config/env.js";
import { classifyFailure, type SourceCheckResult, type SourceVersion } from "./state.js";
import { VA_PDL_VERSIONS, VA_PDL_LANDING, vaPdlUrl } from "../sources/vaMedicaid.js";

/**
 * How stale each source may get before a refresh is forced regardless of
 * whether a change was detected, and how often the publisher actually issues
 * new data. These are different numbers and are reported separately.
 */
export interface SourcePolicy {
  sourceId: string;
  label: string;
  /** Force a full refresh once data is older than this. */
  maxAcceptableAgeHours: number;
  /** The publisher's own release cadence, in words. */
  publisherCadence: string;
  /** How often we poll. */
  checkCadence: string;
  requiresCredential: boolean;
}

export const SOURCE_POLICIES: Record<string, SourcePolicy> = {
  openfda: {
    sourceId: "openfda",
    label: "openFDA (labels, NDC, enforcement)",
    maxAcceptableAgeHours: 24 * 7,
    publisherCadence:
      "openFDA states a per-endpoint last_updated date; drug label and enforcement endpoints " +
      "typically refresh weekly.",
    checkCadence: "daily",
    requiresCredential: false,
  },
  dailymed: {
    sourceId: "dailymed",
    label: "DailyMed SPL",
    maxAcceptableAgeHours: 24 * 7,
    publisherCadence: "Continuous; individual SPLs gain a new version whenever a labeler files one.",
    checkCadence: "daily",
    requiresCredential: false,
  },
  rxnav: {
    sourceId: "rxnav",
    label: "RxNorm / RxNav",
    maxAcceptableAgeHours: 24 * 31,
    publisherCadence: "Full RxNorm release monthly (first Monday); weekly updates in between.",
    checkCadence: "daily",
    requiresCredential: false,
  },
  "cms-part-d": {
    sourceId: "cms-part-d",
    label: "CMS Part D formulary files",
    maxAcceptableAgeHours: 24 * 31,
    publisherCadence: "Monthly release.",
    checkCadence: "daily",
    requiresCredential: false,
  },
  vamedicaid: {
    sourceId: "vamedicaid",
    label: "Virginia Medicaid PDL",
    maxAcceptableAgeHours: 24 * 31,
    publisherCadence:
      "Quarterly effective dates (Jan/Apr/Jul/Oct) with interim revisions, each published weeks " +
      "BEFORE it takes effect.",
    checkCadence: "daily",
    requiresCredential: false,
  },
};

/** Bounded, credential-safe fetch used only for version probes. */
async function probe(
  url: string,
  opts: { method?: "GET" | "HEAD"; headers?: Record<string, string> } = {}
): Promise<{ status: number | null; headers: Headers | null; body: string | null; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "*/*", ...(opts.headers ?? {}) },
      signal: controller.signal,
      redirect: "follow",
    });
    // 304 carries no body and is a definitive "unchanged".
    const body = res.status === 304 || opts.method === "HEAD" ? null : await res.text();
    return { status: res.status, headers: res.headers, body, error: null };
  } catch (err) {
    const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    // Redact before the message can reach a log or a workflow summary.
    return { status: null, headers: null, body: null, error: redactSecrets(raw) };
  } finally {
    clearTimeout(timer);
  }
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function validators(h: Headers | null): Pick<SourceVersion, "etag" | "lastModified"> {
  return {
    etag: h?.get("etag") ?? null,
    lastModified: h?.get("last-modified") ?? null,
  };
}

export interface CheckContext {
  previous: SourceVersion | null;
  lastSuccessfulCheck: string | null;
  lastSuccessfulRetrieval: string | null;
  /** Ignore "unchanged" and report changed anyway. */
  force?: boolean;
}

function base(
  policy: SourcePolicy,
  ctx: CheckContext
): Pick<
  SourceCheckResult,
  | "sourceId"
  | "label"
  | "previous"
  | "checkedAt"
  | "lastSuccessfulCheck"
  | "lastSuccessfulRetrieval"
  | "maxAcceptableAgeHours"
  | "upcoming"
> {
  return {
    sourceId: policy.sourceId,
    label: policy.label,
    previous: ctx.previous,
    checkedAt: new Date().toISOString(),
    lastSuccessfulCheck: ctx.lastSuccessfulCheck,
    lastSuccessfulRetrieval: ctx.lastSuccessfulRetrieval,
    maxAcceptableAgeHours: policy.maxAcceptableAgeHours,
    upcoming: null,
  };
}

function isStale(lastRetrieval: string | null, maxHours: number): boolean {
  if (!lastRetrieval) return true;
  const age = Date.now() - Date.parse(lastRetrieval);
  return age > maxHours * 3600_000;
}

function settle(
  b: ReturnType<typeof base>,
  current: SourceVersion | null,
  changed: boolean,
  detail: string,
  httpStatus: number | null,
  ctx: CheckContext
): SourceCheckResult {
  const neverRetrieved = b.lastSuccessfulRetrieval === null;
  const stale = isStale(b.lastSuccessfulRetrieval, b.maxAcceptableAgeHours);

  // `outcome` reports what the SOURCE did. `refreshDue` reports what WE should
  // do. They are different questions and are answered separately.
  const reason: SourceCheckResult["refreshDueReason"] = changed
    ? "source-changed"
    : ctx.force
      ? "forced"
      : neverRetrieved
        ? "never-retrieved"
        : stale
          ? "max-age-exceeded"
          : null;

  return {
    ...b,
    stage: "discovered",
    outcome: changed ? "changed" : "no-change",
    current,
    httpStatus,
    detail:
      detail +
      (!changed && neverRetrieved
        ? " Source is unchanged, but we hold no record of ever retrieving it, so a refresh is due."
        : "") +
      (!changed && !neverRetrieved && stale
        ? " Source is unchanged, but our copy exceeds its maximum acceptable age."
        : "") +
      (!changed && ctx.force ? " Refresh forced." : ""),
    stale,
    refreshDue: reason !== null,
    refreshDueReason: reason,
    // A successful check advances the check timestamp; retrieval is advanced
    // only by an actual ingest, elsewhere.
    lastSuccessfulCheck: b.checkedAt,
  };
}

function fail(
  b: ReturnType<typeof base>,
  status: number | null,
  detail: string
): SourceCheckResult {
  return {
    ...b,
    stage: "discovered",
    outcome: classifyFailure(status, detail),
    current: null,
    httpStatus: status,
    detail: redactSecrets(detail),
    stale: isStale(b.lastSuccessfulRetrieval, b.maxAcceptableAgeHours),
    // A failed check establishes nothing, so it cannot establish that a
    // refresh is due either.
    refreshDue: false,
    refreshDueReason: null,
    // NOT advanced: a failed check is not evidence the source was reached.
  };
}

/* ------------------------------------------------------------- openFDA */

/**
 * openFDA publishes `meta.last_updated` per endpoint. That is the dataset's
 * own statement about itself and is cheaper and more honest than hashing a
 * result page, which changes whenever ranking does.
 */
export async function checkOpenFda(ctx: CheckContext): Promise<SourceCheckResult> {
  const policy = SOURCE_POLICIES.openfda!;
  const b = base(policy, ctx);
  const url = withOpenFdaKey("https://api.fda.gov/drug/label.json?limit=1");

  const r = await probe(url);
  if (r.status === null) return fail(b, null, r.error ?? "network failure");
  if (r.status !== 200) {
    return fail(
      b,
      r.status,
      r.status === 401 || r.status === 403
        ? `HTTP ${r.status}: openFDA rejected the request. If OPENFDA_API_KEY is set, it may be ` +
          "invalid or revoked. The pipeline also works without a key at a lower rate limit."
        : `HTTP ${r.status} from ${sanitizeUrl(url)}`
    );
  }

  let lastUpdated: string | null = null;
  try {
    lastUpdated = JSON.parse(r.body ?? "{}")?.meta?.last_updated ?? null;
  } catch {
    return fail(b, r.status, "openFDA returned a 200 that is not valid JSON.");
  }
  if (!lastUpdated) {
    return fail(b, r.status, "openFDA response carried no meta.last_updated to compare.");
  }

  const current: SourceVersion = {
    version: lastUpdated,
    publishedDate: lastUpdated,
    ...validators(r.headers),
    contentHash: null,
    method: "api-version-field",
  };
  const changed = ctx.previous?.version !== lastUpdated;
  return settle(
    b,
    current,
    changed,
    `openFDA drug/label meta.last_updated = ${lastUpdated}.` +
      (changed && ctx.previous?.version ? ` Previously ${ctx.previous.version}.` : ""),
    r.status,
    ctx
  );
}

/* ------------------------------------------------------------ DailyMed */

/**
 * DailyMed exposes an SPL's version history. The setid is stable across
 * revisions and the version number increments, so identity is checked by
 * (setid, version) rather than by hashing the XML - which would also change
 * when only whitespace moved.
 */
export async function checkDailyMed(
  ctx: CheckContext,
  setIds: string[]
): Promise<SourceCheckResult> {
  const policy = SOURCE_POLICIES.dailymed!;
  const b = base(policy, ctx);
  if (setIds.length === 0) {
    return fail(b, null, "No SPL setids configured to check.");
  }

  const versions: string[] = [];
  for (const setId of setIds) {
    const url = `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/${setId}/history.json`;
    const r = await probe(url);
    if (r.status === null) return fail(b, null, r.error ?? "network failure");
    if (r.status !== 200) return fail(b, r.status, `HTTP ${r.status} for SPL ${setId} history.`);
    try {
      const j = JSON.parse(r.body ?? "{}");
      const history = j?.data?.history ?? j?.data ?? [];
      const latest = Array.isArray(history) && history.length > 0 ? history[history.length - 1] : null;
      const v = latest?.spl_version ?? latest?.version ?? null;
      versions.push(`${setId}:${v ?? "unknown"}`);
    } catch {
      return fail(b, r.status, `DailyMed history for ${setId} is not valid JSON.`);
    }
  }

  const composite = versions.sort().join("|");
  const current: SourceVersion = {
    version: composite,
    publishedDate: null,
    etag: null,
    lastModified: null,
    contentHash: hash(composite),
    method: "api-version-field",
  };
  const changed = ctx.previous?.version !== composite;
  return settle(
    b,
    current,
    changed,
    `Checked ${setIds.length} SPL set id(s) by version history. ` +
      (changed ? "At least one SPL version differs." : "All SPL versions unchanged."),
    200,
    ctx
  );
}

/* -------------------------------------------------------------- RxNorm */

/**
 * RxNav publishes its current data version. A change means concepts may have
 * been added, retired or remapped - which is why a version bump triggers a
 * re-resolution rather than a silent reuse of the stored RXCUI.
 */
export async function checkRxNorm(ctx: CheckContext): Promise<SourceCheckResult> {
  const policy = SOURCE_POLICIES.rxnav!;
  const b = base(policy, ctx);
  const url = "https://rxnav.nlm.nih.gov/REST/version.json";
  const r = await probe(url);
  if (r.status === null) return fail(b, null, r.error ?? "network failure");
  if (r.status !== 200) return fail(b, r.status, `HTTP ${r.status} from RxNav version endpoint.`);

  let version: string | null = null;
  try {
    const j = JSON.parse(r.body ?? "{}");
    version = j?.version ?? j?.rxnormVersion ?? null;
  } catch {
    return fail(b, r.status, "RxNav version endpoint returned a 200 that is not valid JSON.");
  }
  if (!version) return fail(b, r.status, "RxNav response carried no version field.");

  const current: SourceVersion = {
    version,
    publishedDate: null,
    ...validators(r.headers),
    contentHash: null,
    method: "api-version-field",
  };
  const changed = ctx.previous?.version !== version;
  return settle(
    b,
    current,
    changed,
    `RxNorm data version ${version}.` +
      (changed
        ? " A version change can retire or remap RXCUIs, so product identity must be re-resolved " +
          "rather than assumed."
        : ""),
    r.status,
    ctx
  );
}

/* ---------------------------------------------------------- CMS Part D */

/**
 * CMS publishes the Part D files as a dated archive. The check reads the
 * dataset metadata rather than the 2.14 GB archive.
 *
 * Publication date, release label and plan year are kept separate: a release
 * published in August can carry a contract year of 2026, and conflating them
 * would date the coverage wrongly.
 */
export async function checkCmsPartD(ctx: CheckContext): Promise<SourceCheckResult> {
  const policy = SOURCE_POLICIES["cms-part-d"]!;
  const b = base(policy, ctx);
  try {
    const { findPartDRelease } = await import("../sources/cmsPartD.js");
    const rel: any = await findPartDRelease();
    const current: SourceVersion = {
      version: rel.release ?? null,
      publishedDate: rel.modified ?? null,
      etag: null,
      lastModified: rel.modified ?? null,
      contentHash: null,
      method: "document-catalogue",
    };
    const changed =
      ctx.previous?.version !== current.version ||
      ctx.previous?.publishedDate !== current.publishedDate;
    return settle(
      b,
      current,
      changed,
      `CMS release ${current.version} (published ${current.publishedDate}).` +
        (changed && ctx.previous?.version ? ` Previously ${ctx.previous.version}.` : ""),
      200,
      ctx
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /HTTP (\d{3})/.exec(msg)?.[1];
    return fail(b, status ? Number(status) : null, `CMS release discovery failed: ${msg}`);
  }
}

/* ------------------------------------------------- Virginia Medicaid */

/**
 * Virginia's documents are static PDFs at versioned URLs, so the check is a
 * conditional request against the catalogue's newest entries.
 *
 * The result separates what is IN FORCE from what is merely published: this
 * publisher issues each quarterly PDL weeks ahead of its effective date, and a
 * newly discovered document is normally upcoming, not current.
 */
export async function checkVirginiaMedicaid(
  ctx: CheckContext,
  asOf: string
): Promise<SourceCheckResult> {
  const policy = SOURCE_POLICIES.vamedicaid!;
  const b = base(policy, ctx);

  const parts: string[] = [];
  let upcoming: SourceCheckResult["upcoming"] = null;

  for (const ref of VA_PDL_VERSIONS) {
    const url = vaPdlUrl(ref.slug);
    const headers: Record<string, string> = {};
    // Conditional request: an unchanged PDF costs a 304 and no megabytes.
    if (ctx.previous?.etag) headers["If-None-Match"] = ctx.previous.etag;

    const r = await probe(url, { method: "HEAD", headers });
    if (r.status === null) return fail(b, null, r.error ?? "network failure");
    if (r.status !== 200 && r.status !== 304) {
      return fail(b, r.status, `HTTP ${r.status} for ${ref.slug}.`);
    }
    const v = validators(r.headers);
    parts.push(`${ref.slug}:${v.etag ?? v.lastModified ?? "no-validator"}`);

    if (ref.effectiveDate > asOf) {
      upcoming = { version: ref.expectedFooterVersion, effectiveDate: ref.effectiveDate };
    }
  }

  const composite = parts.join("|");
  const current: SourceVersion = {
    version: composite,
    publishedDate: null,
    etag: null,
    lastModified: null,
    contentHash: hash(composite),
    method: "http-validator",
  };
  const changed = ctx.previous?.contentHash !== current.contentHash;

  const result = settle(
    b,
    current,
    changed,
    `Checked ${VA_PDL_VERSIONS.length} catalogued PDL document(s) by HTTP validator.` +
      (upcoming
        ? ` One is FUTURE-EFFECTIVE (${upcoming.version}, effective ${upcoming.effectiveDate}) and ` +
          "is retained as upcoming, not treated as current coverage."
        : ""),
    200,
    ctx
  );
  return { ...result, upcoming };
}

/**
 * The publication page, checked separately from the catalogued documents.
 *
 * A NEW document appearing on the page is exactly what the catalogue cannot
 * see, so its validator is tracked too. A change here means "a human should
 * look at the page", not "ingest something new automatically": the catalogue
 * is deliberately explicit so a new URL cannot silently become evidence.
 */
export async function checkVirginiaLandingPage(
  ctx: CheckContext
): Promise<SourceCheckResult> {
  const policy = SOURCE_POLICIES.vamedicaid!;
  const b = { ...base(policy, ctx), sourceId: "vamedicaid-landing", label: "Virginia PDL publication page" };
  const r = await probe(VA_PDL_LANDING, { method: "HEAD" });
  if (r.status === null) return fail(b, null, r.error ?? "network failure");
  if (r.status >= 400) return fail(b, r.status, `HTTP ${r.status} for the publication page.`);

  const v = validators(r.headers);
  const current: SourceVersion = {
    version: null,
    publishedDate: null,
    ...v,
    contentHash: null,
    method: v.etag || v.lastModified ? "http-validator" : "none",
  };
  const changed = Boolean(
    (v.etag && ctx.previous?.etag && v.etag !== ctx.previous.etag) ||
      (v.lastModified && ctx.previous?.lastModified && v.lastModified !== ctx.previous.lastModified)
  );
  return settle(
    b,
    current,
    changed,
    changed
      ? "The publication page changed. A NEW document may have been posted; the document " +
        "catalogue is explicit, so review the page and add the entry deliberately."
      : "Publication page unchanged, or it offers no validator to compare.",
    r.status,
    ctx
  );
}
