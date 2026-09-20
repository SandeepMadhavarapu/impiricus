import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import DoctorPage from "@/app/doctor/page";
import { listGuides } from "@/sources/lib/content/catalogue";
import { buildShareUrl } from "@/doctor/lib/share";
import { createNfcTarget } from "@/doctor/lib/nfc/target";
import { completion, formatCommand, parseReply, UNSUPPORTED_SERIAL, validateNfcUrl } from "@/doctor/lib/nfc/protocol";
import { browserSerial, NfcSerialConnection, requestNfcPort, type NfcSerialPort } from "@/doctor/lib/nfc/serial";

const origin = "https://mediz.example";
const guides = listGuides();
const url = buildShareUrl(origin, guides[0]!.slug);
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("NFC selected guide and safety", () => {
  it.each(guides.map(g => g.slug))("derives %s from the CURRENT catalogue and existing routing", slug => {
    const target = createNfcTarget(slug, origin)!;
    expect(target.url).toBe(buildShareUrl(origin, slug));
    expect(formatCommand("PROGRAM_NDEF_URI", "deadbeef", target.url)).toBe(`PROGRAM_NDEF_URI deadbeef ${origin}/medications/${slug}\n`);
  });
  it("rejects unknown medications and non-public origins", () => {
    expect(createNfcTarget("unregistered", origin)).toBeNull();
    expect(createNfcTarget(guides[0]!.slug, "http://localhost:3000")).toBeNull();
    expect(createNfcTarget(guides[0]!.slug, "https://localhost")).toBeNull();
  });
  it.each([url + "?patient=123", url + "#insurance", url + "\nREAD_NDEF", url.replace("https:", "http:"), "https://user:pass@example.com/medications/drug", "https://example.com/medications/" + "a".repeat(240)])("rejects unsafe payload %s", value => {
    expect(() => validateNfcUrl(value)).toThrow();
  });
  it("does not include config query strings or identifiers in the NDEF command", () => {
    const target = createNfcTarget(guides[0]!.slug, origin + "/?patient=123#insurance")!;
    expect(target.url).toBe(url);
    expect(formatCommand("PROGRAM_NDEF_URI", "abcdef12", target.url)).not.toMatch(/patient=|insurance|\?|#/);
  });
  it("renders unsupported serial without breaking doctor preview or native sharing", async () => {
    vi.stubGlobal("navigator", {}); vi.stubEnv("PUBLIC_ORIGIN", origin);
    expect(browserSerial()).toBeUndefined();
    await expect(requestNfcPort()).rejects.toThrow(UNSUPPORTED_SERIAL);
    const html = renderToStaticMarkup(await DoctorPage({ searchParams: Promise.resolve({ medication: guides[0]!.slug }) }));
    expect(html).toContain(UNSUPPORTED_SERIAL); expect(html).toContain("Share with Patient");
    expect(html).toContain("Open patient preview"); expect(html).not.toContain("NFC PROGRAMMED &amp; VERIFIED");
  });
});

describe("serial protocol", () => {
  it("only accepts matching VERIFIED as programming success", () => {
    expect(completion(parseReply("STATUS deadbeef WRITING")!, "PROGRAM_NDEF_URI", url)).toBeUndefined();
    expect(completion(parseReply("STATUS deadbeef READING")!, "PROGRAM_NDEF_URI", url)).toBeUndefined();
    expect(completion(parseReply(`VERIFIED deadbeef ${url}`)!, "PROGRAM_NDEF_URI", url)).toBe(url);
    expect(() => completion(parseReply(`NDEF_URI deadbeef ${url}`)!, "PROGRAM_NDEF_URI", url)).toThrow();
    expect(() => completion(parseReply(`VERIFIED deadbeef ${url}`)!, "PROGRAM_NDEF_URI", url + "-different")).toThrow("mismatch");
  });
  it.each(["WRITE_FAILED", "READ_FAILED", "VERIFY_MISMATCH", "INVALID_URL"])("never verifies ERROR %s", code => {
    expect(() => completion(parseReply(`ERROR deadbeef ${code}`)!, "PROGRAM_NDEF_URI", url)).toThrow(code);
  });
  it.each(["VERIFIED", "VERIFIED deadbeef", "ok", "STATUS deadbeef SUCCESS", "READY deadbeef UNKNOWN", "VERIFIED deadbeef " + url + " extra"])("rejects malformed response %s", line => expect(() => parseReply(line)).toThrow());
});

// Transport unit doubles exercise framing and state, NOT an ST25DV emulator or hardware proof.
class TestPort extends EventTarget implements NfcSerialPort {
  input!: ReadableStreamDefaultController<Uint8Array>;
  readable = new ReadableStream<Uint8Array>({ start: controller => { this.input = controller; } });
  commands: string[] = [];
  writable = new WritableStream<Uint8Array>({ write: bytes => {
    const line = new TextDecoder().decode(bytes); this.commands.push(line);
    const [command, id] = line.trim().split(" ");
    if (command === "HELLO") this.emit(`READY ${id} MEDIZ_NFC\n`);
  } });
  open = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  emit(line: string) { this.input.enqueue(new TextEncoder().encode(line)); }
  lastId() { return this.commands.at(-1)!.trim().split(" ")[1]!; }
}
async function connected() {
  const port = new TestPort(), status = vi.fn(), disconnected = vi.fn();
  const connection = new NfcSerialConnection(port, status, disconnected);
  await connection.open();
  return { port, connection, status, disconnected };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("Web Serial transport", () => {
  it("waits for a matching hardware reply and handles fragmented CRLF responses", async () => {
    const { port, connection, status } = await connected();
    let verified = false;
    const operation = connection.program(url).then(value => { verified = true; return value; });
    await flush(); const id = port.lastId();
    port.emit(`STATUS ${id} WRITING\nSTATUS ${id} READING\n`); await flush();
    expect(status).toHaveBeenCalled(); expect(verified).toBe(false);
    port.emit(`VERIFIED 00000000 ${url}\n`); await flush(); expect(verified).toBe(false);
    port.emit(`VERIFIED ${id} ${url.slice(0, 20)}`); await flush(); expect(verified).toBe(false);
    port.emit(url.slice(20) + "\r\n"); expect(await operation).toBe(url);
    await connection.close(); expect(port.readable.locked).toBe(false); expect(port.writable.locked).toBe(false);
  });
  it("keeps independent memory reading separate and sends updated selections", async () => {
    const { port, connection } = await connected();
    for (const guide of guides) {
      const target = createNfcTarget(guide.slug, origin)!;
      const operation = connection.program(target.url); await flush();
      expect(port.commands.at(-1)).toContain(target.url);
      port.emit(`VERIFIED ${port.lastId()} ${target.url}\n`); expect(await operation).toBe(target.url);
      const read = connection.readMemory(); await flush(); expect(port.commands.at(-1)).toMatch(/^READ_NDEF /);
      port.emit(`NDEF_URI ${port.lastId()} ${target.url}\n`); expect(await read).toBe(target.url);
    }
    await connection.close();
  });
  it.each(["ERROR", "MISMATCH", "MALFORMED"])("rejects %s without any success", async mode => {
    const { port, connection } = await connected();
    const operation = connection.program(url); const assertion = expect(operation).rejects.toThrow(); await flush();
    port.emit(mode === "ERROR" ? `ERROR ${port.lastId()} WRITE_FAILED\n` : mode === "MISMATCH" ? `VERIFIED ${port.lastId()} ${url}-wrong\n` : "not a reply\n");
    await assertion; await connection.close();
  });
  it("times out, rejects pending work, and closes the port", async () => {
    vi.useFakeTimers(); const { port, connection } = await connected();
    const pending = connection.program(url); const assertion = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(12001); await assertion; await connection.close(); expect(port.close).toHaveBeenCalled();
  });
  it("handles unplug and prevents simultaneous operations", async () => {
    const { port, connection, disconnected } = await connected();
    const pending = connection.program(url); const assertion = expect(pending).rejects.toThrow("disconnected");
    await expect(connection.readMemory()).rejects.toThrow("already in progress");
    port.dispatchEvent(new Event("disconnect")); await assertion; await connection.close(); expect(disconnected).toHaveBeenCalled();
  });
  it("handles serial write failure", async () => {
    const broken = new TestPort();
    broken.writable = new WritableStream({ write() { throw new Error("USB lost"); } });
    const bad = new NfcSerialConnection(broken, vi.fn(), vi.fn());
    await expect(bad.open()).rejects.toThrow("write failed"); await bad.close();
  });
});
