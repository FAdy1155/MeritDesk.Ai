import type { ListingParse, ParsedItem } from "../types";
import { parseStatedDate } from "./dates";
import { anchors, htmlToText, inlineText, justiceGovBody, justiceGovUpdatedLine, resolveUrl, tableRows } from "./html";

// Parsers for the justice.gov (EOIR) pages sources.md sections 1-5 name.
// Each returns the items exactly as the page lists them; the collector
// fetches the pages and drops any item whose link is off the source's hosts.

/** sources.md section 1: the volumes in the AG/BIA Precedent Decisions table, highest first. */
export function parseAgBiaIndex(html: string, pageUrl: string): { volume: number; url: string; label: string }[] {
  const body = justiceGovBody(html) ?? html;
  const seen = new Map<number, { volume: number; url: string; label: string }>();
  for (const a of anchors(body)) {
    const m = /\/eoir\/volume-(\d+)\b/.exec(a.href);
    const label = /^Volume\s+(\d+)/i.exec(a.text);
    if (!m || !label || m[1] !== label[1]) continue;
    const url = resolveUrl(a.href, pageUrl);
    if (url && !seen.has(+m[1])) seen.set(+m[1], { volume: +m[1], url, label: a.text });
  }
  return [...seen.values()].sort((x, y) => y.volume - x.volume);
}

// The period after "Dec" is sometimes missing on the page ("29 I&N Dec 621").
const INTERIM_DECISION_CITATION = /\d+\s+I&N\s+Dec\.?\s+\d+\s+\([^)]*\d{4}\)/;

/**
 * A volume page (sources.md section 1): one entry per decision, separated by
 * rules, each a table row (name, citation, "ID nnnn" link to the PDF)
 * followed by the official headnote paragraphs. The headnote is the quoted
 * text; the page lists no per-decision date, so none is stored.
 */
export function parseVolumePage(html: string, pageUrl: string): ListingParse & { pageUpdated: string | null } {
  const body = justiceGovBody(html);
  const pageUpdated = justiceGovUpdatedLine(html);
  if (!body) return { items: [], rowsSeen: 0, recognized: false, notes: ["The page has no body field."], indexText: "", pageUpdated };
  const items: ParsedItem[] = [];
  const notes: string[] = [];
  let rowsSeen = 0;
  for (const block of body.split(/<hr\b[^>]*>/i)) {
    const tableEnd = block.search(/<\/table\s*>/i);
    if (tableEnd < 0) continue;
    rowsSeen++;
    const head = block.slice(0, tableEnd);
    const firstCell = /<td\b[^>]*>([\s\S]*?)<\/td\s*>/i.exec(head);
    const cellText = firstCell ? inlineText(firstCell[1]) : "";
    const strong = /<strong\b[^>]*>([\s\S]*?)<\/strong\s*>/i.exec(head);
    const citation = INTERIM_DECISION_CITATION.exec(cellText)?.[0].replace(/\s+/g, " ") ?? null;
    const idLink = anchors(head).find((a) => /^ID\s*#?\s*\d+$/i.test(a.text));
    const idNumber = idLink ? /\d+/.exec(idLink.text)?.[0] : undefined;
    const url = idLink ? resolveUrl(idLink.href, pageUrl) : null;
    const name = strong ? inlineText(strong[1]).replace(/,\s*$/, "") : cellText.split(",")[0]?.trim();
    if (!idNumber || !url || !name || !citation) {
      notes.push(`A volume entry could not be read (${cellText.slice(0, 80) || "no caption"}); it was left out.`);
      continue;
    }
    const headnote = htmlToText(block.slice(tableEnd));
    const itemType = /\(A\.\s?G\.?\s|\(AG\s|Att'y Gen/i.test(citation)
      ? "AG precedent"
      : /\(AAO\b/i.test(citation)
        ? "AAO precedent"
        : "BIA precedent";
    items.push({
      externalId: `ID ${idNumber}`,
      crossSourceKey: `intdec:${idNumber}`,
      itemType,
      title: name,
      citation: `${citation}, ID ${idNumber}`,
      officialUrl: url,
      documentUrl: null,
      publishedDateText: null,
      publishedOn: null,
      excerpt: [`${name}, ${citation}, ID ${idNumber}`, headnote].filter(Boolean).join("\n"),
      listingFacts: pageUpdated ? { volumePage: pageUrl, volumePageUpdated: pageUpdated } : { volumePage: pageUrl },
    });
  }
  return { items, rowsSeen, recognized: rowsSeen > 0, notes, indexText: htmlToText(body), pageUpdated };
}

/**
 * Interim Decision numbers missing between the lowest and highest on the
 * page. sources.md: AAO decisions share the numbering but are not listed on
 * the volume page, so a gap is reported for the attorney, never filled in.
 */
export function interimDecisionGaps(ids: readonly number[]): number[] {
  if (ids.length < 2) return [];
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const present = new Set(sorted);
  const gaps: number[] = [];
  for (let n = sorted[0] + 1; n < sorted[sorted.length - 1]; n++) if (!present.has(n)) gaps.push(n);
  return gaps;
}

// sources.md section 2: "Open the PDF only when the title suggests a change
// to filing, hearings, motions, appeals, fees, asylum procedure,
// representation or the use of generative AI", and "Memos that cancel older
// memos count. Say which memo was cancelled."
const MEMO_READ_TITLE =
  /\b(?:fil(?:e|es|ed|ing|ings)|hearings?|motions?|appeal(?:s|ed|ing)?|fees?|asylum|represent\w*|generative|artificial intelligence|cancel\w*|withdraw\w*|rescind\w*|rescission|supersed\w*|deadlines?)\b/i;

export function memoNeedsDocument(title: string): boolean {
  return MEMO_READ_TITLE.test(title);
}

/** sources.md section 2: "PM 26-07 (PDF) Title", one paragraph per memo. */
export function parsePolicyMemoranda(html: string, pageUrl: string): ListingParse {
  const body = justiceGovBody(html);
  if (!body) return { items: [], rowsSeen: 0, recognized: false, notes: ["The page has no body field."], indexText: "" };
  const items: ParsedItem[] = [];
  const notes: string[] = [];
  let rowsSeen = 0;
  for (const p of body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)) {
    const link = anchors(p[1]).find((a) => /^PM\s*\d{2}\s*-\s*\d{2,3}\b/i.test(a.text));
    if (!link) continue;
    rowsSeen++;
    const numbers = /(\d{2})\s*-\s*(\d{2,3})/.exec(link.text);
    const url = resolveUrl(link.href, pageUrl);
    if (!numbers || !url) {
      notes.push(`A memorandum entry could not be read (${link.text}); it was left out.`);
      continue;
    }
    const memo = `PM ${numbers[1]}-${numbers[2]}`;
    const line = inlineText(p[1]);
    const title = line.replace(link.text, "").replace(/^\s*\(PDF\)\s*/i, "").trim();
    items.push({
      externalId: memo,
      itemType: "Policy memorandum",
      title: title ? `${memo}, ${title}` : memo,
      citation: memo,
      officialUrl: url,
      documentUrl: memoNeedsDocument(title) ? url : null,
      publishedDateText: null,
      publishedOn: null,
      excerpt: line,
    });
  }
  return { items, rowsSeen, recognized: rowsSeen > 0, notes, indexText: htmlToText(body) };
}

/**
 * sources.md section 3: a practice manual landing page's "Updated <date>"
 * line. A new date is the item; the changed chapters themselves come from
 * the Policy Manual's table of changes (parsePolicyManualChanges).
 */
export function parseManualLanding(html: string, pageUrl: string, manualLabel: string): ListingParse {
  const body = justiceGovBody(html);
  const text = body ? htmlToText(body) : "";
  const m = /Updated\s+([A-Z][a-z]+\.?\s+\d{1,2},\s+\d{4})/.exec(text);
  if (!m) return { items: [], rowsSeen: 0, recognized: false, notes: ['No "Updated" line was found on the landing page.'], indexText: text };
  const date = m[1].replace(/\s+/g, " ");
  return {
    items: [
      {
        externalId: `updated:${date}`,
        itemType: "Practice Manual",
        title: manualLabel,
        citation: null,
        officialUrl: pageUrl,
        documentUrl: null,
        publishedDateText: date,
        publishedOn: parseStatedDate(date),
        excerpt: `Updated ${date}`,
      },
    ],
    rowsSeen: 1,
    recognized: true,
    notes: [],
    indexText: text,
  };
}

/** The EOIR Policy Manual's Appendix O: Section Amended | Date of Change | Nature of Change. */
export function parsePolicyManualChanges(html: string, pageUrl: string): ListingParse {
  const body = justiceGovBody(html);
  if (!body) return { items: [], rowsSeen: 0, recognized: false, notes: ["The page has no body field."], indexText: "" };
  const items: ParsedItem[] = [];
  const notes: string[] = [];
  let rowsSeen = 0;
  for (const cells of tableRows(body)) {
    if (cells.length !== 3) continue;
    const section = inlineText(cells[0]);
    const dateText = inlineText(cells[1]);
    const nature = htmlToText(cells[2]).split("\n").join("; ");
    if (/^Section Amended$/i.test(section)) continue;
    rowsSeen++;
    if (!section || !dateText || !nature) {
      notes.push("A table of changes row with an empty cell was left out.");
      continue;
    }
    items.push({
      externalId: `${section} | ${dateText} | ${nature}`,
      itemType: "Practice Manual",
      title: `${section}: ${nature}`,
      citation: null,
      officialUrl: pageUrl,
      documentUrl: null,
      publishedDateText: dateText,
      publishedOn: parseStatedDate(dateText),
      excerpt: `Section Amended: ${section}\nDate of Change: ${dateText}\nNature of Change: ${nature}`,
    });
  }
  return { items, rowsSeen, recognized: rowsSeen > 0, notes, indexText: htmlToText(body) };
}

// sources.md section 4: "Skip judge investiture announcements unless they
// concern the Houston court."
const JUDGE_ANNOUNCEMENT = /\bImmigration Judges?\b|Biographical Information|\binvestiture\b/i;

/**
 * sources.md section 4: paragraphs of "Weekday, Month D, YYYY" (when a new
 * date starts), the kind ("Press Release", "Notice") and the linked title.
 * A paragraph without a date line shares the date above it.
 */
export function parseEoirNotices(html: string, pageUrl: string): ListingParse {
  const body = justiceGovBody(html);
  if (!body) return { items: [], rowsSeen: 0, recognized: false, notes: ["The page has no body field."], indexText: "" };
  const items: ParsedItem[] = [];
  let rowsSeen = 0;
  let judgeAnnouncements = 0;
  let currentDate: string | null = null;
  for (const p of body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)) {
    const link = anchors(p[1])[0];
    if (!link) continue;
    const lines = htmlToText(p[1].slice(0, link.index)).split("\n").filter(Boolean);
    if (lines.length && /\b\d{4}\b/.test(lines[0]) && parseStatedDate(lines[0])) currentDate = lines.shift() ?? null;
    const kind = lines.join(" ").trim();
    const url = resolveUrl(link.href, pageUrl);
    if (!url || !link.text) continue;
    rowsSeen++;
    if (JUDGE_ANNOUNCEMENT.test(link.text) && !/Houston/i.test(link.text)) {
      judgeAnnouncements++;
      continue;
    }
    const path = new URL(url).pathname.replace(/\/dl$/, "");
    const isMediaDownload = /\/media\/\d+\/dl$/.test(new URL(url).pathname);
    items.push({
      externalId: path,
      itemType: "EOIR notice",
      title: link.text,
      citation: null,
      officialUrl: url,
      documentUrl: isMediaDownload ? url : null,
      publishedDateText: currentDate,
      publishedOn: parseStatedDate(currentDate),
      excerpt: [currentDate, kind, link.text].filter(Boolean).join("\n"),
      listingFacts: kind ? { kind } : undefined,
    });
  }
  const notes = judgeAnnouncements
    ? [`${judgeAnnouncements} judge announcement(s) not about the Houston court were skipped, as sources.md directs.`]
    : [];
  return { items, rowsSeen, recognized: rowsSeen > 0, notes, indexText: htmlToText(body) };
}

/** sources.md section 5: the year pages to read (the prior year's too in January). */
export function eoirFederalRegisterPageUrls(now: Date): string[] {
  const year = now.getUTCFullYear();
  const urls = [`https://www.justice.gov/eoir/federal-register-notices-${year}`];
  if (now.getUTCMonth() === 0) urls.push(`https://www.justice.gov/eoir/federal-register-notices-${year - 1}`);
  return urls;
}

/**
 * sources.md section 5: Date | Title table rows, the date linked to the
 * govinfo PDF and the second cell holding the summary EOIR prints (with its
 * DATES line). The page gives no separate title, so the item is named by
 * its Federal Register document number.
 */
export function parseEoirFederalRegisterPage(html: string, pageUrl: string): ListingParse {
  const body = justiceGovBody(html);
  if (!body) return { items: [], rowsSeen: 0, recognized: false, notes: ["The page has no body field."], indexText: "" };
  const items: ParsedItem[] = [];
  const notes: string[] = [];
  let rowsSeen = 0;
  for (const cells of tableRows(body)) {
    if (cells.length < 2) continue;
    const link = anchors(cells[0])[0];
    if (!link) continue;
    rowsSeen++;
    const url = resolveUrl(link.href, pageUrl);
    const docNumber = url ? /\/pdf\/([^/]+?)\.pdf$/i.exec(new URL(url).pathname)?.[1] : undefined;
    const pkg = url ? /\/pkg\/(FR-\d{4}-\d{2}-\d{2})\//.exec(url)?.[1] : undefined;
    const summary = inlineText(cells[1]);
    if (!url || !docNumber || !summary) {
      notes.push(`A Federal Register row could not be read (${link.text}); it was left out.`);
      continue;
    }
    items.push({
      externalId: docNumber,
      crossSourceKey: `fr:${docNumber}`,
      itemType: "Federal Register",
      title: `FR Doc. ${docNumber}`,
      citation: `FR Doc. ${docNumber}`,
      officialUrl: url,
      documentUrl: null,
      publishedDateText: link.text,
      publishedOn: parseStatedDate(link.text),
      excerpt: summary,
      listingFacts: pkg ? { govinfoPackage: pkg } : undefined,
    });
  }
  return { items, rowsSeen, recognized: rowsSeen > 0, notes, indexText: htmlToText(body) };
}
