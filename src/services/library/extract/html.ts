import { anchors, attrValue, decodeEntities, inlineText, resolveUrl, tableRows } from "@/services/monitoring/parse/html";
import { cleanText } from "../text";

// HTML to clean text for library documents, and the small parsing helpers
// adapters use on listing pages (re-exported from the monitor's dependency
// free helpers, so there is one copy of each). Unlike the monitor's
// htmlToText, which reads listings line by line, htmlToDocumentText keeps a
// document's shape: headings and paragraphs separated by blank lines, list
// items as "- " lines, table cells joined with " | ", page furniture
// (scripts, styles, navigation, headers, footers, forms) left out.

export { anchors, attrValue, decodeEntities, inlineText, resolveUrl, tableRows };
export { htmlToText } from "@/services/monitoring/parse/html";

const DROP_ELEMENTS = ["script", "style", "noscript", "template", "svg", "iframe", "object", "nav", "header", "footer", "aside", "form", "button", "select"];
const BLOCK = "p|div|section|article|main|blockquote|pre|address|figure|figcaption|dl|dt|dd|table|thead|tbody|tfoot|ul|ol|hr";

/**
 * The main content of a page: the first of <main> or <article>, else
 * <body>, else the whole document. An adapter that knows the page's
 * content container (justice.gov's field_body, for one) slices that instead.
 */
export function mainContent(html: string): string {
  for (const pattern of [/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i, /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i, /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i]) {
    const m = pattern.exec(html);
    if (m && m[1].trim()) return m[1];
  }
  return html;
}

/** Removes every element named in DROP_ELEMENTS (with its content), comments included. */
function dropFurniture(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of DROP_ELEMENTS) {
    s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
    s = s.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ");
  }
  return s;
}

/**
 * A document's visible text with its structure kept: headings and blocks
 * separated by blank lines, list items "- ", table rows one per line with
 * cells joined by " | ", <br> as a line break, entities decoded.
 */
export function htmlToDocumentText(fragment: string): string {
  let s = dropFurniture(fragment);
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<h([1-6])\b[^>]*>/gi, "\n\n")
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li\s*>/gi, "\n")
    .replace(/<tr\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>\s*(?=<t[dh]\b)/gi, " | ")
    .replace(/<\/tr\s*>/gi, "\n")
    .replace(new RegExp(`<\\/?(?:${BLOCK})\\b[^>]*>`, "gi"), "\n\n")
    .replace(/<[^>]*>/g, "");
  s = decodeEntities(s);
  const lines = s.split("\n").map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim());
  const out: string[] = [];
  for (const line of lines) {
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    if (line === "-") continue;
    out.push(line);
  }
  return cleanText(out.join("\n"));
}

/** The text of the page's <title>, entities decoded; null when it has none. */
export function pageTitle(html: string): string | null {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const text = m ? inlineText(m[1]) : "";
  return text || null;
}

/** The content of a <meta name="..."> or <meta property="..."> tag; null when absent. */
export function metaContent(html: string, name: string): string | null {
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = m[1];
    const key = attrValue(attrs, "name") ?? attrValue(attrs, "property");
    if (key && key.toLowerCase() === name.toLowerCase()) return attrValue(attrs, "content");
  }
  return null;
}
