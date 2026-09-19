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
export default function Home() {
  redirect(getAppMode() === "doctor" ? "/doctor" : `/medications/${DEFAULT_MEDICATION_SLUG}`);
}
