import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { anchors, htmlToDocumentText, resolveUrl } from "../../extract/html";
import { sha256Hex } from "../../text";
import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { cachedPage, chunkOf, fetchFileText, fileFields, fileMetadata, fingerprintOf } from "./common";
import { dolArticle, parseOflcAnnouncements, parseOflcArchive, parseOflcFaqLinks, pathId, type OflcAnnouncement } from "./parse";

// The Department of Labor's Office of Foreign Labor Certification (OFLC),
// on dol.gov: its announcements and its frequently asked questions.
//
// Announcements: OFLC posts each announcement as a dated entry on one page
// (https://www.dol.gov/agencies/eta/foreign-labor/news, August 2012 to the
// present) and keeps the older ones, 2005 to 2014, on an archive page. An
// entry has no page or number of its own, so its identifier is its date
// and a hash of its heading as printed; a heading OFLC rewrites is a new
// document (the old one stays, as the source no longer lists it). Each
// entry is stored with its text and the links it gives.
//
// FAQs: OFLC publishes its FAQs as PDF "rounds" listed on its FAQ page,
// grouped by program and rule (H-2A 2022 rule, H-2A 2010 rule, H-2B,
// PERM, LCA, prevailing wage, CW-1); each round is one document.
//
// dol.gov's robots.txt sets no Crawl-delay. US government work: public
// domain, stored in full.

const HOSTS = ["www.dol.gov", "dol.gov"] as const;
const NEWS_URL = "https://www.dol.gov/agencies/eta/foreign-labor/news";
const ARCHIVE_URL = "https://www.dol.gov/agencies/eta/foreign-labor/news/archive";
const FAQ_URL = "https://www.dol.gov/agencies/eta/foreign-labor/faqs/print";
const AGENCY = "U.S. Department of Labor, Employment and Training Administration, Office of Foreign Labor Certification";

/** Whether the heading says more than its date (the archive's bold lead is often only "June 16, 2005,"). */
function hasHeading(a: OflcAnnouncement): boolean {
  return /[A-Za-z]{3}/.test(a.heading);
}

/** The entry's first sentence as printed ("H-1B Visa Extensions."), for an entry whose heading is only its date. */
function firstSentence(a: OflcAnnouncement): string {
  const text = htmlToDocumentText(a.html).replace(/\s+/g, " ").trim();
  const end = text.search(/[.!?](?:\s|$)/);
  return (end > 0 ? text.slice(0, end + 1) : text).slice(0, 200).trim();
}

/**
 * The date and a hash of the heading as printed; when the heading is only
 * the date, of the first sentence too, since the archive has days with two
 * such entries.
 */
function announcementId(a: OflcAnnouncement): string {
  const key = hasHeading(a) ? a.headingLine : `${a.headingLine} ${firstSentence(a)}`;
  return `${a.date ?? a.dateText}:${sha256Hex(key.replace(/\s+/g, " ").trim().toLowerCase()).slice(0, 12)}`;
}

/** The heading without its date; for a heading that is only a date, the entry's first sentence (or the date when the entry has no text). */
function announcementTitle(a: OflcAnnouncement): string {
  if (hasHeading(a)) return a.heading;
  return firstSentence(a).replace(/[.]$/, "") || a.headingLine.replace(/[\s,.:]+$/, "");
}

type AnnouncementListing = { page: string; dateText: string; heading: string };

async function readAnnouncements(ctx: LibraryAdapterContext, withArchive: boolean): Promise<DocumentRef[]> {
  const { text } = await cachedPage(ctx, NEWS_URL);
  const article = dolArticle(text);
  const current = article ? parseOflcAnnouncements(article) : [];
  if (current.length === 0) throw new LibraryLayoutError(NEWS_URL, "no dated announcement entries");
  const refs: DocumentRef[] = [];
  const seen = new Set<string>();
  const add = (a: OflcAnnouncement, page: string) => {
    const id = announcementId(a);
    if (seen.has(id)) return;
    seen.add(id);
    refs.push({
      externalId: id,
      url: page,
      title: announcementTitle(a),
      fingerprint: fingerprintOf(a.headingLine, sha256Hex(a.html)),
      listing: { page, dateText: a.dateText, heading: a.heading } satisfies AnnouncementListing,
    });
  };
  for (const a of current) add(a, NEWS_URL);
  if (withArchive) {
    const { text: archiveHtml } = await cachedPage(ctx, ARCHIVE_URL);
    const archiveArticle = dolArticle(archiveHtml);
    const archived = archiveArticle ? parseOflcArchive(archiveArticle) : [];
    if (archived.length === 0) throw new LibraryLayoutError(ARCHIVE_URL, "no dated entries under the Calendar Year headings");
    // The archive overlaps the current page from August 2012 to 2014; the current page's copy is kept.
    const oldest = current.map((a) => a.date).filter((d): d is string => Boolean(d)).sort()[0] ?? "9999";
    for (const a of archived) if (a.date && a.date < oldest) add(a, ARCHIVE_URL);
  }
  return refs;
}

export const dolOflcAnnouncementsAdapter: LibrarySourceAdapter = {
  code: "dol_oflc_announcements",
  group: "other-agency-guidance",
  name: "DOL Office of Foreign Labor Certification announcements",
  description:
    "OFLC's dated announcements on the labor certification programs (PERM, H-1B labor condition applications, H-2A, H-2B, CW-1, prevailing wages): processing changes, filing instructions, wage updates and rule implementation, from OFLC's announcements page and its archive.",
  coverage: "Every announcement on OFLC's announcements page (August 2012 to the present) and on its archive page (2005 to July 2012).",
  cadence: "Daily",
  officialUrl: NEWS_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 90,

  async listUpdates(ctx) {
    return { refs: await readAnnouncements(ctx, false) };
  },

  async backfill(ctx): Promise<BackfillChunk> {
    // Two pages hold every announcement and each is read once per run, so one chunk is the whole history.
    const refs = await readAnnouncements(ctx, true);
    return { refs, nextCursor: null, progress: `${refs.length} announcements on the current and archive pages` };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as AnnouncementListing | undefined;
    if (!listing?.page) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const { text, response } = await cachedPage(ctx, listing.page);
    const article = dolArticle(text) ?? "";
    const entries = listing.page === ARCHIVE_URL ? parseOflcArchive(article) : parseOflcAnnouncements(article);
    const entry = entries.find((a) => announcementId(a) === ref.externalId);
    if (!entry) return { kind: "skip", reason: `${ref.externalId}: the announcement is no longer on ${listing.page}.` };
    const links = anchors(entry.html)
      .map((a) => ({ label: a.text, url: resolveUrl(a.href, response.url) }))
      .filter((l) => l.url && /^https?:/.test(l.url) && !/webex\.com/i.test(l.url));
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "notice",
        title: announcementTitle(entry),
        citations: [],
        agency: AGENCY,
        publishedDate: entry.date,
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        text: [entry.headingLine, htmlToDocumentText(entry.html)].filter(Boolean).join("\n\n"),
        metadata: {
          headingAsPrinted: entry.headingLine,
          listedOn: listing.page === ARCHIVE_URL ? "OFLC announcements archive" : "OFLC announcements",
          ...(links.length ? { links } : {}),
          statedDates: { posted: entry.dateText },
        },
        fetch: { response },
      },
    };
  },
};

type FaqListing = { label: string; section: string | null };

async function readFaqs(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await cachedPage(ctx, FAQ_URL);
  const article = dolArticle(text);
  const links = article ? parseOflcFaqLinks(article, response.url) : [];
  if (links.length === 0) throw new LibraryLayoutError(FAQ_URL, "no FAQ round PDFs in the page body");
  return links.map((l) => ({
    externalId: pathId(l.url),
    url: l.url,
    // The group heading reads "Download H-2A 2022 Final Rule FAQs (PDF)"; the title keeps its subject.
    title: l.section ? `${l.section.replace(/^Download\s+/i, "").replace(/\s*\(PDF\)\s*$/i, "")}: ${l.label}` : l.label,
    fingerprint: fingerprintOf(l.label, l.section, l.url),
    listing: { label: l.label, section: l.section } satisfies FaqListing,
  }));
}

export const dolOflcFaqsAdapter: LibrarySourceAdapter = {
  code: "dol_oflc_faqs",
  group: "other-agency-guidance",
  name: "DOL Office of Foreign Labor Certification FAQs",
  description:
    "OFLC's frequently asked questions on the permanent and temporary labor certification programs, labor condition applications and prevailing wage determinations, as the PDF rounds OFLC lists on its FAQ page.",
  coverage: "Every FAQ round PDF linked from OFLC's FAQ page. OFLC's former searchable FAQ database, now only on an outside web archive, is not collected.",
  cadence: "Daily",
  officialUrl: FAQ_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 60,

  async listUpdates(ctx) {
    return { refs: await readFaqs(ctx) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const all = await readFaqs(ctx);
    const { items, nextCursor, progress } = chunkOf(all, cursor, 150);
    return { refs: items, nextCursor, progress };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as FaqListing | undefined;
    const file = await fetchFileText(ctx, ref.url, ref.known);
    if (file === "not_modified") return { kind: "not_modified" };
    // A round prints its issue date under its heading on the first page ("August 3, 2023").
    const issued = /\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4})\b/.exec(file.text.slice(0, 800))?.[1] ?? null;
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "web_guidance",
        publishedDate: parseStatedDate(issued),
        title: ref.title ?? listing?.label ?? ref.externalId,
        citations: [],
        agency: AGENCY,
        precedentialStatus: "not_applicable",
        ...fileFields(file),
        metadata: {
          linkLabel: listing?.label ?? null,
          ...(listing?.section ? { faqGroup: listing.section } : {}),
          listedOn: FAQ_URL,
          ...(issued ? { statedDates: { issued } } : {}),
          ...fileMetadata(file),
        },
      },
    };
  },
};
