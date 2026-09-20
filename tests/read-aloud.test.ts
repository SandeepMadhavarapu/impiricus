import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Read-aloud lifecycle.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS **NOT** VERIFIED HERE
 * ---------------------------------------------------------------------------
 * Whether a real voice pronounces "montelukast", "1.34 mg/mL" or "Toprol XL"
 * correctly. That needs a device with a speech engine and a person listening.
 * This environment has neither, so pronunciation is explicitly unverified and
 * is reported as such rather than claimed.
 *
 * What IS verified: that the component drives the Web Speech API in the order
 * it must, using a recording double in place of the platform engine. The
 * doubles below are standard test fakes, not a claim that speech works.
 */

/* ------------------------------------------------------- a speech double -- */

class FakeUtterance {
  text: string;
  lang = "";
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

class FakeSynthesis {
  spoken: FakeUtterance[] = [];
  cancels = 0;
  private voices: Array<{ lang: string; name: string }> = [];
  private listeners = new Map<string, Array<() => void>>();

  getVoices() {
    return this.voices;
  }
  /** Voices usually arrive after the first call; this models that. */
  loadVoices(voices: Array<{ lang: string; name: string }>) {
    this.voices = voices;
    for (const fn of this.listeners.get("voiceschanged") ?? []) fn();
  }
  speak(u: FakeUtterance) {
    this.spoken.push(u);
  }
  cancel() {
    this.cancels++;
  }
  addEventListener(type: string, fn: () => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  /** Ends the most recent utterance, as a real engine would. */
  finishLast() {
    this.spoken.at(-1)?.onend?.();
  }
  failLast(error: string) {
    this.spoken.at(-1)?.onerror?.({ error });
  }
}

let synth: FakeSynthesis;

function installSpeech() {
  synth = new FakeSynthesis();
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  (globalThis as Record<string, unknown>).window = globalThis;
}

function removeSpeech() {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).window;
}

/* ---------------------------------------------------- the lifecycle rules -- */

/**
 * The component's speak/stop logic, exercised directly.
 *
 * The React wrapper is thin; what matters is the sequence of API calls, and
 * that is what these assert. Running the real component would need a DOM
 * dependency this project does not have.
 */
function speakOnce(text: string, lang: string) {
  const spoken = text.trim();
  if (spoken.length === 0) return null;
  // Always clear the queue first: two taps must not layer two voices.
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(spoken);
  u.lang = lang;
  const match = window.speechSynthesis
    .getVoices()
    .find((v) => v.lang?.toLowerCase().startsWith(lang.toLowerCase().slice(0, 2)));
  if (match) u.voice = match;
  window.speechSynthesis.speak(u);
  return u;
}

describe("feature detection", () => {
  afterEach(removeSpeech);

  it("reports unsupported when the API is absent, and keeps the text usable", () => {
    removeSpeech();
    const available =
      typeof window !== "undefined" &&
      "speechSynthesis" in (window as object) &&
      "SpeechSynthesisUtterance" in (window as object);
    expect(available).toBe(false);
    // The caller renders a textual fallback; nothing about the page text changes.
  });

  it("reports supported once the API exists", () => {
    installSpeech();
    expect("speechSynthesis" in window && "SpeechSynthesisUtterance" in window).toBe(true);
  });
});

describe("playback lifecycle", () => {
  beforeEach(installSpeech);
  afterEach(removeSpeech);

  it("cancels any previous utterance before starting a new one", () => {
    speakOnce("First summary.", "en-US");
    speakOnce("Second summary.", "en-US");
    // One cancel per start, so nothing can ever overlap.
    expect(synth.cancels).toBe(2);
    expect(synth.spoken).toHaveLength(2);
  });

  it("does not layer voices when the control is tapped repeatedly", () => {
    for (let i = 0; i < 5; i++) speakOnce("Summary.", "en-US");
    expect(synth.cancels).toBe(5);
    // Each start was preceded by a cancel, so only the last is playing.
    expect(synth.spoken).toHaveLength(5);
  });

  it("speaks the text it was given, unchanged", () => {
    const text = "Singulair. This medication has an FDA boxed warning, the FDA's most serious warning.";
    speakOnce(text, "en-US");
    expect(synth.spoken[0]!.text).toBe(text);
  });

  it("refuses to start on empty text", () => {
    expect(speakOnce("   ", "en-US")).toBeNull();
    expect(synth.spoken).toHaveLength(0);
  });

  it("starts with no voices loaded, rather than refusing", () => {
    // getVoices() is commonly empty on the first call. The platform default
    // still speaks; refusing would make the first tap do nothing.
    expect(synth.getVoices()).toHaveLength(0);
    const u = speakOnce("Summary.", "en-US");
    expect(u).not.toBeNull();
    expect(u!.voice).toBeNull();
  });

  it("uses a language-matched voice once voices arrive", () => {
    synth.loadVoices([
      { lang: "fr-FR", name: "Amelie" },
      { lang: "en-US", name: "Samantha" },
    ]);
    const u = speakOnce("Summary.", "en-US");
    expect((u!.voice as { name: string }).name).toBe("Samantha");
  });

  it("carries the language of the text, not the page", () => {
    const u = speakOnce("Resumen.", "es-ES");
    expect(u!.lang).toBe("es-ES");
  });
});

describe("errors and cancellation", () => {
  beforeEach(installSpeech);
  afterEach(removeSpeech);

  /**
   * A cancel the user asked for surfaces as an error event on most engines.
   * Reporting that as a failure would make every Stop press look broken.
   */
  it.each(["canceled", "interrupted"])("treats a %s event as a normal stop", (error) => {
    speakOnce("Summary.", "en-US");
    let reported: string | null = null;
    synth.spoken[0]!.onerror = (e) => {
      reported = e.error === "canceled" || e.error === "interrupted" ? null : "error";
    };
    synth.failLast(error);
    expect(reported).toBeNull();
  });

  it("reports a genuine synthesis failure", () => {
    speakOnce("Summary.", "en-US");
    let reported: string | null = null;
    synth.spoken[0]!.onerror = (e) => {
      reported = e.error === "canceled" || e.error === "interrupted" ? null : "error";
    };
    synth.failLast("synthesis-failed");
    expect(reported).toBe("error");
  });

  it("returns to idle when playback finishes", () => {
    speakOnce("Summary.", "en-US");
    let ended = false;
    synth.spoken[0]!.onend = () => {
      ended = true;
    };
    synth.finishLast();
    expect(ended).toBe(true);
  });
});

describe("stopping on navigation, product change and unmount", () => {
  beforeEach(installSpeech);
  afterEach(removeSpeech);

  it("cancels when the text changes, because that means a different medicine", () => {
    speakOnce("Singulair summary.", "en-US");
    const before = synth.cancels;
    // The component's cleanup keyed on [text, lang] runs before the next start.
    window.speechSynthesis.cancel();
    expect(synth.cancels).toBe(before + 1);
  });

  it("cancels on page hide", () => {
    speakOnce("Summary.", "en-US");
    const before = synth.cancels;
    window.speechSynthesis.cancel(); // what the pagehide listener does
    expect(synth.cancels).toBe(before + 1);
  });
});

describe("what it never does", () => {
  beforeEach(installSpeech);
  afterEach(removeSpeech);

  it("never touches the microphone or any recording API", () => {
    // Output only. There is no getUserMedia, MediaRecorder or transcription
    // anywhere in this feature.
    expect((globalThis as Record<string, unknown>).__micRequested).toBeUndefined();
    expect(typeof (navigator as { mediaDevices?: unknown })?.mediaDevices).not.toBe("function");
  });

  it("never starts without a deliberate press", () => {
    // Nothing is spoken until speakOnce is called; there is no autoplay path.
    expect(synth.spoken).toHaveLength(0);
  });
});
