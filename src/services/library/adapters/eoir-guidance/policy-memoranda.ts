import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText } from "../../extract/html";
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
  bodyField,
  memoChanges,
  memoNumberYear,
  pageHeading,
  parseBookToc,
  parseMemoHeader,
  parseMemoList,
  parseTableOfChanges,
  type MemoChange,
  type MemoEntry,
  type TocNode,
} from "./parse";

// EOIR's policy memoranda (PM) and the older operating policies and
// procedures memoranda (OPPM) still in effect, as EOIR lists them in Part V
// of the EOIR Policy Manual on justice.gov: the List of EOIR Policy
// Memoranda, the Operating Policies and Procedures Memoranda page, and All
// EOIR Memoranda by Topic (which also lists a few memoranda the other two
// do not, and gives each its topic). Each memorandum is read from its PDF.
//
// - Daily: all three lists (the pages are short); unchanged memoranda are
//   skipped by their listing fingerprint, and a PDF re-read after
//   RECHECK_DAYS is a conditional GET (the files carry Last-Modified).
// - Withdrawn: Appendix O, the manual's Table of Changes, records each
//   memorandum EOIR removed ("Removed Policy Memorandum 21-15
//   (Cancellation)") and reinstated. A memorandum whose latest row there is
//   a removal is flagged withdrawn with that row as the reason, including
//   one a list still links (EOIR has left some cancelled OPPMs on the OPPM
//   page). Cancelled memoranda are not linked anywhere any more, so the
//   library holds only what the lists link today plus what it read before.
// - Backfill: the merged list, newest number first, CHUNK per chunk. Older
//   memoranda redirect once to the file, so a memorandum can cost about 20
//   seconds at justice.gov's 10-second Crawl-delay.
// - The same file listed under two numbers (PM 17-03, "formerly OPPM
//   17-03") is one document with both citations.
//
// US government work: public domain, stored in full. Several older
// memoranda are scans without a text layer: stored with their listing and
// link, textKind "none" (no OCR is run).

const PM_LIST_URL = "https://www.justice.gov/eoir/policy-manual-eoir/part-V/memoranda/pm";
const HOSTS = ["www.justice.gov", "justice.gov"] as const;
const AGENCY = "Executive Office for Immigration Review";
const CHUNK = 40;
const RECHECK_DAYS = 60;
const MAX_FILE_BYTES = 60 * 1024 * 1024;

type ListedOn = "pm" | "oppm" | "topic";

type Listing = {
  kind: "PM" | "OPPM";
  /** As listed ("26-07", "97-2"). */
  number: string;
  title: string;
  listedOn: ListedOn[];
  topics: string[];
  /** The same file listed under another number ("OPPM 17-03"). */
  aliases: string[];
  tableOfChanges: { dateOfChange: string; natureOfChange: string }[];
  /** The latest Table of Changes row about this memorandum is a removal. */
  removedPerTableOfChanges: string | null;
};

type Cursor = { offset: number };

function isCursor(value: unknown): value is Cursor {
  return Boolean(value) && Number.isInteger((value as Cursor).offset) && (value as Cursor).offset >= 0;
}

/** "PM 26-07", "OPPM 97-02": the sequence padded so "97-2" and "97-02" are one memorandum. */
function memoId(kind: string, number: string): string {
  const [yy, seq] = number.split("-");
  return `${kind} ${yy}-${seq.padStart(2, "0")}`;
}

function findChild(toc: readonly TocNode[], test: RegExp): TocNode | null {
  for (const n of toc) {
    if (test.test(n.title)) return n;
    const inner = findChild(n.children, test);
    if (inner) return inner;
  }
  return null;
}

async function readList(ctx: LibraryAdapterContext, url: string, label: string): Promise<{ entries: MemoEntry[]; html: string; pageUrl: string }> {
  const { text, response } = await ctx.http.getText(url, { expect: "html" });
  const body = bodyField(text);
  if (!body) throw new LibraryLayoutError(url, `no body field on ${label}`);
  const parsed = parseMemoList(body, response.url);
  for (const note of parsed.notes) ctx.note(`${label}: ${note}`);
  if (parsed.entries.length === 0) throw new LibraryLayoutError(url, `no "PM nn-nn" or "OPPM nn-nn" links on ${label}`);
  return { entries: parsed.entries, html: text, pageUrl: response.url };
}

async function readListing(ctx: LibraryAdapterContext): Promise<{ refs: DocumentRef[]; withdrawn: { externalId: string; reason: string }[] }> {
  const pm = await readList(ctx, PM_LIST_URL, "the List of EOIR Policy Memoranda");
  // The other pages are found in the manual's table of contents, which the list page's sidebar carries.
  const toc = parseBookToc(pm.html, pm.pageUrl);
  const oppmNode = findChild(toc, /Operating Policies and Procedures Memoranda/i);
  const topicNode = findChild(toc, /Memoranda by Topic/i);
  const changesNode = findChild(toc, /Table of Changes/i);
  if (!oppmNode || !topicNode) throw new LibraryLayoutError(PM_LIST_URL, "the table of contents no longer links the OPPM and by-topic pages");
  const oppm = await readList(ctx, oppmNode.url, "the Operating Policies and Procedures Memoranda page");
  const topic = await readList(ctx, topicNode.url, "All EOIR Memoranda by Topic");

  let changes: MemoChange[] = [];
  if (changesNode) {
    const page = await ctx.http.getText(changesNode.url, { expect: "html" });
    const body = bodyField(page.text);
    const parsed = body ? parseTableOfChanges(body) : { entries: [], rowsSeen: 0 };
    if (parsed.rowsSeen === 0) throw new LibraryLayoutError(changesNode.url, "no Section Amended | Date of Change | Nature of Change rows");
    changes = memoChanges(parsed.entries);
  } else {
    ctx.note("The manual's table of contents no longer links a Table of Changes; withdrawals were not read.");
  }

  // Merge the three lists: the PM list, then the OPPM page, then the topic page.
  const byId = new Map<string, { entry: MemoEntry; listing: Listing }>();
  const byUrl = new Map<string, string>();
  const add = (entry: MemoEntry, from: ListedOn) => {
    if (from === "pm" && entry.kind !== "PM") return;
    if (from === "oppm" && entry.kind !== "OPPM") return;
    const id = memoId(entry.kind, entry.number);
    const known = byId.get(id) ?? (byUrl.has(entry.url) ? byId.get(byUrl.get(entry.url)!) : undefined);
    if (known) {
      if (!known.listing.listedOn.includes(from)) known.listing.listedOn.push(from);
      const alias = `${entry.kind} ${entry.number}`;
      if (memoId(known.entry.kind, known.entry.number) !== id && !known.listing.aliases.includes(alias)) known.listing.aliases.push(alias);
      if (entry.topic && !known.listing.topics.includes(entry.topic)) known.listing.topics.push(entry.topic);
      return;
    }
    byId.set(id, {
      entry,
      listing: {
        kind: entry.kind,
        number: entry.number,
        title: entry.title,
        listedOn: [from],
        topics: entry.topic ? [entry.topic] : [],
        aliases: [],
        tableOfChanges: [],
        removedPerTableOfChanges: null,
      },
    });
    byUrl.set(entry.url, id);
  };
  for (const e of pm.entries) add(e, "pm");
  for (const e of oppm.entries) add(e, "oppm");
  for (const e of topic.entries) add(e, "topic");

  // Appendix O rows, newest first as printed: the first row about a memorandum is its latest.
  const latest = new Map<string, MemoChange>();
  for (const c of changes) {
    const id = memoId(c.kind, c.number);
    if (!latest.has(id)) latest.set(id, c);
    const item = byId.get(id);
    if (item && !item.listing.tableOfChanges.some((r) => r.dateOfChange === c.entry.dateOfChange && r.natureOfChange === c.entry.natureOfChange)) {
      item.listing.tableOfChanges.push({ dateOfChange: c.entry.dateOfChange, natureOfChange: c.entry.natureOfChange });
    }
  }
  const withdrawn: { externalId: string; reason: string }[] = [];
  for (const [id, change] of latest) {
    if (change.action !== "removed") continue;
    const reason = `EOIR Policy Manual, Appendix O (Table of Changes), ${change.entry.dateOfChange}: "${change.entry.natureOfChange}"`;
    const item = byId.get(id);
    if (item) item.listing.removedPerTableOfChanges = reason;
    else withdrawn.push({ externalId: id, reason });
  }

  const year = (l: Listing) => memoNumberYear(l.number) ?? 0;
  const seq = (l: Listing) => Number(l.number.split("-")[1]) || 0;
  const refs = [...byId.entries()]
    .sort(([, a], [, b]) => year(b.listing) - year(a.listing) || seq(b.listing) - seq(a.listing) || a.listing.kind.localeCompare(b.listing.kind))
    .map(([id, { entry, listing }]) => ({
      externalId: id,
      url: entry.url,
      title: `${listing.kind} ${listing.number}, ${listing.title}`,
      fingerprint: sha256Hex(
        [entry.url, listing.title, listing.topics.join("|"), listing.aliases.join("|"), listing.removedPerTableOfChanges ?? ""].join("\u0000")
      ).slice(0, 32),
      listing,
    }));
  return { refs, withdrawn };
}

async function fetchMemo(ctx: LibraryAdapterContext, ref: DocumentRef): Promise<FetchDocumentResult> {
  const listing = ref.listing as Listing | undefined;
  if (!listing?.kind || !listing.number || !listing.title) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
  // Most links are PDFs; a few (on the topic page) lead to an HTML page instead.
  let response;
  try {
    response = await ctx.http.get(ref.url, { expect: "any", maxBytes: MAX_FILE_BYTES, conditional: ref.known ?? null });
  } catch (err) {
    // EOIR links a few memoranda to files it has not published (the link answers 403 or 404): nothing to store, said plainly.
    const code = (err as { code?: unknown }).code;
    if (code === "http_403" || code === "http_404" || code === "http_410") {
      return { kind: "skip", reason: `${ref.externalId}: EOIR's link ${ref.url} answers HTTP ${String(code).slice(5)}, so the memorandum could not be read.` };
    }
    throw err;
  }
  if (response.notModified) return { kind: "not_modified" };
  const isPdf = response.body.subarray(0, 1024).toString("latin1").includes("%PDF-");
  const isHtml = !isPdf && /html/i.test(response.contentType);
  if (!isPdf && !isHtml) throw new LibraryLayoutError(response.url, `the memorandum link returned ${response.contentType || "an unknown type"}, not a PDF or a page`);

  let text = "";
  let textKind: "full" | "none" = "full";
  let pageCount: number | null = null;
  let extraction: Record<string, unknown> | undefined;
  let pageTitle: string | null = null;
  if (isPdf) {
    const pdf = await extractPdfText(response.body);
    if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
    text = pdf.pagesWithText > 0 ? pdf.text : "";
    textKind = pdf.pagesWithText > 0 ? "full" : "none";
    pageCount = pdf.pageCount;
    extraction = { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated };
  } else {
    const html = response.body.toString("utf-8");
    const body = bodyField(html);
    if (!body) throw new LibraryLayoutError(response.url, "the memorandum page has no body field");
    text = htmlToDocumentText(body);
    pageTitle = pageHeading(html);
  }

  const header = parseMemoHeader(text);
  const numberYear = memoNumberYear(listing.number);
  // A date is kept only when its year is within a year of the memorandum's
  // number (policy memoranda are numbered by fiscal year), so a date the
  // header quotes from elsewhere is not taken for the memorandum's own.
  const plausible = (stated: string | null) => {
    const iso = parseStatedDate(stated);
    return iso && numberYear !== null && Math.abs(Number(iso.slice(0, 4)) - numberYear) <= 1 ? iso : null;
  };
  const statedDates: Record<string, string> = {};
  if (header.dateText) statedDates.date = header.dateText;
  if (header.effectiveText) statedDates.effective = header.effectiveText;

  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType: "policy_memorandum",
      title: `${listing.kind} ${listing.number}, ${listing.title}`,
      citations: [`${listing.kind} ${listing.number}`, ...listing.aliases],
      agency: AGENCY,
      publishedDate: plausible(header.dateText),
      effectiveDate: plausible(header.effectiveText),
      precedentialStatus: "not_applicable",
      officialUrl: ref.url,
      originalUrl: response.url !== ref.url ? response.url : null,
      text,
      textKind,
      metadata: {
        series: listing.kind === "PM" ? "Policy Memorandum" : "Operating Policies and Procedures Memorandum",
        memoNumber: listing.number,
        listedTitle: listing.title,
        listedOn: listing.listedOn,
        ...(listing.topics.length ? { topics: listing.topics } : {}),
        ...(listing.aliases.length ? { alsoListedAs: listing.aliases } : {}),
        ...(header.purpose ? { summary: header.purpose, summaryKind: "purpose" } : {}),
        ...(header.subject ? { subject: header.subject } : {}),
        ...(header.cancellation ? { cancellation: header.cancellation } : {}),
        ...(header.owner ? { owner: header.owner } : {}),
        ...(header.authority ? { authority: header.authority } : {}),
        ...(pageTitle ? { pageHeading: pageTitle } : {}),
        statedDates,
        ...(listing.tableOfChanges.length ? { tableOfChanges: listing.tableOfChanges } : {}),
        ...(pageCount !== null ? { pageCount } : {}),
        ...(textKind === "none" ? { textNote: "The PDF has no text layer (a scan); no OCR is run." } : {}),
      },
      original: isPdf ? { bytes: response.body, contentType: "application/pdf", extension: "pdf" } : null,
      fetch: { response, ...(extraction ? { extraction } : {}) },
      withdrawn: listing.removedPerTableOfChanges ? { reason: listing.removedPerTableOfChanges } : null,
    },
  };
}

export const eoirPolicyMemorandaAdapter: LibrarySourceAdapter = {
  code: "eoir_policy_memoranda",
  group: "eoir-manuals-memos-forms",
  name: "EOIR policy memoranda and operating policies and procedures memoranda",
  description:
    "The Director's policy memoranda (PM) and the older operating policies and procedures memoranda (OPPM) EOIR lists as in effect in Part V of the EOIR Policy Manual, each read from its PDF, with its topics and the Table of Changes rows about it.",
  coverage:
    "Every memorandum linked from the List of EOIR Policy Memoranda, the OPPM page and All EOIR Memoranda by Topic (PMs from 17-03 on, OPPMs from 84-1 on, as EOIR lists them); cancelled memoranda EOIR no longer links are not available.",
  cadence: "Daily",
  officialUrl: PM_LIST_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: RECHECK_DAYS,

  async listUpdates(ctx) {
    return readListing(ctx);
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const { refs } = await readListing(ctx);
    const offset = isCursor(cursor) ? cursor.offset : 0;
    if (offset >= refs.length) {
      if (offset > 0) ctx.note(`The saved position (${offset}) is past the ${refs.length} memoranda listed now; the walk is complete.`);
      return { refs: [], nextCursor: null, progress: "every listed memorandum is done" };
    }
    const chunk = refs.slice(offset, offset + CHUNK);
    const next = offset + CHUNK;
    return {
      refs: chunk,
      nextCursor: next < refs.length ? { offset: next } : null,
      progress: `memoranda ${offset + 1} to ${offset + chunk.length} of ${refs.length}, newest number first`,
    };
  },

  fetchDocument: fetchMemo,

  legalUpdateItem(document) {
    const dates = document.metadata?.statedDates as { date?: string; effective?: string } | undefined;
    const summary = typeof document.metadata?.summary === "string" ? document.metadata.summary : null;
    return {
      itemType: "Policy memorandum",
      crossSourceKey: null,
      excerpt: summary ? `${document.title}\nPURPOSE: ${summary}` : null,
      publishedDateText: dates?.date ?? dates?.effective ?? null,
      listedOnUrl: PM_LIST_URL,
    };
  },
};
