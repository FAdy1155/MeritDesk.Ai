import { justiceGovBody, justiceGovUpdatedLine } from "@/services/monitoring/parse/html";
import { anchors, htmlToText, inlineText, resolveUrl } from "../../extract/html";
import { repairMojibake } from "../../text";

// Parsers for EOIR's AG/BIA Precedent Decisions pages on justice.gov:
// https://www.justice.gov/eoir/ag-bia-decisions (the volume index) and one
// page per volume. Pure, so they can be checked against saved pages.
//
// The volume pages come in two layouts, and both are read the same way:
// - older volumes (8 to about 24): one table, one row per decision (the
//   caption in the first cell, the "ID nnnn" link to the PDF in the second),
//   rows separated by a row holding a rule; no headnotes;
// - newer volumes: one small table per decision, followed by the official
//   headnote paragraphs, entries separated by a rule.
// A decision is a table row with an "ID nnnn" link; its headnote is the text
// between that row's table and the next decision's row, when there is any.

export type VolumeLink = { volume: number; url: string; label: string };

/** The volumes the index's AG/BIA Precedent Decisions list links, highest first. */
export function parseVolumeIndex(html: string, pageUrl: string): VolumeLink[] {
  const body = justiceGovBody(html) ?? html;
  // The AG/BIA list ends where the OCAHO list starts; OCAHO volumes are not BIA volumes.
  const ocaho = body.search(/OCAHO Published Decisions/i);
  const section = ocaho > 0 ? body.slice(0, ocaho) : body;
  const seen = new Map<number, VolumeLink>();
  for (const a of anchors(section)) {
    const m = /^Volume\s+0*(\d{1,2})\b/i.exec(a.text);
    if (!m) continue;
    const url = resolveUrl(a.href, pageUrl);
    if (!url) continue;
    const volume = Number(m[1]);
    if (!seen.has(volume)) seen.set(volume, { volume, url, label: a.text });
  }
  return [...seen.values()].sort((x, y) => y.volume - x.volume);
}

export type VolumeEntry = {
  /** The Interim Decision number as the page prints it ("0939"). */
  idNumber: string;
  /** The caption name as listed ("C-R-", "BAY AREA LEGAL SERVICES, INC."). */
  name: string;
  /** "8 I&N Dec. 59 (BIA 1958)", as listed. */
  citation: string;
  pdfUrl: string;
  /** The official headnote paragraphs under the entry; null when the page prints none. */
  headnote: string | null;
};

export type VolumeParse = {
  entries: VolumeEntry[];
  rowsSeen: number;
  notes: string[];
  /** The page's "Updated <date>" line. */
  pageUpdated: string | null;
  recognized: boolean;
};

// The period after "Dec" is sometimes missing on the page ("29 I&N Dec 621").
const CITATION = /\d{1,2}\s+I\s*&\s*N\s+Dec\.?\s+\d{1,4}\s+\([^)]*\d{4}\)/;

/** One volume page's decisions, in page order. */
export function parseVolumePage(html: string, pageUrl: string): VolumeParse {
  const body = justiceGovBody(html);
  const pageUpdated = justiceGovUpdatedLine(html);
  if (!body) return { entries: [], rowsSeen: 0, notes: ["The page has no body field."], pageUpdated, recognized: false };

  const rows: { start: number; end: number; inner: string }[] = [];
  for (const m of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const inner = m[1];
    if (anchors(inner).some((a) => /^ID\s*#?\s*\d{3,4}$/i.test(a.text))) {
      const start = m.index ?? 0;
      rows.push({ start, end: start + m[0].length, inner });
    }
  }

  const entries: VolumeEntry[] = [];
  const notes: string[] = [];
  rows.forEach((row, i) => {
    const firstCell = /<td\b[^>]*>([\s\S]*?)<\/td\s*>/i.exec(row.inner);
    const cellText = repairMojibake(firstCell ? inlineText(firstCell[1]) : "");
    const strong = /<strong\b[^>]*>([\s\S]*?)<\/strong\s*>/i.exec(row.inner);
    const link = anchors(row.inner).find((a) => /^ID\s*#?\s*\d{3,4}$/i.test(a.text));
    const idNumber = link ? /\d+/.exec(link.text)?.[0] : undefined;
    const pdfUrl = link ? resolveUrl(link.href, pageUrl) : null;
    const citation = CITATION.exec(cellText)?.[0].replace(/\s+/g, " ") ?? null;
    const name = repairMojibake(strong ? inlineText(strong[1]) : cellText.split(",")[0] ?? "")
      .replace(/[,\s]+$/, "")
      .trim();
    if (!idNumber || !pdfUrl || !citation || !name) {
      notes.push(`An entry could not be read (${cellText.slice(0, 80) || "no caption"}); it was left out.`);
      return;
    }
    const segmentEnd = i + 1 < rows.length ? rows[i + 1].start : body.length;
    const segment = body.slice(row.end, segmentEnd);
    const headnote = segment.search(/<\/table\s*>/i) >= 0 ? repairMojibake(htmlToText(segment)).trim() || null : null;
    entries.push({ idNumber, name, citation, pdfUrl, headnote });
  });
  return { entries, rowsSeen: rows.length, notes, pageUpdated, recognized: rows.length > 0 };
}

export type DecisionHeader = {
  /** The decision date as the PDF states it ("May 22, 2020"); null when not found. */
  decidedText: string | null;
};

const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const DECIDED = new RegExp(`\\bDecided(?:\\s+by\\s+[A-Za-z .'-]{2,60}?)?\\s+(${MONTH}\\.?\\s+\\d{1,2},\\s+\\d{4})`);

/** The "Decided <date>" line near the top of a decision's text. */
export function parseDecisionHeader(text: string): DecisionHeader {
  const m = DECIDED.exec(text.slice(0, 5000));
  return { decidedText: m ? m[1].replace(/\s+/g, " ") : null };
}

/** The issuer abbreviation and year in a citation's parenthetical: "(BIA 1958)" gives BIA and 1958. */
export function citationParenthetical(citation: string): { issuer: string | null; year: number | null } {
  const m = /\(([^)]*?)\s*(\d{4})\)\s*$/.exec(citation);
  if (!m) return { issuer: null, year: null };
  return { issuer: m[1].trim() || null, year: Number(m[2]) };
}
