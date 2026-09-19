import { inflateRawSync } from "node:zlib";
import { USER_AGENT } from "../config/sources.js";

/**
 * Range-based ZIP reader.
 *
 * Why this exists: the CMS Monthly Prescription Drug Plan file is 2.29 GB, but
 * 2.18 GB of that is pharmacy-network data we do not need. Reading the ZIP
 * central directory over HTTP range requests shows the members we DO need are
 * tiny:
 *
 *   basic drugs formulary file   7.9 MB
 *   plan information             0.4 MB
 *   beneficiary cost file        0.4 MB
 *   excluded drugs formulary    ~0.0 MB
 *
 * Fetching only those is roughly 8.8 MB instead of 2.29 GB — about 250x less
 * transfer — and it is the difference between "we documented a dataset" and
 * "we ingested it". Verified: the CMS host returns `Accept-Ranges: bytes` and
 * answers HTTP 206.
 *
 * Only the subset of ZIP needed for these files is implemented: stored (0) and
 * deflate (8), standard (non-ZIP64) central directories. Anything else raises
 * rather than guessing.
 */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  compressionMethod: number;
}

async function rangeFetch(url: string, start: number, end: number): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Range: `bytes=${start}-${end}` },
    signal: AbortSignal.timeout(180_000),
  });
  if (res.status !== 206 && res.status !== 200) {
    throw new Error(`Range request failed: HTTP ${res.status} for bytes=${start}-${end}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function contentLength(url: string): Promise<number> {
  const res = await fetch(url, {
    method: "HEAD",
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HEAD failed: HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (!len) throw new Error("Server did not report a content length");
  return len;
}

/** Parses a central directory buffer into entries. */
export function parseCentralDirectory(cd: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let off = 0;
  while (off < cd.length - 4 && cd.readUInt32LE(off) === CEN_SIG) {
    const compressionMethod = cd.readUInt16LE(off + 10);
    const compressedSize = cd.readUInt32LE(off + 20);
    const uncompressedSize = cd.readUInt32LE(off + 24);
    const nameLen = cd.readUInt16LE(off + 28);
    const extraLen = cd.readUInt16LE(off + 30);
    const commentLen = cd.readUInt16LE(off + 32);
    const localHeaderOffset = cd.readUInt32LE(off + 42);
    const name = cd.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    entries.push({ name, compressedSize, uncompressedSize, localHeaderOffset, compressionMethod });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Lists a remote ZIP's members without downloading the archive. */
export async function listRemoteZip(url: string): Promise<{ entries: ZipEntry[]; totalBytes: number }> {
  const totalBytes = await contentLength(url);

  // The EOCD is within the last 64 KiB unless there is a huge comment.
  const tailLen = Math.min(65_536 + 22, totalBytes);
  const tail = await rangeFetch(url, totalBytes - tailLen, totalBytes - 1);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP end-of-central-directory not found");

  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error("ZIP64 central directory is not supported by this reader");
  }

  const cd = await rangeFetch(url, cdOffset, cdOffset + cdSize - 1);
  return { entries: parseCentralDirectory(cd), totalBytes };
}

/** Decompresses one member given its local header and following bytes. */
function extractFromLocal(buf: Buffer, entry: ZipEntry): Buffer {
  if (buf.readUInt32LE(0) !== LOC_SIG) throw new Error(`Bad local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const dataStart = 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) return data;
  if (entry.compressionMethod === 8) return inflateRawSync(data);
  throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod} for ${entry.name}`);
}

/** Fetches and decompresses a single member of a remote ZIP. */
export async function fetchZipMember(url: string, entry: ZipEntry): Promise<Buffer> {
  // Local header is 30 bytes plus name and extra fields; 4 KiB of slack covers
  // any realistic combination.
  const start = entry.localHeaderOffset;
  const end = start + 30 + 4096 + entry.compressedSize;
  const raw = await rangeFetch(url, start, end);
  return extractFromLocal(raw, entry);
}

/** Reads an in-memory ZIP (CMS nests a ZIP inside the outer ZIP). */
export function readZipBuffer(buf: Buffer): Array<{ name: string; data: Buffer }> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Nested ZIP end-of-central-directory not found");

  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = parseCentralDirectory(buf.subarray(cdOffset, cdOffset + cdSize));

  return entries.map((entry) => ({
    name: entry.name,
    data: extractFromLocal(buf.subarray(entry.localHeaderOffset), entry),
  }));
}

/** Convenience: fetch a member and unwrap it if it is itself a ZIP. */
export async function fetchZipMemberFlattened(
  url: string,
  entry: ZipEntry
): Promise<Array<{ name: string; data: Buffer }>> {
  const member = await fetchZipMember(url, entry);
  const looksLikeZip = member.length > 4 && member.readUInt32LE(0) === LOC_SIG;
  return looksLikeZip ? readZipBuffer(member) : [{ name: entry.name, data: member }];
}
