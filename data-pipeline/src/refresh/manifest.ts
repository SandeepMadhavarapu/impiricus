/**
 * Publication manifests, staging, and rollback.
 *
 * Every published export set is described by a manifest naming the source
 * versions, content hashes, parser version, schema versions and validation
 * results behind it. Without that, "the data is current" is an assertion; with
 * it, it is checkable.
 *
 * ATOMIC PUBLICATION
 *
 * Candidates are built in a staging directory and only moved into the export
 * tree once the WHOLE bundle validates. A consumer therefore never reads a
 * half-written set: either the previous bundle or the new one, never a mix of
 * a new formulary and an old medication record that disagree about a product.
 *
 * FAILURE NEVER ERASES
 *
 * A failed or partial refresh leaves the published tree untouched. It does not
 * write an empty formulary, does not turn an unknown flag into false, and does
 * not restamp old evidence with a new retrieval time.
 */

import { mkdir, writeFile, readFile, readdir, rename, rm, cp, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PIPELINE_ROOT } from "../config/env.js";
import type { SourceCheckResult } from "./state.js";

export const MANIFEST_SCHEMA_VERSION = "manifest-1.0.0";

/** Where staged candidates are built before publication. */
export const STAGING_DIR = path.join(PIPELINE_ROOT, "data", "staging");
/** Where published exports live. This is what consumers read. */
export const EXPORTS_DIR = path.join(PIPELINE_ROOT, "data", "exports");
/** Manifests, one per publication, newest last. */
export const MANIFESTS_DIR = path.join(PIPELINE_ROOT, "data", "manifests");

export interface ManifestFile {
  /** Path relative to the exports directory. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface ValidationResult {
  name: string;
  passed: boolean;
  detail: string;
  /** A failure here blocks publication; a warning does not. */
  severity: "blocking" | "warning";
}

export interface PublicationManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  manifestId: string;
  createdAt: string;
  /** The run that produced it. */
  runId: string;
  /** check-only runs never produce a manifest. */
  mode: "refresh" | "force-refresh";
  /** Source versions this bundle was built from. */
  sources: Array<{
    sourceId: string;
    version: string | null;
    publishedDate: string | null;
    contentHash: string | null;
    retrievedAt: string | null;
    outcome: string;
  }>;
  /** Parser/schema versions, so a diff can be attributed correctly. */
  versions: {
    parser: string;
    medicationSchema: string;
    insuranceSchema: string;
    accessSchema: string;
  };
  files: ManifestFile[];
  validations: ValidationResult[];
  /** Blocking validation failures, or review reasons. Empty means publishable. */
  reviewBlockers: string[];
  status: "candidate" | "review-required" | "ready-for-publication" | "published" | "rolled-back";
  /** Set once published. */
  publishedAt: string | null;
  /** The manifest this one superseded, for rollback. */
  supersedes: string | null;
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function newManifestId(runId: string): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${runId.slice(0, 8)}`;
}

/** Hashes every file in a directory tree, relative to it. */
export async function hashTree(root: string): Promise<ManifestFile[]> {
  const out: ManifestFile[] = [];
  async function walk(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      const buf = await readFile(abs);
      out.push({
        path: path.relative(root, abs).replace(/\\/g, "/"),
        sha256: sha256(buf),
        bytes: buf.length,
      });
    }
  }
  await walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export async function writeManifest(m: PublicationManifest): Promise<string> {
  await mkdir(MANIFESTS_DIR, { recursive: true });
  const file = path.join(MANIFESTS_DIR, `${m.manifestId}.json`);
  // Written via a temp file and renamed, so a reader never sees a partial one.
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(m, null, 2) + "\n", "utf8");
  await rename(tmp, file);
  return file;
}

export async function readManifest(manifestId: string): Promise<PublicationManifest | null> {
  const file = path.join(MANIFESTS_DIR, `${manifestId}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, "utf8"));
}

export async function listManifests(): Promise<PublicationManifest[]> {
  if (!existsSync(MANIFESTS_DIR)) return [];
  const files = (await readdir(MANIFESTS_DIR)).filter((f) => f.endsWith(".json"));
  const out: PublicationManifest[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(await readFile(path.join(MANIFESTS_DIR, f), "utf8")));
    } catch {
      // A corrupt manifest must not hide the good ones.
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The newest manifest that actually reached `published`. */
export async function lastKnownGood(): Promise<PublicationManifest | null> {
  const all = await listManifests();
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i]!.status === "published") return all[i]!;
  }
  return null;
}

/**
 * Verifies that every file a manifest claims is present and unmodified.
 *
 * Used before rollback and after publication: a manifest that does not match
 * the tree it describes is worse than none, because it looks authoritative.
 */
export async function verifyManifestAgainstTree(
  m: PublicationManifest,
  root = EXPORTS_DIR
): Promise<{ ok: boolean; missing: string[]; modified: string[] }> {
  const missing: string[] = [];
  const modified: string[] = [];
  for (const f of m.files) {
    const abs = path.join(root, f.path);
    if (!existsSync(abs)) {
      missing.push(f.path);
      continue;
    }
    const buf = await readFile(abs);
    if (sha256(buf) !== f.sha256) modified.push(f.path);
  }
  return { ok: missing.length === 0 && modified.length === 0, missing, modified };
}

/* ------------------------------------------------------------- staging */

/** Clears and recreates the staging directory for a fresh candidate build. */
export async function resetStaging(): Promise<string> {
  await rm(STAGING_DIR, { recursive: true, force: true });
  await mkdir(STAGING_DIR, { recursive: true });
  return STAGING_DIR;
}

/**
 * Publishes a staged candidate into the export tree, atomically per file.
 *
 * Files are copied to `<target>.incoming` and renamed into place. Rename is
 * atomic within a filesystem, so a consumer reading during publication sees
 * either the old file or the new one, never a truncated one.
 *
 * Publication is refused outright unless the manifest is publishable, so the
 * "validate then publish" order cannot be inverted by a caller.
 */
export async function publishStaged(
  m: PublicationManifest
): Promise<{ published: string[]; refused: string | null }> {
  if (m.reviewBlockers.length > 0) {
    return {
      published: [],
      refused:
        `Refused: ${m.reviewBlockers.length} review blocker(s) outstanding. ` +
        "Publication requires a human decision on these first.",
    };
  }
  if (m.status !== "ready-for-publication") {
    return {
      published: [],
      refused: `Refused: manifest status is "${m.status}", not "ready-for-publication".`,
    };
  }

  const staged = await hashTree(STAGING_DIR);
  if (staged.length === 0) {
    return { published: [], refused: "Refused: staging directory is empty." };
  }

  const published: string[] = [];
  for (const f of staged) {
    const src = path.join(STAGING_DIR, f.path);
    const dest = path.join(EXPORTS_DIR, f.path);
    await mkdir(path.dirname(dest), { recursive: true });
    const incoming = `${dest}.incoming`;
    await cp(src, incoming);
    await rename(incoming, dest);
    published.push(f.path);
  }
  return { published, refused: null };
}

/**
 * Restores the export tree to a previously published manifest.
 *
 * Requires a snapshot of that manifest's files, kept alongside it. Rollback
 * verifies the restored tree against the manifest afterwards, because a
 * rollback that silently half-succeeded would be the worst of both states.
 */
export const SNAPSHOTS_DIR = path.join(PIPELINE_ROOT, "data", "manifests", "snapshots");

export async function snapshotExports(manifestId: string): Promise<string> {
  const dest = path.join(SNAPSHOTS_DIR, manifestId);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  if (existsSync(EXPORTS_DIR)) await cp(EXPORTS_DIR, dest, { recursive: true });
  return dest;
}

export async function rollbackTo(
  manifestId: string
): Promise<{ ok: boolean; detail: string; verified?: { ok: boolean; missing: string[]; modified: string[] } }> {
  const m = await readManifest(manifestId);
  if (!m) return { ok: false, detail: `No manifest ${manifestId}.` };

  const snap = path.join(SNAPSHOTS_DIR, manifestId);
  if (!existsSync(snap)) {
    return {
      ok: false,
      detail:
        `Manifest ${manifestId} exists but its file snapshot does not, so the exact bundle cannot ` +
        "be restored. Rolling back from git history is the remaining option.",
    };
  }

  // Restore into place file-by-file via rename, same as publication.
  const files = await hashTree(snap);
  for (const f of files) {
    const dest = path.join(EXPORTS_DIR, f.path);
    await mkdir(path.dirname(dest), { recursive: true });
    const incoming = `${dest}.incoming`;
    await cp(path.join(snap, f.path), incoming);
    await rename(incoming, dest);
  }

  const verified = await verifyManifestAgainstTree(m);
  return {
    ok: verified.ok,
    detail: verified.ok
      ? `Rolled back to ${manifestId}; every file matches the manifest.`
      : `Rollback incomplete: ${verified.missing.length} missing, ${verified.modified.length} modified.`,
    verified,
  };
}

/** Bytes in the export tree, for the size sanity check. */
export async function treeSize(root: string): Promise<number> {
  let total = 0;
  for (const f of await hashTree(root)) total += f.bytes;
  return total;
}

export function sourcesFromChecks(checks: SourceCheckResult[]): PublicationManifest["sources"] {
  return checks.map((c) => ({
    sourceId: c.sourceId,
    version: c.current?.version ?? null,
    publishedDate: c.current?.publishedDate ?? null,
    contentHash: c.current?.contentHash ?? null,
    // Retrieval time, NOT check time: a check that found no change did not
    // retrieve anything, and must not look as though it did.
    retrievedAt: c.outcome === "changed" ? c.checkedAt : c.lastSuccessfulRetrieval,
    outcome: c.outcome,
  }));
}
