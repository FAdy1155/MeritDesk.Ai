import { anchors, attrValue, decodeEntities, inlineText, metaContent, pageTitle, resolveUrl } from "../../extract/html";

// Pure page parsers for the country-conditions collectors: the State
// Department's report pages (www.state.gov and its 2009-2017 archive
// site), USCIRF's publications, and EUAA's publication pages. No I/O, so
// each can be tried on a saved page. A parser returns null (or an empty
// list) when the page does not have the layout it reads; the adapter turns
// that into a LibraryLayoutError.

// ---------------------------------------------------------------------------
// Shared helpers

/** The part of `html` from the first match of `start` to the earliest of `ends` after it (or the end); null without `start`. */
export function sliceFrom(html: string, start: RegExp, ends: RegExp[]): string | null {
  const s = start.exec(html);
  if (!s) return null;
  const from = s.index;
  let to = html.length;
  for (const end of ends) {
    const rest = html.slice(from + s[0].length);
    const m = end.exec(rest);
    if (m) to = Math.min(to, from + s[0].length + m.index);
  }
  return html.slice(from, to);
}

/** The inner text of the first element whose opening tag matches `open` (up to its first closing `tag`); null when absent. */
function elementText(html: string, open: RegExp, tag: string): string | null {
  const m = open.exec(html);
  if (!m) return null;
  const rest = html.slice(m.index + m[0].length);
  const close = new RegExp(`</${tag}\\s*>`, "i").exec(rest);
  const text = inlineText(close ? rest.slice(0, close.index) : rest);
  return text || null;
}

/** A 4-digit year (1990 to 2099) stated in `text`; null when none. */
export function statedYear(text: string | null | undefined): number | null {
  const m = /\b(19[89]\d|20\d\d)\b/.exec(text ?? "");
  return m ? Number(m[1]) : null;
}

/** The URL a `<meta http-equiv="Refresh" content="0;URL=...">` sends to, resolved; null when the page has none. */
export function metaRefreshUrl(html: string, pageUrl: string): string | null {
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = m[1];
    if ((attrValue(attrs, "http-equiv") ?? "").toLowerCase() !== "refresh") continue;
    const target = /url\s*=\s*['"]?([^'";]+)/i.exec(attrValue(attrs, "content") ?? "")?.[1];
    if (target) return resolveUrl(decodeEntities(target.trim()), pageUrl);
  }
  return null;
}

/** A Drupal pager's highest ?page=N and its rel="next" link (resolved against the page). */
export function pagerLinks(html: string, pageUrl: string): { lastPage: number; nextUrl: string | null } {
  let lastPage = 0;
  for (const a of anchors(html)) {
    const m = /[?&]page=(\d+)/.exec(decodeEntities(a.href));
    if (m) lastPage = Math.max(lastPage, Number(m[1]));
  }
  const next = /<a\b([^>]*\brel="next"[^>]*)>/i.exec(html);
  const href = next ? attrValue(next[1], "href") : null;
  return { lastPage, nextUrl: href ? resolveUrl(decodeEntities(href), pageUrl) : null };
}

// ---------------------------------------------------------------------------
// Sitemaps (www.state.gov publishes Yoast sitemaps with a lastmod per URL)

export type SitemapEntry = { loc: string; lastmod: string | null };

/** A sitemap index or URL set; null when the XML is neither. */
export function parseSitemap(xml: string): { kind: "index" | "urlset"; entries: SitemapEntry[] } | null {
  const kind = /<sitemapindex\b/i.test(xml) ? "index" : /<urlset\b/i.test(xml) ? "urlset" : null;
  if (!kind) return null;
  const tag = kind === "index" ? "sitemap" : "url";
  const entries: SitemapEntry[] = [];
  for (const m of xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "gi"))) {
    const loc = /<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/i.exec(m[1])?.[1];
    if (!loc) continue;
    const lastmod = /<lastmod\b[^>]*>([\s\S]*?)<\/lastmod\s*>/i.exec(m[1])?.[1]?.trim() ?? null;
    entries.push({ loc: decodeEntities(loc.replace(/<!\[CDATA\[|\]\]>/g, "").trim()), lastmod: lastmod || null });
  }
  return { kind, entries };
}

// ---------------------------------------------------------------------------
// www.state.gov report pages (2016 onward)

export type StateReportPage = {
  /** The page's headline: "2024 Country Reports on Human Rights Practices: Syria". */
  headline: string;
  /** The "Download Report" link, as written on the page. */
  pdfHref: string | null;
  /** The page's article:modified_time, as stated. */
  modified: string | null;
  /** The first section title in the report ("EXECUTIVE SUMMARY", "GUATEMALA (Tier 2)"). */
  firstSectionTitle: string | null;
  /** The report's own content, up to the page's side navigation and its "On This Page" list. */
  contentHtml: string;
};

/** A report page of www.state.gov's reports template; null when the headline or the report content is missing. */
export function parseStateReportPage(html: string): StateReportPage | null {
  const headline = elementText(html, /<h1\b[^>]*class="[^"]*report-header__headline[^"]*"[^>]*>/i, "h1");
  const content = sliceFrom(html, /<div\b[^>]*id="report_content"[^>]*>/i, [
    /<div\b[^>]*class="report__side"/i,
    /<nav\b[^>]*id="report-nav"/i,
    /<div\b[^>]*id="mininav_outer"/i,
    /<div\b[^>]*class="related-tags"/i,
    /<\/article\s*>/i,
    /<footer\b/i,
  ]);
  if (!headline || !content) return null;
  const meta = sliceFrom(html, /<div\b[^>]*class="[^"]*report-meta__link--download-pdf[^"]*"/i, [/<\/h5\s*>/i]);
  const pdfHref = meta ? (anchors(meta)[0]?.href ?? null) : null;
  const firstSectionTitle = elementText(content, /<h2\b[^>]*class="[^"]*report__section-title[^"]*"[^>]*>/i, "h2");
  return { headline, pdfHref, modified: metaContent(html, "article:modified_time"), firstSectionTitle, contentHtml: content };
}

/** The part of a report headline after "<report name>: ", the country or area as the page names it; null without a colon. */
export function headlineSubject(headline: string): string | null {
  const at = headline.indexOf(": ");
  const subject = at >= 0 ? headline.slice(at + 2).trim() : "";
  return subject || null;
}

/** The tier a Trafficking in Persons narrative states in its heading ("GUATEMALA (Tier 2)", "FRANCE: Tier 1"). */
export function statedTier(text: string | null): string | null {
  const m = /(?:\(|:\s*)(Tier\s+\d(?:\s+Watch\s+List)?|Special Case)\b/i.exec(text ?? "");
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

/**
 * The countries a grouped Trafficking in Persons narrative covers, from the
 * heading line each country's narrative opens with: the country and its
 * tier, alone on the line ("AFGHANISTAN (TIER 2)", "Haiti (Tier 2)",
 * "HAITI (TIER 2 - WATCH LIST)", "CONGO, DEMOCRATIC REPUBLIC OF THE: Tier
 * 3"). The names as written, each once, in the order of the text.
 */
export function narrativeHeadingCountries(text: string): string[] {
  const out: string[] = [];
  const heading = /^[ \t]*([A-ZÀ-Þ][\p{L}'’ ,.()&-]{1,60}?)[ \t]*(?:\([ \t]*(?:tier|special case)\b[^()\n]*\)|:[ \t]*(?:tier[ \t]+\d[\p{L} \t-]*|special case))[ \t]*$/gimu;
  for (const m of text.matchAll(heading)) {
    let name = m[1].trim();
    // A heading's name has no tier in it and starts with a capital (the flag makes the class case-blind).
    if (/\btier\b/i.test(name) || name[0] !== name[0].toUpperCase()) continue;
    // The reports' worked example ("COUNTRY X (Tier 2 Watch List)") is not a country.
    if (/^country [a-z]$/i.test(name)) continue;
    // A PDF can break an inverted name over two lines ("CONGO," or "CONGO, DEMOCRATIC", then "REPUBLIC OF THE (Tier 2)").
    if (/^(?:the|(?:democratic |islamic |people'?s )?republic of(?: the)?|federated states of|kingdom of(?: the)?)$/i.test(name)) {
      const before = text.slice(0, m.index ?? 0).replace(/\s+$/, "");
      const previous = /(?:^|\n)[ \t]*([^\n]{2,40})$/.exec(before)?.[1]?.trim();
      if (!previous || !/(?:,|\b(?:democratic|islamic|people'?s|federated))$/i.test(previous)) continue;
      name = `${previous} ${name}`;
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The 2009-2017 archive site (2009-2017.state.gov): report years before 2016

export type ArchiveYearLink = {
  /** The year the link text (or, failing that, the path) states. */
  year: number;
  /** The report's folder on the archive site ("2008", "2010_5"): country pages sit under it. */
  dir: string;
  url: string;
  text: string;
};

/**
 * The archive year links on a series landing page: anchors to `host` whose
 * path matches `indexPath` (its first group the folder name as written,
 * "2014humanrightsreport", "humanrightsreport", "2008"). The year comes from
 * the link text when it states one, else from the folder.
 */
export function parseArchiveYearLinks(html: string, pageUrl: string, host: string, indexPath: RegExp): ArchiveYearLink[] {
  const out = new Map<string, ArchiveYearLink>();
  for (const a of anchors(html)) {
    const url = resolveUrl(a.href, pageUrl);
    if (!url) continue;
    const u = new URL(url);
    if (u.hostname !== host) continue;
    const m = indexPath.exec(u.pathname);
    if (!m) continue;
    const folder = m[1];
    const year = statedYear(a.text) ?? statedYear(folder);
    if (!year) continue;
    // The interactive editions live in "<year>humanrightsreport/"; their country pages are under "<year>/".
    const dir = /^\d{4}(?:_\d+)?$/.test(folder) ? folder : String(year);
    u.protocol = "https:";
    u.hash = "";
    if (!out.has(dir)) out.set(dir, { year, dir, url: u.toString(), text: a.text });
  }
  return [...out.values()].sort((a, b) => b.year - a.year || b.dir.localeCompare(a.dir));
}

/** Link texts on archive indexes that are parts of a report, not a country's chapter. */
const FRONT_MATTER =
  /^(?:preface|introduction|overview|executive summary|appendi|addend|acknowledg|table of contents|letter\b|secretary|foreword|glossary|methodology|basic text|other years|note\b|message|home|report home|printer|download|pdf\b|frontmatter|front matter|statement|tier placements?|topics|victims|heroes|photo|closing|special case|relevant international|multilateral|stopping|global law|related|tvpa|trafficking victims protection|minimum standards|countries that are not|child soldiers|what is|commendable|major forms|punishing|u\.s\. government|human trafficking defined|meeting the global)/i;

export type ArchiveLink = { url: string; text: string; region: string | null };

/**
 * Links on an archive year page (or a region or narratives page) whose path
 * matches `pattern` (group 1, when present, is the region folder), resolved
 * against the page, on `host`, front matter left out, each URL once.
 */
export function archiveLinks(html: string, pageUrl: string, host: string, pattern: RegExp, keepFrontMatter = false): ArchiveLink[] {
  const seen = new Set<string>();
  const out: ArchiveLink[] = [];
  for (const a of anchors(html)) {
    const resolved = resolveUrl(a.href, pageUrl);
    if (!resolved) continue;
    const u = new URL(resolved);
    if (u.hostname !== host) continue;
    const m = pattern.exec(u.pathname);
    if (!m) continue;
    const text = a.text.replace(/\s+/g, " ").trim();
    if (!text || (!keepFrontMatter && FRONT_MATTER.test(text))) continue;
    u.protocol = "https:";
    u.hash = "";
    u.search = "";
    const url = u.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, text, region: m[1] ?? null });
  }
  return out;
}

export type ArchiveReportPage = {
  /** The page heading (id="page-title"): the country, or the part of the report. */
  heading: string;
  /** The report the page belongs to, as its header names it ("2008 Country Reports on Human Rights Practices"). */
  reportTitle: string | null;
  /** The release date line ("February 25, 2009"). */
  dateLong: string | null;
  /** The bureau line. */
  bureau: string | null;
  /** A PDF link in the page header, as written. */
  pdfHref: string | null;
  /** The page's <title>. */
  htmlTitle: string | null;
  /** The centre block: the report text. */
  contentHtml: string;
};

/** A page of the archive site's release template; null when the heading or the centre block is missing. */
export function parseArchiveReportPage(html: string): ArchiveReportPage | null {
  const heading = elementText(html, /<h2\b[^>]*id="page-title"[^>]*>/i, "h2");
  let content =
    sliceFrom(html, /<!--\s*CENTERBLOCK START\s*-->/i, [/<!--\s*CENTERBLOCK END\s*-->/i]) ??
    sliceFrom(html, /<div\b[^>]*id="centerblock"[^>]*>/i, [/<aside\b/i, /<footer\b/i]);
  if (!heading || !content) return null;
  // The interactive-era pages carry share icons, a permalink and a hidden table of contents before the text.
  content = content.replace(/<div\b[^>]*id="icons"[^>]*>[\s\S]*?<div\b[^>]*class="copylink-icon"[^>]*>[\s\S]*?<\/div>\s*<\/div>/i, " ");
  const toc = /<div\b[^>]*id=['"]toc['"][^>]*>/i.exec(content);
  if (toc) {
    const after = content.slice(toc.index);
    const firstHeading = /<h[1-3]\b/i.exec(after);
    if (firstHeading) content = content.slice(0, toc.index) + after.slice(firstHeading.index);
  }
  content = content.replace(/<span\b[^>]*class="link\d+"[^>]*>\s*Share\s*<\/span>/gi, " ");
  const topMeta = sliceFrom(html, /<div\b[^>]*id="top-meta"[^>]*>/i, [/<!--\s*CENTERBLOCK START\s*-->/i, /<div\b[^>]*id="centerblock"/i]) ?? "";
  const pdf = anchors(topMeta).find((a) => /\.pdf(?:$|[?#])/i.test(a.href));
  return {
    heading,
    reportTitle: elementText(html, /<span\b[^>]*class="report_title"[^>]*>/i, "span"),
    dateLong: elementText(html, /<div\b[^>]*id="date_long"[^>]*>/i, "div"),
    bureau: elementText(html, /<span\b[^>]*class="bureau"[^>]*>/i, "span"),
    pdfHref: pdf?.href ?? null,
    htmlTitle: pageTitle(html),
    contentHtml: content,
  };
}

// ---------------------------------------------------------------------------
// USCIRF (www.uscirf.gov): the publications list and a publication's page

export type UscirfListItem = { url: string; title: string; dateText: string | null; datetime: string | null; pdfUrl: string | null };

export type UscirfListPage = {
  items: UscirfListItem[];
  /** The highest ?page=N the pager links (0 when it links none). */
  lastPage: number;
  /** The pager's "next page" link, resolved; null on the last page. */
  nextUrl: string | null;
  /** The country names the list's country filter offers, as written (its non-country entries left out). */
  countries: string[];
};

/** One page of https://www.uscirf.gov/publications; null when the page has no publications view. */
export function parseUscirfList(html: string, pageUrl: string): UscirfListPage | null {
  if (!/class="[^"]*view-publications/i.test(html)) return null;
  const items: UscirfListItem[] = [];
  const rows = html.split(/<div\b[^>]*class="[^"]*\bviews-row\b[^"]*"[^>]*>/i).slice(1);
  for (const row of rows) {
    const title = elementText(row, /<h3\b[^>]*class="[^"]*government-counsel-title[^"]*"[^>]*>/i, "h3");
    // Most rows link /publications/<slug>; some link /publication/<slug>.
    const link = anchors(row).find((a) => /^(?:https:\/\/www\.uscirf\.gov)?\/publications?\/[^/?#]+$/i.test(a.href.trim()));
    if (!title || !link) continue;
    const url = resolveUrl(link.href, pageUrl);
    if (!url) continue;
    const time = /<time\b([^>]*)>([\s\S]*?)<\/time\s*>/i.exec(row);
    const pdf = anchors(row).find((a) => /\.pdf(?:$|[?#])/i.test(a.href));
    items.push({
      url,
      title,
      dateText: time ? inlineText(time[2]) || null : null,
      datetime: time ? attrValue(time[1], "datetime") : null,
      pdfUrl: pdf ? resolveUrl(pdf.href, pageUrl) : null,
    });
  }
  const countries = [...html.matchAll(/<div\b[^>]*data-target="country"[^>]*>([^<]*)/gi)]
    .map((m) => inlineText(m[1]))
    // The filter also offers "All Countries", "Entities of Particular Concern (EPC)" and "Others", which are not countries.
    .filter((c, i, all) => c && !/^(?:all countries|others?|entities\b.*)$/i.test(c) && all.indexOf(c) === i);
  return { items, ...pagerLinks(html, pageUrl), countries };
}

export type UscirfPublication = {
  title: string | null;
  descriptionHtml: string | null;
  /** The page's "View PDF" button. */
  pdfHref: string | null;
  /** The PDFs the description links (href as written, link text), each once: older pages link their file, or a run of annual report chapters, there. */
  descriptionPdfs: { href: string; text: string }[];
};

/** A publication page: the hero title, the description and the "View PDF" link; null without the main content block. */
export function parseUscirfPublication(html: string): UscirfPublication | null {
  const main = sliceFrom(html, /<div\b[^>]*id="block-uscirf2020-content"[^>]*>/i, [/<footer\b/i]);
  if (!main) return null;
  const description = sliceFrom(main, /<div\b[^>]*class="full-content"[^>]*>/i, [/<a\b[^>]*class="[^"]*single-cta-btn/i, /<div\b[^>]*id="block-taxonomytermview"/i]);
  const button = /<a\b([^>]*class="[^"]*single-cta-btn[^"]*"[^>]*)>/i.exec(main);
  const buttonHref = button ? attrValue(button[1], "href") : null;
  const descriptionPdfs = (description ? anchors(description) : [])
    .filter((a) => /\.pdf(?:$|[?#])/i.test(a.href))
    .map((a) => ({ href: a.href.trim(), text: a.text.replace(/\s+/g, " ").trim() }))
    .filter((a, i, all) => all.findIndex((b) => b.href === a.href) === i);
  return {
    title: elementText(html, /<h1\b[^>]*class="[^"]*internal-hero-title[^"]*"[^>]*>/i, "h1"),
    descriptionHtml: description,
    pdfHref: buttonHref && /\.pdf(?:$|[?#])/i.test(buttonHref) ? buttonHref : null,
    descriptionPdfs,
  };
}

// ---------------------------------------------------------------------------
// EUAA (www.euaa.europa.eu): the publications list filtered to Country of
// Origin Information, and a publication's page

export type EuaaListItem = { url: string; title: string; dateText: string | null; datetime: string | null; summaryText: string | null; pdfUrl: string | null };

export type EuaaListPage = { items: EuaaListItem[]; lastPage: number; nextUrl: string | null };

/** One page of the publications list; null when the page has no publications view. */
export function parseEuaaList(html: string, pageUrl: string): EuaaListPage | null {
  const view = sliceFrom(html, /<div\b[^>]*class="[^"]*view-content[^"]*"[^>]*>/i, [/<nav\b[^>]*aria-label="pagination/i, /<ul\b[^>]*class="[^"]*pagination/i, /<footer\b/i]);
  // Past the last page the view prints its filter form and no results.
  if (!view) return /views-exposed-form-publications/i.test(html) ? { items: [], lastPage: 0, nextUrl: null } : null;
  const items: EuaaListItem[] = [];
  const panels = view.split(/<div\b[^>]*class="[^"]*euaa-panel--publication[^"]*"[^>]*>/i).slice(1);
  for (const panel of panels) {
    const h3 = /<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/i.exec(panel);
    const link = h3 ? anchors(h3[1])[0] : undefined;
    if (!link) continue;
    const url = resolveUrl(link.href, pageUrl);
    if (!url || !/\/publications\/[^/?#]+$/.test(new URL(url).pathname)) continue;
    const time = /<time\b([^>]*)>([\s\S]*?)<\/time\s*>/i.exec(panel);
    const body = sliceFrom(panel, /<div\b[^>]*field--name-body[^>]*>/i, [/<\/div\s*>/i]);
    const pdf = anchors(panel).find((a) => /\.pdf(?:$|[?#])/i.test(a.href));
    items.push({
      url,
      title: link.text,
      dateText: time ? inlineText(time[2]) || null : null,
      datetime: time ? attrValue(time[1], "datetime") : null,
      summaryText: body ? inlineText(body) || null : null,
      pdfUrl: pdf ? resolveUrl(pdf.href, pageUrl) : null,
    });
  }
  return { items, ...pagerLinks(html, pageUrl) };
}

export type EuaaPublication = {
  title: string | null;
  /** "Geographical coverage" values, as written. */
  geoCoverage: string[];
  keywords: string[];
  author: string | null;
  dateText: string | null;
  datetime: string | null;
  /** The description the page prints above the file. */
  bodyHtml: string | null;
  /** The category badge ("Country of Origin Information"). */
  category: string | null;
  pdfUrl: string | null;
};

/** The labelled field values of a Drupal field block named `name` (field--name-<name>). */
function fieldItems(html: string, name: string): string[] {
  const block = sliceFrom(html, new RegExp(`<div\\b[^>]*field--name-${name}\\b[^>]*>`, "i"), [/<div\b[^>]*field--name-/i]);
  if (!block) return [];
  const out: string[] = [];
  for (const m of block.matchAll(/<(?:div|span)\b[^>]*class="field__item"[^>]*>([\s\S]*?)<\/(?:div|span)\s*>/gi)) {
    const v = inlineText(m[1]);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** A publication page; null when it has no title. */
export function parseEuaaPublication(html: string, pageUrl: string): EuaaPublication | null {
  const title = metaContent(html, "og:title") ?? elementText(html, /<h1\b[^>]*>/i, "h1");
  if (!title) return null;
  const dateBlock = sliceFrom(html, /<div\b[^>]*class="field__label"[^>]*>\s*Date\s*<\/div>/i, [/<\/time\s*>/i]);
  const time = dateBlock ? /<time\b([^>]*)>([\s\S]*)$/i.exec(dateBlock) : null;
  const body = sliceFrom(html, /<div\b[^>]*field--name-body\b[^>]*>/i, [/<a\b[^>]*target="_blank"[^>]*href="[^"]*\.pdf/i, /<div\b[^>]*euaa-publication-detail__metadata/i]);
  const file = sliceFrom(html, /<div\b[^>]*field--name-field-publication-file\b[^>]*>/i, [/<\/object\s*>/i]) ?? "";
  const data = /\b(?:data|src)="([^"]+\.pdf)(?:#[^"]*)?"/i.exec(file)?.[1] ?? anchors(html).find((a) => /\.pdf(?:$|[?#])/i.test(a.href))?.href ?? null;
  const badge = /<div\b[^>]*class="[^"]*euaa-badge[^"]*"[^>]*>([\s\S]*?)<\/div\s*>/i.exec(html);
  return {
    title: title.replace(/\s+/g, " ").trim(),
    geoCoverage: fieldItems(html, "field-geo-coverage"),
    keywords: fieldItems(html, "field-keywords"),
    author: fieldItems(html, "field-author")[0] ?? null,
    dateText: time ? inlineText(time[2]) || null : null,
    datetime: time ? attrValue(time[1], "datetime") : null,
    bodyHtml: body,
    category: badge ? inlineText(badge[1]) || null : null,
    pdfUrl: data ? resolveUrl(decodeEntities(data.split("#")[0]), pageUrl) : null,
  };
}
