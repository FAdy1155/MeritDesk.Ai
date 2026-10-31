import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibraryHttpResponse,
  type LibrarySourceAdapter,
} from "../../types";
import { parseBalcaCaselist, tidyListedDate, type BalcaCaselist, type BalcaEntry } from "./parse";

// Board of Alien Labor Certification Appeals (BALCA) decisions, from the
// caselists the Department of Labor's Office of Administrative Law Judges
// publishes on www.dol.gov: the en banc decisions under the pre-PERM
// regulations (1987 to 2004), the en banc decisions since PERM (2006 to the
// present, each with the caselist's summary bullets), and the prevailing
// wage determination appeals (PWD, BALCA's docket since September 2011).
//
// What is stored, and why not the decisions' text: every decision file the
// caselists link is on www.oalj.dol.gov, and that host's robots.txt
// (https://www.oalj.dol.gov/robots.txt) disallows all paths for every
// crawler ("User-agent: *" with "Disallow: /", and "/DECISIONS/" again by
// name). OALJ's full-text and case number search
// (https://www.dol.gov/agencies/oalj/apps/keyword-search) refuses automated
// clients. So each decision is kept as the caselist states it: caption,
// docket number, date, the caselist's parentheticals and summary, and the
// link to the official file, with no text (textKind "none"). Nothing is
// fetched from www.oalj.dol.gov; it is on the host list only because the
// official URLs are there. BALCA's panel decisions (the bulk of its
// docket) are listed only on www.oalj.dol.gov and are not collected.
//
// The caselists are US government work (public domain). They do not state
// whether a decision is precedential, so the status is "unknown".

const LIBRARY_URL = "https://www.dol.gov/agencies/oalj/topics/libraries/LIBINA";
const HOSTS = ["www.dol.gov", "www.oalj.dol.gov"] as const;

const CASELISTS: readonly { kind: BalcaCaselist; url: string; name: string }[] = [
  {
    kind: "en_banc_perm",
    url: "https://www.dol.gov/agencies/oalj/PUBLIC/INA/REFERENCES/CASELISTS/BALCA_DECISIONS_PERM",
    name: "BALCA en banc decisions, 2006 to present",
  },
  {
    kind: "en_banc_pre_perm",
    url: "https://www.dol.gov/agencies/oalj/PUBLIC/INA/REFERENCES/CASELISTS/BALCA_DECISIONS",
    name: "BALCA en banc decisions under the pre-PERM regulations, 1987 to 2004",
  },
  {
    kind: "pwd",
    url: "https://www.dol.gov/agencies/oalj/PUBLIC/INA/REFERENCES/CASELISTS/PWD_DECISIONS",
    name: "Prevailing wage determination appeals (PWD), docketed by BALCA since September 1, 2011",
  },
];

const NO_TEXT_NOTE =
  "The decision file is on www.oalj.dol.gov, whose robots.txt disallows automated access, so its text is not collected; this record holds what the OALJ caselist states and the official link.";

type Listing = {
  caselist: BalcaCaselist;
  caselistUrl: string;
  caselistName: string;
  caption: string;
  docket: string;
  docketText: string;
  dateText: string;
  documentLabel: string | null;
  fileIndex: number;
  alternateUrls: string[];
  parentheticals: string[];
  summary: string | null;
  listedAs: string;
  alsoListedIn: string[];
};

// The caselist responses a run has read, so a document's fetch record is
// the page its facts came from without reading that page again.
const caselistPages = new WeakMap<LibraryAdapterContext, Map<string, LibraryHttpResponse>>();

async function readCaselist(ctx: LibraryAdapterContext, list: (typeof CASELISTS)[number]): Promise<BalcaEntry[]> {
  const { text, response } = await ctx.http.getText(list.url, { expect: "html" });
  const pages = caselistPages.get(ctx) ?? new Map<string, LibraryHttpResponse>();
  pages.set(list.url, response);
  caselistPages.set(ctx, pages);
  const parsed = parseBalcaCaselist(text, response.url, list.kind);
  if (!parsed.recognized) throw new LibraryLayoutError(list.url, parsed.notes[0] ?? "no caselist entries with a docket number and a decision link");
  for (const note of parsed.notes) ctx.note(`${list.name}: ${note}`);
  return parsed.entries;
}

async function listAll(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const byId = new Map<string, DocumentRef>();
  for (const list of CASELISTS) {
    for (const entry of await readCaselist(ctx, list)) {
      // The official file's path is the decision's own identifier (the docket alone is not: a case can have several decisions).
      const externalId = new URL(entry.fileUrl).pathname;
      const known = byId.get(externalId);
      if (known) {
        (known.listing as Listing).alsoListedIn.push(list.name);
        continue;
      }
      const listing: Listing = {
        caselist: list.kind,
        caselistUrl: list.url,
        caselistName: list.name,
        caption: entry.caption,
        docket: entry.docket,
        docketText: entry.docketText,
        dateText: entry.dateText,
        documentLabel: entry.documentLabel,
        fileIndex: entry.fileIndex,
        alternateUrls: entry.alternateUrls,
        parentheticals: entry.parentheticals,
        summary: entry.summary,
        listedAs: entry.listedAs,
        alsoListedIn: [],
      };
      byId.set(externalId, {
        externalId,
        url: entry.fileUrl,
        title: `${entry.caption}, ${entry.docketText}${entry.documentLabel ? ` (${entry.documentLabel})` : ""}`,
        fingerprint: sha256Hex([entry.listedAs, entry.fileUrl, entry.summary ?? "", list.kind].join("\u0000")).slice(0, 32),
        listing,
      });
    }
  }
  // Fold the other caselists into the fingerprint, so a decision newly listed in a second one is refreshed.
  return [...byId.values()].map((ref) => {
    const also = (ref.listing as Listing).alsoListedIn;
    return also.length ? { ...ref, fingerprint: sha256Hex(`${ref.fingerprint}\u0000${also.join("|")}`).slice(0, 32) } : ref;
  });
}

export const balcaDecisionsAdapter: LibrarySourceAdapter = {
  code: "dol_balca_caselists",
  group: "ocaho-balca",
  name: "BALCA decisions in the OALJ caselists (Department of Labor)",
  description:
    "Board of Alien Labor Certification Appeals decisions as the Office of Administrative Law Judges lists them: en banc decisions from 1987 (pre-PERM and PERM, the latter with the caselist's summaries) and prevailing wage determination appeals, each with its docket, date and official link.",
  coverage:
    "The en banc decisions (1987 to the present) and the PWD appeals docketed since September 2011 that the OALJ caselists on www.dol.gov list. Caselist facts and links only: the decision files are on www.oalj.dol.gov, whose robots.txt disallows automated access, so their text is not held; BALCA panel decisions outside these caselists are not collected.",
  cadence: "Daily",
  officialUrl: LIBRARY_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 90,

  async listUpdates(ctx) {
    return { refs: await listAll(ctx) };
  },

  async backfill(ctx): Promise<BackfillChunk> {
    // Three caselist pages and no per-decision request: one chunk is the whole history.
    const refs = await listAll(ctx);
    return { refs, nextCursor: null, progress: `the three OALJ caselists: ${refs.length} decisions` };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.caption || !listing.docket) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    // Nothing is requested from www.oalj.dol.gov (robots.txt). The record is the caselist page's.
    let response = caselistPages.get(ctx)?.get(listing.caselistUrl);
    if (!response) {
      const list = CASELISTS.find((l) => l.kind === listing.caselist);
      if (!list) return { kind: "skip", reason: `${ref.externalId}: caselist ${listing.caselist} is no longer read.` };
      await readCaselist(ctx, list);
      response = caselistPages.get(ctx)?.get(listing.caselistUrl);
    }
    if (!response) return { kind: "skip", reason: `${ref.externalId}: the caselist page could not be read.` };
    // When a line links several files, its date is the first file's; the others are left undated.
    const decided = listing.fileIndex === 0 ? parseStatedDate(tidyListedDate(listing.dateText)) : null;
    const enBanc = listing.parentheticals.some((p) => /en banc/i.test(p));
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "decision",
        title: listing.caption,
        citations: [...new Set([listing.docket, listing.docketText])],
        court: "Board of Alien Labor Certification Appeals",
        agency: "U.S. Department of Labor",
        decisionDate: decided,
        precedentialStatus: "unknown",
        officialUrl: ref.url,
        text: "",
        textKind: "none",
        metadata: {
          docket: listing.docket,
          ...(listing.docketText !== listing.docket ? { dockets: listing.docketText } : {}),
          ...(listing.documentLabel ? { documentLabel: listing.documentLabel } : {}),
          ...(listing.alternateUrls?.length ? { otherFormats: listing.alternateUrls } : {}),
          caselist: listing.caselistName,
          caselistUrl: listing.caselistUrl,
          ...(listing.alsoListedIn.length ? { alsoListedIn: listing.alsoListedIn } : {}),
          listedAs: listing.listedAs,
          parentheticals: listing.parentheticals,
          ...(enBanc ? { enBanc: true } : {}),
          ...(listing.summary ? { summary: listing.summary, summaryKind: "the OALJ caselist's summary of the decision (not part of the opinion)" } : {}),
          statedDates: { listed: listing.dateText },
          textNote: NO_TEXT_NOTE,
        },
        fetch: { response, extraction: { method: "caselist entry", caselist: listing.caselistUrl } },
      },
    };
  },
};
