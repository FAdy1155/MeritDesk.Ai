import { extractPdfText } from "../../extract/pdf";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import { feeEntryUrl, parseFeeEntry, parseFormPage, parseG1055Page, parseSlashDate, pdfFormFacts, type G1055Page } from "./parse";
import { USCIS_AGENCY, USCIS_HOST, isUscisUrl, readRunPage, recallPage } from "./run-pages";

// Form G-1055, Fee Schedule, as USCIS publishes it at
// https://www.uscis.gov/g-1055, in three kinds of document:
// - the page itself: the current edition, the alerts on fee changes, and
//   the rules on paying, fee waivers, exemptions and the Pub. L. 119-21
//   fees;
// - the fee schedule PDF it links (Form G-1055 itself);
// - one entry per form or fee from the page's "Select a Form for Fee
//   Information" list: the fee table and notes USCIS shows for it. The page
//   shows an entry through its own GET filter (action /g-1055, field
//   topic_id, the choice's value); that is the URL read for each entry.
//
// - Daily and backfill read the same thing: the page, then whatever
//   changed. Every entry's fingerprint includes the page's edition date, so
//   a new edition of the schedule fetches every entry again (about 130, 22
//   minutes at uscis.gov's 10 seconds a request); otherwise entries are
//   rechecked every recheckAfterDays.
// - Earlier editions are kept only as stored versions from when this
//   collector read them: USCIS does not publish past fee schedules here.
//
// US government work: public domain.

const G1055_URL = "https://www.uscis.gov/g-1055";
const HOSTS = [USCIS_HOST] as const;

type PageListing = { kind: "page" };
type PdfListing = { kind: "pdf"; label: string; pageEditionText: string | null; pageEditionDateText: string | null };
type FeeListing = { kind: "fee"; id: string; marker: string | null; label: string };

async function readSchedulePage(ctx: LibraryAdapterContext): Promise<{ page: G1055Page; pageUrl: string }> {
  const { text, response } = await readRunPage(ctx, G1055_URL);
  const page = parseG1055Page(text, response.url);
  if (!page.isFormPage || page.number?.toUpperCase() !== "G-1055") throw new LibraryLayoutError(G1055_URL, "the page is not the G-1055 form page");
  if (!page.pdf) throw new LibraryLayoutError(G1055_URL, "no link to the fee schedule PDF");
  if (!page.filter) throw new LibraryLayoutError(G1055_URL, "no fee filter form (GET, one field)");
  if (page.options.length < 50) throw new LibraryLayoutError(G1055_URL, `only ${page.options.length} choices under "Select a Form for Fee Information"`);
  if (!page.editionDateText) ctx.note("The G-1055 page states no edition date.");
  return { page, pageUrl: response.url };
}

async function listAll(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { page, pageUrl } = await readSchedulePage(ctx);
  const edition = page.editionDateText ?? "";
  const refs: DocumentRef[] = [
    {
      externalId: "Form G-1055",
      url: pageUrl,
      title: "Form G-1055, Fee Schedule",
      fingerprint: sha256Hex([page.text, page.editionText ?? "", page.pdf!.url].join("\u0000")).slice(0, 32),
      listing: { kind: "page" } satisfies PageListing,
    },
  ];
  if (isUscisUrl(page.pdf!.url)) {
    refs.push({
      externalId: `file ${new URL(page.pdf!.url).pathname}`,
      url: page.pdf!.url,
      title: page.pdf!.label,
      fingerprint: sha256Hex([page.pdf!.url, page.pdf!.label, edition].join("\u0000")).slice(0, 32),
      listing: { kind: "pdf", label: page.pdf!.label, pageEditionText: page.editionText, pageEditionDateText: page.editionDateText } satisfies PdfListing,
    });
  } else ctx.note(`The fee schedule PDF link (${page.pdf!.url}) is not on ${USCIS_HOST}; left out.`);
  for (const option of page.options) {
    refs.push({
      externalId: `G-1055 fee ${option.id}`,
      url: feeEntryUrl(page.filter!, option.id),
      title: option.label,
      fingerprint: sha256Hex([option.id, option.marker ?? "", option.label, edition].join("\u0000")).slice(0, 32),
      listing: { kind: "fee", id: option.id, marker: option.marker, label: option.label } satisfies FeeListing,
    });
  }
  return refs;
}

function normalized(s: string): string {
  return s.replace(/[\u2018\u2019]/g, "'").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
}

async function pageDocument(ctx: LibraryAdapterContext, ref: DocumentRef): Promise<FetchDocumentResult> {
  const read = recallPage(ctx, ref.url, { forget: true }) ?? (await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null }));
  if (read.response.notModified) return { kind: "not_modified" };
  const page = parseG1055Page(read.text, read.response.url);
  if (!page.isFormPage) throw new LibraryLayoutError(ref.url, "the page is not the G-1055 form page");
  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType: "fee_schedule",
      title: `Form ${page.number ?? "G-1055"}, ${page.name ?? "Fee Schedule"}`,
      citations: ["Form G-1055"],
      agency: USCIS_AGENCY,
      editionDate: parseSlashDate(page.editionDateText, ctx.now),
      precedentialStatus: "not_applicable",
      officialUrl: read.response.url,
      text: page.text,
      metadata: {
        kind: "fee_schedule_page",
        formNumber: "G-1055",
        editionText: page.editionText,
        alerts: page.alerts,
        pdf: page.pdf,
        feeEntries: page.options.length,
        lastReviewedUpdated: page.lastReviewed?.text ?? null,
        statedDates: { edition: page.editionDateText, lastReviewedUpdated: page.lastReviewed?.text ?? null },
      },
      fetch: { response: read.response },
    },
  };
}

async function pdfDocument(ctx: LibraryAdapterContext, ref: DocumentRef, listing: PdfListing): Promise<FetchDocumentResult> {
  const response = await ctx.http.get(ref.url, { expect: "pdf", conditional: ref.known ?? null });
  if (response.notModified) return { kind: "not_modified" };
  const pdf = await extractPdfText(response.body);
  const facts = pdfFormFacts(pdf.text);
  const fileEdition = parseSlashDate(facts.editionText, ctx.now);
  const pageEdition = parseSlashDate(listing.pageEditionDateText, ctx.now);
  if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType: "fee_schedule",
      title: listing.label,
      citations: [],
      agency: USCIS_AGENCY,
      editionDate: fileEdition,
      precedentialStatus: "not_applicable",
      officialUrl: ref.url,
      originalUrl: response.url !== ref.url ? response.url : null,
      text: pdf.pagesWithText > 0 ? pdf.text : "",
      textKind: pdf.pagesWithText > 0 ? "full" : "none",
      metadata: {
        kind: "fee_schedule_pdf",
        formNumber: "G-1055",
        formPage: G1055_URL,
        editionPrinted: facts.editionText,
        pageEditionText: listing.pageEditionText,
        ...(fileEdition && pageEdition ? { editionAgreesWithPage: fileEdition === pageEdition } : {}),
        statedDates: { edition: facts.editionText, pageEdition: listing.pageEditionDateText },
        pageCount: pdf.pageCount,
        ...(pdf.pagesWithText === 0 ? { textNote: "The PDF has no text layer; no OCR is run." } : {}),
      },
      original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
      fetch: { response, extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated } },
    },
  };
}

async function feeDocument(ctx: LibraryAdapterContext, ref: DocumentRef, listing: FeeListing): Promise<FetchDocumentResult> {
  const { text, response } = await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null });
  if (response.notModified) return { kind: "not_modified" };
  const entry = parseFeeEntry(text, response.url);
  if (entry.headings !== 1 || !entry.heading) throw new LibraryLayoutError(ref.url, `${entry.headings} fee entries shown for one choice (expected 1)`);
  if (normalized(entry.heading) !== normalized(listing.label)) {
    throw new LibraryLayoutError(ref.url, `the entry shown ("${entry.heading}") is not the one chosen ("${listing.label}")`);
  }
  // The entry is shown on the G-1055 page itself, so the schedule's edition is on the same response.
  const page = parseFormPage(text, response.url);
  const formNumber = /^([A-Z]{1,4}-\d+[A-Z0-9]*)\b/.exec(entry.heading)?.[1] ?? null;
  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType: "fee_schedule",
      title: `Fee Schedule (G-1055): ${entry.heading}`,
      citations: [],
      agency: USCIS_AGENCY,
      editionDate: parseSlashDate(page.editionDateText, ctx.now),
      precedentialStatus: "not_applicable",
      officialUrl: response.url,
      text: entry.text,
      metadata: {
        kind: "fee_entry",
        feeEntryId: listing.id,
        marker: listing.marker,
        entryHeading: entry.heading,
        ...(formNumber ? { formNumber } : {}),
        ...(entry.formPageUrl ? { formPage: entry.formPageUrl } : {}),
        scheduleEditionText: page.editionText,
        statedDates: { scheduleEdition: page.editionDateText, lastReviewedUpdated: page.lastReviewed?.text ?? null },
        listedOn: G1055_URL,
      },
      fetch: { response },
    },
  };
}

export const uscisG1055Adapter: LibrarySourceAdapter = {
  code: "uscis_g1055",
  group: "uscis-forms-fees",
  name: "USCIS Fee Schedule (Form G-1055)",
  description:
    "USCIS's fee schedule: the G-1055 page with its current edition and alerts on fee changes, the fee schedule PDF, and the fee entry USCIS shows for each form and fee.",
  coverage: "The current edition of Form G-1055: its page, its PDF, and every entry under \"Select a Form for Fee Information\" (about 130); earlier editions only as stored versions.",
  cadence: "Daily",
  officialUrl: G1055_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 14,

  async listUpdates(ctx) {
    return { refs: await listAll(ctx) };
  },

  async backfill(ctx) {
    // The page lists the whole current schedule: one chunk is the whole history it offers.
    return { refs: await listAll(ctx), nextCursor: null, progress: "the whole current fee schedule" };
  },

  async fetchDocument(ctx, ref) {
    const listing = ref.listing as PageListing | PdfListing | FeeListing | undefined;
    if (listing?.kind === "page") return pageDocument(ctx, ref);
    if (listing?.kind === "pdf") return pdfDocument(ctx, ref, listing);
    if (listing?.kind === "fee") return feeDocument(ctx, ref, listing);
    return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
  },

  legalUpdateItem(document) {
    if (document.metadata?.kind !== "fee_schedule_page") return null;
    const edition = (document.metadata.statedDates as { edition?: string | null } | undefined)?.edition ?? null;
    return {
      itemType: "USCIS form update",
      excerpt: [document.title, ...(Array.isArray(document.metadata.alerts) ? (document.metadata.alerts as string[]) : [])].join("\n\n"),
      publishedDateText: edition ? `Edition Date: ${edition}` : null,
      listedOnUrl: G1055_URL,
    };
  },
};
