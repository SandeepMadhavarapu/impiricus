import { CLOCK, PREAMBLE, frequency, encodePacket, DATA_SECONDS, CLOCK_SECONDS } from "./protocol";
export const UNSUPPORTED = "Nearby sound sharing isn't available on this browser.";
/** Call synchronously in the click handler, before fetching a session (iOS activation). */
export function prepareTransmitter() {
  if (typeof window === "undefined" || !window.AudioContext) throw new Error(UNSUPPORTED);
  const context = new AudioContext();
  const ready = context.resume();
  // Attach immediately so cancellation during a fetch cannot leave an unhandled rejection.
  void ready.catch(() => {});
  let closed = false;
  let finish: (() => void) | undefined;
  const close = () => { closed = true; finish?.(); if (context.state !== "closed") void context.close().catch(() => {}); };
  return {
    close,
    async send(token: string) {
      await ready;
      if (closed) throw new Error("Sending cancelled.");
      if (context.state !== "running") throw new Error("Audio paused. Try Send Nearby again.");
      const tones = [{ symbol: PREAMBLE, duration: 0.35 }, ...encodePacket(token).flatMap(symbol => [
        { symbol: CLOCK, duration: CLOCK_SECONDS }, { symbol, duration: DATA_SECONDS },
      ])];
      let time = context.currentTime + 0.1;
      let last: OscillatorNode | undefined;
      for (const tone of tones) {
        const oscillator = context.createOscillator(), gain = context.createGain();
        oscillator.frequency.value = frequency(tone.symbol);
        oscillator.connect(gain); gain.connect(context.destination);
        gain.gain.setValueAtTime(0, time); gain.gain.linearRampToValueAtTime(0.22, time + 0.004);
        gain.gain.setValueAtTime(0.22, time + tone.duration - 0.004); gain.gain.linearRampToValueAtTime(0, time + tone.duration);
        oscillator.start(time); oscillator.stop(time + tone.duration); time += tone.duration;
        last = oscillator;
      }
      await new Promise<void>(resolve => { finish = resolve; last!.onended = () => resolve(); });
      if (closed) throw new Error("Sending cancelled.");
    },
  };
}
