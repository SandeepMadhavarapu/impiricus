"use client";

import { useEffect } from "react";
import { track } from "@/shared/lib/analytics/client";

/**
 * Records that a medication page was opened.
 *
 * Note what is NOT recorded: the medication slug. Linking a person to interest
 * in a specific drug is the exact inference this product should not enable, so
 * the event is a bare counter plus a coarse referrer class.
 *
 * The referrer is bucketed into three values rather than passed through, so a
 * full referring URL never reaches the analytics endpoint.
 */
export function PageOpenBeacon() {
  useEffect(() => {
    let kind: "direct" | "qr" | "external" = "direct";
    try {
      if (document.referrer) {
        const ref = new URL(document.referrer);
        kind = ref.origin === window.location.origin ? "direct" : "external";
      }
    } catch {
      kind = "direct";
    }
    track("medication_page_opened", { referrer_kind: kind });
  }, []);

  return null;
}
