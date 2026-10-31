import { htmlToDocumentText, resolveUrl } from "../../extract/html";
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
import { countryFields } from "./country";

// The UK Home Office's Country Policy and Information Notes (CPINs), with
// the country information notes, bulletins and fact-finding mission reports
// published beside them, read through the GOV.UK Content API (documented
// at https://content-api.publishing.service.gov.uk/), which serves every
// GOV.UK page's content item as JSON at /api/content<page path>.
//
// - The collection "Country policy and information notes" lists one
//   publication per country ("Afghanistan: country policy and information
//   notes"), each with the notes in force as attachments: an HTML version
//   ("... (accessible)") and the PDF, or a PDF alone. GOV.UK keeps only the
//   current notes on a country's page (a new version replaces the old one),
//   so this collector holds the notes current when it reads them, and older
//   versions it stored before; it cannot reach versions GOV.UK replaced
//   earlier.
// - One document per note: the HTML attachment when there is one (its
//   content item has the note's text, its first-published time and its
//   version line), else the PDF. The PDF beside an HTML version is linked in
//   metadata.pdfUrl.
// - Daily: the collection, then the country publications updated since the
//   last run (the collection states each one's public_updated_at).
//   Backfill: every country publication, in one chunk (about 50 requests
//   plus one per note).
//
// Licence: GOV.UK content is published under the Open Government Licence
// v3.0 (https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/),
// which permits reuse with attribution; but the OGL does not cover
// third-party material, and the notes are largely made of quotations from
// other publishers' reports (UNHCR, NGOs, news media), whose rights the
// Home Office cannot license. The library also has no way yet to show an
// attribution statement beside a stored text. So the notes are link_only:
// the pipeline keeps the metadata, a short excerpt and the GOV.UK link,
// never the whole text or the file (docs/LIBRARY.md, section 5).

const HOST = "www.gov.uk";
const ASSETS_HOST = "assets.publishing.service.gov.uk";
const COLLECTION_PAGE = "https://www.gov.uk/government/collections/country-policy-and-information-notes";
const COLLECTION_API = "https://www.gov.uk/api/content/government/collections/country-policy-and-information-notes";
const AGENCY = "UK Home Office";
const ATTRIBUTION = "Contains public sector information licensed under the Open Government Licence v3.0.";

type LinkedItem = { api_url?: string; base_path?: string; web_url?: string; title?: string; public_updated_at?: string; withdrawn?: boolean };
type Attachment = {
  attachment_type?: string;
  id?: string;
  title?: string;
  url?: string;
  content_type?: string;
  filename?: string;
  number_of_pages?: number;
  file_size?: number;
};
type ContentItem = {
  title?: string;
  base_path?: string;
  document_type?: string;
  schema_name?: string;
  first_published_at?: string;
  public_updated_at?: string;
  withdrawn_notice?: { explanation?: string; withdrawn_at?: string } | Record<string, never>;
  details?: { attachments?: Attachment[]; body?: string; change_history?: { note?: string; public_timestamp?: string }[] };
  links?: { documents?: LinkedItem[]; parent?: LinkedItem[] };
};

type Listing = {
  kind: "html" | "pdf";
  /** The country as the publication's title names it. */
  country: string | null;
  publicationTitle: string;
  publicationUrl: string;
  attachmentId: string | null;
  attachmentTitle: string;
  /** The PDF beside an HTML version (or the PDF itself). */
  pdfUrl: string | null;
  pdfTitle: string | null;
  pages: number | null;
};

/** A note's title without the "(accessible)" marker GOV.UK adds to HTML versions, for pairing it with its PDF. */
function pairingKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(\s*access[a-z]*(?:\s+version)?\s*\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The country before ": country policy and information notes" in a publication's title. */
function publicationCountry(title: string): string | null {
  const m = /^(.+?):\s*country policy and information notes?\b/i.exec(title.trim());
  return m ? m[1].trim() : null;
}

/** The documented Content API address of a GOV.UK page (https://content-api.publishing.service.gov.uk/#gov-uk-content-api). */
function contentApiUrl(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    if (u.hostname !== HOST) return null;
    return `https://${HOST}/api/content${u.pathname}`;
  } catch {
    return null;
  }
}

async function readCollection(ctx: LibraryAdapterContext): Promise<LinkedItem[]> {
  const { data } = await ctx.http.getJson<ContentItem>(COLLECTION_API);
  const docs = data.links?.documents;
  if (!Array.isArray(docs) || docs.length === 0) throw new LibraryLayoutError(COLLECTION_API, "the collection links no documents");
  return docs.filter((d) => typeof d.api_url === "string" && typeof d.title === "string");
}

/** The refs of one country publication's notes. */
async function publicationRefs(ctx: LibraryAdapterContext, doc: LinkedItem): Promise<DocumentRef[]> {
  const apiUrl = doc.api_url!;
  const { data } = await ctx.http.getJson<ContentItem>(apiUrl);
  const attachments = data.details?.attachments;
  if (!Array.isArray(attachments)) throw new LibraryLayoutError(apiUrl, "no attachments list in the publication's details");
  const publicationTitle = data.title ?? doc.title ?? "";
  const publicationUrl = doc.web_url ?? resolveUrl(data.base_path ?? "", `https://${HOST}/`) ?? COLLECTION_PAGE;
  const country = publicationCountry(publicationTitle);
  const files = attachments.filter((a) => a.attachment_type === "file" && a.url && /pdf/i.test(a.content_type ?? a.filename ?? ""));
  const htmls = attachments.filter((a) => a.attachment_type === "html" && a.url);
  const refs: DocumentRef[] = [];
  const paired = new Set<Attachment>();
  for (const h of htmls) {
    const url = resolveUrl(h.url!, publicationUrl);
    if (!url) continue;
    const pdf = files.find((f) => !paired.has(f) && pairingKey(f.title ?? "") === pairingKey(h.title ?? ""));
    if (pdf) paired.add(pdf);
    const listing: Listing = {
      kind: "html",
      country,
      publicationTitle,
      publicationUrl,
      attachmentId: h.id ?? null,
      attachmentTitle: (h.title ?? "").trim(),
      pdfUrl: pdf?.url ? resolveUrl(pdf.url, publicationUrl) : null,
      pdfTitle: pdf?.title?.trim() ?? null,
      pages: pdf?.number_of_pages ?? null,
    };
    refs.push({
      externalId: new URL(url).pathname,
      url,
      title: listing.pdfTitle ?? listing.attachmentTitle,
      fingerprint: sha256Hex([url, listing.attachmentTitle, listing.pdfUrl ?? ""].join("\u0000")).slice(0, 32),
      listing,
    });
  }
  for (const f of files) {
    if (paired.has(f)) continue;
    const url = resolveUrl(f.url!, publicationUrl);
    if (!url || !f.id) continue;
    const listing: Listing = {
      kind: "pdf",
      country,
      publicationTitle,
      publicationUrl,
      attachmentId: f.id,
      attachmentTitle: (f.title ?? "").trim(),
      pdfUrl: url,
      pdfTitle: f.title?.trim() ?? null,
      pages: f.number_of_pages ?? null,
    };
    refs.push({
      // GOV.UK's own attachment id: the file's address changes when it is re-uploaded, the attachment's id does not.
      externalId: `${new URL(publicationUrl).pathname}#attachment-${f.id}`,
      url,
      title: listing.attachmentTitle,
      fingerprint: sha256Hex([url, listing.attachmentTitle].join("\u0000")).slice(0, 32),
      listing,
    });
  }
  return refs;
}

async function allRefs(ctx: LibraryAdapterContext, docs: LinkedItem[]): Promise<DocumentRef[]> {
  const refs: DocumentRef[] = [];
  for (const doc of docs) refs.push(...(await publicationRefs(ctx, doc)));
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.externalId) ? false : (seen.add(r.externalId), true)));
}

/** The edition a note's title ends with ("..., Afghanistan, February 2026 (accessible)" gives "February 2026"). */
function editionOf(title: string): { text: string; year: number } | null {
  const m = /,\s*((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4}))\s*(?:\([^)]*\))?\s*$/i.exec(title.trim());
  return m ? { text: m[1], year: Number(m[2]) } : null;
}

/** The "Version 6.0, February 2026" line a note prints first. */
function versionLine(text: string): string | null {
  const m = /^\s*(Version\s+[\d.]+\b[^\n]{0,40})/im.exec(text.slice(0, 2000));
  return m ? m[1].trim() : null;
}

export const ukHomeOfficeCpinAdapter: LibrarySourceAdapter = {
  code: "uk_home_office_cpin",
  group: "country-conditions",
  name: "UK Home Office Country Policy and Information Notes",
  description:
    "The UK Home Office's Country Policy and Information Notes and the country information notes, bulletins and fact-finding reports published with them, by country, read through the GOV.UK Content API. Stored as metadata, a short excerpt and the GOV.UK link.",
  coverage:
    "The notes each country's page in GOV.UK's Country policy and information notes collection lists when the collector reads it (GOV.UK keeps only the notes in force), and the versions collected before; earlier versions GOV.UK replaced before collection began are not held.",
  cadence: "Daily",
  officialUrl: COLLECTION_PAGE,
  hosts: [HOST, ASSETS_HOST],
  license: "link_only",
  licenseNote:
    "GOV.UK publishes the notes under the Open Government Licence, which does not cover the third-party material the notes largely quote; only metadata, a short excerpt and the link are kept.",
  staleAfterHours: 48,
  recheckAfterDays: 30,

  async listUpdates(ctx, since) {
    const docs = await readCollection(ctx);
    // A day of margin: public_updated_at is the publication's own time.
    const cutoff = since ? since.getTime() - 24 * 60 * 60 * 1000 : null;
    const changed = cutoff
      ? docs.filter((d) => {
          const t = d.public_updated_at ? new Date(d.public_updated_at).getTime() : NaN;
          return Number.isNaN(t) || t >= cutoff;
        })
      : docs;
    return { refs: await allRefs(ctx, changed) };
  },

  async backfill(ctx): Promise<BackfillChunk> {
    // GOV.UK lists only the notes in force, so the whole history it offers is the current listing.
    const docs = await readCollection(ctx);
    const refs = await allRefs(ctx, docs);
    return { refs, nextCursor: null, progress: `${docs.length} country pages, ${refs.length} notes` };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const common = {
      externalId: ref.externalId,
      docType: "report" as const,
      citations: [],
      agency: AGENCY,
      precedentialStatus: "not_applicable" as const,
    };
    const edition = editionOf(listing.pdfTitle ?? listing.attachmentTitle);
    const baseMetadata = {
      ...countryFields(listing.country),
      ...(edition ? { edition: edition.text } : {}),
      publicationTitle: listing.publicationTitle,
      publicationUrl: listing.publicationUrl,
      ...(listing.attachmentId ? { attachmentId: listing.attachmentId } : {}),
      ...(listing.pdfUrl ? { pdfUrl: listing.pdfUrl } : {}),
      ...(listing.pages ? { pdfPages: listing.pages } : {}),
      licence: "Open Government Licence v3.0",
      attribution: ATTRIBUTION,
    };

    if (listing.kind === "pdf") {
      const response = await ctx.http.get(ref.url, { expect: "pdf", conditional: ref.known ?? null });
      if (response.notModified) return { kind: "not_modified" };
      const pdf = await extractPdfText(response.body);
      const text = pdf.pagesWithText > 0 ? pdf.text : "";
      const version = versionLine(text.replace(/\[Page \d+\]/g, ""));
      // An archived note's PDF opens with GOV.UK's archive stamp ("This publication was archived on 12 October 2026.").
      const archived = /This publication was archived on\s+([^.\n]+(?:\n[^.\n]+)?)\./i.exec(text.slice(0, 600));
      return {
        kind: "document",
        document: {
          ...common,
          title: listing.attachmentTitle,
          // The month and year a note's title ends with is its edition ("..., Afghanistan, February 2026").
          documentYear: editionOf(listing.attachmentTitle)?.year ?? null,
          officialUrl: listing.publicationUrl,
          originalUrl: response.url,
          text,
          textKind: text ? "excerpt" : "none",
          metadata: { ...baseMetadata, ...(version ? { version } : {}), format: "pdf" },
          withdrawn: archived ? { reason: `The PDF states: This publication was archived on ${archived[1].replace(/\s+/g, " ").trim()}.` } : null,
          fetch: { response, extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated } },
        },
      };
    }

    const apiUrl = contentApiUrl(ref.url);
    if (!apiUrl) return { kind: "skip", reason: `${ref.url} is not a GOV.UK page.` };
    const { text: raw, response } = await ctx.http.getText(apiUrl, { expect: "json", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    let item: ContentItem;
    try {
      item = JSON.parse(raw) as ContentItem;
    } catch {
      throw new LibraryLayoutError(apiUrl, "not JSON");
    }
    const body = item.details?.body;
    if (item.schema_name !== "html_publication" || typeof body !== "string") throw new LibraryLayoutError(apiUrl, "not an html_publication with a body");
    const text = htmlToDocumentText(body);
    const version = versionLine(text);
    const withdrawn = item.withdrawn_notice && "explanation" in item.withdrawn_notice && item.withdrawn_notice.explanation ? item.withdrawn_notice.explanation : null;
    return {
      kind: "document",
      document: {
        ...common,
        title: listing.pdfTitle ?? item.title ?? listing.attachmentTitle,
        // GOV.UK reuses a note's HTML page for its later versions, so the page's first_published_at can predate the
        // version it now shows; the note's own edition is the month and year its title ends with.
        documentYear: editionOf(listing.pdfTitle ?? item.title ?? listing.attachmentTitle)?.year ?? null,
        officialUrl: ref.url,
        text,
        textKind: "excerpt",
        metadata: {
          ...baseMetadata,
          htmlTitle: item.title ?? listing.attachmentTitle,
          ...(version ? { version } : {}),
          format: "html",
          statedDates: {
            ...(item.first_published_at ? { firstPublished: item.first_published_at } : {}),
            ...(item.public_updated_at ? { publicUpdated: item.public_updated_at } : {}),
          },
        },
        withdrawn: withdrawn ? { reason: withdrawn } : null,
        fetch: { response },
      },
    };
  },
};
