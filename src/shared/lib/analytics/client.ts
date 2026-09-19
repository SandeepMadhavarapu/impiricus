"use client";

import type { AnalyticsEvent } from "./events";

/**
 * Client-side event reporting.
 *
 * Fire-and-forget, never blocks the UI, and silently does nothing if the
 * endpoint is unavailable. Only the event name and an allow-listed property
 * bag are sent — never message text, coverage inputs, or the medication slug.
 */
export function track(event: AnalyticsEvent, properties: Record<string, string> = {}): void {
  try {
    const body = JSON.stringify({ event, properties });
    // sendBeacon survives page navigation, which matters for share events.
    if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
      navigator.sendBeacon("/api/analytics", new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch("/api/analytics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Measurement must never break the experience.
  }
}
