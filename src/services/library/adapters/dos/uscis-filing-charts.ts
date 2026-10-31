import { htmlToDocumentText } from "../../extract/html";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import { chunkOf } from "./chunk";
import { decodeHtml } from "./parse";
import { chartRows, parseChartsIndex, parseChartsMonth, statedDate, type ChartsMonthLink } from "./parse-bulletin";

// The chart USCIS designated each month for filing adjustment of status
// applications in the family-sponsored and employment-based preference
// categories ("Dates for Filing" or "Final Action Dates" from that month's
// Visa Bulletin), from USCIS's "Adjustment of Status Filing Charts from the
// Visa Bulletin" page and the monthly page it links for each month since
// October 2015. Each monthly page prints the designated chart itself, read
// into rows like the bulletin's (metadata.priorityDates), and which chart
// applies to each category (metadata.designatedCharts), from the table
// captions or headings.
//
// - Daily: this month's and next month's entries and the three newest
//   previous months; the current month's entry fingerprint includes the
//   index page's own statement of which chart applies, so a change there is
//   fetched again.
// - Backfill: every month the page links, newest first.
// - www.uscis.gov's robots.txt asks for 10 seconds between requests:
//   PAGE_SIZE months take about 10 minutes.
// - A month linked to a host that is not public (the page once linked
//   January 2026 to USCIS's editing host) is left out and noted.
//
// US government work: public domain, stored in full.

const INDEX_URL =
  "https://www.uscis.gov/green-card/green-card-processes-and-procedures/visa-availability-priority-dates/adjustment-of-status-filing-charts-from-the-visa-bulletin";
const HOSTS = ["www.uscis.gov"] as const;
const AGENCY = "U.S. Citizenship and Immigration Services";
const PAGE_SIZE = 50;
const DAILY_PREVIOUS = 3;

type Listing = { month: string; label: string; section: ChartsMonthLink["section"]; indexStatements: string[]; indexUrl: string };

async function readIndex(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await ctx.http.getText(INDEX_URL, { expect: "html" });
  const parsed = parseChartsIndex(text, response.url);
  if (!parsed.recognized) throw new LibraryLayoutError(INDEX_URL, "no current or previous months' chart links");
  const refs: DocumentRef[] = [];
  for (const m of parsed.months) {
    const host = new URL(m.url).hostname;
    if (!HOSTS.includes(host as (typeof HOSTS)[number]) || !m.url.startsWith("https:")) {
      ctx.note(`${m.label}: the page links it to ${host}, which is not a public USCIS host this collector reads; it was left out.`);
      continue;
    }
    const indexStatements = m.section === "current" ? parsed.currentStatements : [];
    const listing: Listing = { month: m.month, label: m.label, section: m.section, indexStatements, indexUrl: response.url };
    refs.push({
      externalId: m.month,
      url: m.url,
      title: `USCIS ${m.label} Adjustment of Status Filing Charts`,
      fingerprint: sha256Hex([m.url, m.label, ...indexStatements].join("\u0000")).slice(0, 32),
      listing,
    });
  }
  // Newest first: the page lists previous months oldest first within each year.
  return refs.sort((a, b) => b.externalId.localeCompare(a.externalId));
}

export const uscisFilingChartsAdapter: LibrarySourceAdapter = {
  code: "uscis_aos_filing_charts",
  group: "visa-bulletin",
  name: "Adjustment of status filing charts from the Visa Bulletin (USCIS)",
  description:
    "The Visa Bulletin chart USCIS designated each month for filing family-sponsored and employment-based adjustment of status applications, with the designated chart's priority dates kept as rows.",
  coverage: "Every month the USCIS filing-charts page links, October 2015 to the current month (about 130), except a month it links to a non-public host.",
  cadence: "Monthly, when USCIS posts the month's designation (checked daily)",
  officialUrl: INDEX_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 72,
  recheckAfterDays: 60,

  async listUpdates(ctx) {
    const refs = await readIndex(ctx);
    const recent = refs.filter((r) => (r.listing as Listing).section === "previous").slice(0, DAILY_PREVIOUS);
    return { refs: refs.filter((r) => (r.listing as Listing).section !== "previous" || recent.includes(r)) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    // readIndex orders the months newest first.
    return chunkOf(await readIndex(ctx), cursor, PAGE_SIZE, "months");
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.month) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const response = await ctx.http.get(ref.url, { expect: "html", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const html = decodeHtml(response.body, response.charset);
    const page = parseChartsMonth(html);
    if (!page) throw new LibraryLayoutError(response.url, "no page body (field--name-body)");
    if (page.month && page.month.key !== listing.month) {
      return { kind: "skip", reason: `${ref.externalId}: the index links ${listing.label} to a page for ${page.month.label}; left out until the link is corrected.` };
    }
    const rows = chartRows(page.charts);
    if (!rows.length) ctx.note(`${ref.externalId}: no chart was recognized on the page; its text was stored without chart rows.`);
    const text = htmlToDocumentText(page.bodyHtml);
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "bulletin",
        title: page.title ?? ref.title ?? listing.label,
        citations: [],
        agency: AGENCY,
        documentYear: Number(listing.month.slice(0, 4)),
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        text,
        textKind: text ? "full" : "none",
        metadata: {
          chartMonth: listing.month,
          chartMonthLabel: listing.label,
          designatedCharts: { familySponsored: page.designations.family, employmentBased: page.designations.employment },
          ...(listing.indexStatements.length ? { indexStatements: listing.indexStatements } : {}),
          charts: page.charts.map((c) => ({ chart: c.chart, category: c.category, label: c.label, chargeabilityAreas: c.columns, rows: c.rows.length })),
          priorityDates: rows,
          statedDates: page.reviewedText ? { lastReviewedUpdated: page.reviewedText } : {},
          ...(statedDate(page.reviewedText) ? { pageLastReviewed: statedDate(page.reviewedText) } : {}),
          indexPage: listing.indexUrl,
        },
        fetch: { response },
      },
    };
  },

  legalUpdateItem(document) {
    const statements = document.metadata?.indexStatements;
    const charts = document.metadata?.charts as { label?: string | null }[] | undefined;
    const lines = [
      document.title,
      ...(Array.isArray(statements) ? statements.filter((s): s is string => typeof s === "string") : []),
      ...(charts ?? []).map((c) => c.label).filter((l): l is string => Boolean(l)),
    ];
    return {
      itemType: "Visa Bulletin",
      excerpt: `${lines.join("\n")}\n\n${document.text}`,
      publishedDateText: (document.metadata?.statedDates as { lastReviewedUpdated?: string } | undefined)?.lastReviewedUpdated ?? null,
      listedOnUrl: INDEX_URL,
    };
  },
};
