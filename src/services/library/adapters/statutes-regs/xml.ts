// A small, dependency-free XML reader for the official XML these collectors
// read: the Office of the Law Revision Counsel's USLM titles of the U.S.
// Code and GovInfo's bulk eCFR titles. Both are large, well-formed, machine
// generated files, so the reader is non-validating: it tokenizes start and
// end tags, text, CDATA, comments, processing instructions and a DOCTYPE,
// decodes the predefined and numeric character references, and drops
// namespace prefixes from element and attribute names. Pure: no I/O.
//
// tokenizeXml() walks a document (or a slice of one) without building
// anything, so a collector can find the elements it wants in a 30 MB title
// and build a tree (parseXml) only for those slices.

export type XmlElement = { name: string; attrs: Record<string, string>; children: XmlNode[] };
export type XmlNode = XmlElement | string;

export class XmlSyntaxError extends Error {
  constructor(detail: string, at: number) {
    super(`The XML is not well formed (${detail}, at character ${at}).`);
    this.name = "XmlSyntaxError";
  }
}

const PREDEFINED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodes XML character references; an unknown named reference is left as written. */
export function decodeXmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return PREDEFINED[ref] ?? whole;
  });
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon >= 0 ? name.slice(colon + 1) : name;
}

export type XmlTokenHandler = {
  /** A start tag (or an empty-element tag, with selfClosing). start and end are the tag's own offsets. */
  open?(name: string, attrs: Record<string, string>, start: number, end: number, selfClosing: boolean): void;
  /** An end tag (also called right after open for an empty-element tag). */
  close?(name: string, start: number, end: number): void;
  /** Character data, entities decoded (CDATA as written). */
  text?(text: string, start: number, end: number): void;
};

const NAME_END = /[\s/>]/;

function parseAttributes(tag: string, offset: number): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0;
  const n = tag.length;
  while (i < n) {
    while (i < n && /\s/.test(tag[i])) i++;
    if (i >= n) break;
    let j = i;
    while (j < n && tag[j] !== "=" && !/\s/.test(tag[j])) j++;
    const name = tag.slice(i, j);
    while (j < n && /\s/.test(tag[j])) j++;
    if (tag[j] !== "=") {
      // A bare attribute name is not XML; skip it rather than fail on a tolerant reader's input.
      i = j + 1;
      continue;
    }
    j++;
    while (j < n && /\s/.test(tag[j])) j++;
    const quote = tag[j];
    if (quote !== '"' && quote !== "'") throw new XmlSyntaxError(`attribute ${name} is not quoted`, offset + j);
    const close = tag.indexOf(quote, j + 1);
    if (close < 0) throw new XmlSyntaxError(`attribute ${name} is not closed`, offset + j);
    if (name) attrs[localName(name)] = decodeXmlEntities(tag.slice(j + 1, close));
    i = close + 1;
  }
  return attrs;
}

/**
 * Walks `xml` from `from` to `to`, calling the handler for each token.
 * Throws XmlSyntaxError on an unterminated construct; tag balance is the
 * caller's concern (parseXml checks it).
 */
export function tokenizeXml(xml: string, handler: XmlTokenHandler, from = 0, to = xml.length): void {
  let pos = from;
  while (pos < to) {
    const lt = xml.indexOf("<", pos);
    const textEnd = lt < 0 || lt > to ? to : lt;
    if (textEnd > pos && handler.text) handler.text(decodeXmlEntities(xml.slice(pos, textEnd)), pos, textEnd);
    if (textEnd >= to) break;
    pos = lt;
    if (xml.startsWith("<!--", pos)) {
      const end = xml.indexOf("-->", pos + 4);
      if (end < 0) throw new XmlSyntaxError("a comment is not closed", pos);
      pos = end + 3;
    } else if (xml.startsWith("<![CDATA[", pos)) {
      const end = xml.indexOf("]]>", pos + 9);
      if (end < 0) throw new XmlSyntaxError("a CDATA section is not closed", pos);
      if (handler.text) handler.text(xml.slice(pos + 9, end), pos, end + 3);
      pos = end + 3;
    } else if (xml.startsWith("<?", pos)) {
      const end = xml.indexOf("?>", pos + 2);
      if (end < 0) throw new XmlSyntaxError("a processing instruction is not closed", pos);
      pos = end + 2;
    } else if (xml.startsWith("<!", pos)) {
      // DOCTYPE, with an internal subset when there is a "[" before the first ">".
      const gt = xml.indexOf(">", pos);
      const bracket = xml.indexOf("[", pos);
      const end = bracket >= 0 && (gt < 0 || bracket < gt) ? xml.indexOf("]>", bracket) + 1 : gt;
      if (end <= 0) throw new XmlSyntaxError("a declaration is not closed", pos);
      pos = end + 1;
    } else if (xml[pos + 1] === "/") {
      const end = xml.indexOf(">", pos + 2);
      if (end < 0) throw new XmlSyntaxError("an end tag is not closed", pos);
      if (handler.close) handler.close(localName(xml.slice(pos + 2, end).trim()), pos, end + 1);
      pos = end + 1;
    } else {
      // A start tag: find its ">" outside quoted attribute values.
      let i = pos + 1;
      let quote: string | null = null;
      for (; i < xml.length; i++) {
        const c = xml[i];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
      }
      if (i >= xml.length) throw new XmlSyntaxError("a start tag is not closed", pos);
      const selfClosing = xml[i - 1] === "/";
      const inner = xml.slice(pos + 1, selfClosing ? i - 1 : i);
      const nameEnd = inner.search(NAME_END);
      const rawName = nameEnd < 0 ? inner : inner.slice(0, nameEnd);
      if (!rawName) throw new XmlSyntaxError("a tag has no name", pos);
      const name = localName(rawName);
      const attrs = nameEnd < 0 ? {} : parseAttributes(inner.slice(nameEnd), pos + 1 + nameEnd);
      if (handler.open) handler.open(name, attrs, pos, i + 1, selfClosing);
      if (selfClosing && handler.close) handler.close(name, i + 1, i + 1);
      pos = i + 1;
    }
  }
}

/** The tree of the first element in `xml` (or in xml.slice(from, to)); throws XmlSyntaxError when tags do not balance. */
export function parseXml(xml: string, from = 0, to = xml.length): XmlElement {
  const root: XmlElement = { name: "#document", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  tokenizeXml(
    xml,
    {
      open(name, attrs) {
        const el: XmlElement = { name, attrs, children: [] };
        stack[stack.length - 1].children.push(el);
        stack.push(el);
      },
      close(name, start) {
        const top = stack[stack.length - 1];
        if (stack.length === 1 || top.name !== name) throw new XmlSyntaxError(`</${name}> does not close <${top.name}>`, start);
        stack.pop();
      },
      text(text) {
        if (stack.length > 1) stack[stack.length - 1].children.push(text);
      },
    },
    from,
    to
  );
  if (stack.length !== 1) throw new XmlSyntaxError(`<${stack[stack.length - 1].name}> is not closed`, to);
  const first = root.children.find((c): c is XmlElement => typeof c !== "string");
  if (!first) throw new XmlSyntaxError("no element", from);
  return first;
}

/** The element children of `el`, optionally only those named `name`. */
export function childElements(el: XmlElement, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) if (typeof c !== "string" && (name === undefined || c.name === name)) out.push(c);
  return out;
}

/** The first element child named `name`, or null. */
export function firstChild(el: XmlElement, name: string): XmlElement | null {
  for (const c of el.children) if (typeof c !== "string" && c.name === name) return c;
  return null;
}

/** Every text node under `el`, concatenated, whitespace runs collapsed and trimmed. */
export function elementText(el: XmlNode): string {
  const parts: string[] = [];
  const walk = (n: XmlNode) => {
    if (typeof n === "string") parts.push(n);
    else for (const c of n.children) walk(c);
  };
  walk(el);
  // Soft hyphens (U+00AD) only mark where a printed line may break.
  return parts.join("").replace(/­/g, "").replace(/\s+/g, " ").trim();
}

/**
 * The offset just after the end tag that closes the element whose start tag
 * begins at `start` (same name, nesting counted); -1 when it is not closed.
 */
export function elementEnd(xml: string, start: number, name: string): number {
  let depth = 0;
  let result = -1;
  const stop = new Error("stop");
  try {
    tokenizeXml(
      xml,
      {
        open(n) {
          if (n === name) depth++;
        },
        close(n, _s, end) {
          if (n !== name) return;
          depth--;
          if (depth === 0) {
            result = end;
            throw stop;
          }
        },
      },
      start
    );
  } catch (err) {
    if (err !== stop) throw err;
  }
  return result;
}
