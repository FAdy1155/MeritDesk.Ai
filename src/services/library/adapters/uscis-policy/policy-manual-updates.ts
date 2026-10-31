import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText } from "../../extract/html";
import { cleanText } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibraryHttpResponse,
  type LibrarySourceAdapter,
} from "../../types";
import { bodyText, fetchUscisFile, fingerprintOf, pdfExtraction, pdfOriginal, USCIS_AGENCY, USCIS_HOSTS } from "./common";
import { parseMemoHeader, parsePmUpdateBlocks, parseUscisPage, statedEffectiveDate, supersessionStatements, urlPath, type PmUpdate } from "./parse";

// The USCIS Policy Manual's update history: every policy alert and
// technical update on https://www.uscis.gov/policy-manual/updates ("all
// current and historical updates since the Policy Manual's inception"),
// each with its date, USCIS's summary and the sections it affected.
//
// - A policy alert links its document ("Read More", a PDF): the document's
//   text is the PDF's, its number ("PA-2026-15") a citation, the listing's
//   summary its metadata.summary, and the sentences in which it says what
//   it supersedes, rescinds or replaces are kept (metadata.supersedes), so
//   the memoranda the manual now governs can be traced.
// - A technical update has no document of its own: its text is the update
//   as the Updates page prints it, read again from that page (once per run).
// - Daily: the Updates page, every entry (fingerprints skip the unchanged).
//   Backfill: the same entries, newest first, PAGE_SIZE per chunk.
// - Legal updates: "USCIS Policy Manual update", with the official link the
//   legal-update monitor uses for the same item (the PDF, else the first
//   affected section), so the two are recognized as one.

const UPDATES_URL = "https://www.uscis.gov/policy-manual/updates";
const PAGE_SIZE = 70;

type Listing = {
  header: string;
  dateText: string | null;
  datetime: string | null;
  summary: string;
  readMoreUrl: string | null;
  affected: { citation: string | null; title: string; url: string | null }[];
};

type Cursor = { offset: number };

function isCursor(value: unknown): value is Cursor {
  return Boolean(value) && Number.isInteger((value as Cursor).offset) && (value as Cursor).offset >= 0;
}

function dateOf(u: { datetime: string | null; dateText: string | null }): string | null {
  return parseStatedDate(u.dateText) ?? parseStatedDate(u.datetime);
}

/** The update's own identifier: its document's path when it has one, else its date and header as listed. */
function idOf(u: PmUpdate): string {
  return u.readMoreUrl ? urlPath(u.readMoreUrl) : `update ${dateOf(u) ?? u.dateText ?? "undated"} ${u.header}`;
}

function refFor(u: PmUpdate): DocumentRef {
  const listing: Listing = {
    header: u.header,
    dateText: u.dateText,
    datetime: u.datetime,
    summary: u.summary,
    readMoreUrl: u.readMoreUrl,
    affected: u.affected,
  };
  return {
    externalId: idOf(u),
    url: u.readMoreUrl ?? UPDATES_URL,
    title: u.header,
    fingerprint: fingerprintOf(u.header, u.dateText, u.summary, u.readMoreUrl, u.affected.map((a) => `${a.citation}|${a.title}|${a.url}`).join("\n")),
    listing,
  };
}

function parseUpdatesPage(html: string, url: string): PmUpdate[] {
  const updates = parsePmUpdateBlocks(html, url);
  if (updates.length === 0) throw new LibraryLayoutError(url, "no update blocks (div.pm-updates)");
  return updates;
}

/** The Updates page's entries; the daily run reads it with a conditional GET and lists nothing when it is unchanged (HTTP 304). */
async function readUpdates(ctx: LibraryAdapterContext, daily = false): Promise<DocumentRef[]> {
  const { text, response, unchanged } = daily
    ? await ctx.http.getListing(UPDATES_URL, { expect: "html" })
    : { ...(await ctx.http.getText(UPDATES_URL, { expect: "html" })), unchanged: false };
  if (unchanged) return [];
  const seen = new Set<string>();
  const refs: DocumentRef[] = [];
  for (const u of parseUpdatesPage(text, response.url)) {
    const ref = refFor(u);
    if (seen.has(ref.externalId)) continue;
    seen.add(ref.externalId);
    refs.push(ref);
  }
  return refs;
}

// The Updates page as read in this run, for the technical updates (which
// have no page of their own): fetched once per run, not once per update.
const pageThisRun = new WeakMap<LibraryAdapterContext, Promise<{ response: LibraryHttpResponse; updates: PmUpdate[] }>>();

function updatesPage(ctx: LibraryAdapterContext) {
  let page = pageThisRun.get(ctx);
  if (!page) {
    page = ctx.http.get(UPDATES_URL, { expect: "html" }).then((response) => ({ response, updates: parseUpdatesPage(bodyText(response), response.url) }));
    page.catch(() => pageThisRun.delete(ctx));
    pageThisRun.set(ctx, page);
  }
  return page;
}

/** The link the legal-update monitor gives the same update: its document, else its first affected section, else the Updates page. */
function monitorUrl(listing: Listing): string {
  return listing.readMoreUrl ?? listing.affected.find((a) => a.url)?.url ?? UPDATES_URL;
}

export const uscisPolicyManualUpdatesAdapter: LibrarySourceAdapter = {
  code: "uscis_policy_manual_updates",
  group: "uscis-policy-manual",
  name: "USCIS Policy Manual updates and policy alerts",
  description:
    "Every update to the USCIS Policy Manual: the policy alerts, read from their PDFs, and the technical updates, each with USCIS's summary, the date and the sections it affected.",
  coverage: "Every update the Policy Manual's Updates page lists, from the manual's first updates to today.",
  cadence: "Daily",
  officialUrl: UPDATES_URL,
  hosts: USCIS_HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 90,
  maxDocumentsPerDailyRun: 120,

  async listUpdates(ctx) {
    return { refs: await readUpdates(ctx, true) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const all = await readUpdates(ctx);
    const offset = isCursor(cursor) ? cursor.offset : 0;
    if (offset >= all.length) return { refs: [], nextCursor: null, progress: "every update is done" };
    const refs = all.slice(offset, offset + PAGE_SIZE);
    const next = offset + refs.length;
    return { refs, nextCursor: next < all.length ? { offset: next } : null, progress: `updates ${offset + 1} to ${next} of ${all.length}, newest first` };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.header) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const published = dateOf(listing);
    const affectedLines = listing.affected.map((a) => [a.citation, a.title].filter(Boolean).join(" - "));
    const isAlert = /^POLICY ALERT\b/i.test(listing.header);
    const base = {
      externalId: ref.externalId,
      docType: "policy_alert" as const,
      title: listing.header,
      agency: USCIS_AGENCY,
      publishedDate: published,
      precedentialStatus: "not_applicable" as const,
      officialUrl: monitorUrl(listing),
    };
    const metadataBase = {
      updateKind: isAlert ? "Policy alert" : /^Technical Update\b/i.test(listing.header) ? "Technical update" : "Update",
      summary: listing.summary || undefined,
      affectedSections: affectedLines,
      affectedSectionUrls: listing.affected.map((a) => a.url).filter(Boolean),
      listedOn: UPDATES_URL,
    };

    if (!listing.readMoreUrl) {
      const page = await updatesPage(ctx);
      const entry = page.updates.find((u) => idOf(u) === ref.externalId);
      if (!entry) return { kind: "skip", reason: `${ref.externalId} is no longer on the Updates page.` };
      const effectiveText = statedEffectiveDate(entry.summary);
      return {
        kind: "document",
        document: {
          ...base,
          citations: [],
          effectiveDate: parseStatedDate(effectiveText),
          text: cleanText(htmlToDocumentText(entry.html)),
          metadata: {
            ...metadataBase,
            statedDates: { listed: listing.dateText, ...(effectiveText ? { effective: effectiveText } : {}) },
          },
          fetch: { response: page.response },
        },
      };
    }

    const file = await fetchUscisFile(ctx, listing.readMoreUrl, ref.known);
    if (file.kind === "not_modified") return { kind: "not_modified" };
    if (file.kind === "other") return { kind: "skip", reason: `${listing.readMoreUrl} is ${file.response.contentType || "an unknown file type"}, which is not read.` };
    let text: string;
    let textKind: "full" | "none" = "full";
    let extra: Record<string, unknown> = {};
    let extraction: Record<string, unknown> | undefined;
    let original: { bytes: Buffer; contentType: string; extension: string } | null = null;
    if (file.kind === "pdf") {
      text = file.pdf.pagesWithText > 0 ? file.pdf.text : "";
      textKind = file.pdf.pagesWithText > 0 ? "full" : "none";
      extraction = pdfExtraction(file.pdf);
      original = pdfOriginal(file.response);
      const header = parseMemoHeader(text);
      extra = {
        ...(header.number ? { alertNumber: header.number } : {}),
        ...(header.subject ? { subject: header.subject } : {}),
        ...(header.dateText ? { issuedAsPrinted: header.dateText } : {}),
        pageCount: file.pdf.pageCount,
        supersedes: supersessionStatements(text, header.number),
      };
      if (file.pdf.truncated) ctx.note(`${ref.externalId}: only the first ${file.pdf.pagesRead} page(s) of ${file.pdf.pageCount} were read (size caps).`);
    } else {
      const page = parseUscisPage(file.html);
      if (!page) return { kind: "skip", reason: `${file.response.url} has no article to read.` };
      text = htmlToDocumentText(page.articleHtml);
      extra = { pageTitle: page.title };
    }
    const effectiveText = statedEffectiveDate(listing.summary) ?? statedEffectiveDate(text.slice(0, 6000));
    const number = typeof extra.alertNumber === "string" ? extra.alertNumber : null;
    return {
      kind: "document",
      document: {
        ...base,
        citations: number ? [number] : [],
        effectiveDate: parseStatedDate(effectiveText),
        originalUrl: file.response.url !== base.officialUrl ? file.response.url : null,
        text,
        textKind,
        metadata: {
          ...metadataBase,
          ...extra,
          statedDates: {
            listed: listing.dateText,
            ...(typeof extra.issuedAsPrinted === "string" ? { issued: extra.issuedAsPrinted } : {}),
            ...(effectiveText ? { effective: effectiveText } : {}),
          },
        },
        original,
        fetch: { response: file.response, ...(extraction ? { extraction } : {}) },
      },
    };
  },

  legalUpdateItem(document) {
    const summary = typeof document.metadata?.summary === "string" ? document.metadata.summary : "";
    const affected = Array.isArray(document.metadata?.affectedSections) ? (document.metadata.affectedSections as string[]) : [];
    return {
      itemType: "USCIS Policy Manual update",
      excerpt: [document.title, summary, affected.length ? `Affected Sections: ${affected.join("; ")}` : ""].filter(Boolean).join("\n"),
      publishedDateText: (document.metadata?.statedDates as { listed?: string } | undefined)?.listed ?? null,
      listedOnUrl: UPDATES_URL,
    };
  },
};
