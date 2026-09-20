import { frequency, PacketCollector } from "./protocol";
import { UNSUPPORTED } from "./transmitter";

/** Match the strongest tone within +/- 35Hz; require separation from other tones. */
export function detectSymbol(spectrum: Float32Array, sampleRate: number, fftSize: number): number | undefined {
  const scores = Array.from({ length: 18 }, (_, symbol) => {
    const bin = Math.round(frequency(symbol) * fftSize / sampleRate);
    let score = -Infinity;
    for (let i = bin - 1; i <= bin + 1; i++) if (Math.abs(i * sampleRate / fftSize - frequency(symbol)) <= 35) score = Math.max(score, spectrum[i] ?? -Infinity);
    return { symbol, score };
  }).sort((a, b) => b.score - a.score);
  return scores[0]!.score > -65 && scores[0]!.score - scores[1]!.score > 7 ? scores[0]!.symbol : undefined;
}

/** No recording or network calls. All samples remain in the local audio graph. */
export function listenForToken(onToken: (token: string) => void, onError: (message: string) => void, onStatus: (message: string) => void = () => {}) {
  if (typeof window === "undefined" || !window.isSecureContext || !window.AudioContext || !navigator.mediaDevices?.getUserMedia) {
    onError(UNSUPPORTED); return () => {};
  }
  let context: AudioContext;
  try { context = new AudioContext(); } catch { onError(UNSUPPORTED); return () => {}; }
  let stopped = false;
  let stream: MediaStream | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let collector = new PacketCollector();
  let heardSignal = false;
  const stop = () => {
    stopped = true; clearInterval(interval); clearTimeout(timeout);
    stream?.getTracks().forEach(track => track.stop());
    if (context.state !== "closed") void context.close().catch(() => {});
  };
  const fail = (message: string) => { if (stopped) return; stop(); onError(message); };
  let timeout = setTimeout(() => fail("Microphone setup took too long. Allow microphone access, then try again."), 60000);
  // Both permission and resume originate directly from the explicit Listen gesture.
  const ready = context.resume();
  void ready.catch(() => fail("Audio paused. Press Listen for guide again."));
  void navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).then(async media => {
    stream = media;
    // Permission can resolve AFTER cancel/unmount/timeout.
    if (stopped) { media.getTracks().forEach(track => track.stop()); return; }
    await ready;
    if (stopped) return;
    clearTimeout(timeout);
    timeout = setTimeout(() => fail(heardSignal ? "We heard a signal, but couldn't verify it. Move the devices closer and ask your provider to send again." : "We couldn't hear a MediZ signal. Check the sending device's volume and try again."), 60000);
    onStatus("Microphone ready. Ask your provider to tap Play sound now. Keep both screens open.");
    const source = context.createMediaStreamSource(media), analyser = context.createAnalyser();
    analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0;
    source.connect(analyser); // Deliberately no connection to speakers.
    const spectrum = new Float32Array(analyser.frequencyBinCount);
    let previous: number | undefined, consecutive = 0, emitted: number | undefined;
    interval = setInterval(() => {
      if (context.state !== "running") { fail("Audio paused. Keep this page open and try again."); return; }
      analyser.getFloatFrequencyData(spectrum);
      const symbol = detectSymbol(spectrum, context.sampleRate, analyser.fftSize);
      if (symbol === undefined) { previous = undefined; consecutive = 0; return; }
      consecutive = symbol === previous ? consecutive + 1 : 1; previous = symbol;
      if (consecutive < 2 || symbol === emitted) return;
      emitted = symbol;
      try {
        const token = collector.accept(symbol);
        if (collector.heardPreamble && !heardSignal) { heardSignal = true; onStatus("Sound detected. Receiving your guide…"); }
        if (token) { stop(); onToken(token); }
      } catch {
        // A damaged frame is not the end of the attempt: the sender repeats it.
        collector = new PacketCollector();
        onStatus("Signal interrupted. Still listening for the repeated signal…");
      }
    }, 10);
  }).catch(error => fail(error instanceof Error && error.name === "NotAllowedError"
    ? "Microphone access is needed to receive a nearby guide. Allow microphone access in your browser settings, then try again."
    : "Couldn't start the microphone. Check that it is available, then try again."));
  return stop;
}
