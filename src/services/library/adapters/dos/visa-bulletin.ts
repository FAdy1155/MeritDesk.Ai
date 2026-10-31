import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText } from "../../extract/html";
import { sameAddress, sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import { chunkOf } from "./chunk";
import { BULLETIN_PATH, chartRows, parseBulletin, parseBulletinIndex, type BulletinLink } from "./parse-bulletin";
import { decodeHtml, statedMonth } from "./parse";
import { CONSULAR_AFFAIRS, TRAVEL_HOSTS } from "./travel";

// The Visa Bulletin, as the State Department publishes it on
// travel.state.gov: every monthly bulletin the Visa Bulletin page links
// (the current and upcoming bulletins and the fiscal-year archive, December
// 2001 on), one document per bulletin page, with its priority-date charts
// read into rows (metadata.priorityDates: chart, family or employment,
// preference, chargeability area, the cell as stated, and its date) and the
// diversity visa rank cut-offs (metadata.diversityCutoffs).
//
// - Charts: "Final Action Dates" and "Dates for Filing" from the October
//   2015 bulletin on; one chart per category before that ("cut_off_dates").
//   A cell's two-digit year is read in the bulletin's own century. A
//   bulletin page with no chart recognized is stored with its text and
//   noted on the run (some archive entries are notices, such as the 2007
//   "Update on July Visa Availability").
// - Daily: the current and upcoming bulletins and those of the two newest
//   fiscal years on the page; unchanged pages are skipped by fingerprint.
// - Backfill: every bulletin the page links, newest first, PAGE_SIZE per
//   chunk.
// - The chart USCIS designates for adjustment of status each month is a
//   separate source (./uscis-filing-charts.ts).
// - travel.state.gov's bot protection: see ./travel.ts. The source is kept
//   up to date by import from the official site (../../manual-import.ts):
//   a bulletin's page saved as HTML gives the same document and chart rows
//   as the daily run. With the Visa Bulletin page itself as the linked file,
//   the ref is the one the daily run builds from it (its title and whether
//   the page lists the bulletin as current, upcoming or in the archive);
//   without it those listing facts are left out.
//
// US government work: public domain, stored in full.

const INDEX_URL = "https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html";
/** A bulletin's page, as the Visa Bulletin page links them (BULLETIN_PATH, anchored). */
const BULLETIN_PATH_IMPORT = /^\/content\/travel\/en\/legal\/visa-law0\/visa-bulletin\/\d{4}\/[\w.-]+\.html$/i;
const PAGE_SIZE = 60;
const DAILY_FISCAL_YEARS = 2;

/** What a ref carries from the Visa Bulletin page; listedAs is null for a bulletin imported without that page. */
type Listing = { title: string; folder: string; slug: string; listedAs: BulletinLink["listedAs"] | null; indexUrl: string };

async function readIndex(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await ctx.http.getText(INDEX_URL, { expect: "html" });
  const parsed = parseBulletinIndex(text, response.url);
  if (!parsed.recognized) throw new LibraryLayoutError(INDEX_URL, "no bulletin links in the Visa Bulletin page's main copy");
  return parsed.links.map((link) => {
    const listing: Listing = { title: link.title, folder: link.folder, slug: link.slug, listedAs: link.listedAs, indexUrl: response.url };
    return {
      externalId: `${link.folder}/${link.slug}`,
      url: link.url,
      title: link.title,
      fingerprint: sha256Hex([link.url, link.title].join("\u0000")).slice(0, 32),
      listing,
    };
  });
}

/** Where the bulletin's charts begin in its text, for the legal-update excerpt (the opening is the same boilerplate every month). */
function chartsOnward(text: string): string | null {
  const at = text.search(/FAMILY-SPONSORED PREFERENCES|[A-Z]\.\s+(?:APPLICATION\s+)?FINAL ACTION DATES|Priority Dates for Family/);
  return at > 0 ? text.slice(at) : null;
}

export const dosVisaBulletinAdapter: LibrarySourceAdapter = {
  code: "dos_visa_bulletin",
  group: "visa-bulletin",
  name: "Visa Bulletin (State Department)",
  description:
    "The State Department's monthly Visa Bulletin: final action dates and dates for filing for every family-sponsored and employment-based preference category and chargeability area, and the diversity visa rank cut-offs, with the charts kept as structured rows.",
  coverage:
    "Every bulletin the travel.state.gov Visa Bulletin page links, from the December 2001 bulletin to the current and upcoming ones (about 300).",
  cadence: "Monthly, when the Department of State posts it (checked daily)",
  officialUrl: INDEX_URL,
  hosts: TRAVEL_HOSTS,
  license: "public_domain",
  staleAfterHours: 72,
  recheckAfterDays: 30,

  async listUpdates(ctx) {
    const refs = await readIndex(ctx);
    const folders = [...new Set(refs.map((r) => (r.listing as Listing).folder))].sort((a, b) => b.localeCompare(a)).slice(0, DAILY_FISCAL_YEARS);
    return { refs: refs.filter((r) => (r.listing as Listing).listedAs !== "archive" || folders.includes((r.listing as Listing).folder)) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    // The page lists the bulletins newest first.
    return chunkOf(await readIndex(ctx), cursor, PAGE_SIZE, "bulletins");
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    const response = await ctx.http.get(ref.url, { expect: "html", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const html = decodeHtml(response.body, response.charset);
    const bulletin = parseBulletin(html, response.url);
    if (!bulletin) throw new LibraryLayoutError(response.url, "no main copy (tsg-rwd-main-copy-body-frame)");
    const text = htmlToDocumentText(bulletin.bodyHtml);
    const rows = chartRows(bulletin.charts);
    if (!rows.length) ctx.note(`${ref.externalId}: no priority-date chart was recognized; its text was stored without chart rows.`);
    const title = bulletin.title ?? (listing?.title || ref.externalId);
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "bulletin",
        title,
        citations: [title],
        agency: CONSULAR_AFFAIRS,
        publishedDate: parseStatedDate(bulletin.issuedText),
        documentYear: bulletin.month?.year ?? null,
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        text,
        textKind: text ? "full" : "none",
        metadata: {
          ...(bulletin.month ? { bulletinMonth: bulletin.month.key, bulletinMonthLabel: bulletin.month.label } : {}),
          ...(bulletin.number ? { number: bulletin.number } : {}),
          ...(bulletin.volume ? { volume: bulletin.volume } : {}),
          ...(bulletin.publication ? { publication: `Department of State Publication ${bulletin.publication}` } : {}),
          fiscalYearFolder: listing?.folder ?? null,
          listedAs: listing?.listedAs ?? null,
          ...(bulletin.pdfUrl ? { printerFriendlyPdf: bulletin.pdfUrl } : {}),
          statedDates: {
            ...(bulletin.issuedText ? { issued: `CA/VO: ${bulletin.issuedText}` } : {}),
            ...(bulletin.revisedText ? { revised: bulletin.revisedText } : {}),
          },
          charts: bulletin.charts.map((c) => ({ chart: c.chart, category: c.category, label: c.label, chargeabilityAreas: c.columns, rows: c.rows.length })),
          priorityDates: rows,
          ...(bulletin.diversity.length ? { diversityCutoffs: bulletin.diversity } : {}),
          indexPage: listing?.indexUrl ?? INDEX_URL,
        },
        fetch: { response },
      },
    };
  },

  manualImportPaths: [
    {
      path: BULLETIN_PATH_IMPORT,
      file: "html",
      role: "document",
      label: "A monthly bulletin's page (https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin/<fiscal year>/visa-bulletin-for-<month>-<year>.html), saved as HTML",
    },
    {
      path: /^\/content\/travel\/en\/legal\/visa-law0\/visa-bulletin\.html$/,
      file: "html",
      role: "linked",
      label: "Optional: the Visa Bulletin page itself (the bulletin's listed title and whether it is the current or upcoming one)",
    },
  ],
  manualImportIntervalDays: 35,
  async parseImported(ctx, input) {
    let ref: DocumentRef | undefined;
    if (input.linked) {
      if (!sameAddress(input.linked.url, INDEX_URL)) return { kind: "skip", reason: `The linked page must be the Visa Bulletin page, ${INDEX_URL}.` };
      ref = (await readIndex(ctx)).find((r) => sameAddress(r.url, input.url));
      if (!ref) return { kind: "skip", reason: `The Visa Bulletin page given does not link ${input.url}, so the collector would not collect it.` };
    } else {
      const path = BULLETIN_PATH.exec(new URL(input.url).pathname);
      if (!path) return { kind: "skip", reason: `${input.url} is not a bulletin's page.` };
      const listing: Listing = { title: "", folder: path[1], slug: path[2], listedAs: null, indexUrl: INDEX_URL };
      ref = { externalId: `${listing.folder}/${listing.slug}`, url: input.url, listing };
    }
    const result = await dosVisaBulletinAdapter.fetchDocument(ctx, { ...ref, url: input.url });
    // The page has no canonical link to check its address against; the month its address names must be its own.
    const named = statedMonth((BULLETIN_PATH.exec(new URL(input.url).pathname)?.[2] ?? "").replace(/-/g, " "));
    const own = result.kind === "document" ? result.document.metadata?.bulletinMonthLabel : null;
    if (named && typeof own === "string" && named.label !== own) {
      return { kind: "skip", reason: `The file is the bulletin for ${own}, but the address names ${named.label}. Give the address the bulletin was saved from.` };
    }
    return result;
  },

  legalUpdateItem(document) {
    const stated = document.metadata?.statedDates as { issued?: string } | undefined;
    return {
      itemType: "Visa Bulletin",
      excerpt: chartsOnward(document.text) ? `${document.title}\n${chartsOnward(document.text)}` : null,
      publishedDateText: stated?.issued ?? null,
      listedOnUrl: INDEX_URL,
    };
  },
};
