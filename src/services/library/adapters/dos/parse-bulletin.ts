import { htmlToText, inlineText, resolveUrl } from "../../extract/html";
import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { collapse, dropOffscreenBlocks, htmlTables, monthNumber, sliceFrom, statedMonth, travelLinks, travelMainCopy, type HtmlTable } from "./parse";

// Pure parsers for the Visa Bulletin (travel.state.gov) and for the USCIS
// page naming the Visa Bulletin chart to use for adjustment of status each
// month (www.uscis.gov). Both print the same kind of chart: a row per
// preference category, a column per chargeability area, each cell a cut-off
// date ("01FEB20"), "C" (current) or "U" (unauthorized). The charts are read
// into rows exactly as stated; a cell's date is given as YYYY-MM-DD only
// when it parses, its two-digit year read in the bulletin's own century
// (no stated priority date is later than the bulletin).

export type ChartKind = "final_action_dates" | "dates_for_filing" | "cut_off_dates";
export type PreferenceCategory = "family" | "employment";

export type PriorityDateRow = {
  /** Which chart: final action dates, dates for filing, or (bulletins before October 2015, which print one chart per category) cut-off dates. */
  chart: ChartKind;
  category: PreferenceCategory;
  /** The row as stated: "F1", "F2A", "2nd", "Other Workers", "5th Unreserved (including C5, T5, I5, R5)". */
  preference: string;
  /** The column as stated: "All Chargeability Areas Except Those Listed", "INDIA". */
  chargeability: string;
  /** The cell as stated: "01FEB20", "C", "U". */
  stated: string;
  status: "date" | "current" | "unavailable" | "other";
  /** YYYY-MM-DD when the cell is a date. */
  date: string | null;
};

export type DiversityRow = {
  /** The month the cut-offs apply to, as the heading above them names it ("June", "July"); null when it does not. */
  appliesTo: string | null;
  region: string;
  /** The rank cut-off as stated ("55,000", "CURRENT"). */
  stated: string;
  /** The exceptions as stated ("Except: Algeria 37,000 Egypt 30,000"). */
  exceptions: string | null;
};

export type ChartTable = { chart: ChartKind; category: PreferenceCategory; label: string | null; columns: string[]; rows: PriorityDateRow[] };

const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** One chart cell: "01FEB20" with the bulletin's year 2026 is 2020-02-01; "C" current; "U" unauthorized. */
export function readChartCell(stated: string, bulletinYear: number | null): Pick<PriorityDateRow, "status" | "date"> {
  const s = stated.trim();
  if (/^C(?![A-Za-z])/.test(s) || /^current\b/i.test(s)) return { status: "current", date: null };
  if (/^U(?![A-Za-z])/.test(s) || /^unauthori[sz]ed\b|^unavailable\b/i.test(s)) return { status: "unavailable", date: null };
  const m = /^(\d{1,2})\s*-?\s*([A-Za-z]{3})\s*-?\s*(\d{4}|\d{2})(?!\d)/.exec(s);
  if (!m) return { status: "other", date: null };
  const month = MONTH_ABBR.indexOf(m[2].toUpperCase()) + 1;
  if (month === 0) return { status: "other", date: null };
  let year: number;
  if (m[3].length === 4) year = Number(m[3]);
  else if (bulletinYear !== null) {
    const yy = Number(m[3]);
    year = 2000 + yy <= bulletinYear + 1 ? 2000 + yy : 1900 + yy;
  } else return { status: "date", date: null };
  const day = Number(m[1]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return { status: "date", date: null };
  return { status: "date", date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
}

const AREA_HEADER = /chargeability|\bindia\b|\bmexico\b|\bphilippines\b|\bchina\b/i;
const REGION = /^(AFRICA|ASIA|EUROPE|NORTH AMERICA|OCEANIA|SOUTH AMERICA)/i;

function lastMatch(text: string, pattern: RegExp): RegExpExecArray | null {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let last: RegExpExecArray | null = null;
  for (let m = global.exec(text); m; m = global.exec(text)) last = m;
  return last;
}

/** Which chart a table is, from its caption or the words between it and the table before it. */
function chartKindOf(label: string): ChartKind | null {
  const m = lastMatch(label, /final action dates?|dates? for filing/i);
  if (!m) return null;
  return /final/i.test(m[0]) ? "final_action_dates" : "dates_for_filing";
}

/**
 * Reads every preference chart and diversity table in a fragment. `context`
 * for each table is its caption, else the text between the previous table
 * and it (the bulletin's lettered heading and explanation).
 */
export function readCharts(fragment: string, bulletinYear: number | null): { charts: ChartTable[]; diversity: DiversityRow[] } {
  const html = dropOffscreenBlocks(fragment);
  const tables = htmlTables(html);
  const charts: ChartTable[] = [];
  const diversity: DiversityRow[] = [];
  const used = new Set<HtmlTable>();
  const withText = tables.filter((t) => t.rows.some((r) => r.some((c) => c)));
  for (const table of tables) {
    // The words since the last table (with any text) that closed before this one opened.
    const previousEnd = withText.reduce((end, t) => (t.end <= table.start && t.end > end ? t.end : end), 0);
    const context = htmlToText(html.slice(previousEnd, table.start));
    const label = table.caption ?? context;
    const rows = table.rows.filter((r) => r.some((c) => c));
    const regionRows = rows.filter((r) => r.length >= 2 && REGION.test(r[0] ?? ""));
    const headerAt = regionRows.length ? -1 : rows.findIndex((r) => r.length >= 3 && r.slice(1).some((c) => AREA_HEADER.test(c)));
    if (headerAt >= 0) {
      const header = rows[headerAt];
      const firstColumn = rows.map((r) => r[0] ?? "").slice(0, headerAt + 2).join(" ");
      const categoryWord =
        /family/i.test(firstColumn) ? "family" : /employment/i.test(firstColumn) ? "employment" : lastMatch(label, /family|employment/i)?.[0];
      if (!categoryWord) continue;
      const category: PreferenceCategory = /family/i.test(categoryWord) ? "family" : "employment";
      const chart = chartKindOf(table.caption ?? "") ?? chartKindOf(context) ?? "cut_off_dates";
      const columns = header.slice(1).map(collapse);
      const out: PriorityDateRow[] = [];
      for (const row of rows.slice(headerAt + 1)) {
        const preference = collapse(row[0] ?? "");
        const values = row.slice(1);
        if (!preference || values.every((v) => !v)) continue;
        if (row.length < 2 || /^(\*|note\b)/i.test(preference)) continue;
        values.forEach((value, i) => {
          const stated = collapse(value);
          if (!stated) return;
          out.push({ chart, category, preference, chargeability: columns[i] ?? `column ${i + 2}`, stated, ...readChartCell(stated, bulletinYear) });
        });
      }
      if (out.length) {
        charts.push({ chart, category, label: table.caption ?? chartHeading(context, category), columns, rows: out });
        used.add(table);
      }
      continue;
    }
    // Diversity visa rank cut-offs: a row per region (newer bulletins), or one cell of "REGION: XX 6,000" lines (older ones).
    if (table.depth > 0 && tables.some((t) => used.has(t) && t.start < table.start && t.end > table.end)) continue;
    const appliesTo = lastMatch(context, /(?:for the month of|which will apply in)\s+([A-Za-z]+)/i)?.[1] ?? null;
    const appliesMonth = appliesTo && monthNumber(appliesTo) ? appliesTo[0].toUpperCase() + appliesTo.slice(1).toLowerCase() : null;
    if (regionRows.length) {
      for (const r of regionRows) {
        // Some older bulletins (March 2005, for one) put the region's two-letter code ("AF") in a column of its own before the cut-off.
        const cells = r.length >= 3 && /^[A-Z]{2}$/.test(collapse(r[1])) && /\d|CURRENT|^C$/i.test(collapse(r[2])) ? [r[0], ...r.slice(2)] : r;
        diversity.push({ appliesTo: appliesMonth, region: collapse(cells[0]), stated: collapse(cells[1]), exceptions: cells[2] ? collapse(cells[2]) || null : null });
      }
      used.add(table);
      continue;
    }
    if (rows.length && rows.every((r) => r.length <= 2)) {
      const lines = htmlToText(html.slice(table.start, table.end)).split("\n");
      const before = diversity.length;
      for (const line of lines) {
        const m = /^(AFRICA|ASIA|EUROPE|NORTH AMERICA(?:\s*\([^)]*\))?|OCEANIA|SOUTH AMERICA,?(?:\s+and the CARIBBEAN)?)\s*:?\s*(?:[A-Z]{2}\s+)?([\d,]+|CURRENT|C)\b\s*(.*)$/i.exec(line.trim());
        if (m) diversity.push({ appliesTo: appliesMonth, region: collapse(m[1]), stated: m[2], exceptions: m[3].trim() || null });
      }
      if (diversity.length > before) used.add(table);
    }
  }
  return { charts, diversity: dedupeDiversity(diversity) };
}

function dedupeDiversity(rows: DiversityRow[]): DiversityRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.appliesTo}|${r.region}|${r.stated}|${r.exceptions}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The heading the chart sits under, for its label: the last line of the
 * context that reads as a heading (all capitals, lettered, or naming a
 * chart) and names this chart's category or kind, not another one (older
 * bulletins print both preference lists before both charts). Null when none.
 */
function chartHeading(context: string, category: PreferenceCategory): string | null {
  const other = category === "family" ? /employment/i : /family/i;
  const own = category === "family" ? /family/i : /employment/i;
  const lines = context.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.length > 200) continue;
    const headingLike = /^[A-Z]\.\s+\S/.test(line) || (line === line.toUpperCase() && /[A-Z]{4}/.test(line)) || /priority dates for|final action dates|dates for filing/i.test(line);
    if (!headingLike) continue;
    if (other.test(line) && !own.test(line)) return null;
    if (own.test(line) || /final action dates|dates for filing|priority dates|cut-?off dates/i.test(line)) return line;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The Visa Bulletin index and bulletins (travel.state.gov)

export type BulletinLink = {
  url: string;
  /** The fiscal-year folder the page is filed in ("2026") and its page name ("visa-bulletin-for-june-2026"). */
  folder: string;
  slug: string;
  title: string;
  listedAs: "current" | "upcoming" | "archive";
};

/** A bulletin page's path: group 1 its fiscal-year folder, group 2 its page name. */
export const BULLETIN_PATH = /\/visa-bulletin\/(\d{4})\/([\w.-]+)\.html$/i;

/**
 * The bulletins the Visa Bulletin page links: the current and upcoming
 * bulletin boxes, then the fiscal-year lists, newest first as the page
 * orders them, each once.
 */
export function parseBulletinIndex(html: string, pageUrl: string): { recognized: boolean; links: BulletinLink[] } {
  const main = travelMainCopy(html);
  if (!main) return { recognized: false, links: [] };
  const out: BulletinLink[] = [];
  const seen = new Map<string, BulletinLink>();
  const add = (url: string, title: string, listedAs: BulletinLink["listedAs"]) => {
    const path = BULLETIN_PATH.exec(new URL(url).pathname);
    if (!path) return;
    const existing = seen.get(url);
    if (existing) {
      // The boxes label the link "June 2026"; the fiscal-year list gives the full title.
      if (listedAs === "archive" && existing.title.length < title.length) existing.title = title;
      return;
    }
    const link: BulletinLink = { url, folder: path[1], slug: path[2], title, listedAs };
    seen.set(url, link);
    out.push(link);
  };
  const boxes = sliceFrom(main, 'id="recent_bulletins"', ["</ul>"], "<ul");
  if (boxes) {
    for (const li of boxes.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
      const heading = inlineText(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(li[1])?.[1] ?? "");
      for (const link of travelLinks(li[1], pageUrl, BULLETIN_PATH)) {
        add(link.url, link.title || link.text, /upcoming/i.test(heading) ? "upcoming" : "current");
      }
    }
  }
  for (const link of travelLinks(main, pageUrl, BULLETIN_PATH)) add(link.url, link.text || link.title || "", "archive");
  return { recognized: out.length > 0, links: out };
}

export type Bulletin = {
  title: string | null;
  number: string | null;
  volume: string | null;
  publication: string | null;
  /** The "CA/VO: May 4, 2026" line's date as stated. */
  issuedText: string | null;
  revisedText: string | null;
  pdfUrl: string | null;
  month: { key: string; label: string; year: number } | null;
  charts: ChartTable[];
  diversity: DiversityRow[];
  /** The bulletin's body for the document text (hidden blocks removed). */
  bodyHtml: string;
};

/** One bulletin page; null when the page has no main copy. */
export function parseBulletin(html: string, pageUrl: string): Bulletin | null {
  const main = travelMainCopy(html);
  if (!main) return null;
  const bodyHtml = dropOffscreenBlocks(main);
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(main)?.[1];
  const title = h1 ? inlineText(h1) || null : null;
  const text = htmlToText(bodyHtml);
  const month = statedMonth(title ?? "");
  const head = text.slice(0, 800);
  const pdfHref = /<a\b[^>]*href=["']([^"']+\.pdf)["'][^>]*>[^<]*printer friendly/i.exec(bodyHtml)?.[1] ?? null;
  const pdfUrl = pdfHref ? resolveUrl(pdfHref, pageUrl) : null;
  const issued = lastMatch(text, /CA\/VO\s*:\s*([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/);
  const { charts, diversity } = readCharts(bodyHtml, month?.year ?? (issued ? Number(issued[1].slice(-4)) : null));
  return {
    title,
    number: /\bNumber\s+(\d+)\b/.exec(head)?.[1] ?? null,
    volume: /\bVolume\s+([IVXLC]+)\b/.exec(head)?.[1] ?? null,
    publication: /Department of State Publication\s+(\d+)/.exec(text)?.[1] ?? null,
    issuedText: issued ? collapse(issued[1]) : null,
    revisedText: /\bRevised\s+([A-Z][a-z]+\.?\s+\d{1,2},\s+\d{4})/.exec(head)?.[1] ?? null,
    pdfUrl: pdfUrl && new URL(pdfUrl).hostname === "travel.state.gov" && pdfUrl.startsWith("https:") ? pdfUrl : null,
    month: month ? { key: month.key, label: month.label, year: month.year } : null,
    charts,
    diversity,
    bodyHtml,
  };
}

// ---------------------------------------------------------------------------
// USCIS: Adjustment of Status Filing Charts from the Visa Bulletin

export type ChartsMonthLink = {
  /** YYYY-MM of the month the charts are for. */
  month: string;
  label: string;
  /** The link as resolved; its host may be one the collector does not read (the page once linked a month to an editing host). */
  url: string;
  section: "current" | "next" | "previous";
};

/**
 * The page body of a www.uscis.gov article: the body field inside <main> (the
 * header and footer blocks use the same field class) to the "Last
 * Reviewed/Updated" block.
 */
export function uscisBody(html: string): string | null {
  const main = html.search(/<main\b/i);
  if (main < 0) return null;
  return sliceFrom(html.slice(main), "field--name-body", ['<div class="reviewed-date', "</article>", "</main>"]);
}

/** The "Last Reviewed/Updated" date of a www.uscis.gov page as printed ("09/29/2026"). */
export function uscisReviewedText(html: string): string | null {
  const block = sliceFrom(html, 'class="reviewed-date', ["</article>"]);
  const m = block ? /<time\b[^>]*>([^<]+)<\/time>/i.exec(block) : null;
  return m ? m[1].trim() : null;
}

/**
 * The months the USCIS filing-charts page links: this month's charts, next
 * month's when posted, and the previous months by year; plus the page's own
 * statements of which chart applies this month.
 */
export function parseChartsIndex(html: string, pageUrl: string): { recognized: boolean; months: ChartsMonthLink[]; currentStatements: string[] } {
  const body = uscisBody(html);
  if (!body) return { recognized: false, months: [], currentStatements: [] };
  const sections = body.split(/<h2\b[^>]*>/i).slice(1);
  const months: ChartsMonthLink[] = [];
  const seen = new Set<string>();
  const currentStatements: string[] = [];
  let sawPrevious = false;
  for (const section of sections) {
    const heading = inlineText(section.slice(0, section.search(/<\/h2>/i)));
    const kind: ChartsMonthLink["section"] | null = /^current month/i.test(heading)
      ? "current"
      : /^next month/i.test(heading)
        ? "next"
        : /^previous/i.test(heading)
          ? "previous"
          : null;
    if (!kind) continue;
    if (kind === "previous") sawPrevious = true;
    const content = section.slice(section.search(/<\/h2>/i) + 5);
    if (kind === "current") {
      for (const p of content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
        const line = inlineText(p[1].replace(/<br\s*\/?>/gi, " "));
        if (/chart/i.test(line)) currentStatements.push(line);
      }
    }
    for (const a of content.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const text = inlineText(a[2]);
      // Previous months are linked by their name ("January 2026"); this and next month by "USCIS October 2026 Adjustment of Status Filing Charts".
      if (kind === "previous" ? !/^[A-Za-z]+\s+\d{4}$/.test(text) : !/filing charts/i.test(text)) continue;
      const month = statedMonth(text);
      const url = resolveUrl(a[1].replace(/&amp;/g, "&"), pageUrl);
      if (!month || !url || seen.has(month.key)) continue;
      seen.add(month.key);
      months.push({ month: month.key, label: month.label, url, section: kind });
    }
  }
  return { recognized: sawPrevious && months.length > 0, months, currentStatements };
}

export type ChartsMonthPage = {
  title: string | null;
  month: { key: string; label: string; year: number } | null;
  charts: ChartTable[];
  /** The chart(s) the page prints for each category, by the names its captions use; two when a category is split (June 2021 printed Final Action Dates for F2A and Dates for Filing for the rest). */
  designations: { family: string[]; employment: string[] };
  reviewedText: string | null;
  bodyHtml: string;
};

const CHART_NAMES: Record<ChartKind, string> = {
  final_action_dates: "Final Action Dates",
  dates_for_filing: "Dates for Filing",
  cut_off_dates: "Cut-off dates",
};

/** One month's USCIS filing-charts page; null when it has no body. */
export function parseChartsMonth(html: string): ChartsMonthPage | null {
  const body = uscisBody(html);
  if (!body) return null;
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const title = h1 ? inlineText(h1) || null : null;
  const month = statedMonth(title ?? "") ?? statedMonth(htmlToText(body).slice(0, 4000));
  // The page prints only the chart USCIS designated; its caption (or heading) names it.
  const { charts } = readCharts(body, month?.year ?? null);
  const designation = (category: PreferenceCategory) => [
    ...new Set(charts.filter((c) => c.category === category && c.chart !== "cut_off_dates").map((c) => CHART_NAMES[c.chart])),
  ];
  return {
    title,
    month: month ? { key: month.key, label: month.label, year: month.year } : null,
    charts,
    designations: { family: designation("family"), employment: designation("employment") },
    reviewedText: uscisReviewedText(html),
    bodyHtml: body,
  };
}

/** Rows of every chart, for metadata. */
export function chartRows(charts: ChartTable[]): PriorityDateRow[] {
  return charts.flatMap((c) => c.rows);
}

/** The stated "Last Reviewed/Updated" or "CA/VO" date as YYYY-MM-DD, when it parses. */
export function statedDate(text: string | null): string | null {
  return parseStatedDate(text);
}
