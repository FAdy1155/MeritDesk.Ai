import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText, inlineText } from "../../extract/html";
import { repairMojibake, sha256Hex } from "../../text";
import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { dolContent, pageHeading, parseSummariesToc } from "./parse";

// The BALCA En Banc Decision Summaries: the Office of Administrative Law
// Judges' digest of the Board of Alien Labor Certification Appeals' en banc
// decisions under the pre-PERM regulations, one page per topic (ability to
// pay, actual minimum requirements, rebuttal, ...), each summary naming the
// decision it comes from and linking it. Published on www.dol.gov, where
// (unlike the decision files on www.oalj.dol.gov) automated reading is
// allowed. The pages were last updated in 2004 and say so in their titles.
//
// Each page opens with OALJ's notice that the summaries were written for
// BALCA staff, are not part of the opinions and are not to be cited; the
// notice is kept in the text and in metadata.
//
// US government work: public domain, stored in full.

const TOC_URL = "https://www.dol.gov/agencies/oalj/PUBLIC/INA/REFERENCES/REFERENCE_WORKS/BALCA_EN_BANC_SUMMARIES_TABLE_OF_CONTENTS";
const HOSTS = ["www.dol.gov"] as const;

type Listing = { topic: string };

async function readToc(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await ctx.http.getText(TOC_URL, { expect: "html" });
  const topics = parseSummariesToc(text, response.url);
  if (topics.length === 0) throw new LibraryLayoutError(TOC_URL, "no topic headings linking summary pages");
  return topics.map((t) => ({
    externalId: new URL(t.url).pathname,
    url: t.url,
    title: t.title,
    fingerprint: sha256Hex(`${t.title}\u0000${t.url}`).slice(0, 32),
    listing: { topic: t.title } satisfies Listing,
  }));
}

export const balcaEnBancSummariesAdapter: LibrarySourceAdapter = {
  code: "dol_balca_en_banc_summaries",
  group: "ocaho-balca",
  name: "BALCA En Banc Decision Summaries (OALJ digest)",
  description:
    "The Office of Administrative Law Judges' topical digest of BALCA's pre-PERM en banc decisions, one document per topic, each summary naming and linking its decision.",
  coverage: "Every topic page the digest's table of contents links (17 when this collector was written, last updated by OALJ in 2004).",
  cadence: "Checked daily; the digest has not changed since 2004",
  officialUrl: TOC_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 30,

  async listUpdates(ctx) {
    return { refs: await readToc(ctx) };
  },

  async backfill(ctx): Promise<BackfillChunk> {
    const refs = await readToc(ctx);
    return { refs, nextCursor: null, progress: `the whole digest: ${refs.length} topic pages` };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    const { text, response } = await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const content = dolContent(text);
    const body = content ? repairMojibake(htmlToDocumentText(content)) : "";
    if (!body) throw new LibraryLayoutError(ref.url, "no content field");
    const heading = pageHeading(text) ?? listing?.topic ?? null;
    if (!heading) throw new LibraryLayoutError(ref.url, "no page heading");
    const updated = /last updated\s+([^)]+)\)/i.exec(heading)?.[1]?.trim() ?? null;
    const notice = /NOTICE\s*:?\s*([\s\S]*?)(?:\n\n|$)/.exec(body)?.[0] ?? null;
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "other",
        title: heading,
        citations: [],
        agency: "U.S. Department of Labor",
        editionDate: parseStatedDate(updated),
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        text: body,
        metadata: {
          work: "BALCA En Banc Decision Summaries",
          topic: listing?.topic ?? null,
          tableOfContents: TOC_URL,
          ...(notice ? { notice: inlineText(notice) } : {}),
          statedDates: updated ? { lastUpdated: updated } : {},
        },
        fetch: { response },
      },
    };
  },
};
