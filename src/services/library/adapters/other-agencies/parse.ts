import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { anchors, attrValue, decodeEntities, inlineText, metaContent, resolveUrl, tableRows } from "../../extract/html";

// Page parsers for the collectors in this folder. Pure (no I/O), so each can
// be tried on a saved page. Every parser returns only what the page states;
// a parser that does not find the layout it reads returns an empty result
// or null, and the adapter turns that into a LibraryLayoutError.

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** The inner HTML of the first element matching `open` up to its matching close tag (same tag name, nesting counted). */
export function elementContent(html: string, open: RegExp): string | null {
  const m = open.exec(html);
  if (!m) return null;
  const tag = /^<([a-z0-9]+)/i.exec(m[0])?.[1]?.toLowerCase();
  if (!tag) return null;
  const start = (m.index ?? 0) + m[0].length;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = start;
  let depth = 1;
  for (let t = re.exec(html); t; t = re.exec(html)) {
    if (t[0].endsWith("/>")) continue;
    depth += t[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index);
  }
  return html.slice(start);
}

/** The text of the first <h1>, entities decoded; null when there is none. */
export function firstH1(html: string): string | null {
  const m = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
  const text = m ? inlineText(m[1]) : "";
  return text || null;
}

/** A URL without its #fragment. */
export function withoutFragment(url: string): string {
  const at = url.indexOf("#");
  return at < 0 ? url : url.slice(0, at);
}

/** The path (and query) of a URL, as an external identifier. */
export function pathId(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname) + u.search;
  } catch {
    return url;
  }
}

/**
 * A date written MM/DD/YY (the ORR letter tables): the two-digit year read
 * as 20YY when that is not after `now`'s year plus one, else 19YY. Null
 * when it does not parse as a real date.
 */
export function parseShortUsDate(text: string | null | undefined, now: Date): string | null {
  const m = /\b(\d{1,2})\/(\d{1,2})\/(\d{2})\b/.exec(text ?? "");
  if (!m) return parseStatedDate(text);
  const yy = Number(m[3]);
  const year = 2000 + yy <= now.getUTCFullYear() + 1 ? 2000 + yy : 1900 + yy;
  return parseStatedDate(`${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`);
}

/** "Month YYYY" as the year, when that is all a page states. */
export function yearOf(text: string | null | undefined): number | null {
  const m = /\b(19\d{2}|20\d{2})\b/.exec(text ?? "");
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Federal Register API (www.federalregister.gov/api/v1)
// ---------------------------------------------------------------------------

export type FrAgency = { name?: string | null; raw_name?: string | null; slug?: string | null };
export type FrCfrReference = { title?: number | string | null; part?: string | null };

export type FrDocument = {
  document_number: string;
  title: string;
  type?: string | null;
  subtype?: string | null;
  abstract?: string | null;
  action?: string | null;
  dates?: string | null;
  publication_date?: string | null;
  effective_on?: string | null;
  html_url?: string | null;
  pdf_url?: string | null;
  raw_text_url?: string | null;
  body_html_url?: string | null;
  agencies?: FrAgency[] | null;
  cfr_references?: FrCfrReference[] | null;
  citation?: string | null;
  docket_ids?: string[] | null;
  regulation_id_numbers?: string[] | null;
  start_page?: number | null;
  end_page?: number | null;
  volume?: number | null;
  significant?: boolean | null;
  correction_of?: string | null;
  signing_date?: string | null;
  executive_order_number?: string | number | null;
  presidential_document_number?: string | null;
  comments_close_on?: string | null;
  topics?: string[] | null;
};

export type FrPage = { count: number | null; documents: FrDocument[]; nextPageUrl: string | null };

/** One page of the API's documents search; null when the JSON is not the documented shape. */
export function parseFrPage(json: unknown): FrPage | null {
  const j = json as { count?: unknown; results?: unknown; next_page_url?: unknown } | null;
  if (!j || typeof j !== "object") return null;
  // A search always states its count; an empty search has no results array.
  if (typeof j.count !== "number") return null;
  if (j.results !== undefined && !Array.isArray(j.results)) return null;
  const results = (j.results ?? []) as unknown[];
  const documents: FrDocument[] = [];
  for (const r of results) {
    const d = r as FrDocument;
    if (!d || typeof d.document_number !== "string" || typeof d.title !== "string") return null;
    documents.push(d);
  }
  return {
    count: typeof j.count === "number" ? j.count : null,
    documents,
    nextPageUrl: typeof j.next_page_url === "string" ? j.next_page_url : null,
  };
}

/**
 * The text of a Federal Register document as the Federal Register serves
 * it at raw_text_url (GPO's text, wrapped in <pre>), entities decoded.
 */
export function frRawText(page: string): string {
  const pre = /<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/i.exec(page)?.[1] ?? page;
  return decodeEntities(pre.replace(/<[^>]+>/g, ""));
}

// ---------------------------------------------------------------------------
// DOL Office of Foreign Labor Certification (www.dol.gov/agencies/eta/foreign-labor)
// ---------------------------------------------------------------------------

/** The article body of a dol.gov (Drupal) page; null when it has none. */
export function dolArticle(html: string): string | null {
  return elementContent(html, /<article\b[^>]*>/i);
}

export type OflcAnnouncement = {
  /** "2026-08-05" when the heading's date parses. */
  date: string | null;
  dateText: string;
  /** The heading as printed, without the date. */
  heading: string;
  /** The full heading line as printed. */
  headingLine: string;
  html: string;
};

const DATE_LEAD = /^\s*((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},\s*\d{4})[.:,]?\s*/i;

function announcementFrom(headingLine: string, html: string): OflcAnnouncement | null {
  const m = DATE_LEAD.exec(headingLine);
  if (!m) return null;
  return { date: parseStatedDate(m[1]), dateText: m[1], heading: headingLine.slice(m[0].length).trim(), headingLine, html };
}

/** The current announcements page: one "nr-entry" block per announcement, headed "Month D, YYYY. Title". */
export function parseOflcAnnouncements(html: string): OflcAnnouncement[] {
  const out: OflcAnnouncement[] = [];
  const starts = [...html.matchAll(/<div class="nr-entry">\s*(?:<div class="nr-entry">)?/g)].map((m) => ({ at: m.index ?? 0, len: m[0].length }));
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].at + starts[i].len;
    const to = i + 1 < starts.length ? starts[i + 1].at : html.indexOf("</article>", from) > 0 ? html.indexOf("</article>", from) : html.length;
    const block = html.slice(from, to);
    const h3 = /<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/i.exec(block);
    if (!h3) continue;
    const entry = announcementFrom(inlineText(h3[1]), block.slice((h3.index ?? 0) + h3[0].length));
    if (entry) out.push(entry);
  }
  return out;
}

/** The announcements archive (2005 to 2014): "Calendar Year YYYY" sections of <li> items opening with a bold date. */
export function parseOflcArchive(html: string): OflcAnnouncement[] {
  const out: OflcAnnouncement[] = [];
  for (const ul of html.matchAll(/<ul class="box">([\s\S]*?)<\/ul>\s*(?=<br|<a id|<h3|<\/div|$)/gi)) {
    for (const li of ul[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
      const strong = /<strong\b[^>]*>([\s\S]*?)<\/strong\s*>/i.exec(li[1]);
      if (!strong) continue;
      const entry = announcementFrom(inlineText(strong[1]), li[1].slice((strong.index ?? 0) + strong[0].length));
      if (entry) out.push(entry);
    }
  }
  return out;
}

export type LinkedFile = { url: string; label: string; section: string | null };

/** The FAQ page's PDF links ("rounds"), each under the bold heading that precedes its list. */
export function parseOflcFaqLinks(article: string, pageUrl: string): LinkedFile[] {
  const out: LinkedFile[] = [];
  const seen = new Set<string>();
  let section: string | null = null;
  const tokens = /<strong\b[^>]*>([\s\S]*?)<\/strong\s*>|<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (const t of article.matchAll(tokens)) {
    if (t[1] !== undefined) {
      const text = inlineText(t[1]);
      if (text) section = text;
      continue;
    }
    const href = attrValue(t[2], "href");
    const url = href ? resolveUrl(href, pageUrl) : null;
    if (!url || !/\.pdf$/i.test(new URL(url).pathname)) continue;
    if (!/(^|\.)dol\.gov$/i.test(new URL(url).hostname)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, label: inlineText(t[3]), section });
  }
  return out;
}

// ---------------------------------------------------------------------------
// DOL Wage and Hour Division immigration pages
// ---------------------------------------------------------------------------

/** The program pages the WHD immigration hub links (D-1, E-3, H-1B, H-1B1, H-2A, H-2B, U and T visa certifications). */
export function parseWhdHub(article: string, pageUrl: string): { url: string; label: string }[] {
  const out: { url: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const a of anchors(article)) {
    const url = resolveUrl(a.href, pageUrl);
    if (!url) continue;
    const u = new URL(url);
    if (u.hostname !== "www.dol.gov") continue;
    if (!/^\/agencies\/whd\/(?:immigration\/[\w-]+|agriculture\/h2a)$/i.test(u.pathname)) continue;
    const clean = withoutFragment(url);
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push({ url: clean, label: a.text });
  }
  return out;
}

/** WHD files and fact sheets a page links: WHD PDFs on dol.gov, and fact sheet pages (English only). */
export function parseWhdLinkedGuidance(article: string, pageUrl: string): { url: string; label: string }[] {
  const out: { url: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const a of anchors(article)) {
    const url = resolveUrl(a.href, pageUrl);
    if (!url) continue;
    const u = new URL(url);
    if (u.hostname !== "www.dol.gov") continue;
    const isFile = /^\/sites\/dolgov\/files\/whd\/.+\.pdf$/i.test(u.pathname);
    const isFactSheet = /^\/agencies\/whd\/fact-sheets\/[\w-]+$/i.test(u.pathname);
    if (!isFile && !isFactSheet) continue;
    const clean = withoutFragment(url);
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push({ url: clean, label: a.text });
  }
  return out;
}

const WHD_IMMIGRATION_FACT_SHEET = /\bH-2A\b|\bH-2B\b|\bH-1B\d?\b|\bH-1C\b|\bD-1\b|\bE-3\b|\bCW-1\b|Immigration and Nationality Act|\bINA\b|\bvisa\b|nonimmigrant|\bimmigra/i;

/** The fact sheets index's English fact sheets about the immigration programs WHD enforces. */
export function parseWhdFactSheetIndex(article: string, pageUrl: string): { url: string; label: string }[] {
  return parseWhdLinkedGuidance(article, pageUrl).filter((l) => WHD_IMMIGRATION_FACT_SHEET.test(l.label) || /h-?2a|h-?2b|h1b|h-1b/i.test(l.url));
}

/** "Fact Sheet #26: ..." pages print their revision month under the title ("February 2010"). */
export function whdRevisionLine(articleText: string): string | null {
  const m = /^\s*((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})\s*$/m.exec(articleText.split("\n").slice(0, 12).join("\n"));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// ACF / ORR pages (acf.gov)
// ---------------------------------------------------------------------------

/** The <article> of an acf.gov page (the page node: lead, body), without the side navigation. */
export function acfArticle(html: string): string | null {
  return elementContent(html, /<article\b[^>]*>/i);
}

/** The page lead: the <h1> title and the subtitle under it ("Policy Letter 26-01"). */
export function acfLead(html: string): { title: string | null; subtitle: string | null } {
  const title = /<h1\b[^>]*acf-page-lead__title[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1];
  const subtitle = /<h2\b[^>]*acf-page-lead__subtitle[^>]*>([\s\S]*?)<\/h2\s*>/i.exec(html)?.[1];
  return { title: title ? inlineText(title) || null : firstH1(html), subtitle: subtitle ? inlineText(subtitle) || null : null };
}

/** The right rail's PUBLISHED and UPDATED dates as printed. */
export function acfDates(html: string): { published: string | null; updated: string | null } {
  const value = (label: string) => {
    const re = new RegExp(`<h2[^>]*acf-right-navigation__label[^>]*>\\s*${label}\\s*<\\/h2>\\s*<p[^>]*>([\\s\\S]*?)<\\/p>`, "i");
    const m = re.exec(html);
    return m ? inlineText(m[1]) || null : null;
  };
  return { published: value("PUBLISHED"), updated: value("UPDATED") };
}

/** The body section of an acf.gov page node. */
export function acfBody(html: string): string | null {
  return elementContent(html, /<section\b[^>]*acf-page-node__body[^>]*>/i) ?? acfArticle(html);
}

const ACF_NAV = /^\/(?:orr\/?$|orr\/policy-guidance\/?$|orr\/policy-guidance\/(?:uac|refugees)\/?$|search\/|orr\/about|orr\/grants|orr\/research-data|orr\/programs-services\/?$)/i;

/** The pages a guide's table of contents links, in order, once each (fragments dropped), and its PDFs. */
export function parseAcfGuideToc(article: string, pageUrl: string): { url: string; label: string }[] {
  const out: { url: string; label: string }[] = [];
  const seen = new Set<string>([withoutFragment(pageUrl)]);
  for (const a of anchors(article)) {
    const url = resolveUrl(a.href, pageUrl);
    if (!url) continue;
    const u = new URL(url);
    if (!/^(?:www\.)?acf(?:\.hhs)?\.gov$/i.test(u.hostname)) continue;
    if (!/^\/(?:orr\/|sites\/default\/files\/documents\/orr\/|system\/files\/documents\/orr\/)/i.test(u.pathname)) continue;
    if (ACF_NAV.test(u.pathname)) continue;
    const clean = withoutFragment(url);
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push({ url: clean, label: a.text });
  }
  return out;
}

export type OrrLetterRow = {
  /** "PL", "DCL" or "SL". */
  series: string;
  number: string;
  title: string;
  url: string;
  dateText: string | null;
  note: string | null;
  /** The table's heading cell ("FY 2025", "Eligibility"). */
  group: string | null;
};

/** One ORR letters page (Dear Colleague Letters, Policy Letters, State Letters): a table per year or topic, a row per letter. */
export function parseOrrLetterTables(article: string, pageUrl: string, series: string): OrrLetterRow[] {
  const out: OrrLetterRow[] = [];
  for (const table of article.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)) {
    const rows = tableRows(table[1]);
    if (!rows.length) continue;
    const group = rows[0].length ? inlineText(rows[0][0]) || null : null;
    for (const cells of rows) {
      if (cells.length < 3) continue;
      const link = anchors(cells[0])[0];
      if (!link) continue;
      const url = resolveUrl(link.href, pageUrl);
      const number = inlineText(cells[1]);
      if (!url || !/^\d{2}-\d{1,3}[A-Za-z]?$/.test(number)) continue;
      out.push({
        series,
        number,
        title: link.text,
        url: withoutFragment(url),
        dateText: inlineText(cells[2]) || null,
        note: cells[3] !== undefined ? inlineText(cells[3]) || null : null,
        group,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Justice Manual (www.justice.gov/jm)
// ---------------------------------------------------------------------------

/** The Justice Manual's chapters as its book navigation lists them: path and "4-7.000 - Immigration Litigation". */
export function parseJmChapters(html: string, pageUrl: string): { url: string; label: string; number: string }[] {
  const out: { url: string; label: string; number: string }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b([^>]*)>\s*<span>([^<]+)<\/span>/gi)) {
    const href = attrValue(m[1], "href");
    const label = decodeEntities(m[2]).replace(/\s+/g, " ").trim();
    const number = /^(\d{1,2}-\d{1,2}\.\d{3})\s*-/.exec(label)?.[1];
    if (!href || !number || !/^\/jm\/jm-/i.test(href)) continue;
    const url = resolveUrl(href, pageUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, label, number });
  }
  return out;
}

export type JmSection = { number: string; title: string; html: string; updatedText: string | null };

/** A Justice Manual chapter page's sections: each "<h2>4-7.010 - Title</h2>" up to the next one. */
export function parseJmSections(html: string): { sections: JmSection[]; chapterTitle: string | null } {
  const body = /field_body"?[^>]*>([\s\S]*)/i.exec(html)?.[1] ?? "";
  const end = body.search(/<div class="node-updated-date|<nav class="book-navigation|<\/article>/i);
  const content = end > 0 ? body.slice(0, end) : body;
  // Chapters head their sections with <h2> or <h3>, "4-7.010 - Title" or "9-72.100 S Visa Program".
  const heads = [...content.matchAll(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)]
    .map((m) => ({ at: m.index ?? 0, len: m[0].length, text: inlineText(m[2]).replace(/\s+/g, " ") }))
    .filter((h) => /^\d{1,2}-\d{1,2}\.\d{3}\s+\S/.test(h.text));
  const sections: JmSection[] = heads.map((h, i) => {
    const sectionHtml = content.slice(h.at + h.len, i + 1 < heads.length ? heads[i + 1].at : content.length);
    const m = /^(\d{1,2}-\d{1,2}\.\d{3})\s+(?:-\s*)?(.+)$/.exec(h.text)!;
    const updated = /\[\s*updated\s+([A-Za-z]+\.?\s+(?:\d{1,2},\s*)?\d{4})\s*\]/i.exec(decodeEntities(sectionHtml.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " "));
    return { number: m[1], title: m[2].trim(), html: sectionHtml, updatedText: updated ? updated[1] : null };
  });
  return { sections, chapterTitle: firstH1(html) };
}

// ---------------------------------------------------------------------------
// DOJ Civil Rights Division, Immigrant and Employee Rights Section: technical assistance letters
// ---------------------------------------------------------------------------

export type IerLetter = { url: string; dateText: string; subject: string | null; topics: string[] };

/** The letters page: <h3> topic headings, then a paragraph per letter (the date links the letter; its subject follows in parentheses). */
export function parseIerLetters(body: string, pageUrl: string): IerLetter[] {
  const byUrl = new Map<string, IerLetter>();
  let topic: string | null = null;
  for (const t of body.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>|<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)) {
    if (t[1] !== undefined) {
      topic = inlineText(t[1]) || topic;
      continue;
    }
    const p = t[2];
    const link = anchors(p)[0];
    if (!link) continue;
    const dateText = link.text.trim();
    if (!parseStatedDate(dateText)) continue;
    const url = resolveUrl(link.href, pageUrl);
    if (!url) continue;
    const after = inlineText(p.slice(link.index)).slice(dateText.length).trim();
    const subject = /^\((.*)\)\s*$/.exec(after)?.[1]?.trim() || after || null;
    const existing = byUrl.get(url);
    if (existing) {
      if (topic && !existing.topics.includes(topic)) existing.topics.push(topic);
      continue;
    }
    byUrl.set(url, { url, dateText, subject, topics: topic ? [topic] : [] });
  }
  return [...byUrl.values()];
}

// ---------------------------------------------------------------------------
// CDC Technical Instructions (www.cdc.gov/immigrant-refugee-health/hcp/...)
// ---------------------------------------------------------------------------

/** The Technical Instructions pages an index's navigation links (same section: panel-physicians or civil-surgeons). */
export function parseCdcTiPages(html: string, pageUrl: string): { url: string; label: string }[] {
  const section = /\/hcp\/([\w-]+)\//.exec(new URL(pageUrl).pathname)?.[1];
  const out: { url: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const a of anchors(html)) {
    const url = resolveUrl(a.href, pageUrl);
    if (!url || !section) continue;
    const u = new URL(url);
    if (u.hostname !== "www.cdc.gov" || !u.pathname.startsWith(`/immigrant-refugee-health/hcp/${section}/`) || !u.pathname.endsWith(".html")) continue;
    const clean = withoutFragment(url);
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push({ url: clean, label: a.text });
  }
  return out;
}

/** A CDC page's dates as its meta tags state them (cdc:first_published, cdc:last_updated, cdc:last_reviewed). */
export function cdcDates(html: string): { firstPublished: string | null; lastUpdated: string | null; lastReviewed: string | null } {
  return {
    firstPublished: metaContent(html, "cdc:first_published"),
    lastUpdated: metaContent(html, "cdc:last_updated"),
    lastReviewed: metaContent(html, "cdc:last_reviewed"),
  };
}

// ---------------------------------------------------------------------------
// SSA POMS (secure.ssa.gov/poms.nsf)
// ---------------------------------------------------------------------------

/** A POMS table of contents' section links ("SI 00502.100"), in order. */
export function parsePomsToc(html: string, pageUrl: string): { url: string; citation: string }[] {
  const body = /id="divBody"[^>]*>([\s\S]*?)<!--divBody-->/i.exec(html)?.[1] ?? "";
  const out: { url: string; citation: string }[] = [];
  const seen = new Set<string>();
  for (const a of anchors(body)) {
    if (!/^[A-Z]{2}\s+[A-Z]{0,4}\d{5}\.\d{3}$/.test(a.text)) continue;
    const url = resolveUrl(a.href, pageUrl);
    if (!url || !/\/poms\.nsf\/lnx\/\d{10}[A-Z]*$/i.test(new URL(url).pathname) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, citation: a.text });
  }
  return out;
}

export type PomsSection = {
  citation: string;
  title: string;
  /** "11/30/2023 - Present" */
  effectiveText: string | null;
  transmittal: string | null;
  html: string;
};

/** One POMS section page: <title> "SSA - POMS: SI 00502.100 - Basic SSI Alien Eligibility Requirements - 11/30/2023", its effective dates, transmittal and body. */
export function parsePomsSection(html: string): PomsSection | null {
  const pageTitle = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  // The <title> escapes the section title's own entities a second time ("&amp;mdash;").
  const titleText = pageTitle ? decodeEntities(decodeEntities(pageTitle)).replace(/\s+/g, " ").trim() : null;
  const t = titleText ? /^SSA - POMS:\s*([A-Z]{2}\s+[A-Z]{0,4}\d{5}\.\d{3})\s+-\s+(.+?)(?:\s+-\s+\d{2}\/\d{2}\/\d{4})?\s*$/.exec(titleText) : null;
  const body = /id="divBody"[^>]*>([\s\S]*?)<!--divBody-->/i.exec(html)?.[1];
  if (!t || !body) return null;
  const effective = /Effective Dates:(?:&nbsp;|\s)*([^<]+)</i.exec(body)?.[1];
  const tn = /<p\b[^>]*>\s*(TN\s+[^<]{1,40})<\/p>/i.exec(body)?.[1];
  const h1 = body.search(/<h1\b/i);
  return {
    citation: t[1],
    title: t[2],
    effectiveText: effective ? decodeEntities(effective).replace(/\s+/g, " ").trim() : null,
    transmittal: tn ? decodeEntities(tn).replace(/\s+/g, " ").trim() : null,
    html: h1 >= 0 ? body.slice(h1) : body,
  };
}

// ---------------------------------------------------------------------------
// Sitemaps (USDA FNS)
// ---------------------------------------------------------------------------

export type SitemapEntry = { loc: string; lastmod: string | null };

/** <loc> and <lastmod> of a sitemap (or the child sitemaps of a sitemap index). */
export function parseSitemap(xml: string): { kind: "index" | "urlset" | null; entries: SitemapEntry[] } {
  const kind = /<sitemapindex\b/i.test(xml) ? "index" : /<urlset\b/i.test(xml) ? "urlset" : null;
  const tag = kind === "index" ? "sitemap" : "url";
  const entries: SitemapEntry[] = [];
  for (const m of xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))) {
    const loc = /<loc>\s*([^<]+?)\s*<\/loc>/i.exec(m[1])?.[1];
    if (!loc) continue;
    entries.push({ loc: decodeEntities(loc), lastmod: /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i.exec(m[1])?.[1] ?? null });
  }
  return { kind, entries };
}

/** "Page updated: August 29, 2025" as printed on usda.gov pages. */
export function usdaUpdatedLine(html: string): string | null {
  const m = /Page updated:?\s*(?:<[^>]+>\s*)*([A-Z][a-z]+\.?\s+\d{1,2},\s*\d{4})/.exec(html);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Medicaid.gov federal policy guidance listing
// ---------------------------------------------------------------------------

export type FpgEntry = {
  nodeId: string;
  title: string;
  dateText: string | null;
  links: { url: string; label: string }[];
  type: string | null;
  topics: string[];
};

/** One page of medicaid.gov's federal policy guidance listing: an accordion entry per item (node id, title, date, links, type, topics). */
export function parseFpgListing(html: string, pageUrl: string): { entries: FpgEntry[]; lastPage: number | null } {
  const entries: FpgEntry[] = [];
  const starts = [...html.matchAll(/aria-controls="node-(\d+)"\s*>\s*([\s\S]*?)<\/button>/g)];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].index ?? 0;
    const to = i + 1 < starts.length ? (starts[i + 1].index ?? html.length) : html.length;
    const block = html.slice(from, to);
    const date = /<b>Date:<\/b>\s*([^<]+)/i.exec(block)?.[1];
    const linkPart = /<b>Link:<\/b>([\s\S]*?)<\/ul>/i.exec(block)?.[1] ?? "";
    const links = anchors(linkPart)
      .map((a) => ({ url: resolveUrl(a.href, pageUrl), label: a.text }))
      .filter((l): l is { url: string; label: string } => Boolean(l.url));
    const typePart = /<b>Type:<\/b>([\s\S]*?)<\/div>/i.exec(block)?.[1] ?? "";
    const topicPart = /<b>Topics:<\/b>([\s\S]*?)<\/div>/i.exec(block)?.[1] ?? "";
    const chips = (part: string) => [...part.matchAll(/<span class="usa-chip">([\s\S]*?)<\/span>/g)].map((m) => inlineText(m[1])).filter(Boolean);
    entries.push({
      nodeId: starts[i][1],
      title: inlineText(starts[i][2]),
      dateText: date ? decodeEntities(date).trim() : null,
      links,
      type: chips(typePart)[0] ?? null,
      topics: chips(topicPart),
    });
  }
  const pages = [...html.matchAll(/[?&](?:amp;)?page=(\d+)"/g)].map((m) => Number(m[1]));
  return { entries, lastPage: pages.length ? Math.max(...pages) : null };
}

// ---------------------------------------------------------------------------
// OMB information collections (www.reginfo.gov)
// ---------------------------------------------------------------------------

export type IcrRecord = {
  icrReferenceNumber: string;
  ombControlNumber: string | null;
  agencyCode: string | null;
  title: string;
  abstract: string | null;
  icrType: string | null;
  status: string | null;
  concludedDate: string | null;
  submissionDate: string | null;
  expirationDate: string | null;
  formNumbers: string[];
  cfrCitations: string[];
};

function xmlField(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() || null : null;
}

/** The ICRs of a reginfo.gov PRA XML report (inventory, pending, concluded); agency contacts are not read. */
export function parseIcrXml(xml: string): { recognized: boolean; records: IcrRecord[] } {
  if (!/<InformationCollectionRequestList\b/i.test(xml)) return { recognized: false, records: [] };
  const records: IcrRecord[] = [];
  for (const part of xml.split(/<InformationCollectionRequest>/).slice(1)) {
    const item = part.split(/<\/InformationCollectionRequest>/)[0].replace(/<AgencyContact>[\s\S]*?<\/AgencyContact>/gi, "");
    const ref = xmlField(item, "ICRReferenceNumber");
    const title = xmlField(item, "Title");
    if (!ref || !title) continue;
    const date = (block: string | null) => (block ? (/(\d{4}-\d{2}-\d{2})/.exec(block)?.[1] ?? null) : null);
    const cfr = [...item.matchAll(/<CFRCitation>\s*<CFRTitle>(\d+)<\/CFRTitle>\s*<CFRPart>([^<]+)<\/CFRPart>/gi)].map((m) => `${m[1]} CFR ${m[2].trim()}`);
    records.push({
      icrReferenceNumber: ref,
      ombControlNumber: xmlField(item, "OMBControlNumber"),
      agencyCode: xmlField(item, "AgencyCode"),
      title,
      abstract: xmlField(item, "Abstract"),
      icrType: xmlField(item, "ICRTypeCode"),
      status: xmlField(item, "ICRStatus"),
      concludedDate: date(/<ConcludedDate>([\s\S]*?)<\/ConcludedDate>/i.exec(item)?.[1] ?? null),
      submissionDate: date(/<SubmissionDate>([\s\S]*?)<\/SubmissionDate>/i.exec(item)?.[1] ?? null),
      expirationDate: date(xmlField(item, "ExpirationDate")),
      formNumbers: [...new Set([...item.matchAll(/<FormNumber>([^<]+)<\/FormNumber>/gi)].map((m) => decodeEntities(m[1]).trim()).filter(Boolean))],
      cfrCitations: [...new Set(cfr)],
    });
  }
  return { recognized: true, records };
}

export type IcrDocument = { label: string; fileName: string; url: string; uploaded: string | null; kind: "supporting_statement_a" | "supporting_statement_b" | "supplementary" };

/** The documents table of a PRAViewDocument page: Supporting Statement A and B, and the supplementary documents. */
export function parseIcrDocuments(html: string, pageUrl: string): { recognized: boolean; documents: IcrDocument[] } {
  if (!/Supporting Statement A/i.test(html)) return { recognized: false, documents: [] };
  const documents: IcrDocument[] = [];
  const sections = html.split(/<label>/i).slice(1);
  for (const section of sections) {
    const label = /^([^<]+)<\/label>/i.exec(section)?.[1]?.trim() ?? "";
    const kind = /^Supporting Statement A/i.test(label) ? "supporting_statement_a" : /^Supporting Statement B/i.test(label) ? "supporting_statement_b" : /^Supplementary/i.test(label) ? "supplementary" : null;
    if (!kind) continue;
    for (const row of tableRows(section.split(/<\/table>/i)[0])) {
      const docCell = row.find((c) => /DownloadDocument\?objectID=/i.test(c));
      if (!docCell) continue;
      const path = /["'](\/public\/do\/DownloadDocument\?objectID=\d+)["']/i.exec(docCell)?.[1];
      const url = path ? resolveUrl(path, pageUrl) : null;
      if (!url) continue;
      const cells = row.map((c) => inlineText(c));
      const fileName = inlineText(docCell);
      const uploaded = cells.find((c) => /^\d{2}\/\d{2}\/\d{4}$/.test(c)) ?? null;
      documents.push({ label: kind === "supplementary" ? cells[0] : label, fileName, url, uploaded, kind });
    }
  }
  return { recognized: true, documents };
}

export type IcrPage = {
  referenceNumber: string | null;
  status: string | null;
  agency: string | null;
  agencyTrackingNumber: string | null;
  title: string | null;
  collectionType: string | null;
  reviewType: string | null;
  conclusionAction: string | null;
  /** MM/DD/YYYY as printed. */
  conclusionDate: string | null;
  receivedDate: string | null;
  abstract: string | null;
  /** The IC list's form numbers ("I-130"), once each. */
  formNumbers: string[];
};

/**
 * A PRAViewICR page's labeled facts ("<label>Status:</label> Historical
 * Active") and its IC list's form numbers. The PRA XML reports of pending
 * and concluded reviews carry no abstract, status, type or forms; the page
 * states them. Contacts are not read.
 */
export function parseIcrPage(html: string): IcrPage | null {
  if (!/<label>\s*ICR Reference No:\s*<\/label>/i.test(html)) return null;
  const field = (label: string): string | null => {
    const re = new RegExp(`<label>\\s*${label}\\s*</label>([\\s\\S]*?)(?=<label>|</td>)`, "i");
    const m = re.exec(html);
    return m ? inlineText(m[1].replace(/<br\s*\/?>/gi, " ")).replace(/ /g, " ").trim() || null : null;
  };
  const formNumbers: string[] = [];
  const icTable = /<th>\s*IC Title\s*<\/th>\s*<th>\s*Form No\.\s*<\/th>([\s\S]*?)<\/table>/i.exec(html)?.[1] ?? "";
  for (const row of tableRows(icTable)) {
    const form = row[1] !== undefined ? inlineText(row[1]) : "";
    for (const f of form.split(/\s*,\s*/)) if (f && !formNumbers.includes(f)) formNumbers.push(f);
  }
  return {
    referenceNumber: field("ICR Reference No:"),
    status: field("Status:"),
    agency: field("Agency/Subagency:"),
    agencyTrackingNumber: field("Agency Tracking No:"),
    title: field("Title:"),
    collectionType: field("Type of Information Collection:"),
    reviewType: field("Type of Review Request:"),
    conclusionAction: field("OIRA Conclusion Action:"),
    conclusionDate: field("Conclusion Date:"),
    receivedDate: field("Date Received in OIRA:"),
    abstract: field("Abstract:"),
    formNumbers,
  };
}

// ---------------------------------------------------------------------------
// BLS Occupational Outlook Handbook (www.bls.gov/ooh)
// ---------------------------------------------------------------------------

/** The occupation profiles the A-Z index links (one per page; the index lists alternate titles too). */
export function parseOohIndex(html: string, pageUrl: string): { url: string; label: string }[] {
  const out: { url: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const a of anchors(html)) {
    const url = resolveUrl(a.href, pageUrl);
    if (!url) continue;
    const u = new URL(url);
    if (u.hostname !== "www.bls.gov" || !/^\/ooh\/[a-z0-9-]+\/[a-z0-9-]+\.htm$/i.test(u.pathname)) continue;
    // Group home pages, the Handbook's help pages and its print view (which
    // BLS's robots.txt disallows) are not profiles.
    if (/^\/ooh\/(?:about|how-to-find-a-job|print)\//i.test(u.pathname) || /\/home\.htm$/i.test(u.pathname)) continue;
    const clean = `${u.origin}${u.pathname}`;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push({ url: clean, label: a.text });
  }
  return out;
}

/** An OOH profile: its title, the tabs' content, the "Last modified date" and the suggested citation. */
export function parseOohProfile(html: string): { title: string | null; panes: string | null; lastModified: string | null; citation: string | null } {
  const start = html.indexOf('id="panes"');
  const citationAt = html.indexOf("Suggested citation", start);
  const panes = start >= 0 ? html.slice(html.indexOf(">", start) + 1, citationAt > start ? citationAt : undefined) : null;
  const lastModified = /Last modified date:\s*<\/strong>\s*([^<]+)</i.exec(html)?.[1]?.trim() ?? null;
  const citationHtml = citationAt > 0 ? /<p>([\s\S]*?)<\/p>/i.exec(html.slice(citationAt))?.[1] : null;
  return { title: firstH1(html), panes, lastModified, citation: citationHtml ? inlineText(citationHtml) : null };
}

// ---------------------------------------------------------------------------
// O*NET OnLine (www.onetonline.org)
// ---------------------------------------------------------------------------

/** The occupations the "All Occupations" page links (O*NET-SOC code and title). */
export function parseOnetAll(html: string, pageUrl: string): { url: string; code: string; title: string }[] {
  const out: { url: string; code: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const a of anchors(html)) {
    const url = resolveUrl(a.href, pageUrl);
    if (!url) continue;
    const m = /^\/link\/summary\/(\d{2}-\d{4}\.\d{2})$/.exec(new URL(url).pathname);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ url, code: m[1], title: a.text });
  }
  return out;
}

/** An O*NET summary page: title, code, the description under the title, sample job titles, job zone and the "updated" line. */
export function parseOnetSummary(html: string): {
  title: string | null;
  code: string | null;
  content: string | null;
  description: string | null;
  sampleTitles: string | null;
  jobZone: string | null;
  updatedText: string | null;
} {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
  const title = h1 ? inlineText(/<span class="main">([\s\S]*?)<\/span>/i.exec(h1[1])?.[1] ?? "") || null : null;
  const code = h1 ? (/(\d{2}-\d{4}\.\d{2})/.exec(h1[1])?.[1] ?? null) : null;
  const begin = html.indexOf("<!-- begin content -->");
  const endAt = html.indexOf("<!-- end content -->", begin);
  const content = begin >= 0 ? html.slice(begin, endAt > begin ? endAt : undefined) : null;
  const description = content ? (/<p>([\s\S]*?)<\/p>/i.exec(content)?.[1] ?? null) : null;
  const sample = content ? /Sample of reported job titles:<\/b>([\s\S]*?)<\/p>/i.exec(content)?.[1] : null;
  const zone = content ? /Job Zone\s+(One|Two|Three|Four|Five)\b/i.exec(content.replace(/<[^>]+>/g, " "))?.[1] : null;
  // The heading's "Updated 2026" badge: the year O*NET last updated the occupation's data (the footer's date is the site's).
  const updated = h1 ? (/Updated\s+(\d{4})\b/.exec(inlineText(h1[1]))?.[1] ?? null) : null;
  return {
    title,
    code,
    content,
    description: description ? inlineText(description) : null,
    sampleTitles: sample ? inlineText(sample) : null,
    jobZone: zone ? `Job Zone ${zone[0].toUpperCase()}${zone.slice(1).toLowerCase()}` : null,
    updatedText: updated,
  };
}
