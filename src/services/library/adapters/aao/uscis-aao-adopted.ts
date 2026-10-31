import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { extractPdfText } from "../../extract/pdf";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import { parseAdoptedDecisions, textLayerNote, type AdoptedEntry } from "./parse";

// Adopted AAO decisions: non-precedent decisions USCIS has "adopted" as
// policy guidance for its officers, each identified by its own citation form
// ("Matter of F-M- Co., Adopted Decision 2020-01 (AAO May 5, 2020)") and a
// cover memorandum. USCIS lists them on its AAO Decisions page, the current
// ones first and then "Previous adopted decisions, now superseded by USCIS
// policy or by designation of the adopted decision as a precedent
// decision", each linking the decision (or the memorandum package that
// carries it) as a PDF on uscis.gov.
//
// - Daily and backfill: the page's two lists (about 25 entries), one ref per
//   designation; unchanged entries are skipped by their fingerprint.
// - A superseded entry is stored as withdrawn, with the page's own words for
//   what superseded it; when that is another adopted decision on the page
//   ("overruled by Matter of Vazquez, Adopted Decision 07-0006"), it is named
//   as the superseding document.
//
// US government work: public domain, stored in full. An adopted decision is
// not a precedent decision (only the Secretary, with the Attorney General's
// approval, designates those): stored as non_precedential, with the page's
// description of what adoption means in metadata.

const PAGE_URL = "https://www.uscis.gov/administrative-appeals/aao-decisions";
const HOSTS = ["www.uscis.gov"] as const;

type Listing = Omit<AdoptedEntry, "pdfUrl"> & { reviewedText: string | null; intro: string | null };

async function listAll(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await ctx.http.getText(PAGE_URL, { expect: "html" });
  const page = parseAdoptedDecisions(text, response.url);
  if (!page.recognized) throw new LibraryLayoutError(PAGE_URL, "no Adopted AAO Decisions section");
  if (page.entries.length === 0) throw new LibraryLayoutError(PAGE_URL, "no adopted decision could be read in the Adopted AAO Decisions section");
  for (const note of page.notes) ctx.note(note);
  const seen = new Set<string>();
  const refs: DocumentRef[] = [];
  for (const entry of page.entries) {
    const externalId = `Adopted Decision ${entry.designation}`;
    if (seen.has(externalId)) {
      ctx.note(`${externalId} is listed twice; the first entry was kept.`);
      continue;
    }
    seen.add(externalId);
    const { pdfUrl, ...rest } = entry;
    const listing: Listing = { ...rest, reviewedText: page.reviewedText, intro: page.intro };
    refs.push({
      externalId,
      url: pdfUrl,
      title: entry.citation,
      fingerprint: sha256Hex([entry.entryText, pdfUrl, entry.superseded ? "superseded" : "current", ...entry.supersededLinks.map((l) => l.url)].join("\u0000")).slice(0, 32),
      listing,
    });
  }
  return refs;
}

export const uscisAaoAdoptedAdapter: LibrarySourceAdapter = {
  code: "uscis_aao_adopted_decisions",
  group: "aao-decisions",
  name: "Adopted AAO decisions (USCIS)",
  description:
    "AAO non-precedent decisions USCIS has adopted as policy guidance for its officers, current and superseded, as listed on USCIS's AAO Decisions page, each read from its PDF.",
  coverage: "Every adopted decision the AAO Decisions page lists, current and superseded (2005 to the present).",
  cadence: "Daily",
  officialUrl: PAGE_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 90,

  async listUpdates(ctx) {
    return { refs: await listAll(ctx) };
  },

  async backfill(ctx) {
    // The page lists every adopted decision, so one chunk is the whole history.
    const refs = await listAll(ctx);
    return { refs, nextCursor: null, progress: `the AAO Decisions page's ${refs.length} adopted decisions` };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.designation || !listing.citation) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const response = await ctx.http.get(ref.url, { expect: "pdf", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const pdf = await extractPdfText(response.body);
    if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
    const hasText = pdf.pagesWithText > 0;
    const textNote = textLayerNote(pdf.pageCount, pdf.pagesWithText);
    // The cover memorandum's number ("PM-602-0177"), printed at the top of its first page, for a lookup by memorandum.
    const memo = /\bPM-\d{3}-\d{4}(?:\.\d{1,2})?\b/.exec(pdf.text.split("[Page 2]")[0].slice(0, 3000))?.[0] ?? null;
    // "overruled by Matter of Vazquez, Adopted Decision 07-0006 (...)": the superseding decision is on this page too.
    const by = listing.supersededText ? /Adopted Decision\s+(\d{2,4}-\d{2,4})/i.exec(listing.supersededText)?.[1] : undefined;
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "decision",
        title: listing.name,
        // The page's citation, and the designation on its own (as the page writes it) for a lookup by designation.
        citations: [listing.citation, `Adopted Decision ${listing.designation}`, ...(memo ? [memo] : [])],
        court: "Administrative Appeals Office",
        agency: "U.S. Citizenship and Immigration Services",
        decisionDate: parseStatedDate(listing.dateText),
        precedentialStatus: "non_precedential",
        officialUrl: ref.url,
        originalUrl: response.url !== ref.url ? response.url : null,
        text: hasText ? pdf.text : "",
        textKind: hasText ? "full" : "none",
        metadata: {
          designation: `Adopted Decision ${listing.designation}`,
          ...(memo ? { policyMemorandumNumber: memo } : {}),
          listedCitation: listing.citation,
          listedName: listing.name,
          listStatus: listing.superseded ? "superseded" : "current",
          ...(listing.supersededText ? { supersededText: listing.supersededText } : {}),
          ...(listing.supersededLinks.length ? { supersededLinks: listing.supersededLinks } : {}),
          ...(listing.intro ? { adoptedDecisionsNote: listing.intro } : {}),
          listedOn: PAGE_URL,
          statedDates: {
            ...(listing.dateText ? { decided: listing.dateText } : {}),
            ...(listing.reviewedText ? { pageLastReviewedUpdated: listing.reviewedText } : {}),
          },
          pageCount: pdf.pageCount,
          ...(textNote ? { textNote } : {}),
        },
        original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
        fetch: { response, extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated } },
        withdrawn: listing.superseded
          ? { reason: `USCIS lists it among previous adopted decisions, now superseded${listing.supersededText ? `: ${listing.supersededText}` : ""}.` }
          : null,
        supersededBy: by && by !== listing.designation ? { externalId: `Adopted Decision ${by}`, note: listing.supersededText ?? undefined } : null,
      },
    };
  },

  legalUpdateItem(document) {
    // A newly adopted decision comes with a USCIS policy memorandum announcing it; superseded ones are not news.
    // The excerpt defaults to the opening of the PDF: the cover memorandum, in USCIS's words.
    if (document.withdrawn) return null;
    const decided = (document.metadata?.statedDates as { decided?: string } | undefined)?.decided ?? null;
    return { itemType: "USCIS policy memorandum", publishedDateText: decided, listedOnUrl: PAGE_URL };
  },
};
