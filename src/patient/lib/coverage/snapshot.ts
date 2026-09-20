import "server-only";
import snapshotData from "@/sources/content/coverage/cms-part-d-snapshot.json";
import { FormularySnapshotSchema, type FormularySnapshot } from "./formulary";

/**
 * Loads the vendored CMS Part D formulary snapshot.
 *
 * WHY THIS IS A STATIC IMPORT AND NOT readFileSync
 * ------------------------------------------------
 * This module used to read the file from `process.cwd()` at request time. That
 * works locally and fails silently in production: Next.js traces the files a
 * serverless function needs by following its imports, so a path assembled at
 * runtime is never traced, never bundled, and `existsSync` returns false on the
 * deployed function. The coverage flow then reports "unable to verify" for
 * every request while the file sits happily in the repository.
 *
 * The plan directory next door (`@/sources/content/insurance/plans.json`) has
 * always been imported for exactly this reason. This now matches it: the
 * snapshot is committed, it is imported, and a missing file breaks the build
 * loudly instead of quietly disabling the feature in production.
 *
 * Regenerate with `npm run content:sync` (after `npm run app:snapshot` in
 * data-pipeline). Never edit it by hand.
 *
 * WHAT ABSENCE AND INVALIDITY STILL MEAN
 * --------------------------------------
 * A snapshot that does not validate is treated as absent rather than partially
 * trusted, and absence means exactly one thing: no formulary data was
 * consulted, so the flow reports "unable to verify". It must NEVER be read as
 * "not covered". Half-read coverage data is worse than none.
 */

let cached: FormularySnapshot | null | undefined;

export function loadFormularySnapshot(): FormularySnapshot | null {
  if (cached !== undefined) return cached;

  const parsed = FormularySnapshotSchema.safeParse(snapshotData);
  if (!parsed.success) {
    console.warn(
      "[coverage] formulary snapshot failed schema validation; ignoring it and reporting unable-to-verify"
    );
    cached = null;
    return cached;
  }
  cached = parsed.data;
  return cached;
}

/** Test seam. */
export function resetFormularySnapshotCache(): void {
  cached = undefined;
}
