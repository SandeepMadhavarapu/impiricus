/** Fixed-size MB1 packet: magic/version (3 bytes), opaque token (36), CRC16 (2). */
export const PACKET_SYMBOLS = 82;
export const PREAMBLE = 17;
export const CLOCK = 16;
export const frequency = (symbol: number) => symbol < 16 ? 900 + symbol * 100 : symbol === CLOCK ? 2700 : 3000;
export const DATA_SECONDS = 0.08;
export const CLOCK_SECONDS = 0.05;
export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}
export function encodePacket(token: string): number[] {
  if (!/^[a-f0-9]{72}$/.test(token)) throw new Error("Invalid token");
  const bytes = new Uint8Array(41);
  bytes.set([0x4d, 0x42, 1]);
  for (let i = 0; i < 36; i++) bytes[i + 3] = parseInt(token.slice(i * 2, i * 2 + 2), 16);
  const crc = crc16(bytes.subarray(0, 39)); bytes[39] = crc >> 8; bytes[40] = crc & 255;
  return Array.from(bytes).flatMap(byte => [byte >> 4, byte & 15]);
}
export function decodePacket(symbols: number[]): string {
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
    if (this.symbols.length === PACKET_SYMBOLS) { this.active = false; return decodePacket(this.symbols); }
  }
}
