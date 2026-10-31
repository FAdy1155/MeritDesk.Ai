import { anchors, attrValue, decodeEntities, inlineText, resolveUrl } from "../../extract/html";

// Parsers for the Reading Room of EOIR's FOIA Public Access Link (PAL),
// where EOIR posts redacted Board of Immigration Appeals decisions:
// https://foia.eoir.justice.gov/app/ReadingRoom.aspx (the search form) and
// SearchDocs.aspx (the results the form loads). Pure, so they can be checked
// against saved pages.
//
// - The search form names its search fields in a JSON array in the page's
//   script (`var json = $.parseJSON(JSON.stringify([...]))`, the same array
//   as the hdnFieldInfo hidden field): "Decision Date" is a custom field
//   (CustomField54 when this was written) searched by its _FromDate and
//   _ToDate parts. The sort list names the folder-name column ("vcName").
// - A results page is one table (#tblsearchdocs) whose header cells name the
//   columns (Folder Name, Decision Date, Base City, Appeal Type, Filed By,
//   Pages, Size (Bytes), Published Date, Download), ten rows a page, with
//   "page 1 of N" under it when there is more than one page, or a single row
//   saying no documents matched. Each row's folder link and download link
//   are javascript: calls (showDocs('<docid>','F'), download('<docid>','F'))
//   to functions the page defines; the URLs are the ones those functions
//   open, read from the page's own script.

export type SearchField = { name: string; type: number; customListId: number };

export type ReadingRoomForm = {
  /** The results URL the form posts to, resolved against the page. */
  searchUrl: string;
  /** The Decision Date field's From and To parts, as the form sends them. */
  decisionFrom: SearchField;
  decisionTo: SearchField;
  /** The sort value of the Folder Name column. */
  folderSortValue: string;
  /** The release periods the page lists ("FY17 - Q2-Q4 01/01/2017 - 09/30/2017"). */
  periods: string[];
};

type FieldInfo = { InternalName?: unknown; LabelName?: unknown; FieldType?: unknown; CustomListId?: unknown };

function fieldList(html: string): FieldInfo[] | null {
  const script = /var\s+json\s*=\s*\$\.parseJSON\(\s*JSON\.stringify\(\s*(\[[\s\S]*?\])\s*\)\s*\)\s*;/.exec(html)?.[1];
  const hidden = /<input\b[^>]*\bid="hdnFieldInfo"[^>]*>/i.exec(html)?.[0];
  for (const raw of [script, hidden ? decodeEntities(attrValue(hidden, "value") ?? "") : undefined]) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as FieldInfo[];
    } catch {
      // try the other copy
    }
  }
  return null;
}

/** The search form on ReadingRoom.aspx; null fields name what is missing. */
export function parseReadingRoomForm(html: string, pageUrl: string): { form: ReadingRoomForm | null; problems: string[] } {
  const problems: string[] = [];
  const fields = fieldList(html);
  if (!fields) problems.push("no search field list");
  const field = (suffix: string): SearchField | null => {
    const f = fields?.find(
      (x) => x.LabelName === "Decision Date" && typeof x.InternalName === "string" && x.InternalName.endsWith(suffix)
    );
    if (!f || typeof f.InternalName !== "string") return null;
    return { name: f.InternalName, type: Number(f.FieldType ?? 5), customListId: Number(f.CustomListId ?? 0) };
  };
  const decisionFrom = field("_FromDate");
  const decisionTo = field("_ToDate");
  if (fields && (!decisionFrom || !decisionTo)) problems.push("no Decision Date From/To fields");

  const searchPath = /\$\.ajax\(\s*\{\s*url:\s*"([^"]+)"\s*,\s*type:\s*"POST"/.exec(html)?.[1] ?? null;
  const searchUrl = searchPath && /SearchDocs\.aspx$/i.test(searchPath) ? resolveUrl(searchPath, pageUrl) : null;
  if (!searchUrl) problems.push("no SearchDocs.aspx search call");

  const sortSelect = /<select\b[^>]*\bid="ddlSortBy"[^>]*>([\s\S]*?)<\/select\s*>/i.exec(html)?.[1] ?? "";
  let folderSortValue: string | null = null;
  for (const m of sortSelect.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option\s*>/gi)) {
    if (inlineText(m[2]) === "Folder Name") folderSortValue = attrValue(m[1], "value");
  }
  if (!folderSortValue) problems.push("no Folder Name sort option");

  const message = /<div\b[^>]*\bid="pageMessage"[^>]*>([\s\S]*?)<div\b[^>]*\bclass="card panel-default"/i.exec(html)?.[1] ?? "";
  const periods = [...message.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)].map((m) => inlineText(m[1])).filter(Boolean);

  if (problems.length || !searchUrl || !decisionFrom || !decisionTo || !folderSortValue) return { form: null, problems };
  return { form: { searchUrl, decisionFrom, decisionTo, folderSortValue, periods }, problems };
}

export type ResultRow = {
  /** The reading room's document id (the argument of showDocs and download). */
  docId: string;
  /** The second argument of showDocs and download ("F"). */
  palFlag: string;
  /** The Folder Name column: the reading room's title for the decision. */
  folderName: string;
  /** The columns as printed ("3/19/2021 12:00:00 AM", "MIAMI", "Case Appeal", ...); "" when blank. */
  decisionDateText: string;
  baseCity: string;
  appealType: string;
  filedBy: string;
  pagesText: string;
  sizeText: string;
  publishedDateText: string;
  /** The URL the row's download link opens (the decision's PDF). */
  downloadUrl: string;
  /** The URL the row's folder link opens (the reading room's Folder Information page). */
  folderInfoUrl: string;
};

export type ResultsPage = {
  /** The results table was found and read. */
  recognized: boolean;
  /** Why the page was not recognized. */
  problem: string | null;
  /** The page says no documents matched. */
  empty: boolean;
  /** How many pages the results have (1 when the page prints no pager). */
  totalPages: number;
  rows: ResultRow[];
  /** Rows that could not be read, described. */
  unreadable: string[];
};

const COLUMNS = {
  folder: "Folder Name",
  decided: "Decision Date",
  city: "Base City",
  appealType: "Appeal Type",
  filedBy: "Filed By",
  pages: "Pages",
  size: "Size (Bytes)",
  published: "Published Date",
  download: "Download",
} as const;

/** The URL prefix and middle a page's javascript link function joins with a document id and flag. */
function linkTemplate(html: string, pattern: RegExp): [string, string] | null {
  const m = pattern.exec(html);
  return m ? [m[1], m[2]] : null;
}

const DOWNLOAD_FN =
  /function\s+download\s*\(\s*docid\s*,\s*isPALDoc\s*\)\s*\{\s*location\.href\s*=\s*'([^']+)'\s*\+\s*encodeURIComponent\(docid\)\s*\+\s*'([^']+)'\s*\+\s*encodeURIComponent\(isPALDoc\)/;
const SHOWDOCS_FN =
  /function\s+showDocs\s*\(\s*docid\s*,\s*isPALDoc\s*\)\s*\{\s*\$\('#docinfo'\)\.attr\('src',\s*'([^']+)'\s*\+\s*encodeURIComponent\(docid\)\s*\+\s*'([^']+)'\s*\+\s*encodeURIComponent\(isPALDoc\)\)/;

function unrecognized(problem: string): ResultsPage {
  return { recognized: false, problem, empty: false, totalPages: 0, rows: [], unreadable: [] };
}

/** One SearchDocs.aspx results page. */
export function parseResultsPage(html: string, pageUrl: string): ResultsPage {
  const table = /<table\b[^>]*\bid="tblsearchdocs"[^>]*>([\s\S]*?)<\/table\s*>/i.exec(html)?.[1];
  if (!table) return unrecognized("no results table (#tblsearchdocs)");
  const head = /<thead\b[^>]*>([\s\S]*?)<\/thead\s*>/i.exec(table)?.[1] ?? "";
  const headers = [...head.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th\s*>/gi)].map((m) => inlineText(m[1]));
  const col = (title: string) => headers.indexOf(title);
  const missing = Object.values(COLUMNS).filter((t) => col(t) < 0);
  if (missing.length) return unrecognized(`the results table has no ${missing.join(", ")} column(s)`);

  const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody\s*>/i.exec(table)?.[1] ?? "";
  const bodyRows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((m) => m[1]);
  if (bodyRows.length === 1 && /No documents matching the search criteria were found/i.test(inlineText(bodyRows[0]))) {
    return { recognized: true, problem: null, empty: true, totalPages: 0, rows: [], unreadable: [] };
  }

  const download = linkTemplate(html, DOWNLOAD_FN);
  const showDocs = linkTemplate(html, SHOWDOCS_FN);
  if (!download) return unrecognized("no download(docid, isPALDoc) function");
  if (!showDocs) return unrecognized("no showDocs(docid, isPALDoc) function");

  const rows: ResultRow[] = [];
  const unreadable: string[] = [];
  for (const inner of bodyRows) {
    const cells = [...inner.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)].map((m) => m[1]);
    const text = (i: number) => (cells[i] === undefined ? "" : inlineText(cells[i]).replace(/\u00a0/g, " ").trim());
    const folderLink = anchors(cells[col(COLUMNS.folder)] ?? "").find((a) => /^javascript:showDocs\(/i.test(a.href));
    const downloadLink = anchors(cells[col(COLUMNS.download)] ?? "").find((a) => /^javascript:download\(/i.test(a.href));
    const args = (href: string | undefined) => (href ? /\(\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/.exec(href) : null);
    const shown = args(folderLink?.href);
    const fetched = args(downloadLink?.href);
    const folderName = folderLink ? folderLink.text.trim() : "";
    if (!shown || !fetched || !folderName || !/^\d+$/.test(shown[1]) || shown[1] !== fetched[1] || shown[2] !== fetched[2]) {
      unreadable.push(inlineText(inner).slice(0, 120) || "an empty row");
      continue;
    }
    const [docId, palFlag] = [shown[1], shown[2]];
    const downloadUrl = resolveUrl(`${download[0]}${encodeURIComponent(docId)}${download[1]}${encodeURIComponent(palFlag)}`, pageUrl);
    const folderInfoUrl = resolveUrl(`${showDocs[0]}${encodeURIComponent(docId)}${showDocs[1]}${encodeURIComponent(palFlag)}`, pageUrl);
    if (!downloadUrl || !folderInfoUrl) {
      unreadable.push(`document ${docId}: its links do not resolve`);
      continue;
    }
    rows.push({
      docId,
      palFlag,
      folderName,
      decisionDateText: text(col(COLUMNS.decided)),
      baseCity: text(col(COLUMNS.city)),
      appealType: text(col(COLUMNS.appealType)),
      filedBy: text(col(COLUMNS.filedBy)),
      pagesText: text(col(COLUMNS.pages)),
      sizeText: text(col(COLUMNS.size)),
      publishedDateText: text(col(COLUMNS.published)),
      downloadUrl,
      folderInfoUrl,
    });
  }

  // "page 1 of N" under the table when there is more than one page; the
  // pager script's last page index (Math.min(N - 1, ...)) on every page.
  const pager = /\bpage\s+\d+\s+of\s+(\d+)\b/i.exec(html);
  const lastIndex = /pageIndex\s*===\s*'L'\)\s*pageIndexValue\s*=\s*(-?\d+)\s*;/.exec(html);
  const totalPages = pager ? Number(pager[1]) : lastIndex ? Number(lastIndex[1]) + 1 : rows.length > 0 ? 1 : 0;
  if (rows.length === 0 && unreadable.length === 0) return unrecognized("no result rows and no 'no documents' message");
  return { recognized: true, problem: null, empty: false, totalPages, rows, unreadable };
}

/** The stated date part of a Decision Date cell ("3/19/2021 12:00:00 AM" gives "3/19/2021"). */
export function statedDay(text: string): string | null {
  return /\b\d{1,2}\/\d{1,2}\/\d{4}\b/.exec(text)?.[0] ?? null;
}

/** MM/DD/YYYY of a YYYY-MM-DD day, as the search form takes dates. */
export function formDate(isoDay: string): string {
  return `${isoDay.slice(5, 7)}/${isoDay.slice(8, 10)}/${isoDay.slice(0, 4)}`;
}

/** YYYY-MM-DD of a M/D/YYYY date as the listing prints it; null when it is not one. */
export function isoOfStated(text: string | null): string | null {
  const m = text ? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text) : null;
  if (!m) return null;
  const iso = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}
