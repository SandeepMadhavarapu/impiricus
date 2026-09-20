"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Optional read-aloud for patient narrative text.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT READS
 * ---------------------------------------------------------------------------
 * In English, exactly the text already on the screen, passed in by the caller.
 * Nothing is rewritten for speech and no model is involved: a spoken version
 * that has been reworded is a different text from the one a clinician
 * reviewed, and the reader has no way to tell which they heard.
 *
 * In another language it reads a stored translation of that same text, which
 * is DISPLAYED as well as spoken so the listener can see the words they are
 * hearing. Nothing is translated at request time - the translations are
 * committed data with provenance, so what is spoken is reviewable before it
 * ships rather than generated fresh for each listener.
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
 * A translation here is machine output that no clinician has reviewed, and the
 * control says so in the language being offered rather than only in English -
 * a warning about an unreviewed Spanish translation is not much use to someone
 * who is choosing Spanish because they do not read English.
 *
 * No microphone, no recording, no transcription. This is output only.
 */

type Status = "idle" | "speaking" | "unsupported" | "error";

/** One language this text can be heard in. */
export interface ReadAloudTranslation {
  /** Content locale, e.g. "es". */
  locale: string;
  /** Endonym for the control, e.g. "Español". */
  name: string;
  /** BCP-47 tag to speak it with, e.g. "es-ES". */
  speechTag: string;
  /** The translated text, shown and spoken. */
  text: string;
  /** True when no person produced it. Drives the notice below. */
  machineTranslated: boolean;
  /** True only when a named clinician reviewed it. */
  reviewed: boolean;
}

interface Props {
  /** The exact visible English text to speak, in reading order. */
  text: string;
  /** BCP-47 tag of the language `text` is actually written in. */
  lang: string;
  /** Names the content, e.g. "this summary". */
  label: string;
  /** Other languages this text exists in. Omitted or empty means English only. */
  translations?: readonly ReadAloudTranslation[];
}

/**
 * The notice shown under an unreviewed translation, IN that language.
 *
 * Written per language rather than translated at runtime, and kept short
 * enough to read at a glance. Someone selecting Spanish because they do not
 * read English cannot be warned in English.
 */
const UNREVIEWED_NOTICE: Readonly<Record<string, string>> = {
  es: "Traducción automática. Ningún profesional clínico la ha revisado. El texto en inglés de arriba es el texto revisado.",
  fr: "Traduction automatique. Aucun professionnel de santé ne l'a vérifiée. Le texte anglais ci-dessus est le texte vérifié.",
};

/** Fallback for a language with no notice written for it yet. */
const UNREVIEWED_NOTICE_EN =
  "Machine translation. No clinician has reviewed it. The English above is the reviewed text.";

/** "No voice installed" warning, in the language being offered. */
const NO_VOICE_NOTICE: Readonly<Record<string, string>> = {
  es: "Este navegador no tiene una voz en español instalada, así que puede sonar con acento inglés.",
  fr: "Ce navigateur n'a pas de voix française installée, la lecture peut donc avoir un accent anglais.",
};

const NO_VOICE_NOTICE_EN =
  "This browser has no voice installed for that language, so it may be read with an English voice.";

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
 * The terminators include the Spanish opening marks so "¿...?" and "¡...!" do
 * not swallow the following sentence into one over-long utterance.
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
 * than a default accent - but the caller warns first, because a French summary
 * read by an English voice is close to unintelligible.
 */
function pickVoice(lang: string): SpeechSynthesisVoice | null {
  if (!speechAvailable()) return null;
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

export function ReadAloud({ text, lang, label, translations = [] }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  /** Selected content locale. Empty string means the English original. */
  const [locale, setLocale] = useState("");
  /**
   * Bumped when the engine reports new voices, so the "no voice installed"
   * warning re-evaluates. getVoices() is commonly empty on first call.
   */
  const [voicesVersion, setVoicesVersion] = useState(0);

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

  /** The chosen translation, or null for the English original. */
  const chosen = useMemo(
    () => translations.find((t) => t.locale === locale) ?? null,
    [translations, locale]
  );
  const spokenText = chosen ? chosen.text : text;
  const spokenTag = chosen ? chosen.speechTag : lang;

  const stop = useCallback(() => {
    runRef.current += 1;
    if (speechAvailable()) window.speechSynthesis.cancel();
    setStatus("idle");
  }, []);

  /*
   * Stop on unmount, and whenever the spoken text or its language changes.
   *
   * The text changing means the product, or the chosen language, changed.
   * Speech that carries on across that is speech about the previous medicine,
   * or in the language the reader just moved away from. The speechSynthesis
   * queue is global to the page, so nothing else stops it.
   */
  useEffect(() => {
    return () => {
      runRef.current += 1;
      if (speechAvailable()) window.speechSynthesis.cancel();
    };
  }, [spokenText, spokenTag]);

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

  /*
   * Voices can arrive after the first attempt. Re-reading the list keeps a
   * later press using a real voice, and re-renders the availability warning,
   * without restarting anything on its own.
   */
  useEffect(() => {
    if (!speechAvailable()) return;
    const onVoices = () => setVoicesVersion((n) => n + 1);
    window.speechSynthesis.addEventListener?.("voiceschanged", onVoices);
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", onVoices);
  }, []);

  /**
   * Whether a voice exists for the chosen language.
   *
   * Only reported once voices have actually loaded: an empty list on first
   * render means "not yet known", and warning then would show a scary message
   * that disappears a moment later.
   */
  const voiceMissing = useMemo(() => {
    void voicesVersion;
    if (!chosen || !speechAvailable()) return false;
    if (window.speechSynthesis.getVoices().length === 0) return false;
    return pickVoice(chosen.speechTag) === null;
  }, [chosen, voicesVersion]);

  const speak = useCallback(() => {
    if (!speechAvailable()) {
      setStatus("unsupported");
      return;
    }
    const spoken = spokenText.trim();
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
    const voice = pickVoice(spokenTag);
    const sentences = splitIntoSentences(spoken);
    let remaining = sentences.length;

    const finish = () => {
      // A callback from a run that has been replaced must not touch the button.
      if (runRef.current === run) setStatus("idle");
    };

    for (const sentence of sentences) {
      const utterance = new SpeechSynthesisUtterance(sentence);
      utterance.lang = spokenTag;
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
  }, [spokenText, spokenTag]);

  /** Switching language stops whatever is playing; it is now the wrong text. */
  const chooseLocale = useCallback(
    (next: string) => {
      stop();
      setLocale(next);
    },
    [stop]
  );

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
  const showPicker = translations.length > 0;
  const unreviewed = chosen !== null && !chosen.reviewed;

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          className="btn btn--small read-aloud"
          onClick={speaking ? stop : speak}
          aria-pressed={speaking}
        >
          {speaking ? "Stop reading" : `Read ${label} aloud`}
        </button>

        {showPicker ? (
          <>
            {/*
              Labelled "Read aloud in", not "Language": it changes what is
              SPOKEN, and the page around it stays English. A control labelled
              "Language" would promise a translated page.
            */}
            <label htmlFor="read-aloud-lang" className="tiny">
              Read aloud in
            </label>
            <select
              id="read-aloud-lang"
              className="read-aloud-lang"
              value={locale}
              onChange={(e) => chooseLocale(e.target.value)}
            >
              <option value="">English</option>
              {translations.map((t) => (
                <option key={t.locale} value={t.locale}>
                  {t.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>

      {/*
        Polite, so it does not interrupt a screen reader mid-sentence, and
        keyed to real state rather than to the press - if speech fails, this
        says so instead of claiming it is playing.
      */}
      <span aria-live="polite" className="tiny" style={{ marginLeft: 2 }}>
        {status === "speaking" ? "Reading aloud." : null}
        {status === "error" ? "Read aloud stopped unexpectedly. The text above is unchanged." : null}
      </span>

      {chosen ? (
        <div className="read-aloud-translation" style={{ marginTop: 10 }}>
          {/*
            The translated words are SHOWN, not just spoken. A listener who
            cannot check what they heard against anything has to take it on
            trust, and this text is explicitly untrusted.
          */}
          <p lang={chosen.speechTag} style={{ fontSize: 15 }}>
            {chosen.text}
          </p>
          {unreviewed ? (
            <p className="tiny" lang={chosen.speechTag}>
              {UNREVIEWED_NOTICE[chosen.locale] ?? UNREVIEWED_NOTICE_EN}
            </p>
          ) : null}
          {voiceMissing ? (
            <p className="tiny" lang={chosen.speechTag}>
              {NO_VOICE_NOTICE[chosen.locale] ?? NO_VOICE_NOTICE_EN}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
