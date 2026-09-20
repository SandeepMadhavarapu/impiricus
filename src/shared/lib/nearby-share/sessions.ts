import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getGuide, listGuideSlugs, guideProductName } from "@/sources/lib/content/catalogue";
import { getPublicOrigin } from "@/shared/lib/config";
import { medicationPath } from "@/doctor/lib/share";

export const TTL_SECONDS = 120;
export class SessionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
// Global only for development HMR. Production MUST share a configured key across instances.
const local = globalThis as typeof globalThis & { nearbyDevelopmentKey?: Buffer };
function key() {
  const value = process.env.NEARBY_SHARE_SECRET;
  if (value && /^[a-fA-F0-9]{64}$/.test(value)) return Buffer.from(value, "hex");
  if (process.env.NODE_ENV === "production") throw new SessionError(503, "Nearby sharing is not configured. Use Share normally.");
  return local.nearbyDevelopmentKey ??= randomBytes(32);
}
function id(slug: string) { return createHash("sha256").update(slug).digest().subarray(0, 4); }
const aad = Buffer.from("MediZ nearby v1");
export function createSession(slug: string, now = Date.now()) {
  // The catalogue, not the authored-only registry: every guide the doctor can
  // select must be shareable, including the label-sourced ones.
  if (!getGuide(slug)) throw new SessionError(400, "Unsupported medication.");
  const expires = Math.floor(now / 1000) + TTL_SECONDS;
  const payload = Buffer.alloc(8);
  payload.writeUInt32BE(expires); id(slug).copy(payload, 4);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const token = Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString("hex");
  return { token, expiresAt: new Date(expires * 1000).toISOString(), receiveUrl: `${getPublicOrigin().origin}/receive` };
}
export function resolveSession(token: string, now = Date.now()) {
  if (!/^[a-f0-9]{72}$/.test(token)) throw new SessionError(400, "We couldn't verify this medication guide.");
  const secret = key();
  let payload: Buffer;
  try {
    const bytes = Buffer.from(token, "hex");
    const decipher = createDecipheriv("aes-256-gcm", secret, bytes.subarray(0, 12));
    decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(20));
    payload = Buffer.concat([decipher.update(bytes.subarray(12, 20)), decipher.final()]);
  } catch { throw new SessionError(400, "We couldn't verify this medication guide."); }
  const expires = payload.readUInt32BE(0);
  if (expires <= Math.floor(now / 1000)) throw new SessionError(410, "This share has expired. Ask your provider to send it again.");
  if (expires > Math.floor(now / 1000) + TTL_SECONDS) throw new SessionError(400, "We couldn't verify this medication guide.");
  const matches = listGuideSlugs().filter(slug => id(slug).equals(payload.subarray(4)));
  if (matches.length !== 1) throw new SessionError(400, "We couldn't verify this medication guide.");
  const slug = matches[0]!;
  return { medicationSlug: slug, label: guideProductName(getGuide(slug)!), path: medicationPath(slug) };
}
