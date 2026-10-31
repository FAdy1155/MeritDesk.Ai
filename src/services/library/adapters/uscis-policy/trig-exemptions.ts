import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { anchors, htmlToDocumentText, resolveUrl } from "../../extract/html";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import { fetchUscisFile, fingerprintOf, pdfExtraction, pdfOriginal, permanentFetchProblem, USCIS_AGENCY, USCIS_HOSTS } from "./common";
import { fileExtension, httpsForUscis, linksBySection, parseMemoHeader, parseUscisPage, urlPath, WRITTEN_DATE } from "./parse";

// Terrorism-related inadmissibility grounds (TRIG) exemption authorities:
// USCIS's TRIG pages (https://www.uscis.gov/laws-and-policy/other-
// resources/terrorism-related-inadmissibility-grounds-trig and the pages
// under it: the exemptions, situational exemptions and group-based
// exemptions) and the documents they link for each exemption: the
// Secretaries' exercises of authority under INA 212(d)(3)(B)(i) and USCIS's
// implementation memoranda.
//
// - Each page is a document; its metadata lists every document it links,
//   under the exemption (the accordion heading) it is linked from.
// - Each linked PDF on uscis.gov is a document, titled as the page links it
//   ("June 18, 2008, Exercise of Authority (CAA)"), dated by the date that
//   title states. Files in USCIS's memoranda folders are held by the
//   memoranda collector instead (they are listed on the page's record), and
//   Federal Register links are left to the Federal Register collection.
// - Daily and backfill read the same few pages (about 45 documents in all);
//   fingerprints skip what is unchanged.

const TRIG_URL = "https://www.uscis.gov/laws-and-policy/other-resources/terrorism-related-inadmissibility-grounds-trig";
const TRIG_PATH = new URL(TRIG_URL).pathname;
const MEMO_FOLDERS = /^\/sites\/default\/files\/document\/(?:memos|policy-alerts|policy-manual)\//i;
const MAX_PAGES = 10;

type PageListing = { kind: "page"; title: string | null; links: { section: string | null; title: string; url: string }[] };
type FileListing = { kind: "file"; title: string; sections: string[]; linkedFrom: string[] };

export type TrigPages = {
  pages: { url: string; title: string | null; text: string; links: { section: string | null; title: string; url: string }[] }[];
  /** Every file the pages link, by URL path, with the titles and sections it is linked under. */
  files: Map<string, { url: string; titles: string[]; sections: string[]; linkedFrom: string[] }>;
};

/** The TRIG pages and the files they link: the landing page, then every page under it that the pages link (at most MAX_PAGES). */
export async function readTrigPages(ctx: LibraryAdapterContext): Promise<TrigPages> {
  const queue = [TRIG_URL];
  const seen = new Set<string>();
  const out: TrigPages = { pages: [], files: new Map() };
  while (queue.length && out.pages.length < MAX_PAGES) {
    const url = queue.shift()!;
    const path = urlPath(url);
    if (seen.has(path)) continue;
    seen.add(path);
    const { text, response } = await ctx.http.getText(url, { expect: "html" });
    const page = parseUscisPage(text);
    if (!page) throw new LibraryLayoutError(url, "no article on the TRIG page");
    const body = /<div\b[^>]*class="[^"]*field--name-body[^"]*"[^>]*>/i.exec(page.articleHtml);
    const bodyHtml = body ? page.articleHtml.slice(body.index) : page.articleHtml;
    const links = linksBySection(bodyHtml, response.url).filter((l) => !/\/website-policies\//.test(l.url));
    out.pages.push({ url: response.url, title: page.title, text: htmlToDocumentText(page.articleHtml), links });
    for (const a of anchors(page.articleHtml)) {
      const next = resolveUrl(a.href, response.url);
      if (!next) continue;
      const u = new URL(httpsForUscis(next));
      if (u.hostname === "www.uscis.gov" && u.pathname.startsWith(`${TRIG_PATH}/`) && !seen.has(u.pathname)) queue.push(`${u.origin}${u.pathname}`);
    }
    for (const l of links) {
      const u = new URL(l.url);
      if (u.hostname !== "www.uscis.gov" || !u.pathname.startsWith("/sites/default/files/")) continue;
      const entry = out.files.get(u.pathname) ?? { url: `${u.origin}${u.pathname}`, titles: [], sections: [], linkedFrom: [] };
      if (!entry.titles.includes(l.title)) entry.titles.push(l.title);
      if (l.section && !entry.sections.includes(l.section)) entry.sections.push(l.section);
      if (!entry.linkedFrom.includes(response.url)) entry.linkedFrom.push(response.url);
      out.files.set(u.pathname, entry);
    }
  }
  if (out.pages.length < 2 || out.files.size === 0) throw new LibraryLayoutError(TRIG_URL, `found ${out.pages.length} TRIG page(s) and ${out.files.size} linked file(s)`);
  return out;
}

async function listAll(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const trig = await readTrigPages(ctx);
  const refs: DocumentRef[] = trig.pages.map((p) => {
    const listing: PageListing = { kind: "page", title: p.title, links: p.links };
    return { externalId: urlPath(p.url), url: p.url, title: p.title ?? p.url, fingerprint: fingerprintOf(p.title, p.url, p.text), listing };
  });
  let memoFiles = 0;
  let otherFiles = 0;
  for (const [path, f] of trig.files) {
    if (MEMO_FOLDERS.test(path)) {
      memoFiles++;
      continue;
    }
    if (fileExtension(f.url) !== "pdf") {
      otherFiles++;
      continue;
    }
    const listing: FileListing = { kind: "file", title: f.titles[0], sections: f.sections, linkedFrom: f.linkedFrom };
    refs.push({ externalId: path, url: f.url, title: f.titles[0], fingerprint: fingerprintOf(f.titles.join("|"), f.url, f.sections.join("|")), listing });
  }
  if (memoFiles) ctx.note(`${memoFiles} linked file(s) in USCIS's memoranda folders are held by the memoranda collector (uscis_policy_memoranda).`);
  if (otherFiles) ctx.note(`${otherFiles} linked file(s) are not PDFs and were not collected.`);
  return refs;
}

export const uscisTrigExemptionsAdapter: LibrarySourceAdapter = {
  code: "uscis_trig_exemptions",
  group: "uscis-policy-guidance",
  name: "USCIS terrorism-related inadmissibility grounds (TRIG) exemptions",
  description:
    "USCIS's TRIG exemption pages and the documents they link for each situational and group-based exemption: the exercises of exemption authority and USCIS's implementation memoranda.",
  coverage: "The TRIG page, every page under it that it links, and every PDF on uscis.gov those pages link (implementation memoranda in USCIS's memoranda folders are held with the memoranda).",
  cadence: "Daily",
  officialUrl: TRIG_URL,
  hosts: USCIS_HOSTS,
  license: "public_domain",
  staleAfterHours: 72,
  recheckAfterDays: 90,

  async listUpdates(ctx) {
    return { refs: await listAll(ctx) };
  },

  async backfill(ctx): Promise<BackfillChunk> {
    // A few pages and about 45 files: one chunk is the whole source.
    return { refs: await listAll(ctx), nextCursor: null, progress: "the TRIG pages and every file they link" };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as PageListing | FileListing | undefined;
    if (!listing?.kind) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    let file;
    try {
      file = await fetchUscisFile(ctx, ref.url, ref.known);
    } catch (err) {
      const problem = permanentFetchProblem(err);
      if (problem) return { kind: "skip", reason: problem };
      throw err;
    }
    if (file.kind === "not_modified") return { kind: "not_modified" };

    if (listing.kind === "page") {
      if (file.kind !== "html") return { kind: "skip", reason: `${ref.url} is no longer a page.` };
      const page = parseUscisPage(file.html);
      if (!page) throw new LibraryLayoutError(file.response.url, "no article on the TRIG page");
      return {
        kind: "document",
        document: {
          externalId: ref.externalId,
          docType: "web_guidance",
          title: page.title ?? listing.title ?? ref.externalId,
          citations: [],
          agency: USCIS_AGENCY,
          publishedDate: parseStatedDate(page.reviewedDateText),
          precedentialStatus: "not_applicable",
          officialUrl: file.response.url,
          text: htmlToDocumentText(page.articleHtml),
          metadata: {
            topic: "Terrorism-related inadmissibility grounds (TRIG) exemptions",
            linkedDocuments: listing.links.map((l) => ({ exemption: l.section, title: l.title, url: l.url })),
            statedDates: page.reviewedDateText ? { lastReviewedUpdated: page.reviewedDateText } : {},
          },
          fetch: { response: file.response },
        },
      };
    }

    if (file.kind !== "pdf") return { kind: "skip", reason: `${file.response.url} answered ${file.response.contentType || "an unknown type"}, not a PDF.` };
    const pdf = file.pdf;
    const text = pdf.pagesWithText > 0 ? pdf.text : "";
    const header = parseMemoHeader(text);
    const titleDate = WRITTEN_DATE.exec(listing.title)?.[0] ?? null;
    const isAuthority = /\bExercises? of (?:INA )?(?:Exemption )?Authority\b/i.test(listing.title);
    const isMemo = !isAuthority && /\b(?:Implementation Memo(?:randum)?|Policy Memorandum|Implementation of)\b/i.test(listing.title);
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: isAuthority ? "notice" : isMemo ? "policy_memorandum" : "other",
        title: listing.title,
        citations: header.number ? [header.number] : [],
        // An exercise of authority is the Secretaries' act, not USCIS's; USCIS only publishes it.
        agency: isAuthority ? null : USCIS_AGENCY,
        publishedDate: parseStatedDate(titleDate) ?? parseStatedDate(header.dateText),
        precedentialStatus: "not_applicable",
        officialUrl: ref.url,
        originalUrl: file.response.url !== ref.url ? file.response.url : null,
        text,
        textKind: text ? "full" : "none",
        metadata: {
          topic: "Terrorism-related inadmissibility grounds (TRIG) exemptions",
          documentKind: isAuthority ? "Exercise of authority" : isMemo ? "Implementation memorandum" : "Linked document",
          exemptions: listing.sections,
          linkedFrom: listing.linkedFrom,
          ...(header.number ? { memoNumber: header.number } : {}),
          ...(header.subject ? { subject: header.subject } : {}),
          statedDates: { ...(titleDate ? { asLinked: titleDate } : {}), ...(header.dateText ? { issued: header.dateText } : {}) },
          pageCount: pdf.pageCount,
          ...(pdf.pagesWithText === 0 ? { textNote: "The PDF has no text layer (a scan); no OCR is run." } : {}),
        },
        original: pdfOriginal(file.response),
        fetch: { response: file.response, extraction: pdfExtraction(pdf) },
      },
    };
  },
};
