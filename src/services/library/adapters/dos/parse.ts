import { anchors, attrValue, htmlToText, inlineText, pageTitle, resolveUrl } from "../../extract/html";

// Pure page parsers for the Department of State collectors in this folder
// (and the USCIS page that names the Visa Bulletin chart for filing, whose
// parsers are in ./parse-bulletin.ts). Each reads one official page's known
// markup and returns what it states; a page whose markup is not recognized
// yields null or recognized: false, and the adapter fails the run with a
// LibraryLayoutError instead of reporting a quiet day. No network, no
// database: they can be tried on saved pages.

// ---------------------------------------------------------------------------
// Shared

/**
 * A page's bytes as text: the charset the response header names, else the
 * one the page declares in a <meta> tag, else UTF-8. fam.state.gov serves
 * Word-generated pages as text/html with no charset and declares
 * iso-8859-1 in the page (decoded as windows-1252, as browsers do).
 */
export function decodeHtml(body: Buffer, headerCharset: string | null): string {
  const declared =
    headerCharset ??
    /<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString("latin1"))?.[1]?.toLowerCase() ??
    null;
  if (declared && declared !== "utf-8" && declared !== "utf8") {
    try {
      return new TextDecoder(declared).decode(body);
    } catch {
      // an unknown charset: read as UTF-8
    }
  }
  return body.toString("utf-8");
}

/** The part of `html` from the element containing `startMarker` to the earliest end marker after it; null without the start marker. */
export function sliceFrom(html: string, startMarker: string, endMarkers: string[], backToTag = "<div"): string | null {
  const at = html.indexOf(startMarker);
  if (at < 0) return null;
  const tagStart = html.lastIndexOf(backToTag, at);
  const rest = html.slice(tagStart >= 0 ? tagStart : at);
  let end = rest.length;
  for (const marker of endMarkers) {
    const found = rest.indexOf(marker, 1);
    if (found > 0 && found < end) end = found;
  }
  return rest.slice(0, end);
}

/** Text with its whitespace runs collapsed. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "June 2026" (anywhere in the text) as { key: "2026-06", label: "June 2026" }; null when no month and four-digit year are stated. */
export function statedMonth(text: string): { key: string; label: string; year: number; month: number } | null {
  const m = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s*,?\s+(\d{4})\b/i.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
  const year = Number(m[2]);
  const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return { key: `${year}-${String(month).padStart(2, "0")}`, label: `${name} ${year}`, year, month };
}

export function monthNumber(name: string): number | null {
  const at = MONTHS.indexOf(name.toLowerCase());
  return at < 0 ? null : at + 1;
}

// ---------------------------------------------------------------------------
// Tables

export type HtmlTable = {
  /** Offsets of the <table> tag and just past its </table> in the HTML given. */
  start: number;
  end: number;
  /** 0 for a table not inside another one. */
  depth: number;
  caption: string | null;
  /** Each row's cells as visible text; a nested table's text is left out of the cell that holds it. */
  rows: string[][];
};

function cellText(inner: string): string {
  return inlineText(inner.replace(/<br\s*\/?>/gi, " "));
}

/**
 * Every table of a fragment with its rows, nested tables included (each on
 * its own). Tolerates the omitted </td> and </tr> older pages have.
 */
export function htmlTables(html: string): HtmlTable[] {
  type Open = {
    start: number;
    depth: number;
    rows: string[][];
    row: string[] | null;
    cellStart: number | null;
    nested: [number, number][];
    captionStart: number | null;
    caption: string | null;
  };
  const out: HtmlTable[] = [];
  const stack: Open[] = [];
  const closeCell = (t: Open, at: number) => {
    if (t.cellStart === null) return;
    let inner = "";
    let pos = t.cellStart;
    for (const [s, e] of t.nested) {
      if (s >= pos && s <= at) {
        inner += html.slice(pos, s);
        pos = Math.min(e, at);
      }
    }
    inner += html.slice(pos, at);
    (t.row ??= []).push(cellText(inner));
    t.cellStart = null;
    t.nested = [];
  };
  const closeRow = (t: Open, at: number) => {
    closeCell(t, at);
    if (t.row) t.rows.push(t.row);
    t.row = null;
  };
  for (const m of html.matchAll(/<(\/?)(table|tr|td|th|caption)\b[^>]*>/gi)) {
    const at = m.index ?? 0;
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const top = stack[stack.length - 1];
    if (tag === "table") {
      if (!closing) {
        stack.push({ start: at, depth: stack.length, rows: [], row: null, cellStart: null, nested: [], captionStart: null, caption: null });
      } else if (top) {
        closeRow(top, at);
        stack.pop();
        const end = at + m[0].length;
        out.push({ start: top.start, end, depth: top.depth, caption: top.caption, rows: top.rows });
        const parent = stack[stack.length - 1];
        if (parent && parent.cellStart !== null) parent.nested.push([top.start, end]);
      }
      continue;
    }
    if (!top) continue;
    if (tag === "caption") {
      if (!closing) top.captionStart = at + m[0].length;
      else if (top.captionStart !== null) {
        top.caption = inlineText(html.slice(top.captionStart, at)) || null;
        top.captionStart = null;
      }
      continue;
    }
    if (tag === "tr") {
      closeRow(top, at);
      if (!closing) top.row = [];
      continue;
    }
    // td or th
    closeCell(top, at);
    if (!closing) {
      top.row ??= [];
      top.cellStart = at + m[0].length;
    }
  }
  while (stack.length) {
    const t = stack.pop()!;
    closeRow(t, html.length);
    out.push({ start: t.start, end: html.length, depth: t.depth, caption: t.caption, rows: t.rows });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Removes blocks a page hides off screen (a div positioned at left:-10000px
 * holding a stray table). The Visa Bulletin pages carry several, left over
 * from the editor, with dates that are not part of the bulletin; they are
 * invisible to readers and must not be read as charts.
 */
export function dropOffscreenBlocks(html: string): string {
  return html.replace(/<div\b[^>]*style\s*=\s*["'][^"']*left\s*:\s*-\d{3,}px[^"']*["'][^>]*>[\s\S]*?<\/table>\s*<\/div>/gi, " ");
}

// ---------------------------------------------------------------------------
// Foreign Affairs Manual (fam.state.gov)

export type FamTocLeaf = {
  /** The page's own identifier, from its file name: "09FAM050201", "07FAM0200apA". */
  id: string;
  /** As the table of contents lists it: "502.1 IV CLASSIFICATIONS OVERVIEW". */
  text: string;
  url: string;
  /** The chapter and part headings above it, outermost first. */
  path: string[];
};

type FamTreeNode = { id?: unknown; text?: unknown; url?: unknown; items?: unknown };

/**
 * The leaves (subchapters and appendices) of one volume's table of contents,
 * as /api/Tree/GetTreeByVolumeId returns it; null when the answer is not
 * that tree. Leaves whose link is not a page of the volume are reported in
 * `skipped`.
 */
export function parseFamTree(data: unknown, volumeId: string, baseUrl: string): { leaves: FamTocLeaf[]; skipped: string[] } | null {
  if (!Array.isArray(data)) return null;
  const leaves: FamTocLeaf[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const pagePattern = new RegExp(`/FAM/${volumeId}/(${volumeId}[0-9A-Za-z]+)\\.html?$`, "i");
  const walk = (nodes: unknown[], path: string[]) => {
    for (const raw of nodes) {
      if (!raw || typeof raw !== "object") continue;
      const node = raw as FamTreeNode;
      const text = typeof node.text === "string" ? collapse(node.text) : "";
      if (typeof node.url === "string" && node.url) {
        const url = resolveUrl(node.url, baseUrl);
        const id = url ? pagePattern.exec(new URL(url).pathname)?.[1] : undefined;
        if (!url || !id) skipped.push(`${text || "(untitled)"} (${node.url})`);
        else if (!seen.has(id.toUpperCase())) {
          seen.add(id.toUpperCase());
          leaves.push({ id, text, url, path });
        }
      }
      if (Array.isArray(node.items) && node.items.length) walk(node.items, text ? [...path, text] : path);
    }
  };
  walk(data, []);
  return { leaves, skipped };
}

export type FamTransmittal = { number: string; date: string | null; title: string | null; summary: string | null };

/**
 * The change transmittals a volume's "View Changes" page lists (the page
 * builds its table from a JSON array in a script); null when the page has
 * no such array. An empty array is a valid answer: the page lists only
 * recent transmittals.
 */
export function parseFamChanges(html: string): FamTransmittal[] | null {
  const m = /\bvar\s+ds\s*=\s*(\[[\s\S]*?\])\s*;\s*\n/.exec(html);
  if (!m) return null;
  let rows: unknown;
  try {
    rows = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  return rows
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
    .map((r) => ({
      number: typeof r.DisplayNumber === "string" ? r.DisplayNumber.trim() : "",
      date: typeof r.Date === "string" ? r.Date.slice(0, 10) : null,
      title: typeof r.Title === "string" ? collapse(r.Title) : null,
      summary: typeof r.Summary === "string" ? htmlToText(r.Summary) || null : null,
    }))
    .filter((r) => r.number);
}

export type FamSection = {
  /** The page's <title>: "9 FAM 502.1 IV CLASSIFICATIONS OVERVIEW". */
  title: string | null;
  /** The subchapter (or appendix) number line: "9 FAM 502.1", "7 FAM 200 APPENDIX A". */
  citation: string | null;
  /** The subchapter's name line under its number. */
  heading: string | null;
  /** The chapter line above it, when the page prints one: "9 FAM 502 Immigrant visa classifications". */
  chapter: string | null;
  /** The subchapter's own change-transmittal line: "(CT:VISA-2198; 08-18-2026)". */
  ctLine: string | null;
  transmittal: string | null;
  transmittalDateText: string | null;
  officeOfOrigin: string | null;
  /** The page body (the Word sections), for the text. */
  bodyHtml: string;
};

function paragraphOfClass(html: string, cls: string): string | null {
  const m = new RegExp(`<p\\b[^>]*class=["']?${cls}(?=["'\\s>])[^>]*>([\\s\\S]*?)<\\/p>`, "i").exec(html);
  return m ? m[1] : null;
}

/** One FAM page (a subchapter or an appendix), as fam.state.gov serves it; null when it is not a FAM page. */
export function parseFamSection(html: string): FamSection | null {
  const bodyStart = html.search(/<div\b[^>]*class=["']?WordSection\d/i);
  if (bodyStart < 0 || !/class=["']?FAM/i.test(html)) return null;
  const bodyEnd = html.search(/<\/body\s*>/i);
  const bodyHtml = html.slice(bodyStart, bodyEnd > bodyStart ? bodyEnd : undefined);
  const numberHtml = paragraphOfClass(bodyHtml, "FAMHeading20SubchapterNumber");
  const headingHtml = paragraphOfClass(bodyHtml, "FAMHeading20");
  const chapterHtml = paragraphOfClass(bodyHtml, "FAMHeading22");
  const ctHtml = paragraphOfClass(bodyHtml, "FAMCTLineCentered");
  const ctText = ctHtml ? htmlToText(ctHtml) : null;
  const ctLine = ctText ? (/\(CT:[^)]*\)/.exec(ctText)?.[0] ?? null) : null;
  const ct = ctLine ? /CT:\s*([A-Z]+-\d+)\s*;\s*([0-9]{1,2}-[0-9]{1,2}-[0-9]{4})/.exec(ctLine.replace(/\s+/g, " ")) : null;
  return {
    title: pageTitle(html),
    citation: numberHtml ? inlineText(numberHtml) || null : null,
    heading: headingHtml ? inlineText(headingHtml) || null : null,
    chapter: chapterHtml ? inlineText(chapterHtml.replace(/<br\s*\/?>/gi, " ")) || null : null,
    ctLine: ctLine ? collapse(ctLine) : null,
    transmittal: ct?.[1] ?? null,
    transmittalDateText: ct?.[2] ?? null,
    officeOfOrigin: ctText ? (/Office of Origin:\s*([^)]+)\)/.exec(ctText)?.[1]?.trim() ?? null) : null,
    bodyHtml,
  };
}

// ---------------------------------------------------------------------------
// travel.state.gov (the Bureau of Consular Affairs site)

/**
 * The main copy of a travel.state.gov page: from the main-copy frame to the
 * right rail, the hidden shelf or the external-link dialog, whichever comes
 * first. Null when the page does not have that frame.
 */
export function travelMainCopy(html: string): string | null {
  return sliceFrom(html, "tsg-rwd-main-copy-body-frame", [
    '<div class="tsg-rwd-right-rail',
    "tsg-rwd-shelf-for-hidden-iParsys",
    'id="ExternalPopup"',
    "<footer",
  ]);
}

/** The page's heading (the <h1> in the main copy), else its <title>. */
export function travelHeading(html: string, main: string | null): string | null {
  const h1 = main ? /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(main)?.[1] : undefined;
  return (h1 ? inlineText(h1) : "") || pageTitle(html);
}

/**
 * The main copy as document HTML: hidden off-screen blocks, the accordions'
 * "open all / close all" controls (page furniture, not the page's words) and
 * the travel-advisory banner country pages embed (a separate publication,
 * reissued on its own schedule) left out.
 */
export function travelDocumentHtml(main: string): string {
  let html = main;
  const advisory = html.search(/<div\b[^>]*class=["']tsg-rwd-csi-travel-advisories["']/i);
  const after = advisory >= 0 ? html.indexOf("tsg-rwd-csi-travel-rss", advisory) : -1;
  if (advisory >= 0 && after > advisory) html = html.slice(0, advisory) + html.slice(html.lastIndexOf("<div", after));
  return dropOffscreenBlocks(html)
    .replace(/<(a|div)\b[^>]*class=["'][^"']*(?:All-control|_all_button)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<a\b[^>]*name=["']inner-content["'][^>]*>[\s\S]*?<\/a>/gi, " ");
}

export type PageLink = { url: string; text: string; title: string | null };

/**
 * Links in a fragment to travel.state.gov pages whose path matches
 * `pathPattern`, resolved against the page, without query or fragment,
 * each once (the first link text kept).
 */
export function travelLinks(fragment: string, pageUrl: string, pathPattern: RegExp): PageLink[] {
  const out: PageLink[] = [];
  const seen = new Set<string>();
  const cleaned = fragment.replace(/<!--[\s\S]*?-->/g, " ");
  for (const m of cleaned.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = attrValue(m[1], "href");
    if (!href || /^(javascript:|mailto:|#)/i.test(href.trim())) continue;
    const resolved = resolveUrl(href, pageUrl);
    if (!resolved) continue;
    const url = new URL(resolved);
    if (url.protocol !== "https:" || url.hostname !== "travel.state.gov" || !pathPattern.test(url.pathname)) continue;
    url.hash = "";
    url.search = "";
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: key, text: inlineText(m[2]), title: attrValue(m[1], "title") });
  }
  return out;
}

/** A travel.state.gov page's identifier: its path under /content/travel/en/, without ".html" ("us-visas/Visa-Reciprocity-and-Civil-Documents-by-Country/Egypt"). */
export function travelPageId(url: string): string {
  const path = new URL(url).pathname;
  return path.replace(/^\/content\/travel\/en\//, "").replace(/\.html?$/i, "");
}

export type ReciprocityRow = { visaClassification: string; fee: string; entries: string; validity: string };

/**
 * The reciprocity schedule table of a country page (visa classification,
 * fee, number of entries, validity period), each value as stated; empty
 * when the page has none.
 */
export function parseReciprocityRows(main: string, tables: HtmlTable[] = htmlTables(main)): ReciprocityRow[] {
  for (const table of tables) {
    const header = table.rows[0]?.map((c) => c.toLowerCase()) ?? [];
    if (header.length < 4 || !/visa\s*classification/.test(header[0]) || !/fee/.test(header[1])) continue;
    return table.rows
      .slice(1)
      .filter((r) => r.length >= 4 && r[0])
      .map((r) => ({ visaClassification: r[0], fee: r[1], entries: r[2], validity: r[3] }));
  }
  return [];
}

// ---------------------------------------------------------------------------
// BridgeUSA (j1visa.state.gov, WordPress)

export type SitemapEntry = { loc: string; lastmod: string | null };

/** The <loc> and <lastmod> of each <sitemap> or <url> of a sitemap document; null when it is neither kind. */
export function parseSitemap(xml: string): { kind: "index" | "urlset"; entries: SitemapEntry[] } | null {
  const kind = /<sitemapindex\b/i.test(xml) ? "index" : /<urlset\b/i.test(xml) ? "urlset" : null;
  if (!kind) return null;
  const tag = kind === "index" ? "sitemap" : "url";
  const entries: SitemapEntry[] = [];
  for (const m of xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))) {
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(m[1])?.[1];
    if (!loc) continue;
    entries.push({ loc: loc.replace(/&amp;/g, "&"), lastmod: /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i.exec(m[1])?.[1] ?? null });
  }
  return { kind, entries };
}

export type WordPressArticle = {
  /** The page heading; for a post of the site's blog this is the blog's name ("Route J-1"). */
  title: string | null;
  /** A blog post's own title (the heading of its post block), when the page is a post. */
  postTitle: string | null;
  /** A post's categories as its "category tag" links name them. */
  categories: string[];
  bodyHtml: string;
  publishedIso: string | null;
  modifiedIso: string | null;
};

/**
 * A j1visa.state.gov page or post: its heading, the content from the page
 * heading (#page-title, which every template of the site's theme prints) to
 * the related-resources sidebar, the site map or the footer, and the dates
 * its metadata states; null when the page has no page heading. The left
 * navigation comes before the heading and is not read.
 */
export function parseBridgeUsaPage(html: string): WordPressArticle | null {
  const body = sliceFrom(
    html,
    'id="page-title"',
    ['<div class="sub-col"', 'id="site-map"', 'id="footer"', '<div class="footer"', "<footer"],
    "<h1"
  );
  if (!body || !/^<h1\b/i.test(body)) return null;
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1] ?? /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const meta = (property: string) => {
    for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
      if ((attrValue(m[1], "property") ?? attrValue(m[1], "name"))?.toLowerCase() === property) return attrValue(m[1], "content");
    }
    return null;
  };
  const post = sliceFrom(body, 'class="post-', ["</h2>"], "<div");
  const postHeading = post ? /<h2\b[^>]*>([\s\S]*)$/i.exec(post)?.[1] : undefined;
  return {
    title: (h1 ? inlineText(h1) : "") || meta("og:title") || pageTitle(html),
    postTitle: postHeading ? inlineText(postHeading) || null : null,
    categories: [...body.matchAll(/<a\b[^>]*rel=["']category tag["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => inlineText(m[1])).filter(Boolean),
    bodyHtml: body,
    publishedIso: meta("article:published_time"),
    modifiedIso: meta("article:modified_time"),
  };
}

// ---------------------------------------------------------------------------
// State Department press releases (www.state.gov, WordPress)

export type FeedItem = {
  title: string;
  link: string;
  guid: string | null;
  /** The WordPress post number in the guid ("https://www.state.gov/releases/preview/664759/"). */
  postId: string | null;
  pubDate: string | null;
  creator: string | null;
  /** The item's description (the release's own words), as text. */
  descriptionText: string;
  categories: string[];
};

function xmlField(item: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i").exec(item);
  if (!m) return null;
  const raw = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
  return cdata ? cdata[1] : raw;
}

/** The items of an RSS 2.0 feed; null when the document is not an RSS feed. */
export function parseRssFeed(xml: string): FeedItem[] | null {
  if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml)) return null;
  const items: FeedItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)) {
    const item = m[1];
    const title = inlineText(xmlField(item, "title") ?? "");
    const link = (xmlField(item, "link") ?? "").trim();
    if (!title || !link) continue;
    const guid = xmlField(item, "guid")?.trim() ?? null;
    items.push({
      title,
      link,
      guid,
      postId: guid ? (/\/preview\/(\d+)\/?$/.exec(guid)?.[1] ?? /[?&]p=(\d+)/.exec(guid)?.[1] ?? null) : null,
      pubDate: xmlField(item, "pubDate")?.trim() ?? null,
      creator: xmlField(item, "dc:creator") ? inlineText(xmlField(item, "dc:creator")!) : null,
      descriptionText: htmlToText(xmlField(item, "description") ?? ""),
      categories: [...item.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)].map((c) => inlineText(c[1].replace(/^<!\[CDATA\[|\]\]>$/g, ""))),
    });
  }
  return items;
}

export type PressArticle = {
  postId: string | null;
  title: string | null;
  documentType: string | null;
  bureau: string | null;
  publishDateText: string | null;
  modifiedIso: string | null;
  bodyHtml: string;
  tags: string[];
};

/** A www.state.gov release page: its article, heading, document type, bureau, stated date and body; null without the article. */
export function parsePressArticle(html: string): PressArticle | null {
  const article = sliceFrom(html, "<article", ["</article>", "</main>"], "<article");
  if (!article) return null;
  const pick = (cls: string) => {
    const m = new RegExp(`<(?:p|div|span)\\b[^>]*class=["'][^"']*${cls}[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:p|div|span)>`, "i").exec(article);
    return m ? inlineText(m[1]) || null : null;
  };
  const heroEnd = article.search(/<\/section>/i);
  const afterHero = heroEnd >= 0 ? article.slice(heroEnd + "</section>".length) : article;
  const tagsAt = afterHero.search(/<div\b[^>]*class=["'][^"']*wp-block-tags-block/i);
  const bodyHtml = tagsAt >= 0 ? afterHero.slice(0, tagsAt) : afterHero;
  const tagBlock = tagsAt >= 0 ? afterHero.slice(tagsAt) : "";
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(article)?.[1];
  let modifiedIso: string | null = null;
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    if (attrValue(m[1], "property") === "article:modified_time") modifiedIso = attrValue(m[1], "content");
  }
  return {
    postId: /<article\b[^>]*\bid=["']post-(\d+)["']/i.exec(article)?.[1] ?? null,
    title: h1 ? inlineText(h1) || null : null,
    documentType: pick("doctype-meta"),
    bureau: pick("article-meta__author-bureau"),
    publishDateText: pick("article-meta__publish-date"),
    modifiedIso,
    bodyHtml,
    tags: anchors(tagBlock)
      .map((a) => a.text)
      .filter(Boolean),
  };
}

/**
 * Whether a release concerns visas or immigration, by its own title and
 * opening words: visas and visa restrictions, immigration and migration,
 * refugees and asylum, deportation, exchange visitors and the Immigration
 * and Nationality Act, named in the title or the first OPENING_CHARS
 * characters (a joint statement that mentions migration in its tenth
 * paragraph is not a release on immigration). Releases about passports
 * alone, assistance to citizens abroad, travel of officials or foreign
 * policy generally are left out.
 */
const OPENING_CHARS = 600;

export function isVisaRelevant(title: string, opening: string): boolean {
  const text = `${title}\n${opening.replace(/\s+/g, " ").trim().slice(0, OPENING_CHARS)}`;
  return /\bvisas?\b|\bimmigra(?:nt|nts|tion)\b|\bmigra(?:nt|nts|tion)\b|\brefugees?\b|\basylum\b|\bdeport(?:ation|ed|ing)?\b|\bImmigration and Nationality Act\b|\bINA\b|\bentry (?:ban|restrictions?)\b|\btravel (?:ban|restrictions?)\b|\bexchange visitors?\b|\bJ-1\b|\bH-1B\b|\bdiversity visa\b|\b212\(a\)\(3\)\(C\)/i.test(
    text
  );
}
