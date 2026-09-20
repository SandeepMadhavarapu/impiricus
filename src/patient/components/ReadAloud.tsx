"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Optional read-aloud for patient narrative text.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT READS
 * ---------------------------------------------------------------------------
 * Exactly the text already on the screen, passed in by the caller. Nothing is
 * rewritten for speech, and no model is involved: a spoken version that has
 * been reworded is a different text from the one a clinician reviewed, and the
 * reader has no way to tell which they heard.
 *
 * It is deliberately pointed at short narrative content - the summary and key
 * points. Professional labeling and dosage tables are not read: a table
 * flattened into a sentence stops being a table, and "10 mg once daily in the
 * evening" read out of its row loses the row's conditions.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT CLAIMED
 * ---------------------------------------------------------------------------
 * Browser speech is NOT necessarily on-device. Several platforms synthesise
 * server-side, so this makes no privacy claim about where the words go. The
 * text being read is public medication information either way.
 *
 * No microphone, no recording, no transcription. This is output only.
 */

type Status = "idle" | "speaking" | "unsupported" | "error";

interface Props {
  /** The exact visible text to speak, in reading order. */
  text: string;
  /** BCP-47 tag of the language the text is actually written in. */
  lang: string;
  /** Names the content, e.g. "the summary of Singulair". */
  label: string;
}

/** Feature detection, deferred to the client so SSR never touches it. */
function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

export function ReadAloud({ text, lang, label }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  /** Guards against a late voiceschanged event resuming a cancelled read. */
  const cancelledRef = useRef(false);

  /*
   * Support is resolved after mount, never during render.
   *
   * Deciding during render would make the server and the client disagree about
   * whether the button exists, and hydration would swap it under the reader.
   */
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    setSupported(speechAvailable());
  }, []);

  const stop = useCallback(() => {
    cancelledRef.current = true;
    if (speechAvailable()) window.speechSynthesis.cancel();
    utteranceRef.current = null;
    setStatus("idle");
  }, []);

  /*
   * Stop on unmount, and whenever the text or language changes.
   *
   * The text changing means the product or the language changed, and speech
   * that carries on across that is speech about the previous medicine. The
   * speechSynthesis queue is global to the page, so nothing else stops it.
   */
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (speechAvailable()) window.speechSynthesis.cancel();
    };
  }, [text, lang]);

  /* The same problem on navigation, which does not always unmount in an SPA. */
  useEffect(() => {
    const onLeave = () => {
      if (speechAvailable()) window.speechSynthesis.cancel();
    };
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, []);

  const speak = useCallback(() => {
    if (!speechAvailable()) {
      setStatus("unsupported");
      return;
    }
    const spoken = text.trim();
    if (spoken.length === 0) return;

    // Always clear the queue first. Tapping twice must not layer two voices
    // reading different sentences over each other.
    window.speechSynthesis.cancel();
    cancelledRef.current = false;

    const utterance = new SpeechSynthesisUtterance(spoken);
    utterance.lang = lang;

    /*
     * Voices load asynchronously and are often empty on the first call.
     * A matching voice is preferred but never required: with none, the
     * platform default still speaks, which is better than refusing to start.
     */
    const voices = window.speechSynthesis.getVoices();
    const match = voices.find((v) => v.lang?.toLowerCase().startsWith(lang.toLowerCase().slice(0, 2)));
    if (match) utterance.voice = match;

    utterance.onend = () => {
      utteranceRef.current = null;
      setStatus("idle");
    };
    utterance.onerror = (event) => {
      utteranceRef.current = null;
      // A cancel we asked for surfaces as an error event too. That is not a
      // failure, and reporting it as one would make every stop look broken.
      setStatus(cancelledRef.current || event.error === "canceled" || event.error === "interrupted" ? "idle" : "error");
    };

    utteranceRef.current = utterance;
    setStatus("speaking");
    window.speechSynthesis.speak(utterance);
  }, [text, lang]);

  /*
   * Voices can arrive after the first attempt. Re-reading the list keeps a
   * later press using a real voice, without restarting anything on its own.
   */
  useEffect(() => {
    if (!speechAvailable()) return;
    const onVoices = () => void window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener?.("voiceschanged", onVoices);
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", onVoices);
  }, []);

  // Before detection resolves, render nothing rather than a control that might
  // be about to disappear.
  if (supported === null) return null;

  if (supported === false) {
    return (
      <p className="tiny" style={{ marginTop: 10 }}>
        Read aloud is not available in this browser. The text above is unchanged.
      </p>
    );
  }

  const speaking = status === "speaking";

  return (
    <div style={{ marginTop: 10 }}>
      <button
        type="button"
        className="btn btn--small read-aloud"
        onClick={speaking ? stop : speak}
        aria-pressed={speaking}
      >
        {speaking ? "Stop reading" : `Read ${label} aloud`}
      </button>

      {/*
        Polite, so it does not interrupt a screen reader mid-sentence, and
        keyed to real state rather than to the press - if speech fails, this
        says so instead of claiming it is playing.
      */}
      <span aria-live="polite" className="tiny" style={{ marginLeft: 10 }}>
        {status === "speaking" ? "Reading aloud." : null}
        {status === "error" ? "Read aloud stopped unexpectedly. The text above is unchanged." : null}
      </span>
    </div>
  );
}
