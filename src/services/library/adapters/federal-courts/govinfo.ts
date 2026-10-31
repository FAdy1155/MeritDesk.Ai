import { extractPdfText } from "../../extract/pdf";
import { sha256Hex } from "../../text";
import { LibraryLayoutError, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibraryDocumentInput } from "../../types";
import {
  appellatePrecedential,
  circuitNumber,
  courtStaffSummary,
  decisiveImmigrationTerms,
  parseSitemap,
  parseUscourtsMods,
  pdfPages,
  type SitemapEntry,
  type UscourtsCase,
  type UscourtsGranule,
} from "./parse";

// What the two GovInfo United States Courts Opinions (USCOURTS) collectors
// share: reading a case's MODS record, turning its opinions (granules) into
// refs, and reading one opinion's PDF into a library document.
//
// A USCOURTS package is one case (docket); each granule is one opinion or
// order filed in it, with the court's docket text, its date and its own
// PDF. One library document per granule, keyed by GovInfo's granule ID
// ("USCOURTS-ca5-25-60702-0").
//
// The MODS record of a package is at
// https://www.govinfo.gov/metadata/pkg/<package ID>/mods.xml, the "MODS"
// download link every GovInfo details page prints for its package (seen on
// the details pages of USCOURTS and USREPORTS packages when this was
// written). It is built from the package ID the sitemap or the API gives,
// instead of reading each package's details page for the same link, which
// would double the requests for hundreds of thousands of packages. Every
// link stored (the opinion's PDF, its details page) is the one the MODS
// record states.

export const GOVINFO_HOST = "www.govinfo.gov";

/** A GovInfo package's MODS record (see the file comment). */
export function packageModsUrl(packageId: string): string {
  return `https://${GOVINFO_HOST}/metadata/pkg/${encodeURIComponent(packageId)}/mods.xml`;
}

/** An HTTP 404 or 410 from ctx.http (OfficialFetchError's code): the page or file is gone. */
export function isGone(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "http_404" || code === "http_410";
}

export async function readSitemapEntries(ctx: LibraryAdapterContext, url: string): Promise<SitemapEntry[]> {
  const { text } = await ctx.http.getText(url, { expect: "xml" });
  const parsed = parseSitemap(text);
  if (!parsed.recognized) throw new LibraryLayoutError(url, "not a sitemap (no <sitemapindex> or <urlset>)");
  return parsed.entries;
}

/** A package's MODS record; null when GovInfo no longer has it (noted). */
export async function readPackageMods(ctx: LibraryAdapterContext, packageId: string): Promise<{ case: UscourtsCase; modsUrl: string } | null> {
  const url = packageModsUrl(packageId);
  let text: string;
  try {
    ({ text } = await ctx.http.getText(url, { expect: "xml" }));
  } catch (err) {
    if (!isGone(err)) throw err;
    ctx.note(`${packageId}: GovInfo has no MODS record for it any more (${err instanceof Error ? err.message : String(err)}); left out.`);
    return null;
  }
  const parsed = parseUscourtsMods(text);
  if (!parsed) throw new LibraryLayoutError(url, "not a USCOURTS MODS record");
  return { case: parsed, modsUrl: url };
}

export type GranuleListing = {
  packageId: string;
  modsUrl: string;
  granule: UscourtsGranule;
  case: Omit<UscourtsCase, "granules">;
  /** The other opinions GovInfo has in the same case. */
  otherGranules: string[];
  reasons: string[];
  /** Kept only when the opinion reads as an immigration case (decisiveImmigrationTerms): an appeal whose parties alone do not say. */
  needsTextCheck: boolean;
};

/** One ref per opinion of the case that has a PDF. */
export function granuleRefs(c: UscourtsCase, modsUrl: string, reasons: string[], needsTextCheck: boolean, note: (m: string) => void): DocumentRef[] {
  const { granules, ...caseFields } = c;
  const refs: DocumentRef[] = [];
  for (const g of granules) {
    if (!g.pdfUrl) {
      note(`${g.granuleId}: no PDF link in the MODS record; left out.`);
      continue;
    }
    const listing: GranuleListing = {
      packageId: c.packageId,
      modsUrl,
      granule: g,
      case: caseFields,
      otherGranules: granules.filter((o) => o.granuleId !== g.granuleId).map((o) => o.granuleId),
      reasons,
      needsTextCheck,
    };
    refs.push({
      externalId: g.granuleId,
      url: g.pdfUrl,
      title: c.title ?? g.title ?? g.granuleId,
      fingerprint: sha256Hex([c.title ?? "", g.title ?? "", g.docketText ?? "", g.dateIssued ?? "", g.pdfUrl, c.caseNumber ?? "", String(needsTextCheck)].join("\u0000")).slice(0, 32),
      listing,
    });
  }
  return refs;
}

/** One opinion's PDF read into a document; a "maybe" appeal whose text uses no immigration term is skipped. */
export async function fetchGranule(ctx: LibraryAdapterContext, ref: DocumentRef, kind: "appeals" | "district"): Promise<FetchDocumentResult> {
  const listing = ref.listing as GranuleListing | undefined;
  if (!listing?.granule?.granuleId || !listing.case) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
  const { granule: g, case: c } = listing;
  const response = await ctx.http.get(ref.url, { expect: "pdf", conditional: ref.known ?? null });
  if (response.notModified) return { kind: "not_modified" };
  const pdf = await extractPdfText(response.body);
  const hasText = pdf.pagesWithText > 0;
  const terms = decisiveImmigrationTerms(pdf.text.slice(0, 60_000));
  if (listing.needsTextCheck && terms.length === 0) {
    return { kind: "skip", reason: `${ref.externalId} (${c.title ?? g.title}): the Attorney General is a party but the opinion does not read as an immigration case (fewer than two decisive immigration terms).` };
  }
  if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
  const firstPage = pdfPages(pdf.text)[0]?.text ?? null;
  const precedential =
    kind === "appeals"
      ? appellatePrecedential(g.docketText, firstPage)
      : // A district court's decision binds no other court (Camreta v. Greene, 563 U.S. 692, 709 n.7 (2011)); GovInfo states no status.
        { status: "non_precedential" as const, basis: "district court decision" };
  const staffSummary = kind === "appeals" ? courtStaffSummary(pdf.text) : null;
  const circuit = circuitNumber(c.circuit, c.courtCode);
  // Some early Fifth Circuit files on GovInfo (2004-2005) hold only the
  // clerk's cover memorandum, not the opinion: stored as GovInfo has it, and said so.
  const coverLetterOnly = pdf.pageCount <= 1 && /MEMORANDUM TO COUNSEL OR PARTIES LISTED BELOW/i.test(pdf.text);
  const document: LibraryDocumentInput = {
    externalId: ref.externalId,
    docType: "opinion",
    title: c.title ?? g.title ?? ref.externalId,
    citations: [],
    court: g.courtName ?? c.courtName,
    decisionDate: g.dateIssued,
    precedentialStatus: precedential.status,
    officialUrl: response.url,
    originalUrl: null,
    text: hasText ? pdf.text : "",
    textKind: hasText ? "full" : "none",
    metadata: {
      packageId: listing.packageId,
      granuleId: g.granuleId,
      ...(c.caseNumber ? { docket: c.caseNumber } : {}),
      ...(c.courtCode ? { courtCode: c.courtCode } : {}),
      ...(circuit ? { circuit } : {}),
      ...(c.state ? { state: c.state } : {}),
      ...(c.caseOffice ? { office: c.caseOffice } : {}),
      ...(c.caseType ? { caseType: c.caseType } : {}),
      ...(c.natureSuitCode ? { natureOfSuitCode: c.natureSuitCode } : {}),
      ...(c.natureSuit ? { natureOfSuit: c.natureSuit } : {}),
      ...(c.cause ? { cause: c.cause } : {}),
      parties: c.parties,
      ...(g.docketText ? { docketText: g.docketText } : {}),
      ...(g.title && g.title !== c.title ? { opinionTitle: g.title } : {}),
      ...(precedential.basis ? { precedentialBasis: precedential.basis } : {}),
      ...(staffSummary ? { summary: staffSummary, summaryKind: "summary prepared by court staff (no part of the opinion)" } : {}),
      immigrationReasons: listing.needsTextCheck ? terms.map((t) => `opinion term: ${t}`) : listing.reasons,
      ...(listing.otherGranules.length ? { otherOpinionsInCase: listing.otherGranules } : {}),
      statedDates: g.dateIssued ? { issued: g.dateIssued } : {},
      ...(g.detailsUrl ? { detailsUrl: g.detailsUrl } : c.detailsUrl ? { detailsUrl: c.detailsUrl } : {}),
      modsUrl: listing.modsUrl,
      pageCount: pdf.pageCount,
      ...(hasText ? {} : { textNote: "The PDF has no text layer (a scan); no OCR is run." }),
      ...(coverLetterOnly ? { textNote: "GovInfo's file for this opinion holds only the clerk's cover memorandum, not the opinion itself." } : {}),
    },
    original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
    fetch: { response, extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated } },
  };
  return { kind: "document", document };
}
