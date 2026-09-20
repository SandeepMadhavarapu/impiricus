/** Version 1: ASCII, LF-delimited, one outstanding operation, random request IDs. */
export const MAX_URL_BYTES = 240;
export const MAX_LINE_BYTES = 300;
export const UNSUPPORTED_SERIAL = "NFC hardware programming requires a browser with Web Serial support. Use Chrome or Edge on the demo computer.";
export interface NfcTarget { slug: string; name: string; url: string }
export type Operation = "HELLO" | "PROGRAM_NDEF_URI" | "READ_NDEF";
export type Reply =
  | { type: "READY"; id: string }
  | { type: "STATUS"; id: string; value: "WRITING" | "READING" }
  | { type: "VERIFIED" | "NDEF_URI"; id: string; url: string }
  | { type: "ERROR"; id: string; code: string };
const ID = /^[a-f0-9]{8}$/;

export function validateNfcUrl(value: string): string {
  if (value.length > MAX_URL_BYTES || !/^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?\/medications\/[a-z0-9_-]+$/.test(value)) {
    throw new Error("NFC requires a public HTTPS medication-guide URL without extra data (maximum 240 bytes).");
  }
  const url = new URL(value);
  if (!url.hostname.includes(".") || url.hostname.endsWith(".localhost") || ["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname) || url.href !== value) {
    throw new Error("NFC requires a configured public HTTPS origin, not localhost.");
  }
  return value;
}
export function formatCommand(operation: Operation, id: string, url?: string): string {
  if (!ID.test(id)) throw new Error("Invalid request ID.");
  if (operation === "PROGRAM_NDEF_URI") return `${operation} ${id} ${validateNfcUrl(url ?? "")}\n`;
  return `${operation} ${id}\n`;
}
export function parseReply(line: string): Reply | null {
  if (line === "READY MEDBRIDGE_NFC") return null; // Boot announcement is not a handshake or verification.
  if (line.length > MAX_LINE_BYTES || /[^\x20-\x7e]/.test(line)) throw new Error("Malformed Arduino response.");
  const [type, id, value, ...rest] = line.split(" ");
  if (!id || !ID.test(id) || rest.length) throw new Error("Malformed Arduino response.");
  if (type === "READY" && value === "MEDBRIDGE_NFC") return { type, id };
  if (type === "STATUS" && (value === "WRITING" || value === "READING")) return { type, id, value };
  if ((type === "VERIFIED" || type === "NDEF_URI") && value) return { type, id, url: validateNfcUrl(value) };
  if (type === "ERROR" && value && /^[A-Z_]+$/.test(value)) return { type, id, code: value };
  throw new Error("Malformed Arduino response.");
}
/** A local write or STATUS message can never produce a verified result. */
export function completion(reply: Reply, operation: Operation, expectedUrl?: string): string | undefined {
  if (reply.type === "ERROR") throw new Error(`NFC hardware: ${reply.code}`);
  if (reply.type === "STATUS") return undefined;
  if (operation === "HELLO" && reply.type === "READY") return "ready";
  if (operation === "READ_NDEF" && reply.type === "NDEF_URI") return reply.url;
  if (operation === "PROGRAM_NDEF_URI" && reply.type === "VERIFIED") {
    if (reply.url !== expectedUrl) throw new Error("Verification mismatch: hardware returned a different URI.");
    return reply.url;
  }
  throw new Error("Unexpected Arduino response. Verification was not accepted.");
}
