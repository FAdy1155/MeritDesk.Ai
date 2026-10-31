import { anchors, attrValue, decodeEntities, htmlToDocumentText, inlineText, resolveUrl, tableRows } from "../../extract/html";

// Pure parsers for the oversight reports, INA legislative history and
// treaty collectors in this folder (GAO, GovInfo, DHS OIG, the UN Treaty
// Collection, UNHCR). No network and no database: each takes a fetched page
// or record and returns what it states, or a "recognized: false" result the
// adapter turns into a LibraryLayoutError.

// ---------------------------------------------------------------------------
// Immigration subjects
// ---------------------------------------------------------------------------

// Words and phrases that mark a report, an act or a CRS product as being
// about immigration. Lower-case words match in any case; the agency and
// program acronyms match only in capitals ("ICE", not "office").
const IMMIGRATION_WORDS =
  /\b(?:immigra\w*|emigra\w*|migrants?|migration|asylum|asylees?|refugees?|visas?|naturaliz\w*|citizenship|deport\w*|aliens?(?!\s+(?:species|plants?|animals?|invasive|property))|noncitizens?|non-citizens?|undocumented|unaccompanied (?:alien |migrant )?(?:children|minors)|border (?:security|patrol|wall|barriers?|crossings?|enforcement|apprehensions?|agents?)|temporary protected status|deferred action|green cards?|e-verify|public charge|human smuggling|removal proceedings|expedited removal|immigration courts?|nationality act|foreign nationals?|(?:ports?|points?) of entry|entry-exit|overstays?)\b/i;
const IMMIGRATION_ACRONYMS = /\b(?:USCIS|ICE|CBP|EOIR|INS|DACA|TPS|H-1B|H-2A|H-2B|EB-5|SEVP|SEVIS|US-VISIT|ORR|INA)\b/;

/** The immigration words and acronyms a text uses (deduplicated, in order), for deciding and for recording why. */
export function immigrationTerms(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const re of [new RegExp(IMMIGRATION_WORDS.source, "gi"), new RegExp(IMMIGRATION_ACRONYMS.source, "g")]) {
    for (const m of text.matchAll(re)) {
      const key = m[0].toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(m[0]);
      }
    }
  }
  return out;
}

// Terms that also name customs, trade, port and maritime security work: on their own they do not
// make a report an immigration report (GAO files its cargo-container reports under "Border security"
// and "CBP Secure Freight Initiative").
const WEAK_TERMS = /^(?:border security|(?:ports?|points?) of entry|foreign nationals?|CBP)$/i;

/** Whether the terms immigrationTerms found decide: at least one that is not only a border or port term. */
export function isImmigrationMatch(terms: string[]): boolean {
  return terms.some((t) => !WEAK_TERMS.test(t));
}

// The stricter test for an Act's titles in the Statutes at Large, where
// "ports of entry" or "foreign nationals" also name customs and tax laws.
const ACT_WORDS =
  /\b(?:immigra\w*|naturaliz\w*|nationality|refugees?|(?<!lying-in |insane |lunatic |infant |orphans?'? )asylum|asylees?|visas?|aliens?(?!\s+(?:property|species|plants?|animals?))|deport\w*|(?<!diversity of |honorary )citizenship|border (?:patrol|security|control|fence)|international land (?:and maritime )?borders?|undocumented|temporary protected status)\b/gi;

// Acts that amended the INA, or carry immigration titles, under short titles that use none of the
// words above (the REAL ID Act sits in a supplemental appropriations law, NACARA in the District
// of Columbia appropriations law, the T and U visas in trafficking and violence-against-women laws,
// the aggravated felony definition in the Anti-Drug Abuse Act of 1988, the CAT's implementation in
// the Foreign Affairs Reform and Restructuring Act of 1998 and the H-1B changes of ACWIA in the
// 1999 omnibus law). A short title or name-index title must be one of these names (with its year),
// not merely mention it: "USA PATRIOT Act Additional Reauthorizing Amendments Act of 2006" and "An
// act to amend the Foreign Affairs Reform and Restructuring Act of 1998 to reauthorize the
// United States Advisory Commission on Public Diplomacy" are not immigration laws.
const ACT_NAMES = [
  "REAL ID Act",
  "Nicaraguan Adjustment and Central American Relief Act",
  "Victims of Trafficking and Violence Protection Act",
  "Trafficking Victims Protection (?:Reauthorization )?Act",
  "Violence Against Women (?:Act|and Department of Justice Reauthorization Act)",
  "Battered Immigrant Women Protection Act",
  "Personal Responsibility and Work Opportunity Reconciliation Act",
  "Uniting and Strengthening America by Providing Appropriate Tools Required to Intercept and Obstruct Terrorism \\(USA PATRIOT ACT\\) Act",
  "USA PATRIOT Act",
  "Homeland Security Act",
  "Secure Fence Act",
  "Intelligence Reform and Terrorism Prevention Act",
  "Anti-Drug Abuse Act",
  "Foreign Affairs Reform and Restructuring Act",
  "American Competitiveness and Workforce Improvement Act",
  "Chinese Student Protection Act",
  "International Religious Freedom Act",
];
const ACT_NAME_EXACT = new RegExp(`^(?:${ACT_NAMES.join("|")})(?:\\s+of\\s+\\d{4})?\\.?$`, "i");

/** The immigration words an Act's title uses (deduplicated, in order). */
export function actImmigrationTerms(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(ACT_WORDS)) {
    const key = m[0].toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(m[0]);
    }
  }
  return out;
}

/** The short or name-index titles that are one of the known immigration Acts (ACT_NAMES). */
export function knownImmigrationActs(titles: string[]): string[] {
  return [...new Set(titles.map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => ACT_NAME_EXACT.test(t)))];
}

/**
 * Whether a public law in the Statutes at Large is an immigration law for the INA's legislative
 * history: its title or a long title uses an immigration word (ownTitle: the law itself is on
 * immigration, so its committee reports are collected), or else a short or name-index title uses
 * one, or the title, a short title or a name-index title is a known immigration Act (the law is or
 * contains one: the Homeland Security Act of 2002 carries no immigration word in its titles).
 * Commemorative resolutions are left out.
 */
export function classifyStatuteLaw(g: Pick<StatuteGranule, "title" | "longTitles" | "shortTitles" | "indexTitles">): { terms: string[]; ownTitle: boolean } | null {
  if (isCommemorative(g.title)) return null;
  const own = actImmigrationTerms([g.title, ...g.longTitles].join("\n"));
  if (own.length) return { terms: own, ownTitle: true };
  const named = [...new Set([...actImmigrationTerms([...g.shortTitles, ...g.indexTitles].join("\n")), ...knownImmigrationActs([g.title, ...g.shortTitles, ...g.indexTitles])])];
  return named.length ? { terms: named, ownTitle: false } : null;
}

// ---------------------------------------------------------------------------
// XML helpers (sitemaps, RSS, MODS)
// ---------------------------------------------------------------------------

/** The decoded text of the first <tag> in a fragment (CDATA unwrapped); null when absent. */
export function xmlField(fragment: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i").exec(fragment);
  if (!m) return null;
  const raw = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
  return decodeEntities(raw).trim();
}

/** Every <tag>...</tag> body in a fragment. */
function xmlAll(fragment: string, tag: string): string[] {
  return [...fragment.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi"))].map((m) => m[1]);
}

/** The attributes text of every <tag ...> (self-closing or not). */
function xmlAttrs(fragment: string, tag: string): string[] {
  return [...fragment.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "gi"))].map((m) => m[1]);
}

/** The committees a MODS record names ("House Committee on the Judiciary"), each from its own <congCommittee> block. */
function committeesOf(fragment: string): string[] {
  const out = new Set<string>();
  for (const m of fragment.matchAll(/<congCommittee\b([^>]*)>([\s\S]*?)<\/congCommittee\s*>/gi)) {
    const chamber = attrValue(m[1], "chamber");
    const name =
      /<name\s+type="authority-standard">([^<]+)</i.exec(m[2])?.[1] ?? /<name\s+type="parsed">([^<]+)</i.exec(m[2])?.[1] ?? /<name\s+type="authority-short">([^<]+)</i.exec(m[2])?.[1];
    const clean = name ? oneLine(decodeEntities(name)) : null;
    const house = chamber === "H" ? "House" : chamber === "S" ? "Senate" : chamber === "J" ? "Joint" : "";
    if (clean) out.add(`${house} ${clean}`.trim());
  }
  return [...out];
}

function oneLine(text: string | null): string | null {
  const s = text?.replace(/\s+/g, " ").trim() ?? "";
  return s || null;
}

export type SitemapEntry = { loc: string; lastmod: string | null };

/** A sitemap index (<sitemap> entries) or a urlset (<url> entries). */
export function parseSitemap(xml: string): { recognized: boolean; kind: "index" | "urlset" | null; entries: SitemapEntry[] } {
  const kind = /<sitemapindex\b/i.test(xml) ? "index" : /<urlset\b/i.test(xml) ? "urlset" : null;
  if (!kind) return { recognized: false, kind: null, entries: [] };
  const entries: SitemapEntry[] = [];
  for (const body of xmlAll(xml, kind === "index" ? "sitemap" : "url")) {
    const loc = xmlField(body, "loc");
    if (loc) entries.push({ loc, lastmod: xmlField(body, "lastmod") });
  }
  return { recognized: true, kind, entries };
}

// ---------------------------------------------------------------------------
// GAO (www.gao.gov): the reports RSS feed and a product page
// ---------------------------------------------------------------------------

export type RssItem = { title: string; link: string; description: string | null; pubDate: string | null; guid: string | null };

/** The items of an RSS 2.0 feed; recognized only when it has a <channel>. */
export function parseRss(xml: string): { recognized: boolean; items: RssItem[] } {
  if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml)) return { recognized: false, items: [] };
  const items: RssItem[] = [];
  for (const body of xmlAll(xml, "item")) {
    const title = oneLine(xmlField(body, "title"));
    const link = xmlField(body, "link");
    if (!title || !link) continue;
    items.push({ title, link, description: xmlField(body, "description"), pubDate: xmlField(body, "pubDate"), guid: xmlField(body, "guid") });
  }
  return { recognized: true, items };
}

/** "GAO-26-108157" from a GAO product link (https://www.gao.gov/products/gao-26-108157); null for other links. */
export function gaoProductId(link: string): string | null {
  const m = /^https:\/\/(?:www\.)?gao\.gov\/products\/([a-z0-9][a-z0-9-]*)\/?$/i.exec(link.trim());
  return m ? m[1].toUpperCase() : null;
}

export type GaoProductPage = {
  title: string;
  reportNumber: string | null;
  /** The "Published: ... Publicly Released: ..." line as printed. */
  dateLine: string | null;
  publishedText: string | null;
  releasedText: string | null;
  fastFacts: string | null;
  highlights: string | null;
  /** Links in the page's report files block, with their labels ("Full Report", "Highlights Page", "Accessible PDF"). */
  files: { label: string; url: string; pages: string | null }[];
  topics: string[];
  subjectTerms: string[];
};

/** A GAO product page (https://www.gao.gov/products/<id>); null when it has no product title. */
export function parseGaoProductPage(html: string, pageUrl: string): GaoProductPage | null {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
  if (!h1 || !/page-node-type-product|node--type-product/.test(html)) return null;
  const title = inlineText(h1[1]);
  if (!title) return null;
  const info = /<section\b[^>]*block-post-title-info[^>]*>([\s\S]*?)<\/section\s*>/i.exec(html)?.[1] ?? "";
  const reportNumber = oneLine(inlineText(/<strong\b[^>]*>([\s\S]*?)<\/strong\s*>/i.exec(info)?.[1] ?? "")) ?? null;
  const dateLine = oneLine(/Published:[^<]*/i.exec(inlineText(info.replace(/<\/span>/gi, "</span>\n")))?.[0] ?? null);
  const publishedText = dateLine ? (oneLine(/Published:\s*([^.]+\d{4})/i.exec(dateLine)?.[1] ?? null) ?? null) : null;
  const releasedText = dateLine ? (oneLine(/Publicly Released:\s*([^.]+\d{4})/i.exec(dateLine)?.[1] ?? null) ?? null) : null;

  const field = (name: string): string | null => {
    const m = new RegExp(`<div\\b[^>]*field--name-${name}\\b[^>]*>[\\s\\S]*?<div class="field__item">([\\s\\S]*?)<\\/div>\\s*<\\/div>`, "i").exec(html);
    if (!m) return null;
    const text = htmlToDocumentText(m[1]);
    return text || null;
  };
  const fastFacts = field("field-fast-facts-description");
  const highlights = field("product-highlights-custom");

  const files: GaoProductPage["files"] = [];
  for (const m of html.matchAll(/<figure\b[^>]*media--view-mode-full[-_]report[-_]teaser[^>]*>([\s\S]*?)<\/figure\s*>/gi)) {
    const a = anchors(m[1])[0];
    if (!a) continue;
    const url = resolveUrl(a.href, pageUrl);
    const label = inlineText(/field--name-field-link-label[^>]*>([\s\S]*?)<\/div\s*>/i.exec(m[1])?.[1] ?? "") || a.text;
    const pages = oneLine(inlineText(/field--name-file_type_num_pages_only[^>]*>([\s\S]*?)<\/div\s*>/i.exec(m[1])?.[1] ?? ""));
    if (url) files.push({ label, url, pages });
  }

  const topicsBlock = /<h2\b[^>]*>\s*Topics\s*<\/h2>([\s\S]*?)<\/main\s*>/i.exec(html)?.[1] ?? "";
  const topics = [...topicsBlock.matchAll(/views-field-field-topic[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)].map((m) => inlineText(m[1])).filter(Boolean);
  const subjectTerms = [...(/views-field-field-subject-term[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(topicsBlock)?.[1] ?? "").matchAll(/<span\b[^>]*>([\s\S]*?)<\/span\s*>/gi)]
    .map((m) => inlineText(m[1]))
    .filter(Boolean);

  return { title, reportNumber, dateLine, publishedText, releasedText, fastFacts, highlights, files, topics, subjectTerms };
}

// ---------------------------------------------------------------------------
// GovInfo MODS: GAO reports (GAOREPORTS), Statutes at Large (STATUTE),
// committee reports (CRPT and the Serial Set)
// ---------------------------------------------------------------------------

export type GovinfoLinks = { details: string | null; pdf: string | null; html: string | null };

function modsLinks(fragment: string): GovinfoLinks {
  const links: GovinfoLinks = { details: null, pdf: null, html: null };
  for (const m of fragment.matchAll(/<url\b([^>]*)>([\s\S]*?)<\/url\s*>/gi)) {
    const label = (attrValue(m[1], "displayLabel") ?? "").toLowerCase();
    const url = decodeEntities(m[2]).trim();
    if (!/^https:\/\//.test(url)) continue;
    if (label === "content detail" && !links.details) links.details = url;
    else if (label === "pdf rendition" && !links.pdf) links.pdf = url;
    else if (label === "html rendition" && !links.html) links.html = url;
  }
  return links;
}

export type GaoReportMods = {
  accessId: string;
  reportNumber: string | null;
  title: string;
  dateIssued: string | null;
  docClass: string | null;
  productType: string | null;
  subjects: string[];
  abstract: string | null;
  sudoc: string | null;
  pages: string | null;
  links: GovinfoLinks;
};

/** A GovInfo GAOREPORTS package's MODS record; null when it is not one. */
export function parseGaoReportMods(xml: string): GaoReportMods | null {
  if (!/<collectionCode>\s*GAOREPORTS\s*</i.test(xml)) return null;
  const accessId = xmlField(xml, "accessId");
  const title = oneLine(xmlField(/<titleInfo\b[^>]*>([\s\S]*?)<\/titleInfo\s*>/i.exec(xml)?.[1] ?? "", "title"));
  if (!accessId || !title) return null;
  const extension = xmlAll(xml, "extension").join("\n");
  const subjects = [...new Set(xmlAll(extension, "subject").map((s) => oneLine(decodeEntities(s))).filter((s): s is string => Boolean(s)))];
  return {
    accessId,
    reportNumber: xmlField(extension, "reportNumber"),
    title,
    dateIssued: /<dateIssued\b[^>]*encoding="w3cdtf"[^>]*>(\d{4}-\d{2}-\d{2})</i.exec(xml)?.[1] ?? null,
    docClass: xmlField(extension, "docClass"),
    productType: xmlField(extension, "type"),
    subjects,
    abstract: oneLine(xmlField(xml, "abstract")),
    sudoc: xmlField(xml, "classification"),
    pages: xmlField(xml, "extent"),
    links: modsLinks(xml),
  };
}

export type StatuteGranule = {
  accessId: string;
  granuleClass: string;
  title: string;
  /** "Public Law 104-208", as the record's search title states it. */
  publicLaw: string | null;
  citation: string | null;
  approvedDate: string | null;
  congress: string | null;
  lawNumber: string | null;
  volume: string | null;
  pageStart: string | null;
  pageEnd: string | null;
  longTitles: string[];
  shortTitles: string[];
  /** The short titles and popular names the Statutes at Large name index gives the law. */
  indexTitles: string[];
  reports: { congress: string; number: string; chamber: "H" | "S" }[];
  bills: { congress: string; number: string; type: string; priority: string | null }[];
  committees: string[];
  links: GovinfoLinks;
};

/** The granules (one per law, resolution or proclamation) of a STATUTE package's MODS record. */
export function parseStatuteVolumeMods(xml: string): { recognized: boolean; packageId: string | null; granules: StatuteGranule[] } {
  if (!/<collectionCode>\s*STATUTE\s*</i.test(xml)) return { recognized: false, packageId: null, granules: [] };
  const packageId = /<accessId>\s*(STATUTE-\d+)\s*</i.exec(xml)?.[1] ?? null;
  const granules: StatuteGranule[] = [];
  // Each constituent block ends with its <extension>; links and citations come before it.
  for (const m of xml.matchAll(/<relatedItem\s+type="constituent"\s+ID="id-([^"]+)"[^>]*>([\s\S]*?)<\/extension>/gi)) {
    const body = m[2];
    const granuleClass = xmlField(body, "granuleClass");
    const title = oneLine(xmlField(/<titleInfo\b[^>]*>([\s\S]*?)<\/titleInfo\s*>/i.exec(body)?.[1] ?? "", "title"));
    if (!granuleClass || !title) continue;
    const searchTitle = xmlField(body, "searchTitle") ?? "";
    const reports: StatuteGranule["reports"] = [];
    for (const attrs of xmlAttrs(body, "congReport")) {
      const congress = attrValue(attrs, "congress");
      const number = attrValue(attrs, "number");
      const chamber = attrValue(attrs, "type");
      if (congress && number && (chamber === "H" || chamber === "S")) reports.push({ congress, number, chamber });
    }
    const bills: StatuteGranule["bills"] = [];
    for (const attrs of xmlAttrs(body, "bill")) {
      const congress = attrValue(attrs, "congress");
      const number = attrValue(attrs, "number");
      const type = attrValue(attrs, "type");
      if (congress && number && type) bills.push({ congress, number, type, priority: attrValue(attrs, "priority") });
    }
    granules.push({
      accessId: xmlField(body, "accessId") ?? m[1],
      granuleClass,
      title,
      publicLaw: /\bPublic Law (\d+-\d+)/.exec(searchTitle)?.[0] ?? null,
      citation: /<identifier type="preferred citation">([^<]+)</i.exec(body)?.[1]?.trim() ?? null,
      approvedDate: /<granuleDate>(\d{4}-\d{2}-\d{2})</i.exec(body)?.[1] ?? null,
      congress: /<congress\b[^>]*>(\d+)</i.exec(body)?.[1] ?? null,
      lawNumber: xmlField(body, "number"),
      volume: xmlField(body, "volume"),
      pageStart: xmlField(body, "start"),
      pageEnd: xmlField(body, "end"),
      longTitles: xmlAll(body, "titles").map((t) => oneLine(decodeEntities(t))).filter((t): t is string => Boolean(t)),
      shortTitles: [...body.matchAll(/<shortTitle\s+context="CONTENT">([^<]*)</gi)].map((s) => oneLine(decodeEntities(s[1]))).filter((t): t is string => Boolean(t)),
      indexTitles: [...body.matchAll(/<shortTitle\s+context="NAMEINDEX">([^<]*)</gi)].map((s) => oneLine(decodeEntities(s[1]))).filter((t): t is string => Boolean(t)),
      reports,
      bills,
      committees: committeesOf(body),
      links: modsLinks(body),
    });
  }
  return { recognized: true, packageId, granules };
}

/** A commemorative resolution or designation ("to designate October 30, 1990, as 'Refugee Day'"): not legislative history of the Act. */
export function isCommemorative(title: string): boolean {
  return /\bdesignat\w*\b[\s\S]*\b(?:day|week|month|year)\b/i.test(title) && /^(?:a\s+)?joint resolution\b/i.test(title);
}

export type CommitteeReportMods = {
  accessId: string;
  collection: string;
  title: string;
  /** Present only when the record gives a full date (the Serial Set often states only the year). */
  dateIssued: string | null;
  year: number | null;
  docClass: string | null;
  congress: string | null;
  number: string | null;
  session: string | null;
  serialSetNumber: string | null;
  subtitle: string | null;
  committees: string[];
  links: GovinfoLinks;
};

/** A committee report's MODS record (GovInfo CRPT, or a report in the digitized Serial Set). */
export function parseCommitteeReportMods(xml: string): CommitteeReportMods | null {
  const collection = /<collectionCode>\s*(CRPT|SERIALSET)\s*</i.exec(xml)?.[1] ?? null;
  const accessId = xmlField(xml, "accessId");
  const title = oneLine(xmlField(/<titleInfo\b[^>]*>([\s\S]*?)<\/titleInfo\s*>/i.exec(xml)?.[1] ?? "", "title"));
  if (!collection || !accessId || !title) return null;
  // The Serial Set records a report's year only: its originInfo carries "1986-01-01" and
  // its extension says the day and month are not specified, so no full date is kept.
  const dayUnknown = /<dateIssued\b[^>]*notSpecified="[^"]*day/i.test(xml);
  const fullDate = dayUnknown ? null : (/<dateIssued\b[^>]*encoding="w3cdtf"[^>]*>(\d{4}-\d{2}-\d{2})</i.exec(xml)?.[1] ?? null);
  const yearText = /<dateIssued\b[^>]*>(\d{4})/i.exec(xml)?.[1] ?? null;
  const subtitle = oneLine(xmlField(xml, "subTitle") ?? xmlField(xml, "subtitle"));
  return {
    accessId,
    collection,
    title,
    dateIssued: fullDate,
    year: yearText ? Number(yearText) : null,
    docClass: xmlField(xml, "docClass"),
    congress: /<congress\b[^>]*>(\d+)</i.exec(xml)?.[1] ?? null,
    number: xmlField(xml.slice(Math.max(0, xml.search(/<docClass>/i))), "number"),
    session: xmlField(xml, "session"),
    serialSetNumber: xmlField(xml, "serialSetNumber"),
    subtitle: subtitle ? subtitle.slice(0, 600) : null,
    committees: committeesOf(xml),
    links: modsLinks(xml),
  };
}

/** The text of a GovInfo HTML rendition (a <pre> body for older collections), or of the page body. */
export function govinfoHtmlText(html: string): string {
  const pre = xmlAll(html, "pre");
  if (pre.length) return htmlToDocumentText(pre.map((p) => `<pre>${p.replace(/\n/g, "<br>")}</pre>`).join("\n"));
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html)?.[1] ?? html;
  return htmlToDocumentText(body);
}

// ---------------------------------------------------------------------------
// DHS Office of Inspector General (www.oig.dhs.gov) report listings
// ---------------------------------------------------------------------------

/** reportNumber is null for the few older management alerts the OIG lists without one. */
export type OigRow = { reportNumber: string | null; title: string; fileUrl: string; dateTime: string | null; dateText: string | null; fiscalYear: string | null };

export type OigListing = {
  recognized: boolean;
  rows: OigRow[];
  /** The listing's agency filter: its form's action and field name, and the options by label (CBP, ICE, USCIS, ...). */
  agencyFilter: { action: string; field: string; options: Record<string, string>; otherFields: Record<string, string> } | null;
  nextUrl: string | null;
  notes: string[];
};

/** A DHS OIG report listing (audits, inspections and evaluations; management alerts): one table row per report. */
export function parseOigListing(html: string, pageUrl: string): OigListing {
  const notes: string[] = [];
  const table = /<table\b[^>]*views-table[^>]*>([\s\S]*?)<\/table\s*>/i.exec(html)?.[1] ?? null;
  const emptyView = /<div\b[^>]*view-empty[^>]*>/i.test(html);
  const rows: OigRow[] = [];
  if (table) {
    for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
      const cells = [...row[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td\s*>/gi)];
      if (cells.length === 0) continue;
      const cell = (pattern: RegExp) => cells.find((c) => pattern.test(attrValue(c[1], "headers") ?? ""))?.[2] ?? null;
      const numberCell = cell(/report-number/);
      const titleCell = cell(/view-title/);
      const reportNumber = oneLine(inlineText(numberCell ?? ""));
      const link = titleCell ? anchors(titleCell)[0] : undefined;
      const fileUrl = link ? resolveUrl(link.href, pageUrl) : null;
      if (!link || !fileUrl || !link.text) {
        notes.push(`A row without a linked title was left out (${oneLine(inlineText(row[1]))?.slice(0, 120) ?? "empty"}).`);
        continue;
      }
      const time = /<time\b([^>]*)>([\s\S]*?)<\/time\s*>/i.exec(row[1]);
      const fyCell = cell(/fiscal-year|field-fy/);
      rows.push({
        reportNumber,
        title: link.text,
        fileUrl,
        dateTime: time ? attrValue(time[1], "datetime") : null,
        dateText: time ? oneLine(inlineText(time[2])) : null,
        fiscalYear: fyCell ? oneLine(inlineText(fyCell)) : null,
      });
    }
  }

  let agencyFilter: OigListing["agencyFilter"] = null;
  const form = /<form\b([^>]*views-exposed-form[^>]*)>([\s\S]*?)<\/form\s*>/i.exec(html);
  if (form) {
    const action = resolveUrl(attrValue(form[1], "action") ?? "", pageUrl);
    const selects = [...form[2].matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select\s*>/gi)];
    const agency = selects.find((s) => /dhs[-_]agency/i.test(attrValue(s[1], "name") ?? ""));
    if (action && agency) {
      const options: Record<string, string> = {};
      for (const o of agency[2].matchAll(/<option\b([^>]*)>([^<]*)/gi)) {
        const value = attrValue(o[1], "value");
        const label = oneLine(decodeEntities(o[2]));
        if (value && label) options[label] = value;
      }
      const otherFields: Record<string, string> = {};
      for (const s of selects) {
        const name = attrValue(s[1], "name");
        if (!name || s === agency) continue;
        const selected = /<option\b([^>]*\bselected\b[^>]*)>/i.exec(s[2]);
        otherFields[name] = (selected ? attrValue(selected[1], "value") : null) ?? "All";
      }
      agencyFilter = { action, field: attrValue(agency[1], "name")!, options, otherFields };
    }
  }

  // The pager's "next" link; some pages print only numbered links (the second of three pages in
  // a short view has no "next"), so the link to the page after the current one is the fallback.
  const next = /<a\b([^>]*\brel="next"[^>]*)>/i.exec(html);
  let nextHref = next ? attrValue(next[1], "href") : null;
  if (!nextHref) {
    const current = Number(new URL(pageUrl).searchParams.get("page") ?? "0");
    const pager = /<nav\b[^>]*(?:usa-pagination|pager)[^>]*>([\s\S]*?)<\/nav\s*>/i.exec(html)?.[1] ?? "";
    for (const m of pager.matchAll(/<a\b([^>]*)>/gi)) {
      const href = attrValue(m[1], "href");
      const to = href ? /[?&]page=(\d+)/.exec(decodeEntities(href)) : null;
      if (href && to && Number(to[1]) === current + 1) {
        nextHref = decodeEntities(href);
        break;
      }
    }
  }
  return { recognized: Boolean(table) || emptyView, rows, agencyFilter, nextUrl: nextHref ? resolveUrl(nextHref, pageUrl) : null, notes };
}

/** "OIG-24-46-Aug24": the redacted marker is the only difference some files have; the title says it. */
export function isRedactedTitle(title: string): boolean {
  return /\(\s*REDACTED\s*\)/i.test(title);
}

// ---------------------------------------------------------------------------
// UN Treaty Collection (treaties.un.org): a multilateral treaty's status page
// ---------------------------------------------------------------------------

export type UnTreatyStatus = {
  chapter: string | null;
  title: string;
  /** "Geneva, 28 July 1951": the place and date of conclusion. */
  concluded: string | null;
  entryIntoForce: string | null;
  registration: string | null;
  status: string | null;
  /** "United Nations, Treaty Series, vol. 189, p. 137." */
  textCitation: string | null;
  unts: { volume: string; page: string } | null;
  certifiedCopyUrl: string | null;
  note: string | null;
  /** The participants table's column names and the United States' row, as printed. */
  participantColumns: string[];
  unitedStates: string[] | null;
  participantCount: number;
  /** The status block as text, without the "STATUS AS AT" time stamp (which changes on every request). */
  text: string;
};

function untcField(html: string, idPart: string): string | null {
  const m = new RegExp(`id="[^"]*${idPart}[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`, "i").exec(html);
  return m ? oneLine(inlineText(dropFootnoteMarks(m[1]))) : null;
}

/** UNTC's footnote marks (<SUP><A class='noteIndex'>2</A></SUP>, sometimes as a malformed <superscript>2</A></SUP>), replaced by a space. */
function dropFootnoteMarks(html: string): string {
  return html.replace(/<sup(?:erscript)?\b[^>]*>[\s\S]*?<\/sup\s*>/gi, " ");
}

/** A UNTC "status of treaties" page (ViewDetails.aspx); null when it has none of the status block's fields. */
export function parseUnTreatyStatus(html: string, pageUrl: string): UnTreatyStatus | null {
  const title = untcField(html, "rptTreaty_ctl00_tcTreaty");
  if (!title) return null;
  const chapter = untcField(html, "rptHead_ctl00_tcHead");
  const concluded = untcField(html, "rptTreaty_ctl00_tcText");
  const entryIntoForce = untcField(html, "rptEIF_ctl00_tcText");
  const registration = untcField(html, "rptRegistration_ctl00_tcText");
  const status = untcField(html, "rptStatus_ctl00_tcText");
  const textBlock = /id="[^"]*rptText_ctl00_tcText"[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1] ?? "";
  const textCitation = oneLine(inlineText(textBlock));
  const unts = /vol\.\s*([\d,]+)\s*,?\s*p\.\s*(\d+)/i.exec(textCitation ?? "");
  const ctc = /id="[^"]*rptText_ctl00_hypCTC"[^>]*href="([^"]+)"/i.exec(html) ?? /href="([^"]+)"[^>]*id="[^"]*rptText_ctl00_hypCTC"/i.exec(html);
  const note = untcField(html, "rptNotes_ctl00_tcText");

  // The participants table follows the status block: a header row, then one row per State.
  const participantsAt = html.search(/id="participants"/i);
  const participantsTable = participantsAt >= 0 ? /<table\b[^>]*>([\s\S]*?)<\/table\s*>/i.exec(html.slice(participantsAt))?.[1] ?? "" : "";
  const rows = tableRows(participantsTable).map((cells) => cells.map((c) => oneLine(inlineText(dropFootnoteMarks(c))) ?? ""));
  const participantColumns = rows[0] ?? [];
  const body = rows.slice(1).filter((r) => r.some(Boolean));
  const us = body.find((r) => /^United States of America\b/.test(r[0] ?? "")) ?? null;

  const lines = [
    chapter,
    title,
    concluded,
    entryIntoForce ? `Entry into force: ${entryIntoForce}` : null,
    registration ? `Registration: ${registration}` : null,
    status ? `Status: ${status}` : null,
    textCitation ? `Text: ${textCitation}` : null,
    note ? `Note: ${note}` : null,
    us && participantColumns.length ? `United States of America: ${participantColumns.slice(1).map((col, i) => `${col} ${us[i + 1] || "-"}`).join("; ")}` : null,
  ].filter((l): l is string => Boolean(l));

  return {
    chapter,
    title,
    concluded,
    entryIntoForce,
    registration,
    status,
    textCitation,
    unts: unts ? { volume: unts[1].replace(/,/g, ""), page: unts[2] } : null,
    certifiedCopyUrl: ctc ? resolveUrl(decodeEntities(ctc[1]), pageUrl) : null,
    note,
    participantColumns,
    unitedStates: us,
    participantCount: body.length,
    text: lines.join("\n\n"),
  };
}

/** The date in "Geneva, 28 July 1951" or "22 April 1954, in accordance with article 43.": its first "D Month YYYY". */
export function firstDayMonthYear(text: string | null): string | null {
  return /\b\d{1,2}\s+[A-Z][a-z]+\.?\s+\d{4}\b/.exec(text ?? "")?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// UNHCR (www.unhcr.org): the handbooks page and a publication's media page
// ---------------------------------------------------------------------------

/** The link a UNHCR page gives for a publication whose link text matches `pattern`. */
export function findLinkByText(html: string, pageUrl: string, pattern: RegExp): { url: string; text: string } | null {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(html)?.[1] ?? html;
  for (const a of anchors(main)) {
    if (pattern.test(a.text)) {
      const url = resolveUrl(a.href, pageUrl);
      if (url) return { url, text: a.text };
    }
  }
  return null;
}

export type UnhcrMediaPage = {
  title: string;
  symbol: string | null;
  /** The date the page prints under the title (its posting date). */
  pageDateTime: string | null;
  pageDateText: string | null;
  caption: string | null;
  fileUrl: string | null;
};

/** A UNHCR media (publication) page: the PDF title block, its date, caption and file link. */
export function parseUnhcrMediaPage(html: string, pageUrl: string): UnhcrMediaPage | null {
  const h1 = /<h1\b[^>]*class="[^"]*pdf-title[^"]*"[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
  if (!h1) return null;
  const title = inlineText(h1[1]);
  if (!title) return null;
  const after = html.slice((h1.index ?? 0) + h1[0].length);
  const symbol = oneLine(inlineText(/^\s*<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/i.exec(after)?.[1] ?? ""));
  const time = /<div\b[^>]*field--name-created[^>]*>\s*<time\b([^>]*)>([\s\S]*?)<\/time\s*>/i.exec(after);
  const caption = /<div\b[^>]*field--name-field-caption[^>]*>([\s\S]*?)<\/div\s*>/i.exec(after);
  const file = /data-src="([^"]+\.pdf)"/i.exec(after) ?? /<a\b[^>]*href="([^"]+\.pdf)"[^>]*>\s*Click here to download/i.exec(after);
  return {
    title,
    symbol,
    pageDateTime: time ? attrValue(time[1], "datetime") : null,
    pageDateText: time ? oneLine(inlineText(time[2])) : null,
    caption: caption ? oneLine(inlineText(caption[1])) : null,
    fileUrl: file ? resolveUrl(decodeEntities(file[1]), pageUrl) : null,
  };
}
