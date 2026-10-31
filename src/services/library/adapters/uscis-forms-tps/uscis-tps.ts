import { utcDate } from "@/services/monitoring/parse/dates";
import {
  LibraryLayoutError,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import {
  checkAgainstFederalRegister,
  citedNotices,
  countriesNamedIn,
  isTpsTitle,
  parseFrDocumentsPage,
  parseTpsCountryLists,
  parseTpsCountryPage,
  readUscisPage,
  uscisText,
  type FrNotice,
  type TpsCountryLink,
} from "./parse";
import { USCIS_AGENCY, USCIS_HOST, isUscisUrl, readRunPage, recallPage } from "./run-pages";

// Temporary Protected Status, country by country, as USCIS states it, checked
// against the Federal Register.
//
// - USCIS's TPS page lists the countries "Currently Designated" and
//   "Previously Designated" for TPS, each linking its country page (moved
//   under /archive when USCIS archives it). Each country page opens with a
//   table of the posture USCIS states: designated or extended through,
//   re-registration and initial registration periods, EAD auto-extension,
//   continuous residence and physical presence dates, designation date, and
//   the Federal Register notices it rests on. One document per country, the
//   page's text with that table kept field by field, plus one for the TPS
//   page itself.
// - The check: the Federal Register API lists every document titled for
//   Temporary Protected Status (one request, about 570 documents back to
//   1994); those whose title names the country are kept with the country,
//   and compared with the notices the USCIS pages cite (by document number
//   or "<volume> FR <page>"): whether the newest notice is cited, and which
//   later ones are not. Only titles and the API's own fields are used; the
//   notices themselves are collected with the Federal Register in the
//   regulations group.
// - Daily and backfill read the same thing: the TPS page, the Federal
//   Register list and every country page (about 23 requests to uscis.gov,
//   4 minutes). The country pages are read while listing, so the run fails
//   when most of them lose the key-facts table, and kept for fetchDocument.
//   They are always read in full, not with a conditional GET: the document
//   joins the page with the Federal Register list, which can change while
//   the page does not.
// - An archived country page ("The information on this page is out of
//   date") is kept as it is, marked archived in its metadata, not flagged
//   withdrawn: it is the record of that country's TPS, and the library's
//   searches leave withdrawn documents out.
//
// US government works (USCIS, the Federal Register): public domain.

const TPS_URL = "https://www.uscis.gov/humanitarian/temporary-protected-status";
const FR_API = "https://www.federalregister.gov/api/v1/documents.json";
const FR_HOST = "www.federalregister.gov";
const HOSTS = [USCIS_HOST, FR_HOST] as const;
const FR_FIELDS = ["document_number", "title", "type", "publication_date", "effective_on", "citation", "html_url", "pdf_url", "action", "dates", "agencies"];
const FR_MAX_PAGES = 3;

type OverviewListing = { kind: "overview" };
type CountryListing = {
  kind: "country";
  country: string;
  listing: TpsCountryLink["listing"];
  listedUnder: string;
  /** Alerts on the TPS page that name the country, verbatim. */
  mainPageAlerts: string[];
  /** Federal Register notices cited in those alerts. */
  mainPageCited: ReturnType<typeof citedNotices>;
  /** Federal Register documents titled for TPS that name the country, newest first. */
  frNotices: FrNotice[];
  frSearchedOn: string;
};

/** The Federal Register API's search for "temporary protected status": its documents whose title is about TPS. */
async function federalRegisterNotices(ctx: LibraryAdapterContext): Promise<FrNotice[]> {
  const first = new URL(FR_API);
  first.searchParams.set("per_page", "1000");
  first.searchParams.set("order", "newest");
  first.searchParams.set("conditions[term]", '"temporary protected status"');
  for (const field of FR_FIELDS) first.searchParams.append("fields[]", field);
  const notices: FrNotice[] = [];
  let url: string | null = first.toString();
  for (let page = 0; url && page < FR_MAX_PAGES; page++) {
    const { data } = await ctx.http.getJson(url, { expect: "json" });
    const parsed = parseFrDocumentsPage(data);
    if (!parsed) throw new LibraryLayoutError(FR_API, "the answer is not the Federal Register API's document list");
    notices.push(...parsed.notices);
    const next: string | null = parsed.nextPageUrl;
    url = next && new URL(next).hostname === FR_HOST ? next : null;
    if (page === FR_MAX_PAGES - 1 && url) ctx.note(`The Federal Register search has more than ${FR_MAX_PAGES} pages; the oldest were not read.`);
  }
  const tps = notices.filter((n) => isTpsTitle(n.title));
  if (tps.length === 0) throw new LibraryLayoutError(FR_API, "no document titled for Temporary Protected Status in the search results");
  return tps;
}

async function listAll(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await readRunPage(ctx, TPS_URL);
  const page = readUscisPage(text);
  if (!page.articleHtml) throw new LibraryLayoutError(TPS_URL, "no article");
  const { countries, headingsFound } = parseTpsCountryLists(page.articleHtml, response.url);
  if (!headingsFound.some((h) => /currently designated/i.test(h))) throw new LibraryLayoutError(TPS_URL, 'no "Countries Currently Designated for TPS" list');
  if (countries.length === 0) throw new LibraryLayoutError(TPS_URL, "no country links in the TPS country lists");

  const frNotices = await federalRegisterNotices(ctx);
  await checkCountryPages(
    ctx,
    countries.filter((c, i) => isUscisUrl(c.url) && countries.findIndex((d) => d.url === c.url) === i)
  );
  const names = countries.map((c) => c.country);
  const searchedOn = utcDate(ctx.now);
  const refs: DocumentRef[] = [
    { externalId: "TPS overview", url: response.url, title: page.heading ?? "Temporary Protected Status", listing: { kind: "overview" } satisfies OverviewListing },
  ];
  const seen = new Set<string>();
  for (const link of countries) {
    if (!isUscisUrl(link.url)) {
      ctx.note(`TPS ${link.country}: its link (${link.url}) is not on ${USCIS_HOST}; left out.`);
      continue;
    }
    const externalId = `TPS ${link.country}`;
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    const alerts = page.alerts.filter((a) => countriesNamedIn(a, names).includes(link.country));
    const listing: CountryListing = {
      kind: "country",
      country: link.country,
      listing: link.listing,
      listedUnder: link.listedUnder,
      mainPageAlerts: alerts,
      mainPageCited: alerts.flatMap((a) => citedNotices(a, response.url)),
      frNotices: frNotices.filter((n) => countriesNamedIn(n.title, names).includes(link.country)),
      frSearchedOn: searchedOn,
    };
    // No fingerprint: every country is read every day (see the file comment).
    refs.push({ externalId, url: link.url, title: `TPS: ${link.country}`, listing });
  }
  return refs;
}

async function overviewDocument(ctx: LibraryAdapterContext, ref: DocumentRef): Promise<FetchDocumentResult> {
  const read = recallPage(ctx, ref.url, { forget: true }) ?? (await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null }));
  if (read.response.notModified) return { kind: "not_modified" };
  const page = readUscisPage(read.text);
  if (!page.articleHtml) throw new LibraryLayoutError(ref.url, "no article");
  const { countries } = parseTpsCountryLists(page.articleHtml, read.response.url);
  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType: "web_guidance",
      title: page.heading ?? "Temporary Protected Status",
      citations: [],
      agency: USCIS_AGENCY,
      precedentialStatus: "not_applicable",
      officialUrl: read.response.url,
      text: uscisText(page.articleHtml),
      metadata: {
        kind: "tps_overview",
        currentlyDesignated: countries.filter((c) => c.listing === "current").map((c) => c.country),
        previouslyDesignated: countries.filter((c) => c.listing === "previous").map((c) => c.country),
        alerts: page.alerts,
        lastReviewedUpdated: page.lastReviewed?.text ?? null,
        statedDates: { lastReviewedUpdated: page.lastReviewed?.text ?? null },
      },
      fetch: { response: read.response },
    },
  };
}

/**
 * Reads every country page while listing (kept for fetchDocument in the same
 * run, so no page is asked for twice) and fails the run when most of them
 * have lost the key-facts table: a redesign, not one country's page
 * written differently (Venezuela's, in litigation, has none and states its
 * posture in alerts and a filing table).
 */
async function checkCountryPages(ctx: LibraryAdapterContext, links: TpsCountryLink[]): Promise<void> {
  let read = 0;
  let withFacts = 0;
  for (const link of links) {
    try {
      const { text, response } = await readRunPage(ctx, link.url);
      read++;
      if (parseTpsCountryPage(text, response.url).facts.length > 0) withFacts++;
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.note(`TPS ${link.country}: the page could not be read while listing (${err instanceof Error ? err.message : String(err)}); it is tried again for its document.`);
    }
  }
  if (read >= 4 && withFacts * 2 < read) {
    throw new LibraryLayoutError(TPS_URL, `only ${withFacts} of the ${read} country pages read have the key-facts table (designation dates, registration periods)`);
  }
}

async function countryDocument(ctx: LibraryAdapterContext, ref: DocumentRef, listing: CountryListing): Promise<FetchDocumentResult> {
  const { text, response } = recallPage(ctx, ref.url, { forget: true }) ?? (await ctx.http.getText(ref.url, { expect: "html" }));
  const page = parseTpsCountryPage(text, response.url);
  if (!page.heading || !countriesNamedIn(page.heading, [listing.country]).length) {
    throw new LibraryLayoutError(ref.url, `the page heading ("${page.heading ?? ""}") does not name ${listing.country}`);
  }
  if (page.facts.length === 0) ctx.note(`TPS ${listing.country}: the page has no key-facts table; its posture is only in its text and alerts.`);
  const reviewed = page.lastReviewed?.datetime?.slice(0, 10) ?? null;
  const check = checkAgainstFederalRegister({
    country: listing.country,
    cited: [...page.cited, ...listing.mainPageCited],
    notices: listing.frNotices,
    pageReviewedIso: reviewed && /^\d{4}-\d{2}-\d{2}$/.test(reviewed) ? reviewed : null,
  });
  const summary = page.facts.map((f) => `${f.label}: ${f.value}`).join("\n");
  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType: "designation",
      title: page.heading,
      citations: [],
      agency: USCIS_AGENCY,
      precedentialStatus: "not_applicable",
      officialUrl: response.url,
      text: page.text,
      metadata: {
        kind: "tps_country",
        country: listing.country,
        uscisListing: listing.listing === "current" ? "currently designated" : "previously designated",
        listedUnder: listing.listedUnder,
        ...(summary ? { summary, summaryKind: "the page's key-facts table" } : {}),
        keyFactsTable: page.facts.length > 0,
        facts: page.facts,
        posture: page.posture,
        ...(page.archivedNotice ? { archived: true, archivedNotice: page.archivedNotice } : { archived: false }),
        alerts: page.alerts,
        mainPageAlerts: listing.mainPageAlerts,
        federalRegisterCited: page.cited,
        federalRegisterNotices: listing.frNotices,
        federalRegisterCheck: { ...check, searchedOn: listing.frSearchedOn, source: FR_API },
        lastReviewedUpdated: page.lastReviewed?.text ?? null,
        statedDates: { lastReviewedUpdated: page.lastReviewed?.text ?? null },
        tpsPage: TPS_URL,
      },
      fetch: { response },
    },
  };
}

export const uscisTpsAdapter: LibrarySourceAdapter = {
  code: "uscis_tps",
  group: "tps",
  name: "Temporary Protected Status by country (USCIS, checked against the Federal Register)",
  description:
    "Each country USCIS lists as currently or previously designated for TPS: its USCIS page with the posture USCIS states (designation and extension dates, registration periods, EAD auto-extension, residence and presence dates), and the Federal Register notices titled for that country's TPS, compared with the ones USCIS cites.",
  coverage:
    "Every country linked from USCIS's TPS page (5 current and 15 previous designations when this collector was written) and the TPS page itself; countries USCIS no longer links (Angola, Burundi, Kosovo, Montserrat and others from the 1990s and 2000s) are not covered.",
  cadence: "Daily",
  officialUrl: TPS_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,

  async listUpdates(ctx) {
    return { refs: await listAll(ctx) };
  },

  async backfill(ctx) {
    // The TPS page links every country page it keeps: one chunk is the whole history it offers.
    return { refs: await listAll(ctx), nextCursor: null, progress: "every country the TPS page links" };
  },

  async fetchDocument(ctx, ref) {
    const listing = ref.listing as OverviewListing | CountryListing | undefined;
    if (listing?.kind === "overview") return overviewDocument(ctx, ref);
    if (listing?.kind === "country") return countryDocument(ctx, ref, listing);
    return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
  },

  legalUpdateItem(document) {
    if (document.metadata?.kind !== "tps_country") return null;
    const check = document.metadata.federalRegisterCheck as { newestNoticeCitedByUscisPage?: FrNotice | null } | undefined;
    const cited = check?.newestNoticeCitedByUscisPage?.documentNumber ?? null;
    const summary = typeof document.metadata.summary === "string" ? document.metadata.summary : "";
    const alerts = Array.isArray(document.metadata.mainPageAlerts) ? (document.metadata.mainPageAlerts as string[]) : [];
    return {
      itemType: "TPS designation",
      // The same event as the Federal Register notice the page rests on, as the monitor keys it.
      crossSourceKey: cited ? `fr:${cited}` : null,
      excerpt: [document.title, summary, ...alerts].filter(Boolean).join("\n\n"),
      publishedDateText: typeof document.metadata.lastReviewedUpdated === "string" ? `Last Reviewed/Updated: ${document.metadata.lastReviewedUpdated}` : null,
      listedOnUrl: TPS_URL,
    };
  },
};
