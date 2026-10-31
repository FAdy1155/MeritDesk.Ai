import { LibraryLayoutError, type BackfillChunk, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { DHS_HOSTS, fetchPublicationDocument, labelId, refsForPublications, type AttachmentIdStrategy } from "./dhs-publications";
import { directiveNumber, parseManagementDirectivesIndex } from "./parse";

// The DHS Management Directives System: the Department's directives and
// instructions, listed on dhs.gov's Management Directives page by topic.
// Each topic page attaches the directives and instructions as PDFs labeled
// with their number, title and revision ("034-06 Department Reporting
// Requirements, Revision: 01"). Each PDF is one document, keyed by the
// number its label starts with, so a new revision of a directive becomes a
// new version of the same document.
//
// Daily and backfill read the index and every topic page (about thirty);
// the backfill hands the documents out CHUNK_SIZE at a time.
// US government work: public domain, stored in full.

const INDEX_URL = "https://www.dhs.gov/department-homeland-security-management-directives";
const AGENCY = "U.S. Department of Homeland Security";
const CHUNK_SIZE = 150;

/** "MD 117-01" from the label's number; the label itself when it carries none. */
const directiveId: AttachmentIdStrategy = (path, attachment, siblings) => {
  const number = directiveNumber(attachment.label);
  if (!number) return labelId(path, attachment, siblings);
  return /^MD\s/i.test(number) ? number.toUpperCase().replace(/\s+/g, " ") : `MD ${number}`;
};

async function listAll(ctx: LibraryAdapterContext) {
  const { text, response } = await ctx.http.getText(INDEX_URL, { expect: "html" });
  const topics = parseManagementDirectivesIndex(text, response.url, DHS_HOSTS);
  if (topics.length === 0) throw new LibraryLayoutError(INDEX_URL, "no topic links under the directives list");
  return refsForPublications(
    ctx,
    topics.map((t) => ({ url: t.url, item: { url: t.url, title: t.label, dateText: null, datetime: null, description: null }, listedOn: INDEX_URL })),
    { idFor: directiveId, bodyIsBoilerplate: true }
  );
}

function isCursor(value: unknown): value is { offset: number } {
  return Boolean(value) && Number.isInteger((value as { offset: number }).offset) && (value as { offset: number }).offset >= 0;
}

function revisionOf(label: string): string | null {
  return /Revision:?\s*(\d+)/i.exec(label)?.[1] ?? null;
}

export const dhsManagementDirectivesAdapter: LibrarySourceAdapter = {
  code: "dhs_management_directives",
  group: "other-agency-guidance",
  name: "DHS Management Directives and Instructions",
  description:
    "The Department of Homeland Security's management directives and instructions, as DHS lists them by topic on its Management Directives page.",
  coverage: "Every directive and instruction PDF attached to the topic pages linked from DHS's Management Directives page.",
  cadence: "Daily",
  officialUrl: INDEX_URL,
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
      docType: "policy_memorandum",
      agency: AGENCY,
      title: (l) => (l.attachment ? `DHS Management Directive ${l.attachment.label}` : (l.publicationTitle ?? ref.externalId)),
      extraMetadata: (l) => {
        const number = l.attachment ? directiveNumber(l.attachment.label) : null;
        const revision = l.attachment ? revisionOf(l.attachment.label) : null;
        return {
          ...(l.publicationTitle ? { topic: l.publicationTitle.replace(/^Management Directives\s*-\s*/i, "") } : {}),
          ...(number ? { directiveNumber: number } : {}),
          ...(revision ? { revision } : {}),
        };
      },
    });
  },
};
