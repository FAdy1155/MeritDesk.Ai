import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { anchors, attrValue, decodeEntities, htmlToText, inlineText, resolveUrl } from "../../extract/html";
import { repairMojibake } from "../../text";

// Parsers for the uscis.gov pages, feeds and files the USCIS policy
// collectors read. Pure, so they can be tried on saved pages. uscis.gov is a
// Drupal site, and its pages share a few patterns this file reads:
//
// - a content page: <main> holding one <article class="node node--type-...">
//   with the h1.page-title, the field--name-body, and the "Release Date" and
//   "Last Reviewed/Updated" lines (each a <time>);
// - a listing ("views"): one div.views-row per entry (linked title, a
//   <time>, a teaser in views-field-body), a "1 - 10 of N" counter and a
//   mini pager whose "next" link is followed for the next page;
// - the listings' RSS feeds (https://www.uscis.gov/news/rss-feed/<id>):
//   <item> with title, link, description, pubDate (a two-digit year) and a
//   guid;
// - the site map (https://www.uscis.gov/sitemap.xml, an index of pages of
//   <url><loc><lastmod>), the only list of every file the site publishes;
// - the Policy Manual: its "Print Manual" export (one page with every
//   volume, part and chapter, and the Updates list), each chapter's page
//   (Guidance, Resources, Appendices and Updates tabs, "Current as of"), and
//   the Updates page (policy alerts and technical updates).

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** One-line text of an HTML fragment, entities decoded and double-encoding repaired. */
export function lineText(fragment: string): string {
  return repairMojibake(inlineText(fragment));
}

/** The text after `marker` up to the earliest of `ends` (or the end); null when the marker is missing. */
export function sliceFrom(html: string, marker: string | RegExp, ends: (string | RegExp)[]): string | null {
  const start = typeof marker === "string" ? html.indexOf(marker) : html.search(marker);
  if (start < 0) return null;
  const rest = html.slice(start);
  let end = rest.length;
  for (const e of ends) {
    const at = typeof e === "string" ? rest.indexOf(e, 1) : searchAfter(rest, e, 1);
    if (at > 0 && at < end) end = at;
  }
  return rest.slice(0, end);
}

function searchAfter(text: string, pattern: RegExp, from: number): number {
  const found = text.slice(from).search(pattern);
  return found < 0 ? -1 : found + from;
}

/**
 * The element that starts at `start` (an opening <tag ...>), through its
 * matching close tag, counting nested elements of the same name; to the end
 * of the text when it is never closed.
 */
export function sliceElement(html: string, start: number, tag: string): string {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return html.slice(start);
}

/** Screen-reader-only labels ("Alert Type info") and visually hidden blocks, which are not part of the page's text. */
export function dropHiddenLabels(html: string): string {
  return html
    .replace(/<span\b[^>]*class="[^"]*\busa-sr-only\b[^"]*"[^>]*>[\s\S]*?<\/span\s*>/gi, " ")
    .replace(/<(div|span)\b[^>]*class="[^"]*\bvisually-hidden\b[^"]*"[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
}

/**
 * An http:// link to uscis.gov as https: the same resource, which the site
 * serves only over https (older pages still link http://). Any other URL is
 * returned unchanged.
 */
export function httpsForUscis(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" && /(^|\.)uscis\.gov$/i.test(u.hostname)) {
      u.protocol = "https:";
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}

/** The URL's path (percent-encoding as the URL object normalizes it); the stable identifier of a file on uscis.gov. */
export function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** The file name at the end of a URL, percent-decoded, lowercased: how the same file is recognized under two paths. */
export function fileKey(url: string): string {
  const last = urlPath(url).split("/").pop() ?? "";
  try {
    return decodeURIComponent(last).toLowerCase();
  } catch {
    return last.toLowerCase();
  }
}

/** The file's name as words ("2015-0508_Certain_Limited_Material_Support_PM_Effective.pdf" gives "2015-0508 Certain Limited Material Support PM Effective"). */
export function titleFromFileName(url: string): string {
  let last = urlPath(url).split("/").pop() ?? url;
  try {
    last = decodeURIComponent(last);
  } catch {
    // keep it as written
  }
  return last
    // Only the file type ("Letter_11.16.21.pdf" keeps its date; "memo.pdf.pdf" loses both).
    .replace(/(?:\.(?:pdf|docx?|xlsx?|txt|html?))+$/i, "")
    .replace(/[_+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The extension of a URL's file name, lowercased ("pdf"), or "" for a page. */
export function fileExtension(url: string): string {
  const m = /\.([a-z0-9]{2,5})$/i.exec(urlPath(url));
  return m ? m[1].toLowerCase() : "";
}

/** "(PDF, 449.39 KB)" as bytes (449.39 * 1024), or null. */
export function statedFileBytes(fileInfo: string | null): number | null {
  if (!fileInfo) return null;
  const m = /([\d.,]+)\s*(KB|MB|GB|bytes)/i.exec(fileInfo);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toUpperCase();
  return Math.round(n * (unit === "GB" ? 1024 ** 3 : unit === "MB" ? 1024 ** 2 : unit === "KB" ? 1024 : 1));
}

const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
/** A written-out date ("September 23, 2026", "Sept. 26, 2012"). */
export const WRITTEN_DATE = new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2},?\\s+\\d{4}\\b`);

/**
 * An RSS pubDate as YYYY-MM-DD. uscis.gov writes two-digit years ("Wed, 17
 * Jun 26 19:19:51 -0400"); they are read as RFC 5322 section 4.3 says for
 * the obsolete two-digit form: 00 to 49 are 2000 to 2049, 50 to 99 are 1950
 * to 1999. The calendar date is taken as written, with no time zone shift.
 */
export function rssDate(text: string | null): string | null {
  if (!text) return null;
  const m = new RegExp(`^(?:[A-Za-z]{3},\\s*)?(\\d{1,2})\\s+(${MONTH})\\s+(\\d{2}|\\d{4})\\b`).exec(text.trim());
  if (!m) return parseStatedDate(text);
  let year = Number(m[3]);
  if (m[3].length === 2) year += year < 50 ? 2000 : 1900;
  return parseStatedDate(`${m[2]} ${m[1]}, ${year}`);
}

// ---------------------------------------------------------------------------
// RSS feeds
// ---------------------------------------------------------------------------

export type RssItem = {
  title: string;
  link: string;
  /** The description as plain text (it is entity-encoded HTML in the feed). */
  description: string;
  pubDate: string | null;
  guid: string | null;
};

function rssField(itemXml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i").exec(itemXml);
  if (!m) return null;
  const raw = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
  return cdata ? cdata[1] : decodeEntities(raw);
}

export type RssParse = { channelTitle: string | null; items: RssItem[]; recognized: boolean };

/** A uscis.gov RSS feed's items, in feed order. */
export function parseRss(xml: string): RssParse {
  const channel = /<channel\b[^>]*>([\s\S]*?)<\/channel\s*>/i.exec(xml);
  if (!channel) return { channelTitle: null, items: [], recognized: false };
  const channelTitle = rssField(channel[1].replace(/<item\b[\s\S]*$/i, ""), "title");
  const items: RssItem[] = [];
  for (const m of channel[1].matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)) {
    const title = rssField(m[1], "title");
    const link = rssField(m[1], "link");
    if (!title || !link) continue;
    items.push({
      title: repairMojibake(lineText(title)),
      link: link.trim(),
      description: lineText(rssField(m[1], "description") ?? ""),
      pubDate: rssField(m[1], "pubDate"),
      guid: rssField(m[1], "guid"),
    });
  }
  return { channelTitle, items, recognized: true };
}

// ---------------------------------------------------------------------------
// The site map
// ---------------------------------------------------------------------------

/** The page URLs a site map index lists. */
export function parseSitemapIndex(xml: string): string[] {
  if (!/<sitemapindex\b/i.test(xml)) return [];
  return [...xml.matchAll(/<sitemap\b[^>]*>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>[\s\S]*?<\/sitemap\s*>/gi)].map((m) => decodeEntities(m[1]));
}

export type SitemapUrl = { loc: string; lastmod: string | null };

/** The <url> entries of one site map page; null when the page is not a urlset. */
export function parseSitemapUrls(xml: string): SitemapUrl[] | null {
  if (!/<urlset\b/i.test(xml)) return null;
  const out: SitemapUrl[] = [];
  for (const m of xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url\s*>/gi)) {
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(m[1]);
    if (!loc) continue;
    const lastmod = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i.exec(m[1]);
    out.push({ loc: decodeEntities(loc[1]), lastmod: lastmod ? lastmod[1] : null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Content pages
// ---------------------------------------------------------------------------

export type UscisPage = {
  /** The h1.page-title. */
  title: string | null;
  /** The node type the article states ("article", "news-item", "book"). */
  nodeType: string | null;
  /** The <article class="node ..."> element, screen-reader labels removed. */
  articleHtml: string;
  /** "Release Date" as printed ("10/09/2026"). */
  releaseDateText: string | null;
  /** "Last Reviewed/Updated" as printed. */
  reviewedDateText: string | null;
  /** The text of an "Archived Content" notice, when the page carries one. */
  archivedNotice: string | null;
  /** The text of each alert box on the page (USCIS's own words). */
  alerts: string[];
};

/** A uscis.gov content page's article; null when the page has no <article class="node ...">. */
export function parseUscisPage(html: string): UscisPage | null {
  const main = /<main\b[^>]*>/i.exec(html);
  const from = main ? main.index : 0;
  const rel = html.slice(from).search(/<article\b[^>]*class="[^"]*\bnode\b/i);
  if (rel < 0) return null;
  const start = from + rel;
  const article = dropHiddenLabels(sliceElement(html, start, "article"));
  const nodeType = /class="[^"]*\bnode--type-([a-z0-9_-]+)/i.exec(article)?.[1] ?? null;
  const h1 = /<h1\b[^>]*class="[^"]*\bpage-title\b[^"]*"[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(article) ?? /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(article);
  const release = /Release Date[\s\S]{0,400}?<time\b[^>]*>([^<]+)<\/time>/i.exec(article);
  const reviewed = /Last Reviewed\/Updated:?[\s\S]{0,600}?<time\b[^>]*>([^<]+)<\/time>/i.exec(article);
  const alerts = alertTexts(article);
  return {
    title: h1 ? lineText(h1[1]) || null : null,
    nodeType,
    articleHtml: article,
    releaseDateText: release ? release[1].trim() : null,
    reviewedDateText: reviewed ? reviewed[1].trim() : null,
    archivedNotice: alerts.find((a) => /^Archived Content\b/i.test(a)) ?? null,
    alerts,
  };
}

/** The text of each div.alert-message / div.messages box in a fragment. */
export function alertTexts(fragment: string): string[] {
  const out: string[] = [];
  const re = /<div\b[^>]*class="[^"]*\bmessages__text\b[^"]*"[^>]*>/gi;
  for (let m = re.exec(fragment); m; m = re.exec(fragment)) {
    const text = repairMojibake(htmlToText(sliceElement(fragment, m.index, "div"))).replace(/\n+/g, " ").trim();
    if (text) out.push(text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Listings ("views")
// ---------------------------------------------------------------------------

export type ListingRow = {
  title: string;
  /** The link, resolved against the page (https for uscis.gov). */
  url: string;
  /** The <time> text ("June 17, 2026"). */
  dateText: string | null;
  /** The <time datetime> attribute. */
  datetime: string | null;
  /** The teaser the listing prints under the title. */
  teaser: string;
  /** "(PDF, 449.39 KB)" when the entry is a file. */
  fileInfo: string | null;
};

export type ListingParse = {
  rows: ListingRow[];
  /** The total the counter states ("1 - 10 of 2061" gives 2061). */
  total: number | null;
  /** The pager's "next" link. */
  nextUrl: string | null;
  /** How many rows were left out (no link) and why. */
  notes: string[];
  recognized: boolean;
};

/** One page of a uscis.gov listing (policy memoranda, Electronic Reading Room, all news). */
export function parseListingPage(html: string, pageUrl: string): ListingParse {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(html)?.[1] ?? html;
  const recognized = /\bviews-element-container\b/.test(main) && /<form\b[^>]*views-exposed-form/i.test(main);
  const notes: string[] = [];
  const rows: ListingRow[] = [];
  const parts = main.split(/<div class="views-row\b[^"]*">/).slice(1);
  for (const raw of parts) {
    const part = raw.split(/<nav\b|<footer\b|<\/section\b/)[0];
    const titleField =
      sliceFrom(part, /views-field-title|views-field-field-document/, [/views-field-field-display-date/, /views-field-body/]) ?? part;
    const link = anchors(titleField)[0];
    const resolved = link ? resolveUrl(link.href, pageUrl) : null;
    if (!link || !resolved) {
      notes.push("A listing row without a link was left out.");
      continue;
    }
    const fileInfo = /<span\b[^>]*class="[^"]*\bfile-ext-info\b[^"]*"[^>]*>([\s\S]*?)<\/span\s*>/i.exec(link.inner);
    const title = lineText(link.inner.replace(/<span\b[^>]*class="[^"]*\bfile-ext-info\b[^"]*"[^>]*>[\s\S]*?<\/span\s*>/gi, ""));
    const time = /<time\b([^>]*)>([^<]*)<\/time>/i.exec(part);
    const body = sliceFrom(part, /views-field-body/, []) ?? "";
    rows.push({
      title,
      url: httpsForUscis(resolved),
      dateText: time ? time[2].trim() || null : null,
      datetime: time ? attrValue(time[1], "datetime") : null,
      teaser: lineText(body.replace(/^[^>]*>/, "")),
      fileInfo: fileInfo ? lineText(fileInfo[1]).replace(/^\(|\)$/g, "") || null : null,
    });
  }
  const counter = /view__counter-text">[^<]*<\/span>\s*of\s*([\d,]+)/i.exec(main);
  const next = /<a\b([^>]*\brel="next"[^>]*)>/i.exec(main);
  const nextHref = next ? attrValue(next[1], "href") : null;
  return {
    rows,
    total: counter ? Number(counter[1].replace(/,/g, "")) : null,
    nextUrl: nextHref ? resolveUrl(nextHref, pageUrl) : null,
    notes,
    recognized,
  };
}

// ---------------------------------------------------------------------------
// The Policy Manual
// ---------------------------------------------------------------------------

export type AffectedSection = { citation: string | null; title: string; url: string | null };

export type PmUpdate = {
  /** "POLICY ALERT - ...", "Technical Update - ...". */
  header: string;
  /** The <time> text ("September 23, 2026"). */
  dateText: string | null;
  datetime: string | null;
  /** The update's paragraphs as text. */
  summary: string;
  /** The "Read More" link (the policy alert's PDF), when there is one. */
  readMoreUrl: string | null;
  affected: AffectedSection[];
  /** The block's HTML, for the document text of an update with no file. */
  html: string;
};

/** Every update block (div.pm-updates) in a fragment, in page order. */
export function parsePmUpdateBlocks(fragment: string, pageUrl: string): PmUpdate[] {
  const out: PmUpdate[] = [];
  const re = /<div class="pm-updates">/g;
  for (let m = re.exec(fragment); m; m = re.exec(fragment)) {
    const block = sliceElement(fragment, m.index, "div");
    const header = /<div class="pm-resource__update_header">([\s\S]*?)<\/div>/i.exec(block);
    const headerText = header ? lineText(header[1]) : "";
    if (!headerText) continue;
    const time = /<time\b([^>]*)>([^<]*)<\/time>/i.exec(block);
    const content = sliceFrom(block, "pm-resource__content", ["pm-resource__associated_pages"]) ?? "";
    const body = /<div\b[^>]*class="[^"]*field--name-body[^"]*"[^>]*>/i.exec(content);
    const summary = body ? repairMojibake(htmlToText(sliceElement(content, body.index, "div"))) : "";
    const readMore = /<a\b([^>]*class="btn btn--anchor"[^>]*)>/i.exec(block);
    const readMoreHref = readMore ? attrValue(readMore[1], "href") : null;
    const affected: AffectedSection[] = [...block.matchAll(/<p class="affected-sections">([\s\S]*?)<\/p>/gi)].map((p) => {
      const a = anchors(p[1])[0];
      const citation = /<span class="citation">([\s\S]*?)<\/span>/i.exec(p[1]);
      const rest = a ? a.inner.replace(/<span class="citation">[\s\S]*?<\/span>\s*-?\s*/i, "") : p[1];
      return {
        citation: citation ? lineText(citation[1]) || null : null,
        title: lineText(rest),
        url: a ? resolveUrl(a.href, pageUrl) : null,
      };
    });
    out.push({
      header: headerText,
      dateText: time ? time[2].trim() || null : null,
      datetime: time ? attrValue(time[1], "datetime") : null,
      summary,
      readMoreUrl: readMoreHref ? resolveUrl(readMoreHref, pageUrl) : null,
      affected,
      html: block,
    });
  }
  return out;
}

export type BookNode = {
  depth: number;
  heading: string;
  /** The node's page ("https://www.uscis.gov/policy-manual/volume-1-part-a-chapter-1"). */
  url: string;
  /** The volume, part and chapter headings above and including this node. */
  path: string[];
  /** The node's own text in the export (its children excluded), for the change fingerprint. */
  text: string;
};

export type BookExport = { nodes: BookNode[]; updates: PmUpdate[]; recognized: boolean };

/**
 * The Policy Manual's "Print Manual" export: one <article
 * class="book-node-depth-N"> per page (2 a volume, 3 a part, 4 a chapter;
 * the landing, search, updates and table of contents pages too), each
 * with its heading, a rel="bookmark" link to the page and its own body,
 * followed by its children. A node's own content runs to the next node's
 * start. The Updates node holds every update block.
 */
export function parseBookExport(html: string, pageUrl: string): BookExport {
  const starts: { index: number; depth: number }[] = [];
  for (const m of html.matchAll(/<article class="book-node-depth-(\d+)">/g)) starts.push({ index: m.index ?? 0, depth: Number(m[1]) });
  const nodes: BookNode[] = [];
  let updates: PmUpdate[] = [];
  const path: string[] = [];
  starts.forEach((s, i) => {
    const segment = html.slice(s.index, starts[i + 1]?.index ?? html.length);
    const heading = /<h1 class="book-node-heading[^"]*">([\s\S]*?)<\/h1>/i.exec(segment);
    const bookmark = /<a\b([^>]*)\brel="bookmark"[^>]*>/i.exec(segment);
    const href = bookmark ? attrValue(bookmark[1], "href") : null;
    const url = href ? resolveUrl(href, pageUrl) : null;
    const headingText = heading ? lineText(heading[1]) : "";
    if (!url || !headingText) return;
    path.length = Math.max(0, s.depth - 2);
    if (s.depth >= 2) path.push(headingText);
    if (/\/policy-manual\/updates$/.test(url)) updates = parsePmUpdateBlocks(segment, pageUrl);
    if (!/\/policy-manual\/volume-/.test(url)) return;
    const own = segment.replace(/^[\s\S]*?<\/h1>/i, "");
    nodes.push({ depth: s.depth, heading: headingText, url, path: [...path], text: repairMojibake(htmlToText(dropHiddenLabels(own))) });
  });
  return { nodes, updates, recognized: nodes.filter((n) => n.depth === 4).length >= 100 };
}

export type PmResource = { category: string; text: string; url: string | null };

export type PmPage = {
  title: string | null;
  /** The Guidance tab. */
  guidanceHtml: string;
  /** The Appendices tab's content, when it has any. */
  appendicesHtml: string | null;
  resources: PmResource[];
  updates: PmUpdate[];
  /** "Current as of" as printed ("October 02, 2026"). */
  currentAsOf: string | null;
  counts: { resources: number | null; appendices: number | null; updates: number | null };
  alerts: string[];
  recognized: boolean;
};

/** A Policy Manual volume, part or chapter page. */
export function parsePmPage(html: string, pageUrl: string): PmPage {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(html)?.[1] ?? html;
  const h1 = /<h1\b[^>]*class="[^"]*\bpage-title\b[^"]*"[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(main);
  const tab = (id: string): string | null => {
    const m = new RegExp(`<div id="${id}" class="tabcontent\\b[^"]*"[^>]*>`, "i").exec(main);
    return m ? sliceElement(main, m.index, "div") : null;
  };
  const guidance = tab("guidance");
  const resourcesHtml = tab("resources") ?? "";
  const appendices = tab("appendices");
  const updatesHtml = tab("updates") ?? "";
  const resources: PmResource[] = [];
  for (const m of resourcesHtml.matchAll(/<div class="pm-resource__container">/g)) {
    const container = sliceElement(resourcesHtml, m.index ?? 0, "div");
    const header = /<div class="pm-resource__header">([\s\S]*?)<\/div>/i.exec(container);
    const category = header ? lineText(header[1]) : "";
    for (const row of container.matchAll(/<div class="row-data[^"]*">([\s\S]*?)<\/div>\s*<\/div>/gi)) {
      const text = lineText(row[1]);
      if (!text) continue;
      const a = anchors(row[1])[0];
      const url = a ? resolveUrl(a.href, pageUrl) : null;
      resources.push({ category, text, url: url ? httpsForUscis(url) : null });
    }
  }
  const appendixText = appendices ? htmlToText(appendices) : "";
  const count = (id: string) => {
    const m = new RegExp(`id="${id}">(\\d+)<`).exec(main);
    return m ? Number(m[1]) : null;
  };
  const current = /current-date__value">\s*([^<]+?)\s*</i.exec(main);
  const guidanceHtml = guidance ? dropHiddenLabels(guidance) : "";
  return {
    title: h1 ? lineText(h1[1]) || null : null,
    guidanceHtml,
    appendicesHtml: appendices && !/No\s*(<[^>]*>)*\s*appendices\s*(<[^>]*>)*\s*available/i.test(appendices) && appendixText.replace(/^Appendices\s*/i, "").trim() ? dropHiddenLabels(appendices) : null,
    resources,
    updates: parsePmUpdateBlocks(updatesHtml, pageUrl),
    currentAsOf: current ? current[1].trim() : null,
    counts: { resources: count("resources_count"), appendices: count("appendices_count"), updates: count("updates_count") },
    alerts: alertTexts(guidanceHtml),
    recognized: guidance !== null,
  };
}

/** "Volume 10 - Employment Authorization" gives "Volume 10"; a heading without " - " is returned whole. */
export function headingLabel(heading: string): string {
  const m = /^(.*?)\s+[-–—]\s+/.exec(heading);
  return (m ? m[1] : heading).trim();
}

/** The effective date an update or memo states ("This policy becomes effective October 23, 2026."). */
export function statedEffectiveDate(text: string): string | null {
  const m = new RegExp(`\\b(?:becomes|become|is|are|will be|takes|take|goes|go)\\s+(?:into\\s+)?effective\\s+(?:on\\s+|as of\\s+)?(${WRITTEN_DATE.source})`, "i").exec(text);
  return m ? m[1].replace(/\s+/g, " ") : null;
}

// ---------------------------------------------------------------------------
// Memoranda and other files
// ---------------------------------------------------------------------------

export type MemoHeader = {
  /** "PM-602-0199", "PA-2026-15", as printed. */
  number: string | null;
  /** The date printed on the number's line ("May 21, 2026"), or a "Date:" line. */
  dateText: string | null;
  /** The SUBJECT line. */
  subject: string | null;
  /** "Policy Memorandum", "Policy Alert", as printed under the number. */
  kind: string | null;
};

// "PM-602-0199", "PA-2026-15", and the older "PA-12-001".
const MEMO_NUMBER = /\b(P[AM]-\d{2,4}-\d{2,4}(?:\.\d{1,2})?)\b/;
const SECTION_START = /^(?:Purpose|Background|Authority|Authorities|Summary|Policy|Discussion|Introduction|Applicability|Scope|Overview|I\.|A\.|1\.|Use\b|This\b|USCIS\b|The\b|In\b|On\b|Effective\b)/;

/** The header of a USCIS memorandum or policy alert, read from the first page of its text. */
export function parseMemoHeader(text: string): MemoHeader {
  const head = text.slice(0, 4000);
  const lines = head.split("\n").map((l) => l.replace(/\s+/g, " ").trim());
  let number: string | null = null;
  let dateText: string | null = null;
  let kind: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const n = MEMO_NUMBER.exec(lines[i]);
    if (!n) continue;
    number = n[1];
    dateText = WRITTEN_DATE.exec(lines[i])?.[0] ?? null;
    const next = lines[i + 1] ?? "";
    if (/^(Policy Memorandum|Policy Alert|Memorandum)$/i.test(next)) kind = next;
    break;
  }
  if (!dateText) {
    const d = new RegExp(`^Date:\\s*(${WRITTEN_DATE.source})`, "im").exec(head);
    if (d) dateText = d[1];
  }
  let subject: string | null = null;
  const at = lines.findIndex((l) => /^SUBJECT\s*:/i.test(l));
  if (at >= 0) {
    const parts = [lines[at].replace(/^SUBJECT\s*:\s*/i, "")];
    // The PDF's text can put a blank line between the subject's lines; a section heading ends it.
    for (let j = at + 1, taken = 0; j < lines.length && taken < 4; j++) {
      const l = lines[j];
      if (!l) continue;
      if (SECTION_START.test(l) || /^\d+\s/.test(l)) break;
      parts.push(l);
      taken++;
    }
    subject = parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 500) || null;
  }
  return { number, dateText, subject, kind };
}

/**
 * Sentences of a policy alert or memorandum that say what it supersedes,
 * rescinds or replaces, with the memorandum numbers they name: the source's
 * own words, kept so a reader can see which memoranda the Policy Manual now
 * governs. At most `max` sentences.
 */
export function supersessionStatements(text: string, ownNumber: string | null = null, max = 12): { sentence: string; memoNumbers: string[] }[] {
  const flat = text.replace(/\[Page \d+\]/g, " ").replace(/\s+/g, " ");
  const out: { sentence: string; memoNumbers: string[] }[] = [];
  // Statements, not mentions: "supersedes", "is rescinded", "replaces", "vacating" (not "to supersede").
  // A period inside a number ("PM-602-0050.1") does not end a sentence.
  for (const m of flat.matchAll(/(?:[^.;:]|\.(?=\d))*?\b(?:supersedes|superseded|superseding|rescinds|rescinded|rescinding|rescission of|replaces|replaced|vacates|vacated|vacating)\b(?:[^.;]|\.(?=\d))*[.;]/gi)) {
    const sentence = m[0].trim();
    if (sentence.length > 400) continue;
    const memoNumbers = [
      ...new Set([...sentence.matchAll(/\bP[AM][- ]\d{2,4}-\d{2,4}(?:\.\d{1,2})?\b/g)].map((x) => x[0].replace(" ", "-")).filter((n) => n !== ownNumber)),
    ];
    if (!memoNumbers.length && !/\b(?:memorand\w*|policy alerts?|Adjudicator.s Field Manual|AFM)\b/i.test(sentence)) continue;
    out.push({ sentence, memoNumbers });
    if (out.length >= max) break;
  }
  return out;
}

export type ArchiveMemoEntry = {
  title: string;
  url: string;
  /** The month heading the entry sits under ("August 2011"). */
  monthHeading: string | null;
  /** The date line ("08/30/2011"). */
  dateText: string | null;
  /** The other lines the entry prints (a note, the author, "Notice"). */
  lines: string[];
};

/** USCIS's Archive Memos page: entries under month headings, each a linked title, maybe a note or author line, and a date line. */
export function parseArchiveMemos(html: string, pageUrl: string): { entries: ArchiveMemoEntry[]; recognized: boolean } {
  const body = sliceFrom(html, /field--name-body/, ["</article>"]);
  if (!body) return { entries: [], recognized: false };
  const entries: ArchiveMemoEntry[] = [];
  let month: string | null = null;
  for (const m of body.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>|<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)) {
    if (m[1] !== undefined) {
      month = lineText(m[1]) || month;
      continue;
    }
    const p = m[2] ?? "";
    const a = anchors(p)[0];
    if (!a) continue;
    const url = resolveUrl(a.href, pageUrl);
    if (!url) continue;
    const title = a.text.replace(/\s*\((?:PDF|DOC|DOCX)[^)]*\)\s*;?\s*$/i, "").replace(/[;\s]+$/, "").trim();
    const lines = htmlToText(p.replace(a.inner, " ").replace(/<a\b[^>]*>\s*<\/a>/gi, ""))
      .split("\n")
      .map((l) => l.replace(/ /g, " ").trim())
      .filter((l) => l && !/^\((?:PDF|DOC)[^)]*\)$/i.test(l));
    const dateLine = lines.find((l) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(l)) ?? null;
    entries.push({ title, url: httpsForUscis(url), monthHeading: month, dateText: dateLine, lines: lines.filter((l) => l !== dateLine) });
  }
  // The page states what it holds, and its entries carry date lines; a page without both is another page.
  const recognized = /superseded by the USCIS Policy Manual/i.test(htmlToText(body)) && entries.filter((e) => e.dateText).length >= 20;
  return { entries, recognized };
}

export type LinkedFile = {
  /** The accordion heading the link sits under (the exemption's name), when there is one. */
  section: string | null;
  title: string;
  url: string;
};

/** Links in a page body, each with the accordion heading (h4.accordion__header) it sits under. */
export function linksBySection(bodyHtml: string, pageUrl: string): LinkedFile[] {
  const heads: { index: number; name: string }[] = [];
  for (const m of bodyHtml.matchAll(/<h4\b[^>]*class="[^"]*\baccordion__header\b[^"]*"[^>]*>([\s\S]*?)<\/h4\s*>/gi)) {
    heads.push({ index: m.index ?? 0, name: lineText(m[1]) });
  }
  const out: LinkedFile[] = [];
  for (const a of anchors(bodyHtml)) {
    const url = resolveUrl(a.href, pageUrl);
    if (!url || !a.text) continue;
    const section = [...heads].reverse().find((h) => h.index < a.index)?.name ?? null;
    out.push({ section, title: a.text, url: httpsForUscis(url) });
  }
  return out;
}
