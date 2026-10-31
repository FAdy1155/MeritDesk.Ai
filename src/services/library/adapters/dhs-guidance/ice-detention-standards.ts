import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { LibraryLayoutError, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { fetchFileText, fileFields, fileMetadata, fingerprintOf } from "./files";
import { parseStandardsIndex, parseStandardsPage, type StandardsEntry } from "./parse";

// ICE's detention standards, from ICE's Detention Management page: the
// "Detention Standards" list links one page per set (2026 and 2025 National
// Detention Standards, NDIDS, PBNDS 2011 as revised in 2016, NDS 2019, the
// Family Residential Standards 2020) and the Temporary Housing Standards
// PDF. Each set page links the complete set as one PDF and, for PBNDS 2011,
// NDS 2019 and FRS 2020, each standard's own PDF. PBNDS 2008 is no longer
// linked from the list; ICE keeps its page at ARCHIVED_PAGES under an
// "Archived Content" banner, and it is read the same way and flagged as
// archived.
//
// - A set with per-standard PDFs is held one document per standard (keyed by
//   the set page and the standard's number, so a re-posted file stays the
//   same document); a set published only as one PDF is held as that PDF.
// - Daily and backfill both read the whole list (eight pages); fingerprints
//   skip unchanged standards. ice.gov's robots.txt sets no Crawl-delay.
//
// US government work: public domain, stored in full.

const INDEX_URL = "https://www.ice.gov/detain/detention-management";
/** Standards pages ICE keeps but no longer links from INDEX_URL (PBNDS 2008, archived). */
const ARCHIVED_PAGES = ["https://www.ice.gov/detain/detention-management/2008"] as const;
const HOSTS = ["www.ice.gov", "ice.gov"] as const;
const AGENCY = "U.S. Immigration and Customs Enforcement";

type Listing = {
  setName: string;
  setPage: string;
  setPageTitle: string | null;
  setPageUpdated: string | null;
  archived: boolean;
  archiveNote: string | null;
  number: string | null;
  title: string;
  label: string;
  part: string | null;
  complete: boolean;
};

function refFor(setPage: string, setName: string, page: ReturnType<typeof parseStandardsPage> | null, entry: StandardsEntry): DocumentRef {
  const slug = new URL(setPage).pathname.replace(/\/+$/, "");
  const externalId = entry.complete ? `${slug} complete` : entry.number ? `${slug} ${entry.number}` : new URL(entry.pdfUrl).pathname;
  const listing: Listing = {
    setName,
    setPage,
    setPageTitle: page?.title ?? null,
    setPageUpdated: page?.updated ?? null,
    archived: page?.archived ?? false,
    archiveNote: page?.archiveNote ?? null,
    number: entry.number,
    title: entry.title,
    label: entry.label,
    part: entry.part,
    complete: entry.complete,
  };
  return {
    externalId,
    url: entry.pdfUrl,
    title: entry.complete ? `${setName} (complete)` : `${setName}: ${entry.label}`,
    fingerprint: fingerprintOf(setName, entry.label, entry.part, entry.pdfUrl, page?.archived),
    listing,
  };
}

async function listAll(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await ctx.http.getText(INDEX_URL, { expect: "html" });
  const links = parseStandardsIndex(text, response.url, HOSTS);
  if (!links || links.length === 0) throw new LibraryLayoutError(INDEX_URL, "no Detention Standards list");
  const refs: DocumentRef[] = [];
  const seen = new Set<string>();
  const pages = [
    ...links.map((l) => ({ ...l, archivedOnly: false })),
    ...ARCHIVED_PAGES.filter((u) => !links.some((l) => l.url === u)).map((url) => ({ label: null as string | null, url, kind: "page" as const, archivedOnly: true })),
  ];
  for (const link of pages) {
    if (link.kind === "file") {
      // A set published only as a file on the list itself (the Temporary Housing Standards).
      const label = link.label ?? link.url;
      const ref = refFor(INDEX_URL, label, null, { number: null, title: label, label, part: null, pdfUrl: link.url, complete: true });
      ref.externalId = new URL(link.url).pathname;
      if (!seen.has(ref.externalId)) refs.push(ref);
      seen.add(ref.externalId);
      continue;
    }
    const { text: html, response: pageResponse } = await ctx.http.getText(link.url, { expect: "html" });
    const page = parseStandardsPage(html, pageResponse.url, HOSTS);
    if (page.entries.length === 0) throw new LibraryLayoutError(link.url, "no standards PDF links on the page");
    const setName = link.label ?? page.title ?? link.url;
    const perStandard = page.entries.filter((e) => !e.complete);
    // A set with its standards listed one by one is held per standard; the complete PDF repeats them.
    const entries = perStandard.length > 0 ? perStandard : page.entries;
    for (const entry of entries) {
      const ref = refFor(link.url, setName, page, entry);
      if (seen.has(ref.externalId)) {
        ctx.note(`${link.url}: ${entry.label} is listed twice; the first link was kept.`);
        continue;
      }
      seen.add(ref.externalId);
      refs.push(ref);
    }
    const complete = page.entries.find((e) => e.complete);
    if (perStandard.length > 0 && complete) ctx.note(`${setName}: held per standard; the complete PDF (${complete.pdfUrl}) repeats them and is not stored separately.`);
  }
  return refs;
}

export const iceDetentionStandardsAdapter: LibrarySourceAdapter = {
  code: "ice_detention_standards",
  group: "other-agency-guidance",
  name: "ICE detention standards",
  description:
    "The detention standards ICE applies to facilities holding its detainees (National Detention Standards 2019, 2025 and 2026, PBNDS 2011 as revised in 2016, the archived PBNDS 2008, the Family Residential Standards and NDIDS), read from ICE's Detention Management pages and each standard's PDF.",
  coverage:
    "Every set linked from ICE's Detention Standards list (per standard where ICE posts each standard separately, otherwise the complete set), the Temporary Housing Standards, and the archived PBNDS 2008 page ICE still hosts.",
  cadence: "Daily",
  officialUrl: INDEX_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 30,

  async listUpdates(ctx) {
    return { refs: await listAll(ctx) };
  },

  async backfill(ctx) {
    // Eight pages list every standard ICE publishes: one chunk is the whole history.
    const refs = await listAll(ctx);
    return { refs, nextCursor: null, progress: `${refs.length} standards documents on ICE's detention standards pages` };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.setName) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const file = await fetchFileText(ctx, ref.url, ref.known);
    if (file === "not_modified") return { kind: "not_modified" };
    const title = listing.complete ? listing.setName : `${listing.setName}: ${listing.label}`;
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "manual_section",
        title,
        citations: [],
        agency: AGENCY,
        precedentialStatus: "not_applicable",
        ...fileFields(file),
        withdrawn: listing.archived ? { reason: listing.archiveNote ?? "ICE lists this page as Archived Content." } : null,
        metadata: {
          standardsSet: listing.setName,
          setPage: listing.setPage,
          ...(listing.setPageTitle ? { setPageTitle: listing.setPageTitle } : {}),
          ...(listing.number ? { standardNumber: listing.number } : {}),
          standardTitle: listing.title,
          ...(listing.part ? { part: listing.part } : {}),
          completeSet: listing.complete,
          ...(listing.archived ? { archived: true } : {}),
          statedDates: listing.setPageUpdated ? { setPageUpdated: listing.setPageUpdated } : {},
          ...(listing.setPageUpdated && parseStatedDate(listing.setPageUpdated) ? { setPageUpdatedOn: parseStatedDate(listing.setPageUpdated) } : {}),
          ...fileMetadata(file),
        },
      },
    };
  },
};
