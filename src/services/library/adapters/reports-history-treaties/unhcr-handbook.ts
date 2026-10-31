import { LibraryLayoutError, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { fingerprintOf, isoDatePart } from "./common";
import { findLinkByText, parseUnhcrMediaPage } from "./parse";

// UNHCR's Handbook on Procedures and Criteria for Determining Refugee Status
// under the 1951 Convention and the 1967 Protocol, as UNHCR lists it on its
// "Handbooks and toolkits" page (www.unhcr.org). The listing link leads
// (through one redirect) to the Handbook's publication page, which states
// the title, the document symbol, a date, a caption and the PDF.
//
// License: link_only, and metadata only. UNHCR's terms of use
// (https://www.unhcr.org/contact-us/terms-and-conditions-use) allow extracts
// "for research or private study but not for sale or for use in conjunction
// with commercial purposes", and require UNHCR's prior permission for any
// other use, "including reproduction, scraping by artificial intelligence
// (AI)". A firm's research service is commercial, so this collector reads
// only the two public pages that say what the Handbook is and where it is,
// never the PDF, and keeps the page's own one-line caption as the excerpt.
// Storing the Handbook's text would need UNHCR's written permission.
//
// UNHCR's Guidelines on International Protection are published on
// refworld.org, which answers automated clients with a Cloudflare challenge
// (HTTP 403), and www.unhcr.org's listings do not link them; they are not
// collected (see the hand-off notes).
//
// www.unhcr.org refuses the collector on some days, so the source is kept up
// to date by import from the official site (../../manual-import.ts): the
// Handbook's publication page saved as HTML, with the "Handbooks and
// toolkits" page as the optional linked file (the words it links the
// Handbook with). The page must be the Handbook's: the import checks its
// title as the listing checks the link. Only the record and the caption are
// kept, as for the daily run.

const LIST_URL = "https://www.unhcr.org/what-we-do/data-and-publications/handbooks-and-toolkits";
const HOSTS = ["www.unhcr.org"] as const;
const HANDBOOK_LINK = /Determining Refugee Status/i;

type Listing = { linkText: string; listedOn: string };

async function listHandbook(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await ctx.http.getText(LIST_URL, { expect: "html" });
  const link = findLinkByText(text, response.url, HANDBOOK_LINK);
  if (!link) throw new LibraryLayoutError(LIST_URL, "no link to the refugee status determination Handbook");
  const listing: Listing = { linkText: link.text, listedOn: response.url };
  return [
    {
      externalId: "unhcr-rsd-handbook",
      url: link.url,
      title: link.text,
      fingerprint: fingerprintOf(link.text, link.url),
      listing,
    },
  ];
}

export const unhcrHandbookAdapter: LibrarySourceAdapter = {
  code: "unhcr_rsd_handbook",
  group: "treaties",
  name: "UNHCR Handbook on Procedures and Criteria for Determining Refugee Status",
  description:
    "UNHCR's Handbook on refugee status determination under the 1951 Convention and the 1967 Protocol: its publication record and official link on unhcr.org.",
  coverage:
    "The Handbook's publication page on unhcr.org (title, symbol, date, caption and PDF link); its text is not stored, and the Guidelines on International Protection (on refworld.org) are not collected.",
  cadence: "Daily",
  officialUrl: LIST_URL,
  hosts: HOSTS,
  license: "link_only",
  licenseNote:
    "UNHCR's terms of use allow extracts only for research or private study, not commercial use, and require prior permission for reproduction or AI scraping; the library keeps the publication record and link.",
  staleAfterHours: 24 * 8,
  recheckAfterDays: 7,

  async listUpdates(ctx) {
    return { refs: await listHandbook(ctx) };
  },

  async backfill(ctx) {
    return { refs: await listHandbook(ctx), nextCursor: null, progress: "the Handbook's listing" };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    const { text: html, response } = await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const page = parseUnhcrMediaPage(html, response.url);
    if (!page) throw new LibraryLayoutError(ref.url, "no publication title (h1.pdf-title)");
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "manual_section",
        title: page.title,
        citations: page.symbol ? [page.symbol] : [],
        agency: "Office of the United Nations High Commissioner for Refugees (UNHCR)",
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        // The page's caption is the only text kept (see the file comment).
        text: page.caption ?? "",
        textKind: page.caption ? "excerpt" : "none",
        metadata: {
          ...(page.symbol ? { symbol: page.symbol } : {}),
          ...(page.fileUrl ? { pdfUrl: page.fileUrl } : {}),
          // The date the page prints under the title; UNHCR does not label it as the publication date.
          ...(page.pageDateTime ? { pageDate: isoDatePart(page.pageDateTime) ?? page.pageDateTime } : {}),
          ...(listing ? { listedAs: listing.linkText, listedOn: listing.listedOn } : {}),
          statedDates: page.pageDateText ? { page: page.pageDateText } : {},
          textNote: "Link only: UNHCR's terms do not permit storing the Handbook's text for commercial use; read it at the official link.",
        },
        fetch: { response },
      },
    };
  },

  manualImportPaths: [
    {
      path: /^\/media\/[\w-]+$/,
      file: "html",
      role: "document",
      label: "The Handbook's publication page (https://www.unhcr.org/media/handbook-procedures-and-criteria-determining-refugee-status-...), saved as HTML",
    },
    { path: /^\/what-we-do\/data-and-publications\/handbooks-and-toolkits$/, file: "html", role: "linked", label: `Optional: the "Handbooks and toolkits" page, ${LIST_URL}` },
  ],
  manualImportIntervalDays: 100,
  async parseImported(ctx, input) {
    const page = parseUnhcrMediaPage(input.bytes.toString("utf-8"), input.url);
    if (!page || !HANDBOOK_LINK.test(page.title)) return { kind: "skip", reason: `${input.url} is not the Handbook's publication page.` };
    let listing: Listing | undefined;
    if (input.linked) {
      // The listing links the Handbook through a redirect, so its link is matched by its words, as the daily run does.
      const { text, response } = await ctx.http.getText(LIST_URL, { expect: "html" });
      const link = findLinkByText(text, response.url, HANDBOOK_LINK);
      if (!link) throw new LibraryLayoutError(LIST_URL, "no link to the refugee status determination Handbook");
      listing = { linkText: link.text, listedOn: response.url };
    }
    return unhcrHandbookAdapter.fetchDocument(ctx, { externalId: "unhcr-rsd-handbook", url: input.url, title: page.title, ...(listing ? { listing } : {}) });
  },
};
