import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { extractPdfText } from "../../extract/pdf";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibraryDocumentInput,
  type LibrarySourceAdapter,
} from "../../types";
import { citationParenthetical, parseDecisionHeader, parseVolumeIndex, parseVolumePage, type VolumeEntry } from "./parse";

// The reference adapter (docs/LIBRARY.md): EOIR's AG and BIA precedent
// decisions, as EOIR publishes them on justice.gov. The index page lists the
// volumes of Administrative Decisions Under Immigration and Nationality Laws
// (I&N Dec.) it links, each volume page lists its decisions (caption,
// citation, Interim Decision number, the PDF and, for newer volumes, the
// official headnote), and each decision is read from its PDF.
//
// - Daily: the two highest volumes on the index (so the end of a volume is
//   still covered when a new one opens); unchanged entries are skipped by
//   their listing fingerprint.
// - Backfill: every volume the index links, highest first, PAGE_SIZE
//   entries per chunk.
// - justice.gov's robots.txt asks for 10 seconds between requests, and each
//   decision link redirects once to the file, so one decision costs about
//   20 seconds: about 40 decisions per 15-minute chunk.
//
// US government work: public domain, stored in full. Every decision in
// I&N Dec. is a precedent decision.

const INDEX_URL = "https://www.justice.gov/eoir/ag-bia-decisions";
const HOSTS = ["www.justice.gov", "justice.gov"] as const;
const PAGE_SIZE = 40;
const DAILY_VOLUMES = 2;

type Listing = {
  volume: number;
  volumeUrl: string;
  volumePageUpdated: string | null;
  idNumber: string;
  name: string;
  citation: string;
  headnote: string | null;
};

type Cursor = { volumes: number[]; offset: number };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && Array.isArray(c.volumes) && c.volumes.every((v) => Number.isInteger(v)) && Number.isInteger(c.offset);
}

function refFor(volume: number, volumeUrl: string, volumePageUpdated: string | null, entry: VolumeEntry): DocumentRef {
  const listing: Listing = {
    volume,
    volumeUrl,
    volumePageUpdated,
    idNumber: entry.idNumber,
    name: entry.name,
    citation: entry.citation,
    headnote: entry.headnote,
  };
  return {
    externalId: `ID ${Number(entry.idNumber)}`,
    url: entry.pdfUrl,
    title: `Matter of ${entry.name}, ${entry.citation}`,
    fingerprint: sha256Hex([entry.name, entry.citation, entry.pdfUrl, entry.headnote ?? ""].join("\u0000")).slice(0, 32),
    listing,
  };
}

async function readIndex(ctx: LibraryAdapterContext) {
  const { text } = await ctx.http.getText(INDEX_URL, { expect: "html" });
  const volumes = parseVolumeIndex(text, INDEX_URL);
  if (volumes.length === 0) throw new LibraryLayoutError(INDEX_URL, "no volume links in the AG/BIA Precedent Decisions list");
  return volumes;
}

async function readVolume(ctx: LibraryAdapterContext, volume: number, url: string): Promise<DocumentRef[]> {
  const { text, response } = await ctx.http.getText(url, { expect: "html" });
  // The index links some volumes by an older address that redirects; the page is where it landed.
  const pageUrl = response.url;
  const parsed = parseVolumePage(text, pageUrl);
  if (!parsed.recognized) throw new LibraryLayoutError(url, "no decision rows with an ID link");
  for (const note of parsed.notes) ctx.note(`Volume ${volume}: ${note}`);
  return parsed.entries.map((entry) => refFor(volume, pageUrl, parsed.pageUpdated, entry));
}

const COURTS: Record<string, string> = {
  BIA: "Board of Immigration Appeals",
  "A.G.": "Attorney General",
  AG: "Attorney General",
};

function toDocument(listing: Listing, ref: DocumentRef, text: string, extra: Partial<LibraryDocumentInput>): LibraryDocumentInput {
  const { issuer, year } = citationParenthetical(listing.citation);
  return {
    externalId: ref.externalId,
    docType: "decision",
    title: `Matter of ${listing.name}`,
    citations: [listing.citation, `Interim Decision ${Number(listing.idNumber)}`],
    court: issuer ? (COURTS[issuer] ?? null) : null,
    agency: null,
    documentYear: year,
    precedentialStatus: "precedential",
    officialUrl: ref.url,
    text,
    ...extra,
  };
}

export const eoirAgBiaPrecedentsAdapter: LibrarySourceAdapter = {
  code: "eoir_ag_bia_precedents",
  group: "bia-ag-precedents",
  name: "AG and BIA precedent decisions (EOIR)",
  description:
    "Precedent decisions of the Board of Immigration Appeals and the Attorney General, with the other precedents EOIR prints in Administrative Decisions Under Immigration and Nationality Laws (I&N Dec.), read from EOIR's volume pages and each decision's PDF.",
  coverage:
    "Every volume linked from EOIR's AG/BIA Precedent Decisions page (volumes 8 through 30 when this collector was written; EOIR does not link volumes 1 to 7 there).",
  cadence: "Daily",
  officialUrl: INDEX_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 60,

  async listUpdates(ctx) {
    const volumes = (await readIndex(ctx)).slice(0, DAILY_VOLUMES);
    const refs: DocumentRef[] = [];
    for (const v of volumes) refs.push(...(await readVolume(ctx, v.volume, v.url)));
    return { refs };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const index = await readIndex(ctx);
    const state: Cursor = isCursor(cursor) ? cursor : { volumes: index.map((v) => v.volume), offset: 0 };
    const volume = state.volumes[0];
    if (volume === undefined) return { refs: [], nextCursor: null, progress: "every listed volume is done" };
    const link = index.find((v) => v.volume === volume);
    if (!link) {
      ctx.note(`Volume ${volume} is no longer linked from the index; it was skipped.`);
      return { refs: [], nextCursor: state.volumes.length > 1 ? { volumes: state.volumes.slice(1), offset: 0 } : null };
    }
    const all = await readVolume(ctx, volume, link.url);
    const refs = all.slice(state.offset, state.offset + PAGE_SIZE);
    const nextOffset = state.offset + PAGE_SIZE;
    const nextCursor: Cursor | null =
      nextOffset < all.length
        ? { volumes: state.volumes, offset: nextOffset }
        : state.volumes.length > 1
          ? { volumes: state.volumes.slice(1), offset: 0 }
          : null;
    return {
      refs,
      nextCursor,
      progress: `volume ${volume}, entries ${state.offset + 1} to ${state.offset + refs.length} of ${all.length}; ${state.volumes.length - 1} more volume(s) after this one`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.citation || !listing.name || !listing.idNumber) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const response = await ctx.http.get(ref.url, { expect: "pdf", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const pdf = await extractPdfText(response.body);
    const header = parseDecisionHeader(pdf.text);
    const { year } = citationParenthetical(listing.citation);
    // The "Decided" line of older volumes comes from OCR and can be garbled
    // ("Juno 25, 19.78"); a date is kept only when it parses and its year
    // agrees with the citation's.
    const decided = parseStatedDate(header.decidedText);
    const decidedYear = decided ? Number(decided.slice(0, 4)) : null;
    const decisionDate = decided && year && decidedYear !== null && Math.abs(decidedYear - year) <= 1 ? decided : null;
    if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
    return {
      kind: "document",
      document: toDocument(listing, ref, pdf.pagesWithText > 0 ? pdf.text : "", {
        textKind: pdf.pagesWithText > 0 ? "full" : "none",
        decisionDate,
        originalUrl: response.url !== ref.url ? response.url : null,
        metadata: {
          volume: listing.volume,
          interimDecisionNumber: Number(listing.idNumber),
          listedName: listing.name,
          listedCitation: listing.citation,
          issuerAsCited: citationParenthetical(listing.citation).issuer,
          ...(listing.headnote ? { summary: listing.headnote, summaryKind: "headnote" } : {}),
          volumePage: listing.volumeUrl,
          ...(listing.volumePageUpdated ? { volumePageUpdated: listing.volumePageUpdated } : {}),
          statedDates: header.decidedText ? { decided: header.decidedText } : {},
          pageCount: pdf.pageCount,
          ...(pdf.pagesWithText === 0 ? { textNote: "The PDF has no text layer (a scan); no OCR is run." } : {}),
        },
        original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
        fetch: { response, extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated } },
      }),
    };
  },

  legalUpdateItem(document) {
    const issuer = (document.metadata?.issuerAsCited as string | undefined) ?? null;
    const number = document.metadata?.interimDecisionNumber;
    const summary = typeof document.metadata?.summary === "string" ? document.metadata.summary : null;
    return {
      itemType: issuer && /^A\.?\s?G\.?$/.test(issuer) ? "AG precedent" : issuer === "AAO" ? "AAO precedent" : "BIA precedent",
      crossSourceKey: typeof number === "number" ? `intdec:${number}` : null,
      // With no headnote on the volume page, the hook quotes the opening of the decision itself.
      excerpt: summary ? `${document.title}, ${document.citations.join(", ")}\n${summary}` : null,
      publishedDateText: (document.metadata?.statedDates as { decided?: string } | undefined)?.decided ?? null,
      listedOnUrl: typeof document.metadata?.volumePage === "string" ? document.metadata.volumePage : null,
    };
  },
};
