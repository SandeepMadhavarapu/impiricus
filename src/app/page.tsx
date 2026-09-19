import { redirect } from "next/navigation";
import { DEFAULT_MEDICATION_SLUG } from "@/sources/lib/content/registry";

/**
 * The root path goes straight to the featured medication.
 *
 * There is deliberately no marketing splash. Someone who opens a shared link
 * should see useful medication information immediately.
 */
export default function Home() {
  redirect(`/medications/${DEFAULT_MEDICATION_SLUG}`);
}
