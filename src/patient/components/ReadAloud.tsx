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

/**
 * One utterance per sentence.
 *
 * Chrome stops a long utterance after roughly 15 seconds. The Singulair
 * summary measured 85 words - about 34 seconds - so as a single utterance it
 * was cut off partway through, and the key points come LAST. The boxed warning
 * is a key point. A medication summary that stops speaking before the warning
 * is worse than one that never started.
 *
 * Queueing sentence by sentence keeps the whole text audible on every engine.
 */
function splitIntoSentences(text: string): string[] {
  const parts = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [text.trim()];
}

/**
 * Best installed voice for a tag: exact region, then same language.
 *
 * Returns null when nothing matches, and the platform default then speaks for
 * `utterance.lang`. Refusing to start because no voice matched would be worse
 * than a default accent.
 */
function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  const wanted = lang.replace("_", "-").toLowerCase();
  const base = wanted.split("-")[0] ?? wanted;
  const norm = (v: SpeechSynthesisVoice) => v.lang.replace("_", "-").toLowerCase();

  const exact = voices.filter((v) => norm(v) === wanted);
  const sameLanguage = voices.filter((v) => norm(v) === base || norm(v).startsWith(`${base}-`));
  const pool = exact.length > 0 ? exact : sameLanguage;
  if (pool.length === 0) return null;
  return pool.find((v) => v.default) ?? pool[0] ?? null;
}

export function ReadAloud({ text, lang, label }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  /**
   * Identifies the current playback.
   *
   * A cancelled run's utterances still fire their callbacks, and with several
   * queued sentences there can be a handful in flight. Comparing against this
   * counter makes a stale callback a no-op rather than something that resets
   * the button under a read that has already been replaced.
   */
  const runRef = useRef(0);

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
    runRef.current += 1;
    if (speechAvailable()) window.speechSynthesis.cancel();
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
      runRef.current += 1;
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

    const synth = window.speechSynthesis;

    // Always clear the queue first. Tapping twice must not layer two voices
    // reading different sentences over each other.
    synth.cancel();
    runRef.current += 1;
    const run = runRef.current;

    /*
     * Voices load asynchronously and are often empty on the first call. A
     * matching voice is preferred but never required: with none, the platform
     * default still speaks for `utterance.lang`, which beats refusing to start.
     */
    const voice = pickVoice(lang);
    const sentences = splitIntoSentences(spoken);
    let remaining = sentences.length;

    const finish = () => {
      // A callback from a run that has been replaced must not touch the button.
      if (runRef.current === run) setStatus("idle");
    };

    for (const sentence of sentences) {
      const utterance = new SpeechSynthesisUtterance(sentence);
      utterance.lang = lang;
      if (voice) utterance.voice = voice;

      utterance.onend = () => {
        remaining -= 1;
        if (remaining <= 0) finish();
      };
      utterance.onerror = (event) => {
        // A cancel we asked for surfaces as an error event too. Reporting that
        // as a failure would make every Stop press look broken.
        if (
          runRef.current === run &&
          event.error !== "canceled" &&
          event.error !== "interrupted"
        ) {
          setStatus("error");
          return;
        }
        finish();
      };
      synth.speak(utterance);
    }

    /*
     * Chrome and Safari sometimes leave the engine paused after a cancel(), so
     * the NEXT press queues utterances that never sound. Silence with the
     * button showing "Stop reading" is the worst of both.
     */
    if (synth.paused) synth.resume();

    setStatus("speaking");
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
