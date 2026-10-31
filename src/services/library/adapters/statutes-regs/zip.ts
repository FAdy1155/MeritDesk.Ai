import zlib from "node:zlib";

// Reads one file out of a ZIP archive held in memory: the Office of the Law
// Revision Counsel publishes each title of the U.S. Code as a ZIP holding
// one USLM XML file. Stored and deflated entries only (what the OLRC's
// archives use), no ZIP64, no encryption; the entry's CRC-32 is checked and
// its inflated size capped. Pure apart from node:zlib.

export class ZipFormatError extends Error {
  constructor(detail: string) {
    super(`The ZIP archive could not be read (${detail}).`);
    this.name = "ZipFormatError";
  }
}

export type ZipEntry = { name: string; method: number; compressedSize: number; size: number; crc32: number; localHeaderOffset: number };

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The archive's entries, from its central directory. */
export function zipEntries(zip: Buffer): ZipEntry[] {
  const lowest = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = zip.length - 22; i >= lowest; i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError("no end of central directory record");
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let k = 0; k < count; k++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== CENTRAL) throw new ZipFormatError("a central directory entry is damaged");
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const entry: ZipEntry = {
      method: zip.readUInt16LE(at + 10),
      crc32: zip.readUInt32LE(at + 16),
      compressedSize: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      localHeaderOffset: zip.readUInt32LE(at + 42),
      name: zip.toString("utf8", at + 46, at + 46 + nameLength),
    };
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.localHeaderOffset === 0xffffffff) {
      throw new ZipFormatError("ZIP64 archives are not read");
    }
    entries.push(entry);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

let CRC_TABLE: Uint32Array | null = null;

function crc32(data: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The bytes of one entry, inflated and checked against its CRC-32. */
export function readZipEntry(zip: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  if (entry.size > maxBytes) throw new ZipFormatError(`${entry.name} is ${entry.size} bytes, over the ${maxBytes}-byte limit`);
  const at = entry.localHeaderOffset;
  if (at + 30 > zip.length || zip.readUInt32LE(at) !== LOCAL) throw new ZipFormatError(`the local header of ${entry.name} is damaged`);
  if (zip.readUInt16LE(at + 6) & 0x1) throw new ZipFormatError(`${entry.name} is encrypted`);
  const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
  const raw = zip.subarray(start, start + entry.compressedSize);
  if (raw.length !== entry.compressedSize) throw new ZipFormatError(`${entry.name} is cut short`);
  let data: Buffer;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) {
    try {
      data = zlib.inflateRawSync(raw, { maxOutputLength: maxBytes });
    } catch (err) {
      throw new ZipFormatError(`${entry.name} could not be inflated: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else throw new ZipFormatError(`${entry.name} uses compression method ${entry.method}`);
  if (data.length !== entry.size) throw new ZipFormatError(`${entry.name} inflated to ${data.length} bytes, not the ${entry.size} its header states`);
  if (crc32(data) !== entry.crc32) throw new ZipFormatError(`${entry.name} fails its CRC-32 check`);
  return data;
}
