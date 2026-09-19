import "server-only";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { FormularySnapshotSchema, type FormularySnapshot } from "./formulary";

/**
 * Loads the ingested CMS formulary snapshot, if an operator has produced one.
 *
 * The snapshot is NOT committed: the CMS source release is ~2.2 GB compressed,
 * and the extracted subset is regenerated with `npm run coverage:ingest`.
 *
 * Absence is a normal, expected state and means exactly one thing — no real
 * formulary data is available, so the coverage flow reports "unable to verify".
 * It must never be interpreted as "not covered", and a malformed snapshot is
 * treated as absent rather than partially trusted.
 */

const SNAPSHOT_PATH = path.join(
  process.cwd(),
  "src",
  "sources",
  "content",
  "coverage",
  "cms-part-d-snapshot.json"
);

let cached: FormularySnapshot | null | undefined;

export function loadFormularySnapshot(): FormularySnapshot | null {
  if (cached !== undefined) return cached;

  try {
    if (!existsSync(SNAPSHOT_PATH)) {
      cached = null;
      return cached;
    }
    const raw: unknown = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    const parsed = FormularySnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      // A snapshot we cannot fully validate is not partially trusted. Half-read
      // coverage data is worse than none.
      console.warn(
        "[coverage] formulary snapshot failed schema validation; ignoring it and reporting unable-to-verify"
      );
      cached = null;
      return cached;
    }
    cached = parsed.data;
    return cached;
  } catch {
    cached = null;
    return cached;
  }
}

/** Test seam. */
export function resetFormularySnapshotCache(): void {
  cached = undefined;
}

export { SNAPSHOT_PATH };
