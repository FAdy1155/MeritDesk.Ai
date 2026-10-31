import zlib from "node:zlib";

// What a .docx really is, read from its own package manifest rather than its
// name: a Word file is a ZIP whose [Content_Types].xml declares the main
// part as WordprocessingML. detectFileKind only checks the ZIP signature and
// the name, so anything zipped and named .docx (a spreadsheet, an ODF file,
// a macro-enabled .docm renamed) would otherwise go to LibreOffice, which
// picks its import filter from the content. Pure functions, no I/O.

const WORDPROCESSING_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

// ZIP record signatures (little-endian "PK\x05\x06", "PK\x01\x02", "PK\x03\x04").
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
// The manifest is small; refuse to inflate anything claiming to be larger.
const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * The uncompressed bytes of one entry of a ZIP archive, or null when the
 * archive or the entry can't be read (missing, encrypted, an unsupported
 * compression method, or larger than maxBytes). Reads the central
 * directory, so it finds entries the way unzip tools do.
 */
export function readZipEntry(zip: Buffer, name: string, maxBytes: number): Buffer | null {
  // End of central directory: 22 bytes plus a comment of up to 65,535 bytes.
  const searchFrom = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = zip.length - 22; i >= searchFrom; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entryCount = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);

  for (let n = 0; n < entryCount; n++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE) return null;
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const entryName = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;

    if (flags & 0x1) return null; // encrypted
    if (uncompressedSize > maxBytes || compressedSize > zip.length) return null;
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) return null;
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > zip.length) return null;
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    try {
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: maxBytes });
    } catch {
      return null;
    }
    return null; // another compression method
  }
  return null;
}

/**
 * Whether a ZIP is a Word document (.docx): its [Content_Types].xml
 * overrides /word/document.xml (or another main part) with the
 * WordprocessingML document content type. Macro-enabled documents and
 * templates use other content types and are not accepted.
 */
export function isWordprocessingDocument(zip: Buffer): boolean {
  let manifest: Buffer | null;
  try {
    manifest = readZipEntry(zip, "[Content_Types].xml", MAX_MANIFEST_BYTES);
  } catch {
    return false; // a malformed archive (a read past the end)
  }
  if (!manifest) return false;
  const xml = manifest.toString("utf8");
  const overrides = xml.match(/<Override\b[^>]*>/g) ?? [];
  return overrides.some((tag) => {
    const contentType = /\bContentType\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    return contentType === WORDPROCESSING_MAIN;
  });
}
