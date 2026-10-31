import { sha256Hex } from "../../text";
import { decodeXmlEntities, elementText, firstChild, parseXml, tokenizeXml, type XmlElement, type XmlNode } from "./xml";

// Reading GovInfo's bulk eCFR XML (https://www.govinfo.gov/bulkdata/ECFR,
// one file per title, the text of the Electronic Code of Federal
// Regulations as of the date in its AMDDATE element). Pure: the adapters
// fetch, this file reads.
//
// The file nests DIV1 (title or volume), DIV2 (subtitle), DIV3 (chapter),
// DIV4 (subchapter), DIV5 (part), DIV6 (subpart), DIV7 (subject group),
// DIV8 (section) and DIV9 (appendix), each opening with a HEAD; a part
// also states its Authority (AUTH) and Source (SOURCE). Sections close
// with their source note (CITA, "[61 FR 18908, Apr. 29, 1996, as amended
// at ...]") and any editorial or effective-date notes.

export type CfrLevel = { type: string; n: string; head: string | null };

export type CfrEntry = {
  kind: "section" | "appendix";
  /** The DIV's N attribute as written ("§ 1003.38", "Appendix E"). */
  n: string;
  /** The section number ("1003.38"), or for an appendix the identifier its heading opens with ("Appendix E to Part 62"). */
  identifier: string;
  /** The HEAD, whitespace collapsed ("§ 1003.38 Appeals."). */
  head: string;
  part: string;
  subpart: string | null;
  /** Chapter, subchapter, part, subpart and subject group above it, as the file names them. */
  ancestry: CfrLevel[];
  /** The heading says "[Reserved]". */
  reserved: boolean;
  start: number;
  end: number;
};

export type CfrPartInfo = { head: string | null; authority: string | null; source: string | null };

const DIV_TYPES: Record<string, string> = {
  DIV1: "title",
  DIV2: "subtitle",
  DIV3: "chapter",
  DIV4: "subchapter",
  DIV5: "part",
  DIV6: "subpart",
  DIV7: "subject_group",
  DIV8: "section",
  DIV9: "appendix",
};

function stripTags(fragment: string): string {
  return decodeXmlEntities(fragment.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

export type EcfrAmendedDate = { at: number; text: string };

/**
 * The "amended through" dates the file states ("Oct. 9, 2026"), one AMDDATE
 * per volume, each with its position. A title printed in several volumes
 * gives each volume its own date (21 CFR volume 1 can say Sept. 8 while the
 * volume holding part 1308 says Oct. 9), so a section takes the date of the
 * volume it is in (amendedDateAt), never the file's first.
 */
export function readEcfrAmendedDates(xml: string): EcfrAmendedDate[] {
  const out: EcfrAmendedDate[] = [];
  const re = /<AMDDATE>([\s\S]*?)<\/AMDDATE>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const text = stripTags(m[1]);
    if (text) out.push({ at: m.index, text });
  }
  return out;
}

/** The AMDDATE of the volume a position is in: the last one stated before it; null when none is. */
export function amendedDateAt(dates: readonly EcfrAmendedDate[], position: number): string | null {
  let found: string | null = null;
  for (const d of dates) {
    if (d.at > position) break;
    found = d.text;
  }
  return found;
}

/** The section number in a DIV8's N: "§ 1003.38" gives "1003.38". */
export function sectionNumberOf(n: string): string {
  return n.replace(/^§+\s*/, "").replace(/\s+/g, " ").trim();
}

/** "Appendix E to Part 62—Unskilled Occupations" gives "Appendix E to Part 62". */
export function appendixIdentifierOf(head: string): string {
  return head.split(/\s*—\s*/)[0].replace(/\s*\[Reserved\]\s*$/i, "").trim();
}

type Frame = { name: string; level: CfrLevel | null; start: number; part: CfrPartInfo | null };
type Capture = { tag: "HEAD" | "AUTH" | "SOURCE"; frame: Frame; from: number; depth: number };

/**
 * Every section and appendix in the file, with the part and subpart it is
 * in, in document order. Parts are told apart by their N; `parts` keeps
 * only those (null keeps all).
 */
export function listEcfrEntries(xml: string, parts: ReadonlySet<string> | null = null): { entries: CfrEntry[]; partInfo: Map<string, CfrPartInfo> } {
  const stack: Frame[] = [];
  const entries: CfrEntry[] = [];
  const partInfo = new Map<string, CfrPartInfo>();
  const state: { capture: Capture | null } = { capture: null };

  tokenizeXml(xml, {
    open(name, attrs, start, end, selfClosing) {
      const type = DIV_TYPES[name];
      const parent = stack[stack.length - 1];
      if (!state.capture && !selfClosing && parent?.level && (name === "HEAD" || ((name === "AUTH" || name === "SOURCE") && parent.part))) {
        state.capture = { tag: name, frame: parent, from: end, depth: stack.length };
      }
      stack.push({
        name,
        level: type ? { type, n: attrs.N ?? "", head: null } : null,
        start,
        part: type === "part" ? { head: null, authority: null, source: null } : null,
      });
    },
    close(name, start, end) {
      const frame = stack.pop();
      if (!frame || frame.name !== name) throw new Error(`eCFR XML: </${name}> does not close <${frame?.name ?? "nothing"}> at ${start}`);
      const capture = state.capture;
      if (capture && stack.length === capture.depth && name === capture.tag) {
        const text = stripTags(xml.slice(capture.from, start)) || null;
        if (capture.tag === "HEAD" && capture.frame.level && capture.frame.level.head === null) capture.frame.level.head = text;
        if (capture.frame.part) {
          if (capture.tag === "HEAD") capture.frame.part.head = text;
          else if (capture.tag === "AUTH") capture.frame.part.authority = text?.replace(/^Authority:\s*/i, "") ?? null;
          else capture.frame.part.source = text?.replace(/^Source:\s*/i, "") ?? null;
        }
        state.capture = null;
      }
      const level = frame.level;
      if (!level) return;
      if (level.type === "part" && frame.part) partInfo.set(level.n, frame.part);
      if (level.type !== "section" && level.type !== "appendix") return;
      const partFrame = [...stack].reverse().find((f) => f.level?.type === "part");
      const part = partFrame?.level?.n ?? "";
      if (parts && !parts.has(part)) return;
      const subpartFrame = [...stack].reverse().find((f) => f.level?.type === "subpart");
      const head = level.head ?? "";
      const identifier = level.type === "section" ? sectionNumberOf(level.n) : appendixIdentifierOf(head) || level.n;
      entries.push({
        kind: level.type,
        n: level.n,
        identifier,
        head,
        part,
        subpart: subpartFrame?.level?.n ? subpartFrame.level.n.replace(/^Subpart\s+/i, "") : null,
        ancestry: stack.filter((f) => f.level && f.level.type !== "title").map((f) => ({ ...(f.level as CfrLevel) })),
        reserved: /\[Reserved\]/i.test(head),
        start: frame.start,
        end,
      });
    },
  });
  return { entries, partInfo };
}

// --- one section as text ---------------------------------------------------

/** Blocks that start a line. */
const LINE_BLOCKS = new Set([
  "P",
  "FP",
  "FP1",
  "FP2",
  "FP-1",
  "FP-2",
  "FP-DASH",
  "P1",
  "P2",
  "HD1",
  "HD2",
  "HD3",
  "HD4",
  "HED",
  "PSPACE",
  "LI",
  "TR",
  "FL",
  "STARS",
  "HALFDASH",
  "SUBTI",
  "TCAP",
  "BCAP",
  "LDRWK",
  "LDRFIG",
  "REVTXT",
  "RESERVED",
  "DOCKETHD",
  "FRP",
  "AC",
]);
/** Blocks set off by a blank line. */
const PARAGRAPH_BLOCKS = new Set(["CITA", "EDNOTE", "EFFDNOT", "NOTE", "EXTRACT", "EXAMPLE", "FTNT", "APPRO", "SECAUTH", "PARAUTH", "CROSSREF", "TABLE", "BOXTXT", "AUTH", "SOURCE"]);
const SKIP = new Set(["img", "GPH", "PRTPAGE", "FTREF"]);

const LINE = "\u0001";
const BLANK = "\u0003";

function render(node: XmlNode, out: string[], cells: { n: number } | null): void {
  if (typeof node === "string") {
    // Soft hyphens (U+00AD) mark where a printed line may break; they are not text and would split words for search.
    out.push(node.replace(/­/g, "").replace(/\s+/g, " "));
    return;
  }
  const el = node;
  if (SKIP.has(el.name)) return;
  if (el.name === "br") {
    out.push(LINE);
    return;
  }
  if (el.name === "SU" || el.name === "sup") {
    // Superscripts are footnote markers and exponents alike; "^" keeps either readable.
    const text = elementText(el);
    if (text) out.push(`^${text}`);
    return;
  }
  if (el.name === "TD" || el.name === "TH" || el.name === "ENT") {
    if (cells && cells.n++ > 0) out.push(" | ");
    for (const c of el.children) render(c, out, null);
    return;
  }
  const paragraph = PARAGRAPH_BLOCKS.has(el.name);
  const line = paragraph || LINE_BLOCKS.has(el.name) || el.name === "ROW";
  if (paragraph) out.push(`${LINE}${BLANK}${LINE}`);
  else if (line) out.push(LINE);
  const rowCells = el.name === "TR" || el.name === "ROW" ? { n: 0 } : null;
  for (const c of el.children) render(c, out, rowCells);
  if (paragraph) out.push(`${LINE}${BLANK}${LINE}`);
  else if (line) out.push(LINE);
}

function finish(parts: string[]): string {
  const out: string[] = [];
  for (const segment of parts.join("").split(LINE)) {
    if (segment === BLANK) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const text = segment.replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  while (out.length && out[0] === "") out.shift();
  return out.join("\n");
}

export type CfrEntryText = {
  /** The heading, whitespace collapsed ("§ 1003.38 Appeals."). */
  head: string;
  /** The heading without its number ("Appeals."). */
  subject: string;
  /** The whole entry as clean text: heading, paragraphs, tables, source note and notes. */
  text: string;
  /** The source note ("[61 FR 18908, Apr. 29, 1996, as amended at ...]"), when the entry has one. */
  sourceNote: string | null;
  /** Editorial and effective-date notes, when there are any. */
  notes: string[];
};

/** One section or appendix as text, from the slice of the file that holds it. */
export function readEcfrEntry(xml: string, entry: Pick<CfrEntry, "start" | "end" | "kind">): CfrEntryText {
  const el: XmlElement = parseXml(xml, entry.start, entry.end);
  const headEl = firstChild(el, "HEAD");
  const head = headEl ? elementText(headEl) : "";
  const out: string[] = [head];
  for (const c of el.children) {
    if (c === headEl) continue;
    // An XREF right under the section is the eCFR's notice of an amendment
    // published but not yet in this text ("Link to an amendment published at
    // 91 FR 61984, Sept. 30, 2026."): a line of its own, not part of the heading.
    if (typeof c !== "string" && c.name === "XREF") out.push(LINE);
    render(c, out, null);
    if (typeof c !== "string" && c.name === "XREF") out.push(LINE);
  }
  const notes: string[] = [];
  let sourceNote: string | null = null;
  for (const c of el.children) {
    if (typeof c === "string") continue;
    if (c.name === "CITA" && !sourceNote) sourceNote = elementText(c) || null;
    if (c.name === "EDNOTE" || c.name === "EFFDNOT" || c.name === "NOTE" || c.name === "XREF") {
      // Rendered as blocks, so "Editorial Note:" and its text do not run together.
      const parts: string[] = [];
      render(c, parts, null);
      const text = finish(parts).replace(/\s*\n+\s*/g, " ").trim();
      if (text) notes.push(text);
    }
  }
  const subject =
    entry.kind === "section"
      ? head.replace(/^§+\s*[\w.\-–]+\s*/, "").trim()
      : head.includes("—")
        ? head.slice(head.indexOf("—") + 1).trim()
        : head;
  return { head, subject, text: finish(out), sourceNote, notes };
}

/** A change signal for an entry: its text and place (the NODE attributes are positions and are left out). */
export function cfrEntryFingerprint(entry: CfrEntry, text: CfrEntryText): string {
  return sha256Hex([entry.identifier, entry.part, entry.subpart ?? "", text.text].join("\u0000")).slice(0, 32);
}
