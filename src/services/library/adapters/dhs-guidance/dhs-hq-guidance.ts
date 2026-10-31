import type { LibraryAdapterContext, LibrarySourceAdapter } from "../../types";
import { DHS_HOSTS, fetchPublicationDocument, readDhsCollection, refsForPublications } from "./dhs-publications";

// DHS headquarters guidance documents: the "Headquarters Guidance Documents"
// collection that dhs.gov/guidance points to for guidance issued by DHS
// headquarters offices (the components' guidance lives on their own sites
// and is collected by their own adapters). Each publication page is read
// for its attached files; each attached PDF is one document, and a
// publication with no PDF is held as its page. The collection is small
// (about twenty publications), so daily and backfill read all of it.
//
// US government work: public domain, stored in full.

const COLLECTION_URL = "https://www.dhs.gov/publications-library/collections/headquarters-guidance-documents";
const AGENCY = "U.S. Department of Homeland Security";

async function listAll(ctx: LibraryAdapterContext) {
  const { items, pageUrls } = await readDhsCollection(ctx, COLLECTION_URL);
  return refsForPublications(
    ctx,
    items.map((item) => ({ url: item.url, item, listedOn: pageUrls[0] ?? COLLECTION_URL }))
  );
}

export const dhsHqGuidanceAdapter: LibrarySourceAdapter = {
  code: "dhs_headquarters_guidance",
  group: "other-agency-guidance",
  name: "DHS headquarters guidance documents",
  description:
    "Guidance documents issued by DHS headquarters (among them the policy on classified information in immigration proceedings), from the Headquarters Guidance Documents collection on dhs.gov.",
  coverage:
    "Every publication in dhs.gov's Headquarters Guidance Documents collection, one document per attached PDF (a publication without a PDF is held as its page).",
  cadence: "Daily",
  officialUrl: COLLECTION_URL,
  hosts: DHS_HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 60,

  async listUpdates(ctx) {
    return { refs: await listAll(ctx) };
  },

  async backfill(ctx) {
    const refs = await listAll(ctx);
    return { refs, nextCursor: null, progress: `${refs.length} documents in the collection` };
  },

  fetchDocument(ctx, ref) {
    return fetchPublicationDocument(ctx, ref, {
      docType: "policy_memorandum",
      agency: AGENCY,
      title: (l) =>
        l.attachment && l.publicationTitle && l.attachment.label !== l.publicationTitle
          ? `${l.publicationTitle}: ${l.attachment.label}`
          : (l.attachment?.label ?? l.publicationTitle ?? ref.externalId),
    });
  },
};
