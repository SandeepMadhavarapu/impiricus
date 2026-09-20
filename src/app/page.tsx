import { redirect } from "next/navigation";
import { DEFAULT_MEDICATION_SLUG } from "@/sources/lib/content/registry";
import { getAppMode } from "@/shared/lib/config";

/**
 * The root path goes straight to the audience this deployment is for.
 *
 * There is deliberately no marketing splash. Someone who opens a shared link
 * should see useful medication information immediately — and on the doctor
 * demo deployment, someone who opens the bare domain should land straight in
 * the doctor workspace rather than the patient page. Both routes remain
 * reachable directly regardless of mode; this only picks what "/" means. See
 * getAppMode() in src/shared/lib/config.ts.
 */
/**
 * Rendered per request, so the redirect reads the live APP_MODE.
 *
 * Next prerendered this page, which froze the redirect target into the build
 * output: a clinician deployment built without APP_MODE present sent its own
 * home page to the patient medication page and never reached /doctor. It works
 * on a host that exposes the variable at build time and fails silently on one
 * that does not, which is the worst combination to rely on.
 */
export const dynamic = "force-dynamic";

export default function Home() {
  redirect(getAppMode() === "doctor" ? "/doctor" : `/medications/${DEFAULT_MEDICATION_SLUG}`);
}
