"use client";
import { useEffect, useRef, useState } from "react";
import { requestSession, type ShareSession } from "@/shared/lib/nearby-share/client";
import { prepareTransmitter } from "@/shared/lib/nearby-share/transmitter";

// The doctor flow mounts this only for a registered medication. Nearby sharing
// uses same-origin APIs and an opaque token, not the configured public share URL.
export function NearbyShare({ slug }: { slug: string }) {
  const [session, setSession] = useState<ShareSession | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  async function send(manual = false) {
    cleanup.current?.();
    let active = true;
    const controller = new AbortController();
    let audio: ReturnType<typeof prepareTransmitter> | undefined;
    cleanup.current = () => { active = false; controller.abort(); audio?.close(); };
    setBusy(true); setMessage("Preparing…");
    try {
      if (!manual) audio = prepareTransmitter();
      const current = session && Date.parse(session.expiresAt) > Date.now() + 15000 ? session : await requestSession(slug, controller.signal);
      if (!active) return;
      setSession(current);
      if (manual) { setMessage("Temporary token ready for development testing."); return; }
      setMessage("Sending… Keep both pages open.");
      await audio!.send(current.token);
      if (active) setMessage("Signal sent. Check the patient's screen; delivery is not confirmed.");
    } catch (error) { if (active) setMessage(`${error instanceof Error ? error.message : "Unable to send."} Use Share normally below.`); }
    finally { audio?.close(); if (active) setBusy(false); }
  }
  return <div className="card stack" style={{ marginTop: 16 }}>
    <p className="eyebrow">Send Nearby · Experimental</p><h3>Send with sound</h3>
    <p>Hold the patient’s phone nearby. Open <a href="/receive" target="_blank" rel="noreferrer">MedBridge Receive</a> on that phone and press Listen for guide before sending.</p>
    <p className="tiny">Sound sharing sends a temporary code, not your medical information. Turn up speaker volume. The signal lasts about 11 seconds.</p>
    <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void send()}>{busy ? "Sending…" : session ? "Send again" : "Send Nearby"}</button>
    {busy ? <button className="btn" type="button" onClick={() => { cleanup.current?.(); setBusy(false); setMessage("Sending cancelled."); }}>Cancel</button> : null}
    <p role="status" aria-live="polite">{message}</p>
    {process.env.NODE_ENV === "development" ? <details><summary>Demo / developer tools</summary><button type="button" className="btn" disabled={busy} onClick={() => void send(true)}>Create token without sound</button>{session ? <><p>Expires {session.expiresAt}</p><label>Copy temporary token<input readOnly value={session.token} onFocus={e => e.target.select()} /></label><p><a href={session.receiveUrl}>Open Receive page</a></p></> : null}</details> : null}
  </div>;
}
