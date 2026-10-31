import { anchors, attrValue, htmlToDocumentText, htmlToText, inlineText, resolveUrl } from "../../extract/html";
import { repairMojibake } from "../../text";

// Parsers for the administrative tribunal sources in this folder. Pure, so
// they can be checked against saved pages:
// - OCAHO on justice.gov: the published decisions page
//   (https://www.justice.gov/eoir/office-of-the-chief-administrative-hearing-officer-decisions),
//   one listing page per volume (the OCAHO Practice Manual, Part IV of the
//   EOIR Policy Manual, is collected with the other manual parts in
//   ../eoir-guidance/policy-manual.ts);
// - BALCA on dol.gov: the OALJ caselists (en banc decisions before and
//   under PERM, prevailing wage appeals) and the en banc decision summaries;
// - the decisions EOIR's FOIA Library lists as released records.
// A parser that does not find the markup it reads says so (recognized:
// false) so the adapter fails the run instead of reporting a quiet day.

// ---------------------------------------------------------------------------
// justice.gov (Drupal) page parts

/**
 * The body field of a justice.gov page: from the "field_body" container to
 * the updated-date line, the book navigation or the end of the article,
 * whichever comes first; null when the page has no body field (a book
 * chapter page that only lists its sections).
 */
export function justiceBody(html: string): string | null {
  const start = html.indexOf("field_body");
  if (start < 0) return null;
  const open = html.indexOf(">", start);
  if (open < 0) return null;
  let end = html.length;
  for (const marker of ['<div class="node-updated-date', '<nav class="book-navigation', "</article>", "<footer"]) {
    const at = html.indexOf(marker, open);
    if (at > 0 && at < end) end = at;
  }
  return html.slice(open + 1, end);
}

/** The "Updated <date>" line justice.gov prints under a page, if any. */
export function justiceUpdatedLine(html: string): string | null {
  const m = /<div class="node-updated-date[^"]*">\s*([^<]*?)\s*<\/div>/i.exec(html);
  return m ? inlineText(m[1]) || null : null;
}

/** The page's own <h1> text. */
export function pageHeading(html: string): string | null {
  const m = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
  const text = m ? repairMojibake(inlineText(m[1])) : "";
  return text || null;
}

// ---------------------------------------------------------------------------
// Tables with rowspans

type GridRow = { cells: (string | undefined)[]; header: boolean; reset: boolean };

/**
 * A table's rows as a grid, with row and column spans expanded the way a
 * browser lays them out. One repair: a row that has a full set of its own
 * cells while an earlier rowspan still covers some columns (EOIR's volume
 * pages have a few rowspans one row too long) starts afresh, instead of
 * having its cells pushed out of their columns.
 */
export function tableGrid(table: string): GridRow[] {
  const raw = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((m) =>
    [...m[1].matchAll(/<(t[dh])\b([^>]*)>([\s\S]*?)<\/t[dh]\s*>/gi)].map((c) => ({
      header: c[1].toLowerCase() === "th",
      html: c[3],
      rowspan: Math.max(1, Math.min(50, Number(attrValue(c[2], "rowspan")) || 1)),
      colspan: Math.max(1, Math.min(20, Number(attrValue(c[2], "colspan")) || 1)),
    }))
  );
  const width = Math.max(0, ...raw.map((cells) => cells.reduce((n, c) => n + c.colspan, 0)));
  let pending: ({ html: string; left: number } | undefined)[] = [];
  const rows: GridRow[] = [];
  for (const cells of raw) {
    const need = cells.reduce((n, c) => n + c.colspan, 0);
    const covered = pending.filter((p) => p && p.left > 0).length;
    const reset = covered > 0 && need > width - covered;
    if (reset) pending = [];
    const out: (string | undefined)[] = [];
    let next = 0;
    for (let col = 0; col < width || next < cells.length; col++) {
      const span = pending[col];
      if (span && span.left > 0) {
        out[col] = span.html;
        span.left--;
        continue;
      }
      const cell = cells[next++];
      if (!cell) continue;
      for (let k = 0; k < cell.colspan; k++) {
        out[col + k] = cell.html;
        pending[col + k] = cell.rowspan > 1 ? { html: cell.html, left: cell.rowspan - 1 } : undefined;
      }
      col += cell.colspan - 1;
    }
    rows.push({ cells: out, header: cells.length > 0 && cells.every((c) => c.header), reset });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// OCAHO published decisions

export type OcahoVolumeLink = { volume: number; binding: "Bound" | "Looseleaf"; url: string; label: string };

/** The volumes the OCAHO published decisions page links ("Bound Volume 1" to "Looseleaf Volume 23"), highest first. */
export function parseOcahoIndex(html: string, pageUrl: string): OcahoVolumeLink[] {
  const body = justiceBody(html) ?? "";
  const seen = new Map<number, OcahoVolumeLink>();
  for (const a of anchors(body)) {
    const m = /^(Bound|Looseleaf)\s+Volume\s+0*(\d{1,3})$/i.exec(a.text);
    if (!m) continue;
    const url = resolveUrl(a.href, pageUrl);
    if (!url) continue;
    const volume = Number(m[2]);
    const binding = m[1].toLowerCase() === "bound" ? "Bound" : "Looseleaf";
    if (!seen.has(volume)) seen.set(volume, { volume, binding, url, label: a.text });
  }
  return [...seen.values()].sort((x, y) => y.volume - x.volume);
}

export type OcahoEntry = {
  /** The OCAHO reference number as the page prints it ("1271a", "1450aa"). */
  reference: string;
  /**
   * 0 for the first file the page links under this reference number, 1 and
   * up for further, different files under the same number (volume 7 links
   * two files as 936, volume 10 two as 1128).
   */
  fileIndex: number;
  pdfUrl: string;
  /** Each distinct case name the rows for this reference number give, in page order. */
  caseNames: string[];
  caseNumbers: string[];
  /** The decision dates as printed ("2/24/16", "06/24/2026"). */
  decisionDates: string[];
  /** The "CAHO Decision" column is marked (a decision of the Chief Administrative Hearing Officer). */
  caho: boolean;
  /**
   * Set when the row leaves the case name or number blank and they were
   * taken from the first decision with the same reference number on the
   * page: OCAHO numbers every later decision in a case with the first
   * one's number and a sub-letter (as the page itself explains).
   */
  captionFrom: string | null;
};

export type OcahoVolumeParse = {
  entries: OcahoEntry[];
  rowsSeen: number;
  notes: string[];
  pageUpdated: string | null;
  recognized: boolean;
};

const OCAHO_REF = /^(\d{1,4}[a-z]{0,2})\b/i;
const LISTED_DATE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;

function cellText(html: string | undefined): string {
  return html ? repairMojibake(inlineText(html)).trim() : "";
}

/** One OCAHO volume listing: a table of case name, case number, decision date, reference number (the PDF link) and, from volume 10, a CAHO column. */
export function parseOcahoVolume(html: string, pageUrl: string): OcahoVolumeParse {
  const body = justiceBody(html);
  const pageUpdated = justiceUpdatedLine(html);
  const notes: string[] = [];
  const empty = (note: string): OcahoVolumeParse => ({ entries: [], rowsSeen: 0, notes: [note], pageUpdated, recognized: false });
  if (!body) return empty("The page has no body field.");
  const table = /<table\b[\s\S]*?<\/table\s*>/i.exec(body)?.[0];
  if (!table) return empty("The page has no table.");
  const grid = tableGrid(table);
  const headerAt = grid.findIndex((row) => row.cells.some((c) => /case\s*name/i.test(cellText(c))) && row.cells.some((c) => /reference/i.test(cellText(c))));
  if (headerAt < 0) return empty("The table has no Case Name / Reference No. header.");
  const heads = grid[headerAt].cells.map(cellText);
  const col = (re: RegExp) => heads.findIndex((h) => re.test(h));
  const nameCol = col(/case\s*name/i);
  const numberCol = col(/case\s*(number|no)/i);
  const dateCol = col(/date/i);
  const refCol = col(/reference/i);
  const cahoCol = col(/caho/i);
  if (nameCol < 0 || dateCol < 0 || refCol < 0) return empty(`Unexpected columns: ${heads.join(" | ")}`);

  // Rows are grouped by reference number and file: consolidated cases list
  // one decision once per case number, and a few numbers link two files.
  const byRef = new Map<string, OcahoEntry>();
  const filesOf = new Map<string, string[]>();
  let rowsSeen = 0;
  for (const row of grid.slice(headerAt + 1)) {
    if (row.header) continue;
    rowsSeen++;
    if (row.reset) notes.push(`A row overlapping an earlier row span was read on its own (${cellText(row.cells[nameCol]).slice(0, 60) || "no caption"}).`);
    const refHtml = row.cells[refCol] ?? "";
    const link = anchors(refHtml).find((a) => OCAHO_REF.test(a.text));
    if (!link) {
      if (cellText(refHtml) || anchors(refHtml).length) notes.push(`A row's reference cell could not be read (${cellText(refHtml).slice(0, 40)}); it was left out.`);
      continue;
    }
    const reference = OCAHO_REF.exec(link.text)![1].toLowerCase();
    const pdfUrl = resolveUrl(link.href, pageUrl);
    if (!pdfUrl) {
      notes.push(`Reference ${reference} has a link that is not a URL; it was left out.`);
      continue;
    }
    const files = filesOf.get(reference) ?? [];
    let fileIndex = files.indexOf(pdfUrl);
    if (fileIndex < 0) {
      fileIndex = files.push(pdfUrl) - 1;
      filesOf.set(reference, files);
      if (fileIndex > 0) notes.push(`Reference ${reference} links ${files.length} different files; each is kept as its own document.`);
    }
    const key = `${reference}\u0000${fileIndex}`;
    let entry = byRef.get(key);
    if (!entry) {
      entry = { reference, fileIndex, pdfUrl, caseNames: [], caseNumbers: [], decisionDates: [], caho: false, captionFrom: null };
      byRef.set(key, entry);
    }
    const name = cellText(row.cells[nameCol]);
    const number = numberCol >= 0 ? cellText(row.cells[numberCol]) : "";
    const dates = cellText(row.cells[dateCol]).match(LISTED_DATE) ?? [];
    if (name && !entry.caseNames.includes(name)) entry.caseNames.push(name);
    if (number && !entry.caseNumbers.includes(number)) entry.caseNumbers.push(number);
    for (const d of dates) if (!entry.decisionDates.includes(d)) entry.decisionDates.push(d);
    if (cahoCol >= 0 && /\bX\b/i.test(cellText(row.cells[cahoCol]))) entry.caho = true;
  }
  const all = [...byRef.values()];
  const base = new Map<string, OcahoEntry>();
  for (const e of all) if (/^\d+$/.test(e.reference) && e.fileIndex === 0) base.set(e.reference, e);
  const entries = all.filter((e) => {
    const first = /^\d+[a-z]+$/.test(e.reference) ? base.get(e.reference.replace(/[a-z]+$/, "")) : undefined;
    if (first && (!e.caseNames.length || !e.caseNumbers.length)) {
      if (!e.caseNames.length) e.caseNames = [...first.caseNames];
      if (!e.caseNumbers.length) e.caseNumbers = [...first.caseNumbers];
      e.captionFrom = first.reference;
    }
    if (e.caseNames.length) return true;
    notes.push(`Reference ${e.reference} has no case name on the page; it was left out.`);
    return false;
  });
  return { entries, rowsSeen, notes, pageUpdated, recognized: rowsSeen > 0 && entries.length > 0 };
}

/**
 * A date as the OCAHO listings print it ("2/24/16", "06/24/2026") as
 * YYYY-MM-DD. Two-digit years are read in OCAHO's own span: the office
 * began publishing in 1988, so 87 to 99 are 19xx and the rest 20xx.
 */
export function parseListedDate(text: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text.trim());
  if (!m) return null;
  const yy = Number(m[3]);
  const year = m[3].length === 4 ? yy : yy >= 87 ? 1900 + yy : 2000 + yy;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export type OcahoDecisionHeader = {
  /** The citation printed at the head of the decision ("23 OCAHO no. 1732", "1 OCAHO 1"). */
  citation: string | null;
  volume: number | null;
  reference: string | null;
  /** The date printed on its own line under the office's name ("October 2, 2026"); older decisions print none there. */
  headerDate: string | null;
  /** The statute the caption names ("8 U.S.C. § 1324a"). */
  proceeding: string | null;
  /** "OCAHO Case No. 2026A00054" as printed. */
  caseNumber: string | null;
};

const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

/** What the first page of an OCAHO decision states about itself. */
export function parseOcahoDecisionHeader(text: string): OcahoDecisionHeader {
  const head = text.slice(0, 3000);
  const cite = /\b(\d{1,2})\s+OCAHO\s+(?:no\.?\s*)?(\d{1,4}[a-z]{0,2})\b/i.exec(head.slice(0, 800));
  // The date printed on a line of its own under the office name (newer decisions); a date inside a sentence is not it.
  const date = new RegExp(String.raw`^[ \t]*(${MONTH}\.?\s+\d{1,2},\s+\d{4})[ \t]*$`, "m").exec(head.slice(0, 1500));
  const proceeding = /(8\s+U\.?\s?S\.?\s?C\.?\s*(?:§|'|&#167;)?\s*1324[abc])\s+Proceeding/i.exec(head);
  const caseNumber = /OCAHO\s+Case\s+No\.?\s*([0-9A-Z]{6,12})/i.exec(head);
  return {
    citation: cite ? cite[0].replace(/\s+/g, " ") : null,
    volume: cite ? Number(cite[1]) : null,
    reference: cite ? cite[2].toLowerCase() : null,
    headerDate: date ? date[1].replace(/\s+/g, " ") : null,
    proceeding: proceeding ? proceeding[1].replace(/\s+/g, " ").replace(/'/g, "§") : null,
    caseNumber: caseNumber ? caseNumber[1] : null,
  };
}

// ---------------------------------------------------------------------------
// BALCA caselists (dol.gov)

export type BalcaCaselist = "en_banc_pre_perm" | "en_banc_perm" | "pwd";

export type BalcaEntry = {
  caption: string;
  /** The first docket number as listed ("1987-INA-161", "2011-PWD-00001"). */
  docket: string;
  /** All the docket numbers the entry gives, as listed ("1987-INA-570 and 571", "1989-INA-311, et al"). */
  docketText: string;
  /** The parenthetical with the date as listed ("Dec. 7, 1988", "ALJ Feb. 27, 2012"). */
  dateText: string;
  /** The parentheticals after the date ("en banc", "Per Curiam", "Decision and Order ..."). */
  parentheticals: string[];
  /** The decision file on www.oalj.dol.gov, as linked. */
  fileUrl: string;
  /** The same decision in another format, linked right after it ("PDF | HTML"). */
  alternateUrls: string[];
  /**
   * When an entry links more than one file (a decision and a later order in
   * the same case), the parenthetical just before this file's link
   * ("Order Denying Motion for Reconsideration"); null for a single file.
   */
  documentLabel: string | null;
  /** 0 for the entry's first file, 1 and up for the others (the date is the first one's). */
  fileIndex: number;
  /** The caselist's own summary bullets under the entry (the PERM en banc list prints them). */
  summary: string | null;
  /** The entry's whole line as listed. */
  listedAs: string;
};

export type BalcaCaselistParse = { entries: BalcaEntry[]; itemsSeen: number; notes: string[]; recognized: boolean };

const DOCKET = /\b\d{4}-[A-Z]{3}[- ]\d{1,5}[A-Z]?\b/;
const DATE_PAREN = new RegExp(String.raw`\(([^()]*?\b${MONTH}\.?,?\s+\d{1,2}\s*,\s*\d{4})\)`);
// A date whose opening parenthesis the page left out ("1989-INA-320 et al. Mar. 12, 1991)").
const DATE_BARE = new RegExp(String.raw`(\b${MONTH}\.?,?\s+\d{1,2}\s*,\s*\d{4})\)?`);

/** The content field of a dol.gov page (the OALJ pages keep their old markup inside it). */
export function dolContent(html: string): string | null {
  const start = html.indexOf("field--name-field-p-text");
  if (start < 0) return null;
  const open = html.indexOf(">", start);
  const end = html.indexOf("</article>", open);
  return html.slice(open + 1, end > 0 ? end : html.length);
}

function parentheticals(rest: string): string[] {
  return [...rest.matchAll(/\(([^()]+)\)/g)].map((m) => m[1].trim()).filter(Boolean);
}

/** A link without the analytics parameters some caselist links carry ("?_ga=2.1991..."); the rest of the URL as linked. */
function withoutTracking(url: string | null): string | null {
  if (!url) return null;
  const u = new URL(url);
  for (const key of [...u.searchParams.keys()]) if (/^_g[al]$/.test(key)) u.searchParams.delete(key);
  return u.toString();
}

/**
 * A listed date with the stray punctuation some caselist lines have
 * ("Dec. 29 , 1988", "Jan, 9, 2004") taken out, so it parses; the text as
 * listed is kept separately.
 */
export function tidyListedDate(text: string): string {
  return text.replace(/\s+,/g, ",").replace(new RegExp(String.raw`\b(${MONTH})\.?,\s*(\d)`), "$1 $2");
}

/** A link to a decision file on the OALJ host. */
function isDecisionFile(href: string): boolean {
  return /^https?:\/\/www\.oalj\.dol\.gov\/.+\.(?:pdf|html?)(?:\?.*)?$/i.test(href.trim());
}

/**
 * One caselist line: "CAPTION, DOCKET(S) (DATE) (PARENTHETICALS) PDF". A
 * line can give several docket numbers ("1987-INA-570 and 571"), leave out
 * the comma before the docket or the parenthesis before the date, and link
 * more than one file (each becomes its own entry).
 */
function balcaEntries(lineHtml: string, pageUrl: string, summary: string | null): BalcaEntry[] | null {
  const links = anchors(lineHtml).filter((a) => isDecisionFile(a.href));
  if (!links.length) return null;
  // The line without its "PDF" / "HTM" link labels.
  const text = repairMojibake(inlineText(lineHtml.replace(/<a\b[^>]*>\s*(?:<[^>]+>\s*)*(?:PDF|HTML?)(?:&nbsp;|\s)*(?:<\/[^>]+>\s*)*<\/a\s*>/gi, " ")))
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const docket = DOCKET.exec(text);
  if (!docket) return null;
  const caption = text.slice(0, docket.index).replace(/[,\s]+$/, "").trim();
  const afterDocket = text.slice(docket.index);
  const date = DATE_PAREN.exec(afterDocket) ?? DATE_BARE.exec(afterDocket);
  if (!caption || !date) return null;
  const docketText = afterDocket.slice(0, date.index).replace(/[,(\s]+$/, "").trim();
  const rest = afterDocket.slice(date.index + date[0].length);
  // Files: a link right after another with nothing but "|" between them is
  // the same decision in another format ("PDF | HTML"); any other link is a
  // further document of the line (a later order), labeled by the
  // parenthetical before it.
  const files: { url: string; before: string; alternates: string[] }[] = [];
  let previousEnd = 0;
  for (const link of links) {
    const url = withoutTracking(resolveUrl(link.href, pageUrl));
    const before = inlineText(lineHtml.slice(previousEnd, link.index)).replace(/[|\s]+/g, " ").trim();
    const close = lineHtml.toLowerCase().indexOf("</a", link.index);
    previousEnd = close < 0 ? link.index : close;
    if (!url) continue;
    const last = files[files.length - 1];
    if (last && before === "") last.alternates.push(url);
    else files.push({ url, before, alternates: [] });
  }
  const out: BalcaEntry[] = files.map((file, i) => ({
    caption,
    docket: docket[0].replace(" ", "-"),
    docketText,
    dateText: date[1].trim(),
    parentheticals: parentheticals(rest),
    fileUrl: file.url,
    alternateUrls: file.alternates,
    documentLabel: files.length > 1 ? (parentheticals(file.before).pop() ?? null) : null,
    fileIndex: i,
    summary,
    listedAs: text,
  }));
  return out.length ? out : null;
}

/**
 * One OALJ caselist. The pre-PERM en banc list and the PWD list are lists
 * of <li> lines ("CAPTION, 1987-INA-161 (Dec. 7, 1988) (en banc) PDF"); the
 * PERM en banc list gives each decision an <h2> line followed by a list of
 * the caselist's summary bullets.
 */
export function parseBalcaCaselist(html: string, pageUrl: string, kind: BalcaCaselist): BalcaCaselistParse {
  const content = dolContent(html);
  if (!content) return { entries: [], itemsSeen: 0, notes: ["The page has no content field."], recognized: false };
  const entries: BalcaEntry[] = [];
  const notes: string[] = [];
  let itemsSeen = 0;
  if (kind === "en_banc_perm") {
    const heads = [...content.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/gi)];
    heads.forEach((h, i) => {
      itemsSeen++;
      const after = content.slice((h.index ?? 0) + h[0].length, i + 1 < heads.length ? heads[i + 1].index : content.length);
      const list = /<ul\b[\s\S]*?<\/ul\s*>/i.exec(after)?.[0];
      const summary = list ? repairMojibake(htmlToDocumentText(list)) || null : null;
      const found = balcaEntries(h[1], pageUrl, summary);
      if (found) entries.push(...found);
      else notes.push(`An entry could not be read (${inlineText(h[1]).slice(0, 80)}); it was left out.`);
    });
  } else {
    for (const li of content.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
      const text = inlineText(li[1]);
      if (!/\d{4}-[A-Z]{3}-\d/.test(text)) continue;
      itemsSeen++;
      const found = balcaEntries(li[1], pageUrl, null);
      if (found) entries.push(...found);
      else notes.push(`An entry could not be read (${text.slice(0, 80)}); it was left out.`);
    }
  }
  return { entries, itemsSeen, notes, recognized: entries.length > 0 };
}

export type SummaryTopic = { url: string; title: string };

/** The topic pages the BALCA en banc decision summaries' table of contents links. */
export function parseSummariesToc(html: string, pageUrl: string): SummaryTopic[] {
  const content = dolContent(html) ?? "";
  const seen = new Map<string, SummaryTopic>();
  // Each topic is a bold paragraph followed (until the next one) by links
  // into its page, sometimes under underlined sub-headings; the page is the
  // link target without its fragment. A page linked under two topics keeps
  // the first.
  const heads = [...content.matchAll(/<p>\s*<strong>([\s\S]*?)<\/strong>\s*<\/p>/gi)];
  heads.forEach((head, i) => {
    const start = (head.index ?? 0) + head[0].length;
    const segment = content.slice(start, i + 1 < heads.length ? heads[i + 1].index : content.length);
    const title = repairMojibake(inlineText(head[1]));
    for (const a of anchors(segment)) {
      const link = resolveUrl(a.href, pageUrl);
      if (!link || !/BALCA_EN_BANC_SUMMARIES_(?!TABLE_OF_CONTENTS)[A-Z0-9_]+(#.*)?$/.test(link)) continue;
      const u = new URL(link);
      const url = `${u.origin}${u.pathname}`;
      if (!seen.has(url)) seen.set(url, { url, title });
    }
  });
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// EOIR FOIA Library: released decisions

export type ReleasedDecisionLink = { url: string; label: string; section: string };

/**
 * The links in a FOIA Library section headed by a bold paragraph
 * ("Decisions", "Requested Decisions"): the first list after the heading.
 * Null when the heading is not on the page.
 */
export function parseFoiaSection(html: string, pageUrl: string, heading: string): ReleasedDecisionLink[] | null {
  const body = justiceBody(html);
  if (!body) return null;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const at = new RegExp(`<strong>\\s*${escaped}\\s*</strong>`, "i").exec(body);
  if (!at) return null;
  const list = /<ul\b[\s\S]*?<\/ul\s*>/i.exec(body.slice(at.index));
  if (!list) return [];
  const out: ReleasedDecisionLink[] = [];
  for (const li of list[0].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
    const link = anchors(li[1])[0];
    const url = link ? resolveUrl(link.href, pageUrl) : null;
    if (!link || !url) continue;
    const label = repairMojibake(inlineText(li[1]))
      .replace(/\s*\(PDF\)\s*$/i, "")
      .replace(/\s+/g, " ")
      .replace(/\s+-$/, "-")
      .trim();
    out.push({ url, label: label || link.text, section: heading });
  }
  return out;
}

/** The FOIA Library's statement of why its records are public ("Frequently requested records have been disclosed ..."). */
export function foiaReleaseStatement(html: string): string | null {
  const body = justiceBody(html);
  if (!body) return null;
  const text = htmlToText(body);
  const m = /Frequently requested records have been disclosed[^\n]*?\./i.exec(text);
  return m ? m[0].trim() : null;
}

export type ImmigrationCourtHeader = {
  /** The decision's first page names an immigration court as the body deciding it. */
  isImmigrationCourt: boolean;
  /** The first page names the Board of Immigration Appeals (a Board decision, not a judge's). */
  isBoard: boolean;
  /** The lines under "IMMIGRATION COURT" up to the caption ("KROME SERVICE PROCESSING CENTER, MIAMI, FLORIDA"). */
  courtLocation: string | null;
  /** The signature line's date as written ("12th day of July, 2017", "July 12, 2017"). */
  signedText: string | null;
  /** The signature date as YYYY-MM-DD. */
  signedDate: string | null;
  /** The order's title as printed ("ORDER OF THE IMMIGRATION JUDGE", "DECISION AND ORDER OF THE IMMIGRATION JUDGE"). */
  orderTitle: string | null;
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** What a decision's text says about who decided it and when it was signed. */
export function parseImmigrationCourtHeader(text: string): ImmigrationCourtHeader {
  const head = text.slice(0, 2500);
  const isBoard = /Board\s+of\s+Immigration\s+Appeals/i.test(head.slice(0, 600));
  const court = /IMMIGRATION\s+COURT\s*\n([\s\S]*?)\n\s*(?:IN\s+THE\s+MATTER|In\s+the\s+Matter|File|Matter\s+of)/.exec(head);
  const isImmigrationCourt = !isBoard && /UNITED\s+STATES\s+IMMIGRATION\s+COURT|IMMIGRATION\s+COURT\s*\n/i.test(head);
  const location = court ? court[1].split("\n").map((l) => l.trim()).filter(Boolean).join(", ") : null;
  const orderTitle = /\b((?:DECISION\s+AND\s+)?ORDERS?\s+OF\s+THE\s+IMMIGRATION\s+JUDGE)\b/.exec(text)?.[1].replace(/\s+/g, " ") ?? null;
  let signedText: string | null = null;
  let signedDate: string | null = null;
  const dayOf = /\bDATED\s+this\s+(\d{1,2})(?:st|nd|rd|th)?\s+day\s+of\s+([A-Za-z]+),?\s+(\d{4})/i.exec(text);
  if (dayOf) {
    const month = MONTHS.indexOf(dayOf[2].toLowerCase());
    signedText = dayOf[0].replace(/^DATED\s+this\s+/i, "").replace(/\s+/g, " ");
    if (month >= 0) {
      const d = new Date(Date.UTC(Number(dayOf[3]), month, Number(dayOf[1])));
      if (d.getUTCMonth() === month && d.getUTCDate() === Number(dayOf[1])) signedDate = d.toISOString().slice(0, 10);
    }
  }
  return { isImmigrationCourt, isBoard, courtLocation: location || null, signedText, signedDate, orderTitle };
}
