import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText } from "../../extract/html";
import { LibraryLayoutError, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibraryDocType } from "../../types";
import { fetchFileText, fileFields, fileMetadata, fingerprintOf } from "./files";
import { isFileUrl, isPdfUrl, parseDhsCollection, parseDhsPublication, type DhsAttachment, type DhsListingItem, type DhsPublication } from "./parse";

// Shared by the collectors that read dhs.gov's publications library (the
// CIS Ombudsman's publications, the Headquarters Guidance Documents
// collection, the Management Directives topic pages). A dhs.gov
// "publication" is a page with a description and a table of attached files;
// each attached PDF is one library document (a recommendation, a report, a
// directive), and a publication with no PDF is held as its page. dhs.gov
// sends no validators on these pages, so they are read each run and the
// fingerprints decide what is fetched again. US government work.

export const DHS_HOSTS = ["www.dhs.gov", "dhs.gov"] as const;

export type DhsPublicationListing = {
  publicationUrl: string;
  publicationTitle: string | null;
  /** The publication page's own description (its body), when it is not boilerplate. */
  publicationSummary: string | null;
  lastUpdated: string | null;
  collections: string[];
  topics: string[];
  keywords: string[];
  /** The entry as the collection or index listed it. */
  listedTitle: string | null;
  listedDate: string | null;
  listedOn: string | null;
  /** The attached file this document is, or null for the page itself. */
  attachment: DhsAttachment | null;
};

/** Every /publication/ link of a collection or topic listing, all pages, at 50 a page (the page's own "Items per page" choice). */
export async function readDhsCollection(ctx: LibraryAdapterContext, collectionUrl: string, maxPages = 40): Promise<{ items: DhsListingItem[]; pageUrls: string[] }> {
  const items: DhsListingItem[] = [];
  const pageUrls: string[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(collectionUrl);
    url.searchParams.set("items_per_page", "50");
    if (page > 0) url.searchParams.set("page", String(page));
    const { text, response } = await ctx.http.getText(url.toString(), { expect: "html" });
    const parsed = parseDhsCollection(text, response.url, DHS_HOSTS);
    if (!parsed.recognized) throw new LibraryLayoutError(url.toString(), "no publications list");
    if (page === 0 && parsed.items.length === 0) throw new LibraryLayoutError(url.toString(), "the publications list is empty");
    pageUrls.push(response.url);
    let added = 0;
    for (const item of parsed.items) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      items.push(item);
      added++;
    }
    if (!parsed.hasNext || added === 0) break;
  }
  return { items, pageUrls };
}

/** A publication page, read and checked. */
export async function readDhsPublication(ctx: LibraryAdapterContext, url: string): Promise<{ publication: DhsPublication; finalUrl: string }> {
  const { text, response } = await ctx.http.getText(url, { expect: "html" });
  const publication = parseDhsPublication(text, response.url, DHS_HOSTS);
  if (!publication.recognized) throw new LibraryLayoutError(url, "not a dhs.gov publication page (no title or content block)");
  return { publication, finalUrl: response.url };
}

export type AttachmentIdStrategy = (publicationPath: string, attachment: DhsAttachment, siblings: DhsAttachment[]) => string;

/** The default id of an attached file: the publication's path and the file's label as the page lists it (stable when DHS re-posts a file). */
export const labelId: AttachmentIdStrategy = (path, attachment, siblings) => {
  const sameLabel = siblings.filter((s) => s.label === attachment.label).length > 1;
  return sameLabel ? `${path}#${new URL(attachment.url).pathname.split("/").pop()}` : `${path}#${attachment.label}`;
};

/** The refs of one publication: one per attached PDF, or the page itself when it attaches none. */
export function publicationRefs(
  ctx: LibraryAdapterContext,
  args: {
    publication: DhsPublication;
    publicationUrl: string;
    item: DhsListingItem | null;
    listedOn: string | null;
    idFor?: AttachmentIdStrategy;
    /** Whether the page's body is boilerplate (the Management Directives topic pages): not kept as a summary. */
    bodyIsBoilerplate?: boolean;
  }
): DocumentRef[] {
  const { publication, publicationUrl, item } = args;
  const path = new URL(publicationUrl).pathname;
  const summary = !args.bodyIsBoilerplate && publication.bodyHtml ? htmlToDocumentText(publication.bodyHtml) || null : null;
  const base: Omit<DhsPublicationListing, "attachment"> = {
    publicationUrl,
    publicationTitle: publication.title,
    publicationSummary: summary,
    lastUpdated: publication.lastUpdated,
    collections: publication.collections,
    topics: publication.topics,
    keywords: publication.keywords,
    listedTitle: item?.title ?? null,
    listedDate: item?.dateText ?? null,
    listedOn: args.listedOn,
  };
  const pdfs = publication.attachments.filter((a) => isPdfUrl(a.url));
  for (const other of publication.attachments.filter((a) => !isPdfUrl(a.url))) {
    ctx.note(`${path}: the attached ${other.ext ?? "file"} "${other.label}" is not a PDF and was not read.`);
  }
  if (pdfs.length === 0) {
    if (!summary && !publication.bodyHtml) {
      ctx.note(`${path}: the publication has no PDF and no description; nothing to hold.`);
      return [];
    }
    const listing: DhsPublicationListing = { ...base, attachment: null };
    return [
      {
        externalId: path,
        url: publicationUrl,
        title: publication.title ?? item?.title ?? path,
        fingerprint: fingerprintOf(publication.title, summary, publication.lastUpdated),
        listing,
      },
    ];
  }
  const idFor = args.idFor ?? labelId;
  return pdfs.map((attachment) => {
    const listing: DhsPublicationListing = { ...base, attachment };
    return {
      externalId: idFor(path, attachment, pdfs),
      url: attachment.url,
      title: attachment.label || publication.title || path,
      fingerprint: fingerprintOf(publication.title, attachment.label, attachment.url, attachment.size, attachment.dateText, summary),
      listing,
    };
  });
}

/** Reads one publication document: the attached PDF, or the publication page itself. */
export async function fetchPublicationDocument(
  ctx: LibraryAdapterContext,
  ref: DocumentRef,
  args: { docType: LibraryDocType; agency: string; title?: (listing: DhsPublicationListing) => string; citations?: (listing: DhsPublicationListing) => string[]; extraMetadata?: (listing: DhsPublicationListing) => Record<string, unknown> }
): Promise<FetchDocumentResult> {
  const listing = ref.listing as DhsPublicationListing | undefined;
  if (!listing?.publicationUrl) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
  const attachment = listing.attachment;
  if (attachment && isFileUrl(attachment.url) && !isPdfUrl(attachment.url)) return { kind: "skip", reason: `${ref.externalId}: not a PDF.` };
  const file = await fetchFileText(ctx, ref.url, ref.known, {
    htmlContent: (html) => parseDhsPublication(html, ref.url, DHS_HOSTS).bodyHtml,
  });
  if (file === "not_modified") return { kind: "not_modified" };
  const fileDate = attachment?.dateText ?? null;
  const title = args.title?.(listing) ?? (attachment ? attachment.label : (listing.publicationTitle ?? ref.title ?? ref.externalId));
  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType: args.docType,
      title,
      citations: args.citations?.(listing) ?? [],
      agency: args.agency,
      publishedDate: parseStatedDate(fileDate),
      precedentialStatus: "not_applicable",
      ...fileFields(file),
      metadata: {
        publicationPage: listing.publicationUrl,
        ...(listing.publicationTitle ? { publicationTitle: listing.publicationTitle } : {}),
        ...(listing.publicationSummary ? { summary: listing.publicationSummary, summaryKind: "the publication page's description" } : {}),
        ...(attachment ? { fileLabel: attachment.label, fileType: attachment.ext, fileSize: attachment.size } : {}),
        ...(listing.collections.length ? { collections: listing.collections } : {}),
        ...(listing.topics.length ? { topics: listing.topics } : {}),
        ...(listing.keywords.length ? { keywords: listing.keywords } : {}),
        ...(listing.listedOn ? { listedOn: listing.listedOn } : {}),
        statedDates: {
          ...(fileDate ? { fileDate } : {}),
          ...(listing.lastUpdated ? { publicationLastUpdated: listing.lastUpdated } : {}),
          ...(listing.listedDate ? { listed: listing.listedDate } : {}),
        },
        ...(args.extraMetadata?.(listing) ?? {}),
        ...fileMetadata(file),
      },
    },
  };
}

/** Reads every publication a listing names and returns their refs; a page that fails is noted and skipped. */
export async function refsForPublications(
  ctx: LibraryAdapterContext,
  items: { url: string; item: DhsListingItem | null; listedOn: string | null }[],
  options: { idFor?: AttachmentIdStrategy; bodyIsBoilerplate?: boolean } = {}
): Promise<DocumentRef[]> {
  const refs = new Map<string, DocumentRef>();
  let failures = 0;
  for (const entry of items) {
    let read;
    try {
      read = await readDhsPublication(ctx, entry.url);
    } catch (err) {
      // One unreadable publication page is noted; when none can be read the layout has changed and the run fails.
      failures++;
      ctx.note(`${entry.url} could not be read (${err instanceof Error ? err.message : String(err)}); its documents were not listed.`);
      continue;
    }
    for (const ref of publicationRefs(ctx, { publication: read.publication, publicationUrl: read.finalUrl, item: entry.item, listedOn: entry.listedOn, ...options })) {
      if (refs.has(ref.externalId)) ctx.note(`${ref.externalId} is listed more than once; the first was kept.`);
      else refs.set(ref.externalId, ref);
    }
  }
  if (items.length > 0 && failures === items.length) throw new LibraryLayoutError(items[0].url, "no publication page could be read");
  return [...refs.values()];
}
