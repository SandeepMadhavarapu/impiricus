"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { listenForToken } from "@/shared/lib/nearby-share/receiver";
import { resolveToken, type ReceivedGuide } from "@/shared/lib/nearby-share/client";

export function ReceiveGuide() {
  const [listening, setListening] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  const [token, setToken] = useState("");
  const [guide, setGuide] = useState<ReceivedGuide | null>(null);
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const cancel = () => { stop.current?.(); request.current?.abort(); setListening(false); };
    const hidden = () => { if (document.hidden) { cancel(); setMessage("Listening stopped. Keep this page open and try again."); } };
    document.addEventListener("visibilitychange", hidden);
    return () => { stop.current?.(); request.current?.abort(); document.removeEventListener("visibilitychange", hidden); };
  }, []);
  function listen() {
    stop.current?.(); request.current?.abort(); setGuide(null); setListening(true); setMessage("Listening for your guide… Keep this phone near your provider’s device.");
    stop.current = listenForToken(value => { setListening(false); void resolve(value); }, error => { setListening(false); setMessage(error); });
  }
  async function resolve(value: string) {
    stop.current?.(); setListening(false);
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setMessage("Verifying guide…"); setGuide(null);
    try { const result = await resolveToken(value, controller.signal); if (!controller.signal.aborted) { setGuide(result); setMessage("Medication guide received"); } }
    catch (error) { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Unable to connect. Try again."); }
  }
  return <section className="card stack">
    <h1>Receive medication guide</h1>
    <p>Your provider can send a medication guide to this device using nearby sound.</p>
    {listening ? <button className="btn" onClick={() => { stop.current?.(); setListening(false); setMessage("Listening cancelled."); }}>Cancel</button> : <button className="btn btn--primary" onClick={listen}>{message && !guide ? "Try again — Listen for guide" : "Listen for guide"}</button>}
    <p className="tiny">Audio is processed on this device and is not recorded or uploaded. Microphone access is used only while listening.</p>
    <p className="tiny">If sound sharing is unavailable, ask your provider to use Share normally, AirDrop, Messages, or Copy Link.</p>
    <p role="status" aria-live="polite">{message}</p>
    {guide ? <div className="stack"><h2>Medication guide received</h2><p>{guide.label}</p><Link className="btn btn--primary" href={guide.path}>Open medication guide</Link></div> : null}
    {process.env.NODE_ENV === "development" ? <details><summary>Demo / developer tools</summary><form onSubmit={e => { e.preventDefault(); void resolve(token.trim()); }} className="stack"><label>Temporary token<input value={token} onChange={e => setToken(e.target.value)} autoComplete="off" /></label><button className="btn" type="submit">Resolve token</button></form></details> : null}
  </section>;
}
