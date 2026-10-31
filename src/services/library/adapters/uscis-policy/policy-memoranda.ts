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
import {
  fetchUscisFile,
  fingerprintOf,
  pdfExtraction,
  pdfOriginal,
  permanentFetchProblem,
  readSitemap,
  sinceFilter,
  USCIS_AGENCY,
  USCIS_HOSTS,
} from "./common";
import {
  fileExtension,
  fileKey,
  httpsForUscis,
  parseArchiveMemos,
  parseMemoHeader,
  parseRss,
  parseUscisPage,
  rssDate,
  supersessionStatements,
  titleFromFileName,
  urlPath,
} from "./parse";

// USCIS policy memoranda, current and archived, with whether each is still
// in force as USCIS itself shows it:
//
// - current: the Policy Memoranda page (https://www.uscis.gov/laws-and-
//   policy/policy-memoranda), read from its RSS feed, which lists every
//   entry of the page (186 in October 2026) with title, link, summary and
//   date. USCIS: "In addition to the USCIS Policy Manual, USCIS policy
//   memoranda contain the official policies of USCIS";
// - archived: the Archive Memos page, where USCIS says memoranda "that have
//   been partially or fully superseded by the USCIS Policy Manual have been
//   stamped and republished". They are stored and flagged withdrawn with
//   that reason (the contract's "archived"), so a search shows current
//   policy first; links there to the Federal Register (gpo.gov) are notices,
//   collected with the Federal Register, not here;
// - unlisted: the PDFs in the site map's memoranda folders
//   (/sites/default/files/document/memos/, /policy-alerts/ and
//   /policy-manual/) that neither page lists: USCIS still publishes them,
//   but does not say whether they are current. Their title is the
//   memorandum's SUBJECT line, else the file's name. AAO adopted decisions
//   filed there are left to the AAO collector (uscis_aao_adopted);
// - superseded: USCIS redirects the links of superseded memoranda to the
//   Policy Manual. A memorandum whose link now lands on a Policy Manual page
//   is stored without text, flagged withdrawn, with the page it points to.
//
// The same file is listed once: the current page wins over the archive,
// and the archive over the site map (matched by file name, as the archive's
// old /USCIS/Laws/Memoranda/... links redirect to the same file names).
// Daily: both pages, and site map files changed since the last run.
// Backfill: current, then archived, then unlisted, newest first.

const MEMOS_URL = "https://www.uscis.gov/laws-and-policy/policy-memoranda";
const RSS_URL = "https://www.uscis.gov/news/rss-feed/23734";
const ARCHIVE_URL = "https://www.uscis.gov/archive/archive-memos";
const MEMO_FOLDERS = /^\/sites\/default\/files\/document\/(?:memos|policy-alerts|policy-manual)\/[^/]+\.pdf$/i;
const PAGE_SIZE = 60;
const ADOPTED = /adopted[_ -]?decision/i;

type Status = "current" | "archived" | "unlisted";

type Listing = {
  status: Status;
  title: string | null;
  dateText: string | null;
  date: string | null;
  description: string | null;
  listedOn: string;
  lines?: string[];
  monthHeading?: string | null;
  sitemapLastmod?: string | null;
};

type Phase = "current" | "archived" | "unlisted";
const PHASES: Phase[] = ["current", "archived", "unlisted"];
type Cursor = { phase: Phase; offset: number };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && PHASES.includes(c.phase) && Number.isInteger(c.offset) && c.offset >= 0;
}

function onUscis(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "www.uscis.gov" || u.hostname === "uscis.gov");
  } catch {
    return false;
  }
}

function refOf(url: string, listing: Listing): DocumentRef {
  return {
    externalId: urlPath(url),
    url,
    title: listing.title ?? titleFromFileName(url),
    fingerprint: fingerprintOf(listing.status, listing.title, url, listing.dateText, listing.description, (listing.lines ?? []).join("|"), listing.sitemapLastmod),
    listing,
  };
}

type Lists = { current: DocumentRef[]; archived: DocumentRef[]; unlisted: DocumentRef[] };

/** The memoranda the Policy Memoranda page lists now (its RSS feed), as refs. */
export async function readCurrentMemoranda(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text } = await ctx.http.getText(RSS_URL, { expect: "xml" });
  const feed = parseRss(text);
  if (!feed.recognized || feed.items.length === 0) throw new LibraryLayoutError(RSS_URL, "no <item> entries in the Policy Memoranda feed");
  const refs: DocumentRef[] = [];
  for (const item of feed.items) {
    const url = httpsForUscis(item.link);
    if (!onUscis(url)) {
      ctx.note(`The Policy Memoranda page links "${item.title}" off uscis.gov (${url}); it was not collected.`);
      continue;
    }
    refs.push(
      refOf(url, { status: "current", title: item.title, dateText: item.pubDate, date: rssDate(item.pubDate), description: item.description || null, listedOn: MEMOS_URL })
    );
  }
  return refs;
}

async function readArchive(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await ctx.http.getText(ARCHIVE_URL, { expect: "html" });
  const parsed = parseArchiveMemos(text, response.url);
  if (!parsed.recognized) throw new LibraryLayoutError(ARCHIVE_URL, "no linked entries in the page body");
  const refs: DocumentRef[] = [];
  let offSite = 0;
  for (const e of parsed.entries) {
    if (!onUscis(e.url)) {
      offSite++;
      continue;
    }
    if (/\/website-policies\/|\/policy-manual\/?$/.test(urlPath(e.url))) continue;
    refs.push(
      refOf(e.url, {
        status: "archived",
        title: e.title,
        dateText: e.dateText,
        date: parseStatedDate(e.dateText),
        description: null,
        listedOn: ARCHIVE_URL,
        lines: e.lines,
        monthHeading: e.monthHeading,
      })
    );
  }
  if (offSite) ctx.note(`${offSite} Archive Memos entries link off uscis.gov (Federal Register notices on gpo.gov); they are not collected here.`);
  return refs;
}

async function readUnlisted(ctx: LibraryAdapterContext, listed: DocumentRef[]): Promise<DocumentRef[]> {
  const taken = new Set(listed.map((r) => fileKey(r.url)));
  const sitemap = await readSitemap(ctx);
  // A policy alert USCIS also keeps in the memoranda folders under the same
  // file name is the Policy Manual update the updates collector holds.
  for (const u of sitemap) if (/\/document\/policy-manual-updates\//i.test(urlPath(u.loc))) taken.add(fileKey(u.loc));
  const refs: DocumentRef[] = [];
  for (const u of sitemap) {
    const url = httpsForUscis(u.loc);
    if (!onUscis(url) || !MEMO_FOLDERS.test(urlPath(url)) || taken.has(fileKey(url))) continue;
    // AAO adopted decisions (and the memoranda adopting them) are held by the AAO collector.
    if (ADOPTED.test(fileKey(url))) continue;
    taken.add(fileKey(url));
    refs.push(
      refOf(url, {
        status: "unlisted",
        title: null,
        dateText: null,
        date: null,
        description: null,
        listedOn: "https://www.uscis.gov/sitemap.xml",
        sitemapLastmod: u.lastmod,
      })
    );
  }
  return refs;
}

async function readLists(ctx: LibraryAdapterContext): Promise<Lists> {
  const current = await readCurrentMemoranda(ctx);
  const currentKeys = new Set(current.map((r) => fileKey(r.url)));
  const archived = (await readArchive(ctx)).filter((r) => !currentKeys.has(fileKey(r.url)));
  const seen = new Set<string>();
  const dedupe = (refs: DocumentRef[]) => refs.filter((r) => (seen.has(r.externalId) ? false : (seen.add(r.externalId), true)));
  const c = dedupe(current);
  const a = dedupe(archived);
  const unlisted = dedupe(await readUnlisted(ctx, [...c, ...a]));
  return { current: c, archived: a, unlisted };
}

function newestFirst(refs: DocumentRef[]): DocumentRef[] {
  const key = (r: DocumentRef) => {
    const l = r.listing as Listing;
    return l.date ?? l.sitemapLastmod?.slice(0, 10) ?? "";
  };
  return [...refs].sort((x, y) => key(y).localeCompare(key(x)) || x.externalId.localeCompare(y.externalId));
}

function currentness(listing: Listing): { status: string; basis: string } {
  if (listing.status === "current") {
    return { status: "current", basis: "Listed on USCIS's Policy Memoranda page, which holds the policy memoranda USCIS states contain its official policies." };
  }
  if (listing.status === "archived") {
    return {
      status: "archived",
      basis: "Listed on USCIS's Archive Memos page, where USCIS republishes memoranda that the USCIS Policy Manual has partially or fully superseded.",
    };
  }
  return { status: "unlisted", basis: "Published in USCIS's memoranda files, but listed on neither the Policy Memoranda page nor the Archive Memos page." };
}

/** The opening words of a page's text after its title (at most 300 characters): what a superseded memorandum's link now says. */
function pageStatement(articleHtml: string, title: string | null): string | null {
  let text = htmlToDocumentText(articleHtml).replace(/\s+/g, " ").trim();
  if (title && text.startsWith(title)) text = text.slice(title.length).trim();
  text = text.replace(/\s*Last Reviewed\/Updated:.*$/i, "").trim();
  return text ? text.slice(0, 300) : null;
}

// The stamp USCIS put on memoranda it archived: "IMPORTANT: This policy memo has
// been partially or fully superseded by the USCIS Policy Manual. Please visit
// www.uscis.gov/policymanual for current policy." (at the foot of each page).
const STAMP =/\b(?:IMPORTANT:\s*)?This (?:policy )?(?:memo|memorandum|document) has been (?:partially or fully |partially |fully )?(?:superseded|rescinded|withdrawn)\b[^.]{0,200}\./i;

export const uscisPolicyMemorandaAdapter: LibrarySourceAdapter = {
  code: "uscis_policy_memoranda",
  group: "uscis-policy-guidance",
  name: "USCIS policy memoranda (current and archived)",
  description:
    "USCIS policy and procedural memoranda: those on the Policy Memoranda page, those on the Archive Memos page (superseded in part or in full by the Policy Manual), and the other memoranda files USCIS still publishes, each marked with which of these it is.",
  coverage:
    "Every memorandum the Policy Memoranda page lists, every uscis.gov entry of the Archive Memos page (2000 to 2011), and every PDF in the site map's memoranda folders (about 400 files in October 2026).",
  cadence: "Daily",
  officialUrl: MEMOS_URL,
  hosts: USCIS_HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 60,
  maxDocumentsPerDailyRun: 120,

  async listUpdates(ctx, since) {
    const lists = await readLists(ctx);
    const unlisted = sinceFilter(newestFirst(lists.unlisted), (r) => ((r.listing as Listing).sitemapLastmod ?? "").slice(0, 10) || null, since, 3, 0);
    return { refs: [...newestFirst(lists.current), ...lists.archived, ...unlisted] };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const lists = await readLists(ctx);
    const state: Cursor = isCursor(cursor) ? cursor : { phase: "current", offset: 0 };
    const all = newestFirst(lists[state.phase]);
    const refs = all.slice(state.offset, state.offset + PAGE_SIZE);
    const next = state.offset + refs.length;
    const phaseAfter = PHASES[PHASES.indexOf(state.phase) + 1];
    const nextCursor: Cursor | null = next < all.length ? { phase: state.phase, offset: next } : phaseAfter ? { phase: phaseAfter, offset: 0 } : null;
    return {
      refs,
      nextCursor,
      progress: `${state.phase} memoranda ${refs.length ? `${state.offset + 1} to ${next}` : "none left"} of ${all.length}`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.status) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    if (fileExtension(ref.url) && !["pdf"].includes(fileExtension(ref.url)) && !/\.(?:htm|html)$/i.test(ref.url)) {
      return { kind: "skip", reason: `${ref.url} is a .${fileExtension(ref.url)} file, which the library does not read.` };
    }
    let file;
    try {
      file = await fetchUscisFile(ctx, ref.url, ref.known);
    } catch (err) {
      const problem = permanentFetchProblem(err);
      if (problem) return { kind: "skip", reason: problem };
      throw err;
    }
    if (file.kind === "not_modified") return { kind: "not_modified" };
    const state = currentness(listing);
    const base: Omit<LibraryDocumentInput, "text" | "title" | "citations"> = {
      externalId: ref.externalId,
      docType: "policy_memorandum",
      agency: USCIS_AGENCY,
      publishedDate: listing.date,
      precedentialStatus: "not_applicable",
      officialUrl: ref.url,
    };
    const listingMeta = {
      listingStatus: listing.status,
      currentness: state.status,
      currentnessBasis: state.basis,
      listedOn: listing.listedOn,
      ...(listing.description ? { summary: listing.description } : {}),
      ...(listing.lines?.length ? { listingNotes: listing.lines } : {}),
      ...(listing.monthHeading ? { listedUnder: listing.monthHeading } : {}),
      ...(listing.sitemapLastmod ? { sitemapLastmod: listing.sitemapLastmod } : {}),
    };
    const archivedFlag = listing.status === "archived" ? { reason: state.basis } : null;

    if (file.kind === "other") return { kind: "skip", reason: `${file.response.url} is ${file.response.contentType || "an unknown file type"}, which the library does not read.` };
    if (file.kind === "html") {
      // The memorandum's link no longer leads to the memorandum: USCIS sends
      // superseded memoranda to the Policy Manual (its "Superseded Content"
      // page says "This content has been fully superseded. Please visit the
      // USCIS Policy Manual for current guidance."). Kept as a record without
      // text, with what the page it lands on says.
      const landed = file.response.url;
      const toManual = /^\/policy-manual(\/|$)/.test(urlPath(landed));
      const page = parseUscisPage(file.html);
      const pageSays = page ? pageStatement(page.articleHtml, page.title) : null;
      const where = `${landed}${page?.title ? ` ("${page.title}")` : ""}`;
      const basis = toManual
        ? `USCIS redirects this memorandum's link to the Policy Manual, ${where}${pageSays ? `, which says: "${pageSays}"` : "."}`
        : `This memorandum's link now leads to ${where}, not to the memorandum.`;
      return {
        kind: "document",
        document: {
          ...base,
          title: listing.title ?? titleFromFileName(ref.url),
          citations: [],
          text: "",
          textKind: "none",
          metadata: {
            ...listingMeta,
            currentness: toManual ? "superseded_by_policy_manual" : "link_redirected",
            currentnessBasis: basis,
            redirectedTo: landed,
            ...(page?.title ? { redirectedToTitle: page.title } : {}),
            ...(pageSays ? { redirectedPageSays: pageSays } : {}),
          },
          withdrawn: { reason: basis },
          fetch: { response: file.response },
        },
      };
    }

    const pdf = file.pdf;
    const text = pdf.pagesWithText > 0 ? pdf.text : "";
    const header = parseMemoHeader(text);
    const stamp = STAMP.exec(text.slice(0, 20000))?.[0].replace(/\s+/g, " ").trim() ?? null;
    if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
    const title = listing.title ?? header.subject ?? titleFromFileName(ref.url);
    return {
      kind: "document",
      document: {
        ...base,
        docType: header.number?.startsWith("PA-") ? "policy_alert" : "policy_memorandum",
        title,
        citations: header.number ? [header.number] : [],
        publishedDate: parseStatedDate(header.dateText) ?? listing.date,
        originalUrl: file.response.url !== ref.url ? file.response.url : null,
        text,
        textKind: text ? "full" : "none",
        metadata: {
          ...listingMeta,
          titleSource: listing.title ? "listing" : header.subject ? "subject line" : "file name",
          ...(header.number ? { memoNumber: header.number } : {}),
          ...(header.subject ? { subject: header.subject } : {}),
          ...(header.kind ? { documentKind: header.kind } : {}),
          ...(stamp ? { stampText: stamp } : {}),
          ...(stamp && listing.status === "unlisted" ? { currentness: "stamped_superseded", currentnessBasis: `The memorandum carries USCIS's stamp: "${stamp}"` } : {}),
          supersedes: supersessionStatements(text, header.number),
          statedDates: {
            ...(header.dateText ? { issued: header.dateText } : {}),
            ...(listing.dateText ? { listed: listing.dateText } : {}),
          },
          pageCount: pdf.pageCount,
          ...(pdf.pagesWithText === 0 ? { textNote: "The PDF has no text layer (a scan); no OCR is run." } : {}),
        },
        // A memorandum USCIS stamped as superseded is flagged like the archived ones, with the stamp as the reason.
        withdrawn: archivedFlag ?? (stamp && listing.status === "unlisted" ? { reason: `The memorandum carries USCIS's stamp: "${stamp}"` } : null),
        original: pdfOriginal(file.response),
        fetch: { response: file.response, extraction: pdfExtraction(pdf) },
      },
    };
  },

  legalUpdateItem(document) {
    if (document.metadata?.listingStatus !== "current") return null;
    const summary = typeof document.metadata?.summary === "string" ? document.metadata.summary : "";
    return {
      itemType: "USCIS policy memorandum",
      excerpt: [document.title, document.citations[0] ?? "", summary].filter(Boolean).join("\n") || null,
      publishedDateText: ((document.metadata?.statedDates as { issued?: string; listed?: string } | undefined)?.issued ?? null) || null,
      listedOnUrl: MEMOS_URL,
    };
  },
};

