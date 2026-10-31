import { parseStatedDate } from "@/services/monitoring/parse/dates";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
  type ManualImportInput,
  type ManualImportPath,
} from "../../types";
import { sameAddress, sha256Hex } from "../../text";
import { cachedPage, chunkOf, fetchFileText, fileFields, fileMetadata, fingerprintOf, isPdfUrl, pageText, type FileText } from "./common";
import { acfArticle, acfBody, acfDates, acfLead, parseAcfGuideToc, parseOrrLetterTables, parseShortUsDate, pathId, type OrrLetterRow } from "./parse";

// HHS's Office of Refugee Resettlement (ORR), on acf.gov:
//
// - the Unaccompanied Alien Children Bureau Policy Guide (one document per
//   guide page its table of contents links: the introduction, the guide to
//   terms, each section, the record of posting and revision dates) and the
//   UAC Bureau's field guidance (PDFs);
// - the Unaccompanied Refugee Minors (URM) policy guide and the 1987 URM
//   guidelines;
// - the Refugee Program Bureau's Policy Letters, Dear Colleague Letters
//   and State Letters on refugee benefits and eligibility (cash and
//   medical assistance, eligible populations, Afghan, Ukrainian and Cuban
//   and Haitian entrants), each letter as ORR's tables list it.
//
// Pages carry ORR's PUBLISHED and UPDATED dates in the right rail; a page's
// UPDATED date is kept in metadata. The letter tables state dates as
// MM/DD/YY; a date is kept only when it falls within a year of the fiscal
// year the letter's number names (the tables carry a few typos, such as a
// 2017 letter dated 03/03/27), else it is left null with the stated text.
//
// acf.gov's robots.txt (Drupal's standard rules) sets no Crawl-delay and
// allows these pages. acf.gov's firewall answers a User-Agent without the
// "Mozilla/5.0 (compatible; ...)" form with a 403 or a JavaScript
// challenge, robots.txt included, so this collector needs the library's
// User-Agent in that form (see the hand-off note); it never tries to pass a
// challenge. US government work: public domain, stored in full.
//
// Until acf.gov lets the collector through, the three sources are kept up
// to date by import from the official site (../../manual-import.ts): a page
// saved as HTML or a PDF downloaded as it is, with the page that lists it
// as the linked file. A guide page's table of contents gives its guide and
// link label (and a PDF its title, which only the table states); it is
// optional for a guide page, whose own lead gives its title. A letter's
// number, title and date are stated only in ORR's table of letters, so the
// table page is required, and the letter is matched to its row by address
// or, when the table links an address that redirects, by the number the
// letter's own subtitle states ("Policy Letter 26-01").

const HOSTS = ["acf.gov", "www.acf.gov", "www.acf.hhs.gov"] as const;
const AGENCY = "U.S. Department of Health and Human Services, Administration for Children and Families, Office of Refugee Resettlement";
const UAC_GUIDE_URL = "https://acf.gov/orr/policy-guidance/uac-bureau-policy-guide";
const UAC_FIELD_GUIDANCE_URL = "https://acf.gov/orr/policy-guidance/uac-program-field-guidance";
const URM_POLICY_URL = "https://acf.gov/orr/policy-guidance/refugees";
const URM_GUIDE_URL = "https://acf.gov/orr/policy-guidance/guide-eligibility-placement-services-URM";
const LETTER_PAGES = [
  { series: "PL", name: "Policy Letter", url: "https://acf.gov/orr/policy-guidance/refugees/policy-instructions/pl" },
  { series: "DCL", name: "Dear Colleague Letter", url: "https://acf.gov/orr/policy-guidance/refugees/policy-instructions/dcl" },
  { series: "SL", name: "State Letter", url: "https://acf.gov/orr/policy-guidance/refugees/policy-instructions/sl" },
] as const;

type PageListing = { label: string; listedOn: string; guide: string };

/** A guide page (or a PDF it links) as a document: the page's lead title, body and right-rail dates. */
async function fetchGuidePage(ctx: LibraryAdapterContext, ref: DocumentRef, docType: "manual_section" | "policy_memorandum"): Promise<FetchDocumentResult> {
  const listing = ref.listing as PageListing | undefined;
  let lead: { title: string | null; subtitle: string | null } = { title: null, subtitle: null };
  let dates: { published: string | null; updated: string | null } = { published: null, updated: null };
  const htmlContent = (html: string) => {
    lead = acfLead(html);
    dates = acfDates(html);
    return acfBody(html);
  };
  let file: FileText | "not_modified";
  if (isPdfUrl(ref.url)) file = await fetchFileText(ctx, ref.url, ref.known);
  else {
    // Guide pages were read for the listing (to find where each link lands); the run's copy is used.
    const { text, response } = await cachedPage(ctx, ref.url);
    const body = pageText(htmlContent(text) ?? "");
    file = { response, text: body, textKind: body ? "full" : "none", kind: "html", pageCount: null, noTextReason: body ? null : "The page has no text.", extraction: null, original: null };
  }
  if (file === "not_modified") return { kind: "not_modified" };
  const title = lead.title ?? listing?.label ?? ref.externalId;
  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType,
      title: lead.subtitle && !title.includes(lead.subtitle) ? `${title} (${lead.subtitle})` : title,
      citations: [],
      agency: AGENCY,
      publishedDate: parseStatedDate(dates.published),
      precedentialStatus: "not_applicable",
      ...fileFields(file),
      metadata: {
        ...(listing?.guide ? { guide: listing.guide } : {}),
        ...(listing?.label ? { linkLabel: listing.label } : {}),
        ...(listing?.listedOn ? { listedOn: listing.listedOn } : {}),
        ...(lead.subtitle ? { subtitle: lead.subtitle } : {}),
        ...(parseStatedDate(dates.updated) ? { updatedDate: parseStatedDate(dates.updated) } : {}),
        statedDates: { ...(dates.published ? { published: dates.published } : {}), ...(dates.updated ? { updated: dates.updated } : {}) },
        ...fileMetadata(file),
      },
    },
  };
}

/**
 * The pages a table of contents links, each read once so that two links
 * landing on the same page (the guide links some sections both by an
 * older /orr/resource/ address and by its current one) make one document,
 * identified by where it landed; the fingerprint covers the page body, so
 * an edited section is fetched again. PDFs are listed as linked.
 */
async function resolvedRefs(ctx: LibraryAdapterContext, links: { url: string; label: string }[], listedOn: string, guide: string): Promise<DocumentRef[]> {
  const refs = new Map<string, DocumentRef>();
  for (const p of links) {
    let id = pathId(p.url);
    let fingerprint = fingerprintOf(p.label, p.url);
    if (!isPdfUrl(p.url)) {
      const { text, response } = await cachedPage(ctx, p.url);
      id = pathId(response.url);
      fingerprint = fingerprintOf(acfLead(text).title, sha256Hex(acfBody(text) ?? text));
    }
    if (refs.has(id)) continue;
    refs.set(id, { externalId: id, url: p.url, title: p.label, fingerprint, listing: { label: p.label, listedOn, guide } satisfies PageListing });
  }
  return [...refs.values()];
}

async function guideRefs(ctx: LibraryAdapterContext, tocUrl: string, guide: string): Promise<DocumentRef[]> {
  const { text, response } = await cachedPage(ctx, tocUrl);
  const article = acfArticle(text);
  const pages = article ? parseAcfGuideToc(article, response.url) : [];
  if (pages.length === 0) throw new LibraryLayoutError(tocUrl, "no guide pages in the table of contents");
  return resolvedRefs(ctx, pages, tocUrl, guide);
}

async function uacRefs(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const guide = await guideRefs(ctx, UAC_GUIDE_URL, "Unaccompanied Alien Children Bureau Policy Guide");
  const field = await guideRefs(ctx, UAC_FIELD_GUIDANCE_URL, "Unaccompanied Alien Children Bureau Field Guidance");
  const seen = new Set(guide.map((r) => r.externalId));
  return [...guide, ...field.filter((r) => !seen.has(r.externalId))];
}

async function urmRefs(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const guide = await guideRefs(ctx, URM_GUIDE_URL, "Unaccompanied Refugee Minors Policy Guide");
  // The 1987 URM guidelines are linked from the Refugee Program Bureau's policy page, next to the guide.
  const { text, response } = await cachedPage(ctx, URM_POLICY_URL);
  const article = acfArticle(text) ?? "";
  const extra = parseAcfGuideToc(article, response.url).filter((p) => /URM Guidelines|statement-goals-priorities-standards-and-guidelines/i.test(`${p.label} ${p.url}`));
  const seen = new Set(guide.map((r) => r.externalId));
  const more = await resolvedRefs(ctx, extra, URM_POLICY_URL, "Unaccompanied Refugee Minors guidelines (1987)");
  return [...guide, ...more.filter((r) => !seen.has(r.externalId))];
}

// ---------------------------------------------------------------------------
// Import from the official site (../../manual-import.ts)

/** A page that lists a source's pages and files: a guide's table of contents, or a table of letters. */
type ImportListingPage = { url: string; label: string; guide?: string; filter?: (link: { url: string; label: string }) => boolean };

const UAC_TOCS: readonly ImportListingPage[] = [
  { url: UAC_GUIDE_URL, label: "the policy guide's table of contents", guide: "Unaccompanied Alien Children Bureau Policy Guide" },
  { url: UAC_FIELD_GUIDANCE_URL, label: "the field guidance page", guide: "Unaccompanied Alien Children Bureau Field Guidance" },
];

const URM_TOCS: readonly ImportListingPage[] = [
  { url: URM_GUIDE_URL, label: "the URM guide's table of contents", guide: "Unaccompanied Refugee Minors Policy Guide" },
  {
    url: URM_POLICY_URL,
    label: "the Refugee Program Bureau's policy page (for the 1987 URM guidelines)",
    guide: "Unaccompanied Refugee Minors guidelines (1987)",
    filter: (p) => /URM Guidelines|statement-goals-priorities-standards-and-guidelines/i.test(`${p.label} ${p.url}`),
  },
];

function exactPath(url: string): RegExp {
  return new RegExp(`^${new URL(url).pathname.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "i");
}

/** The pages and files an ORR import may name, and the listing pages it may give with them. */
function orrImportPaths(listings: readonly ImportListingPage[]): ManualImportPath[] {
  return [
    { path: /^\/orr\/[^?#]+$/, file: "html", role: "document", label: "A page on acf.gov under /orr/, saved as HTML" },
    { path: /^\/(?:sites\/default|system)\/files\/[^?#]+\.pdf$/i, file: "pdf", role: "document", label: "A PDF on acf.gov (.../files/documents/orr/...pdf), downloaded as it is" },
    ...listings.map((l) => ({ path: exactPath(l.url), file: "html" as const, role: "linked" as const, label: `${l.label}, ${l.url}` })),
  ];
}

/**
 * A guide page or file imported by hand, as the guide's table of contents
 * lists it when that page was given (required for a PDF, whose title only
 * the table states). A page the table links at another address (one that
 * redirects to it) is kept without the link's label, with a note.
 */
async function importedGuideRef(ctx: LibraryAdapterContext, input: ManualImportInput, tocs: readonly ImportListingPage[]): Promise<DocumentRef | { skip: string }> {
  const id = pathId(input.url);
  const pdf = isPdfUrl(input.url);
  if (!input.linked) {
    if (pdf) return { skip: `A PDF's title is stated only on the page that lists it: give ${tocs.map((t) => t.url).join(" or ")} as the linked file.` };
    return { externalId: id, url: input.url, title: id };
  }
  const toc = tocs.find((t) => sameAddress(t.url, input.linked!.url));
  if (!toc) return { skip: `The linked page must be ${tocs.map((t) => `${t.label} (${t.url})`).join(" or ")}.` };
  const { text, response } = await cachedPage(ctx, input.linked.url);
  const article = acfArticle(text);
  const links = (article ? parseAcfGuideToc(article, response.url) : []).filter((p) => toc.filter?.(p) ?? true);
  if (links.length === 0) throw new LibraryLayoutError(input.linked.url, "no guide pages in the table of contents");
  const link = links.find((p) => sameAddress(p.url, input.url));
  if (!link) {
    if (pdf) return { skip: `The page given (${toc.url}) does not link ${input.url}, so the collector would not collect it.` };
    ctx.note(`${toc.url} does not link ${input.url} at that address (its links can lead there through a redirect), so the link's label is not recorded.`);
    return { externalId: id, url: input.url, title: id };
  }
  return { externalId: id, url: input.url, title: link.label, listing: { label: link.label, listedOn: toc.url, guide: toc.guide ?? "" } satisfies PageListing };
}

export const orrUacPolicyGuideAdapter: LibrarySourceAdapter = {
  code: "orr_uac_policy_guide",
  group: "other-agency-guidance",
  name: "ORR Unaccompanied Alien Children Bureau Policy Guide",
  description:
    "The Office of Refugee Resettlement's policy guide for the care and release of unaccompanied children (placement, release to sponsors, legal services, case management, health, and the record of revisions), with the bureau's field guidance.",
  coverage: "Every page the guide's table of contents on acf.gov links, and every field guidance document on ORR's UAC field guidance page.",
  cadence: "Daily",
  officialUrl: UAC_GUIDE_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 14,

  async listUpdates(ctx) {
    return { refs: await uacRefs(ctx) };
  },
  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const { items, nextCursor, progress } = chunkOf(await uacRefs(ctx), cursor, 200);
    return { refs: items, nextCursor, progress };
  },
  fetchDocument(ctx, ref) {
    return fetchGuidePage(ctx, ref, "manual_section");
  },

  manualImportPaths: orrImportPaths(UAC_TOCS),
  manualImportIntervalDays: 35,
  async parseImported(ctx, input) {
    const ref = await importedGuideRef(ctx, input, UAC_TOCS);
    return "skip" in ref ? { kind: "skip", reason: ref.skip } : fetchGuidePage(ctx, ref, "manual_section");
  },
};

export const orrUrmPolicyGuideAdapter: LibrarySourceAdapter = {
  code: "orr_urm_policy_guide",
  group: "other-agency-guidance",
  name: "ORR Unaccompanied Refugee Minors Policy Guide",
  description:
    "The Office of Refugee Resettlement's guide to eligibility, placement and services in the Unaccompanied Refugee Minors program, and ORR's 1987 URM guidelines.",
  coverage: "Every page the URM guide's table of contents on acf.gov links, and the 1987 URM guidelines page.",
  cadence: "Daily",
  officialUrl: URM_GUIDE_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 30,

  async listUpdates(ctx) {
    return { refs: await urmRefs(ctx) };
  },
  async backfill(ctx): Promise<BackfillChunk> {
    const refs = await urmRefs(ctx);
    return { refs, nextCursor: null, progress: `${refs.length} guide pages` };
  },
  fetchDocument(ctx, ref) {
    return fetchGuidePage(ctx, ref, "manual_section");
  },

  manualImportPaths: orrImportPaths(URM_TOCS),
  manualImportIntervalDays: 35,
  async parseImported(ctx, input) {
    const ref = await importedGuideRef(ctx, input, URM_TOCS);
    return "skip" in ref ? { kind: "skip", reason: ref.skip } : fetchGuidePage(ctx, ref, "manual_section");
  },
};

type LetterListing = OrrLetterRow & { seriesName: string; listedOn: string };

/** The refs one table of letters gives (into `refs`, keyed as the ids are). */
async function letterPageRefs(ctx: LibraryAdapterContext, page: (typeof LETTER_PAGES)[number], refs: Map<string, DocumentRef>): Promise<DocumentRef[]> {
  const { text, response } = await cachedPage(ctx, page.url);
  const article = acfArticle(text);
  const rows = article ? parseOrrLetterTables(article, response.url, page.series) : [];
  if (rows.length === 0) throw new LibraryLayoutError(page.url, `no ${page.name} rows (title link, number, date)`);
  const out: DocumentRef[] = [];
  for (const row of rows) {
    const id = `${page.series} ${row.number}`;
    // A number listed twice (a letter and its FAQ) keeps both, the second by its own page.
    const key = refs.has(id) ? `${id} ${pathId(row.url)}` : id;
    if (refs.has(key)) continue;
    const ref: DocumentRef = {
      externalId: key,
      url: row.url,
      title: `${page.name} ${row.number}: ${row.title}`,
      fingerprint: fingerprintOf(row.title, row.url, row.dateText, row.note),
      listing: { ...row, seriesName: page.name, listedOn: page.url } satisfies LetterListing,
    };
    refs.set(key, ref);
    out.push(ref);
  }
  return out;
}

async function letterRefs(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const refs = new Map<string, DocumentRef>();
  for (const page of LETTER_PAGES) await letterPageRefs(ctx, page, refs);
  return [...refs.values()];
}

/**
 * A letter imported by hand, as its table lists it (the table page is
 * required: the letter's number, title and date are stated only there):
 * the row whose link is the letter's address, else the one whose number
 * the letter's own subtitle states, when exactly one row has it.
 */
async function importedLetterRef(ctx: LibraryAdapterContext, input: ManualImportInput): Promise<DocumentRef | { skip: string }> {
  const tables = LETTER_PAGES.map((p) => p.url).join(", ");
  if (!input.linked) return { skip: `A letter's number, title and date are stated only in ORR's tables of letters: give the table that lists it (${tables}) as the linked file.` };
  const page = LETTER_PAGES.find((p) => sameAddress(p.url, input.linked!.url));
  if (!page) return { skip: `The linked page must be one of ORR's tables of letters: ${tables}.` };
  const refs = await letterPageRefs(ctx, page, new Map());
  let ref = refs.find((r) => sameAddress(r.url, input.url));
  if (!ref && !isPdfUrl(input.url)) {
    const subtitle = acfLead(input.bytes.toString("utf-8")).subtitle?.trim() ?? "";
    const number = new RegExp(`^${page.name}\\s+(\\d{2}-\\d{1,3}[A-Za-z]?)$`, "i").exec(subtitle)?.[1];
    const rows = number ? refs.filter((r) => (r.listing as LetterListing).number === number) : [];
    if (rows.length === 1) ref = rows[0];
  }
  if (!ref) return { skip: `The ${page.name} table given does not list ${input.url}, so the collector would not collect it.` };
  return { ...ref, url: input.url };
}

/** Whether a letter's date falls within a year of the fiscal year its number names ("25-03": FY 2025, October 2024 to September 2025). */
function plausibleLetterDate(iso: string | null, number: string, now: Date): boolean {
  if (!iso) return false;
  const yy = Number(number.slice(0, 2));
  const fy = 2000 + yy > now.getUTCFullYear() + 1 ? 1900 + yy : 2000 + yy;
  const year = Number(iso.slice(0, 4));
  return year >= fy - 2 && year <= fy + 1;
}

export const orrRefugeeLettersAdapter: LibrarySourceAdapter = {
  code: "orr_refugee_policy_letters",
  group: "other-agency-guidance",
  name: "ORR refugee benefits and eligibility letters",
  description:
    "The Office of Refugee Resettlement's Policy Letters, Dear Colleague Letters and State Letters on refugee cash and medical assistance, the populations eligible for ORR benefits and services, and program administration.",
  coverage: "Every letter in ORR's Policy Letter, Dear Colleague Letter and State Letter tables on acf.gov (State Letters from 2000).",
  cadence: "Daily",
  officialUrl: "https://acf.gov/orr/policy-guidance/refugees",
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 30,

  async listUpdates(ctx) {
    return { refs: await letterRefs(ctx) };
  },
  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const { items, nextCursor, progress } = chunkOf(await letterRefs(ctx), cursor, 200);
    return { refs: items, nextCursor, progress };
  },
  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as LetterListing | undefined;
    if (!listing?.number) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const result = await fetchGuidePage(ctx, ref, "policy_memorandum");
    if (result.kind !== "document") return result;
    const listed = parseShortUsDate(listing.dateText, ctx.now);
    const date = plausibleLetterDate(listed, listing.number, ctx.now) ? listed : null;
    const doc = result.document;
    return {
      kind: "document",
      document: {
        ...doc,
        title: `${listing.seriesName} ${listing.number}: ${listing.title}`,
        citations: [`ORR ${listing.series} ${listing.number}`],
        publishedDate: date ?? doc.publishedDate ?? null,
        metadata: {
          ...doc.metadata,
          series: listing.seriesName,
          letterNumber: listing.number,
          ...(listing.group ? { table: listing.group } : {}),
          ...(listing.note ? { note: listing.note } : {}),
          listedOn: listing.listedOn,
          statedDates: {
            ...((doc.metadata?.statedDates as Record<string, string> | undefined) ?? {}),
            ...(listing.dateText ? { listedPublicationDate: listing.dateText } : {}),
          },
          ...(listed && !date ? { dateNote: `The table's date ${listing.dateText} does not fall in the fiscal year of letter ${listing.number}; it is not used as the publication date.` } : {}),
        },
      },
    };
  },

  manualImportPaths: orrImportPaths(LETTER_PAGES.map((p) => ({ url: p.url, label: `the ${p.name} table` }))),
  manualImportIntervalDays: 35,
  async parseImported(ctx, input) {
    const ref = await importedLetterRef(ctx, input);
    return "skip" in ref ? { kind: "skip", reason: ref.skip } : orrRefugeeLettersAdapter.fetchDocument(ctx, ref);
  },
};
