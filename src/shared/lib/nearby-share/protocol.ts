import { publicGuideSlug } from "./public-guides";
/** Compact V2: marker/version + public guide byte + CRC16. MB1 decoding remains compatible. */
export const PACKET_SYMBOLS = 82;
export const PREAMBLE = 17;
export const CLOCK = 16;
export const frequency = (symbol: number) => symbol < 16 ? 900 + symbol * 100 : symbol === CLOCK ? 2700 : 3000;
// Wider slots leave room for microphone buffering and mobile scheduling jitter.
export const DATA_SECONDS = 0.12;
export const CLOCK_SECONDS = 0.08;
export const PREAMBLE_SECONDS = 0.35;
export const COMPACT_PACKET_SYMBOLS = 8;
export const SOUND_SECONDS = PREAMBLE_SECONDS + COMPACT_PACKET_SYMBOLS * (DATA_SECONDS + CLOCK_SECONDS);
export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}
export function encodePacket(token: string): number[] {
  if (publicGuideSlug(token)) {
    const bytes = new Uint8Array([0xd2, parseInt(token.slice(2), 16), 0, 0]);
    const crc = crc16(bytes.subarray(0, 2)); bytes[2] = crc >> 8; bytes[3] = crc & 255;
    return Array.from(bytes).flatMap(byte => [byte >> 4, byte & 15]);
  }
  if (!/^[a-f0-9]{72}$/.test(token)) throw new Error("Invalid token");
  const bytes = new Uint8Array(41);
  bytes.set([0x4d, 0x42, 1]);
  for (let i = 0; i < 36; i++) bytes[i + 3] = parseInt(token.slice(i * 2, i * 2 + 2), 16);
  const crc = crc16(bytes.subarray(0, 39)); bytes[39] = crc >> 8; bytes[40] = crc & 255;
  return Array.from(bytes).flatMap(byte => [byte >> 4, byte & 15]);
}
export function decodePacket(symbols: number[]): string {
  if (symbols.length === COMPACT_PACKET_SYMBOLS) {
    if (symbols.some(s => !Number.isInteger(s) || s < 0 || s > 15)) throw new Error("Corrupt signal");
    const bytes = Uint8Array.from({ length: 4 }, (_, i) => (symbols[i * 2]! << 4) | symbols[i * 2 + 1]!);
    const code = `g:${bytes[1]!.toString(16).padStart(2, "0")}`;
    if (bytes[0] !== 0xd2 || crc16(bytes.subarray(0, 2)) !== ((bytes[2]! << 8) | bytes[3]!) || !publicGuideSlug(code)) throw new Error("Corrupt signal");
    return code;
  }
  if (symbols.length !== PACKET_SYMBOLS || symbols.some(s => !Number.isInteger(s) || s < 0 || s > 15)) throw new Error("Corrupt signal");
  const bytes = Uint8Array.from({ length: 41 }, (_, i) => (symbols[i * 2]! << 4) | symbols[i * 2 + 1]!);
  if (bytes[0] !== 0x4d || bytes[1] !== 0x42 || bytes[2] !== 1 || crc16(bytes.subarray(0, 39)) !== ((bytes[39]! << 8) | bytes[40]!)) throw new Error("Corrupt signal");
  return Array.from(bytes.subarray(3, 39), b => b.toString(16).padStart(2, "0")).join("");
}
/** Clock-delimited symbols avoid cumulative timing drift, including repeated nibbles. */
export class PacketCollector {
  private symbols: number[] = [];
  private active = false;
  private ready = false;
  heardPreamble = false;
  accept(symbol: number): string | undefined {
    if (symbol === PREAMBLE) { this.symbols = []; this.active = true; this.ready = false; this.heardPreamble = true; return; }
    if (!this.active) return;
    if (symbol === CLOCK) { this.ready = true; return; }
    if (!this.ready) return;
    this.ready = false; this.symbols.push(symbol);
    const expected = this.symbols[0] === 0xd && this.symbols[1] === 2 ? COMPACT_PACKET_SYMBOLS : PACKET_SYMBOLS;
    if (this.symbols.length === expected) { this.active = false; return decodePacket(this.symbols); }
  }
}
