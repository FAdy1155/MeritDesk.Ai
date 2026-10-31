import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText, htmlToText } from "../../extract/html";
import { extractPdfText } from "../../extract/pdf";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibraryDocType,
  type LibrarySourceAdapter,
} from "../../types";
import {
  articleTime,
  bodyField,
  findLink,
  pageHeading,
  parseFormHeader,
  parseFormsPage,
  revisionYear,
  type FormEntry,
  type FormLink,
} from "./parse";

// EOIR's forms, from its Forms & Fees page on justice.gov: one accordion
// per form, each linking the English PDF (and, for some, its instructions
// and translated versions) with the purpose, fee, filing channels and the
// revision date EOIR prints. Each form is one document keyed by its number
// (EOIR-26, EOIR-33/IC): its PDF text, then the English instructions EOIR
// links under it, with the page's entry kept as its summary. A new edition
// replaces the stored one as a new version (the old text is kept in
// library_document_versions). Translated versions are linked from the
// metadata, not collected. The USCIS forms the page also lists (I-485,
// I-589, I-881 and others) belong to the USCIS forms collector; the fees
// EOIR states for them are kept with the page itself, which is collected
// as a document, as is EOIR's "Types of Appeals, Motions, and Required
// Fees" page.
//
// - Daily and backfill: the whole page (about two dozen forms); unchanged
//   forms are skipped by their fingerprint, and a re-read after
//   RECHECK_DAYS is a conditional GET (the PDFs carry Last-Modified). The
//   fee page is read every day (no fingerprint): fees change by rule.
//
// US government work: public domain, stored in full.

const FORMS_URL = "https://www.justice.gov/eoir/eoir-forms";
const HOSTS = ["www.justice.gov", "justice.gov"] as const;
const AGENCY = "Executive Office for Immigration Review";
const RECHECK_DAYS = 14;
const MAX_INSTRUCTIONS = 3;

type FormListing = { kind: "form" } & FormEntry;
type PageListing = { kind: "page"; docType: LibraryDocType };

async function readListing(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await ctx.http.getText(FORMS_URL, { expect: "html" });
  const body = bodyField(text);
  if (!body) throw new LibraryLayoutError(FORMS_URL, "no body field");
  const parsed = parseFormsPage(body, response.url);
  for (const note of parsed.notes) ctx.note(note);
  if (parsed.entries.length === 0) throw new LibraryLayoutError(FORMS_URL, `no EOIR form among ${parsed.accordions} accordion(s)`);

  const refs: DocumentRef[] = parsed.entries.map((entry) => {
    const listing: FormListing = { kind: "form", ...entry };
    return {
      externalId: entry.formNumber,
      url: entry.form!.url,
      title: entry.heading,
      fingerprint: sha256Hex(
        [entry.heading, entry.form!.url, entry.instructions.map((i) => i.url).join("|"), entry.translations.map((t) => t.url).join("|"), entry.entryText].join("\u0000")
      ).slice(0, 32),
      listing,
    };
  });
  // The page itself: fetched again only when its text changed.
  refs.push({
    externalId: new URL(response.url).pathname,
    url: response.url,
    title: pageHeading(text) ?? "Forms & Fees",
    fingerprint: sha256Hex(htmlToText(body)).slice(0, 32),
    listing: { kind: "page", docType: "web_guidance" } satisfies PageListing,
  });
  const fees = findLink(body, response.url, /^Types of Appeals, Motions, and Required Fees/i);
  if (fees) {
    refs.push({
      externalId: new URL(fees.url).pathname,
      url: fees.url,
      title: fees.label,
      listing: { kind: "page", docType: "fee_schedule" } satisfies PageListing,
    });
  } else {
    ctx.note('The Forms & Fees page no longer links "Types of Appeals, Motions, and Required Fees"; the fee page was not read.');
  }
  return refs;
}

async function fetchPage(ctx: LibraryAdapterContext, ref: DocumentRef, listing: PageListing): Promise<FetchDocumentResult> {
  const { text: html, response } = await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null });
  if (response.notModified) return { kind: "not_modified" };
  const body = bodyField(html);
  if (!body) throw new LibraryLayoutError(response.url, "no body field");
  const modified = articleTime(html, "modified_time");
  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType: listing.docType,
      title: pageHeading(html) ?? ref.title ?? ref.url,
      citations: [],
      agency: AGENCY,
      editionDate: parseStatedDate(modified),
      precedentialStatus: "not_applicable",
      officialUrl: response.url,
      text: htmlToDocumentText(body),
      metadata: { statedDates: modified ? { pageModified: modified } : {} },
      fetch: { response },
    },
  };
}

async function fetchForm(ctx: LibraryAdapterContext, ref: DocumentRef, listing: FormListing): Promise<FetchDocumentResult> {
  if (!listing.form) return { kind: "skip", reason: `${ref.externalId}: the listing names no form PDF.` };
  const response = await ctx.http.get(ref.url, { expect: "pdf", conditional: ref.known ?? null });
  if (response.notModified) return { kind: "not_modified" };
  const pdf = await extractPdfText(response.body);
  if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
  const header = parseFormHeader(pdf.text);
  let text = pdf.pagesWithText > 0 ? pdf.text : "";

  const instructions: (FormLink & { finalUrl: string; pages: number; pagesWithText: number })[] = [];
  for (const link of listing.instructions.slice(0, MAX_INSTRUCTIONS)) {
    const file = await ctx.http.get(link.url, { expect: "pdf" });
    const part = await extractPdfText(file.body);
    instructions.push({ ...link, finalUrl: file.url, pages: part.pageCount, pagesWithText: part.pagesWithText });
    if (part.pagesWithText > 0) text = `${text}\n\n${link.label}\n\n${part.text}`;
  }

  const statedDates: Record<string, string> = {};
  if (listing.revisedText) statedDates.revisedOnPage = listing.revisedText;
  if (header.revision) statedDates.revisionOnForm = header.revision;
  if (header.expires) statedDates.ombExpiration = header.expires;
  const year = revisionYear(header.revision) ?? revisionYear(listing.revisedText);
  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType: "form",
      title: listing.heading,
      citations: [`Form ${listing.formNumber}`],
      agency: AGENCY,
      // EOIR states a form's edition as a month and year ("Rev. Mar. 2026"), so no full edition date is set.
      documentYear: year,
      precedentialStatus: "not_applicable",
      officialUrl: ref.url,
      originalUrl: response.url !== ref.url ? response.url : null,
      text,
      textKind: text ? "full" : "none",
      metadata: {
        formNumber: listing.formNumber,
        summary: listing.entryText,
        summaryKind: "forms page entry",
        listedOn: FORMS_URL,
        ...(header.omb ? { ombNumber: header.omb } : {}),
        statedDates,
        ...(instructions.length ? { instructions } : {}),
        ...(listing.translations.length ? { translations: listing.translations } : {}),
        pageCount: pdf.pageCount,
        ...(pdf.pagesWithText === 0 ? { textNote: "The form PDF has no text layer; no OCR is run." } : {}),
      },
      original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
      fetch: { response, extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated } },
    },
  };
}

export const eoirFormsAdapter: LibrarySourceAdapter = {
  code: "eoir_forms",
  group: "eoir-manuals-memos-forms",
  name: "EOIR forms",
  description:
    "EOIR's own forms (EOIR-26 through EOIR-61) as its Forms & Fees page links them, each with the form's text, its English instructions and the page's entry for it (purpose, fee, filing channels, revision), plus the Forms & Fees page and EOIR's table of appeal and motion fees.",
  coverage:
    "The current English edition of every EOIR form the Forms & Fees page links; earlier editions are kept as versions from the day the library first read a form. Translated versions are linked, not collected.",
  cadence: "Daily",
  officialUrl: FORMS_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: RECHECK_DAYS,

  async listUpdates(ctx) {
    return { refs: await readListing(ctx) };
  },

  async backfill(ctx): Promise<BackfillChunk> {
    // The page lists every current form, so one chunk is the whole history EOIR offers.
    const refs = await readListing(ctx);
    return { refs, nextCursor: null, progress: `the whole Forms & Fees page (${refs.length} documents)` };
  },

  async fetchDocument(ctx, ref) {
    const listing = ref.listing as FormListing | PageListing | undefined;
    if (listing?.kind === "form") return fetchForm(ctx, ref, listing);
    if (listing?.kind === "page") return fetchPage(ctx, ref, listing);
    return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
  },

  legalUpdateItem(document) {
    if (document.docType !== "form") return null;
    const dates = document.metadata?.statedDates as { revisionOnForm?: string; revisedOnPage?: string } | undefined;
    const summary = typeof document.metadata?.summary === "string" ? document.metadata.summary : "";
    return {
      itemType: "EOIR form",
      crossSourceKey: null,
      excerpt: `${document.title}\n${summary}`,
      publishedDateText: dates?.revisionOnForm ?? dates?.revisedOnPage ?? null,
      listedOnUrl: FORMS_URL,
    };
  },
};
