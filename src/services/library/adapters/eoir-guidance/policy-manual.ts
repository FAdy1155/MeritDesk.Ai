import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { anchors, htmlToDocumentText, resolveUrl } from "../../extract/html";
import { extractPdfText } from "../../extract/pdf";
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
  articleTime,
  bodyField,
  changesForSection,
  pageHeading,
  parseBookToc,
  parseTableOfChanges,
  partNumeral,
  sectionLabel,
  updatedLine,
  type ChangeEntry,
  type TocNode,
} from "./parse";

// The EOIR Policy Manual, section by section, as EOIR publishes it on
// justice.gov: Part II (the Immigration Court Practice Manual), Part III
// (the Board Practice Manual), Part IV (the OCAHO Practice Manual), and
// Parts I, VI and VII (the introduction shared by every component, the
// Uniform Docketing System Manual and the appendices). Part V, the
// memoranda, is ./policy-memoranda.ts.
//
// - The table of contents is the sidebar book navigation every manual page
//   carries; a part is found by its title ("Immigration Court Practice
//   Manual"), not its numeral, since EOIR has renumbered parts before. Each
//   page without sub-pages is a document; chapter pages with sections list
//   only their sections and are not fetched.
// - Revision dates: each section page states when it last changed
//   (article:modified_time), kept as the edition date; the part's landing
//   page states its edition ("Updated February 10, 2026"); Appendix O, the
//   Table of Changes, lists dated changes by part. A section's metadata
//   keeps the Table of Changes rows that name it (or its whole part, or
//   the whole manual) since its part's current edition, verbatim.
// - Daily: the whole table of contents. A section's fingerprint covers its
//   title, link, its part's edition and the newest Table of Changes date
//   for its part, so a new row for a part fetches that part again; every
//   section is also re-read every RECHECK_DAYS days (justice.gov's
//   validators change daily, so a conditional GET rarely saves a fetch).
// - Backfill: the same table of contents, CHUNK sections per chunk
//   (justice.gov asks for 10 seconds between requests).
// - EOIR offers no earlier editions; the library keeps the text each
//   section had before a change as a stored version from the day it was
//   first read.
//
// US government work: public domain, stored in full.

const HOSTS = ["www.justice.gov", "justice.gov"] as const;
const AGENCY = "Executive Office for Immigration Review";
const CHUNK = 60;
const RECHECK_DAYS = 14;
/** A page whose own text is shorter than this and links a PDF is a wrapper for that PDF (Part VI). */
const WRAPPER_TEXT_CHARS = 400;
const MAX_ATTACHMENTS = 3;

type PartSpec = { match: RegExp; label: string };

type ManualConfig = {
  code: string;
  name: string;
  description: string;
  coverage: string;
  /** The page whose sidebar is read (the part's landing page, or the manual's for several parts). */
  officialUrl: string;
  parts: readonly PartSpec[];
  /** Whether new sections reach the legal-update feed. */
  feedsLegalUpdates: boolean;
};

type ChangeRow = { dateOfChange: string; sectionAmended: string; natureOfChange: string; scope: "manual" | "part" | "section" };

type Listing = {
  partTitle: string;
  partNumeral: string | null;
  /** The part landing page's "Updated" line; null for a part that is itself one page (read when it is fetched). */
  partUpdated: string | null;
  chapterTitle: string | null;
  sectionTitle: string;
  tableOfChanges: ChangeRow[];
  tableOfChangesUrl: string | null;
};

type Cursor = { offset: number };

function isCursor(value: unknown): value is Cursor {
  return Boolean(value) && Number.isInteger((value as Cursor).offset) && (value as Cursor).offset >= 0;
}

/** Every page of a part that has no sub-pages, with the chapter it sits in. */
function leaves(part: TocNode): { node: TocNode; chapter: TocNode | null }[] {
  if (part.children.length === 0) return [{ node: part, chapter: null }];
  const out: { node: TocNode; chapter: TocNode | null }[] = [];
  const walk = (node: TocNode, chapter: TocNode | null) => {
    if (node.children.length === 0) out.push({ node, chapter });
    else for (const child of node.children) walk(child, chapter ?? node);
  };
  for (const child of part.children) walk(child, null);
  return out;
}

function findNode(nodes: readonly TocNode[], test: (n: TocNode) => boolean): TocNode | null {
  for (const n of nodes) {
    if (test(n)) return n;
    const inner = findNode(n.children, test);
    if (inner) return inner;
  }
  return null;
}

/** The newest Table of Changes date that concerns a part (by its numeral, its appendices, or the whole manual). */
function newestChangeFor(entries: readonly ChangeEntry[], numeral: string | null, hasAppendices: boolean): string {
  let newest = "";
  for (const e of entries) {
    const concerns = e.wholeManual || (numeral !== null && e.parts.includes(numeral)) || (hasAppendices && e.appendices.length > 0);
    if (concerns && e.date && e.date > newest) newest = e.date;
  }
  return newest;
}

async function readListing(ctx: LibraryAdapterContext, config: ManualConfig): Promise<DocumentRef[]> {
  const { text, response } = await ctx.http.getText(config.officialUrl, { expect: "html" });
  const toc = parseBookToc(text, response.url);
  if (toc.length === 0) throw new LibraryLayoutError(config.officialUrl, "no book navigation in the sidebar");

  // Appendix O, the Table of Changes: found in the table of contents like any section.
  const tocNode = findNode(toc, (n) => /Table of Changes/i.test(n.title));
  let changes: ChangeEntry[] = [];
  if (tocNode) {
    const page = await ctx.http.getText(tocNode.url, { expect: "html" });
    const body = bodyField(page.text);
    const parsed = body ? parseTableOfChanges(body) : { entries: [], rowsSeen: 0 };
    if (parsed.rowsSeen === 0) throw new LibraryLayoutError(tocNode.url, "no Section Amended | Date of Change | Nature of Change rows");
    changes = parsed.entries;
  } else {
    ctx.note("The manual's table of contents no longer links a Table of Changes; revision rows were not read.");
  }

  const refs: DocumentRef[] = [];
  for (const spec of config.parts) {
    const part = toc.find((n) => spec.match.test(n.title));
    if (!part) throw new LibraryLayoutError(config.officialUrl, `no "${spec.label}" part in the table of contents`);
    const numeral = partNumeral(part.title);
    // The part's edition, from its landing page (already read when it is the official page).
    let partUpdated: string | null = null;
    if (part.children.length > 0) {
      const landing = part.url === response.url ? text : (await ctx.http.getText(part.url, { expect: "html" })).text;
      const body = bodyField(landing);
      partUpdated = body ? updatedLine(body) : null;
      if (!partUpdated) ctx.note(`${part.title}: the landing page states no "Updated" date.`);
    }
    const partUpdatedIso = parseStatedDate(partUpdated);
    const hasAppendices = /Appendi/i.test(part.title);
    const newest = newestChangeFor(changes, numeral, hasAppendices);
    for (const { node, chapter } of leaves(part)) {
      const label = sectionLabel(node.title);
      const rows = changesForSection(changes, {
        part: numeral,
        number: label?.number ?? null,
        appendix: label?.appendix ?? null,
        partUpdated: partUpdatedIso,
      }).map((e) => ({ dateOfChange: e.dateOfChange, sectionAmended: e.sectionAmended, natureOfChange: e.natureOfChange, scope: e.scope }));
      const listing: Listing = {
        partTitle: part.title,
        partNumeral: numeral,
        partUpdated,
        chapterTitle: chapter && chapter !== part ? chapter.title : null,
        sectionTitle: node.title,
        tableOfChanges: rows,
        tableOfChangesUrl: tocNode?.url ?? null,
      };
      refs.push({
        externalId: new URL(node.url).pathname,
        url: node.url,
        title: node === part ? part.title : `${part.title}: ${node.title}`,
        fingerprint: sha256Hex([node.title, node.url, part.title, partUpdated ?? "", newest].join("\u0000")).slice(0, 32),
        listing,
      });
    }
  }
  if (refs.length === 0) throw new LibraryLayoutError(config.officialUrl, "no sections under the parts this collector reads");
  return refs;
}

function isPdfLink(url: string): boolean {
  try {
    const u = new URL(url);
    return HOSTS.includes(u.hostname as (typeof HOSTS)[number]) && /\/dl$|\/download$|\.pdf$/i.test(u.pathname);
  } catch {
    return false;
  }
}

async function fetchSection(ctx: LibraryAdapterContext, config: ManualConfig, ref: DocumentRef): Promise<FetchDocumentResult> {
  const listing = ref.listing as Listing | undefined;
  if (!listing?.partTitle || !listing.sectionTitle) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
  const { text: html, response } = await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null });
  if (response.notModified) return { kind: "not_modified" };
  const body = bodyField(html);
  if (!body) throw new LibraryLayoutError(response.url, "no body field on the section page");
  let text = htmlToDocumentText(body);
  const heading = pageHeading(html);
  const modified = articleTime(html, "modified_time");
  const published = articleTime(html, "published_time");
  const ownUpdated = listing.partUpdated ? null : updatedLine(body);

  // A page that only wraps a PDF (Part VI links the Uniform Docketing System Manual): read the PDF too.
  const attachments: { label: string; url: string; finalUrl: string; pages: number; pagesWithText: number }[] = [];
  let original: { bytes: Buffer; contentType: string; extension: string } | null = null;
  const ownText = text.replace(/^Updated\s+[A-Z][a-z]+\.?\s+\d{1,2},\s+\d{4}\s*/, "");
  if (ownText.length < WRAPPER_TEXT_CHARS) {
    const links = anchors(body)
      .map((a) => ({ label: a.text, url: resolveUrl(a.href, response.url) }))
      .filter((a): a is { label: string; url: string } => Boolean(a.url && isPdfLink(a.url)));
    for (const link of links.slice(0, MAX_ATTACHMENTS)) {
      const file = await ctx.http.get(link.url, { expect: "pdf" });
      const pdf = await extractPdfText(file.body);
      if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} of ${link.label} were read (size caps).`);
      attachments.push({ label: link.label, url: link.url, finalUrl: file.url, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText });
      if (pdf.pagesWithText > 0) text = `${text}\n\n${link.label}\n\n${pdf.text}`;
      if (!original && links.length === 1) original = { bytes: file.body, contentType: "application/pdf", extension: "pdf" };
    }
  }
  if (!text.trim()) throw new LibraryLayoutError(response.url, "the section page has an empty body");

  const label = sectionLabel(listing.sectionTitle);
  const isPart = listing.sectionTitle === listing.partTitle;
  const citation = listing.partNumeral
    ? `EOIR Policy Manual, Part ${listing.partNumeral}${!isPart && label ? `, ${label.label}` : ""}`
    : null;
  const statedDates: Record<string, string> = {};
  if (modified) statedDates.pageModified = modified;
  if (published) statedDates.pagePublished = published;
  if (listing.partUpdated ?? ownUpdated) statedDates.partUpdated = (listing.partUpdated ?? ownUpdated)!;

  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType: "manual_section",
      title: isPart ? listing.partTitle : `${listing.partTitle}: ${listing.sectionTitle}`,
      citations: citation ? [citation] : [],
      agency: AGENCY,
      // The page's own last-changed date is the section's revision date.
      editionDate: parseStatedDate(modified),
      precedentialStatus: "not_applicable",
      officialUrl: response.url,
      text,
      metadata: {
        manual: "EOIR Policy Manual",
        part: listing.partTitle,
        ...(listing.chapterTitle ? { chapter: listing.chapterTitle } : {}),
        section: listing.sectionTitle,
        ...(heading && heading !== listing.sectionTitle ? { pageHeading: heading } : {}),
        ...(label?.number ? { sectionNumber: label.number } : {}),
        ...(label?.appendix ? { appendix: label.appendix } : {}),
        statedDates,
        ...(listing.tableOfChanges.length
          ? { tableOfChanges: listing.tableOfChanges, tableOfChangesUrl: listing.tableOfChangesUrl }
          : {}),
        ...(attachments.length ? { attachments } : {}),
      },
      original,
      fetch: { response },
    },
  };
}

function manualAdapter(config: ManualConfig): LibrarySourceAdapter {
  return {
    code: config.code,
    group: "eoir-manuals-memos-forms",
    name: config.name,
    description: config.description,
    coverage: config.coverage,
    cadence: "Daily",
    officialUrl: config.officialUrl,
    hosts: HOSTS,
    license: "public_domain",
    staleAfterHours: 48,
    recheckAfterDays: RECHECK_DAYS,

    async listUpdates(ctx) {
      return { refs: await readListing(ctx, config) };
    },

    async backfill(ctx, cursor): Promise<BackfillChunk> {
      const refs = await readListing(ctx, config);
      const offset = isCursor(cursor) ? cursor.offset : 0;
      if (offset >= refs.length) {
        if (offset > 0) ctx.note(`The saved position (${offset}) is past the ${refs.length} sections listed now; the walk is complete.`);
        return { refs: [], nextCursor: null, progress: "every listed section is done" };
      }
      const chunk = refs.slice(offset, offset + CHUNK);
      const next = offset + CHUNK;
      return {
        refs: chunk,
        nextCursor: next < refs.length ? { offset: next } : null,
        progress: `sections ${offset + 1} to ${offset + chunk.length} of ${refs.length}`,
      };
    },

    fetchDocument(ctx, ref) {
      return fetchSection(ctx, config, ref);
    },

    ...(config.feedsLegalUpdates
      ? {
          legalUpdateItem(document) {
            const dates = document.metadata?.statedDates as { pageModified?: string } | undefined;
            return {
              itemType: "Practice Manual" as const,
              crossSourceKey: null,
              excerpt: `${document.title}\n${document.text}`,
              publishedDateText: dates?.pageModified ?? null,
              listedOnUrl: config.officialUrl,
            };
          },
        }
      : {}),
  };
}

export const eoirIcpmAdapter = manualAdapter({
  code: "eoir_icpm",
  name: "Immigration Court Practice Manual (EOIR Policy Manual, Part II)",
  description:
    "The Office of the Chief Immigration Judge's practice manual for the immigration courts, read section by section from the EOIR Policy Manual on justice.gov, with each section's revision date and the Table of Changes rows that name it.",
  coverage:
    "Every section of Part II as the manual's table of contents lists it today; EOIR publishes no earlier editions, so earlier text is kept only from the day the library first read a section.",
  officialUrl: "https://www.justice.gov/eoir/policy-manual-eoir/part-II/icpm",
  parts: [{ match: /Immigration Court Practice Manual/i, label: "Immigration Court Practice Manual" }],
  feedsLegalUpdates: true,
});

export const eoirBiaPracticeManualAdapter = manualAdapter({
  code: "eoir_bia_practice_manual",
  name: "BIA Practice Manual (EOIR Policy Manual, Part III)",
  description:
    "The Board of Immigration Appeals' practice manual, read section by section from the EOIR Policy Manual on justice.gov, with each section's revision date and the Table of Changes rows that name it.",
  coverage:
    "Every section of Part III as the manual's table of contents lists it today; EOIR publishes no earlier editions, so earlier text is kept only from the day the library first read a section.",
  officialUrl: "https://www.justice.gov/eoir/policy-manual-eoir/part-III/bia",
  parts: [{ match: /Board Practice Manual|BIA Practice Manual/i, label: "Board Practice Manual" }],
  feedsLegalUpdates: true,
});

export const eoirOcahoPracticeManualAdapter = manualAdapter({
  code: "eoir_ocaho_practice_manual",
  name: "OCAHO Practice Manual (EOIR Policy Manual, Part IV)",
  description:
    "The Office of the Chief Administrative Hearing Officer's practice manual for employer sanctions, document fraud and unfair employment practice cases, read section by section from the EOIR Policy Manual on justice.gov.",
  coverage:
    "Every section of Part IV as the manual's table of contents lists it today; EOIR publishes no earlier editions, so earlier text is kept only from the day the library first read a section.",
  officialUrl: "https://www.justice.gov/eoir/policy-manual-eoir/part-IV/ocaho",
  parts: [{ match: /OCAHO Practice Manual/i, label: "OCAHO Practice Manual" }],
  feedsLegalUpdates: false,
});

export const eoirPolicyManualGeneralAdapter = manualAdapter({
  code: "eoir_policy_manual_general",
  name: "EOIR Policy Manual: introduction, docketing manual and appendices (Parts I, VI and VII)",
  description:
    "The parts of the EOIR Policy Manual that apply across EOIR: the introduction (forms, appearances and representation, records, practitioner discipline, judicial conduct), the Uniform Docketing System Manual, and the appendices (deadlines, cover pages, certificates, citations, court codes and the Table of Changes).",
  coverage:
    "Every page of Parts I, VI and VII as the manual's table of contents lists it today, with the PDF Part VI links; EOIR publishes no earlier editions.",
  officialUrl: "https://www.justice.gov/eoir/policy-manual-eoir",
  parts: [
    { match: /^Part\s+[IVX]+\s*[-\u2013\u2014]\s*Introduction/i, label: "Introduction" },
    { match: /Uniform Docketing System Manual/i, label: "Uniform Docketing System Manual" },
    { match: /^Part\s+[IVX]+\s*[-\u2013\u2014]\s*Appendices/i, label: "Appendices" },
  ],
  feedsLegalUpdates: true,
});
