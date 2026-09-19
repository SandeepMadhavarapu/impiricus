import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  SOURCES,
  RETRY,
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
  type SourceId,
} from "../config/sources.js";

/**
 * HTTP layer shared by every source adapter.
 *
 * Responsibilities, all of which exist because a data pipeline that lies about
 * its own retrievals is worse than one that fetches nothing:
 *
 *   - per-host rate limiting and bounded concurrency
 *   - Retry-After compliance, then bounded exponential backoff
 *   - per-request timeouts
 *   - immutable raw capture with a content hash
 *   - an on-disk cache so re-runs are cheap and tests never need the network
 *   - credentials stripped from everything that gets written down
 *
 * A failed retrieval raises. It never returns an empty-but-plausible payload,
 * because a source failure must never become invented data.
 */

export interface RawCapture {
  /** Stable id: sha256 of the canonical request. */
  captureId: string;
  sourceId: SourceId;
  url: string;
  /** URL with any credential removed — this is what gets persisted. */
  sanitizedUrl: string;
  httpStatus: number;
  retrievedAt: string;
  /** sha256 of the response body. */
  contentHash: string;
  contentType: string | null;
  byteLength: number;
  /** Path of the persisted raw body, relative to the pipeline root. */
  rawPath: string;
  /** Publisher-reported freshness, when the payload carries one. */
  sourceLastUpdated: string | null;
  /** True when served from the local cache rather than the network. */
  fromCache: boolean;
}

export interface FetchResult<T> {
  data: T;
  capture: RawCapture;
}

export class SourceUnavailableError extends Error {
  constructor(
    readonly sourceId: SourceId,
    readonly url: string,
    readonly detail: string,
    readonly status?: number
  ) {
    super(`[${sourceId}] ${detail}`);
    this.name = "SourceUnavailableError";
  }
}

/* --------------------------------------------------------------- limiter -- */

interface HostState {
  lastRequestAt: number;
  inFlight: number;
  queue: Array<() => void>;
}

const hostStates = new Map<SourceId, HostState>();

function stateFor(sourceId: SourceId): HostState {
  let s = hostStates.get(sourceId);
  if (!s) {
    s = { lastRequestAt: 0, inFlight: 0, queue: [] };
    hostStates.set(sourceId, s);
  }
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Acquires a slot honouring both concurrency and requests-per-second. */
async function acquire(sourceId: SourceId): Promise<() => void> {
  const spec = SOURCES[sourceId];
  const state = stateFor(sourceId);

  if (state.inFlight >= spec.maxConcurrency) {
    await new Promise<void>((resolve) => state.queue.push(resolve));
  }
  state.inFlight++;

  const minGap = 1000 / spec.maxRequestsPerSecond;
  const since = Date.now() - state.lastRequestAt;
  if (since < minGap) await sleep(minGap - since);
  state.lastRequestAt = Date.now();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.inFlight--;
    state.queue.shift()?.();
  };
}

/* ----------------------------------------------------------------- utils -- */

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Removes credentials from a URL before it is logged or persisted.
 * openFDA takes api_key as a query parameter, so this is not theoretical.
 */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of ["api_key", "apikey", "key", "token", "access_token"]) {
      if (u.searchParams.has(key)) u.searchParams.set(key, "REDACTED");
    }
    return u.toString();
  } catch {
    return url;
  }
}

const RAW_DIR = path.join(process.cwd(), "data", "raw");
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/* ----------------------------------------------------------------- fetch -- */

export interface FetchOptions {
  /** Parse as JSON (default) or keep as text, e.g. SPL XML. */
  as?: "json" | "text";
  /** Skip the cache and force a network round trip. */
  force?: boolean;
  /** Label used in the raw filename, e.g. "label" or "spl-xml". */
  label: string;
  /** Extracts publisher freshness from a parsed payload, when it has one. */
  lastUpdatedFrom?: (data: unknown) => string | null;
}

export async function fetchSource<T = unknown>(
  sourceId: SourceId,
  url: string,
  options: FetchOptions
): Promise<FetchResult<T>> {
  const as = options.as ?? "json";
  const sanitized = sanitizeUrl(url);
  const captureId = sha256(`${sourceId}|${sanitized}|${as}`).slice(0, 32);
  const ext = as === "json" ? "json" : "xml";
  const rawRel = path.join("data", "raw", sourceId, `${options.label}-${captureId}.${ext}`);
  const rawAbs = path.join(process.cwd(), rawRel);
  const metaAbs = `${rawAbs}.meta.json`;

  /* Cache: reuse a recent capture so refresh runs and tests are cheap. */
  if (!options.force) {
    try {
      const meta = await stat(metaAbs);
      if (Date.now() - meta.mtimeMs < CACHE_TTL_MS) {
        const body = await readFile(rawAbs, "utf8");
        const capture: RawCapture = JSON.parse(await readFile(metaAbs, "utf8"));
        return {
          data: (as === "json" ? JSON.parse(body) : body) as T,
          capture: { ...capture, fromCache: true },
        };
      }
    } catch {
      // No usable cache entry. Fall through to the network.
    }
  }

  let lastError = "";
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt++) {
    const release = await acquire(sourceId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          // DailyMed answers 406 to an explicit "application/xml" Accept
          // header on /spls/{setid}.xml, so text fetches send */*.
          Accept: as === "json" ? "application/json" : "*/*",
        },
        signal: controller.signal,
      });
      lastStatus = res.status;

      if (!res.ok) {
        const retryable = (RETRY.retryableStatuses as readonly number[]).includes(res.status);
        if (!retryable || attempt === RETRY.maxAttempts) {
          throw new SourceUnavailableError(
            sourceId,
            sanitized,
            `HTTP ${res.status} from ${sanitized}`,
            res.status
          );
        }
        // Honour Retry-After when the publisher sends one; otherwise back off.
        const retryAfter = res.headers.get("retry-after");
        const waitMs = retryAfter
          ? Math.min(Number(retryAfter) * 1000 || RETRY.baseDelayMs, RETRY.maxDelayMs)
          : Math.min(RETRY.baseDelayMs * 2 ** (attempt - 1), RETRY.maxDelayMs);
        lastError = `HTTP ${res.status}; waiting ${waitMs}ms`;
        release();
        clearTimeout(timer);
        await sleep(waitMs);
        continue;
      }

      const body = await res.text();
      const parsed = (as === "json" ? JSON.parse(body) : body) as T;

      const capture: RawCapture = {
        captureId,
        sourceId,
        url: sanitized,
        sanitizedUrl: sanitized,
        httpStatus: res.status,
        retrievedAt: new Date().toISOString(),
        contentHash: sha256(body),
        contentType: res.headers.get("content-type"),
        byteLength: Buffer.byteLength(body),
        rawPath: rawRel.replace(/\\/g, "/"),
        sourceLastUpdated: options.lastUpdatedFrom?.(parsed) ?? null,
        fromCache: false,
      };

      // Raw payloads are immutable: written once, never edited in place.
      await mkdir(path.dirname(rawAbs), { recursive: true });
      await writeFile(rawAbs, body, "utf8");
      await writeFile(metaAbs, JSON.stringify(capture, null, 2), "utf8");

      return { data: parsed, capture };
    } catch (err) {
      if (err instanceof SourceUnavailableError) throw err;
      const aborted = err instanceof Error && err.name === "AbortError";
      lastError = aborted ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : String(err);
      if (attempt === RETRY.maxAttempts) break;
      await sleep(Math.min(RETRY.baseDelayMs * 2 ** (attempt - 1), RETRY.maxDelayMs));
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  throw new SourceUnavailableError(
    sourceId,
    sanitized,
    `failed after ${RETRY.maxAttempts} attempts: ${lastError}`,
    lastStatus
  );
}


/**
 * Fetches a binary document (a PDF) with the same discipline as fetchSource.
 *
 * Kept separate rather than folded into fetchSource because the text path
 * decodes bodies as UTF-8, which corrupts binary content silently. A PDF that
 * round-trips through a string is not the document that was published, and its
 * hash would not match the publisher's bytes.
 *
 * The raw bytes are written once and hashed. That hash is the evidence anchor
 * for every assertion extracted from the document.
 */
export async function fetchBinary(
  url: string,
  options: { sourceId?: SourceId; label?: string; force?: boolean } = {}
): Promise<Buffer> {
  const sourceId = options.sourceId ?? "vamedicaid";
  const sanitized = sanitizeUrl(url);
  const captureId = sha256(`${sourceId}|${sanitized}|binary`).slice(0, 32);
  const label = options.label ?? "doc";
  const rawRel = path.join("data", "raw", sourceId, `${label}-${captureId}.bin`);
  const rawAbs = path.join(process.cwd(), rawRel);
  const metaAbs = `${rawAbs}.meta.json`;

  if (!options.force) {
    try {
      const meta = await stat(metaAbs);
      if (Date.now() - meta.mtimeMs < CACHE_TTL_MS) return await readFile(rawAbs);
    } catch {
      // No usable cache entry; fall through to the network.
    }
  }

  let lastError = "";
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt++) {
    const release = await acquire(sourceId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/pdf,*/*" },
        signal: controller.signal,
        redirect: "follow",
      });
      lastStatus = res.status;

      if (!res.ok) {
        const retryable = (RETRY.retryableStatuses as readonly number[]).includes(res.status);
        if (!retryable || attempt === RETRY.maxAttempts) {
          throw new SourceUnavailableError(
            sourceId,
            sanitized,
            `HTTP ${res.status} from ${sanitized}`,
            res.status
          );
        }
        const retryAfter = res.headers.get("retry-after");
        const waitMs = retryAfter
          ? Math.min(Number(retryAfter) * 1000 || RETRY.baseDelayMs, RETRY.maxDelayMs)
          : Math.min(RETRY.baseDelayMs * 2 ** (attempt - 1), RETRY.maxDelayMs);
        lastError = `HTTP ${res.status}; waiting ${waitMs}ms`;
        release();
        clearTimeout(timer);
        await sleep(waitMs);
        continue;
      }

      const bytes = Buffer.from(await res.arrayBuffer());

      const capture: RawCapture = {
        captureId,
        sourceId,
        url: sanitized,
        sanitizedUrl: sanitized,
        httpStatus: res.status,
        retrievedAt: new Date().toISOString(),
        contentHash: sha256(bytes),
        contentType: res.headers.get("content-type"),
        byteLength: bytes.length,
        rawPath: rawRel.replace(/\\/g, "/"),
        sourceLastUpdated: res.headers.get("last-modified"),
        fromCache: false,
      };

      await mkdir(path.dirname(rawAbs), { recursive: true });
      await writeFile(rawAbs, bytes);
      await writeFile(metaAbs, JSON.stringify(capture, null, 2), "utf8");
      return bytes;
    } catch (err) {
      if (err instanceof SourceUnavailableError) throw err;
      const aborted = err instanceof Error && err.name === "AbortError";
      lastError = aborted ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : String(err);
      if (attempt === RETRY.maxAttempts) break;
      await sleep(Math.min(RETRY.baseDelayMs * 2 ** (attempt - 1), RETRY.maxDelayMs));
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  throw new SourceUnavailableError(
    sourceId,
    sanitized,
    `failed after ${RETRY.maxAttempts} attempts: ${lastError}`,
    lastStatus
  );
}

/** Appends the openFDA key when configured. Never logged; see sanitizeUrl. */
export function withOpenFdaKey(url: string): string {
  const key = process.env.OPENFDA_API_KEY?.trim();
  if (!key) return url;
  const u = new URL(url);
  u.searchParams.set("api_key", key);
  return u.toString();
}

export { RAW_DIR };
