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
import { parsePrecedentHeader, parsePrecedentPage, textLayerNote, type PrecedentEntry } from "./parse";

// AAO precedent decisions. They are designated by the Secretary of Homeland
// Security with the Attorney General's approval and published by EOIR in
// Administrative Decisions Under Immigration and Nationality Laws (I&N
// Dec.); USCIS's AAO Decisions page sends readers to EOIR's DHS/AAO/INS
// Decisions page for them. That page lists, volume by volume, the
// precedents of the AAO and of the legacy INS and DHS officers (Regional
// Commissioners, District Directors, the Commissioner), each with its
// citation and PDF.
//
// Only the entries whose citation names the AAO ("(AAO 2016)") are taken
// here. When this collector was written, 525 of the page's 536 entries were
// also on EOIR's AG/BIA volume pages, which the AG and BIA precedents
// collector reads (the rest were the same decisions under a slightly
// different page number, and the newest AAO precedent, not yet on its
// volume page); taking the legacy INS entries here would only store them
// twice. The AAO entries are taken because this group is where the AAO's
// precedents belong and because EOIR lists a new one here first. The
// cross-source key intdec:<n> is the AG and BIA collector's, so a decision
// reaches the legal updates once.
//
// - Daily and backfill: the one page (about ten AAO entries); unchanged
//   entries are skipped by their fingerprint.
// - Each decision is read from its PDF: the "Cite as ... Interim Decision
//   #n" line, the "Decided" date (kept only when its year agrees with the
//   citation's) and the official headnote, verbatim.
// - justice.gov's robots.txt asks for 10 seconds between requests; older
//   links redirect once.
//
// US government work: public domain, stored in full.

const PAGE_URL = "https://www.justice.gov/eoir/dhs-aao-ins-decisions";
const HOSTS = ["www.justice.gov", "justice.gov"] as const;

type Listing = Omit<PrecedentEntry, "pdfUrl"> & { pageUpdated: string | null };

const isAao = (entry: PrecedentEntry) => entry.issuer !== null && /\bAAO\b/.test(entry.issuer);

async function listAll(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await ctx.http.getText(PAGE_URL, { expect: "html" });
  const page = parsePrecedentPage(text, response.url);
  if (!page.recognized) throw new LibraryLayoutError(PAGE_URL, "no I&N Dec. entries with a PDF link in the page body");
  for (const note of page.notes) ctx.note(note);
  const aao = page.entries.filter(isAao);
  if (aao.length === 0) throw new LibraryLayoutError(PAGE_URL, `${page.entries.length} entries read, none of them an AAO decision`);
  const seen = new Set<string>();
  const refs: DocumentRef[] = [];
  for (const entry of aao) {
    const externalId = `${entry.volume} I&N Dec. ${entry.page}`;
    if (seen.has(externalId)) {
      ctx.note(`${externalId} is listed twice; the first entry was kept.`);
      continue;
    }
    seen.add(externalId);
    const { pdfUrl, ...rest } = entry;
    const listing: Listing = { ...rest, pageUpdated: page.pageUpdated };
    refs.push({
      externalId,
      url: pdfUrl,
      title: `Matter of ${entry.name}, ${entry.citation}`,
      fingerprint: sha256Hex([entry.entryText, pdfUrl].join("\u0000")).slice(0, 32),
      listing,
    });
  }
  return refs;
}

export const eoirAaoPrecedentsAdapter: LibrarySourceAdapter = {
  code: "eoir_aao_precedent_decisions",
  group: "aao-decisions",
  name: "AAO precedent decisions (EOIR)",
  description:
    "Precedent decisions of the USCIS Administrative Appeals Office published in I&N Dec., as EOIR lists them on its DHS/AAO/INS Decisions page, each read from its PDF with its official headnote.",
  coverage:
    "Every decision on EOIR's DHS/AAO/INS Decisions page whose citation names the AAO (2010 to the present). The page's legacy INS and DHS officer decisions are held by the AG and BIA precedents collector, from EOIR's volume pages.",
  cadence: "Daily",
  officialUrl: PAGE_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 60,

  async listUpdates(ctx) {
    return { refs: await listAll(ctx) };
  },

  async backfill(ctx) {
    // The page lists every AAO precedent, so one chunk is the whole history.
    const refs = await listAll(ctx);
    return { refs, nextCursor: null, progress: `the DHS/AAO/INS Decisions page's ${refs.length} AAO precedent decisions` };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.citation || !listing.name) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const response = await ctx.http.get(ref.url, { expect: "pdf", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const pdf = await extractPdfText(response.body);
    const header = parsePrecedentHeader(pdf.text);
    const decided = parseStatedDate(header.decidedText);
    const decisionDate = decided && listing.year && Math.abs(Number(decided.slice(0, 4)) - listing.year) <= 1 ? decided : null;
    // The decision's own "Cite as" line must name the listed volume and page, or the link is to another decision.
    const citeMatches = header.citeAs ? header.citeAs.startsWith(`${listing.volume} I&N Dec. ${listing.page} `) : null;
    if (citeMatches === false) ctx.note(`${ref.externalId}: the PDF cites itself as ${header.citeAs}; the listing's citation is kept.`);
    const idNumber = header.interimDecisionNumber ?? listing.idNumber;
    if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
    const hasText = pdf.pagesWithText > 0;
    const textNote = textLayerNote(pdf.pageCount, pdf.pagesWithText);
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "decision",
        title: `Matter of ${listing.name}`,
        citations: [listing.citation, ...(idNumber ? [`Interim Decision ${idNumber}`] : [])],
        court: "Administrative Appeals Office",
        agency: "U.S. Citizenship and Immigration Services",
        decisionDate,
        documentYear: listing.year,
        precedentialStatus: "precedential",
        officialUrl: ref.url,
        originalUrl: response.url !== ref.url ? response.url : null,
        text: hasText ? pdf.text : "",
        textKind: hasText ? "full" : "none",
        metadata: {
          volume: listing.volume,
          page: listing.page,
          ...(idNumber ? { interimDecisionNumber: idNumber } : {}),
          listedName: listing.name,
          listedCitation: listing.citation,
          issuerAsCited: listing.issuer,
          ...(listing.note ? { listedNote: listing.note } : {}),
          ...(header.citeAs ? { citeAs: header.citeAs } : {}),
          ...(header.headnote ? { summary: header.headnote, summaryKind: "headnote" } : {}),
          listedOn: PAGE_URL,
          statedDates: {
            ...(header.decidedText ? { decided: header.decidedText } : {}),
            ...(listing.pageUpdated ? { listingPage: listing.pageUpdated } : {}),
          },
          pageCount: pdf.pageCount,
          ...(textNote ? { textNote } : {}),
        },
        original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
        fetch: { response, extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated } },
      },
    };
  },

  legalUpdateItem(document) {
    const number = document.metadata?.interimDecisionNumber;
    const summary = typeof document.metadata?.summary === "string" ? document.metadata.summary : null;
    return {
      itemType: "AAO precedent",
      // The AG and BIA collector and the monitor key the same decision this way.
      crossSourceKey: typeof number === "number" ? `intdec:${number}` : null,
      excerpt: summary ? `${document.title}, ${document.citations.join(", ")}\n${summary}` : null,
      publishedDateText: (document.metadata?.statedDates as { decided?: string } | undefined)?.decided ?? null,
      listedOnUrl: PAGE_URL,
    };
  },
};
