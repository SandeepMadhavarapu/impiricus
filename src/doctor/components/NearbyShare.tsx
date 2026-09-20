"use client";
import { useEffect, useRef, useState } from "react";
import { requestSession, type ShareSession } from "@/shared/lib/nearby-share/client";
import { SOUND_SECONDS } from "@/shared/lib/nearby-share/protocol";
import { prepareTransmitter } from "@/shared/lib/nearby-share/transmitter";

export function NearbyShare({ slug }: { slug: string }) {
  const [session, setSession] = useState<ShareSession | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const audio = useRef<ReturnType<typeof prepareTransmitter> | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; request.current?.abort(); audio.current?.close(); }, []);

  async function prepare(manual = false) {
    const run = ++generation.current;
    request.current?.abort(); audio.current?.close(); audio.current = null;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setPrepared(false); setMessage("Preparing sound…");
    try {
      const current = await requestSession(slug, controller.signal);
      if (controller.signal.aborted) return;
      setSession(current);
      if (manual) { setMessage("Temporary token ready for development testing."); return; }
      audio.current = prepareTransmitter(current.token);
      setPrepared(true);
      setMessage("Sound ready. When the patient is listening, tap Play sound.");
    } catch (error) {
      if (!controller.signal.aborted) setMessage(`${error instanceof Error ? error.message : "Unable to prepare sound."} Use Share normally below.`);
    } finally { if (generation.current === run) setBusy(false); }
  }
  async function play() {
    if (!audio.current || !session) return;
    if (Date.parse(session.expiresAt) <= Date.now() + (SOUND_SECONDS + 10) * 1000) {
      audio.current.close(); audio.current = null; setPrepared(false);
      setMessage("This sound expired. Press Send Nearby to prepare a new one."); return;
    }
    const run = ++generation.current;
    setBusy(true); setMessage("Starting playback…");
    try {
      await audio.current.play(() => { if (generation.current === run) setMessage("Playing sound… Keep both devices close and both pages open."); });
      if (generation.current === run) setMessage("Playback finished. Check the patient’s screen; receipt is not confirmed. If you heard nothing, check media volume and disconnect headphones or Bluetooth speakers.");
    } catch (error) {
      if (generation.current === run) setMessage(error instanceof Error ? error.message : "Unable to play sound.");
    } finally { if (generation.current === run) setBusy(false); }
  }
  function cancel() {
    generation.current++; request.current?.abort(); audio.current?.close(); audio.current = null;
    setBusy(false); setPrepared(false); setMessage("Sending cancelled.");
  }
  return <div className="card stack" style={{ marginTop: 16 }}>
    <p className="eyebrow">Send Nearby · Experimental</p><h3>Send with sound</h3>
    <p>On the patient’s phone, open <a href="/receive" target="_blank" rel="noreferrer">MediZ Receive</a> and press Listen for guide. Wait until their screen says “Microphone ready.” Here, press Send Nearby to prepare, then Play sound.</p>
    <p className="tiny">Use two devices. Turn up media volume and disconnect headphones or Bluetooth speakers. Keep both screens open. The sound repeats automatically for about 35 seconds to recover from interference. It contains a temporary code, not medical information. Stop once the patient receives the guide.</p>
    <button type="button" className="btn btn--primary" disabled={busy} onClick={() => { if (prepared) void play(); else void prepare(); }}>{busy ? "Sending…" : prepared ? "Play sound" : "Send Nearby"}</button>
    {busy ? <button className="btn" type="button" onClick={cancel}>Cancel</button> : null}
    <p role="status" aria-live="polite">{message}</p>
    {process.env.NODE_ENV === "development" ? <details><summary>Demo / developer tools</summary><button type="button" className="btn" disabled={busy} onClick={() => void prepare(true)}>Create token without sound</button>{session ? <><p>Expires {session.expiresAt}</p><label>Copy temporary token<input readOnly value={session.token} onFocus={e => e.target.select()} /></label><p><a href={session.receiveUrl}>Open Receive page</a></p></> : null}</details> : null}
  </div>;
}
