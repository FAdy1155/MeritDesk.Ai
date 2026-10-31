import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { cachedPage, fetchFileText, fileFields, fileMetadata, fingerprintOf, offsetOf } from "./common";
import { parseFpgListing, type FpgEntry } from "./parse";

// CMS guidance on immigrants' eligibility for Medicaid and CHIP, from
// medicaid.gov's federal policy guidance listing (State Medicaid Director
// letters, State Health Official letters, CMCS Informational Bulletins and
// FAQs): the entries whose title is about immigrants, aliens, noncitizens,
// citizenship verification, lawfully residing children and pregnant
// individuals, refugees, parolees or the five-year bar, or that CMS tags
// with the topic "Citizenship". Each entry's first linked file (the letter
// or bulletin PDF) is the document.
//
// - Daily: the listing's first page (the 100 newest entries).
// - Backfill: every page of the listing, PAGES_PER_CHUNK at a time.
// - medicaid.gov's robots.txt asks for 1 second between requests.
//
// US government work: public domain, stored in full.

const HOSTS = ["www.medicaid.gov", "medicaid.gov"] as const;
const LISTING_URL = "https://www.medicaid.gov/federal-policy-guidance";
const PAGES_PER_CHUNK = 4;
const WANTED =
  /\bimmigra\w*|\baliens?\b|\bnon-?citizens?\b|\bcitizenship\b|lawfully residing|lawfully present|\brefugees?\b|\basylees?\b|\bparole\w*|five-year bar|5-year bar|\bqualified (?:alien|non-?citizen)|\bICHIA\b|\bCHIPRA section 214\b|\bemergency medicaid\b|\bDACA\b/i;

function pageUrl(page: number): string {
  return `${LISTING_URL}?limit=100&page=${page}`;
}

type Listing = FpgEntry & { listedOn: string };

function wanted(e: FpgEntry): boolean {
  return WANTED.test(e.title) || e.topics.some((t) => /^Citizenship$/i.test(t));
}

async function readPage(ctx: LibraryAdapterContext, page: number): Promise<{ refs: DocumentRef[]; lastPage: number | null; seen: number; pastEnd: boolean }> {
  const url = pageUrl(page);
  const { text, response } = await cachedPage(ctx, url);
  const { entries, lastPage } = parseFpgListing(text, response.url);
  // A page past the end (a backfill cursor the listing has shrunk under)
  // still shows the pager, with no entries; any other empty page, and the
  // first page empty, is a layout the parser does not read.
  if (entries.length === 0 && page > 0 && lastPage !== null) return { refs: [], lastPage, seen: 0, pastEnd: true };
  if (entries.length === 0) throw new LibraryLayoutError(url, "no guidance entries (accordion items with a date and links)");
  const refs: DocumentRef[] = [];
  for (const e of entries.filter(wanted)) {
    const file = e.links.find((l) => /^https:\/\/(?:www\.)?medicaid\.gov\//i.test(l.url));
    if (!file) {
      ctx.note(`Guidance "${e.title}" links no medicaid.gov file; it was skipped.`);
      continue;
    }
    refs.push({
      externalId: `FPG ${e.nodeId}`,
      url: file.url,
      title: e.title,
      fingerprint: fingerprintOf(e.title, e.dateText, file.url, e.type),
      listing: { ...e, listedOn: url } satisfies Listing,
    });
  }
  return { refs, lastPage, seen: entries.length, pastEnd: false };
}

export const cmsMedicaidImmigrantAdapter: LibrarySourceAdapter = {
  code: "cms_medicaid_immigrant_eligibility",
  group: "other-agency-guidance",
  name: "CMS Medicaid and CHIP immigrant eligibility guidance",
  description:
    "CMS letters, informational bulletins and FAQs to state Medicaid and CHIP programs on the eligibility of immigrants and the verification of citizenship and immigration status, from medicaid.gov's federal policy guidance.",
  coverage:
    "The entries of medicaid.gov's federal policy guidance listing whose titles concern immigrants, noncitizens, citizenship, lawfully residing children and pregnant individuals, refugees or parolees, or that carry CMS's Citizenship topic; one document per entry's linked file.",
  cadence: "Daily",
  officialUrl: LISTING_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 90,

  async listUpdates(ctx) {
    return { refs: (await readPage(ctx, 0)).refs };
  },
  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const start = offsetOf(cursor);
    const refs: DocumentRef[] = [];
    let last: number | null = null;
    let seen = 0;
    let page = start;
    for (; page < start + PAGES_PER_CHUNK; page++) {
      if (last !== null && page > last) break;
      const read = await readPage(ctx, page);
      if (read.pastEnd) {
        ctx.note(`Listing page ${page + 1} has no entries: the listing now ends before it, so the history walk is complete.`);
        last = page - 1;
        break;
      }
      refs.push(...read.refs);
      seen += read.seen;
      last = read.lastPage ?? page;
    }
    const done = last === null || page > last;
    const progress =
      page > start
        ? `listing pages ${start + 1} to ${page} of ${last === null ? "?" : last + 1}: ${refs.length} immigrant eligibility entries of ${seen}`
        : `listing page ${start + 1} is past the end of the listing: nothing left to walk`;
    return { refs, nextCursor: done ? null : { offset: page }, progress };
  },
  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.nodeId) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const file = await fetchFileText(ctx, ref.url, ref.known);
    if (file === "not_modified") return { kind: "not_modified" };
    const letter = /\b(SMDL?|SHO|CIB|SMD)\s*#?\s*(\d{2}-\d{3})\b/i.exec(`${listing.title} ${file.text.slice(0, 1500)}`);
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: /FAQ|Frequently Asked/i.test(`${listing.type ?? ""} ${listing.title}`) ? "web_guidance" : "policy_memorandum",
        title: listing.title,
        citations: letter ? [`${letter[1].toUpperCase()} ${letter[2]}`] : [],
        agency: "Centers for Medicare & Medicaid Services",
        publishedDate: parseStatedDate(listing.dateText),
        precedentialStatus: "not_applicable",
        ...fileFields(file),
        metadata: {
          guidanceType: listing.type,
          topics: listing.topics,
          otherLinks: listing.links.filter((l) => l.url !== ref.url),
          listedOn: LISTING_URL,
          ...(listing.dateText ? { statedDates: { listed: listing.dateText } } : {}),
          ...fileMetadata(file),
        },
      },
    };
  },
};
