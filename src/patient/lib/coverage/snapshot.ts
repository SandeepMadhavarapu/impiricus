import "server-only";
import rawSnapshot from "@/sources/content/coverage/cms-part-d-snapshot.json";
import { FormularySnapshotSchema, type FormularySnapshot } from "./formulary";

/**
 * The committed CMS Part D formulary snapshot.
 *
 * Imported statically, like the plan directory, so the Vercel build bundles
 * it with the route that reads it. The previous version read the file from
 * disk at `process.cwd()/src/...`, which works in `next dev` and is silently
 * absent in a serverless bundle; combined with the file being gitignored, the
 * coverage flow answered "no source connected" on every deployment while
 * genuine evidence sat in the repository.
 *
 * Regenerate with `npm run content:sync`. Never edit by hand.
 *
 * The parse is deferred to first use and cached. A snapshot that fails its
 * schema is treated as ABSENT, not partially trusted: the adapter then
 * reports "unable to verify", which is the honest state when the evidence
 * cannot be read. It must never be interpreted as "not covered".
 */

let cached: FormularySnapshot | null | undefined;

export function loadFormularySnapshot(): FormularySnapshot | null {
  if (cached !== undefined) return cached;
  const parsed = FormularySnapshotSchema.safeParse(rawSnapshot);
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
