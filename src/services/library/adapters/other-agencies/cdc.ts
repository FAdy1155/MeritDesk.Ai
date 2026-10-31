import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { mainContent } from "../../extract/html";
import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { cachedPage, fetchFileText, fileFields, fileMetadata, fingerprintOf } from "./common";
import { cdcDates, firstH1, parseCdcTiPages, pathId } from "./parse";

// CDC's Technical Instructions for the immigration medical examination
// (42 CFR part 34; the examination on Form I-693 and the overseas visa
// medical examination), on cdc.gov: the instructions for civil surgeons in
// the United States and for panel physicians abroad, one document per
// page (each index page, and each disease or topic page its navigation
// links: medical history and physical examination, tuberculosis,
// vaccinations, mental health, syphilis, gonorrhea, Hansen's disease, other
// conditions, and the panel physicians' polio addendum). The pages' own
// dates (cdc:first_published, cdc:last_updated, cdc:last_reviewed meta
// tags) are kept.
//
// cdc.gov's robots.txt sets no Crawl-delay and does not disallow these
// pages. US government work: public domain, stored in full.

const HOSTS = ["www.cdc.gov"] as const;
const INDEXES = [
  { url: "https://www.cdc.gov/immigrant-refugee-health/hcp/civil-surgeons/index.html", audience: "Civil surgeons" },
  { url: "https://www.cdc.gov/immigrant-refugee-health/hcp/panel-physicians/index.html", audience: "Panel physicians" },
] as const;

type Listing = { label: string; audience: string };

async function readAll(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const refs = new Map<string, DocumentRef>();
  for (const index of INDEXES) {
    const { text, response } = await cachedPage(ctx, index.url);
    const pages = parseCdcTiPages(text, response.url);
    if (pages.length < 3) throw new LibraryLayoutError(index.url, "the Technical Instructions navigation lists too few pages");
    const all = [{ url: response.url, label: firstH1(text) ?? index.audience }, ...pages];
    for (const p of all) {
      const id = pathId(p.url);
      if (refs.has(id)) continue;
      refs.set(id, { externalId: id, url: p.url, title: p.label, fingerprint: fingerprintOf(p.label, p.url), listing: { label: p.label, audience: index.audience } satisfies Listing });
    }
  }
  return [...refs.values()];
}

export const cdcTechnicalInstructionsAdapter: LibrarySourceAdapter = {
  code: "cdc_technical_instructions",
  group: "other-agency-guidance",
  name: "CDC Technical Instructions for the immigration medical examination",
  description:
    "CDC's Technical Instructions for civil surgeons (the Form I-693 examination in the United States) and for panel physicians (the overseas visa medical examination): tuberculosis, vaccinations, mental health, communicable diseases and the physical examination.",
  coverage: "Every Technical Instructions page linked from CDC's civil surgeon and panel physician index pages, with the index pages.",
  cadence: "Daily",
  officialUrl: "https://www.cdc.gov/immigrant-refugee-health/hcp/civil-surgeons/index.html",
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 7,

  async listUpdates(ctx) {
    return { refs: await readAll(ctx) };
  },
  async backfill(ctx): Promise<BackfillChunk> {
    const refs = await readAll(ctx);
    return { refs, nextCursor: null, progress: `${refs.length} pages` };
  },
  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    let dates: ReturnType<typeof cdcDates> = { firstPublished: null, lastUpdated: null, lastReviewed: null };
    let title: string | null = null;
    let subtitle: string | null = null;
    const file = await fetchFileText(ctx, ref.url, ref.known, {
      htmlContent: (html) => {
        dates = cdcDates(html);
        title = firstH1(html);
        subtitle = /<div class="page-subtitle">([\s\S]*?)<\/div>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, "").trim() || null;
        // The page body starts after the title bar; <main> also holds the title, which the text keeps.
        return mainContent(html);
      },
    });
    if (file === "not_modified") return { kind: "not_modified" };
    const t = (title as string | null) ?? listing?.label ?? ref.externalId;
    const sub = subtitle as string | null;
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "manual_section",
        title: sub && !t.includes(sub) ? `${t}: ${sub}` : t,
        citations: [],
        agency: "Centers for Disease Control and Prevention",
        publishedDate: parseStatedDate(dates.firstPublished),
        precedentialStatus: "not_applicable",
        ...fileFields(file),
        metadata: {
          audience: listing?.audience ?? null,
          ...(parseStatedDate(dates.lastUpdated) ? { updatedDate: parseStatedDate(dates.lastUpdated) } : {}),
          ...(parseStatedDate(dates.lastReviewed) ? { reviewedDate: parseStatedDate(dates.lastReviewed) } : {}),
          statedDates: {
            ...(dates.firstPublished ? { firstPublished: dates.firstPublished } : {}),
            ...(dates.lastUpdated ? { lastUpdated: dates.lastUpdated } : {}),
            ...(dates.lastReviewed ? { lastReviewed: dates.lastReviewed } : {}),
          },
          ...fileMetadata(file),
        },
      },
    };
  },
};
