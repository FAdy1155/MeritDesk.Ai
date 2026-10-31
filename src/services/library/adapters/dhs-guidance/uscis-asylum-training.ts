import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { fetchFileText, fileFields, fileMetadata, fingerprintOf } from "./files";
import { anchors, resolveUrl } from "../../extract/html";
import { httpsUrl, isPdfUrl, lineText, parseReadingRoom, type ReadingRoomRow } from "./parse";

// USCIS's asylum officer training materials and asylum procedures manuals,
// as USCIS releases them in its Electronic Reading Room: the RAIO and
// Asylum Division lesson plans that make up the Asylum Officer Basic
// Training Course ("Persecution LP (RAIO)", "Credible Fear of Persecution
// and Torture Determinations Lesson Plan", ...), the Affirmative Asylum
// Procedures Manual and the Credible Fear Procedures Manual, plus the current
// Affirmative Asylum Procedures Manual that USCIS links from "The
// Affirmative Asylum Process" page (AAPM_PAGE_URL). The Reading
// Room lists everything USCIS releases there (about 1,800 items, newest
// first, 8 a page); its category and search filters do not apply to plain
// GET requests, so the collector reads the list and keeps the rows whose
// titles name these materials (isAsylumTrainingRow).
//
// - Daily: the first DAILY_PAGES pages (what was released recently).
// - Backfill: PAGES_PER_CHUNK pages a chunk, newest first, to the end of
//   the list. uscis.gov's robots.txt asks for 10 seconds between requests.
// - The Reading Room orders rows by their date, and rows with the same date
//   can trade places between pages, so a walk can see a row twice (merged)
//   or, rarely, miss one; the daily run re-reads the newest pages.
//
// The Affirmative Asylum Procedures Manual was released as an 86 MB PDF,
// above the library's default PDF cap and slow to download, so this collector
// allows MAX_PDF_MB and five minutes per attempt.
// US government work: public domain, stored in full.

const READING_ROOM_URL = "https://www.uscis.gov/records/electronic-reading-room";
const AAPM_PAGE_URL = "https://www.uscis.gov/humanitarian/refugees-and-asylum/asylum/the-affirmative-asylum-process";
const HOSTS = ["www.uscis.gov", "uscis.gov"] as const;
const AGENCY = "U.S. Citizenship and Immigration Services";
const DAILY_PAGES = 3;
const PAGES_PER_CHUNK = 45;
const MAX_PDF_MB = 120;

/** The Reading Room rows this collector keeps: lesson plans, asylum officer training material and the asylum procedures manuals. */
export function isAsylumTrainingRow(row: Pick<ReadingRoomRow, "title" | "url">): boolean {
  const title = row.title;
  const file = decodeURIComponent(new URL(row.url).pathname.split("/").pop() ?? "");
  return (
    /\bLP\s*\(RAIO\)|\bRAIO\b.*\b(?:Lesson|LP|Training)\b|\bLesson\s*Plans?\b/i.test(title) ||
    /_LP_RAIO|RAIO_Lesson_Plan|Lesson_?Plan/i.test(file) ||
    /\b(?:Affirmative Asylum|Credible Fear|Reasonable Fear)\b.*\bProcedures Manual\b/i.test(title) ||
    /\bAsylum Officer (?:Basic )?Training\b|\bAOBTC\b|\bADOTC\b|\bBasic Training Course\b/i.test(title)
  );
}

type Listing = { title: string; fileNote: string | null; dateText: string | null; description: string | null; listedOn: string };

function kindOf(title: string): "procedures manual" | "lesson plan" | "training material" {
  if (/Procedures Manual/i.test(title)) return "procedures manual";
  if (/\bLP\b|Lesson\s*Plan/i.test(title)) return "lesson plan";
  return "training material";
}

async function readPage(ctx: LibraryAdapterContext, page: number) {
  const url = new URL(READING_ROOM_URL);
  if (page > 0) url.searchParams.set("page", String(page));
  const { text, response } = await ctx.http.getText(url.toString(), { expect: "html" });
  const parsed = parseReadingRoom(text, response.url, HOSTS);
  if (!parsed.recognized) throw new LibraryLayoutError(url.toString(), "no Reading Room result rows");
  if (page === 0 && parsed.rows.length === 0) throw new LibraryLayoutError(url.toString(), "the Reading Room lists nothing");
  return parsed.rows;
}

/** The Affirmative Asylum Procedures Manual link on The Affirmative Asylum Process page. */
async function readAapmPage(ctx: LibraryAdapterContext, into: Map<string, DocumentRef>): Promise<void> {
  const { text, response } = await ctx.http.getText(AAPM_PAGE_URL, { expect: "html" });
  const link = anchors(text).find((a) => /Affirmative Asylum Procedures Manual/i.test(a.text) && /\.pdf(?:$|[?#])/i.test(a.href));
  const url = link ? httpsUrl(resolveUrl(link.href, response.url), HOSTS) : null;
  if (!link || !url) throw new LibraryLayoutError(AAPM_PAGE_URL, "no Affirmative Asylum Procedures Manual PDF link");
  const externalId = new URL(url).pathname;
  if (into.has(externalId)) return;
  const title = lineText(link.inner);
  const listing: Listing = { title, fileNote: null, dateText: null, description: null, listedOn: AAPM_PAGE_URL };
  into.set(externalId, { externalId, url, title, fingerprint: fingerprintOf(title, url), listing });
}

function collect(rows: ReadingRoomRow[], page: number, into: Map<string, DocumentRef>): void {
  for (const row of rows) {
    if (!isAsylumTrainingRow(row) || !isPdfUrl(row.url)) continue;
    const externalId = new URL(row.url).pathname;
    if (into.has(externalId)) continue;
    const listing: Listing = {
      title: row.title,
      fileNote: row.fileNote,
      dateText: row.dateText,
      description: row.description,
      listedOn: page > 0 ? `${READING_ROOM_URL}?page=${page}` : READING_ROOM_URL,
    };
    into.set(externalId, {
      externalId,
      url: row.url,
      title: row.title,
      fingerprint: fingerprintOf(row.title, row.url, row.fileNote, row.dateText, row.description),
      listing,
    });
  }
}

/** "Last Updated February 2025" on a manual's first page. */
function editionLine(text: string): string | null {
  return /\bLast Updated\s+[A-Z][a-z]+\.?\s+(?:\d{1,2},\s+)?\d{4}/.exec(text.slice(0, 2000))?.[0] ?? null;
}

function isCursor(value: unknown): value is { page: number } {
  return Boolean(value) && Number.isInteger((value as { page: number }).page) && (value as { page: number }).page >= 0;
}

export const uscisAsylumTrainingAdapter: LibrarySourceAdapter = {
  code: "uscis_asylum_officer_training",
  group: "other-agency-guidance",
  name: "USCIS asylum officer training lesson plans and asylum procedures manuals",
  description:
    "The RAIO and Asylum Division lesson plans used in the Asylum Officer Basic Training Course, the Affirmative Asylum Procedures Manual and the Credible Fear Procedures Manual, as USCIS releases them in its Electronic Reading Room.",
  coverage:
    "Every lesson plan, asylum officer training item and asylum procedures manual the Electronic Reading Room lists, and the current Affirmative Asylum Procedures Manual; lesson plans that uscis.gov hosts but no page links are not held.",
  cadence: "Daily",
  officialUrl: READING_ROOM_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 90,

  async listUpdates(ctx) {
    const refs = new Map<string, DocumentRef>();
    await readAapmPage(ctx, refs);
    for (let page = 0; page < DAILY_PAGES; page++) {
      const rows = await readPage(ctx, page);
      collect(rows, page, refs);
      if (rows.length === 0) break;
    }
    return { refs: [...refs.values()] };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const start = isCursor(cursor) ? cursor.page : 0;
    const refs = new Map<string, DocumentRef>();
    if (start === 0) await readAapmPage(ctx, refs);
    for (let page = start; page < start + PAGES_PER_CHUNK; page++) {
      const rows = await readPage(ctx, page);
      if (rows.length === 0) {
        // Past the last page: the walk is done (also for a cursor left beyond a list that shrank).
        return { refs: [...refs.values()], nextCursor: null, progress: `Reading Room pages ${start + 1} to ${page}; the end of the list was reached` };
      }
      collect(rows, page, refs);
    }
    return {
      refs: [...refs.values()],
      nextCursor: { page: start + PAGES_PER_CHUNK },
      progress: `Reading Room pages ${start + 1} to ${start + PAGES_PER_CHUNK}, ${refs.size} matching item(s)`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.title) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const file = await fetchFileText(ctx, ref.url, ref.known, { maxBytes: MAX_PDF_MB * 1024 * 1024, timeoutMs: 5 * 60 * 1000 });
    if (file === "not_modified") return { kind: "not_modified" };
    const kind = kindOf(listing.title);
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "manual_section",
        title: listing.title,
        citations: [],
        agency: AGENCY,
        precedentialStatus: "not_applicable",
        ...fileFields(file),
        metadata: {
          materialKind: kind,
          ...(listing.description ? { summary: listing.description, summaryKind: "the Reading Room's description" } : {}),
          ...(listing.fileNote ? { listedFile: listing.fileNote } : {}),
          ...(listing.dateText && parseStatedDate(listing.dateText) ? { releasedInReadingRoom: parseStatedDate(listing.dateText) } : {}),
          ...(editionLine(file.text) ? { edition: editionLine(file.text) } : {}),
          listedOn: listing.listedOn,
          statedDates: listing.dateText ? { readingRoomDate: listing.dateText } : {},
          ...fileMetadata(file),
        },
      },
    };
  },
};
