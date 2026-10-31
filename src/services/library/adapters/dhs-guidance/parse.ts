import { anchors, attrValue, htmlToDocumentText, inlineText, pageTitle, resolveUrl, tableRows } from "../../extract/html";
import { repairMojibake } from "../../text";

// Parsers for the DHS components' guidance pages: ICE (detention standards,
// the FOIA Library's policy categories, SEVP), CBP (policies, procedures and
// directives), dhs.gov (publications library collections and publication
// pages, the Management Directives index), uscis.gov (the Electronic
// Reading Room, the Policy Manual's index and Part pages that carry the
// remaining Adjudicator's Field Manual chapters) and the Drupal "book"
// manuals USCIS and E-Verify publish with a printable export (the Handbook
// for Employers M-274, the E-Verify User Manual M-775). Pure, so they can
// be checked against saved pages; every link is taken from the page and
// resolved against the page's own URL.

// ---------------------------------------------------------------------------
// Shared helpers

/** The text between the first match of `start` and the first of `ends` after it; null when `start` is absent. */
export function sliceFrom(html: string, start: RegExp | string, ends: (RegExp | string)[]): string | null {
  const i = typeof start === "string" ? html.indexOf(start) : html.search(start);
  if (i < 0) return null;
  const rest = html.slice(i);
  let end = rest.length;
  for (const marker of ends) {
    const j = typeof marker === "string" ? rest.indexOf(marker, 1) : rest.slice(1).search(marker) + 1;
    if (j > 0 && j < end) end = j;
  }
  return rest.slice(0, end);
}

/** The page's <main> element, or null. */
export function mainElement(html: string): string | null {
  return /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(html)?.[1] ?? null;
}

/** One-line visible text with double-encoding repaired. */
export function lineText(fragment: string): string {
  return repairMojibake(inlineText(fragment)).replace(/\s+/g, " ").trim();
}

/**
 * The ICE, CBP and DHS sites link some files by http:// or by the bare
 * domain; both answer with a permanent redirect to the https://www. address
 * of the same path. The scheme is moved to https (the only scheme the
 * library fetches); the host stays as the page wrote it and the fetch
 * follows the site's own redirect.
 */
export function httpsUrl(url: string | null, hosts: readonly string[]): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!hosts.includes(u.hostname.toLowerCase())) return null;
    if (u.protocol === "http:") u.protocol = "https:";
    if (u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** Whether the URL's path names a PDF file. */
export function isPdfUrl(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Whether the URL's path names a file (a document extension) rather than a page. */
export function isFileUrl(url: string): boolean {
  try {
    return /\.[a-z0-9]{2,5}$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Removes the "(PDF | 318 KB)", "(PDF, 163.58 KB)" and similar file notes from a label. */
export function stripFileNote(label: string): string {
  return label
    .replace(/\(\s*(?:PDF|DOCX?|XLSX?|PPTX?|ZIP|TXT)\s*[|,]?\s*(?:[\d.,]+\s*[KMG]?B)?\s*\)/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s:|,(-]+$/, "")
    .trim();
}

/** Whether the page has a "Next page" pager link (USWDS and Drupal mini pagers). */
export function hasNextPage(html: string): boolean {
  return /aria-label="Next page"|rel="next"|title="Go to next page"|pager__item--next[^"]*"[^>]*>\s*<a\b/i.test(html);
}

/** The highest zero-based page number the page's pager links ("?page=53"); null when it links none. */
export function highestPagerPage(html: string): number | null {
  let max: number | null = null;
  for (const m of html.matchAll(/href="[^"]*[?&](?:amp;)?page=(\d+)[^"]*"/gi)) max = Math.max(max ?? 0, Number(m[1]));
  return max;
}

// ---------------------------------------------------------------------------
// ICE detention standards: https://www.ice.gov/detain/detention-management

export type StandardsLink = { label: string; url: string; kind: "page" | "file" };

/** The links in the "Detention Standards" list of the Detention Management page, in page order. */
export function parseStandardsIndex(html: string, pageUrl: string, hosts: readonly string[]): StandardsLink[] | null {
  const section = sliceFrom(html, /<h2[^>]*>\s*Detention Standards\s*<\/h2>/i, [/<h2\b/i]);
  if (!section) return null;
  const list = /<ul\b[^>]*>([\s\S]*?)<\/ul\s*>/i.exec(section)?.[1];
  if (!list) return null;
  const out: StandardsLink[] = [];
  for (const a of anchors(list)) {
    const url = httpsUrl(resolveUrl(a.href, pageUrl), hosts);
    if (!url || !a.text) continue;
    out.push({ label: lineText(a.inner), url, kind: isFileUrl(url) ? "file" : "page" });
  }
  return out;
}

export type StandardsEntry = {
  /** The standard's number as the page prints it ("4.3", "1.0", "17"); null for an unnumbered entry (a model policy, an overview). */
  number: string | null;
  /** The entry's label without its number and file note ("Medical Care"). */
  title: string;
  /** The label as the page prints it, file note removed ("4.3 Medical Care"). */
  label: string;
  /** The part heading the entry is listed under ("Part 4 - Care"). */
  part: string | null;
  pdfUrl: string;
  /** "View the complete ..." link: the whole set in one file. */
  complete: boolean;
};

export type StandardsPage = {
  /** The page's <title> without " | ICE" and the "Archived: " prefix. */
  title: string | null;
  archived: boolean;
  /** ICE's archive banner, as printed. */
  archiveNote: string | null;
  updated: string | null;
  entries: StandardsEntry[];
};

/**
 * One detention standards page (2026 and 2025 NDS, NDIDS, PBNDS 2011, NDS
 * 2019, FRS 2020, the archived PBNDS 2008): the "View the complete ..." PDF
 * and, where the page lists them, each standard's own PDF. The PBNDS 2008
 * page lists a DOC and a PDF per standard; the PDF is taken.
 */
export function parseStandardsPage(html: string, pageUrl: string, hosts: readonly string[]): StandardsPage {
  const rawTitle = pageTitle(html);
  const archived = /^Archived:/i.test(rawTitle ?? "") || /<[^>]+class="[^"]*\bice_archive\b/i.test(html);
  const title = rawTitle ? lineText(rawTitle).replace(/\s*\|\s*ICE\s*$/i, "").replace(/^Archived:\s*/i, "").trim() || null : null;
  const main = mainElement(html) ?? html;
  const body = main.split(/Local Footer Navigation/i)[0];
  const archiveNote = archived ? (/(In an effort to keep ICE\.gov current[^<]*)/i.exec(body)?.[1]?.trim() ?? null) : null;
  const updated = /Updated:\s*<time\b[^>]*>([^<]+)<\/time>/i.exec(html)?.[1]?.trim() ?? null;

  // Part headings (h2, or accordion titles in h3) with their positions, so each entry knows its part.
  const headings: { index: number; text: string }[] = [];
  for (const m of body.matchAll(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]\s*>/gi)) {
    const text = lineText(m[1]);
    if (text) headings.push({ index: m.index ?? 0, text });
  }

  const entries: StandardsEntry[] = [];
  const seen = new Set<string>();
  for (const a of anchors(body)) {
    const url = httpsUrl(resolveUrl(a.href, pageUrl), hosts);
    if (!url || !isPdfUrl(url) || seen.has(url)) continue;
    const anchorText = lineText(a.inner);
    const complete = /^View the complete\b/i.test(anchorText);
    let label: string;
    if (complete) {
      label = anchorText.replace(/^View the complete\s+/i, "").trim();
    } else {
      // The entry's label is the text before the link in its list item or paragraph:
      // "4.3 Medical Care (" before "PDF | 797 KB)", or "25 Terminal Illness, ... (DOC | 114 KB) (" on the PBNDS 2008 page.
      const before = body.slice(0, a.index);
      const blockStart = Math.max(before.lastIndexOf("<li"), before.lastIndexOf("<p"));
      if (blockStart < 0) continue;
      label = stripFileNote(lineText(body.slice(blockStart, a.index)));
      if (!label) continue;
    }
    seen.add(url);
    const numbered = complete ? null : /^(\d{1,2}(?:\.\d{1,2})?)\.?\s+(.+)$/.exec(label);
    const part = headings.filter((h) => h.index < a.index).pop()?.text ?? null;
    entries.push({
      number: numbered ? numbered[1] : null,
      title: numbered ? numbered[2].trim() : label,
      label,
      part: complete ? null : part,
      pdfUrl: url,
      complete,
    });
  }
  return { title, archived, archiveNote, updated, entries };
}

// ---------------------------------------------------------------------------
// ICE FOIA Library: https://www.ice.gov/foia/library

/** The Category select's options: label to id. */
export function parseFoiaCategories(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const select = /<select\b[^>]*name="field_foia_category_target_id"[^>]*>([\s\S]*?)<\/select\s*>/i.exec(html)?.[1];
  if (!select) return out;
  for (const m of select.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option\s*>/gi)) {
    const value = attrValue(m[1], "value");
    const label = lineText(m[2]);
    if (value && /^\d+$/.test(value) && label) out.set(label, value);
  }
  return out;
}

export type FoiaItem = {
  url: string;
  /** The link text as listed ("ICE Directive 11003.7: Notification, ..."). */
  title: string;
  /** What follows the link in the heading, separated by " | " (the category, sometimes "Rescinded August 2017"). */
  trailing: string[];
  description: string | null;
  /** When the item was added to the library (the listing's datetime). */
  postedDateTime: string | null;
};

export type FoiaListing = { recognized: boolean; items: FoiaItem[]; offHost: string[]; hasNext: boolean };

/** One page of the FOIA Library's results. */
export function parseFoiaListing(html: string, pageUrl: string, hosts: readonly string[]): FoiaListing {
  const recognized = /<ul\b[^>]*class="[^"]*usa-collection\b/i.test(html) || /view-empty|No results found|no records/i.test(html);
  const items: FoiaItem[] = [];
  const offHost: string[] = [];
  for (const m of html.matchAll(/<li\b[^>]*class="[^"]*usa-collection__item[^"]*"[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
    const li = m[1];
    const heading = /<h4\b[^>]*>([\s\S]*?)<\/h4\s*>/i.exec(li)?.[1];
    if (!heading) continue;
    const link = anchors(heading)[0];
    if (!link) continue;
    const resolved = resolveUrl(link.href, pageUrl);
    const url = httpsUrl(resolved, hosts);
    if (!url) {
      if (resolved) offHost.push(resolved);
      continue;
    }
    const afterLink = heading.slice(heading.search(/<\/a\s*>/i) + 4);
    const trailing = lineText(afterLink)
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    const descriptionHtml = /usa-collection__description[^>]*>([\s\S]*?)(?:<\/span>|<\/div>\s*<\/span>|$)/i.exec(li)?.[1] ?? "";
    const description = lineText(descriptionHtml) || null;
    items.push({
      url,
      title: lineText(link.inner),
      trailing,
      description,
      postedDateTime: attrValue(/<time\b([^>]*)>/i.exec(li)?.[1] ?? "", "datetime"),
    });
  }
  return { recognized, items, offHost, hasNext: hasNextPage(html) };
}

/** A date at the end of an ICE listing title: "- Jul. 22, 2026" or "(Nov. 29, 2006)". */
export function trailingTitleDate(title: string): string | null {
  const m =
    /[-–—]\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},\s+\d{4})\s*$/i.exec(title) ??
    /\(((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},\s+\d{4})\)\s*$/i.exec(title);
  return m ? m[1] : null;
}

/** "ICE Directive 11003.7", "Policy Number 11014", "ERO Directive 24003", "HSI Directive 24-02" at the start of a title, as written. */
export function directiveDesignation(title: string): string | null {
  const m = /^((?:ICE|ERO|HSI|ICE\/ERO)?\s*(?:Directive|Policy(?:\s+Number)?|Policy\s+No\.)\s+[\d][\d.-]*\d)/i.exec(title.trim());
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

// ---------------------------------------------------------------------------
// SEVP: https://www.ice.gov/sevis/schools and https://www.ice.gov/sevis/whats-new

/** The content of the accordion section whose title link has this id (up to the next accordion title). */
export function accordionSection(html: string, id: string): string | null {
  const start = html.search(new RegExp(`<a\\b[^>]*\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "i"));
  if (start < 0) return null;
  const rest = html.slice(start);
  const next = rest.slice(10).search(/<h3\b[^>]*class="[^"]*accordion-title/i);
  return next >= 0 ? rest.slice(0, next + 10) : rest;
}

export type SevpGuidanceItem = {
  kind: "policy_guidance" | "stem_list" | "covid_archived";
  url: string;
  title: string;
  description: string | null;
};

export type SevpSchoolsPage = { items: SevpGuidanceItem[]; covidNote: string | null; policyGuidanceUpdated: string | null; problems: string[] };

/**
 * The SEVP schools page: the Policy Guidance table (title, description,
 * "Read the policy guidance" link), the DHS STEM Designated Degree Program
 * lists (current and archived) and the COVID-19 archived guidance list.
 */
export function parseSevpSchoolsPage(html: string, pageUrl: string, hosts: readonly string[]): SevpSchoolsPage {
  const problems: string[] = [];
  const items: SevpGuidanceItem[] = [];
  const seen = new Set<string>();
  const push = (item: SevpGuidanceItem) => {
    if (seen.has(item.url)) return;
    seen.add(item.url);
    items.push(item);
  };

  const policy = accordionSection(html, "policy-guidance");
  let policyGuidanceUpdated: string | null = null;
  if (!policy) problems.push("no Policy Guidance section");
  else {
    policyGuidanceUpdated = /Last updated\s+([\d/]+)/i.exec(policy)?.[1] ?? null;
    const table = /<table\b[\s\S]*?<\/table\s*>/i.exec(policy)?.[0];
    if (!table) problems.push("no table in the Policy Guidance section");
    for (const cells of table ? tableRows(table) : []) {
      if (cells.length < 2) continue;
      const link = anchors(cells[1]).find((a) => /^Read the policy guidance/i.test(a.text));
      if (!link) continue;
      const url = httpsUrl(resolveUrl(link.href, pageUrl), hosts);
      if (!url) continue;
      const title = lineText(cells[0]);
      const description = lineText(cells[1].replace(/<a\b[^>]*>\s*Read the policy guidance[\s\S]*?<\/a\s*>/i, " ")) || null;
      if (title) push({ kind: "policy_guidance", url, title, description });
    }
  }

  const stem = accordionSection(html, "dhs-stem-designated-degree-program-list-and-cip-code-nomination-process");
  if (!stem) problems.push("no DHS STEM Designated Degree Program List section");
  for (const a of stem ? anchors(stem) : []) {
    const url = httpsUrl(resolveUrl(a.href, pageUrl), hosts);
    if (url && isPdfUrl(url) && /STEM list/i.test(a.text)) push({ kind: "stem_list", url, title: lineText(a.inner), description: null });
  }

  const covid = accordionSection(html, "nonimmigrant-students-and-sevp-certified-schools-covid-19-archived-guidance");
  let covidNote: string | null = null;
  if (!covid) problems.push("no COVID-19 Archived Guidance section");
  else {
    covidNote = /(The Student and Exchange Visitor Program \(SEVP\) ended its COVID-19 guidance[^<]*)/i.exec(covid)?.[1]?.trim() ?? null;
    const list = /<ul\b[^>]*>([\s\S]*?)<\/ul\s*>/i.exec(covid)?.[1] ?? "";
    for (const a of anchors(list)) {
      const url = httpsUrl(resolveUrl(a.href, pageUrl), hosts);
      if (url && isPdfUrl(url)) {
        const after = list.slice(a.index).replace(/^<a\b[\s\S]*?<\/a\s*>/i, "");
        const dated = /^\s*\(([^)]+)\)/.exec(lineText(after.split(/<\/li\s*>/i)[0]))?.[1] ?? null;
        push({ kind: "covid_archived", url, title: lineText(a.inner), description: dated ? `(${dated})` : null });
      }
    }
  }
  return { items, covidNote, policyGuidanceUpdated, problems };
}

export type BroadcastMessage = {
  url: string;
  title: string;
  /** The month heading it is listed under, as printed with its year ("October 2026"). */
  listedMonth: string | null;
  year: number | null;
  /** The page marks it "(Rescinded)" or strikes it through. */
  rescinded: boolean;
};

/** The Broadcast Messages section of SEVP's What's New page, newest first as listed. */
export function parseSevpBroadcasts(html: string, pageUrl: string, hosts: readonly string[]): { recognized: boolean; messages: BroadcastMessage[] } {
  const section = sliceFrom(html, /<h2>\s*Broadcast Messages\s*<\/h2>/i, [/<h2>\s*Resources\s*<\/h2>/i, /Local Footer Navigation/i]);
  if (!section) return { recognized: false, messages: [] };
  const messages: BroadcastMessage[] = [];
  const seen = new Set<string>();
  let year: number | null = null;
  let month: string | null = null;
  // Walk headings and list items in document order.
  for (const m of section.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>|<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
    if (m[1] !== undefined) {
      const text = lineText(m[1]);
      const monthYear = /^([A-Z][a-z]+)\s+(\d{4})$/.exec(text);
      const yearOnly = /^(\d{4})$/.exec(text);
      const monthOnly = /^(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(\d{4}))?$/i.exec(text);
      if (monthYear) {
        year = Number(monthYear[2]);
        month = monthYear[1];
      } else if (yearOnly) {
        year = Number(yearOnly[1]);
        month = null;
      } else if (monthOnly) {
        month = monthOnly[1];
        if (monthOnly[2]) year = Number(monthOnly[2]);
      }
      continue;
    }
    const li = m[2] ?? "";
    const a = anchors(li).find((x) => /\.pdf(?:$|[?#])/i.test(x.href));
    if (!a) continue;
    const url = httpsUrl(resolveUrl(a.href, pageUrl), hosts);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    messages.push({
      url,
      title: lineText(a.inner),
      listedMonth: month && year ? `${month} ${year}` : year ? String(year) : null,
      year,
      rescinded: /\(Rescinded\)/i.test(lineText(li)) || /line-through/i.test(a.inner),
    });
  }
  return { recognized: true, messages };
}

/** "Date: Oct. 8, 2026" and "Number: 2610-02" at the top of a broadcast message. */
export function broadcastHeader(text: string): { dateText: string | null; number: string | null } {
  const head = text.slice(0, 1500);
  return {
    dateText: /\bDate:\s*([A-Z][a-z]{2,8}\.?\s+\d{1,2},\s+\d{4})/.exec(head)?.[1] ?? null,
    number: /\bNumber:\s*([\dA-Za-z][\w-]*)/.exec(head)?.[1] ?? null,
  };
}

// ---------------------------------------------------------------------------
// CBP: https://www.cbp.gov/newsroom/accountability-and-transparency/policies-procedures-and-directives

export type CbpFile = { url: string; label: string };

export type CbpEntry = {
  /** The entry's own page ("/document/directives/..."). */
  pageUrl: string;
  title: string;
  abstract: string | null;
  files: CbpFile[];
  postDate: string | null;
  postDateTime: string | null;
  lastModified: string | null;
  lastModifiedDateTime: string | null;
};

export type CbpListing = { recognized: boolean; entries: CbpEntry[]; totalStated: number | null; lastPage: number | null };

/** One page of the Policies, Procedures and Directives table; an entry with several files is listed once per file and is merged here. */
export function parseCbpListing(html: string, pageUrl: string, hosts: readonly string[]): CbpListing {
  const table = /<table\b[^>]*class="[^"]*views-table[^"]*"[\s\S]*?<\/table\s*>/i.exec(html)?.[0];
  const totalStated = Number(/([\d,]+)\s+entries found/i.exec(html)?.[1]?.replace(/,/g, "")) || null;
  if (!table) return { recognized: /entries found|No results|no entries/i.test(html) && !/<tbody/i.test(html), entries: [], totalStated, lastPage: highestPagerPage(html) };
  const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody\s*>/i.exec(table)?.[1] ?? "";
  const byPage = new Map<string, CbpEntry>();
  for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const cells = [...row[1].matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi)].map((c) => c[2]);
    if (cells.length < 4) continue;
    const link = anchors(cells[0])[0];
    const entryUrl = link ? httpsUrl(resolveUrl(link.href, pageUrl), hosts) : null;
    if (!link || !entryUrl) continue;
    const files: CbpFile[] = [];
    for (const a of anchors(cells[2])) {
      const url = httpsUrl(resolveUrl(a.href, pageUrl), hosts);
      // An entry whose file was withdrawn keeps its label with an empty link (it resolves to the listing itself).
      if (url && isFileUrl(url)) files.push({ url, label: stripFileNote(lineText(a.inner)) });
    }
    const timeOf = (cell: string | undefined) => {
      const t = /<time\b([^>]*)>([^<]*)<\/time>/i.exec(cell ?? "");
      return { text: t ? t[2].trim() || null : null, datetime: t ? attrValue(t[1], "datetime") : null };
    };
    const posted = timeOf(cells[3]);
    const modified = timeOf(cells[4]);
    const existing = byPage.get(entryUrl);
    if (existing) {
      for (const f of files) if (!existing.files.some((x) => x.url === f.url)) existing.files.push(f);
      continue;
    }
    byPage.set(entryUrl, {
      pageUrl: entryUrl,
      title: lineText(link.inner),
      abstract: lineText(cells[1]) || null,
      files,
      postDate: posted.text,
      postDateTime: posted.datetime,
      lastModified: modified.text,
      lastModifiedDateTime: modified.datetime,
    });
  }
  return { recognized: true, entries: [...byPage.values()], totalStated, lastPage: highestPagerPage(html) };
}

/** A CBP document page: its body text (the abstract and publication number) when it publishes no file. */
export function parseCbpDocumentPage(html: string): { title: string | null; bodyHtml: string | null; publicationNumber: string | null } {
  const main = mainElement(html) ?? html;
  const title = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(main)?.[1];
  const body = /<div\b[^>]*class="[^"]*field--name-body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<div\b[^>]*class="[^"]*field--name-field)/i.exec(main)?.[1] ?? null;
  return {
    title: title ? lineText(title) : null,
    bodyHtml: body,
    publicationNumber: /Publication No\.\s*([\w-]+)/i.exec(lineText(main))?.[1] ?? null,
  };
}

/** "CBP Directive No. 51713-007C", "CBP Directive 2130-021" at the start of (or inside) a title, as written. */
export function cbpDirectiveDesignation(title: string): string | null {
  const m = /(CBP\s+(?:Directive|Dir\.)\s*(?:No\.?:?\s*)?\d[\dA-Z]*-[\dA-Z-]*[\dA-Z])/i.exec(title);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

// ---------------------------------------------------------------------------
// dhs.gov publications library

export type DhsListingItem = { url: string; title: string; dateText: string | null; datetime: string | null; description: string | null };

/** One page of a dhs.gov publications library collection or topic: its /publication/ links in order. */
export function parseDhsCollection(html: string, pageUrl: string, hosts: readonly string[]): { recognized: boolean; items: DhsListingItem[]; hasNext: boolean } {
  const items: DhsListingItem[] = [];
  const recognized = /<ul\b[^>]*class="[^"]*usa-collection\b/i.test(html) || /view-empty|No results found/i.test(html);
  for (const m of html.matchAll(/<li\b[^>]*class="[^"]*usa-collection__item[^"]*"[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
    const li = m[1];
    const heading = /<h3\b[^>]*class="[^"]*usa-collection__heading[^"]*"[^>]*>([\s\S]*?)<\/h3\s*>/i.exec(li)?.[1];
    const link = heading ? anchors(heading)[0] : undefined;
    const url = link ? httpsUrl(resolveUrl(link.href, pageUrl), hosts) : null;
    if (!link || !url) continue;
    const monthDay = /usa-collection__calendar-date-month[^>]*>([^<]*)</i.exec(li)?.[1]?.trim();
    const year = /usa-collection__calendar-date-day[^>]*>([^<]*)</i.exec(li)?.[1]?.trim();
    const datetime = attrValue(/<time\b([^>]*)>/i.exec(li)?.[1] ?? "", "datetime");
    const bodyHtml = li.slice(li.search(/<\/h3\s*>/i) + 5);
    items.push({
      url,
      title: lineText(link.inner),
      dateText: monthDay && year ? `${monthDay} ${year}` : null,
      datetime: datetime || null,
      description: lineText(bodyHtml.replace(/<\/?div\b[^>]*>/gi, " ")) || null,
    });
  }
  return { recognized, items, hasNext: hasNextPage(html) };
}

export type DhsAttachment = { url: string; label: string; ext: string | null; size: string | null; dateText: string | null };

export type DhsPublication = {
  title: string | null;
  bodyHtml: string | null;
  attachments: DhsAttachment[];
  lastUpdated: string | null;
  collections: string[];
  topics: string[];
  keywords: string[];
  recognized: boolean;
};

/** A dhs.gov /publication/ page: title, body, the "Table of Files associated with page", tags and "Last Updated". */
export function parseDhsPublication(html: string, pageUrl: string, hosts: readonly string[]): DhsPublication {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1];
  const bodyHtml =
    /<div\b[^>]*class="[^"]*field--name-body[^"]*"[^>]*>\s*<div\b[^>]*class="field__label[^"]*"[^>]*>[\s\S]*?<\/div>\s*<div\b[^>]*class="field__item"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(html)?.[1] ??
    /<div\b[^>]*class="[^"]*field--name-body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(html)?.[1] ??
    null;
  const attachments: DhsAttachment[] = [];
  const table = /<table\b[^>]*aria-label="Table of Files[^"]*"[^>]*>([\s\S]*?)<\/table\s*>/i.exec(html)?.[1];
  if (table) {
    const tbody = /<tbody\b[^>]*>([\s\S]*?)<\/tbody\s*>/i.exec(table)?.[1] ?? "";
    for (const row of tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
      const link = anchors(row[1])[0];
      const url = link ? httpsUrl(resolveUrl(link.href, pageUrl), hosts) : null;
      if (!link || !url) continue;
      const tds = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)].map((c) => lineText(c[1]));
      attachments.push({ url, label: lineText(link.inner), ext: tds[0] || null, size: tds[1] || null, dateText: tds[2] || null });
    }
  }
  const tags = (heading: string) => {
    const block = new RegExp(`<h2>\\s*${heading}\\s*</h[23]>([\\s\\S]*?)</ul>`, "i").exec(html)?.[1] ?? "";
    return anchors(block).map((a) => lineText(a.inner)).filter(Boolean);
  };
  return {
    title: h1 ? lineText(h1) : null,
    bodyHtml,
    attachments,
    lastUpdated: /Last Updated:<\/span>\s*([^<]+)/i.exec(html)?.[1]?.trim() ?? null,
    collections: tags("Collections"),
    topics: tags("Topics"),
    keywords: tags("Keywords"),
    recognized: Boolean(h1) && /block-mainpagecontent|<article\b/i.test(html),
  };
}

/** The topic links of the DHS Management Directives page ("/publication/administrative-management"). */
export function parseManagementDirectivesIndex(html: string, pageUrl: string, hosts: readonly string[]): { label: string; url: string }[] {
  const main = mainElement(html) ?? html;
  const section = sliceFrom(main, /listed here in alphabetical order by topic/i, [/<\/ul\s*>/i]);
  if (!section) return [];
  const out: { label: string; url: string }[] = [];
  for (const a of anchors(section)) {
    const url = httpsUrl(resolveUrl(a.href, pageUrl), hosts);
    if (url && /\/publication\//.test(url) && a.text) out.push({ label: lineText(a.inner), url });
  }
  return out;
}

/** A management directive's number at the start of its label: "117-01", "034-06", "MD 6400", "262-12-001". */
export function directiveNumber(label: string): string | null {
  const m = /^(?:(?:DHS\s+)?(?:Directive|Instruction)\s+(?:No\.?\s*)?)?((?:MD\s+)?\d{3,5}(?:[.-]\d{1,3}){0,3})\b/i.exec(label.trim());
  return m ? m[1].replace(/\s+/g, " ") : null;
}

// ---------------------------------------------------------------------------
// USCIS Electronic Reading Room: https://www.uscis.gov/records/electronic-reading-room

export type ReadingRoomRow = { url: string; title: string; fileNote: string | null; dateText: string | null; datetime: string | null; description: string | null };

/** One page of the Electronic Reading Room's results. */
export function parseReadingRoom(html: string, pageUrl: string, hosts: readonly string[]): { recognized: boolean; rows: ReadingRoomRow[] } {
  const rows: ReadingRoomRow[] = [];
  const recognized = /class="views-row"|view-empty|No results found/i.test(html) && /electronic-reading-room/i.test(html);
  for (const m of html.matchAll(/<div class="views-row">([\s\S]*?)(?=<div class="views-row">|<\/div>\s*<\/div>\s*<nav\b|<nav\b[^>]*class="[^"]*pager)/gi)) {
    const block = m[1];
    const titleHtml = /<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/i.exec(block)?.[1];
    const link = titleHtml ? anchors(titleHtml)[0] : undefined;
    const url = link ? httpsUrl(resolveUrl(link.href, pageUrl), hosts) : null;
    if (!link || !url) continue;
    const full = lineText(link.inner);
    const fileNote = /\(((?:PDF|DOCX?|XLSX?)[^)]*)\)\s*$/i.exec(full)?.[1] ?? null;
    const t = /<time\b([^>]*)>([^<]*)<\/time>/i.exec(block);
    const description = /views-field-body[\s\S]*?<div class="field-content">([\s\S]*?)<\/div>/i.exec(block)?.[1];
    rows.push({
      url,
      title: stripFileNote(full),
      fileNote,
      dateText: t ? t[2].trim() || null : null,
      datetime: t ? attrValue(t[1], "datetime") : null,
      description: description ? lineText(description) || null : null,
    });
  }
  return { recognized, rows };
}

// ---------------------------------------------------------------------------
// The remaining Adjudicator's Field Manual (USCIS Policy Manual Part pages)

/** The Policy Manual Parts the AFM crosswalk names: "Volume 1, Part E". */
export function crosswalkParts(text: string): { volume: number; part: string }[] {
  const out = new Map<string, { volume: number; part: string }>();
  for (const m of text.matchAll(/Volume\s+(\d{1,2}),\s*Part\s+([A-Z]{1,2})\b/g)) {
    out.set(`${m[1]}-${m[2]}`, { volume: Number(m[1]), part: m[2] });
  }
  return [...out.values()];
}

/** "Chapter 10: An Overview of the Adjudication Process" lines of the crosswalk (chapter numbers). */
export function crosswalkChapters(text: string): string[] {
  return [...new Set([...text.matchAll(/\bChapter\s+(\d{1,3}(?:\.\d+)?)\s*:/g)].map((m) => m[1]))];
}

/** The "Last updated: July 13, 2026" line of the crosswalk. */
export function crosswalkUpdated(text: string): string | null {
  return /Last updated:\s*([A-Z][a-z]+\.?\s+\d{1,2},\s+\d{4})/.exec(text)?.[1] ?? null;
}

/** The Policy Manual index's Part links, keyed "volume-part" ("1-E"). */
export function parsePolicyManualParts(html: string, pageUrl: string, hosts: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of anchors(html)) {
    const url = httpsUrl(resolveUrl(a.href, pageUrl), hosts);
    if (!url) continue;
    const m = /\/policy-manual\/volume-(\d{1,2})-part-([a-z]{1,2})$/i.exec(new URL(url).pathname);
    if (m && !out.has(`${Number(m[1])}-${m[2].toUpperCase()}`)) out.set(`${Number(m[1])}-${m[2].toUpperCase()}`, url);
  }
  return out;
}

export type AfmLink = { url: string; label: string; chapter: string | null };

/** The "AFM Chapter NN - ... (External)" PDF links on a Policy Manual Part page. */
export function parseAfmLinks(html: string, pageUrl: string, hosts: readonly string[]): AfmLink[] {
  const out: AfmLink[] = [];
  for (const a of anchors(html)) {
    const label = lineText(a.inner);
    if (!/^AFM\s+Chapter\b/i.test(label)) continue;
    const url = httpsUrl(resolveUrl(a.href, pageUrl), hosts);
    if (!url || !isPdfUrl(url)) continue;
    out.push({ url, label, chapter: /^AFM\s+Chapter\s+([\dA-Za-z.()-]+)/i.exec(label)?.[1]?.replace(/[-.]+$/, "") ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drupal book manuals with a printable export (M-274 on uscis.gov, M-775 on e-verify.gov)

/** The "Print Manual" link of a book's landing page ("/book/export/html/59502"), and its "Current as of" line. */
export function parseBookLanding(html: string, pageUrl: string, hosts: readonly string[]): { exportUrl: string | null; currentAs: string | null } {
  let exportUrl: string | null = null;
  for (const a of anchors(html)) {
    const url = httpsUrl(resolveUrl(a.href, pageUrl), hosts);
    if (url && /\/book\/export\/html\/\d+$/.test(new URL(url).pathname)) {
      exportUrl = url;
      break;
    }
  }
  const currentAs = /\|\s*(Current as of [A-Z][a-z]+\.? \d{4})/i.exec(lineText(mainElement(html) ?? html))?.[1] ?? null;
  return { exportUrl, currentAs };
}

export type BookSection = {
  /** The section's own page, from its bookmark link. */
  url: string;
  heading: string;
  depth: number;
  /** The section's own content (its children are separate sections). */
  contentHtml: string;
  /** "Last Reviewed/Updated" as printed ("07/07/2026"). */
  reviewed: string | null;
  /** Headings of the enclosing sections, outermost first. */
  path: string[];
};

/**
 * A book export page (/book/export/html/<id>): each node is an
 * <article class="book-node-depth-N"> with an <h1> heading, then the node's
 * content article (a bookmark link to the node's page, the body fields and
 * a "Last Reviewed/Updated" date), then its children's articles. A node's
 * own content is the text between its start and the next node's start.
 */
export function parseBookExport(html: string, pageUrl: string, hosts: readonly string[]): BookSection[] {
  const starts = [...html.matchAll(/<article\b[^>]*class="[^"]*\bbook-node-depth-(\d+)\b[^"]*"[^>]*>/gi)].map((m) => ({
    index: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
    depth: Number(m[1]),
  }));
  const out: BookSection[] = [];
  const trail: string[] = [];
  starts.forEach((s, i) => {
    const segment = html.slice(s.end, i + 1 < starts.length ? starts[i + 1].index : html.length);
    const heading = /<h1\b[^>]*class="[^"]*book-node-heading[^"]*"[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(segment);
    const bookmark = /<a\b([^>]*\brel="bookmark"[^>]*)>/i.exec(segment);
    const href = bookmark ? attrValue(bookmark[1], "href") : null;
    const url = href ? httpsUrl(resolveUrl(href, pageUrl), hosts) : null;
    if (!heading || !url) return;
    const title = lineText(heading[1]);
    trail.length = Math.max(0, s.depth - 1);
    const path = trail.slice(0, s.depth - 1).filter(Boolean);
    trail[s.depth - 1] = title;
    // The node's content: after the bookmark heading, before its date block and navigation.
    let content = segment.slice((bookmark?.index ?? 0) + (bookmark?.[0].length ?? 0));
    content = content.replace(/^[\s\S]*?<\/h2\s*>/i, "");
    const cut = content.search(/<div\b[^>]*class="[^"]*(?:field--name-field-display-date|field--last-updated-date|current-date|bottom-nav|mobile-nav)\b/i);
    if (cut >= 0) content = content.slice(0, cut);
    const reviewed =
      /(?:field--name-field-display-date|field--last-updated-date)[\s\S]*?<time\b[^>]*>([^<]+)<\/time>/i.exec(segment)?.[1]?.trim() ??
      /current-date__value[^>]*>\s*([^<]+)</i.exec(segment)?.[1]?.trim() ??
      null;
    out.push({ url, heading: title, depth: s.depth, contentHtml: content, reviewed, path });
  });
  return out;
}

/** A book section's text: the heading, then its content. */
export function bookSectionText(section: BookSection): string {
  return htmlToDocumentText(`<h1>${section.heading.replace(/</g, "&lt;")}</h1>${section.contentHtml}`);
}

/** The Policy Manual index's volume links, by volume number. */
export function parsePolicyManualVolumes(html: string, pageUrl: string, hosts: readonly string[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const a of anchors(html)) {
    const url = httpsUrl(resolveUrl(a.href, pageUrl), hosts);
    if (!url) continue;
    const m = /\/policy-manual\/volume-(\d{1,2})$/i.exec(new URL(url).pathname);
    if (m && !out.has(Number(m[1]))) out.set(Number(m[1]), url);
  }
  return out;
}

/** The crosswalk's own sentence on which text prevails when the two conflict. */
export function crosswalkPrecedence(text: string): string | null {
  return /(To the extent that a provision in the Policy Manual conflicts[\s\S]*?prevails\.)/.exec(text)?.[1]?.replace(/\s+/g, " ") ?? null;
}
