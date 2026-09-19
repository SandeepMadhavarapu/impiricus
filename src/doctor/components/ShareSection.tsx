"use client";

import { useState, useCallback } from "react";
import { track } from "@/shared/lib/analytics/client";

/**
 * Sharing.
 *
 * What this does: hands the OS a public URL and lets the OS decide what the
 * options are. On iOS that share sheet includes AirDrop; on Android it can
 * include Quick Share. Those are operating-system capabilities — this page
 * cannot select them, force them, or observe which one was picked.
 *
 * What this deliberately does NOT do:
 *   - claim a share was "delivered" or that a recipient opened it. Resolving
 *     navigator.share only means the sheet closed.
 *   - infer the channel. The Web Share API does not report it.
 *   - simulate device discovery, transfer progress, or nearby devices.
 *   - use Web Bluetooth as a stand-in for AirDrop.
 *
 * Cancelling is a normal outcome and is treated as one.
 */
export function ShareSection({
  slug,
  shareUrl,
  productName,
  originIsConfigured,
}: {
  slug: string;
  shareUrl: string;
  productName: string;
  originIsConfigured: boolean;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [tone, setTone] = useState<"ok" | "neutral">("neutral");
  const [showQr, setShowQr] = useState(false);

  const canWebShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const say = (message: string, nextTone: "ok" | "neutral" = "neutral") => {
    setStatus(message);
    setTone(nextTone);
  };

  const onShare = useCallback(async () => {
    const payload = {
      title: `${productName} — what it is, benefits and risks`,
      text: `Plain-language information about ${productName}, sourced from the FDA-approved label.`,
      url: shareUrl,
    };

    if (!canWebShare) {
      await copyLink("manual");
      return;
    }

    track("share_initiated", { method: "web-share" });
    try {
      // Must be called directly from the user gesture, with no await before it.
      await navigator.share(payload);
      // The sheet closed. That is ALL we know — not that anything was sent.
      say("Sharing options closed. Your device handles delivery from here.");
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError") {
        // Cancelling is normal, not an error.
        track("share_dismissed", { method: "web-share" });
        say("Sharing cancelled.");
        return;
      }
      track("share_fallback_used", { method: "clipboard" });
      await copyLink("web-share");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canWebShare, productName, shareUrl]);

  const copyLink = useCallback(
    async (_from: string) => {
      try {
        await navigator.clipboard.writeText(shareUrl);
        track("share_initiated", { method: "clipboard" });
        say("Link copied. Paste it anywhere to share.", "ok");
      } catch {
        track("share_fallback_used", { method: "manual" });
        say("Could not copy automatically — select the link below and copy it manually.");
      }
    },
    [shareUrl]
  );

  return (
    <section className="share-section" aria-labelledby="share-heading">
      <h2 className="section-title" id="share-heading">
        Share this medication information
      </h2>
      <p className="muted">
        Shares the public page only. Your conversation, coverage details and anything you typed stay
        on this device and are never included.
      </p>

      <div className="btn-row" style={{ marginTop: 14 }}>
        <button type="button" className="btn btn--primary" onClick={onShare}>
          {canWebShare ? "Share medication information" : "Copy link to share"}
        </button>
        <button type="button" className="btn" onClick={() => copyLink("button")}>
          Copy link
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setShowQr((v) => !v);
            if (!showQr) track("qr_shown");
          }}
          aria-expanded={showQr}
          aria-controls="qr-panel"
        >
          {showQr ? "Hide QR code" : "Show QR code"}
        </button>
      </div>

      {/* Status is announced politely rather than as an alert — sharing is not an error path. */}
      <p className="share-status" data-tone={tone} role="status" aria-live="polite">
        {status ?? " "}
      </p>

      {canWebShare ? (
        <p className="tiny">
          Your device decides which options appear — that can include AirDrop on iPhone or Quick
          Share on Android. This page cannot choose the method for you, and it cannot tell whether
          anything was actually sent or opened.
        </p>
      ) : (
        <p className="tiny">
          This browser does not support the system share sheet, so copying the link or scanning the
          QR code works instead.
        </p>
      )}

      {showQr ? (
        <div className="qr-wrap" id="qr-panel">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/qr/${slug}`} alt={`QR code linking to the ${productName} information page`} />
          <p className="tiny" style={{ textAlign: "center" }}>
            Point a phone camera at this code to open the same public page.
          </p>
        </div>
      ) : null}

      <div className="link-box" style={{ marginTop: 12 }}>
        <span>{shareUrl}</span>
      </div>

      {!originIsConfigured ? (
        <p className="tiny" style={{ marginTop: 8, color: "var(--warning-text)" }}>
          Note for the operator: <code>PUBLIC_ORIGIN</code> is not configured, so this link points at
          localhost and will not open on another device. Set it before sharing or deploying.
        </p>
      ) : null}
    </section>
  );
}
