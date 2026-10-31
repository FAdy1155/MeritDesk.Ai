import { anchors, inlineText, resolveUrl } from "../../extract/html";

// Pure parsers for EOIR's case data release: the FOIA library page that
// links it, the release's own text files (Readme.txt, Count.txt,
// EOIRDB_Schema.csv) and its tab-separated tables. No network, no database:
// the collector and the statistics loader both use them, and they can be
// tried on saved copies.

/** EOIR's FOIA library page, where the case data release and its code key are linked. */
export const FOIA_LIBRARY_URL = "https://www.justice.gov/eoir/foia-library-0";

export type FoiaLibraryLinks = {
  caseData: { url: string; linkText: string; label: string | null };
  codeKey: { url: string; linkText: string; label: string | null } | null;
  /** "Updated October 9, 2026", as the page states it. */
  pageUpdated: string | null;
};

/** The text right after an anchor, up to the next tag: where EOIR writes "(August 2026)". */
function trailingLabel(html: string, anchorIndex: number): string | null {
  const close = html.indexOf("</a>", anchorIndex);
  if (close < 0) return null;
  const after = html.slice(close + 4, close + 400);
  const text = inlineText(after.split("<")[0] ?? "");
  const m = /^\(([^)]{3,60})\)/.exec(text.trim());
  return m ? m[1].trim() : null;
}

/**
 * The "EOIR Case Data" and "EOIR Case Data Code Key" links of the FOIA
 * library page. Null when the case data link is not there (the caller
 * treats that as a changed layout).
 */
export function parseFoiaLibraryPage(html: string, pageUrl: string): FoiaLibraryLinks | null {
  let caseData: FoiaLibraryLinks["caseData"] | null = null;
  let codeKey: FoiaLibraryLinks["codeKey"] = null;
  for (const a of anchors(html)) {
    const text = a.text.replace(/\s+/g, " ").trim();
    const url = resolveUrl(a.href, pageUrl);
    if (!url || !url.startsWith("https://")) continue;
    if (!caseData && /^EOIR Case Data$/i.test(text) && /\.zip$/i.test(new URL(url).pathname)) {
      caseData = { url, linkText: text, label: trailingLabel(html, a.index) };
    } else if (!codeKey && /^EOIR Case Data Code Key$/i.test(text)) {
      codeKey = { url, linkText: text, label: trailingLabel(html, a.index) };
    }
  }
  if (!caseData) return null;
  const updated = /Updated\s+([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
  return { caseData, codeKey, pageUpdated: updated ? `Updated ${updated[1]}` : null };
}

/** Text from a release file: UTF-8 when it is valid UTF-8, else Windows-1252 (EOIR's Readme is). Control characters other than tab and newline are dropped. */
export function decodeReleaseText(bytes: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
   
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/** Count.txt: "A_TblCase\t12821531 rows copied." per line. */
export function parseCountFile(text: string): { table: string; rows: number }[] {
  const out: { table: string; rows: number }[] = [];
  for (const line of text.split("\n")) {
    const m = /^(\S+)\t\s*(\d+) rows copied\.?\s*$/.exec(line.trim());
    if (m) out.push({ table: m[1], rows: Number(m[2]) });
  }
  return out;
}

export type SchemaField = { table: string; field: string; type: string; nullable: string };

/** EOIRDB_Schema.csv: table_name, field_name, type name and nullability, tab-separated. */
export function parseSchemaFile(text: string): SchemaField[] {
  const lines = text.split("\n").filter((l) => l.trim());
  const header = (lines[0] ?? "").split("\t").map((h) => h.trim().toLowerCase());
  if (header[0] !== "table_name" || header[1] !== "field_name") return [];
  return lines.slice(1).map((line) => {
    const [table = "", field = "", type = "", nullable = ""] = line.split("\t").map((c) => c.trim());
    return { table, field, type, nullable };
  }).filter((f) => f.table && f.field);
}

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------

export class TableLayoutError extends Error {
  constructor(table: string, detail: string) {
    super(`EOIR's ${table} no longer has the layout the statistics loader reads (${detail}), so nothing from this release was loaded. The loader needs updating.`);
    this.name = "TableLayoutError";
  }
}

/** Column positions by name, from a table's header line; throws when a needed column is missing. */
export function columnIndex(table: string, headerLine: string, needed: readonly string[]): Record<string, number> {
  const names = headerLine.split("\t").map((h) => h.trim().toUpperCase());
  const out: Record<string, number> = {};
  const missing: string[] = [];
  for (const name of needed) {
    const at = names.indexOf(name.toUpperCase());
    if (at < 0) missing.push(name);
    else out[name] = at;
  }
  if (missing.length) throw new TableLayoutError(table, `missing column(s) ${missing.join(", ")}`);
  return out;
}

/** A lookup table's rows as objects keyed by the header's names, values trimmed. */
export function parseLookupTable(table: string, text: string, needed: readonly string[]): Record<string, string>[] {
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) throw new TableLayoutError(table, "empty file");
  const index = columnIndex(table, lines[0], needed);
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row: Record<string, string> = {};
    for (const name of needed) row[name] = (cells[index[name]] ?? "").trim();
    return row;
  });
}

/**
 * Days since 1970-01-01 of a "YYYY-MM-DD..." value, or null when the value
 * is empty or not a real date. Fast path for millions of rows: no Date
 * object for the common case.
 */
export function dayNumber(value: string | undefined): number | null {
  if (!value || value.length < 10 || value.charCodeAt(4) !== 45 || value.charCodeAt(7) !== 45) return null;
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, m - 1, d);
  const check = new Date(ms);
  if (check.getUTCDate() !== d) return null;
  return Math.floor(ms / 86_400_000);
}

/** The federal fiscal year (October to September) of a "YYYY-MM-DD..." value; null when it is not a date. */
export function fiscalYear(value: string | undefined): number | null {
  if (dayNumber(value) === null) return null;
  const y = Number(value!.slice(0, 4));
  const m = Number(value!.slice(5, 7));
  return m >= 10 ? y + 1 : y;
}
