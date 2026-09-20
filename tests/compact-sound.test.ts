import { afterEach, expect, it, vi } from "vitest";
import { listGuideSlugs } from "@/sources/lib/content/catalogue";
import { PUBLIC_GUIDE_CODES, publicGuideCode } from "@/shared/lib/nearby-share/public-guides";
import { encodePacket, decodePacket, PacketCollector, PREAMBLE, CLOCK } from "@/shared/lib/nearby-share/protocol";
import { encodeSound } from "@/shared/lib/nearby-share/transmitter";
import { POST as create } from "@/app/api/guide-sounds/route";
import { POST as resolve } from "@/app/api/share-sessions/resolve/route";
import { resolveToken } from "@/shared/lib/nearby-share/client";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("pins codes independently of catalogue ordering", () => {
  expect(PUBLIC_GUIDE_CODES).toEqual({ "01": "singulair-montelukast-10mg-tablet", "02": "toprol-xl-metoprolol-succinate-50mg-er-tablet", "03": "ozempic-semaglutide-1_34mg-per-ml-injection" });
});
it.each(listGuideSlugs())("sends %s in under two seconds and resolves through the actual APIs", async slug => {
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("NEARBY_SHARE_SECRET", "");
  const result = await create(new Request("https://example.test/api/guide-sounds", { method: "POST", body: JSON.stringify({ medicationSlug: slug }) }));
  expect(result.status).toBe(200);
  const sound = await result.json(); expect(sound.code).toBe(publicGuideCode(slug));
  const packet = encodePacket(sound.code); expect(packet).toHaveLength(8);
  const collector = new PacketCollector(); collector.accept(PREAMBLE);
  let decoded;
  for (const symbol of packet) { collector.accept(CLOCK); decoded = collector.accept(symbol); }
  expect(decoded).toBe(sound.code);
  const wav = new DataView(encodeSound(sound.code));
  expect(wav.getUint32(40, true) / 2 / wav.getUint32(24, true)).toBeLessThan(2);
  vi.stubGlobal("fetch", vi.fn((_url, init) => resolve(new Request("https://example.test/api/share-sessions/resolve", init))));
  expect(await resolveToken(decoded!)).toMatchObject({ medicationSlug: slug, path: `/medications/${slug}` });
});
it.each(Object.keys(PUBLIC_GUIDE_CODES))("rejects every single-symbol corruption for code %s", id => {
  const packet = encodePacket(`g:${id}`);
  for (let index = 0; index < packet.length; index++) for (let nibble = 0; nibble < 16; nibble++) {
    if (nibble === packet[index]) continue;
    const changed = [...packet]; changed[index] = nibble;
    expect(() => decodePacket(changed)).toThrow();
  }
});
it("rejects unsupported guide codes and arbitrary destinations", async () => {
  for (const guideCode of ["g:00", "g:ff", "https://evil.test", "g:__proto__"]) {
    const response = await resolve(new Request("https://example.test/resolve", { method: "POST", body: JSON.stringify({ guideCode }) }));
    expect(response.status).toBe(400);
  }
  expect(() => encodeSound("g:ff")).toThrow();
});
