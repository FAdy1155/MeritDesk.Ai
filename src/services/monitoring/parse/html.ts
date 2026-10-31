// Small, dependency-free HTML and RSS helpers for the official listing pages
// the monitor reads. Each parser in this folder targets one page's known
// markup; a page whose markup changes yields no rows, which the collector
// reports as a failed check. Nothing here guesses at content.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  sect: "§",
  para: "¶",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  Ntilde: "Ñ",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  ccedil: "ç",
};

/** Decodes HTML character references; an unknown named reference is left as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ref] ?? NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

const BLOCK_TAGS = "p|div|li|tr|h[1-6]|table|tbody|thead|ul|ol|blockquote|pre|section|article|header|footer";

/**
 * Visible text of an HTML fragment: comments, scripts and styles dropped,
 * block boundaries and <br> as line breaks, table cells separated by a
 * space, entities decoded, whitespace collapsed within each line, empty
 * lines removed.
 */
export function htmlToText(fragment: string): string {
  let s = fragment
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<\/t[dh]\s*>/gi, " ")
    .replace(/<[^>]*>/g, "");
  s = decodeEntities(s);
  return s
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** htmlToText on one line. */
export function inlineText(fragment: string): string {
  return htmlToText(fragment).replace(/\n+/g, " ").trim();
}

/** The value of one attribute in a tag's attribute text (quoted or unquoted), entities decoded. */
export function attrValue(attributes: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attributes);
  if (!m) return null;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
}

export type Anchor = { href: string; text: string; inner: string; index: number };

/** Every <a> in a fragment with its href (as written, entities decoded) and visible text. */
export function anchors(fragment: string): Anchor[] {
  const out: Anchor[] = [];
  const cleaned = fragment.replace(/<!--[\s\S]*?-->/g, (c) => " ".repeat(c.length));
  for (const m of cleaned.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = attrValue(m[1], "href");
    if (href === null) continue;
    out.push({ href, text: inlineText(m[2]), inner: m[2], index: m.index ?? 0 });
  }
  return out;
}

/** An href resolved against the page it appeared on; null when it is not a URL. */
export function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href.trim(), base).toString();
  } catch {
    return null;
  }
}

/**
 * The part of a page from the first occurrence of `startMarker` to the
 * earliest of `endMarkers` after it (or the end of the page); null when the
 * start marker is missing.
 */
export function sliceBetween(html: string, startMarker: string | RegExp, endMarkers: (string | RegExp)[]): string | null {
  const start = typeof startMarker === "string" ? html.indexOf(startMarker) : html.search(startMarker);
  if (start < 0) return null;
  const rest = html.slice(start);
  let end = rest.length;
  for (const marker of endMarkers) {
    const at = typeof marker === "string" ? rest.indexOf(marker, 1) : searchFrom(rest, marker, 1);
    if (at > 0 && at < end) end = at;
  }
  return rest.slice(0, end);
}

function searchFrom(text: string, pattern: RegExp, from: number): number {
  const found = text.slice(from).search(pattern);
  return found < 0 ? -1 : found + from;
}

/**
 * The body field of a justice.gov (Drupal) page: everything from the
 * "field_body" container to the updated-date line, the book navigation or
 * the end of the article, whichever comes first.
 */
export function justiceGovBody(html: string): string | null {
  return sliceBetween(html, "field_body", [
    '<div class="node-updated-date',
    '<nav class="book-navigation',
    "</article>",
    "<footer",
  ]);
}

/** The "Updated <date>" line justice.gov prints under a page, if any. */
export function justiceGovUpdatedLine(html: string): string | null {
  const m = /<div class="node-updated-date[^"]*">\s*([^<]*?)\s*<\/div>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() || null : null;
}

/** Table rows of a fragment, each as its cells' inner HTML. */
export function tableRows(fragment: string): string[][] {
  const rows: string[][] = [];
  for (const row of fragment.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)].map((c) => c[1]);
    rows.push(cells);
  }
  return rows;
}

/** <item> elements of an RSS document, each as its inner XML. */
export function rssItems(xml: string): string[] {
  return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)].map((m) => m[1]);
}

/** The text of one child element of an RSS item, CDATA unwrapped and entities decoded. */
export function rssField(itemXml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i").exec(itemXml);
  if (!m) return null;
  const raw = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
  return decodeEntities(cdata ? cdata[1] : raw).trim();
}
