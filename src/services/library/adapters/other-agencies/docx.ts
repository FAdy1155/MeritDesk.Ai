import { inflateRawSync } from "node:zlib";
import { decodeEntities } from "../../extract/html";

// Text of a Word .docx file, for the agency documents that are only
// published that way (OMB supporting statements on reginfo.gov, some
// Regulations.gov attachments). A .docx is a ZIP archive; its body is
// word/document.xml. This reads the archive's central directory, inflates
// that one entry and keeps the visible text: paragraphs as lines, table
// cells joined with " | ", tabs and line breaks as written. Deleted text
// of tracked changes and field codes are left out. Pure: no I/O.

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_XML_BYTES = 64 * 1024 * 1024;

/** The bytes of one archive entry; null when the archive cannot be read or has no such entry. */
function zipEntry(zip: Buffer, name: string): Buffer | null {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries && at + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(at) !== CENTRAL) return null;
    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    const entryName = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== LOCAL) return null;
    const start = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const data = zip.subarray(start, start + compressedSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) {
      try {
        return inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES });
      } catch {
        return null;
      }
    }
    return null;
  }
  return null;
}

/** The document's visible text; null when the bytes are not a readable .docx. */
export function docxText(bytes: Buffer): string | null {
  const xml = zipEntry(bytes, "word/document.xml");
  if (!xml) return null;
  const s = xml
    .toString("utf8")
    .replace(/<w:delText\b[\s\S]*?<\/w:delText>/g, "")
    .replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, "")
    // A cell's paragraphs run on within the cell; cells are joined with " | ".
    .replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, (cell) => cell.replace(/<\/w:p>/g, " "))
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:(?:br|cr)\b[^>]*\/>/g, "\n")
    .replace(/<\/w:tc>/g, " | ")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "");
  const lines = decodeEntities(s)
    .split("\n")
    .map((line) => line.replace(/[ \u00a0]+/g, " ").replace(/(?:\s*\|\s*)+$/, "").trim());
  const out: string[] = [];
  for (const line of lines) {
    if (!line && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}
