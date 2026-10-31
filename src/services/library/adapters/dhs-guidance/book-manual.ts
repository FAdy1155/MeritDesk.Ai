import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { LibraryLayoutError, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibraryHttpResponse, type LibrarySourceAdapter } from "../../types";
import { fingerprintOf } from "./files";
import { bookSectionText, parseBookExport, parseBookLanding, type BookSection } from "./parse";

// Manuals that USCIS and E-Verify publish as Drupal "books": a landing page,
// one page per section, and a "Print Manual" link to an export of the whole
// book on one page (/book/export/html/<id>). The export is read once per run
// (the landing page names it, so a renumbered book is followed) and each
// section becomes one document cited by its own page, with its heading
// trail and its "Last Reviewed/Updated" date as the site prints them.
// Fingerprints over each section's content mean only changed sections are
// stored again. Both hosts ask for 10 seconds between requests, so one
// export (two requests) instead of a request per section keeps a run short.

type Config = {
  code: string;
  name: string;
  description: string;
  coverage: string;
  /** The manual's landing page (official URL). */
  landingUrl: string;
  hosts: readonly string[];
  agency: string;
  /** The manual's form-style designation ("M-274"), for citations and metadata. */
  designation: string;
  manualTitle: string;
};

type Listing = {
  heading: string;
  depth: number;
  path: string[];
  reviewed: string | null;
  exportUrl: string;
  currentAs: string | null;
  order: number;
};

type ExportRead = { sections: BookSection[]; response: LibraryHttpResponse; exportUrl: string; currentAs: string | null };

/** One export read per run: listing and the documents it lists share it (keyed by the run's context). */
const exportsByRun = new WeakMap<LibraryAdapterContext, Map<string, Promise<ExportRead>>>();

async function readBook(ctx: LibraryAdapterContext, config: Config): Promise<ExportRead> {
  const landing = await ctx.http.getText(config.landingUrl, { expect: "html" });
  const { exportUrl, currentAs } = parseBookLanding(landing.text, landing.response.url, config.hosts);
  if (!exportUrl) throw new LibraryLayoutError(config.landingUrl, "no Print Manual (book export) link");
  const { text, response } = await ctx.http.getText(exportUrl, { expect: "html" });
  const sections = parseBookExport(text, response.url, config.hosts);
  if (sections.length < 2) throw new LibraryLayoutError(exportUrl, "fewer than two book sections with headings and page links");
  return { sections, response, exportUrl, currentAs };
}

function bookFor(ctx: LibraryAdapterContext, config: Config): Promise<ExportRead> {
  let byUrl = exportsByRun.get(ctx);
  if (!byUrl) {
    byUrl = new Map();
    exportsByRun.set(ctx, byUrl);
  }
  let pending = byUrl.get(config.landingUrl);
  if (!pending) {
    pending = readBook(ctx, config);
    // A failed read is not kept: a retry in the same run reads again.
    pending.catch(() => byUrl!.delete(config.landingUrl));
    byUrl.set(config.landingUrl, pending);
  }
  return pending;
}

function refsOf(book: ExportRead): DocumentRef[] {
  const seen = new Set<string>();
  const refs: DocumentRef[] = [];
  book.sections.forEach((section, order) => {
    const externalId = new URL(section.url).pathname;
    if (seen.has(externalId)) return;
    seen.add(externalId);
    const listing: Listing = {
      heading: section.heading,
      depth: section.depth,
      path: section.path,
      reviewed: section.reviewed,
      exportUrl: book.exportUrl,
      currentAs: book.currentAs,
      order,
    };
    refs.push({
      externalId,
      url: section.url,
      title: section.heading,
      fingerprint: fingerprintOf(section.heading, section.path.join(" > "), section.reviewed, section.contentHtml),
      listing,
    });
  });
  return refs;
}

export function bookManualAdapter(config: Config): LibrarySourceAdapter {
  return {
    code: config.code,
    group: "other-agency-guidance",
    name: config.name,
    description: config.description,
    coverage: config.coverage,
    cadence: "Daily",
    officialUrl: config.landingUrl,
    hosts: config.hosts,
    license: "public_domain",
    staleAfterHours: 48,
    recheckAfterDays: 30,

    async listUpdates(ctx) {
      return { refs: refsOf(await bookFor(ctx, config)) };
    },

    async backfill(ctx) {
      // The export holds the whole manual: one chunk is the whole history (the current edition; the sites keep no older ones).
      const refs = refsOf(await bookFor(ctx, config));
      return { refs, nextCursor: null, progress: `${refs.length} sections of the current edition` };
    },

    async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
      const listing = ref.listing as Listing | undefined;
      if (!listing?.heading) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
      const book = await bookFor(ctx, config);
      const section = book.sections.find((s) => new URL(s.url).pathname === ref.externalId);
      if (!section) return { kind: "skip", reason: `${ref.externalId} is no longer in ${config.manualTitle}'s printable export.` };
      const text = bookSectionText(section);
      const reviewedOn = parseStatedDate(section.reviewed);
      return {
        kind: "document",
        document: {
          externalId: ref.externalId,
          docType: "manual_section",
          title: section.depth <= 1 ? section.heading : `${config.manualTitle}, ${section.heading}`,
          citations: [],
          agency: config.agency,
          precedentialStatus: "not_applicable",
          officialUrl: section.url,
          originalUrl: book.response.url,
          text,
          textKind: text ? "full" : "none",
          metadata: {
            manual: config.manualTitle,
            designation: config.designation,
            ...(book.currentAs ? { edition: book.currentAs } : {}),
            sectionHeading: section.heading,
            headingPath: section.path,
            depth: section.depth,
            order: listing.order,
            printableExport: book.exportUrl,
            ...(reviewedOn ? { lastReviewedOn: reviewedOn } : {}),
            statedDates: section.reviewed ? { lastReviewedUpdated: section.reviewed } : {},
          },
          fetch: { response: book.response, extraction: { method: "book export", section: section.heading } },
        },
      };
    },
  };
}
