import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText, htmlToText } from "../../extract/html";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import { articleTime, bodyField, findLink, pageHeading, parseCourtDirectory } from "./parse";

// The immigration courts' own pages on justice.gov, as EOIR's "Find an
// Immigration Court and Access Internet-Based Hearings" page links them in
// its State-Based Immigration Court Directory: each court's address,
// public and window-filing hours, building access, contact channels
// (including its asylum EAD clock mailbox), staff directory and local
// procedures note. Also collected: the directory page itself (each
// judge's internet-based hearing link and telephonic access code) and the
// Immigration Court List - Administrative Control (which court holds the
// records for which DHS offices and detention facilities). EOIR rescinded
// the separate local operating procedures; each court page now points to
// the EOIR Policy Manual for procedure, and these pages are what remains
// court by court.
//
// - Daily and backfill: the directory (about 80 courts); unchanged courts
//   are skipped by their fingerprint and re-read every RECHECK_DAYS days
//   (justice.gov's validators change daily, so a conditional GET rarely
//   saves a fetch). The directory page's own document is fetched again
//   only when its text changed. One chunk is the whole directory (about 15
//   minutes at justice.gov's 10-second Crawl-delay).
//
// US government work: public domain, stored in full.

const DIRECTORY_URL = "https://www.justice.gov/eoir/find-immigration-court-and-access-internet-based-hearings";
const HOSTS = ["www.justice.gov", "justice.gov"] as const;
const AGENCY = "Executive Office for Immigration Review";
const RECHECK_DAYS = 14;

type Listing = { kind: "court"; courtName: string; state: string | null } | { kind: "directory" } | { kind: "control_list" };

async function readListing(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await ctx.http.getText(DIRECTORY_URL, { expect: "html" });
  const body = bodyField(text);
  if (!body) throw new LibraryLayoutError(DIRECTORY_URL, "no body field");
  const { courts, notes } = parseCourtDirectory(body, response.url);
  for (const note of notes) ctx.note(note);
  if (courts.length === 0) throw new LibraryLayoutError(DIRECTORY_URL, "no court headings in the State-Based Immigration Court Directory");

  const refs: DocumentRef[] = courts.map((court) => ({
    externalId: new URL(court.url).pathname,
    url: court.url,
    title: court.courtName,
    fingerprint: sha256Hex([court.courtName, court.url, court.state ?? ""].join("\u0000")).slice(0, 32),
    listing: { kind: "court", courtName: court.courtName, state: court.state } satisfies Listing,
  }));
  refs.push({
    externalId: new URL(response.url).pathname,
    url: response.url,
    title: pageHeading(text) ?? "Find an Immigration Court and Access Internet-Based Hearings",
    fingerprint: sha256Hex(htmlToText(body)).slice(0, 32),
    listing: { kind: "directory" } satisfies Listing,
  });
  const control = findLink(body, response.url, /Administrative Control/i);
  if (control) {
    refs.push({
      externalId: new URL(control.url).pathname,
      url: control.url,
      title: control.label,
      listing: { kind: "control_list" } satisfies Listing,
    });
  } else {
    ctx.note("The directory no longer links the administrative control list; it was not read.");
  }
  return refs;
}

async function fetchCourtPage(ctx: LibraryAdapterContext, ref: DocumentRef): Promise<FetchDocumentResult> {
  const listing = ref.listing as Listing | undefined;
  if (!listing?.kind) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
  const { text: html, response } = await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null });
  if (response.notModified) return { kind: "not_modified" };
  const body = bodyField(html);
  if (!body) throw new LibraryLayoutError(response.url, "no body field");
  const text = htmlToDocumentText(body);
  if (!text) throw new LibraryLayoutError(response.url, "the page has an empty body");
  const modified = articleTime(html, "modified_time");
  const heading = pageHeading(html);
  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType: "web_guidance",
      title: heading ?? ref.title ?? ref.url,
      citations: [],
      agency: AGENCY,
      // The page's own last-changed date; these pages state no other.
      editionDate: parseStatedDate(modified),
      precedentialStatus: "not_applicable",
      officialUrl: response.url,
      text,
      metadata: {
        ...(listing.kind === "court"
          ? { courtName: listing.courtName, ...(listing.state ? { state: listing.state } : {}), listedOn: DIRECTORY_URL }
          : { page: listing.kind === "directory" ? "court directory" : "administrative control list" }),
        statedDates: modified ? { pageModified: modified } : {},
      },
      fetch: { response },
    },
  };
}

export const eoirImmigrationCourtsAdapter: LibrarySourceAdapter = {
  code: "eoir_immigration_courts",
  group: "eoir-manuals-memos-forms",
  name: "Immigration court pages and local procedures (EOIR)",
  description:
    "Each immigration court's page on justice.gov (address, filing hours, contact channels, staff and local procedures note), EOIR's court directory with each judge's internet-based hearing access, and the administrative control list of which court holds which records.",
  coverage: "Every court the State-Based Immigration Court Directory links, as the pages read today, plus the directory and the administrative control list.",
  cadence: "Daily",
  officialUrl: DIRECTORY_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: RECHECK_DAYS,

  async listUpdates(ctx) {
    return { refs: await readListing(ctx) };
  },

  async backfill(ctx): Promise<BackfillChunk> {
    const refs = await readListing(ctx);
    return { refs, nextCursor: null, progress: `the whole court directory (${refs.length} pages)` };
  },

  fetchDocument: fetchCourtPage,
};
