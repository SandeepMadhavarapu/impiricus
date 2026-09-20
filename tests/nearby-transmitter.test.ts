import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeSound, prepareTransmitter } from "@/shared/lib/nearby-share/transmitter";
const holder = {} as { media: FakeAudio };
class FakeAudio {
  volume = 0; muted = true; preload = ""; currentTime = 0; ended = false;
  onplaying: (() => void) | null = null; onended: (() => void) | null = null;
  onerror: (() => void) | null = null; onpause: (() => void) | null = null;
  play = vi.fn().mockResolvedValue(undefined); pause = vi.fn(); load = vi.fn();
  setAttribute = vi.fn(); removeAttribute = vi.fn();
  constructor(public src: string) { holder.media = this; }
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("window", {}); vi.stubGlobal("Audio", FakeAudio);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:signal");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("produces an audible mono PCM WAV with the complete packet duration", () => {
  const bytes = encodeSound("ab".repeat(36)), view = new DataView(bytes);
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
  expect(view.getUint32(24, true)).toBe(48000);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(40, true) / 2 / 48000).toBeCloseTo(34.5, 3);
  let peak = 0;
  for (let i = 44; i < bytes.byteLength; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
  expect(peak).toBeGreaterThan(7000);
  expect(() => encodeSound("invalid")).toThrow();
});
it("starts media synchronously on play, and waits for actual playback events", async () => {
  const sender = prepareTransmitter("ab".repeat(36)), started = vi.fn();
  expect(holder.media.play).not.toHaveBeenCalled();
  const done = sender.play(started);
  expect(holder.media.play).toHaveBeenCalledOnce();
  expect(holder.media.muted).toBe(false);
  expect(started).not.toHaveBeenCalled();
  holder.media.onplaying!(); expect(started).toHaveBeenCalledOnce();
  holder.media.ended = true; holder.media.onended!(); await done;
  sender.close(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:signal");
});
it("reports rejected playback instead of claiming the signal was sent", async () => {
  const sender = prepareTransmitter("ab".repeat(36));
  holder.media.play.mockRejectedValue(new DOMException("Blocked", "NotAllowedError"));
  await expect(sender.play(vi.fn())).rejects.toThrow("blocked playback");
  sender.close();
});
it("bounds stalled startup and cancels pending playback", async () => {
  const sender = prepareTransmitter("ab".repeat(36));
  holder.media.play.mockReturnValue(new Promise(() => {}));
  const result = expect(sender.play(vi.fn())).rejects.toThrow("did not start");
  await vi.advanceTimersByTimeAsync(8001); await result;
  const cancel = expect(sender.play(vi.fn())).rejects.toThrow("cancelled");
  sender.close(); await cancel;
  expect(holder.media.pause).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
