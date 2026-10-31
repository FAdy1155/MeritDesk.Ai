import { parseStatedDate } from "@/services/monitoring/parse/dates";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import { fetchFileText, fileFields, fileMetadata, fingerprintOf, IMMIGRATION_TERMS, pause, runCached } from "./common";

// Immigration agencies' documents on Regulations.gov, from its API (v4,
// https://open.gsa.gov/api/regulationsgov/), with an api.data.gov key
// (API_DATA_GOV_KEY, sent in the X-Api-Key header, never in a URL).
//
// What it holds: the documents the agencies post to their rulemaking and
// information-collection dockets that are not themselves Federal Register
// documents (those come from the Federal Register collector): supporting
// and related material such as the form editions and instructions filed
// with an information collection, regulatory impact analyses, fee studies,
// memoranda, guidance and fact sheets. Public comments are never collected:
// they are not government works and they name private people.
//
// - Agencies: USCIS, ICE (ICEB) and EOIR, every such document; DHS, CBP
//   (USCBP), State (DOS), ETA, the Wage and Hour Division and ACF, only the
//   documents whose title, or whose docket's title, is about immigration.
// - Daily: each agency's documents modified since a day before the last run.
// - Backfill: one calendar year of one agency per chunk (posted date),
//   newest year first, back to 2003 (the first year Regulations.gov holds).
// - fetchDocument reads the document's record (its file formats) and then
//   its file from downloads.regulations.gov: a PDF, Word .docx or HTML file
//   is read for text; other formats are held with their metadata and link.
// - api.data.gov allows 1,000 requests an hour per key, so API calls are
//   spaced API_SPACING_MS apart within a run (on top of the host pacing).
// - downloads.regulations.gov (CloudFront) refuses a User-Agent without the
//   "Mozilla/5.0 (compatible; ...)" form with a 403: see the hand-off note
//   on the library's User-Agent. Its robots.txt answers 403 too, which
//   RFC 9309 reads as allowing all.
//
// US government work: public domain, stored in full.

const API = "https://api.regulations.gov/v4";
const HOSTS = ["api.regulations.gov", "downloads.regulations.gov", "www.regulations.gov"] as const;
const KEY_ENV = "API_DATA_GOV_KEY";
const API_SPACING_MS = 4_000;
const FIRST_YEAR = 2003;
const PAGE_SIZE = 250;
const MAX_PAGES = 20; // the API serves at most 20 pages of one query

const CORE_AGENCIES = ["USCIS", "ICEB", "EOIR"] as const;
const FILTERED_AGENCIES = ["DHS", "USCBP", "DOS", "ETA", "WHD", "ACF"] as const;
const AGENCIES = [...CORE_AGENCIES, ...FILTERED_AGENCIES];
/** The agencies Regulations.gov's agency IDs name. */
const AGENCY_NAMES: Record<string, string> = {
  USCIS: "U.S. Citizenship and Immigration Services",
  ICEB: "U.S. Immigration and Customs Enforcement",
  EOIR: "Executive Office for Immigration Review",
  DHS: "U.S. Department of Homeland Security",
  USCBP: "U.S. Customs and Border Protection",
  DOS: "U.S. Department of State",
  ETA: "U.S. Department of Labor, Employment and Training Administration",
  WHD: "U.S. Department of Labor, Wage and Hour Division",
  ACF: "U.S. Department of Health and Human Services, Administration for Children and Families",
};

type ApiDocument = {
  id: string;
  attributes: {
    agencyId?: string | null;
    title?: string | null;
    documentType?: string | null;
    subtype?: string | null;
    docketId?: string | null;
    frDocNum?: string | null;
    postedDate?: string | null;
    lastModifiedDate?: string | null;
    withdrawn?: boolean | null;
    objectId?: string | null;
  };
};

type ApiList = { data?: ApiDocument[]; meta?: { hasNextPage?: boolean; totalElements?: number } };

type ApiDetail = {
  data?: {
    id: string;
    attributes: Record<string, unknown> & {
      fileFormats?: { fileUrl?: string; format?: string; size?: number }[] | null;
      title?: string | null;
      docAbstract?: string | null;
    };
  };
};

const lastCall = new WeakMap<LibraryAdapterContext, number>();

/** One API call: the key in its header, spaced API_SPACING_MS from the run's previous call. */
async function api<T>(ctx: LibraryAdapterContext, url: string): Promise<T> {
  const key = ctx.env(KEY_ENV);
  if (!key) throw new Error(`${KEY_ENV} is not set.`);
  const wait = (lastCall.get(ctx) ?? 0) + API_SPACING_MS - Date.now();
  if (wait > 0) await pause(wait, ctx.signal);
  lastCall.set(ctx, Date.now());
  const { data } = await ctx.http.getJson<T>(url, { headers: { "X-Api-Key": key } });
  return data;
}

/** "2026-10-14 00:00:00", the API's date-time filter format (Eastern time, as the API documents). */
function apiDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function listUrl(agency: string, filter: Record<string, string>, page: number): string {
  const params = new URLSearchParams();
  params.set("filter[agencyId]", agency);
  // Rules, proposed rules and notices are Federal Register documents (held
  // by that collector); asking only for the other types saves API calls.
  params.set("filter[documentType]", "Supporting & Related Material,Other");
  for (const [k, v] of Object.entries(filter)) params.set(k, v);
  params.set("page[size]", String(PAGE_SIZE));
  params.set("page[number]", String(page));
  params.set("sort", "-postedDate");
  return `${API}/documents?${params.toString()}`;
}

type Listing = {
  agencyId: string;
  title: string;
  documentType: string | null;
  subtype: string | null;
  docketId: string | null;
  postedDate: string | null;
  lastModifiedDate: string | null;
  withdrawn: boolean;
  keptBecause: string;
};

function keep(doc: ApiDocument, agency: string): string | null {
  const a = doc.attributes;
  if (a.frDocNum) return null; // the Federal Register collector holds it
  if (a.documentType === "Public Submission" || /comment/i.test(a.subtype ?? "")) return null;
  if ((CORE_AGENCIES as readonly string[]).includes(agency)) return "immigration agency";
  if (IMMIGRATION_TERMS.test(a.title ?? "")) return "immigration subject";
  return null;
}

async function listAgency(ctx: LibraryAdapterContext, agency: string, filter: Record<string, string>): Promise<DocumentRef[]> {
  const refs: DocumentRef[] = [];
  let skipped = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = listUrl(agency, filter, page);
    const body = await api<ApiList>(ctx, url);
    if (!body || !Array.isArray(body.data)) throw new LibraryLayoutError(url.replace(/api_key=[^&]+/i, ""), "the API's response has no data array");
    for (const doc of body.data) {
      const reason = keep(doc, agency);
      if (!reason) {
        skipped++;
        continue;
      }
      const a = doc.attributes;
      const listing: Listing = {
        agencyId: a.agencyId ?? agency,
        title: a.title ?? doc.id,
        documentType: a.documentType ?? null,
        subtype: a.subtype ?? null,
        docketId: a.docketId ?? null,
        postedDate: a.postedDate ?? null,
        lastModifiedDate: a.lastModifiedDate ?? null,
        withdrawn: Boolean(a.withdrawn),
        keptBecause: reason,
      };
      refs.push({
        externalId: doc.id,
        url: `${API}/documents/${encodeURIComponent(doc.id)}`,
        title: listing.title,
        fingerprint: fingerprintOf(listing.title, listing.lastModifiedDate, listing.withdrawn),
        listing,
      });
    }
    if (!body.meta?.hasNextPage) break;
    if (page === MAX_PAGES) ctx.note(`${agency}: more than ${MAX_PAGES * PAGE_SIZE} documents in one window; the rest waits for the next run.`);
  }
  if (skipped) ctx.note(`${agency}: ${skipped} listed document(s) left out (Federal Register documents, comments, or not about immigration).`);
  return refs;
}

type Cursor = { year: number; agency: number };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && Number.isInteger(c.year) && Number.isInteger(c.agency) && c.agency >= 0;
}

const FORMAT_ORDER = ["pdf", "htm", "html", "docx", "txt"];

export const regulationsGovAdapter: LibrarySourceAdapter = {
  code: "regulations_gov_immigration",
  group: "regulations",
  name: "Regulations.gov: immigration agencies' docket documents",
  description:
    "Supporting and related material that USCIS, ICE, EOIR and the other immigration-related agencies post to their Regulations.gov dockets (form editions filed with information collections, regulatory analyses, fee studies, memoranda), from the Regulations.gov API.",
  coverage:
    "Documents posted since 2003 by USCIS, ICE and EOIR, and the immigration documents of DHS, CBP, State, ETA, the Wage and Hour Division and ACF, other than Federal Register documents (held by the Federal Register collector) and public comments (never collected).",
  cadence: "Daily",
  officialUrl: "https://www.regulations.gov/",
  hosts: HOSTS,
  license: "public_domain",
  requiredEnv: [KEY_ENV],
  staleAfterHours: 48,
  recheckAfterDays: 180,
  maxDocumentsPerDailyRun: 300,

  async listUpdates(ctx, since) {
    const from = new Date((since ?? new Date(ctx.now.getTime() - 14 * 86_400_000)).getTime() - 86_400_000);
    const refs: DocumentRef[] = [];
    for (const agency of AGENCIES) refs.push(...(await listAgency(ctx, agency, { "filter[lastModifiedDate][ge]": apiDateTime(from) })));
    return { refs };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const thisYear = ctx.now.getUTCFullYear();
    const state: Cursor = isCursor(cursor) && cursor.year >= FIRST_YEAR && cursor.year <= thisYear && cursor.agency < AGENCIES.length ? cursor : { year: thisYear, agency: 0 };
    const agency = AGENCIES[state.agency];
    const refs = await listAgency(ctx, agency, {
      "filter[postedDate][ge]": `${state.year}-01-01`,
      "filter[postedDate][le]": `${state.year}-12-31`,
    });
    const next: Cursor | null =
      state.agency + 1 < AGENCIES.length ? { year: state.year, agency: state.agency + 1 } : state.year > FIRST_YEAR ? { year: state.year - 1, agency: 0 } : null;
    return { refs, nextCursor: next, progress: `${agency}, posted in ${state.year}: ${refs.length} document(s)` };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const detail = await runCached(ctx, `detail:${ref.externalId}`, () => api<ApiDetail>(ctx, ref.url));
    const attributes = detail?.data?.attributes;
    if (!attributes) return { kind: "skip", reason: `${ref.externalId}: the API returned no record.` };
    const formats = (attributes.fileFormats ?? []).filter((f) => typeof f.fileUrl === "string" && /^https:\/\/downloads\.regulations\.gov\//.test(f.fileUrl));
    formats.sort((a, b) => FORMAT_ORDER.indexOf(a.format ?? "") - FORMAT_ORDER.indexOf(b.format ?? "") || 0);
    const chosen = formats.find((f) => FORMAT_ORDER.includes(f.format ?? "")) ?? formats[0];
    if (!chosen?.fileUrl) return { kind: "skip", reason: `${ref.externalId}: the document has no file on Regulations.gov.` };
    const file = await fetchFileText(ctx, chosen.fileUrl, ref.known);
    if (file === "not_modified") return { kind: "not_modified" };
    const str = (k: string) => (typeof attributes[k] === "string" && (attributes[k] as string).trim() ? (attributes[k] as string).trim() : null);
    const abstract = str("docAbstract");
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: /notice/i.test(listing.documentType ?? "") ? "notice" : "other",
        title: listing.title,
        citations: [],
        agency: AGENCY_NAMES[listing.agencyId] ?? listing.agencyId,
        publishedDate: parseStatedDate(listing.postedDate),
        effectiveDate: parseStatedDate(str("effectiveDate")),
        precedentialStatus: "not_applicable",
        ...fileFields(file),
        metadata: {
          documentId: ref.externalId,
          docketId: listing.docketId,
          documentType: listing.documentType,
          ...(listing.subtype ? { subtype: listing.subtype } : {}),
          ...(abstract ? { summary: abstract, summaryKind: "Regulations.gov abstract" } : {}),
          ...(str("ombApproval") ? { ombControlNumber: str("ombApproval") } : {}),
          ...(str("subject") ? { subject: str("subject") } : {}),
          ...(Array.isArray(attributes.cfrPart) || str("cfrPart") ? { cfrPart: attributes.cfrPart } : {}),
          fileFormat: chosen.format ?? null,
          otherFormats: formats.filter((f) => f !== chosen).map((f) => ({ format: f.format ?? null, url: f.fileUrl })),
          keptBecause: listing.keptBecause,
          ...fileMetadata(file),
          statedDates: {
            ...(listing.postedDate ? { posted: listing.postedDate } : {}),
            ...(listing.lastModifiedDate ? { lastModified: listing.lastModifiedDate } : {}),
            ...(str("effectiveDate") ? { effective: str("effectiveDate") } : {}),
          },
        },
        withdrawn: listing.withdrawn ? { reason: `Regulations.gov marks the document withdrawn${str("reasonWithdrawn") ? `: ${str("reasonWithdrawn")}` : ""}.` } : null,
      },
    };
  },
};
