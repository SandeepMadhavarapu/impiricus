import { completion, formatCommand, MAX_LINE_BYTES, parseReply, UNSUPPORTED_SERIAL, type Operation } from "./protocol";

/** Minimal local Web Serial types; no browser globals are touched at module load. */
export interface NfcSerialPort extends EventTarget {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}
export interface NfcSerial { requestPort(): Promise<NfcSerialPort> }
export function browserSerial(): NfcSerial | undefined {
  return typeof navigator === "undefined" ? undefined : (navigator as Navigator & { serial?: NfcSerial }).serial;
}
interface Pending {
  id: string; operation: Operation; url?: string;
  resolve: (result: string) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>; retry?: ReturnType<typeof setInterval>;
}

export class NfcSerialConnection {
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private loop?: Promise<void>;
  private pending?: Pending;
  private stopped = false;
  private ready = false;
  private closing?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  constructor(private port: NfcSerialPort, private onStatus: (value: string) => void, private onDisconnect: (message: string) => void) {}
  private disconnected = () => { void this.close("NFC hardware disconnected."); };

  async open() {
    await this.port.open({ baudRate: 115200 });
    if (this.stopped) { await this.port.close(); throw new Error("Connection cancelled."); }
    this.port.addEventListener("disconnect", this.disconnected);
    if (!this.port.readable || !this.port.writable) { await this.close(); throw new Error("Serial streams unavailable."); }
    this.reader = this.port.readable.getReader(); this.writer = this.port.writable.getWriter();
    this.loop = this.readLoop();
    try {
      await this.request("HELLO");
      if (this.stopped) throw new Error("Connection closed.");
      this.ready = true;
    } catch (error) { await this.close(); throw error; }
  }
  program(url: string) { return this.request("PROGRAM_NDEF_URI", url); }
  readMemory() { return this.request("READ_NDEF"); }
  private request(operation: Operation, url?: string): Promise<string> {
    if (this.stopped || !this.writer || (operation !== "HELLO" && !this.ready)) return Promise.reject(new Error("Connect NFC hardware first."));
    if (this.pending) return Promise.reject(new Error("A hardware operation is already in progress."));
    const id = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, "0")).join("");
    let command: string;
    try { command = formatCommand(operation, id, url); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.close("Arduino response timed out. Reconnect and read NFC memory before retrying."); }, 12000);
      this.pending = { id, operation, url, resolve, reject, timer };
      const send = () => {
        this.writes = this.writes.then(async () => {
          if (this.stopped || this.pending?.id !== id) return;
          await this.writer!.write(new TextEncoder().encode(command));
        }).catch(() => { void this.close("Serial write failed. Reconnect the hardware."); });
      };
      // Some Arduino boards reset on port open. Retry only HELLO, never a write command.
      if (operation === "HELLO") this.pending.retry = setInterval(send, 500);
      send();
    });
  }
  private settle(error?: Error, value?: string) {
    const pending = this.pending; if (!pending) return;
    this.pending = undefined; clearTimeout(pending.timer); clearInterval(pending.retry);
    if (error) pending.reject(error); else pending.resolve(value!);
  }
  private async readLoop() {
    let buffer = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      while (!this.stopped) {
        const { value, done } = await this.reader!.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const reply = parseReply(line);
          const pending = this.pending;
          if (!reply || !pending || reply.id !== pending.id) continue; // Ignore stale/unsolicited replies.
          if (reply.type === "STATUS") { this.onStatus(reply.value === "WRITING" ? "Writing NDEF URI…" : "Reading ST25DV64 memory…"); continue; }
          try { const result = completion(reply, pending.operation, pending.url); if (result !== undefined) this.settle(undefined, result); }
          catch (error) { this.settle(error instanceof Error ? error : new Error("Verification failed.")); }
        }
        if (buffer.length > MAX_LINE_BYTES) throw new Error("Malformed Arduino response: line too long.");
      }
      if (!this.stopped) void this.close("NFC hardware disconnected.");
    } catch (error) {
      if (!this.stopped) void this.close(error instanceof Error ? error.message : "Serial read failed.");
    } finally { this.reader?.releaseLock(); this.reader = undefined; }
  }
  close(message = "Hardware disconnected."): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true; this.ready = false;
    this.settle(new Error(message));
    this.port.removeEventListener("disconnect", this.disconnected);
    this.onDisconnect(message);
    this.closing = (async () => {
      await this.reader?.cancel().catch(() => {});
      await this.loop;
      await this.writer?.abort().catch(() => {});
      await this.writes;
      this.writer?.releaseLock(); this.writer = undefined;
      await this.port.close().catch(() => {});
    })();
    return this.closing;
  }
}
export function requestNfcPort(): Promise<NfcSerialPort> {
  const serial = browserSerial();
  if (!serial) return Promise.reject(new Error(UNSUPPORTED_SERIAL));
  return serial.requestPort(); // Must be called directly from a click, before any await.
}
