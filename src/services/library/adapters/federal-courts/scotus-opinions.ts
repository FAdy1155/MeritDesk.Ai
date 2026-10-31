import { anchors, resolveUrl } from "../../extract/html";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import {
  casePageRange,
  immigrationTermsIn,
  opinionParts,
  pageFragment,
  parseJusticeCodes,
  parseSlipOpinionPage,
  parseSlipTermLinks,
  slipCitation,
  slipTableDate,
  syllabusText,
  type SlipOpinionRow,
  type SlipTermLink,
} from "./parse";
import { readPdfPages } from "./pdf-pages";

// The Supreme Court's own "Opinions of the Court" pages
// (https://www.supremecourt.gov/opinions/slipopinions.aspx, one table per
// October Term, 2018 to the current term). Each row gives the Reporter of
// Decisions' sequential number (R-), the decision date, the docket, the
// case name with the Court's one-sentence statement of the holding, the
// author's code, the citation and any revisions. The link is the slip
// opinion PDF, or, for the older terms, a page of the preliminary print or
// bound volume that has replaced it ("588US2PP_final.pdf#page=502"); the
// case is then read from its pages of that file (./pdf-pages.ts keeps the
// file between consecutive refs).
//
// Every opinion on these pages is kept, not only immigration cases: the
// Court decides some sixty cases a term, and its criminal, habeas,
// administrative-law and constitutional decisions are cited in immigration
// practice as often as its immigration ones. The legal-update feed gets only
// those whose name, holding line or syllabus uses an immigration term
// (parse.ts, immigrationTermsIn); the summary step screens again.
//
// The syllabus, the opinion of the Court and each concurrence and dissent
// are told apart by the running head of every page ("Syllabus", "Opinion of
// the Court", "THOMAS, J., dissenting"): metadata.parts gives each part's
// pages, and metadata.summary is the syllabus, verbatim. The text is the
// whole PDF (or the case's pages of the volume), with [Page N] markers.
//
// Opinions before the 2018 Term come from the United States Reports
// collector (./govinfo-us-reports.ts). US government work: public domain.
// robots.txt asks for 1 second between requests.

const ENTRY_URL = "https://www.supremecourt.gov/opinions/slipopinions.aspx";
const HOSTS = ["www.supremecourt.gov"] as const;
const COURT = "Supreme Court of the United States";
/** Daily: the current term and the one before it (whose opinions are revised and paginated in the months after it ends). */
const DAILY_TERMS = 2;

type Listing = {
  term: number;
  termPage: string;
  r: number;
  dateText: string;
  docket: string;
  name: string;
  holding: string | null;
  justice: string | null;
  justiceName: string | null;
  citationText: string | null;
  revisions: { dateText: string; url: string }[];
  /** For a page of a preliminary print or bound volume: the next case's first page in the same file, from the same table. */
  nextStartInFile: number | null;
};

type Cursor = { terms: number[] };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && Array.isArray(c.terms) && c.terms.every((t) => Number.isInteger(t));
}

const withoutFragment = (url: string) => url.replace(/#.*$/, "");

type TermPage = { term: number; pageUrl: string; rows: SlipOpinionRow[]; links: SlipTermLink[]; definitionsUrl: string | null };

async function readTermPage(ctx: LibraryAdapterContext, url: string): Promise<TermPage> {
  const { text, response } = await ctx.http.getText(url, { expect: "html" });
  const parsed = parseSlipOpinionPage(text, response.url);
  if (!parsed.recognized || parsed.term === null) throw new LibraryLayoutError(url, "no table with the R-, Date, Docket, Name, J. and Citation columns under a Term Year heading");
  const definitions = anchors(text).find((a) => /Table Information/i.test(a.text));
  return {
    term: parsed.term,
    pageUrl: response.url,
    rows: parsed.rows,
    links: parseSlipTermLinks(text, response.url),
    definitionsUrl: definitions ? resolveUrl(definitions.href, response.url) : null,
  };
}

async function readJusticeCodes(ctx: LibraryAdapterContext, url: string | null): Promise<Record<string, string>> {
  if (!url) return {};
  try {
    const { text } = await ctx.http.getText(url, { expect: "html" });
    const codes = parseJusticeCodes(text);
    if (Object.keys(codes).length === 0) ctx.note(`The table information page (${url}) listed no Justice codes; authors are kept as codes.`);
    return codes;
  } catch (err) {
    ctx.note(`The table information page could not be read (${err instanceof Error ? err.message : String(err)}); authors are kept as codes.`);
    return {};
  }
}

function refsFor(page: TermPage, codes: Record<string, string>): DocumentRef[] {
  // The first page of each case in each shared file, to find where the next case starts.
  const startsByFile = new Map<string, number[]>();
  for (const row of page.rows) {
    const start = pageFragment(row.url);
    if (start === null) continue;
    const file = withoutFragment(row.url);
    startsByFile.set(file, [...(startsByFile.get(file) ?? []), start]);
  }
  for (const starts of startsByFile.values()) starts.sort((a, b) => a - b);
  const refs = page.rows.map((row): DocumentRef => {
    const start = pageFragment(row.url);
    const starts = startsByFile.get(withoutFragment(row.url)) ?? [];
    const listing: Listing = {
      term: page.term,
      termPage: page.pageUrl,
      r: row.r,
      dateText: row.dateText,
      docket: row.docket,
      name: row.name,
      holding: row.summary,
      justice: row.justice,
      justiceName: row.justice ? (codes[row.justice] ?? null) : null,
      citationText: row.citationText,
      revisions: row.revisions,
      nextStartInFile: start === null ? null : (starts.find((s) => s > start) ?? null),
    };
    return {
      externalId: `OT${page.term} R-${row.r}`,
      url: row.url,
      title: row.name,
      fingerprint: sha256Hex(
        [row.name, row.dateText, row.docket, row.url, row.summary ?? "", row.citationText ?? "", row.justice ?? "", ...row.revisions.map((r) => `${r.dateText} ${r.url}`)].join("\u0000")
      ).slice(0, 32),
      listing,
    };
  });
  // Cases in the same volume file one after another, so the file is read once.
  return refs.sort((a, b) => withoutFragment(a.url).localeCompare(withoutFragment(b.url)) || (pageFragment(a.url) ?? 0) - (pageFragment(b.url) ?? 0));
}

async function readEntry(ctx: LibraryAdapterContext): Promise<TermPage> {
  const page = await readTermPage(ctx, ENTRY_URL);
  if (page.links.length === 0) throw new LibraryLayoutError(ENTRY_URL, "no links to the term pages (2018 onward) in the side menu");
  return page;
}

export const scotusOpinionsAdapter: LibrarySourceAdapter = {
  code: "scotus_opinions_of_the_court",
  group: "supreme-court",
  name: "Supreme Court opinions of the Court (supremecourt.gov)",
  description:
    "Every opinion of the Court the Supreme Court posts on its term pages, from the slip opinion PDF or, for older terms, the case's pages of the preliminary print or bound volume, with the syllabus, the opinion of the Court and each concurrence and dissent told apart by the pages' running heads.",
  coverage:
    "Every opinion the Court's \"Opinions of the Court\" pages list, October Term 2018 to the current term (all subjects; immigration cases are flagged for the legal-update feed). Earlier opinions come from the United States Reports collector.",
  cadence: "Daily",
  officialUrl: ENTRY_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 30,

  async listUpdates(ctx) {
    const entry = await readEntry(ctx);
    const codes = await readJusticeCodes(ctx, entry.definitionsUrl);
    const refs = refsFor(entry, codes);
    for (const link of entry.links.filter((l) => l.term !== entry.term).slice(0, DAILY_TERMS - 1)) {
      refs.push(...refsFor(await readTermPage(ctx, link.url), codes));
    }
    return { refs };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const entry = await readEntry(ctx);
    const state: Cursor = isCursor(cursor) ? cursor : { terms: entry.links.map((l) => l.term) };
    const term = state.terms[0];
    if (term === undefined) return { refs: [], nextCursor: null, progress: "every listed term is done" };
    const rest = state.terms.slice(1);
    const link = entry.links.find((l) => l.term === term);
    if (!link) {
      ctx.note(`October Term ${term} is no longer linked from the opinions pages; it was skipped.`);
      return { refs: [], nextCursor: rest.length ? { terms: rest } : null, progress: `term ${term} not listed` };
    }
    const page = term === entry.term ? entry : await readTermPage(ctx, link.url);
    const refs = refsFor(page, await readJusticeCodes(ctx, page.definitionsUrl));
    return { refs, nextCursor: rest.length ? { terms: rest } : null, progress: `October Term ${term}: ${refs.length} opinion(s); ${rest.length} more term(s) after this one` };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.name || !Number.isInteger(listing.r)) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const start = pageFragment(ref.url);
    const fileUrl = withoutFragment(ref.url);
    const read = await readPdfPages(ctx, fileUrl, ref.known ?? null);
    if (!read) return { kind: "not_modified" };
    const { response, pdf } = read;
    const cite = slipCitation(listing.citationText);
    let pages = read.pages;
    let range: { first: number; last: number } | null = null;
    if (start !== null) {
      const citeParts = cite.citation ? /^(\d+) U\.S\. (\d+)$/.exec(cite.citation) : null;
      range = casePageRange(read.pages, start, listing.nextStartInFile, citeParts ? { volume: Number(citeParts[1]), page: Number(citeParts[2]) } : null);
      pages = read.pages.filter((p) => p.page >= range!.first && p.page <= range!.last);
      if (pages.length === 0) return { kind: "skip", reason: `${ref.externalId}: page ${start} of ${fileUrl} is not in the file (${read.pages.length} pages).` };
    }
    const text = pages.map((p) => `[Page ${p.page}]\n${p.text}`).join("\n\n");
    const hasText = pages.some((p) => p.text.trim().length > 0);
    const parts = opinionParts(pages);
    const syllabus = syllabusText(pages, parts);
    const decided = slipTableDate(listing.dateText);
    const immigrationTerms = immigrationTermsIn([listing.name, listing.holding ?? "", syllabus ?? ""].join("\n"));
    const finalFile = response.url;
    const officialUrl = start !== null ? `${finalFile}#page=${start}` : finalFile;
    if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "opinion",
        title: listing.name,
        citations: cite.citation ? [cite.citation] : [],
        court: COURT,
        decisionDate: decided,
        documentYear: decided ? null : listing.term,
        // Opinions on applications (an "A" docket, the emergency docket) are
        // listed here too; whether they bind as precedent is not something the
        // page states, so they are left unknown.
        precedentialStatus: /^\d{2}A\d+/.test(listing.docket) ? "unknown" : "precedential",
        officialUrl,
        originalUrl: null,
        text: hasText ? text : "",
        textKind: hasText ? "full" : "none",
        metadata: {
          term: `October Term ${listing.term}`,
          reporterNumber: listing.r,
          docket: listing.docket,
          ...(listing.justice ? { authorCode: listing.justice } : {}),
          ...(listing.justiceName ? { author: listing.justiceName } : {}),
          ...(listing.holding ? { holdingAsListed: listing.holding } : {}),
          ...(syllabus ? { summary: syllabus, summaryKind: "syllabus" } : listing.holding ? { summary: listing.holding, summaryKind: "holding line on the Court's opinions page" } : {}),
          ...(listing.citationText ? { citationAsListed: listing.citationText } : {}),
          ...(cite.part !== null ? { preliminaryPrint: { volume: cite.volume, part: cite.part } } : {}),
          parts: parts.map((p) => ({ label: p.label, pages: p.firstPage === p.lastPage ? `${p.firstPage}` : `${p.firstPage}-${p.lastPage}` })),
          ...(listing.revisions.length ? { revisions: listing.revisions } : {}),
          ...(range ? { volumeFile: finalFile, volumePages: `${range.first}-${range.last}` } : {}),
          immigrationTerms,
          statedDates: { decided: listing.dateText },
          listedOn: listing.termPage,
          pageCount: pages.length,
          ...(hasText ? {} : { textNote: "The PDF has no text layer; no OCR is run." }),
        },
        // A volume file holds many cases; it is not kept once per case.
        original: start === null ? { bytes: response.body, contentType: "application/pdf", extension: "pdf" } : null,
        fetch: {
          response,
          extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated, ...(range ? { casePages: `${range.first}-${range.last}` } : {}) },
        },
      },
    };
  },

  legalUpdateItem(document) {
    const terms = document.metadata?.immigrationTerms;
    if (!Array.isArray(terms) || terms.length === 0) return null;
    const summary = typeof document.metadata?.summary === "string" ? document.metadata.summary : null;
    return {
      itemType: "Supreme Court opinion",
      excerpt: summary ? `${document.title}${document.citations.length ? `, ${document.citations.join(", ")}` : ""} (No. ${String(document.metadata?.docket ?? "")})\n${summary}` : null,
      publishedDateText: (document.metadata?.statedDates as { decided?: string } | undefined)?.decided ?? null,
      listedOnUrl: typeof document.metadata?.listedOn === "string" ? document.metadata.listedOn : null,
    };
  },
};
