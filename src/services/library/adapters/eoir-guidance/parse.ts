import { anchors, htmlToText, inlineText, resolveUrl, tableRows } from "../../extract/html";
import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { repairMojibake } from "../../text";

// Parsers for EOIR's guidance pages on justice.gov: the EOIR Policy Manual
// (its book navigation, section pages and Appendix O, the Table of
// Changes), the Part V memoranda lists, the Forms & Fees page and the
// immigration court directory. Pure, so they can be checked against saved
// pages. Every page is a Drupal node: the content sits in the "field_body"
// container, the date the page was last changed in its
// article:modified_time meta tag, and every Policy Manual page carries the
// whole manual's table of contents in its sidebar ("block-booknavigation").

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

/**
 * The page's body field: from the "field_body" container to the bottom book
 * navigation, the end of the article or the footer, whichever comes first;
 * null when the page has none.
 */
export function bodyField(html: string): string | null {
  const start = html.indexOf("field_body");
  if (start < 0) return null;
  const tagStart = html.lastIndexOf("<", start);
  const rest = html.slice(tagStart >= 0 ? tagStart : start);
  let end = rest.length;
  for (const marker of ['<nav class="book-navigation', "</article>", "<footer", '<div class="node-updated-date']) {
    const at = rest.indexOf(marker, 1);
    if (at > 0 && at < end) end = at;
  }
  return rest.slice(0, end);
}

/** The page's <h1>, entities decoded; null when it has none. */
export function pageHeading(html: string): string | null {
  const m = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
  const text = m ? repairMojibake(inlineText(m[1])) : "";
  return text || null;
}

/** The content of an Open Graph article:* meta tag ("2026-04-15T16:05:33-04:00"); null when absent. */
export function articleTime(html: string, name: "published_time" | "modified_time"): string | null {
  const m = new RegExp(`<meta\\s+property="article:${name}"\\s+content="([^"]+)"`, "i").exec(html);
  return m ? m[1].trim() : null;
}

/** The "Updated <Month D, YYYY>" line a page's body opens with ("Updated February 10, 2026"); null when absent. */
export function updatedLine(bodyHtml: string): string | null {
  const m = /^\s*Updated\s+([A-Z][a-z]+\.?\s+\d{1,2},\s+\d{4})/.exec(htmlToText(bodyHtml));
  return m ? m[1].replace(/\s+/g, " ") : null;
}

/** Anchors with their place in the fragment (start of <a>, end of </a>). */
type AnchorSpan = { href: string; text: string; start: number; end: number };

function anchorSpans(fragment: string): AnchorSpan[] {
  const cleaned = fragment.replace(/<!--[\s\S]*?-->/g, (c) => " ".repeat(c.length));
  const out: AnchorSpan[] = [];
  for (const m of cleaned.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = /\bhref\s*=\s*"([^"]*)"/i.exec(m[1])?.[1] ?? /\bhref\s*=\s*'([^']*)'/i.exec(m[1])?.[1];
    if (href === undefined) continue;
    const start = m.index ?? 0;
    out.push({ href: href.replace(/&amp;/g, "&").trim(), text: repairMojibake(inlineText(m[2])), start, end: start + m[0].length });
  }
  return out;
}

/** Collapses whitespace (non-breaking spaces included) and trims. */
function squash(text: string): string {
  return text.replace(/[\s\u00a0]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// EOIR Policy Manual: the book navigation
// ---------------------------------------------------------------------------

export type TocNode = { title: string; url: string; children: TocNode[] };

/**
 * The Policy Manual's table of contents, from the sidebar book navigation
 * every manual page carries: nested lists of parts, chapters and sections,
 * each an <a> with the page's link. Empty when the sidebar is not there.
 */
export function parseBookToc(html: string, pageUrl: string): TocNode[] {
  const block = html.indexOf('id="block-booknavigation"');
  if (block < 0) return [];
  const first = html.slice(block).search(/<ul\b[^>]*class="[^"]*\bbook-level1\b/i);
  if (first < 0) return [];
  const from = block + first;
  const root: TocNode = { title: "", url: "", children: [] };
  const stack: TocNode[] = [root];
  let depth = 0;
  const tags = /<(\/?)(ul|li|a)\b([^>]*)>/gi;
  tags.lastIndex = from;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (tag === "ul") {
      depth += closing ? -1 : 1;
      if (depth <= 0) break;
    } else if (tag === "li") {
      if (closing) {
        if (stack.length > 1) stack.pop();
      } else {
        const node: TocNode = { title: "", url: "", children: [] };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      }
    } else if (tag === "a" && !closing) {
      const close = html.indexOf("</a>", tags.lastIndex);
      if (close < 0) break;
      const node = stack[stack.length - 1];
      const href = /\bhref\s*=\s*"([^"]*)"/i.exec(m[3])?.[1];
      if (node !== root && !node.url && href) {
        node.url = resolveUrl(href.trim(), pageUrl) ?? "";
        node.title = squash(repairMojibake(inlineText(html.slice(tags.lastIndex, close))));
      }
      tags.lastIndex = close + 4;
    }
  }
  const prune = (nodes: TocNode[]): TocNode[] =>
    nodes.filter((n) => n.url && n.title).map((n) => ({ ...n, children: prune(n.children) }));
  return prune(root.children);
}

/** "Part II - OCIJ Immigration Court Practice Manual" gives "II". */
export function partNumeral(partTitle: string): string | null {
  return /^Part\s+([IVX]+)\b/i.exec(partTitle)?.[1].toUpperCase() ?? null;
}

/**
 * How the manual refers to a section, from its title: "3.14 - Master
 * Calendar Hearing" is Chapter 3.14, "Chapter 9 - Judicial Conduct" is
 * Chapter 9, "Appx C - Deadlines" is Appx C; null for anything else.
 */
export function sectionLabel(title: string): { label: string; number: string | null; appendix: string | null } | null {
  let m = /^(\d{1,2}\.\d{1,2})\s*[-\u2013\u2014]/.exec(title);
  if (m) return { label: `Chapter ${m[1]}`, number: m[1], appendix: null };
  m = /^Chapter\s+(\d{1,2})\b/i.exec(title);
  if (m) return { label: `Chapter ${m[1]}`, number: m[1], appendix: null };
  m = /^Appx\.?\s+([A-Z])\b/i.exec(title);
  if (m) return { label: `Appx ${m[1].toUpperCase()}`, number: null, appendix: m[1].toUpperCase() };
  return null;
}

// ---------------------------------------------------------------------------
// EOIR Policy Manual: Appendix O, the Table of Changes
// ---------------------------------------------------------------------------

export type ChangeEntry = {
  /** The "Section Amended" cell as printed ("Part III", "Parts I, II, III, IV, and V", "Appendix C"). */
  sectionAmended: string;
  /** The "Date of Change" cell as printed ("April 15, 2026"). */
  dateOfChange: string;
  /** That date as YYYY-MM-DD, when it parses. */
  date: string | null;
  /** The "Nature of Change" cell, its lines joined with "; ". */
  natureOfChange: string;
  /** Roman numerals of the parts the "Section Amended" cell names. */
  parts: string[];
  /** Appendix letters the "Section Amended" cell names. */
  appendices: string[];
  /** The cell names no part but says the whole manual changed ("Substantive and stylistic edits throughout"). */
  wholeManual: boolean;
};

/** Appendix O's rows: Section Amended | Date of Change | Nature of Change, newest first as printed. */
export function parseTableOfChanges(bodyHtml: string): { entries: ChangeEntry[]; rowsSeen: number } {
  const entries: ChangeEntry[] = [];
  let rowsSeen = 0;
  for (const cells of tableRows(bodyHtml)) {
    if (cells.length !== 3) continue;
    const sectionAmended = squash(repairMojibake(inlineText(cells[0])));
    const dateOfChange = squash(inlineText(cells[1]));
    if (/^Section Amended$/i.test(sectionAmended)) continue;
    rowsSeen++;
    const natureOfChange = repairMojibake(htmlToText(cells[2]))
      .split("\n")
      .map(squash)
      .filter(Boolean)
      .join("; ");
    if (!sectionAmended || !dateOfChange || !natureOfChange) continue;
    const parts = new Set<string>();
    for (const group of sectionAmended.matchAll(/\bParts?\s+((?:[IVX]+\b(?:\s*,\s*|\s*,?\s*(?:and|&)\s*)?)+)/gi)) {
      for (const numeral of group[1].matchAll(/\b[IVX]+\b/g)) parts.add(numeral[0].toUpperCase());
    }
    const appendices = [...sectionAmended.matchAll(/\bAppendi(?:x|ces)\s+([A-Z])\b/g)].map((a) => a[1]);
    entries.push({
      sectionAmended,
      dateOfChange,
      date: parseStatedDate(dateOfChange),
      natureOfChange,
      parts: [...parts],
      appendices,
      wholeManual: parts.size === 0 && appendices.length === 0 && /\bthroughout\b/i.test(sectionAmended),
    });
  }
  return { entries, rowsSeen };
}

/**
 * The Table of Changes rows that apply to one section of the current
 * edition of its part: dated on or after the part's "Updated" date (EOIR
 * renumbers chapters between editions, so an older row's "3.7" may be
 * another section) and either naming the whole manual, naming the part
 * with "throughout", naming the section's number in the nature of change,
 * or naming the section's appendix.
 */
export function changesForSection(
  entries: readonly ChangeEntry[],
  section: { part: string | null; number: string | null; appendix: string | null; partUpdated: string | null }
): (ChangeEntry & { scope: "manual" | "part" | "section" })[] {
  if (!section.partUpdated) return [];
  const out: (ChangeEntry & { scope: "manual" | "part" | "section" })[] = [];
  const numberPattern = section.number ? new RegExp(`(?<![\\d.])${section.number.replace(".", "\\.")}(?![\\d])`) : null;
  for (const e of entries) {
    if (!e.date || e.date < section.partUpdated) continue;
    if (e.wholeManual) {
      out.push({ ...e, scope: "manual" });
      continue;
    }
    if (section.appendix && e.appendices.includes(section.appendix)) {
      out.push({ ...e, scope: "section" });
      continue;
    }
    if (!section.part || !e.parts.includes(section.part)) continue;
    if (/\bthroughout\b/i.test(e.natureOfChange)) out.push({ ...e, scope: "part" });
    else if (numberPattern && section.number?.includes(".") && numberPattern.test(e.natureOfChange)) out.push({ ...e, scope: "section" });
  }
  return out;
}

export type MemoChange = { kind: "PM" | "OPPM"; number: string; action: "added" | "removed"; note: string | null; entry: ChangeEntry };

/**
 * What Appendix O says about each policy memorandum and operating policies
 * and procedures memorandum: "Added Policy Memoranda 25-46, 25-47, and
 * 25-48", "Removed Operating Policies and Procedures Memorandum 84-9, 98-2,
 * 93-1 (Cancellation)". Director's Memoranda are left out (none is listed
 * any more). Rows that name a memorandum by its component ("BIA Operating
 * Policies and Procedures Memorandum (OPPM) 24-01") are left out: the
 * number alone does not say which memorandum it is.
 */
export function memoChanges(entries: readonly ChangeEntry[]): MemoChange[] {
  const out: MemoChange[] = [];
  const token =
    /\b(Added|Removed)\b|\b(BIA|OCIJ|OCAHO)\s+(?:Operating Policies and Procedures Memorand(?:um|a)|OPPM)\b|\b(Policy Memorand(?:um|a)|Operating Policies and Procedures Memorand(?:um|a)|OPPMs?|Director[\u2019']s Memorand(?:um|a))\b|\b(\d{2})\s*-\s*(\d{1,3})\b(\s*\((?:Cancellation|Reinstatement|Amended)\))?/gi;
  for (const e of entries) {
    // "BIA Operating Policies and Procedures Memorandum (OPPM) 24-01": the parenthetical must not reopen the OPPM series.
    for (const clause of e.natureOfChange.replace(/\(OPPMs?\)/g, " ").split(";")) {
      let action: "added" | "removed" | null = null;
      let kind: "PM" | "OPPM" | null = null;
      for (const m of clause.matchAll(token)) {
        if (m[1]) action = m[1].toLowerCase() === "added" ? "added" : "removed";
        else if (m[2]) kind = null;
        else if (m[3]) kind = /^Policy/i.test(m[3]) ? "PM" : /^Operating|^OPPM/i.test(m[3]) ? "OPPM" : null;
        else if (m[4] && action && kind) {
          out.push({ kind, number: `${m[4]}-${m[5]}`, action, note: m[6] ? squash(m[6]).replace(/[()]/g, "") : null, entry: e });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Part V: policy memoranda and operating policies and procedures memoranda
// ---------------------------------------------------------------------------

export type MemoEntry = {
  kind: "PM" | "OPPM";
  /** "26-07", "97-2", as listed. */
  number: string;
  /** The title as listed, "(PDF)" left out. */
  title: string;
  url: string;
  /** The topic heading and accordion it is listed under (the topic page only). */
  topic: string | null;
};

const MEMO_NUMBER = /^(PM|OPPM)\s*(\d{2})\s*-\s*(\d{1,3})\b/i;

/**
 * One memoranda list page: "PM 26-07 (PDF) In-Office Adjudicator Voluntary
 * Transfer Policy", one link per memorandum. The title is the text after
 * the number, up to the next memorandum's link or the end of the
 * paragraph; on the topic page each entry is under an accordion whose
 * button names the topic, under an <h3> naming the topic group.
 */
export function parseMemoList(bodyHtml: string, pageUrl: string): { entries: MemoEntry[]; rowsSeen: number; notes: string[] } {
  const spans = anchorSpans(bodyHtml);
  const starts = spans.filter((a) => MEMO_NUMBER.test(a.text));
  const headings: { at: number; text: string; level: "group" | "topic" }[] = [];
  for (const h of bodyHtml.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/gi)) headings.push({ at: h.index ?? 0, text: squash(inlineText(h[1])), level: "group" });
  for (const b of bodyHtml.matchAll(/<button\b[^>]*class="[^"]*usa-accordion__button[^"]*"[^>]*>([\s\S]*?)<\/button\s*>/gi)) {
    headings.push({ at: b.index ?? 0, text: squash(inlineText(b[1])), level: "topic" });
  }
  headings.sort((a, b) => a.at - b.at);
  const entries: MemoEntry[] = [];
  const notes: string[] = [];
  starts.forEach((a, i) => {
    const m = MEMO_NUMBER.exec(a.text)!;
    const kind = m[1].toUpperCase() as "PM" | "OPPM";
    const number = `${m[2]}-${m[3]}`;
    const nextStart = i + 1 < starts.length ? starts[i + 1].start : bodyHtml.length;
    const paragraphEnd = bodyHtml.slice(a.end).search(/<\/p\s*>|<\/li\s*>|<h[1-6]\b/i);
    const end = Math.min(nextStart, paragraphEnd >= 0 ? a.end + paragraphEnd : bodyHtml.length);
    const after = squash(repairMojibake(inlineText(bodyHtml.slice(a.end, end))));
    const own = squash(a.text.slice(m[0].length));
    const title = squash(`${own} ${after}`)
      .replace(/^\(PDF\)\s*/i, "")
      .replace(/^[-:\s]+/, "")
      .trim();
    const url = resolveUrl(a.href, pageUrl);
    if (!url || !title) {
      notes.push(`A memorandum entry could not be read (${a.text}); it was left out.`);
      return;
    }
    let group: string | null = null;
    let topic: string | null = null;
    for (const h of headings) {
      if (h.at > a.start) break;
      if (h.level === "group") {
        group = h.text;
        topic = null;
      } else topic = h.text;
    }
    entries.push({ kind, number, title, url, topic: topic ? (group ? `${group} > ${topic}` : topic) : group });
  });
  return { entries, rowsSeen: starts.length, notes };
}

/** The year a memorandum number states ("97-3" gives 1997, "25-01" gives 2025). */
export function memoNumberYear(number: string): number | null {
  const yy = Number(/^(\d{2})-/.exec(number)?.[1]);
  if (!Number.isInteger(yy)) return null;
  return yy >= 50 ? 1900 + yy : 2000 + yy;
}

const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const LONG_DATE = `${MONTH}\\.?\\s+\\d{1,2},\\s+\\d{4}`;

export type MemoHeader = {
  /** The "Date:" line, or the first date at the head of the memorandum. */
  dateText: string | null;
  /** The "Effective:" line. */
  effectiveText: string | null;
  purpose: string | null;
  cancellation: string | null;
  owner: string | null;
  authority: string | null;
  /** The memorandum's SUBJECT line (older memoranda) or its title line (newer ones). */
  subject: string | null;
};

/**
 * A labelled header value: the rest of the label's line, plus following
 * lines only while they read as its continuation (starting lowercase, with
 * a parenthesis or a digit), so the body text after "CANCELLATION: None"
 * is not taken for part of it.
 */
function labelled(head: string, label: string, stop: string): string | null {
  // Case-sensitive: the labels are printed in capitals, and a continuation line starts lowercase.
  const m = new RegExp(`\\b${label}:[ \\t]*([^\\n]+(?:\\n(?=[ \\t]*[a-z(0-9])[^\\n]+){0,3})`).exec(head);
  if (!m) return null;
  const value = squash(m[1]);
  return value && !new RegExp(`^(?:${stop}):`, "i").test(value) ? value : null;
}

/**
 * The header of a memorandum's text (pdf.js output). Newer policy
 * memoranda print labelled lines (Effective, To, From, Date, PURPOSE,
 * OWNER, AUTHORITY, CANCELLATION); pdf.js sometimes reads the labels and
 * their values in separate runs, so a label with no value on its line is
 * left null. Older memoranda print a date line and a SUBJECT. Without a
 * "Date:" line, the first date before the SUBJECT or PURPOSE label is the
 * memorandum's; a date after those (in a footnote) never is.
 */
export function parseMemoHeader(text: string): MemoHeader {
  const head = text.slice(0, 4000);
  const stop = "PURPOSE|OWNER|AUTHORITY|CANCELLATION|To|From|Date|Effective|SUBJECT|MEMORANDUM";
  const date = new RegExp(`\\bDate:[ \\t]*(${LONG_DATE})`, "i").exec(head)?.[1] ?? null;
  const effective = new RegExp(`\\bEffective:[ \\t]*(${LONG_DATE})`, "i").exec(head)?.[1] ?? null;
  const headerEnd = head.search(/\bSUBJECT\b|\bPURPOSE:|\[Page 2\]/);
  const firstDate = headerEnd > 0 ? (new RegExp(LONG_DATE).exec(head.slice(0, headerEnd))?.[0] ?? null) : null;
  const subject = /\bSUBJECT:?[ \t]*([^\n]+(?:\n+(?![ \t]*(?:TABLE OF CONTENTS|Table of Contents|[IVX]+\.|\d+\.|[A-Z][A-Z ]{2,}:))[^\n]+){0,3})/.exec(head)?.[1];
  return {
    dateText: (date ?? firstDate)?.replace(/\s+/g, " ") ?? null,
    effectiveText: effective?.replace(/\s+/g, " ") ?? null,
    purpose: labelled(head, "PURPOSE", stop),
    cancellation: labelled(head, "CANCELLATION", stop),
    owner: labelled(head, "OWNER", stop),
    authority: labelled(head, "AUTHORITY", stop),
    subject: subject ? squash(subject) : null,
  };
}

// ---------------------------------------------------------------------------
// Forms & Fees
// ---------------------------------------------------------------------------

export type FormLink = { label: string; url: string };

export type FormEntry = {
  /** "EOIR-26", "EOIR-33/IC". */
  formNumber: string;
  /** The accordion heading as printed ("EOIR 26 - Notice of Appeal from a Decision of an Immigration Judge (IJ)"). */
  heading: string;
  /** The form's English PDF, as linked. */
  form: FormLink | null;
  /** English instructions linked under the form ("General Instructions", "English Language Instructions for ..."). */
  instructions: FormLink[];
  /** Other language versions linked under the form (not collected). */
  translations: FormLink[];
  /** The entry's text as printed (purpose, fees, filing, where to obtain it). */
  entryText: string;
  /** "(Revised Aug. 2022)" as printed next to the form link, without the parentheses. */
  revisedText: string | null;
};

const FORM_HEADING = /^(EOIR)[\s\u00a0-]*(\d{2}[A-Z]?(?:\/[A-Z]{2,3})?)\b/i;
const LANGUAGE_MARK = /\((?!PDF\))[^)]*\)|\u4e2d\u6587|Krey\u00f2l|Portugu\u00eas|Espa\u00f1ol|\u0a2a\u0a70\u0a1c\u0a3e\u0a2c\u0a40|P\u0443\u0441\u0441\u043a\u0438\u0439|\u0420\u0443\u0441\u0441\u043a\u0438\u0439|Spanish|Chinese|Haitian|Punjabi|Russian|Portuguese/i;

/** The EOIR forms on the Forms & Fees page, one accordion each; USCIS forms the page also lists are left out. */
export function parseFormsPage(bodyHtml: string, pageUrl: string): { entries: FormEntry[]; accordions: number; notes: string[] } {
  const blocks = bodyHtml.split(/<div\b[^>]*class="[^"]*\busa-accordion\b[^"]*"[^>]*>/i).slice(1);
  const entries: FormEntry[] = [];
  const notes: string[] = [];
  for (const block of blocks) {
    const button = /<button\b[^>]*>([\s\S]*?)<\/button\s*>/i.exec(block);
    if (!button) continue;
    const heading = squash(repairMojibake(inlineText(button[1])));
    const fm = FORM_HEADING.exec(heading);
    if (!fm) continue;
    const formNumber = `EOIR-${fm[2].toUpperCase()}`;
    const content = block.slice((button.index ?? 0) + button[0].length);
    const wanted = squash(`EOIR ${fm[2]}`).toUpperCase();
    let form: FormLink | null = null;
    const instructions: FormLink[] = [];
    const translations: FormLink[] = [];
    for (const a of anchors(content)) {
      const label = squash(repairMojibake(a.text));
      const url = resolveUrl(a.href, pageUrl);
      if (!url || !/^https:\/\/(www\.)?justice\.gov\//i.test(url)) continue;
      const bare = label.replace(/^FORM\s+/i, "").replace(/\s*\(PDF\)\s*$/i, "").toUpperCase();
      if (bare === wanted) {
        if (!form) form = { label, url };
      } else if (/instructions/i.test(label) && /^(General Instructions|English Language Instructions)\b/i.test(label)) {
        instructions.push({ label, url });
      } else if (bare.startsWith(wanted) && LANGUAGE_MARK.test(label)) {
        translations.push({ label, url });
      } else if (LANGUAGE_MARK.test(label) && /\/dl\b|\.pdf$/i.test(url) && !/instructions/i.test(label)) {
        translations.push({ label, url });
      } else if (/\/dl\b|\.pdf$/i.test(url) && /instruc|instrucciones|instru\u00e7\u00f5es|\u8aaa\u660e|\u8bf4\u660e|enstriksyon/i.test(label)) {
        translations.push({ label, url });
      }
    }
    const lines = repairMojibake(htmlToText(content))
      .split("\n")
      .map(squash)
      .filter((line) => line && !/^_{5,}$/.test(line));
    // The revision EOIR prints next to the form's own link ("EOIR 26A (PDF) (Revised Aug. 2022)").
    const formLine = lines.find((line) => line.replace(/^FORM\s+/i, "").toUpperCase().startsWith(wanted)) ?? lines.join(" ");
    const revisedText = /\((Revised[^)]*)\)/i.exec(formLine)?.[1].replace(/\s+/g, " ").trim() ?? null;
    // The link lines (the form, the translations) are kept as links in the metadata, not in the summary.
    const entryText = lines.filter((line) => !/\(PDF\)\s*(?:\((?:Revised|Rev\.)[^)]*\))?$/i.test(line)).join("\n");
    if (!form) notes.push(`${heading}: no link to the English form was found; it was left out.`);
    else entries.push({ formNumber, heading, form, instructions, translations, entryText, revisedText });
  }
  return { entries, accordions: blocks.length, notes };
}

/** The first link on a page whose text matches; null when none does. */
export function findLink(bodyHtml: string, pageUrl: string, text: RegExp): FormLink | null {
  for (const a of anchors(bodyHtml)) {
    const label = squash(a.text);
    if (text.test(label)) {
      const url = resolveUrl(a.href, pageUrl);
      if (url) return { label, url };
    }
  }
  return null;
}

export type FormHeader = {
  /** "Rev. Mar. 2026", "Revised Nov. 2016", as printed on the form. */
  revision: string | null;
  /** "1125-0002". */
  omb: string | null;
  /** "12/31/2028". */
  expires: string | null;
};

/** The edition, OMB number and expiration the first page of a form prints. */
export function parseFormHeader(text: string): FormHeader {
  const head = text.slice(0, 3000);
  const revision = /\b(Rev(?:ised|\.)\s*(?:[A-Z][a-z]{2,8}\.?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}\/\d{4}))/.exec(head)?.[1] ?? null;
  const omb = /OMB\s*#?\s*(?:No\.?\s*)?([0-9l]{4}-\d{4})/i.exec(head)?.[1]?.replace(/l/g, "1") ?? null;
  const expires = /\bExp(?:ires|\.)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(head)?.[1] ?? null;
  return { revision: revision ? squash(revision) : null, omb, expires };
}

/** The year in a revision line ("Rev. Mar. 2026" gives 2026); null when none. */
export function revisionYear(revision: string | null): number | null {
  const m = /\b(19|20)(\d{2})\b/.exec(revision ?? "");
  return m ? Number(m[1] + m[2]) : null;
}

// ---------------------------------------------------------------------------
// Immigration court directory
// ---------------------------------------------------------------------------

export type CourtEntry = { courtName: string; url: string; state: string | null };

/**
 * The State-Based Immigration Court Directory on "Find an Immigration Court
 * and Access Internet-Based Hearings": an <h2> per state, an <h3> linking
 * each court's page, then that court's judges.
 */
export function parseCourtDirectory(bodyHtml: string, pageUrl: string): { courts: CourtEntry[]; notes: string[] } {
  const marks: { at: number; kind: "state" | "court"; html: string }[] = [];
  for (const h of bodyHtml.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/gi)) marks.push({ at: h.index ?? 0, kind: "state", html: h[1] });
  for (const h of bodyHtml.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/gi)) marks.push({ at: h.index ?? 0, kind: "court", html: h[1] });
  marks.sort((a, b) => a.at - b.at);
  const courts: CourtEntry[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  let state: string | null = null;
  for (const mark of marks) {
    if (mark.kind === "state") {
      state = squash(inlineText(mark.html)) || null;
      continue;
    }
    const link = anchors(mark.html)[0];
    if (!link) continue;
    const url = resolveUrl(link.href.trim(), pageUrl);
    const courtName = squash(repairMojibake(link.text));
    if (!url || !courtName || !/Immigration Court/i.test(courtName)) {
      if (courtName) notes.push(`A directory heading could not be read as a court (${courtName}); it was left out.`);
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    courts.push({ courtName, url, state });
  }
  return { courts, notes };
}
