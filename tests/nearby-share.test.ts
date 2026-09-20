import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, resolveSession } from "@/shared/lib/nearby-share/sessions";
import { listGuideSlugs } from "@/sources/lib/content/catalogue";
import { encodePacket, decodePacket, crc16, PacketCollector, PREAMBLE, CLOCK } from "@/shared/lib/nearby-share/protocol";
import { POST as create } from "@/app/api/share-sessions/route";
import { POST as resolve } from "@/app/api/share-sessions/resolve/route";
import { resolveToken } from "@/shared/lib/nearby-share/client";
const slug = "singulair-montelukast-10mg-tablet";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("temporary sessions", () => {
  it("creates random opaque tokens and resolves only to the registered route", () => {
    const a = createSession(slug), b = createSession(slug);
    expect(a.token).toMatch(/^[a-f0-9]{72}$/); expect(a.token).not.toBe(b.token);
    expect(a.token).not.toContain(slug); expect(a.receiveUrl).toMatch(/\/receive$/);
    expect(resolveSession(a.token).path).toBe(`/medications/${slug}`);
  });
  // Sessions resolve through the catalogue, not the authored-only registry.
  // Every guide the doctor can select, label-sourced ones included, must be
  // shareable; resolving through the registry made this Singulair-only.
  it.each(listGuideSlugs())("creates and resolves a session for every catalogued guide: %s", (slug) => {
    const resolved = resolveSession(createSession(slug).token);
    expect(resolved.medicationSlug).toBe(slug);
    expect(resolved.path).toBe(`/medications/${slug}`);
    expect(resolved.label.length).toBeGreaterThan(0);
  });
  it("rejects unknown slugs, arbitrary URLs, malformed and tampered tokens", () => {
    expect(() => createSession("https://evil.test")).toThrow("Unsupported");
    expect(() => createSession("unknown")).toThrow("Unsupported");
    expect(() => resolveSession("1234")).toThrow("verify");
    const { token } = createSession(slug);
    expect(() => resolveSession((token[0] === "0" ? "1" : "0") + token.slice(1))).toThrow("verify");
  });
  it("expires at exactly 120 seconds", () => {
    const now = 1800000000000, session = createSession(slug, now);
    expect(Date.parse(session.expiresAt) - now).toBe(120000);
    expect(resolveSession(session.token, now + 119999).medicationSlug).toBe(slug);
    expect(() => resolveSession(session.token, now + 120000)).toThrow("expired");
  });
  it("requires a shared production key and verifies across key reloads", () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("NEARBY_SHARE_SECRET", "");
    expect(() => createSession(slug)).toThrow("not configured");
    vi.stubEnv("NEARBY_SHARE_SECRET", "ab".repeat(32));
    const session = createSession(slug); expect(resolveSession(session.token).medicationSlug).toBe(slug);
    vi.stubEnv("NEARBY_SHARE_SECRET", "cd".repeat(32)); expect(() => resolveSession(session.token)).toThrow("verify");
  });
  it("runs the receiver client through both real API handlers", async () => {
    const created = await create(new Request("http://localhost/api/share-sessions", { method: "POST", body: JSON.stringify({ medicationSlug: slug }) }));
    expect(created.status).toBe(200); expect(created.headers.get("cache-control")).toBe("no-store");
    const session = await created.json();
    vi.stubGlobal("fetch", vi.fn((_url, init) => resolve(new Request("http://localhost/api/share-sessions/resolve", init))));
    expect(await resolveToken(session.token)).toMatchObject({ medicationSlug: slug, path: `/medications/${slug}` });
    await expect(resolveToken("bad")).rejects.toThrow("verify");
  });
});
describe("MB1 protocol", () => {
  it("matches standard CRC16 CCITT vector", () => expect(crc16(new TextEncoder().encode("123456789"))).toBe(0x29b1));
  it("round trips only token bytes, magic/version and checksum", () => {
    const { token } = createSession(slug); const packet = encodePacket(token);
    expect(packet).toHaveLength(82); expect(decodePacket(packet)).toBe(token);
    expect(() => encodePacket(slug)).toThrow();
    const collector = new PacketCollector(); collector.accept(PREAMBLE);
    let result;
    for (const s of packet) { collector.accept(CLOCK); collector.accept(CLOCK); result = collector.accept(s); collector.accept(s); }
    expect(result).toBe(token);
  });
  it("rejects every single corrupted symbol, wrong length, version and random audio", () => {
    const packet = encodePacket(createSession(slug).token);
    for (let i = 0; i < packet.length; i++) { const corrupt = [...packet]; corrupt[i] = corrupt[i]! ^ 1; expect(() => decodePacket(corrupt)).toThrow(); }
    expect(() => decodePacket(packet.slice(1))).toThrow();
    const collector = new PacketCollector(); expect(collector.accept(2)).toBeUndefined();
  });
});
