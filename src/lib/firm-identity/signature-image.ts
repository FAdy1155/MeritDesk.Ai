import crypto from "node:crypto";
import zlib from "node:zlib";
import {
  SIGNATURE_MAX_BYTES,
  SIGNATURE_MAX_HEIGHT_PX,
  SIGNATURE_MAX_WIDTH_PX,
  SIGNATURE_MIN_SIDE_PX,
  type SignatureMediaType,
} from "./schema";

// Validation for attorney signature images, used instead of the upload
// malware scan (src/services/ingest/ingest.ts). Pure functions, no I/O; not
// marked "server-only" so it can be exercised under plain Node, but only
// server code imports it.
//
// Why not the ClamAV pipeline: a signature is a small image that only ever
// goes into python-docx (which reads its header), LibreOffice (rendering a
// generated letter, sandboxed) and an <img> preview. Signature scanning finds
// known malware in documents, archives and executables; it says little about
// a 50 KB PNG, and it runs only on the worker, minutes later, against bytes a
// presigned PUT could still replace. This check is stricter and synchronous:
//
// - The upload goes through a Server Action, never a presigned PUT, so the
//   bytes stored are exactly the bytes checked (the server writes them).
// - The format comes from the content (magic bytes), never the name or the
//   browser's MIME type, and only PNG and JPEG are accepted.
// - The file is parsed structurally: every PNG chunk checksum, the IHDR
//   fields, and the compressed image data (inflated, with its size bounded
//   by the header, so it must be exactly as long as the dimensions say and
//   every scanline must carry a valid filter byte); every JPEG segment up to
//   EOI, with only baseline or progressive Huffman coding and 1 or 3
//   components.
// - The image is rebuilt from the parts needed to display it: PNG keeps
//   IHDR, PLTE, tRNS, IDAT and IEND; JPEG keeps DQT, DHT, DRI, SOF, the scans
//   and EOI under a fresh minimal JFIF header (python-docx recognizes a JPEG
//   only by its JFIF or Exif header). Metadata (EXIF location, XMP, ICC,
//   text and comment chunks), thumbnails and anything after the end marker
//   are dropped, so no embedded payload survives into storage.
// - Size and pixel dimensions are capped (schema.ts), which also bounds the
//   memory any later decoder needs.

export type SanitizedSignatureImage = {
  mediaType: SignatureMediaType;
  bytes: Buffer;
  widthPx: number;
  heightPx: number;
  /** sha256 (hex) of `bytes`, the sanitized image that is stored. */
  sha256: string;
};

export type SignatureImageCheck = { ok: true; image: SanitizedSignatureImage } | { ok: false; error: string };

class SignatureImageError extends Error {}

function reject(message: string): never {
  throw new SignatureImageError(message);
}

/**
 * Checks an uploaded (or stored) signature image and returns the sanitized
 * copy to store, or a message the user can act on.
 */
export function sanitizeSignatureImage(input: Uint8Array): SignatureImageCheck {
  if (input.byteLength === 0) return { ok: false, error: "The file is empty." };
  if (input.byteLength > SIGNATURE_MAX_BYTES) {
    return {
      ok: false,
      error: `The file is ${Math.ceil(input.byteLength / 1024)} KB; signature images are limited to ${SIGNATURE_MAX_BYTES / 1024} KB. Crop it to the signature or save it at a lower resolution.`,
    };
  }
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  try {
    let parsed: Omit<SanitizedSignatureImage, "sha256">;
    if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
      parsed = sanitizePng(buf);
    } else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      parsed = sanitizeJpeg(buf);
    } else {
      return {
        ok: false,
        error: "Only PNG and JPEG images are accepted. The type is read from the file's content, not its name.",
      };
    }
    return { ok: true, image: { ...parsed, sha256: crypto.createHash("sha256").update(parsed.bytes).digest("hex") } };
  } catch (err) {
    if (err instanceof SignatureImageError) return { ok: false, error: err.message };
    throw err;
  }
}

function checkDimensions(width: number, height: number): void {
  if (width < SIGNATURE_MIN_SIDE_PX || height < SIGNATURE_MIN_SIDE_PX) {
    reject(`The image is ${width} x ${height} pixels, too small to print legibly.`);
  }
  if (width > SIGNATURE_MAX_WIDTH_PX || height > SIGNATURE_MAX_HEIGHT_PX) {
    reject(
      `The image is ${width} x ${height} pixels; signature images are limited to ${SIGNATURE_MAX_WIDTH_PX} x ${SIGNATURE_MAX_HEIGHT_PX}. Crop it to the signature.`
    );
  }
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Bit depths allowed for each PNG color type, and its channels per pixel.
const PNG_COLOR_TYPES: Record<number, { depths: number[]; channels: number }> = {
  0: { depths: [1, 2, 4, 8, 16], channels: 1 }, // grayscale
  2: { depths: [8, 16], channels: 3 }, // RGB
  3: { depths: [1, 2, 4, 8], channels: 1 }, // palette
  4: { depths: [8, 16], channels: 2 }, // grayscale + alpha
  6: { depths: [8, 16], channels: 4 }, // RGBA
};

// Adam7 passes: x start, y start, x step, y step.
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

type PngHeader = { width: number; height: number; bitDepth: number; colorType: number; interlaced: boolean };

function parseIhdr(data: Buffer): PngHeader {
  if (data.length !== 13) reject("The PNG header is damaged.");
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8];
  const colorType = data[9];
  const compression = data[10];
  const filter = data[11];
  const interlace = data[12];
  const color = PNG_COLOR_TYPES[colorType];
  if (!color || !color.depths.includes(bitDepth) || compression !== 0 || filter !== 0 || interlace > 1) {
    reject("The PNG header is not valid.");
  }
  checkDimensions(width, height);
  return { width, height, bitDepth, colorType, interlaced: interlace === 1 };
}

/** The inflated data's layout: one entry per pass (one for a non-interlaced image), each row a filter byte plus rowBytes. */
function scanlines(header: PngHeader): { rows: number; rowBytes: number }[] {
  const bitsPerPixel = PNG_COLOR_TYPES[header.colorType].channels * header.bitDepth;
  const rowBytes = (width: number) => Math.ceil((width * bitsPerPixel) / 8);
  if (!header.interlaced) return [{ rows: header.height, rowBytes: rowBytes(header.width) }];
  const passes: { rows: number; rowBytes: number }[] = [];
  for (const [x0, y0, dx, dy] of ADAM7) {
    const passWidth = header.width > x0 ? Math.ceil((header.width - x0) / dx) : 0;
    const passHeight = header.height > y0 ? Math.ceil((header.height - y0) / dy) : 0;
    // An empty pass has no scanlines at all, not even filter bytes.
    if (passWidth > 0 && passHeight > 0) passes.push({ rows: passHeight, rowBytes: rowBytes(passWidth) });
  }
  return passes;
}

/** The compressed image data must inflate to exactly what the header describes, with a valid filter byte per row. */
function checkPngImageData(header: PngHeader, compressed: Buffer): void {
  const layout = scanlines(header);
  const expected = layout.reduce((sum, p) => sum + p.rows * (1 + p.rowBytes), 0);
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(compressed, { maxOutputLength: expected });
  } catch {
    reject("The PNG image data is damaged or larger than its header says.");
  }
  if (raw.length !== expected) reject("The PNG image data is damaged (it does not match the image size).");
  let offset = 0;
  for (const pass of layout) {
    for (let row = 0; row < pass.rows; row++) {
      if (raw[offset] > 4) reject("The PNG image data is damaged (an invalid row filter).");
      offset += 1 + pass.rowBytes;
    }
  }
}

function sanitizePng(buf: Buffer): Omit<SanitizedSignatureImage, "sha256"> {
  const kept: Buffer[] = [PNG_SIGNATURE];
  const imageData: Buffer[] = [];
  let header: PngHeader | null = null;
  let sawPalette = false;
  let lastType = "";
  let ended = false;

  let offset = PNG_SIGNATURE.length;
  while (offset < buf.length && !ended) {
    if (offset + 12 > buf.length) reject("The PNG is cut off in the middle of a chunk.");
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) reject("The PNG has an invalid chunk.");
    if (length > 0x7fffffff || offset + 12 + length > buf.length) reject("The PNG is cut off in the middle of a chunk.");
    const crc = buf.readUInt32BE(offset + 8 + length);
    if (crc32(buf.subarray(offset + 4, offset + 8 + length)) !== crc) {
      reject("The PNG is damaged (a chunk checksum does not match).");
    }
    const data = buf.subarray(offset + 8, offset + 8 + length);
    const chunk = buf.subarray(offset, offset + 12 + length);
    offset += 12 + length;

    if (!header && type !== "IHDR") reject("The PNG does not start with its header.");
    switch (type) {
      case "IHDR":
        if (header) reject("The PNG has two headers.");
        header = parseIhdr(data);
        kept.push(chunk);
        break;
      case "PLTE":
        if (sawPalette || imageData.length > 0) reject("The PNG palette is misplaced.");
        if (length === 0 || length % 3 !== 0 || length > 768) reject("The PNG palette is damaged.");
        if (header!.colorType === 0 || header!.colorType === 4) reject("The PNG has a palette its color type does not allow.");
        sawPalette = true;
        kept.push(chunk);
        break;
      case "tRNS":
        if (imageData.length > 0) reject("The PNG transparency chunk is misplaced.");
        // Only meaningful (and only allowed) without an alpha channel.
        if (header!.colorType !== 4 && header!.colorType !== 6) kept.push(chunk);
        break;
      case "IDAT":
        if (imageData.length > 0 && lastType !== "IDAT") reject("The PNG image data is split up.");
        imageData.push(data);
        kept.push(chunk);
        break;
      case "IEND":
        if (length !== 0) reject("The PNG end marker is damaged.");
        kept.push(chunk);
        ended = true; // anything after IEND is dropped
        break;
      default:
        // An unknown critical chunk (upper-case first letter) means a decoder
        // cannot display the image correctly; ancillary chunks are dropped.
        if (type[0] >= "A" && type[0] <= "Z") reject(`The PNG uses an unsupported feature (${type}).`);
    }
    lastType = type;
  }

  if (!header) reject("The PNG has no header.");
  if (imageData.length === 0) reject("The PNG has no image data.");
  if (!ended) reject("The PNG is cut off (no end marker).");
  if (header.colorType === 3 && !sawPalette) reject("The PNG is missing its palette.");
  checkPngImageData(header, Buffer.concat(imageData));
  return { mediaType: "image/png", bytes: Buffer.concat(kept), widthPx: header.width, heightPx: header.height };
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

// A minimal JFIF APP0 segment (version 1.1, no density units, 1:1, no
// thumbnail), written in place of whatever APP segments the file had.
const JFIF_APP0 = Buffer.from([
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
]);

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
// Frame types decoders support everywhere: baseline, extended and progressive Huffman.
const SUPPORTED_SOF = new Set([0xc0, 0xc1, 0xc2]);
// Kept tables: DHT, DQT, DRI.
const KEPT_TABLES = new Set([0xc4, 0xdb, 0xdd]);

function sanitizeJpeg(buf: Buffer): Omit<SanitizedSignatureImage, "sha256"> {
  const out: Buffer[] = [Buffer.from([0xff, SOI]), JFIF_APP0];
  let frame: { width: number; height: number; components: number } | null = null;
  let adobeTransform: number | null = null;
  let scans = 0;
  let ended = false;

  let offset = 2;
  while (offset < buf.length && !ended) {
    if (buf[offset] !== 0xff) reject("The JPEG is damaged (expected a marker).");
    while (offset + 1 < buf.length && buf[offset + 1] === 0xff) offset++; // fill bytes
    if (offset + 1 >= buf.length) reject("The JPEG is cut off.");
    const marker = buf[offset + 1];
    offset += 2;

    if (marker === EOI) {
      out.push(Buffer.from([0xff, EOI]));
      ended = true; // anything after EOI is dropped
      break;
    }
    if (marker === SOI || marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      reject("The JPEG is damaged (a marker is out of place).");
    }
    if (offset + 2 > buf.length) reject("The JPEG is cut off.");
    const length = buf.readUInt16BE(offset);
    if (length < 2 || offset + length > buf.length) reject("The JPEG is cut off.");
    const segment = Buffer.concat([Buffer.from([0xff, marker]), buf.subarray(offset, offset + length)]);
    const payload = buf.subarray(offset + 2, offset + length);
    offset += length;

    if (marker >= 0xe0 && marker <= 0xef) {
      // APPn (JFIF, EXIF, XMP, ICC, Adobe...): metadata, dropped. Adobe's
      // APP14 can say a 3-component image is stored as RGB rather than
      // YCbCr; the new JFIF header would then mis-color it, so that is refused below.
      if (marker === 0xee && payload.length >= 12 && payload.toString("latin1", 0, 5) === "Adobe") {
        adobeTransform = payload[11];
      }
      continue;
    }
    if (marker === 0xfe) continue; // comment, dropped
    if (KEPT_TABLES.has(marker)) {
      out.push(segment);
      continue;
    }
    if (SUPPORTED_SOF.has(marker)) {
      if (frame) reject("The JPEG has more than one frame.");
      if (payload.length < 6) reject("The JPEG frame header is damaged.");
      const precision = payload[0];
      const height = payload.readUInt16BE(1);
      const width = payload.readUInt16BE(3);
      const components = payload[5];
      if (precision !== 8 || payload.length !== 6 + 3 * components) reject("The JPEG frame header is not supported.");
      if (components !== 1 && components !== 3) {
        reject("Only grayscale or color (RGB) JPEGs are accepted; save CMYK images as RGB or PNG.");
      }
      if (height === 0) reject("The JPEG does not state its height.");
      checkDimensions(width, height);
      frame = { width, height, components };
      out.push(segment);
      continue;
    }
    if (marker === SOS) {
      if (!frame) reject("The JPEG image data comes before its frame header.");
      out.push(segment);
      // Entropy-coded data runs to the next marker that is neither a stuffed
      // 0x00 nor a restart marker.
      const start = offset;
      let i = offset;
      for (;;) {
        if (i + 1 >= buf.length) reject("The JPEG is cut off in its image data.");
        if (buf[i] === 0xff) {
          const next = buf[i + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      out.push(buf.subarray(start, i));
      offset = i;
      scans++;
      continue;
    }
    // Arithmetic coding, lossless or hierarchical frames, DNL and the like.
    reject(`The JPEG uses an unsupported feature (marker 0x${marker.toString(16).toUpperCase()}); save it as a standard JPEG or PNG.`);
  }

  if (!frame) reject("The JPEG has no frame header.");
  if (scans === 0) reject("The JPEG has no image data.");
  if (!ended) reject("The JPEG is cut off (no end marker).");
  if (frame.components === 3 && adobeTransform === 0) {
    reject("This JPEG stores its colors as RGB, which some programs misread; save it as a standard JPEG or PNG.");
  }
  return { mediaType: "image/jpeg", bytes: Buffer.concat(out), widthPx: frame.width, heightPx: frame.height };
}
