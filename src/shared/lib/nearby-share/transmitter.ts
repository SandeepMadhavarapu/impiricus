import { CLOCK, PREAMBLE, frequency, encodePacket, DATA_SECONDS, CLOCK_SECONDS, PREAMBLE_SECONDS, TRANSMISSION_REPEATS, REPEAT_GAP_SECONDS, SOUND_SECONDS } from "./protocol";
export const UNSUPPORTED = "Nearby sound sharing isn't available on this browser.";

/** PCM WAV uses Safari's media playback channel, rather than silent-mode Web Audio. */
export function encodeSound(token: string): ArrayBuffer {
  const rate = 48000;
  const packet = [{ symbol: PREAMBLE, duration: PREAMBLE_SECONDS }, ...encodePacket(token).flatMap(symbol => [
    { symbol: CLOCK, duration: CLOCK_SECONDS }, { symbol, duration: DATA_SECONDS },
  ])];
  const tones = Array.from({ length: TRANSMISSION_REPEATS }, (_, index) => [
    ...(index ? [{ symbol: -1, duration: REPEAT_GAP_SECONDS }] : []), ...packet,
  ]).flat();
  const lengths = tones.map(t => Math.round(t.duration * rate));
  const frames = lengths.reduce((a, b) => a + b, 0);
  const buffer = new ArrayBuffer(44 + frames * 2), view = new DataView(buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, frames * 2, true);
  let frame = 0;
  tones.forEach((tone, index) => {
    const length = lengths[index]!;
    for (let i = 0; i < length; i++) {
      const envelope = Math.min(1, i / (rate * 0.004), (length - i) / (rate * 0.004));
      const sample = tone.symbol < 0 ? 0 : 0.22 * envelope * Math.sin(2 * Math.PI * frequency(tone.symbol) * i / rate);
      view.setInt16(44 + frame++ * 2, Math.round(sample * 32767), true);
    }
  });
  return buffer;
}

/** Prepare after fetching the token; call play directly from a fresh user click. */
export function prepareTransmitter(token: string) {
  if (typeof window === "undefined" || typeof Audio === "undefined") throw new Error(UNSUPPORTED);
  const url = URL.createObjectURL(new Blob([encodeSound(token)], { type: "audio/wav" }));
  const audio = new Audio(url);
  audio.preload = "auto";
  audio.volume = 1;
  audio.muted = false;
  audio.setAttribute("playsinline", "");
  let closed = false;
  let pending: ((error?: Error) => void) | undefined;
  return {
    close() {
      if (closed) return;
      closed = true;
      pending?.(new Error("Sending cancelled."));
      audio.pause(); audio.removeAttribute("src"); audio.load();
      URL.revokeObjectURL(url);
    },
    play(onPlaying: () => void): Promise<void> {
      if (closed) return Promise.reject(new Error("Prepare the sound again."));
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(startTimeout); clearTimeout(endTimeout);
          audio.onplaying = null; audio.onended = null; audio.onerror = null; audio.onpause = null;
          pending = undefined;
          if (error) { audio.pause(); reject(error); } else resolve();
        };
        pending = finish;
        const startTimeout = setTimeout(() => finish(new Error("Playback did not start. Tap Play sound again and check your media volume.")), 8000);
        const endTimeout = setTimeout(() => finish(new Error("Playback was interrupted. Keep this page open and try again.")), (SOUND_SECONDS + 12) * 1000);
        audio.onplaying = () => { clearTimeout(startTimeout); onPlaying(); };
        audio.onended = () => finish();
        audio.onerror = () => finish(new Error("This browser could not play the sound. Try Safari or Chrome, or use the QR code."));
        audio.onpause = () => { if (!audio.ended) finish(new Error("Playback paused. Tap Play sound again.")); };
        audio.currentTime = 0;
        // No network or await before this call: iOS requires direct user activation.
        void audio.play().catch(() => finish(new Error("Safari blocked playback. Tap Play sound again and check your media volume.")));
      });
    },
  };
}
