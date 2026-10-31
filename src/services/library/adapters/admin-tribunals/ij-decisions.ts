import { htmlToDocumentText, mainContent } from "../../extract/html";
import { extractPdfText } from "../../extract/pdf";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import { foiaReleaseStatement, justiceBody, pageHeading, parseFoiaSection, parseImmigrationCourtHeader, type ReleasedDecisionLink } from "./parse";

// Immigration judge decisions EOIR itself has released to the public. EOIR
// publishes no immigration judge decisions as such (its Final Opinions and
// Orders page lists "None" for the Office of the Chief Immigration Judge,
// https://www.justice.gov/eoir/foia-opinions-and-orders), and its FOIA
// reading room (the PAL Reading Room) holds Board decisions only. The one
// official release of individual decisions is the "Decisions" list of the
// EOIR FOIA Library (and the "Requested Decisions" list of its Frequently
// Requested FOIA Records page): records EOIR posted because they were
// requested under FOIA, in full or with redactions. That list mixes Board,
// Attorney General, OCAHO and immigration judge decisions, so each linked
// file is read and kept only when its own first page names an immigration
// court as the body deciding it.
//
// The basis for release is recorded as the FOIA Library states it ("Frequently
// requested records have been disclosed, in full or with redactions,
// pursuant to previous FOIA requests"), with the list and the label the
// decision is posted under.
//
// - Daily and backfill alike: both pages (two requests); each listed
//   decision not labeled as a Board, precedent or OCAHO decision is a ref,
//   and stored ones are skipped by their fingerprint. A decision both pages
//   list is taken from the FOIA Library's list, which states the basis.
// - A file without a text layer cannot be told apart and is skipped with a
//   note (no OCR is run).
//
// Immigration judge decisions are not precedents. US government work:
// public domain, stored in full as released (redactions included).

const FOIA_LIBRARY_URL = "https://www.justice.gov/eoir/foia-library-0";
const PAGES: readonly { url: string; heading: string }[] = [
  { url: FOIA_LIBRARY_URL, heading: "Decisions" },
  { url: "https://www.justice.gov/eoir/frequently-requested-foia-records", heading: "Requested Decisions" },
];
const HOSTS = ["www.justice.gov", "justice.gov"] as const;
/** A label naming another body or a published precedent: not read. */
const NOT_IJ_LABEL = /\bBIA\b|Board of Immigration Appeals|\bI\s*&\s*N\s+Dec\b|^United States v\./i;

type Listing = { label: string; section: string; listedOn: string; listedOnTitle: string | null; releaseStatement: string | null };

async function listAll(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const refs = new Map<string, DocumentRef>();
  let excluded = 0;
  for (const page of PAGES) {
    const { text: html, response } = await ctx.http.getText(page.url, { expect: "html" });
    const links = parseFoiaSection(html, response.url, page.heading);
    if (links === null) throw new LibraryLayoutError(page.url, `no "${page.heading}" list in the body`);
    if (links.length === 0) throw new LibraryLayoutError(page.url, `the "${page.heading}" heading has no list of links under it`);
    const statement = foiaReleaseStatement(html);
    const title = pageHeading(html);
    for (const link of links) {
      if (NOT_IJ_LABEL.test(link.label)) {
        excluded++;
        continue;
      }
      const ref = refFor(link, response.url, title, statement);
      if (!refs.has(ref.externalId)) refs.set(ref.externalId, ref);
    }
  }
  if (excluded) ctx.note(`${excluded} listed decision(s) are labeled as Board, precedent or OCAHO decisions and were not read.`);
  return [...refs.values()];
}

function refFor(link: ReleasedDecisionLink, pageUrl: string, pageTitle: string | null, statement: string | null): DocumentRef {
  const u = new URL(link.url);
  const listing: Listing = { label: link.label, section: link.section, listedOn: pageUrl, listedOnTitle: pageTitle, releaseStatement: statement };
  return {
    externalId: u.pathname,
    url: link.url,
    title: link.label,
    fingerprint: sha256Hex([link.label, link.url, link.section, statement ?? ""].join("\u0000")).slice(0, 32),
    listing,
  };
}

export const ijDecisionsAdapter: LibrarySourceAdapter = {
  code: "eoir_foia_released_ij_decisions",
  group: "ij-decisions",
  name: "Immigration judge decisions released in the EOIR FOIA Library",
  description:
    "Immigration judge decisions EOIR has posted in its FOIA Library as frequently requested records, read from the released files, with the basis for release as the library states it.",
  coverage:
    "The immigration judge decisions among the decisions the EOIR FOIA Library lists (one when this collector was written: the decision underlying BIA Amicus Invitation No. 18-02-27). EOIR publishes no other immigration judge decisions; scanned files without a text layer cannot be confirmed as such and are not held.",
  cadence: "Daily",
  officialUrl: FOIA_LIBRARY_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 90,

  async listUpdates(ctx) {
    return { refs: await listAll(ctx) };
  },

  async backfill(ctx): Promise<BackfillChunk> {
    const refs = await listAll(ctx);
    return { refs, nextCursor: null, progress: `the FOIA Library's decision lists: ${refs.length} decision(s) to read` };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.label) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const response = await ctx.http.get(ref.url, { expect: "any", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const isPdf = response.body.subarray(0, 5).toString("latin1") === "%PDF-";
    let text: string;
    let extraction: Record<string, unknown>;
    let pageCount: number | null = null;
    if (isPdf) {
      const pdf = await extractPdfText(response.body);
      text = pdf.pagesWithText > 0 ? pdf.text : "";
      pageCount = pdf.pageCount;
      extraction = { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated };
    } else if (/html/i.test(response.contentType)) {
      const html = response.body.toString("utf-8");
      text = htmlToDocumentText(justiceBody(html) ?? mainContent(html));
      extraction = { method: "html" };
    } else {
      return { kind: "skip", reason: `${listing.label}: ${response.contentType || "an unknown type"} is not a PDF or a page.` };
    }
    if (!text.trim()) {
      return { kind: "skip", reason: `${listing.label}: the file has no text layer (a scan), so it cannot be confirmed as an immigration judge decision; not stored.` };
    }
    const header = parseImmigrationCourtHeader(text);
    if (!header.isImmigrationCourt) {
      return {
        kind: "skip",
        reason: `${listing.label}: not an immigration judge decision (${header.isBoard ? "a Board of Immigration Appeals decision" : "its first page names no immigration court"}).`,
      };
    }
    // FOIA exemption markers stand alone ("(b)(6)", "(b)(7)(C)"); "240A(b)(1)(C)" is a statute, not a redaction.
    const exemptions = [
      ...new Set([...text.matchAll(/(?<![\w)§.])\(b\)\s*\(([1-9])\)(?:\s*\(([A-F])\))?/g)].map((m) => `(b)(${m[1]})${m[2] ? `(${m[2]})` : ""}`)),
    ];
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "decision",
        title: listing.label,
        citations: [],
        court: "Immigration Court",
        agency: "Executive Office for Immigration Review",
        decisionDate: header.signedDate,
        precedentialStatus: "non_precedential",
        officialUrl: ref.url,
        originalUrl: response.url !== ref.url ? response.url : null,
        text,
        metadata: {
          ...(header.courtLocation ? { courtLocation: header.courtLocation } : {}),
          ...(header.orderTitle ? { orderTitle: header.orderTitle } : {}),
          releaseBasis: {
            ...(listing.releaseStatement ? { statement: listing.releaseStatement } : {}),
            listedAs: listing.label,
            list: listing.section,
            listedOn: listing.listedOn,
            ...(listing.listedOnTitle ? { listedOnPage: listing.listedOnTitle } : {}),
          },
          ...(exemptions.length ? { foiaRedactionsMarked: exemptions } : {}),
          statedDates: header.signedText ? { signed: header.signedText } : {},
          ...(pageCount !== null ? { pageCount } : {}),
        },
        original: isPdf ? { bytes: response.body, contentType: "application/pdf", extension: "pdf" } : null,
        fetch: { response, extraction },
      },
    };
  },
};
