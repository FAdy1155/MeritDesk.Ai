import { parseStatedDate, utcDate } from "@/services/monitoring/parse/dates";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import { formUpdateId, parseFormsUpdates, parseSlashDate, type FormUpdateRow, type FormsUpdatesParse } from "./parse";
import { USCIS_AGENCY, USCIS_HOST, isUscisUrl, readRunPage, recallPage, rememberPage } from "./run-pages";

// USCIS's Forms Updates page: one entry per new form edition ("Update to
// Form I-129, Petition for a Nonimmigrant Worker. New Edition Dated
// 01/27/20."), with the date USCIS posted it and its note on which earlier
// editions it still accepts and until when. Each entry is a document, so
// the library holds the edition history the page keeps (back to January
// 2020 today, 439 entries), which the form pages themselves do not show.
//
// - Daily: the first page, and the next ones while they reach back to a
//   week before the last run; a first page unchanged since the last
//   complete run means nothing was posted.
// - Backfill: every page, newest first, following the page's own Next link
//   (the cursor keeps that link); PAGES_PER_CHUNK pages a chunk. New entries
//   push older ones down a page, so an entry may be listed twice (one id)
//   but none is skipped.
// - An entry has no page of its own: its document is read from the listing
//   page (kept from the listing step in the same run, else fetched again),
//   and its official URL is the form page it links.
//
// US government work: public domain.

const FORMS_UPDATES_URL = "https://www.uscis.gov/forms/forms-updates";
const HOSTS = [USCIS_HOST] as const;
const PAGES_PER_CHUNK = 15;
const DAILY_MAX_PAGES = 5;
const OVERLAP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

type RowListing = { pageUrl: string };
type Cursor = { url: string; pagesDone: number };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  if (!c || typeof c.url !== "string" || !Number.isInteger(c.pagesDone)) return false;
  try {
    return isUscisUrl(c.url) && new URL(c.url).pathname === "/forms/forms-updates";
  } catch {
    return false;
  }
}

function postedOn(row: FormUpdateRow): string | null {
  return parseStatedDate(row.date?.text) ?? parseStatedDate(row.date?.datetime);
}

function readRows(url: string, text: string, pageUrl: string): FormsUpdatesParse {
  const parsed = parseFormsUpdates(text, pageUrl);
  if (parsed.rows.length === 0 && parsed.statedTotal !== 0) throw new LibraryLayoutError(url, "no update rows with a linked title");
  return parsed;
}

function refsFor(ctx: LibraryAdapterContext, parsed: FormsUpdatesParse, pageUrl: string): DocumentRef[] {
  for (const note of parsed.notes) ctx.note(note);
  return parsed.rows
    .filter((row) => {
      if (isUscisUrl(row.formUrl)) return true;
      ctx.note(`"${row.title}": its link (${row.formUrl}) is not on ${USCIS_HOST}; left out.`);
      return false;
    })
    .map((row) => ({
      externalId: formUpdateId(row),
      url: pageUrl,
      title: row.title,
      fingerprint: sha256Hex([row.title, row.formUrl, row.date?.text ?? "", row.description].join("\u0000")).slice(0, 32),
      listing: { pageUrl } satisfies RowListing,
    }));
}

function dedupe(refs: DocumentRef[]): DocumentRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.externalId) ? false : (seen.add(r.externalId), true)));
}

export const uscisFormUpdatesAdapter: LibrarySourceAdapter = {
  code: "uscis_form_updates",
  group: "uscis-forms-fees",
  name: "USCIS Forms Updates (form edition history)",
  description:
    "Each new form edition USCIS announces on its Forms Updates page: the form, the new edition date, when it was posted, and USCIS's note on which earlier editions it still accepts.",
  coverage: "Every entry on USCIS's Forms Updates page (January 2020 to the present when this collector was written).",
  cadence: "Daily",
  officialUrl: FORMS_UPDATES_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 90,

  async listUpdates(ctx, since) {
    const first = await ctx.http.getListing(FORMS_UPDATES_URL, { expect: "html" });
    if (first.unchanged) return { refs: [] };
    rememberPage(ctx, FORMS_UPDATES_URL, first);
    let parsed = readRows(FORMS_UPDATES_URL, first.text, first.response.url);
    const refs = refsFor(ctx, parsed, FORMS_UPDATES_URL);
    if (since) {
      const from = utcDate(new Date(since.getTime() - OVERLAP_DAYS * DAY_MS));
      for (let pages = 1; pages < DAILY_MAX_PAGES && parsed.nextUrl; pages++) {
        const oldest = parsed.rows.length ? postedOn(parsed.rows[parsed.rows.length - 1]) : null;
        if (!oldest || oldest < from) break;
        const url: string = parsed.nextUrl;
        const page = await readRunPage(ctx, url);
        parsed = readRows(url, page.text, page.response.url);
        refs.push(...refsFor(ctx, parsed, url));
      }
    }
    return { refs: dedupe(refs) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    let state: Cursor = isCursor(cursor) ? cursor : { url: FORMS_UPDATES_URL, pagesDone: 0 };
    if (cursor !== null && !isCursor(cursor)) ctx.note("The saved cursor is not a Forms Updates page; the walk starts again from the first page.");
    const refs: DocumentRef[] = [];
    let next: string | null = state.url;
    let total: number | null = null;
    let pages = 0;
    while (next && pages < PAGES_PER_CHUNK) {
      const url: string = next;
      const page = await readRunPage(ctx, url);
      const parsed = readRows(url, page.text, page.response.url);
      refs.push(...refsFor(ctx, parsed, url));
      total = parsed.statedTotal ?? total;
      next = parsed.nextUrl;
      pages++;
    }
    const done = state.pagesDone + pages;
    state = { url: next ?? "", pagesDone: done };
    return {
      refs: dedupe(refs),
      nextCursor: next ? state : null,
      progress: `pages ${done - pages + 1} to ${done}${total !== null ? ` (${total} entries in all)` : ""}`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as RowListing | undefined;
    const pageUrl = listing?.pageUrl ?? ref.url;
    const page = recallPage(ctx, pageUrl) ?? (await readRunPage(ctx, pageUrl));
    const parsed = readRows(pageUrl, page.text, page.response.url);
    const row = parsed.rows.find((r) => formUpdateId(r) === ref.externalId);
    if (!row) return { kind: "skip", reason: `${ref.externalId} is no longer on ${pageUrl} (newer entries move older ones down a page); it is read again where it is now.` };
    const posted = postedOn(row);
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "notice",
        title: row.title,
        citations: [],
        agency: USCIS_AGENCY,
        publishedDate: posted,
        editionDate: parseSlashDate(row.editionDateText, ctx.now),
        precedentialStatus: "not_applicable",
        officialUrl: row.formUrl,
        text: [row.title, row.date?.text, row.description].filter(Boolean).join("\n\n"),
        metadata: {
          kind: "form_update",
          formNumber: row.formNumber,
          formName: row.formName,
          formPage: row.formUrl,
          editionDateText: row.editionDateText,
          ...(row.description ? { summary: row.description, summaryKind: "the entry's note on Forms Updates" } : {}),
          statedDates: { posted: row.date?.text ?? null, postedDatetime: row.date?.datetime ?? null, edition: row.editionDateText },
          listedOn: FORMS_UPDATES_URL,
          listedOnPage: pageUrl,
        },
        fetch: { response: page.response },
      },
    };
  },

  legalUpdateItem(document) {
    const posted = (document.metadata?.statedDates as { posted?: string | null } | undefined)?.posted ?? null;
    return {
      itemType: "USCIS form update",
      excerpt: document.text,
      publishedDateText: posted,
      listedOnUrl: FORMS_UPDATES_URL,
    };
  },
};
