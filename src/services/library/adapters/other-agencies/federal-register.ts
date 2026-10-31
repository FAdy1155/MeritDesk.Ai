import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText } from "../../extract/html";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibraryDocumentInput,
  type LibrarySourceAdapter,
} from "../../types";
import { fingerprintOf, IMMIGRATION_TERMS } from "./common";
import { frRawText, parseFrPage, type FrDocument } from "./parse";

// Federal Register documents on immigration, from the Federal Register's
// public API (https://www.federalregister.gov/developers/documentation/api/v1),
// which the Office of the Federal Register and GPO publish. Three searches:
//
// - the immigration agencies, every document: EOIR, USCIS, ICE, the former
//   INS, HHS's Office of Refugee Resettlement and the Commission on
//   Immigration Reform;
// - the departments and offices that publish immigration documents among
//   much else (DHS headquarters, CBP, State, Justice, Labor's ETA and Wage
//   and Hour Division, CDC), narrowed by the API's own full-text search to
//   immigration words and then kept only when the document amends an
//   immigration part of the CFR (8 CFR; 20 CFR 655 and 656; 22 CFR 40 to
//   53; 29 CFR 501 and 503; 42 CFR 34; 45 CFR 400 and 410) or its title,
//   action or summary is about immigration. Coast Guard safety zones and
//   flood maps never reach the library;
// - the benefit agencies whose rules decide which noncitizens may receive
//   their benefits (HUD, USDA's Food and Nutrition Service, CMS, SSA and
//   HHS's Administration for Children and Families), narrowed the same way
//   to documents about noncitizens' eligibility and immigration status.
//   hud.gov refuses automated clients (a Cloudflare block, its robots.txt
//   included), so HUD's noncitizen rules and notices reach the library only
//   through the Federal Register.
//
// Each document's text is the GPO text the Federal Register serves at its
// raw_text_url (one request per document); its official URL is the PDF of
// the printed issue on govinfo.gov, the legal edition, with the
// federalregister.gov page in metadata.
//
// - Daily: documents published since a week before the last run.
// - Backfill: one calendar year of one search per chunk, newest year
//   first, back to 1994 (the API's first year). A year of any search is a
//   few hundred documents, one page of the API.
// - The API asks for no key and federalregister.gov sets no Crawl-delay.
//
// US government work: public domain, stored in full. The legal-update feed
// follows this source (crossSourceKey fr:<document number>, the monitor's
// own key), except paperwork (information collection) notices, which the
// monitor leaves out too.

const API = "https://www.federalregister.gov/api/v1/documents.json";
const HOSTS = ["www.federalregister.gov", "www.govinfo.gov"] as const;
const FIRST_YEAR = 1994;

const CORE_AGENCIES = [
  "executive-office-for-immigration-review",
  "u-s-citizenship-and-immigration-services",
  "u-s-immigration-and-customs-enforcement",
  "immigration-and-naturalization-service",
  "refugee-resettlement-office",
  "commission-on-immigration-reform",
] as const;

const BROAD_AGENCIES = [
  "homeland-security-department",
  "u-s-customs-and-border-protection",
  "state-department",
  "justice-department",
  "employment-and-training-administration",
  "wage-and-hour-division",
  "centers-for-disease-control-and-prevention",
] as const;

// The API's full-text search syntax: "|" is OR.
const BROAD_TERM = "immigration | immigrant | immigrants | alien | aliens | nonimmigrant | visa | visas | asylum | refugee | refugees | naturalization | parole";

const FIELDS = [
  "document_number",
  "title",
  "type",
  "subtype",
  "abstract",
  "action",
  "dates",
  "publication_date",
  "effective_on",
  "html_url",
  "pdf_url",
  "raw_text_url",
  "body_html_url",
  "agencies",
  "cfr_references",
  "citation",
  "docket_ids",
  "regulation_id_numbers",
  "start_page",
  "end_page",
  "volume",
  "significant",
  "correction_of",
  "signing_date",
  "executive_order_number",
  "presidential_document_number",
  "comments_close_on",
  "topics",
] as const;

const BENEFIT_AGENCIES = [
  "housing-and-urban-development-department",
  "food-and-nutrition-service",
  "food-and-nutrition-administration",
  "centers-for-medicare-medicaid-services",
  "social-security-administration",
  "children-and-families-administration",
] as const;

const BENEFIT_TERM =
  'noncitizen | noncitizens | alien | aliens | immigrant | immigrants | "qualified alien" | "qualified aliens" | "lawfully present" | "eligible immigration status" | "immigration status" | refugee | refugees';

type Search = "core" | "broad" | "benefits";
const SEARCHES: readonly Search[] = ["core", "broad", "benefits"];
const SEARCH_LABEL: Record<Search, string> = {
  core: "immigration agencies",
  broad: "departments' immigration documents",
  benefits: "benefit agencies' noncitizen documents",
};

function queryUrl(search: Search, from: string, to: string | null): string {
  const params = new URLSearchParams();
  params.set("per_page", "1000");
  params.set("order", "newest");
  params.set("conditions[publication_date][gte]", from);
  if (to) params.set("conditions[publication_date][lte]", to);
  for (const agency of search === "core" ? CORE_AGENCIES : search === "broad" ? BROAD_AGENCIES : BENEFIT_AGENCIES) params.append("conditions[agencies][]", agency);
  if (search !== "core") params.set("conditions[term]", search === "broad" ? BROAD_TERM : BENEFIT_TERM);
  for (const field of FIELDS) params.append("fields[]", field);
  return `${API}?${params.toString()}`;
}

const CORE = new Set<string>(CORE_AGENCIES);
const PAPERWORK = /Agency Information Collection Activities|Information Collection|Paperwork Reduction Act|Submission for OMB Review|Collection of Information Under Review/i;

function immigrationCfr(doc: FrDocument): boolean {
  return (doc.cfr_references ?? []).some((c) => {
    const title = String(c.title ?? "");
    const part = Number(String(c.part ?? "").replace(/[^\d].*$/, ""));
    if (title === "8") return true;
    if (title === "20") return part === 655 || part === 656;
    if (title === "22") return part >= 40 && part <= 53;
    if (title === "29") return part === 501 || part === 503;
    if (title === "42") return part === 34;
    if (title === "45") return part === 400 || part === 410 || part === 411 || part === 412;
    return false;
  });
}

// The benefit agencies name their noncitizen rules by the statutes behind
// them (PRWORA's Title IV, Section 214 of the Housing and Community
// Development Act of 1980) and by "eligible status", without immigration words.
const BENEFIT_ELIGIBILITY =
  /PRWORA|Personal Responsibility and Work Opportunity Reconciliation Act|Section 214 of the Housing and Community Development Act|Verification of Eligible Status|eligible (?:immigration )?status|Restriction on Assistance to Noncitizens/i;

/** Why a document is kept, or null to leave it out. */
export function keepReason(doc: FrDocument, which: Search = "broad"): string | null {
  if ((doc.agencies ?? []).some((a) => a.slug && CORE.has(a.slug))) return "immigration agency";
  if (immigrationCfr(doc)) return "amends an immigration part of the CFR";
  const words = [doc.title, doc.action ?? "", doc.abstract ?? ""].join(" ");
  if (IMMIGRATION_TERMS.test(words)) return "immigration subject";
  if (which === "benefits" && BENEFIT_ELIGIBILITY.test(words)) return "noncitizen benefit eligibility";
  return null;
}

type Listing = { doc: FrDocument; search: Search };

function refFor(doc: FrDocument, search: Search): DocumentRef | null {
  const textUrl = doc.raw_text_url || doc.body_html_url;
  if (!textUrl) return null;
  return {
    externalId: doc.document_number,
    url: textUrl,
    title: doc.title,
    fingerprint: fingerprintOf(doc.title, doc.citation, doc.pdf_url, doc.raw_text_url, doc.effective_on, doc.correction_of, doc.publication_date),
    listing: { doc, search } satisfies Listing as unknown as Record<string, unknown>,
  };
}

/** Every document one search lists between two dates, following the API's next pages. */
async function search(ctx: LibraryAdapterContext, which: Search, from: string, to: string | null): Promise<DocumentRef[]> {
  const refs: DocumentRef[] = [];
  let url: string | null = queryUrl(which, from, to);
  let dropped = 0;
  for (let page = 1; url && page <= 20; page++) {
    const { data } = await ctx.http.getJson(url);
    const parsed = parseFrPage(data);
    if (!parsed) throw new LibraryLayoutError(url, "the API's response is not the documented documents search shape");
    for (const doc of parsed.documents) {
      // The departments' search also returns their components' documents
      // the agencies' search already lists (a USCIS notice is also DHS's).
      if (which !== "core" && (doc.agencies ?? []).some((a) => a.slug && CORE.has(a.slug))) continue;
      if (which !== "core" && !keepReason(doc, which)) {
        dropped++;
        continue;
      }
      const ref = refFor(doc, which);
      if (ref) refs.push(ref);
      else ctx.note(`FR Doc. ${doc.document_number} lists no text URL; it was skipped.`);
    }
    url = parsed.nextPageUrl;
  }
  if (url) ctx.note(`The ${which} search from ${from} has more than 20 pages; the rest waits for the next run.`);
  if (dropped) ctx.note(`${dropped} document(s) of the ${SEARCH_LABEL[which]} search left out: not about immigration.`);
  return refs;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

type Cursor = { year: number; search: Search };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && Number.isInteger(c.year) && SEARCHES.includes(c.search);
}

function agencyNames(doc: FrDocument): string[] {
  return [...new Set((doc.agencies ?? []).map((a) => a.name || a.raw_name || "").filter(Boolean))];
}

export const federalRegisterAdapter: LibrarySourceAdapter = {
  code: "federal_register_immigration",
  group: "regulations",
  name: "Federal Register: immigration rules, proposed rules and notices",
  description:
    "Rules, proposed rules, notices and presidential documents of the immigration agencies, the immigration documents of DHS, CBP, State, Justice, Labor and CDC, and the benefit agencies' documents on noncitizens' eligibility (HUD, USDA, CMS, SSA, ACF), with their full text, from the Federal Register's API.",
  coverage:
    "Every Federal Register document of EOIR, USCIS, ICE, the former INS, the Office of Refugee Resettlement and the Commission on Immigration Reform since 1994; the documents of DHS, CBP, State, Justice, ETA, the Wage and Hour Division and CDC that amend an immigration part of the CFR or are about immigration; and the documents of HUD, USDA's Food and Nutrition Service, CMS, SSA and ACF about noncitizens or immigration status.",
  cadence: "Daily",
  officialUrl: "https://www.federalregister.gov/",
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 365,

  async listUpdates(ctx, since) {
    const from = isoDay(new Date((since ?? new Date(ctx.now.getTime() - 23 * 86_400_000)).getTime() - 7 * 86_400_000));
    const refs: DocumentRef[] = [];
    for (const which of SEARCHES) refs.push(...(await search(ctx, which, from, null)));
    const seen = new Set<string>();
    return { refs: refs.filter((r) => (seen.has(r.externalId) ? false : (seen.add(r.externalId), true))) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const thisYear = ctx.now.getUTCFullYear();
    const state: Cursor = isCursor(cursor) && cursor.year >= FIRST_YEAR && cursor.year <= thisYear ? cursor : { year: thisYear, search: "core" };
    const refs = await search(ctx, state.search, `${state.year}-01-01`, `${state.year}-12-31`);
    const nextSearch = SEARCHES[SEARCHES.indexOf(state.search) + 1];
    const next: Cursor | null = nextSearch ? { year: state.year, search: nextSearch } : state.year > FIRST_YEAR ? { year: state.year - 1, search: "core" } : null;
    return { refs, nextCursor: next, progress: `${state.year}, ${SEARCH_LABEL[state.search]}: ${refs.length} document(s)` };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as unknown as Listing | undefined;
    const doc = listing?.doc;
    if (!doc?.document_number) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const isText = Boolean(doc.raw_text_url) && ref.url === doc.raw_text_url;
    const { text: body, response } = await ctx.http.getText(ref.url, { expect: isText ? "any" : "html", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const text = isText ? frRawText(body) : body;
    const agencies = agencyNames(doc);
    const officialUrl = doc.pdf_url && /^https:\/\/www\.govinfo\.gov\//.test(doc.pdf_url) ? doc.pdf_url : doc.html_url || response.url;
    const document: LibraryDocumentInput = {
      externalId: doc.document_number,
      docType: "federal_register_document",
      title: doc.title,
      citations: [...(doc.citation ? [doc.citation] : []), `FR Doc. ${doc.document_number}`],
      agency: agencies.join("; ").slice(0, 300) || null,
      publishedDate: parseStatedDate(doc.publication_date),
      effectiveDate: parseStatedDate(doc.effective_on),
      precedentialStatus: "not_applicable",
      officialUrl,
      originalUrl: response.url,
      // The body_html fallback is the document's own HTML, read as page text.
      text: isText ? text : htmlToDocumentText(text),
      metadata: {
        documentNumber: doc.document_number,
        documentType: doc.type ?? null,
        ...(doc.subtype ? { subtype: doc.subtype } : {}),
        ...(doc.action ? { action: doc.action } : {}),
        ...(doc.abstract ? { summary: doc.abstract, summaryKind: "Federal Register SUMMARY" } : {}),
        ...(doc.dates ? { datesStatement: doc.dates } : {}),
        agencies,
        cfrReferences: (doc.cfr_references ?? []).map((c) => `${c.title} CFR ${c.part}`),
        docketIds: doc.docket_ids ?? [],
        rins: doc.regulation_id_numbers ?? [],
        ...(doc.volume ? { volume: doc.volume, startPage: doc.start_page ?? null, endPage: doc.end_page ?? null } : {}),
        ...(doc.significant !== null && doc.significant !== undefined ? { significant: doc.significant } : {}),
        ...(doc.correction_of ? { correctionOf: doc.correction_of } : {}),
        ...(doc.comments_close_on ? { commentsCloseOn: doc.comments_close_on } : {}),
        ...(doc.executive_order_number ? { executiveOrderNumber: String(doc.executive_order_number) } : {}),
        ...(doc.presidential_document_number ? { presidentialDocumentNumber: doc.presidential_document_number } : {}),
        ...(doc.topics?.length ? { topics: doc.topics } : {}),
        federalRegisterPage: doc.html_url ?? null,
        keptBecause: listing?.search && listing.search !== "core" ? keepReason(doc, listing.search) : "immigration agency",
        statedDates: {
          ...(doc.publication_date ? { published: doc.publication_date } : {}),
          ...(doc.effective_on ? { effective: doc.effective_on } : {}),
          ...(doc.signing_date ? { signed: doc.signing_date } : {}),
        },
      },
      fetch: { response },
    };
    return { kind: "document", document };
  },

  legalUpdateItem(document) {
    if (PAPERWORK.test(document.title)) return null;
    const m = document.metadata ?? {};
    // A broad search's document kept only for a word in its summary (a CMS
    // payment rule that mentions lawfully present individuals) is held in the
    // library but is not news for an immigration practice.
    if (m.keptBecause === "immigration subject" && !IMMIGRATION_TERMS.test(`${document.title} ${typeof m.action === "string" ? m.action : ""}`)) return null;
    const lines = [
      typeof m.action === "string" ? `ACTION: ${m.action}` : "",
      typeof m.summary === "string" ? `SUMMARY: ${m.summary}` : "",
      typeof m.datesStatement === "string" ? `DATES: ${m.datesStatement}` : "",
    ].filter(Boolean);
    return {
      itemType: "Federal Register",
      crossSourceKey: `fr:${document.externalId}`,
      excerpt: lines.length ? lines.join("\n") : null,
      publishedDateText: (m.statedDates as { published?: string } | undefined)?.published ?? null,
      listedOnUrl: typeof m.federalRegisterPage === "string" ? m.federalRegisterPage : null,
    };
  },
};
