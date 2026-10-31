import { parseStatedDate } from "@/services/monitoring/parse/dates";
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
import { parseListedDate, parseOcahoDecisionHeader, parseOcahoIndex, parseOcahoVolume, type OcahoEntry, type OcahoVolumeLink } from "./parse";

// OCAHO's published decisions: the decisions and orders of the Office of the
// Chief Administrative Hearing Officer (EOIR) in employer sanctions (INA
// 274A), unfair immigration-related employment practices (274B) and
// document fraud (274C) cases, as EOIR publishes them on justice.gov. The
// published decisions page links one listing per volume (Bound Volumes 1 to
// 8, Looseleaf Volumes 9 to the current one); each listing is a table of
// case name, case number, decision date, OCAHO reference number (the PDF)
// and, from volume 10, whether it is a decision of the Chief Administrative
// Hearing Officer (CAHO).
//
// - Daily: every volume page, read as a conditional listing (an unchanged
//   page yields no refs). Not just the newest volume: since May 2015 a later
//   decision in a case is published under the case's first reference number
//   with a sub-letter, in that first decision's volume (volume 14 gained
//   1450aa and 1450ab in 2026), so new decisions land in older volumes too.
// - Backfill: every volume, highest first, newest entries first, PAGE_SIZE
//   per chunk. justice.gov asks for 10 seconds between requests and the
//   older links redirect once, so a decision costs up to about 20 seconds.
// - The citation is the one the decision prints at its head ("23 OCAHO no.
//   1732", "1 OCAHO 1"); when the file has no text layer, the volume and
//   reference number the listing gives, in OCAHO's "<volume> OCAHO no.
//   <reference>" form, marked as taken from the listing.
//
// EOIR publishes these decisions as precedent ("selected for and may be used
// as precedent pursuant to 5 U.S.C. section 552(a)(2)", on the published
// decisions page). US government work: public domain, stored in full.

const INDEX_URL = "https://www.justice.gov/eoir/office-of-the-chief-administrative-hearing-officer-decisions";
const HOSTS = ["www.justice.gov", "justice.gov"] as const;
const PAGE_SIZE = 40;
const COURT = "Office of the Chief Administrative Hearing Officer";
const AGENCY = "Executive Office for Immigration Review";

type Listing = {
  volume: number;
  binding: "Bound" | "Looseleaf";
  volumeUrl: string;
  volumePageUpdated: string | null;
  reference: string;
  fileIndex: number;
  caseNames: string[];
  caseNumbers: string[];
  decisionDates: string[];
  caho: boolean;
  captionFrom: string | null;
};

type Cursor = { volumes: number[]; offset: number };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && Array.isArray(c.volumes) && c.volumes.every((v) => Number.isInteger(v)) && Number.isInteger(c.offset) && c.offset >= 0;
}

/** "OCAHO 1271a"; a second file the page lists under the same number keeps its own id ("OCAHO 936 (936.pdf)"). */
function externalIdFor(entry: OcahoEntry): string {
  if (entry.fileIndex === 0) return `OCAHO ${entry.reference}`;
  const file = new URL(entry.pdfUrl).pathname.split("/").filter(Boolean).slice(-2).join("/");
  return `OCAHO ${entry.reference} (${file})`;
}

function refFor(link: OcahoVolumeLink, volumeUrl: string, pageUpdated: string | null, entry: OcahoEntry): DocumentRef {
  const listing: Listing = {
    volume: link.volume,
    binding: link.binding,
    volumeUrl,
    volumePageUpdated: pageUpdated,
    reference: entry.reference,
    fileIndex: entry.fileIndex,
    caseNames: entry.caseNames,
    caseNumbers: entry.caseNumbers,
    decisionDates: entry.decisionDates,
    caho: entry.caho,
    captionFrom: entry.captionFrom,
  };
  return {
    externalId: externalIdFor(entry),
    url: entry.pdfUrl,
    title: `${entry.caseNames.join("; ")}, OCAHO ref. ${entry.reference}`,
    fingerprint: sha256Hex(
      [entry.caseNames.join("|"), entry.caseNumbers.join("|"), entry.decisionDates.join("|"), entry.pdfUrl, entry.caho ? "CAHO" : "", String(link.volume)].join("\u0000")
    ).slice(0, 32),
    listing,
  };
}

async function readIndex(ctx: LibraryAdapterContext): Promise<OcahoVolumeLink[]> {
  const { text, response } = await ctx.http.getText(INDEX_URL, { expect: "html" });
  const volumes = parseOcahoIndex(text, response.url);
  if (volumes.length === 0) throw new LibraryLayoutError(INDEX_URL, "no Bound or Looseleaf Volume links");
  return volumes;
}

/** One volume's refs, newest first; null when read as a conditional listing that has not changed. */
async function readVolume(ctx: LibraryAdapterContext, link: OcahoVolumeLink, conditional: boolean): Promise<DocumentRef[] | null> {
  let text: string;
  let pageUrl: string;
  if (conditional) {
    const page = await ctx.http.getListing(link.url, { expect: "html" });
    if (page.unchanged) return null;
    text = page.text;
    pageUrl = page.response.url;
  } else {
    const page = await ctx.http.getText(link.url, { expect: "html" });
    text = page.text;
    pageUrl = page.response.url;
  }
  // The older volumes are linked by their former addresses, which redirect; the page is where it landed.
  const parsed = parseOcahoVolume(text, pageUrl);
  if (!parsed.recognized) throw new LibraryLayoutError(link.url, parsed.notes[0] ?? "no decision rows with a reference link");
  for (const note of parsed.notes) ctx.note(`Volume ${link.volume}: ${note}`);
  return parsed.entries.map((entry) => refFor(link, pageUrl, parsed.pageUpdated, entry)).reverse();
}

/**
 * The decision date, when the listing and the decision agree on one: the
 * listed date when it is the only one and the decision prints no date at
 * its head (older decisions) or the same date; when the listing gives
 * several, the one the decision's head prints. Anything else is left null
 * (both stated texts are kept).
 */
function decisionDateFor(listing: Listing, headerDate: string | null): string | null {
  const listed = listing.decisionDates.map(parseListedDate).filter((d): d is string => Boolean(d));
  const distinct = [...new Set(listed)];
  const header = parseStatedDate(headerDate);
  if (distinct.length === 1 && listing.decisionDates.length === 1) return !header || header === distinct[0] ? distinct[0] : null;
  return header && distinct.includes(header) ? header : null;
}

export const ocahoDecisionsAdapter: LibrarySourceAdapter = {
  code: "eoir_ocaho_published_decisions",
  group: "ocaho-balca",
  name: "OCAHO published decisions (EOIR)",
  description:
    "Published decisions and orders of the Office of the Chief Administrative Hearing Officer in employer sanctions, unfair immigration-related employment practices and document fraud cases, read from EOIR's volume listings and each decision's PDF.",
  coverage:
    "Every decision listed on the volume pages EOIR links from its OCAHO published decisions page: Bound Volumes 1 to 8 and Looseleaf Volumes 9 to 23 when this collector was written (1988 to the present).",
  cadence: "Daily",
  officialUrl: INDEX_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 90,
  // New decisions are a few a week; the daily refs are ordered newest
  // first (by listed date, across volumes), so the cap reaches them first
  // while the history is still being backfilled.
  maxDocumentsPerDailyRun: 60,

  async listUpdates(ctx) {
    const volumes = await readIndex(ctx);
    const refs: DocumentRef[] = [];
    const seen = new Set<string>();
    for (const link of volumes) {
      const volumeRefs = await readVolume(ctx, link, true);
      for (const ref of volumeRefs ?? []) {
        if (seen.has(ref.externalId)) {
          ctx.note(`${ref.externalId} is listed in more than one volume; the first listing is used.`);
          continue;
        }
        seen.add(ref.externalId);
        refs.push(ref);
      }
    }
    // Newest listed date first, across volumes: a sub-lettered decision added to an old volume comes before older entries.
    const latest = (ref: DocumentRef) => {
      const dates = ((ref.listing as Listing).decisionDates ?? []).map(parseListedDate).filter((d): d is string => Boolean(d));
      return dates.sort().pop() ?? "";
    };
    return { refs: refs.map((ref, i) => ({ ref, i, key: latest(ref) })).sort((a, b) => b.key.localeCompare(a.key) || a.i - b.i).map((x) => x.ref) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const index = await readIndex(ctx);
    const state: Cursor = isCursor(cursor) ? cursor : { volumes: index.map((v) => v.volume), offset: 0 };
    const volume = state.volumes[0];
    if (volume === undefined) return { refs: [], nextCursor: null, progress: "every listed volume is done" };
    const rest = state.volumes.slice(1);
    const link = index.find((v) => v.volume === volume);
    if (!link) {
      ctx.note(`Volume ${volume} is no longer linked from the published decisions page; it was skipped.`);
      return { refs: [], nextCursor: rest.length ? { volumes: rest, offset: 0 } : null, progress: `volume ${volume} skipped (no longer linked)` };
    }
    const all = (await readVolume(ctx, link, false)) ?? [];
    const offset = Math.min(state.offset, all.length);
    const refs = all.slice(offset, offset + PAGE_SIZE);
    const nextOffset = offset + PAGE_SIZE;
    const nextCursor: Cursor | null = nextOffset < all.length ? { volumes: state.volumes, offset: nextOffset } : rest.length ? { volumes: rest, offset: 0 } : null;
    return {
      refs,
      nextCursor,
      progress: `${link.binding} Volume ${volume}, entries ${offset + 1} to ${offset + refs.length} of ${all.length} (newest first); ${rest.length} more volume(s) after this one`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.reference || !listing.caseNames?.length) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const response = await ctx.http.get(ref.url, { expect: "pdf", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const pdf = await extractPdfText(response.body);
    const hasText = pdf.pagesWithText > 0;
    const header = parseOcahoDecisionHeader(pdf.text);
    if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);

    // The decision's own citation, when it names this reference number; else the listing's volume and number.
    const statedMatches = header.citation !== null && header.reference === listing.reference;
    if (header.citation && !statedMatches) ctx.note(`${ref.externalId}: the PDF's head cites "${header.citation}", not reference ${listing.reference}; the listing's numbers are used.`);
    if (statedMatches && header.volume !== listing.volume) ctx.note(`${ref.externalId}: the PDF cites volume ${header.volume}, the listing volume ${listing.volume}.`);
    const citation = statedMatches ? header.citation! : `${listing.volume} OCAHO no. ${listing.reference}`;
    const decisionDate = decisionDateFor(listing, header.headerDate);
    const listedDates = listing.decisionDates.map(parseListedDate).filter((d): d is string => Boolean(d));
    if (!decisionDate && listedDates.length) {
      ctx.note(`${ref.externalId}: the listed date(s) ${listing.decisionDates.join(", ")} and the decision's head (${header.headerDate ?? "no date"}) do not settle one decision date; it is left empty.`);
    }

    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "decision",
        title: listing.caseNames.join("; "),
        citations: [citation],
        court: COURT,
        agency: AGENCY,
        decisionDate,
        documentYear: decisionDate ? null : listedDates.length ? Number(listedDates[0].slice(0, 4)) : null,
        precedentialStatus: "precedential",
        officialUrl: ref.url,
        originalUrl: response.url !== ref.url ? response.url : null,
        text: hasText ? pdf.text : "",
        textKind: hasText ? "full" : "none",
        metadata: {
          volume: listing.volume,
          volumeBinding: listing.binding,
          referenceNumber: listing.reference,
          caseNumbers: listing.caseNumbers,
          listedCaseNames: listing.caseNames,
          citationSource: statedMatches ? "decision" : "listing",
          ...(listing.caho ? { cahoDecision: true } : {}),
          ...(listing.captionFrom
            ? { captionNote: `The listing leaves this row's case name or number blank; they are those of reference ${listing.captionFrom}, the first decision in the same case.` }
            : {}),
          ...(header.proceeding ? { proceeding: header.proceeding } : {}),
          ...(header.caseNumber ? { caseNumberAsPrinted: header.caseNumber } : {}),
          statedDates: {
            listedDecisionDates: listing.decisionDates,
            ...(header.headerDate ? { decisionHeader: header.headerDate } : {}),
          },
          volumePage: listing.volumeUrl,
          ...(listing.volumePageUpdated ? { volumePageUpdated: listing.volumePageUpdated } : {}),
          pageCount: pdf.pageCount,
          ...(hasText ? {} : { textNote: "The PDF has no text layer (a scan); no OCR is run." }),
        },
        original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
        fetch: { response, extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated } },
      },
    };
  },
};
