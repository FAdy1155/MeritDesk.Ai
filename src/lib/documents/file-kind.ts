// What kind of file a stored document is, judged from its bytes first and
// its browser-reported MIME type / file name second (both of those come from
// the uploader and can be wrong). Shared by the document-ingest job (which
// extractor to run) and the skill runner (what the model can read natively).
// Pure functions, no I/O.

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export type FileKind =
  | { kind: "pdf" }
  | { kind: "image"; mediaType: ImageMediaType }
  | { kind: "docx" }
  | { kind: "text" }
  | { kind: "other" };

const TEXT_MIME_TYPES = new Set(["application/json", "application/xml", "message/rfc822"]);
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "xml", "eml", "html", "htm", "log"]);
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

/** Image formats the Claude API accepts, identified by magic bytes. */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"; // "GIF8"
  // "RIFF" .... "WEBP"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

/** "%PDF-" within the first 1 KB (the spec allows leading junk before the header). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024));
  return head.indexOf("%PDF-", 0, "latin1") !== -1;
}

/**
 * Classifies a document. With bytes, the content decides for PDFs and images
 * (a .pdf that is really a JPEG is an image). Without bytes, only the MIME
 * type and extension are available, which is enough to decide whether it is
 * worth downloading the bytes at all.
 */
export function detectFileKind(params: { bytes?: Uint8Array; mimeType: string | null; fileName: string }): FileKind {
  const mime = (params.mimeType ?? "").toLowerCase().split(";")[0].trim();
  const ext = extensionOf(params.fileName);

  if (params.bytes) {
    if (looksLikePdf(params.bytes)) return { kind: "pdf" };
    const imageType = sniffImageMediaType(params.bytes);
    if (imageType) return { kind: "image", mediaType: imageType };
    // .docx is a zip ("PK\x03\x04"); only call it docx when the name or type says so too.
    if (startsWith(params.bytes, [0x50, 0x4b, 0x03, 0x04]) && (mime === DOCX_MIME || ext === "docx")) {
      return { kind: "docx" };
    }
  } else {
    if (mime === "application/pdf" || ext === "pdf") return { kind: "pdf" };
    const byName: Record<string, ImageMediaType> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
    };
    if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime)) {
      return { kind: "image", mediaType: mime as ImageMediaType };
    }
    if (byName[ext]) return { kind: "image", mediaType: byName[ext] };
    if (mime === DOCX_MIME || ext === "docx") return { kind: "docx" };
  }

  if (mime.startsWith("text/") || TEXT_MIME_TYPES.has(mime) || TEXT_EXTENSIONS.has(ext)) return { kind: "text" };
  return { kind: "other" };
}

/**
 * Pixel dimensions from an image's header, for the API's image-size rules.
 * Covers the four formats the API accepts; null when the header can't be read.
 */
export function readImageDimensions(bytes: Uint8Array, mediaType: ImageMediaType): { width: number; height: number } | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    switch (mediaType) {
      case "image/png":
        // IHDR is always the first chunk: width and height are big-endian at 16 and 20.
        return buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
      case "image/gif":
        return buf.length >= 10 ? { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) } : null;
      case "image/webp":
        return readWebpDimensions(buf);
      case "image/jpeg":
        return readJpegDimensions(buf);
    }
  } catch {
    return null; // truncated or malformed header
  }
}

function readWebpDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 30) return null;
  const chunk = buf.toString("latin1", 12, 16);
  if (chunk === "VP8X") {
    // 24-bit little-endian canvas width-1 and height-1.
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  if (chunk === "VP8 ") {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

function readJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  // Walk the marker segments to the first start-of-frame (SOF0-SOF15, except
  // DHT C4, JPG C8 and DAC CC), which carries height then width.
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // standalone markers carry no length
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    if (marker === 0xda || length < 2) return null; // start of scan before any frame header
    offset += 2 + length;
  }
  return null;
}
