import { sha256Hex } from "../../text";
import { childElements, decodeXmlEntities, elementText, firstChild, parseXml, tokenizeXml, type XmlElement, type XmlNode } from "./xml";

// Reading the Office of the Law Revision Counsel's USLM XML (United States
// Legislative Markup, the format of the U.S. Code downloads at
// https://uscode.house.gov/download.html; the USLM User Guide is
// linked from that page). Pure: the adapters fetch, this file reads.
//
// - listUslmSections(): every section of a title, found without building a
//   tree of the whole title (Title 18 is about 12 MB), each with its place
//   in the title (title, part, chapter, subchapter, with their numbers and
//   headings as the XML states them).
// - readUslmSection(): one section as clean text, in the order the Code
//   prints it: the section heading, its text, its footnotes, the source
//   credit, then the notes (editorial notes, statutory notes and related
//   subsidiaries, the uncodified provisions set out as notes), plus the
//   facts the XML states (status, source credit, the dates of its acts).
// - inaSectionFromSourceCredit(): the Immigration and Nationality Act
//   section a Title 8 section was enacted as, read from its source credit.

/** The levels above a section that a reader navigates by. */
const HIERARCHY = new Set(["title", "subtitle", "part", "subpart", "chapter", "subchapter", "division", "subdivision"]);

export type UslmLevel = { level: string; identifier: string | null; num: string | null; heading: string | null };

export type UslmSectionEntry = {
  /** The OLRC identifier: "/us/usc/t8/s1101", or for a grouped entry "/us/usc/t8/s1...18" or "/us/usc/t8/s31 /us/usc/t8/s32". */
  identifier: string;
  /** Offsets of the <section> element in the title's XML. */
  start: number;
  end: number;
  /** The status attribute ("repealed", "transferred", "omitted", ...), null when in force. */
  status: string | null;
  ancestry: UslmLevel[];
};

export type UslmTitleMeta = {
  /** dc:title, "Title 8". */
  title: string | null;
  /** docNumber, "8". */
  docNumber: string | null;
  /** docPublicationName, "Online@119-120". */
  publicationName: string | null;
  /** The is-positive-law property, "yes" or "no". */
  positiveLaw: string | null;
  /** dcterms:created. */
  created: string | null;
};

function stripTags(fragment: string): string {
  return decodeXmlEntities(fragment.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** The title's <meta> block. */
export function readUslmTitleMeta(xml: string): UslmTitleMeta {
  const metaEnd = xml.indexOf("</meta>");
  const meta = metaEnd > 0 ? xml.slice(0, metaEnd) : "";
  const field = (re: RegExp) => {
    const m = re.exec(meta);
    return m ? stripTags(m[1]) || null : null;
  };
  return {
    title: field(/<dc:title>([\s\S]*?)<\/dc:title>/),
    docNumber: field(/<docNumber>([\s\S]*?)<\/docNumber>/),
    publicationName: field(/<docPublicationName>([\s\S]*?)<\/docPublicationName>/),
    positiveLaw: field(/<property role="is-positive-law">([\s\S]*?)<\/property>/),
    created: field(/<dcterms:created>([\s\S]*?)<\/dcterms:created>/),
  };
}

type OpenSection = { identifier: string; status: string | null; start: number; depth: number; ancestry: UslmLevel[] };
type Capture = { field: "num" | "heading"; level: UslmLevel; from: number; depth: number };

/**
 * Every section of the title whose identifier starts with `/us/usc/t<title>/s`,
 * in document order. Sections quoted inside notes (amendments, uncodified
 * acts) are part of the section that quotes them, never entries of their own.
 */
export function listUslmSections(xml: string, titleNumber: string): UslmSectionEntry[] {
  const prefix = `/us/usc/t${titleNumber}/s`;
  type Frame = { name: string; level: UslmLevel | null };
  const stack: Frame[] = [];
  const entries: UslmSectionEntry[] = [];
  const state: { section: OpenSection | null; capture: Capture | null } = { section: null, capture: null };

  tokenizeXml(xml, {
    open(name, attrs, start, end, selfClosing) {
      const parent = stack[stack.length - 1];
      const quoted = stack.some((f) => f.name === "quotedContent");
      if (!state.section && !quoted && name === "section" && (attrs.identifier ?? "").startsWith(prefix)) {
        state.section = {
          identifier: attrs.identifier,
          status: attrs.status ?? null,
          start,
          depth: stack.length,
          ancestry: stack.filter((f) => f.level).map((f) => ({ ...(f.level as UslmLevel) })),
        };
      }
      if (!state.section && !state.capture && !selfClosing && parent?.level && (name === "num" || name === "heading") && parent.level[name] === null) {
        state.capture = { field: name, level: parent.level, from: end, depth: stack.length };
      }
      const level = !state.section && !quoted && HIERARCHY.has(name) ? { level: name, identifier: attrs.identifier ?? null, num: null, heading: null } : null;
      stack.push({ name, level });
    },
    close(name, start, end) {
      const top = stack.pop();
      if (!top || top.name !== name) throw new Error(`USLM: </${name}> does not close <${top?.name ?? "nothing"}> at ${start}`);
      const capture = state.capture;
      if (capture && stack.length === capture.depth && name === capture.field) {
        // "CHAPTER 12—" as printed: the dash that joins it to the heading is not part of the number.
        capture.level[capture.field] = stripTags(xml.slice(capture.from, start)).replace(/[—\s-]+$/, "") || null;
        state.capture = null;
      }
      const section = state.section;
      if (section && name === "section" && stack.length === section.depth) {
        entries.push({ identifier: section.identifier, start: section.start, end, status: section.status, ancestry: section.ancestry });
        state.section = null;
      }
    },
  });
  return entries;
}

/**
 * The section numbers an identifier names: "s1101" gives ["1101"], "s1...18"
 * gives ["1", "18"] (a range), "s31 .../s32" gives ["31", "32"]. The en dash
 * of a number like "1440–1" is written as the hyphen the OLRC's own section
 * addresses and citations use ("1440-1").
 */
export function sectionNumbers(identifier: string): { numbers: string[]; range: boolean } {
  const numbers: string[] = [];
  let range = false;
  for (const part of identifier.trim().split(/\s+/)) {
    const m = /\/s([^/\s]+)$/.exec(part);
    if (!m) continue;
    const value = m[1].replace(/–/g, "-");
    if (value.includes("...")) {
      range = true;
      numbers.push(...value.split("...").filter(Boolean));
    } else numbers.push(value);
  }
  return { numbers, range };
}

// --- one section as text ---------------------------------------------------

/** Hierarchical units of the Code's text: each starts a line, its sub-units one step further in. */
const LEVELS = new Set([
  "section",
  "subsection",
  "paragraph",
  "subparagraph",
  "clause",
  "subclause",
  "item",
  "subitem",
  "subsubitem",
  "level",
  "title",
  "subtitle",
  "part",
  "subpart",
  "chapter",
  "subchapter",
  "division",
  "subdivision",
  "article",
]);
/** Blocks that start a line. */
const LINE_BLOCKS = new Set(["p", "continuation", "proviso", "signature", "tocItem", "header", "tr", "caption", "row", "def"]);
/** Blocks set off by a blank line. */
const PARAGRAPH_BLOCKS = new Set(["note", "notes", "sourceCredit", "table", "toc", "layout", "quotedContent"]);
/** Elements whose content is not text. */
const SKIP = new Set(["img", "colgroup", "col", "meta"]);
/** A heading under one of these stands on its own line; a level's heading continues its number's line. */
const HEADING_ON_ITS_OWN = new Set(["note", "notes", "quotedContent", "toc", "layout"]);

// The text is built as a stream of pieces with markers: LINE starts a line
// (followed by one DEPTH mark per step of indentation), BLANK between two
// LINEs asks for a blank line. finish() turns the stream into lines.
const LINE = "\u0001";
const DEPTH = "\u0002";
const BLANK = "\u0003";

type RenderState = { out: string[]; footnotes: { num: string; text: string }[] };

function startLine(state: RenderState, depth: number): void {
  state.out.push(`${LINE}${DEPTH.repeat(Math.max(0, depth))}`);
}

function blankLine(state: RenderState): void {
  state.out.push(`${LINE}${BLANK}${LINE}`);
}

function render(node: XmlNode, parent: XmlElement | null, depth: number, state: RenderState, cells: { n: number } | null): void {
  if (typeof node === "string") {
    // Soft hyphens (U+00AD) mark where a printed line may break; they are not text and would split words for search.
    state.out.push(node.replace(/­/g, "").replace(/\s+/g, " "));
    return;
  }
  const el = node;
  if (SKIP.has(el.name)) return;
  if (el.name === "note" && el.attrs.type === "footnote") {
    // A footnote's text sits where its marker is; the Code prints it under the section's text.
    const num = elementText(firstChild(el, "num") ?? "") || String(state.footnotes.length + 1);
    const text = elementText({ ...el, children: el.children.filter((c) => typeof c === "string" || c.name !== "num") });
    state.footnotes.push({ num, text });
    return;
  }
  if (el.name === "br") {
    startLine(state, depth);
    return;
  }
  if ((el.name === "ref" && /\bfootnoteRef\b/.test(el.attrs.class ?? "")) || el.name === "sup") {
    const text = elementText(el);
    if (text) state.out.push(`[${text}]`);
    return;
  }
  if (el.name === "td" || el.name === "th" || el.name === "column") {
    if (cells && cells.n++ > 0) state.out.push(el.name === "column" ? "  " : " | ");
    for (const c of el.children) render(c, el, depth, state, null);
    return;
  }

  const level = LEVELS.has(el.name);
  const paragraph = PARAGRAPH_BLOCKS.has(el.name);
  const ownLine = level || LINE_BLOCKS.has(el.name) || (el.name === "heading" && parent !== null && HEADING_ON_ITS_OWN.has(parent.name));
  if (paragraph) blankLine(state);
  if (paragraph || ownLine) startLine(state, depth);
  const rowCells = el.name === "tr" || el.name === "tocItem" || el.name === "header" ? { n: 0 } : null;
  for (const c of el.children) {
    // Within a level, its sub-levels and paragraphs sit one step in; text that
    // continues the level after its sub-levels returns to the level's own depth.
    const childDepth = level && !(typeof c !== "string" && c.name === "continuation") ? depth + 1 : depth;
    render(c, el, childDepth, state, rowCells);
    // A heading the Code prints on a line of its own ("(a) Cancellation of removal
    // for certain permanent residents") is not run into the text after it; one
    // that ends in a dash ("(1) In general.—") is.
    if (level && typeof c !== "string" && c.name === "heading" && !/[—\-.:]\s*$/.test(elementText(c))) startLine(state, depth + 1);
  }
  if (paragraph) blankLine(state);
  else if (ownLine) startLine(state, depth);
}

function finish(parts: string[]): string {
  const out: string[] = [];
  for (const segment of parts.join("").split(LINE)) {
    if (segment === BLANK) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    let depth = 0;
    while (segment[depth] === DEPTH) depth++;
    const text = segment.slice(depth).replace(/\s+/g, " ").trim();
    if (text) out.push(`${"  ".repeat(Math.min(depth, 8))}${text}`);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  while (out.length && out[0] === "") out.shift();
  return out.join("\n");
}

export type UslmSection = {
  identifier: string;
  /** The num element's value attribute ("1101", "1 to 18"). */
  numValue: string | null;
  /** The number as printed ("§ 1101."). */
  numText: string | null;
  /** The section heading ("Definitions"). */
  heading: string | null;
  status: string | null;
  /** The section's text, footnotes, source credit and notes. */
  text: string;
  /** The text without the notes (the section, its footnotes and the source credit). */
  bodyText: string;
  sourceCredit: string | null;
  /** Headings of the section's notes, in order ("References in Text", "Amendments", "Short Title", ...). */
  noteHeadings: string[];
  /** The dates the source credit states (ISO, from its date elements), in order. */
  sourceCreditDates: string[];
};

function footnoteBlock(state: RenderState): string[] {
  if (!state.footnotes.length) return [];
  const parts = [`${LINE}${BLANK}${LINE}`];
  for (const f of state.footnotes) parts.push(`${LINE}[${f.num}] ${f.text}`);
  return parts;
}

/** One section, from the slice of the title's XML that holds it. */
export function readUslmSection(xml: string, entry: Pick<UslmSectionEntry, "identifier" | "start" | "end" | "status">): UslmSection {
  const el = parseXml(xml, entry.start, entry.end);
  if (el.name !== "section") throw new Error(`USLM: the element at ${entry.start} is <${el.name}>, not a section`);
  const numEl = firstChild(el, "num");
  const headingEl = firstChild(el, "heading");
  const sourceCreditEl = firstChild(el, "sourceCredit");
  const notesEls = childElements(el, "notes");

  // The heading line, the section's own text, its footnotes, then the source credit.
  const body: RenderState = { out: [[elementText(numEl ?? ""), elementText(headingEl ?? "")].filter(Boolean).join(" "), LINE], footnotes: [] };
  for (const c of el.children) {
    if (typeof c !== "string" && (c === numEl || c === headingEl || c === sourceCreditEl || c.name === "notes")) continue;
    render(c, el, 0, body, null);
  }
  const bodyText = finish([...body.out, ...footnoteBlock(body), ...(sourceCreditEl ? [`${LINE}${BLANK}${LINE}`, elementText(sourceCreditEl)] : [])]);
  const notes: RenderState = { out: [], footnotes: [] };
  for (const n of notesEls) render(n, el, 0, notes, null);
  const notesText = finish([...notes.out, ...footnoteBlock(notes)]);

  const noteHeadings: string[] = [];
  for (const notesEl of notesEls) {
    for (const note of childElements(notesEl, "note")) {
      const h = firstChild(note, "heading");
      const text = h ? elementText(h) : "";
      if (text) noteHeadings.push(text);
    }
  }
  const sourceCreditDates: string[] = [];
  if (sourceCreditEl) {
    const walk = (n: XmlNode) => {
      if (typeof n === "string") return;
      if (n.name === "date" && /^\d{4}-\d{2}-\d{2}$/.test(n.attrs.date ?? "")) sourceCreditDates.push(n.attrs.date);
      n.children.forEach(walk);
    };
    walk(sourceCreditEl);
  }
  return {
    identifier: entry.identifier,
    numValue: numEl?.attrs.value ?? null,
    numText: numEl ? elementText(numEl) || null : null,
    heading: headingEl ? elementText(headingEl) || null : null,
    status: entry.status,
    text: notesText ? `${bodyText}\n\n${notesText}` : bodyText,
    bodyText,
    sourceCredit: sourceCreditEl ? elementText(sourceCreditEl) || null : null,
    noteHeadings,
    sourceCreditDates,
  };
}

/** A change signal for a section: its rendered text (the generated element ids change with every release, the text does not). */
export function uslmSectionFingerprint(section: UslmSection): string {
  return sha256Hex([section.identifier, section.status ?? "", section.text].join("\u0000")).slice(0, 32);
}

/**
 * The section of the Immigration and Nationality Act (act June 27, 1952,
 * ch. 477) a Title 8 section was enacted as, read from the opening of its
 * source credit: "(June 27, 1952, ch. 477, title II, ch. 4, § 240A, as added
 * ..." gives "240A"; "§ 237, formerly ch. 5, § 241" gives "237" (the current
 * number comes first). Null when the source credit does not open with the
 * Act: the section came from another law.
 */
export function inaSectionFromSourceCredit(sourceCredit: string | null): string | null {
  if (!sourceCredit) return null;
  const m = /^\(?\s*June 27, 1952, ch\. 477,(?:\s*title [IVX]+,)?(?:\s*ch\. \d+[A-Z]?,)?\s*§\s*(\d{3}[A-Z]?)\b/.exec(sourceCredit);
  return m ? m[1] : null;
}
