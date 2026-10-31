// ZIP structure readers for EOIR's case data release (a ZIP64 archive of
// about 4.5 GB), so the release is read by HTTP range requests: the central
// directory from the end of the file, then only the entries the statistics
// need, never the whole archive. Pure: buffers in, offsets and entries out.
//
// Formats: PKWARE APPNOTE 6.3.x, sections 4.3.6 (local file header), 4.3.12
// (central directory header), 4.3.14 and 4.3.15 (ZIP64 end of central
// directory record and locator), 4.3.16 (end of central directory record),
// 4.5.3 (the ZIP64 extra field).

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

/** How much of the end of the file to read for the end records (the EOCD comment is at most 65,535 bytes). */
export const ZIP_TAIL_BYTES = 66_000;

export class ZipFormatError extends Error {
  constructor(detail: string) {
    super(`The EOIR case data file is not the ZIP archive this collector reads: ${detail}.`);
    this.name = "ZipFormatError";
  }
}

export type ZipEntry = {
  name: string;
  /** 0 stored, 8 deflated. */
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  /** Absolute offset of the entry's local file header. */
  localHeaderOffset: number;
  /** The entry's DOS modification date as YYYY-MM-DD, as the archive states it. */
  modified: string | null;
};

export type ZipDirectoryLocation = {
  /** Absolute offset of the first byte of `tail`. */
  tailStart: number;
  /** The archive's size in bytes (tailStart + tail length). */
  fileSize: number;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  entryCount: number;
  zip64: boolean;
};

/**
 * Where the central directory is, from the last bytes of the archive (a
 * suffix range: the file's size is not needed, it is worked out from the
 * records themselves).
 */
export function locateCentralDirectory(tail: Buffer): ZipDirectoryLocation {
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError("no end of central directory record in the last bytes");
  let entryCount = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  const needs64 = entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
  const locator = eocd - 20;
  if (locator >= 0 && tail.readUInt32LE(locator) === SIG_ZIP64_LOCATOR) {
    const recordAbsolute = Number(tail.readBigUInt64LE(locator + 8));
    // The ZIP64 record sits just before the locator; its own size field says where it starts.
    let record = -1;
    for (let i = locator - 56; i >= 0 && i >= locator - 4096; i--) {
      if (tail.readUInt32LE(i) === SIG_ZIP64_EOCD && i + 12 + Number(tail.readBigUInt64LE(i + 4)) === locator) {
        record = i;
        break;
      }
    }
    if (record < 0) throw new ZipFormatError("a ZIP64 locator without its ZIP64 end record in the last bytes");
    entryCount = Number(tail.readBigUInt64LE(record + 32));
    cdSize = Number(tail.readBigUInt64LE(record + 40));
    cdOffset = Number(tail.readBigUInt64LE(record + 48));
    const tailStart = recordAbsolute - record;
    return { tailStart, fileSize: tailStart + tail.length, centralDirectoryOffset: cdOffset, centralDirectorySize: cdSize, entryCount, zip64: true };
  }
  if (needs64) throw new ZipFormatError("ZIP64 values without a ZIP64 locator");
  // Without ZIP64 records the central directory ends where the end record starts.
  const tailStart = cdOffset + cdSize - eocd;
  return { tailStart, fileSize: tailStart + tail.length, centralDirectoryOffset: cdOffset, centralDirectorySize: cdSize, entryCount, zip64: false };
}

function dosDate(value: number): string | null {
  const year = (value >> 9) + 1980;
  const month = (value >> 5) & 15;
  const day = value & 31;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Every entry of a central directory (the bytes from centralDirectoryOffset, centralDirectorySize long). */
export function parseCentralDirectory(buffer: Buffer, expectedCount: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let p = 0;
  while (p + 46 <= buffer.length && buffer.readUInt32LE(p) === SIG_CENTRAL) {
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const date = buffer.readUInt16LE(p + 14);
    const crc32 = buffer.readUInt32LE(p + 16);
    let compressedSize = buffer.readUInt32LE(p + 20);
    let size = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    let localHeaderOffset = buffer.readUInt32LE(p + 42);
    const nameBytes = buffer.subarray(p + 46, p + 46 + nameLength);
    // Bit 11: the name is UTF-8; otherwise code page 437, which is ASCII for every name EOIR uses.
    const name = flags & 0x800 ? nameBytes.toString("utf-8") : nameBytes.toString("latin1");
    let e = p + 46 + nameLength;
    const extraEnd = e + extraLength;
    while (e + 4 <= extraEnd) {
      const id = buffer.readUInt16LE(e);
      const length = buffer.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) {
          size = Number(buffer.readBigUInt64LE(q));
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = Number(buffer.readBigUInt64LE(q));
          q += 8;
        }
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = Number(buffer.readBigUInt64LE(q));
      }
      e += 4 + length;
    }
    entries.push({ name, method, crc32, compressedSize, size, localHeaderOffset, modified: dosDate(date) });
    p = extraEnd + commentLength;
  }
  if (entries.length !== expectedCount) {
    throw new ZipFormatError(`the central directory lists ${entries.length} entries where the end record says ${expectedCount}`);
  }
  return entries;
}

/** The offset of an entry's data, from the first 30 bytes of its local file header. */
export function entryDataOffset(entry: ZipEntry, localHeader: Buffer): number {
  if (localHeader.length < 30 || localHeader.readUInt32LE(0) !== SIG_LOCAL) {
    throw new ZipFormatError(`no local file header for ${entry.name} at offset ${entry.localHeaderOffset}`);
  }
  return entry.localHeaderOffset + 30 + localHeader.readUInt16LE(26) + localHeader.readUInt16LE(28);
}

/**
 * The release's top folder ("EOIR Case Data 2026-0901") and the date it
 * states (2026-09-01), when every entry sits under one folder of that form.
 */
export function releaseFolder(entries: readonly ZipEntry[]): { folder: string | null; date: string | null } {
  const tops = new Set(entries.map((e) => e.name.split("/")[0]));
  if (tops.size !== 1) return { folder: null, date: null };
  const folder = [...tops][0];
  const m = /(\d{4})-(\d{2})(\d{2})\s*$/.exec(folder);
  if (!m) return { folder, date: null };
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return { folder, date: !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null };
}
