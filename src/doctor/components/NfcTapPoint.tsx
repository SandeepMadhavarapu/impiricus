"use client";
import { useEffect, useRef, useState } from "react";
import { browserSerial, NfcSerialConnection, requestNfcPort } from "@/doctor/lib/nfc/serial";
import { UNSUPPORTED_SERIAL, type NfcTarget } from "@/doctor/lib/nfc/protocol";

export function NfcTapPoint({ target }: { target: NfcTarget | null }) {
  const [supported, setSupported] = useState(false);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Hardware not connected");
  const [verified, setVerified] = useState<string | null>(null);
  const [readback, setReadback] = useState<string | null>(null);
  const connection = useRef<NfcSerialConnection | null>(null);
  const alive = useRef(true);
  const working = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    alive.current = true; setSupported(!!browserSerial());
    return () => { alive.current = false; void connection.current?.close(); };
  }, []);
  // Selection changes preserve the USB connection but discard the previous selection's proof.
  useEffect(() => { setVerified(null); setReadback(null); }, [target?.url]);
  async function connect() {
    if (working.current) return;
    working.current = true; setBusy(true); setMessage("Select the Arduino port…");
    const attempt = ++generation.current;
    try {
      const port = await requestNfcPort();
      if (!alive.current || attempt !== generation.current) return;
      const device = new NfcSerialConnection(port,
        status => { if (alive.current && attempt === generation.current) setMessage(status); },
        reason => { if (alive.current && attempt === generation.current) { connection.current = null; setConnected(false); setVerified(null); setReadback(null); setMessage(reason); } });
      connection.current = device; setMessage("Connecting; waiting for NFC hardware…");
      await device.open();
      if (alive.current && attempt === generation.current) { setConnected(true); setMessage("NFC Hardware Connected"); }
    } catch (error) {
      if (alive.current && attempt === generation.current) setMessage(error instanceof Error && error.name === "NotFoundError" ? "Port selection cancelled." : error instanceof Error ? error.message : "Connection failed.");
    } finally { working.current = false; if (alive.current) setBusy(false); }
  }
  async function operate(readOnly: boolean) {
    const device = connection.current;
    if (!connected || !device || working.current || (!readOnly && !target)) return;
    working.current = true; setBusy(true); setVerified(null); setReadback(null);
    setMessage(readOnly ? "Reading NFC memory…" : "Programming NFC…");
    try {
      const result = readOnly ? await device.readMemory() : await device.program(target!.url);
      if (!alive.current || connection.current !== device) return;
      if (readOnly) { setReadback(result); setMessage("NFC memory read complete."); }
      else { setVerified(result); setMessage("Hardware verification complete."); }
    } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : "Hardware operation failed."); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="card stack" style={{ marginTop: 24 }} aria-labelledby="nfc-heading">
    <p className="step-label">NFC hardware proof of concept</p>
    <h2 className="section-title" id="nfc-heading">NFC Tap Point</h2>
    <p>{connected ? "● NFC Hardware Connected" : "○ Hardware not connected"}</p>
    <p className="tiny">The ST25DV64 is programmed and verified over I2C. An external 13.56 MHz antenna is required for phone tap functionality. Phone tapping has not been tested.</p>
    {target ? <><p>Selected medication: <strong>{target.name}</strong></p><p className="tiny">Patient guide:</p><div className="link-box"><span>{target.url}</span></div></> : <p className="muted">Select a registered medication and configure PUBLIC_ORIGIN with the public HTTPS patient-guide origin to enable programming.</p>}
    {!supported ? <p className="muted">{UNSUPPORTED_SERIAL}</p> : null}
    <div className="btn-row">
      {!connected ? <button className="btn" disabled={!supported || busy} onClick={() => void connect()}>Connect NFC Hardware</button> : <>
        <button className="btn btn--primary" disabled={busy || !target} onClick={() => void operate(false)}>{busy ? "Working…" : verified === target?.url ? "Program Again" : "Program NFC"}</button>
        <button className="btn" disabled={busy} onClick={() => void operate(true)}>Read NFC Memory</button>
        <button className="btn" disabled={busy} onClick={() => void connection.current?.close()}>Disconnect</button>
      </>}
    </div>
    <p role="status" aria-live="polite">{message}</p>
    {verified && verified === target?.url ? <div className="stack"><h3>✓ NFC PROGRAMMED &amp; VERIFIED</h3><p>Medication: {target.name}</p><p>NDEF URI: {verified}</p><p>Hardware verification: ST25DV64 read-back matched the requested URI.</p></div> : null}
    {readback ? <div className="stack"><h3>NFC MEMORY READBACK</h3><div className="link-box"><span>{readback}</span></div><p>Read directly from ST25DV64</p></div> : null}
  </section>;
}
