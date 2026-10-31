import type { BackfillChunk, LibraryAdapterContext, LibrarySourceAdapter } from "../../types";
import { DHS_HOSTS, fetchPublicationDocument, readDhsCollection, refsForPublications } from "./dhs-publications";

// The Office of the Citizenship and Immigration Services Ombudsman's
// publications, from the Ombudsman's topic in dhs.gov's publications
// library: the annual reports to Congress, the formal recommendations to
// USCIS (and USCIS's responses where DHS posts them), tip sheets, webinar
// summaries and the office's other papers. Each publication page is read
// for its attached files; each attached PDF is one document, dated as the
// page's file table dates it, with the publication page's description as
// its summary.
//
// - Daily and backfill read the whole topic list (about 90 publications,
//   50 a page) and every publication page, then fetch what changed; the
//   backfill hands the documents out CHUNK_SIZE at a time.
// - dhs.gov's robots.txt sets no Crawl-delay (it disallows /archive/, which
//   these pages do not use).
//
// US government work: public domain, stored in full.

const TOPIC_URL = "https://www.dhs.gov/publications-library/office-of-the-citizenship-and-immigration-services-ombudsman";
const AGENCY = "U.S. Department of Homeland Security, Office of the Citizenship and Immigration Services Ombudsman";
const CHUNK_SIZE = 120;

async function listAll(ctx: LibraryAdapterContext) {
  const { items, pageUrls } = await readDhsCollection(ctx, TOPIC_URL);
  return refsForPublications(
    ctx,
    items.map((item) => ({ url: item.url, item, listedOn: pageUrls[0] ?? TOPIC_URL }))
  );
}

function isCursor(value: unknown): value is { offset: number } {
  return Boolean(value) && Number.isInteger((value as { offset: number }).offset) && (value as { offset: number }).offset >= 0;
}

export const cisOmbudsmanAdapter: LibrarySourceAdapter = {
  code: "dhs_cis_ombudsman",
  group: "other-agency-guidance",
  name: "CIS Ombudsman reports and recommendations (DHS)",
  description:
    "The Citizenship and Immigration Services Ombudsman's annual reports to Congress, formal recommendations to USCIS and other publications, read from the Ombudsman's publications on dhs.gov.",
  coverage:
    "Every publication dhs.gov's publications library lists under the Office of the Citizenship and Immigration Services Ombudsman, one document per attached PDF (a publication without a PDF is held as its page).",
  cadence: "Daily",
  officialUrl: TOPIC_URL,
  hosts: DHS_HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 60,

  async listUpdates(ctx) {
    return { refs: await listAll(ctx) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const all = await listAll(ctx);
    const offset = isCursor(cursor) ? Math.min(cursor.offset, all.length) : 0;
    const refs = all.slice(offset, offset + CHUNK_SIZE);
    const next = offset + CHUNK_SIZE;
    return { refs, nextCursor: next < all.length ? { offset: next } : null, progress: `documents ${offset + 1} to ${offset + refs.length} of ${all.length} listed` };
  },

  fetchDocument(ctx, ref) {
    return fetchPublicationDocument(ctx, ref, {
      docType: "report",
      agency: AGENCY,
      // An attachment's label alone can be terse ("2025 Annual Report"); the publication's title goes before it.
      title: (l) =>
        l.attachment && l.publicationTitle && !l.attachment.label.includes(l.publicationTitle)
          ? `${l.publicationTitle}: ${l.attachment.label}`
          : (l.attachment?.label ?? l.publicationTitle ?? ref.externalId),
      extraMetadata: (l) => {
        const number = l.attachment ? /Recommendation\s+(?:Number|No\.?|#)\s*(\d+)/i.exec(l.attachment.label)?.[1] : undefined;
        return number ? { recommendationNumber: Number(number) } : {};
      },
    });
  },
};
