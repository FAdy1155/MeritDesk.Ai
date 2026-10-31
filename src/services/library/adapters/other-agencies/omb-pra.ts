import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { anchors, resolveUrl } from "../../extract/html";
import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { fetchFileText, fileFields, fileMetadata, fingerprintOf, IMMIGRATION_TERMS } from "./common";
import { parseIcrDocuments, parseIcrPage, parseIcrXml, type IcrRecord } from "./parse";

// OMB's records of the immigration agencies' information collections under
// the Paperwork Reduction Act, on reginfo.gov (OIRA): each information
// collection request (ICR) with its Supporting Statement A, the agency's
// own justification of the form (why it collects what it asks, how it is
// used, the burden), which often explains a form's questions better than
// any other public source.
//
// - The ICRs come from reginfo.gov's PRA XML reports: the current
//   inventory (every active collection; about 100 MB, read once at the
//   start of the backfill and carried in the cursor), and for the daily
//   run the reports of collections pending review and of reviews concluded
//   in the last 30 days.
// - Agencies: USCIS (1615), ICE (1653) and EOIR (1125), every collection;
//   CBP (1651), DHS (1601), State (1405), ETA (1205), WHD (1235) and ACF
//   (0970), only collections whose title or abstract is about immigration.
// - Per ICR, the PRAViewDocument page lists Supporting Statement A (a Word
//   .docx or PDF, read for text; a legacy .doc is held with its metadata
//   and link) and the other documents, which are listed in metadata.
// - The XML's agency contacts (names, phone numbers, emails) are never read.
//
// reginfo.gov publishes no robots.txt (its /robots.txt redirects to its
// home page) and sets no Crawl-delay. US government work: public domain,
// stored in full.

const HOSTS = ["www.reginfo.gov"] as const;
const BASE = "https://www.reginfo.gov/public/do";
const INVENTORY_URL = `${BASE}/PRAXML?type=inventory`;
const DAILY_REPORTS = [`${BASE}/PRAXML?type=pending`, `${BASE}/PRAXML?type=concluded`] as const;
const CHUNK_SIZE = 120;

const CORE_AGENCIES = new Set(["1615", "1653", "1125"]);
const FILTERED_AGENCIES = new Set(["1651", "1601", "1405", "1205", "1235", "0970"]);
const AGENCY_NAMES: Record<string, string> = {
  "1615": "U.S. Citizenship and Immigration Services",
  "1653": "U.S. Immigration and Customs Enforcement",
  "1125": "Executive Office for Immigration Review",
  "1651": "U.S. Customs and Border Protection",
  "1601": "U.S. Department of Homeland Security",
  "1405": "U.S. Department of State",
  "1205": "U.S. Department of Labor, Employment and Training Administration",
  "1235": "U.S. Department of Labor, Wage and Hour Division",
  "0970": "U.S. Department of Health and Human Services, Administration for Children and Families",
};

// An abstract is held to narrower words than a title: abstracts of unrelated
// collections mention prevailing wages (Davis-Bacon) or visas in passing.
const ABSTRACT_TERMS = /\bimmigra\w*|\bnonimmigrants?\b|\baliens?\b|\bH-2[AB]\b|\bH-1B\d?\b|\bCW-1\b|\blabor certification\b|\brefugees?\b|\basylum\b|\bnaturaliz\w*|\bunaccompanied (?:alien )?(?:children|minors)\b/i;

function wanted(r: IcrRecord): boolean {
  if (!r.agencyCode) return false;
  if (CORE_AGENCIES.has(r.agencyCode)) return true;
  return FILTERED_AGENCIES.has(r.agencyCode) && (IMMIGRATION_TERMS.test(r.title) || ABSTRACT_TERMS.test(r.abstract ?? ""));
}

function refFor(r: IcrRecord): DocumentRef {
  return {
    externalId: `ICR ${r.icrReferenceNumber}`,
    url: `${BASE}/PRAViewICR?ref_nbr=${encodeURIComponent(r.icrReferenceNumber)}`,
    title: r.title,
    fingerprint: fingerprintOf(r.title, r.status, r.concludedDate, r.expirationDate, r.icrType),
    listing: r,
  };
}

async function readReport(ctx: LibraryAdapterContext, url: string, big: boolean): Promise<IcrRecord[]> {
  const { text } = await ctx.http.getText(url, {
    expect: "xml",
    ...(big ? { maxBytes: 250 * 1024 * 1024, timeoutMs: 20 * 60_000 } : {}),
  });
  const parsed = parseIcrXml(text);
  if (!parsed.recognized) throw new LibraryLayoutError(url, "not an InformationCollectionRequestList");
  return parsed.records;
}

type Cursor = { remaining: IcrRecord[]; total: number };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && Array.isArray(c.remaining) && Number.isInteger(c.total);
}

export const ombPraSupportingStatementsAdapter: LibrarySourceAdapter = {
  code: "omb_pra_supporting_statements",
  group: "other-agency-guidance",
  name: "OMB supporting statements for immigration information collections",
  description:
    "The supporting statements the immigration agencies file with OMB for their forms and other information collections under the Paperwork Reduction Act, with each collection's OMB control number, abstract, form numbers and review status, from reginfo.gov.",
  coverage:
    "The active information collections of USCIS, ICE and EOIR in OMB's inventory when the backfill ran, and those of CBP, DHS, State, ETA, the Wage and Hour Division and ACF about immigration; then each day the collections pending OMB review or concluded in the last 30 days. One document per collection request, with its Supporting Statement A.",
  cadence: "Daily",
  officialUrl: `${BASE}/PRAMain`,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 365,
  maxDocumentsPerDailyRun: 200,

  async listUpdates(ctx) {
    const records = new Map<string, IcrRecord>();
    for (const url of DAILY_REPORTS) for (const r of await readReport(ctx, url, false)) if (wanted(r)) records.set(r.icrReferenceNumber, r);
    return { refs: [...records.values()].map(refFor) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    let state: Cursor;
    if (isCursor(cursor)) state = cursor;
    else {
      const all = (await readReport(ctx, INVENTORY_URL, true)).filter(wanted);
      if (all.length === 0) throw new LibraryLayoutError(INVENTORY_URL, "no immigration agency collections in the inventory");
      // Newest conclusions first.
      all.sort((a, b) => (b.concludedDate ?? "").localeCompare(a.concludedDate ?? ""));
      state = { remaining: all, total: all.length };
    }
    const chunk = state.remaining.slice(0, CHUNK_SIZE);
    const rest = state.remaining.slice(CHUNK_SIZE);
    const done = state.total - state.remaining.length;
    return {
      refs: chunk.map(refFor),
      nextCursor: rest.length ? { remaining: rest, total: state.total } : null,
      progress: `collections ${done + 1} to ${done + chunk.length} of ${state.total} in the inventory`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const r = ref.listing as IcrRecord | undefined;
    if (!r?.icrReferenceNumber) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    // The ICR's page (reginfo.gov's public address for a reference number) links its documents page.
    const { text: icrHtml, response: icrResponse } = await ctx.http.getText(ref.url, { expect: "html" });
    if (!icrHtml.includes(r.icrReferenceNumber)) return { kind: "skip", reason: `${ref.url} does not show ICR ${r.icrReferenceNumber}.` };
    const docLink = anchors(icrHtml).find((a) => /PRAViewDocument\?ref_nbr=/i.test(a.href));
    const docUrl = docLink ? resolveUrl(docLink.href, icrResponse.url) : null;
    if (!docUrl) return { kind: "skip", reason: `${ref.url} links no supporting statement page.` };
    const { text, response: pageResponse } = await ctx.http.getText(docUrl, { expect: "html" });
    const { recognized, documents } = parseIcrDocuments(text, pageResponse.url);
    if (!recognized) return { kind: "skip", reason: `${ref.url} does not show the ICR documents table.` };
    const statementA = documents.find((d) => d.kind === "supporting_statement_a");
    // The daily reports carry no abstract, status, type or forms; the ICR page states them.
    const page = parseIcrPage(icrHtml);
    const abstract = r.abstract ?? page?.abstract ?? null;
    const formNumbers = r.formNumbers.length ? r.formNumbers : (page?.formNumbers ?? []);
    const metadata: Record<string, unknown> = {
      icrReferenceNumber: r.icrReferenceNumber,
      ombControlNumber: r.ombControlNumber,
      agencyCode: r.agencyCode,
      ...(page?.agency ? { agencySubagency: page.agency } : {}),
      ...(page?.agencyTrackingNumber ? { agencyTrackingNumber: page.agencyTrackingNumber } : {}),
      ...(abstract ? { summary: abstract, summaryKind: "ICR abstract" } : {}),
      ...(r.icrType ? { icrType: r.icrType } : {}),
      ...(page?.collectionType ? { collectionType: page.collectionType } : {}),
      ...(page?.reviewType ? { reviewType: page.reviewType } : {}),
      ...(r.status || page?.status ? { status: r.status ?? page?.status } : {}),
      ...(page?.conclusionAction ? { oiraConclusionAction: page.conclusionAction } : {}),
      formNumbers,
      cfrCitations: r.cfrCitations,
      icrPage: icrResponse.url,
      documentsPage: pageResponse.url,
      documents: documents.map((d) => ({ kind: d.kind, label: d.label, file: d.fileName, url: d.url, uploaded: d.uploaded })),
      statedDates: {
        ...(r.concludedDate ? { oiraConcluded: r.concludedDate } : page?.conclusionDate ? { oiraConcluded: page.conclusionDate } : {}),
        ...(r.submissionDate ? { submitted: r.submissionDate } : page?.receivedDate ? { receivedInOira: page.receivedDate } : {}),
        ...(r.expirationDate ? { expires: r.expirationDate } : {}),
        ...(statementA?.uploaded ? { supportingStatementUploaded: statementA.uploaded } : {}),
      },
    };
    const base = {
      externalId: ref.externalId,
      docType: "other" as const,
      title: `${r.title} (OMB ${r.ombControlNumber ?? "control number not assigned"}): Supporting Statement A`,
      citations: [...(r.ombControlNumber ? [`OMB No. ${r.ombControlNumber}`] : []), `ICR ${r.icrReferenceNumber}`],
      agency: (r.agencyCode && AGENCY_NAMES[r.agencyCode]) || null,
      publishedDate: parseStatedDate(r.concludedDate ?? page?.conclusionDate ?? r.submissionDate ?? page?.receivedDate),
      precedentialStatus: "not_applicable" as const,
    };
    if (!statementA) {
      return {
        kind: "document",
        document: { ...base, officialUrl: icrResponse.url, text: "", textKind: "none", metadata: { ...metadata, textNote: "OMB's record lists no Supporting Statement A for this request." }, fetch: { response: icrResponse } },
      };
    }
    const file = await fetchFileText(ctx, statementA.url, ref.known);
    if (file === "not_modified") return { kind: "not_modified" };
    return {
      kind: "document",
      document: { ...base, ...fileFields(file), metadata: { ...metadata, supportingStatementFile: statementA.fileName, ...fileMetadata(file) } },
    };
  },
};
