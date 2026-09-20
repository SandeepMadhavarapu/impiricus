import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { detectSymbol, listenForToken } from "@/shared/lib/nearby-share/receiver";
import { CLOCK, PREAMBLE, encodePacket, frequency } from "@/shared/lib/nearby-share/protocol";
const trackStop = vi.fn(), close = vi.fn();
let symbol: number | undefined;
class Context {
  state = "running";
  sampleRate = 48000;
  resume = vi.fn().mockResolvedValue(undefined);
  close = close.mockImplementation(() => { this.state = "closed"; return Promise.resolve(); });
  createMediaStreamSource = () => ({ connect: vi.fn() });
  createAnalyser = () => ({ fftSize: 2048, smoothingTimeConstant: 0, frequencyBinCount: 1024,
    getFloatFrequencyData: (bins: Float32Array) => { bins.fill(-100); if (symbol !== undefined) bins[Math.round(frequency(symbol) * 2048 / 48000)] = -20; } });
}
const media = { getTracks: () => [{ stop: trackStop }] };
beforeEach(() => {
  vi.useFakeTimers(); trackStop.mockClear(); close.mockClear(); symbol = undefined;
  vi.stubGlobal("window", { isSecureContext: true, AudioContext: Context }); vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(media) } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("resolves clocked audio and stops microphone before callback", async () => {
  const token = "ab".repeat(36), received = vi.fn(() => expect(trackStop).toHaveBeenCalled()), error = vi.fn();
  listenForToken(received, error); await vi.advanceTimersByTimeAsync(1);
  symbol = PREAMBLE; await vi.advanceTimersByTimeAsync(350);
  for (const nibble of encodePacket(token)) {
    symbol = CLOCK; await vi.advanceTimersByTimeAsync(50);
    symbol = nibble; await vi.advanceTimersByTimeAsync(80);
  }
  expect(received).toHaveBeenCalledWith(token); expect(error).not.toHaveBeenCalled(); expect(close).toHaveBeenCalled();
});
it("stops after timeout", async () => {
  const error = vi.fn(); listenForToken(vi.fn(), error); await vi.advanceTimersByTimeAsync(60001);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("We couldn't hear a MediZ signal.")); expect(trackStop).toHaveBeenCalled();
});
it("stops on cancellation and late microphone permission", async () => {
  let grant!: (value: unknown) => void;
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } });
  const received = vi.fn(), error = vi.fn(); const stop = listenForToken(received, error); stop(); grant(media);
  await vi.advanceTimersByTimeAsync(30001);
  expect(trackStop).toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(received).not.toHaveBeenCalled();
});
it("handles denied permission and unsupported browsers", async () => {
  const error = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")) } });
  listenForToken(vi.fn(), error); await vi.advanceTimersByTimeAsync(1);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("Microphone access is needed")); expect(close).toHaveBeenCalled();
  vi.stubGlobal("window", { isSecureContext: false }); listenForToken(vi.fn(), error);
  expect(error).toHaveBeenCalledWith("Nearby sound sharing isn't available on this browser.");
});
it("distinguishes an incomplete signal", async () => {
  const error = vi.fn(); listenForToken(vi.fn(), error); await vi.advanceTimersByTimeAsync(1);
  symbol = PREAMBLE; await vi.advanceTimersByTimeAsync(350);
  symbol = undefined; await vi.advanceTimersByTimeAsync(60000);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("We heard a signal, but couldn't verify it.")); expect(trackStop).toHaveBeenCalled();
});
it("detects tones with frequency tolerance at phone sample rates, rejects noise", () => {
  for (const rate of [44100, 48000]) for (let s = 0; s < 18; s++) {
    const bins = new Float32Array(1024).fill(-100);
    bins[Math.round((frequency(s) + 10) * 2048 / rate)] = -25;
    expect(detectSymbol(bins, rate, 2048)).toBe(s);
  }
  expect(detectSymbol(new Float32Array(1024).fill(-40), 48000, 2048)).toBeUndefined();
});

it("recovers from a corrupt first frame when the sender repeats the packet", async () => {
  const received = vi.fn(), error = vi.fn();
  listenForToken(received, error); await vi.advanceTimersByTimeAsync(1);
  symbol = PREAMBLE; await vi.advanceTimersByTimeAsync(350);
  const packet = encodePacket("ab".repeat(36)); packet[20] = packet[20]! ^ 1;
  for (const nibble of packet) {
    symbol = CLOCK; await vi.advanceTimersByTimeAsync(50);
    symbol = nibble; await vi.advanceTimersByTimeAsync(80);
  }
  expect(received).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(trackStop).not.toHaveBeenCalled();
  symbol = PREAMBLE; await vi.advanceTimersByTimeAsync(600);
  for (const nibble of encodePacket("ab".repeat(36))) {
    symbol = CLOCK; await vi.advanceTimersByTimeAsync(80);
    symbol = nibble; await vi.advanceTimersByTimeAsync(120);
  }
  expect(received).toHaveBeenCalledWith("ab".repeat(36));
  expect(trackStop).toHaveBeenCalled(); expect(close).toHaveBeenCalled();
});


it("starts the listening window only after microphone permission is granted", async () => {
  let grant!: (value: unknown) => void;
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } });
  const error = vi.fn(), status = vi.fn();
  const stop = listenForToken(vi.fn(), error, status);
  await vi.advanceTimersByTimeAsync(45000);
  expect(status).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  grant(media); await vi.advanceTimersByTimeAsync(1);
  expect(status).toHaveBeenCalledWith(expect.stringContaining("Microphone ready"));
  await vi.advanceTimersByTimeAsync(30000); expect(error).not.toHaveBeenCalled();
  stop();
});
