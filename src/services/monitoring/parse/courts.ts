import type { ListingParse, ParsedItem } from "../types";
import { parseStatedDate } from "./dates";
import { anchors, attrValue, htmlToText, inlineText, resolveUrl, rssField, rssItems, sliceBetween, tableRows } from "./html";

// Parsers for the courts of appeals listings in the per-circuit table of
// skills-content/eoir-weekly-update/references/sources.md section 6. Each
// returns every opinion row it read (CourtListingEntry); courtListing() then
// keeps the published ones that may be immigration cases. Whether one is,
// what it holds and whether it is kept under routing.md is decided later,
// from the opinion's own text.

export type CourtListingEntry = {
  circuit: number;
  docket: string;
  caption: string;
  /** The date exactly as the list shows it. */
  dateText: string;
  pdfUrl: string;
  /** true or false when the list says; null when only the opinion itself says (Tenth Circuit). */
  published: boolean | null;
  /** Origin, district or agency line, when the list gives one. */
  origin?: string;
  /** Case type, when the list gives one. */
  caseType?: string;
  /** The list's own words for the document (Published Opinion, Published Order). */
  designation?: string;
};

/** recognized: false when the list, table or feed the parser expects is not on the page (see ListingParse). */
export type CourtParse = { entries: CourtListingEntry[]; rowsSeen: number; recognized: boolean; indexText: string };

const CIRCUIT_ORDINALS: Record<number, string> = {
  1: "1st",
  2: "2d",
  3: "3d",
  4: "4th",
  5: "5th",
  6: "6th",
  7: "7th",
  8: "8th",
  9: "9th",
  10: "10th",
  11: "11th",
};

// sources.md: "petitions for review name the Attorney General as
// respondent. As of October 2026 captions read Blanche or Todd W. Blanche;
// some circuits write Attorney General United States of America or U.S.
// Attorney General, and older cases may still name Bondi or Garland. Some
// lists show the origin as the Board of Immigration Appeals or Agency."
// Detention and habeas cases name DHS and ICE officials (Noem, Lyons). A
// match only makes a row a candidate: the opinion is read before anything
// about it is recorded.
const CAPTION_CANDIDATE =
  /\bBlanche\b|\bBondi\b|\bGarland\b|\bAttorney General\b|\bAtt'?y\.? Gen\b|\bNoem\b|\bMayorkas\b|\bLyons\b|\bHoman\b|\bImmigration\b|\bHomeland Security\b|\bBoard of Immigration Appeals\b/i;
const CAPTION_ACRONYM_CANDIDATE = /\b(?:ICE|DHS|BIA|USCIS|EOIR|INS)\b/;
const ORIGIN_CANDIDATE = /Board of Immigration Appeals|Immigration|\bBIA\b|\bAgency\b/i;

/**
 * Whether a published listing row may be an immigration case and so is
 * worth reading. The Fifth Circuit binds the Houston Immigration Court on
 * every immigration topic (sources.md), so its habeas captions naming a
 * warden are read too.
 */
export function isImmigrationCandidate(entry: CourtListingEntry): boolean {
  if (entry.published === false) return false;
  if (CAPTION_CANDIDATE.test(entry.caption) || CAPTION_ACRONYM_CANDIDATE.test(entry.caption)) return true;
  if (entry.origin && ORIGIN_CANDIDATE.test(entry.origin)) return true;
  if (entry.caseType && /immigration|agency/i.test(entry.caseType)) return true;
  if (entry.circuit === 5 && /\bWarden\b/i.test(entry.caption)) return true;
  return false;
}

/** A candidate row as an item; the opinion PDF is read before it is summarized. */
export function courtEntryToItem(entry: CourtListingEntry): ParsedItem {
  const url = new URL(entry.pdfUrl);
  // A docket number as the list prints it ("26-10925"); the Fourth
  // Circuit's list gives only the opinion's file name, so no number is
  // written for it.
  const docketNumber = /^\d{2}-\d{1,6}(?:,\s*\d{2}-\d{1,6})*$/.test(entry.docket) ? entry.docket : null;
  return {
    externalId: `${entry.docket} | ${url.pathname}${url.search}`,
    itemType: "Court of appeals published opinion",
    title: entry.caption,
    citation: docketNumber
      ? `No. ${docketNumber} (${CIRCUIT_ORDINALS[entry.circuit]} Cir.)`
      : `${CIRCUIT_ORDINALS[entry.circuit]} Cir.`,
    officialUrl: entry.pdfUrl,
    documentUrl: entry.pdfUrl,
    publishedDateText: entry.dateText,
    publishedOn: parseStatedDate(entry.dateText),
    circuit: String(entry.circuit),
    excerpt: [entry.caption, docketNumber ? `No. ${docketNumber}` : null, entry.dateText, entry.designation, entry.caseType, entry.origin]
      .filter(Boolean)
      .join("\n"),
    listingFacts: {
      ...(entry.origin ? { origin: entry.origin } : {}),
      ...(entry.caseType ? { caseType: entry.caseType } : {}),
      ...(entry.designation ? { designation: entry.designation } : {}),
    },
  };
}

/** The candidates of one list, as items, with how many published rows were passed over. */
export function courtListing(parse: CourtParse): ListingParse {
  const published = parse.entries.filter((e) => e.published !== false);
  const candidates = published.filter(isImmigrationCandidate);
  const seen = new Set<string>();
  const items: ParsedItem[] = [];
  for (const entry of candidates) {
    const item = courtEntryToItem(entry);
    if (seen.has(item.externalId)) continue;
    seen.add(item.externalId);
    items.push(item);
  }
  const passed = published.length - candidates.length;
  return {
    items,
    rowsSeen: parse.rowsSeen,
    recognized: parse.recognized,
    notes: passed > 0 ? [`${passed} listed opinion(s) with no sign of an immigration case in the listing were not read.`] : [],
    indexText: parse.indexText,
  };
}

/** First Circuit (search-week / search-month): issuance date, opinion file ("25-1206P.01A"), docket, short title and district. */
export function parseCa1List(html: string, pageUrl: string): CourtParse {
  const table = sliceBetween(html, '<table class="views-table', ["</table>"]) ?? "";
  const entries: CourtListingEntry[] = [];
  let rowsSeen = 0;
  for (const cells of tableRows(table)) {
    if (cells.length < 4) continue;
    const file = anchors(cells[1])[0];
    const pdfUrl = file ? resolveUrl(file.href, pageUrl) : null;
    if (!file || !pdfUrl) continue;
    rowsSeen++;
    const titleLines = htmlToText(cells[3]).split("\n");
    entries.push({
      circuit: 1,
      docket: inlineText(cells[2]),
      caption: titleLines[0] ?? "",
      origin: titleLines.slice(1).join(" ") || undefined,
      dateText: inlineText(cells[0]),
      pdfUrl,
      // The file name carries the kind: P published, U unpublished, E errata, O order.
      published: /^\d{2}-\d{4}P\d*\./i.test(file.text),
      designation: file.text,
    });
  }
  return { entries, rowsSeen, recognized: table !== "", indexText: htmlToText(table) };
}

/** Third Circuit precedential list: "Filed MM/DD/YYYY, No. X", the linked caption, then the origin. */
export function parseCa3List(html: string, pageUrl: string): CourtParse {
  const entries: CourtListingEntry[] = [];
  const re = /Filed\s+(\d{1,2}\/\d{1,2}\/\d{4}),\s*No\.\s*([\w-]+)\s*<br\s*\/?>\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*<br\s*\/?>\s*([^<]*)/gi;
  for (const m of html.matchAll(re)) {
    const pdfUrl = resolveUrl(attrValue(m[3], "href") ?? "", pageUrl);
    if (!pdfUrl) continue;
    entries.push({
      circuit: 3,
      docket: m[2],
      caption: inlineText(m[4]),
      origin: inlineText(m[5]) || undefined,
      dateText: m[1],
      pdfUrl,
      published: true,
      designation: "Precedential",
    });
  }
  return { entries, rowsSeen: entries.length, recognized: /Recent Precedential Opinions/i.test(html), indexText: htmlToText(html) };
}

/** Fourth Circuit published-only list: "237201.P Caption" headings with Case Type and Link lines, dated below. */
export function parseCa4List(html: string, pageUrl: string): CourtParse {
  const entries: CourtListingEntry[] = [];
  let rowsSeen = 0;
  for (const li of html.matchAll(/<li class="sfnewsListItem[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
    rowsSeen++;
    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(li[1]);
    const headingText = heading ? inlineText(heading[1]) : "";
    // The heading starts with the opinion's file name ("237201.P"); the
    // docket number is printed in the opinion, not the list.
    const m = /^(\d{5,7})\.([A-Z]+)\s+(.+)$/.exec(headingText);
    if (!m) continue; // "No Published Opinions of the Court released on ..."
    const link = anchors(li[1]).find((a) => /\.pdf$/i.test(a.href));
    const pdfUrl = link ? resolveUrl(link.href, pageUrl) : null;
    if (!pdfUrl) continue;
    const content = htmlToText(li[1]);
    const caseType = /Case Type:\s*([^\n]+)/.exec(content)?.[1].trim();
    const dateBlock = /<div class="sfnewsMetaInfo[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(li[1]);
    entries.push({
      circuit: 4,
      docket: `${m[1]}.${m[2]}`,
      caption: m[3],
      caseType,
      dateText: dateBlock ? inlineText(dateBlock[1]) : "",
      pdfUrl,
      published: m[2].startsWith("P"),
      designation: /Published opinion[^\n]*/i.exec(content)?.[0],
    });
  }
  return { entries, rowsSeen, recognized: rowsSeen > 0, indexText: htmlToText(html) };
}

/** Fifth Circuit opinions search (published opinions and orders): one "oprow" link per document. */
export function parseCa5List(html: string, pageUrl: string): CourtParse {
  const entries: CourtListingEntry[] = [];
  let rowsSeen = 0;
  for (const row of html.matchAll(/<a\b([^>]*class="oprow"[^>]*)>([\s\S]*?)<\/a>/gi)) {
    rowsSeen++;
    const span = (cls: string) => {
      const m = new RegExp(`<span class="${cls}"[^>]*>([\\s\\S]*?)<\\/span>`, "i").exec(row[2]);
      return m ? inlineText(m[1]) : "";
    };
    const pdfUrl = resolveUrl(attrValue(row[1], "href") ?? "", pageUrl);
    const designation = /<span class="tag[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(row[2]);
    const designationText = designation ? inlineText(designation[1]) : "";
    if (!pdfUrl) continue;
    entries.push({
      circuit: 5,
      docket: span("oprow__docket"),
      caption: span("oprow__caption"),
      dateText: span("oprow__date"),
      pdfUrl,
      published: /\bPublished\b/i.test(designationText) && !/\bUnpublished\b/i.test(designationText),
      designation: designationText || undefined,
    });
  }
  return {
    entries,
    rowsSeen,
    recognized: html.includes("data-op-results"),
    indexText: entries.map((e) => `${e.docket} ${e.caption} ${e.dateText}`).join("\n"),
  };
}

/** Sixth Circuit opinions page: the Published Opinions table only. */
export function parseCa6List(html: string, pageUrl: string): CourtParse {
  const section = sliceBetween(html, /<h2>\s*<span[^>]*>\s*Published Opinions/i, [/<h2>/i]) ?? "";
  const entries: CourtListingEntry[] = [];
  let rowsSeen = 0;
  for (const cells of tableRows(section.replace(/<!--[\s\S]*?-->/g, ""))) {
    if (cells.length < 4) continue;
    const file = anchors(cells[0])[0];
    const pdfUrl = file ? resolveUrl(file.href, pageUrl) : null;
    if (!file || !pdfUrl) continue;
    rowsSeen++;
    const font = /<font\b[^>]*>([\s\S]*?)<\/font>/i.exec(cells[3]);
    const caption = inlineText(cells[3].replace(/<font\b[\s\S]*?<\/font>/i, "")).replace(/\s*-\s*$/, "");
    entries.push({
      circuit: 6,
      docket: inlineText(cells[1]),
      caption,
      origin: font ? inlineText(font[1]) : undefined,
      dateText: inlineText(cells[2]),
      pdfUrl,
      // "26a0277p.06": p is published (n would be not recommended for publication).
      published: /\d+a\d+p\./i.test(file.text),
      designation: file.text,
    });
  }
  return { entries, rowsSeen, recognized: section !== "", indexText: htmlToText(section) };
}

/**
 * Seventh Circuit precedential opinions (OpsOnly=yes): Case #, Caption, Case
 * Type, Filed, Document link, Author. A separate opinion of the same case
 * (a dissent) is listed on its own row; the court's opinion (":aut:") is kept.
 */
export function parseCa7List(html: string, pageUrl: string): CourtParse {
  const tbody = sliceBetween(html, /<TBODY\b/i, [/<\/TBODY>/i]) ?? "";
  const byCase = new Map<string, CourtListingEntry>();
  let rowsSeen = 0;
  for (const cells of tableRows(tbody)) {
    if (cells.length < 5) continue;
    const doc = anchors(cells[4])[0];
    const pdfUrl = doc ? resolveUrl(doc.href, pageUrl) : null;
    if (!doc || !pdfUrl) continue;
    rowsSeen++;
    const entry: CourtListingEntry = {
      circuit: 7,
      docket: inlineText(cells[0]),
      caption: inlineText(cells[1]),
      caseType: inlineText(cells[2]) || undefined,
      dateText: inlineText(cells[3]),
      pdfUrl,
      published: true,
      designation: doc.text,
    };
    const key = `${entry.docket}|${entry.dateText}`;
    const existing = byCase.get(key);
    if (!existing || (!existing.pdfUrl.includes(":aut:") && pdfUrl.includes(":aut:"))) byCase.set(key, entry);
  }
  return { entries: [...byCase.values()], rowsSeen, recognized: tbody !== "", indexText: htmlToText(tbody) };
}

/**
 * Eighth Circuit opinions by date: file name ("252780P.pdf", P published, U
 * unpublished), date and caption, case number, origin. The list links the
 * PDFs on media.ca8.uscourts.gov over plain http, whose https certificate
 * does not match its name; the same files are served over https from
 * ecf.ca8.uscourts.gov/opndir/, which is the link kept.
 */
export function parseCa8List(html: string): CourtParse {
  const pre = sliceBetween(html, /<pre>/i, [/<\/pre>/i]) ?? "";
  const entries: CourtListingEntry[] = [];
  const re =
    /<a\s+href="([^"]+)">([^<]+)<\/a>\s*<b>\s*(\d{2}\/\d{2}\/\d{4})\s+([\s\S]*?)<\/b>\s*(?:<\/font>)?\s*U\.S\. Court of Appeals Case No:\s*([\w-]+)\s*([^<]*)/gi;
  for (const m of pre.matchAll(re)) {
    const path = /\/opndir\/(\d{2}\/\d{2}\/[\w.]+\.pdf)$/i.exec(m[1]);
    if (!path) continue;
    entries.push({
      circuit: 8,
      docket: m[5],
      caption: inlineText(m[4]),
      origin: inlineText(m[6]) || undefined,
      dateText: m[3],
      pdfUrl: `https://ecf.ca8.uscourts.gov/opndir/${path[1]}`,
      published: /P\.pdf$/i.test(m[2]),
      designation: m[2].trim(),
    });
  }
  // A day with no opinions prints "No Opinion Found For MM/DD/YYYY" instead of the listing block.
  return {
    entries,
    rowsSeen: entries.length,
    recognized: pre !== "" || /No Opinion Found For \d{2}\/\d{2}\/\d{4}/i.test(html),
    indexText: htmlToText(pre),
  };
}

/** Ninth Circuit published opinions feed: caption, PDF link, MM/DD/YYYY date. */
export function parseCa9Feed(xml: string, pageUrl: string): CourtParse {
  const entries: CourtListingEntry[] = [];
  const items = rssItems(xml);
  for (const item of items) {
    const link = rssField(item, "link");
    const pdfUrl = link ? resolveUrl(link, pageUrl) : null;
    const caption = rssField(item, "title");
    if (!pdfUrl || !caption) continue;
    const docket = /\/([\w-]+)\.pdf$/i.exec(new URL(pdfUrl).pathname)?.[1] ?? "";
    entries.push({
      circuit: 9,
      docket,
      caption,
      dateText: rssField(item, "pubDate") ?? "",
      pdfUrl,
      published: true,
    });
  }
  return {
    entries,
    rowsSeen: items.length,
    recognized: /<rss\b|<channel\b/i.test(xml),
    indexText: entries.map((e) => `${e.docket} ${e.caption} ${e.dateText}`).join("\n"),
  };
}

/** Tenth Circuit opinion search results: Case #, Case Title, Filed On, Origin, PDF. Published or not is printed in the opinion. */
export function parseCa10List(html: string, pageUrl: string): CourtParse {
  const table = sliceBetween(html, '<table class="views-table', ["</table>"]) ?? "";
  const entries: CourtListingEntry[] = [];
  let rowsSeen = 0;
  for (const cells of tableRows(table)) {
    if (cells.length < 5) continue;
    const pdf = anchors(cells[4])[0];
    const pdfUrl = pdf ? resolveUrl(pdf.href, pageUrl) : null;
    if (!pdfUrl) continue;
    rowsSeen++;
    entries.push({
      circuit: 10,
      docket: inlineText(cells[0]),
      caption: inlineText(cells[1]),
      dateText: inlineText(cells[2]),
      origin: inlineText(cells[3]) || undefined,
      pdfUrl,
      published: null,
    });
  }
  // A week with nothing filed shows no results table.
  return {
    entries,
    rowsSeen,
    recognized: table !== "" || /views-empty|No results|no opinions/i.test(html),
    indexText: htmlToText(table),
  };
}

/** True when a Tenth Circuit results page lists nothing filed on or after `sinceIso`, so later pages need not be read. */
export function ca10PagePassedDate(parse: CourtParse, sinceIso: string): boolean {
  if (parse.entries.length === 0) return true;
  return parse.entries.every((e) => {
    const iso = parseStatedDate(e.dateText);
    return iso !== null && iso < sinceIso;
  });
}

/** Eleventh Circuit published opinions feed: caption, PDF link, "Issued Date ... Case#: ..." description. */
export function parseCa11Feed(xml: string, pageUrl: string): CourtParse {
  const entries: CourtListingEntry[] = [];
  const items = rssItems(xml);
  for (const item of items) {
    const link = rssField(item, "link");
    const pdfUrl = link ? resolveUrl(link, pageUrl) : null;
    const caption = rssField(item, "title");
    if (!pdfUrl || !caption) continue;
    const description = htmlToText(rssField(item, "description") ?? "");
    entries.push({
      circuit: 11,
      docket: /Case#:\s*([^\n]+)/.exec(description)?.[1].trim() ?? "",
      caption,
      dateText: /Issued Date:\s*([^\n]+)/.exec(description)?.[1].trim() ?? rssField(item, "pubDate") ?? "",
      pdfUrl,
      published: true,
      designation: /Type:\s*([^\n]+)/.exec(description)?.[1].trim(),
    });
  }
  return {
    entries,
    rowsSeen: items.length,
    recognized: /<rss\b|<channel\b/i.test(xml),
    indexText: entries.map((e) => `${e.docket} ${e.caption} ${e.dateText}`).join("\n"),
  };
}
