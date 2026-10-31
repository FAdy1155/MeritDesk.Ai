import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText } from "../../extract/html";
import { LibraryLayoutError, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { parseManualPage, parseManualToc } from "./parse";

// The AAO Practice Manual: the AAO's rules, procedures and recommendations
// for practice before it, a Drupal book on uscis.gov. Its Table of Contents
// links seven chapters and the Table of Changes; the book's front page
// ("About the Administrative Appeals Office Practice Manual") is the manual's
// own address. Each page is one document: its body field, footnotes
// included (the chapter's citations are in them), and its "Last
// Reviewed/Updated" date.
//
// - Daily and backfill: the Table of Contents and the front page, nine pages
//   in all. The contents list says nothing about a page's changes, so every
//   page is listed each day (no fingerprint) and fetched with a conditional
//   GET (uscis.gov answers 304 for an unchanged page); a page whose text and
//   facts are unchanged is only marked checked.
//
// US government work: public domain, stored in full.

const MANUAL_URL = "https://www.uscis.gov/administrative-appeals/aao-practice-manual";
const TOC_URL = "https://www.uscis.gov/administrative-appeals/aao-practice-manual/table-of-contents";
const HOSTS = ["www.uscis.gov"] as const;
const MANUAL_NAME = "AAO Practice Manual";

async function listAll(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await ctx.http.getText(TOC_URL, { expect: "html" });
  const links = parseManualToc(text, response.url);
  if (!links.some((l) => /^Chapter\s+\d+/i.test(l.title))) throw new LibraryLayoutError(TOC_URL, "no chapter links in the table of contents");
  const refs: DocumentRef[] = [{ externalId: new URL(MANUAL_URL).pathname, url: MANUAL_URL, title: MANUAL_NAME, listing: { tocTitle: MANUAL_NAME } }];
  for (const link of links) {
    const url = new URL(link.url);
    if (url.hostname !== "www.uscis.gov" || !url.pathname.startsWith(new URL(MANUAL_URL).pathname)) {
      ctx.note(`The table of contents links ${link.url} outside the manual; it was left out.`);
      continue;
    }
    refs.push({ externalId: url.pathname, url: `${url.origin}${url.pathname}`, title: link.title, listing: { tocTitle: link.title } });
  }
  return refs;
}

export const uscisAaoPracticeManualAdapter: LibrarySourceAdapter = {
  code: "uscis_aao_practice_manual",
  group: "aao-decisions",
  name: "AAO Practice Manual (USCIS)",
  description:
    "The Administrative Appeals Office's practice manual: jurisdiction, representation, appeals, motions, certifications, contacting the AAO and resources, with its footnotes and table of changes.",
  coverage: "The manual's front page, every chapter its Table of Contents links (seven) and its Table of Changes, as currently published.",
  cadence: "Daily",
  officialUrl: MANUAL_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,

  async listUpdates(ctx) {
    return { refs: await listAll(ctx) };
  },

  async backfill(ctx) {
    // The manual is published only in its current form: one chunk is all of it.
    const refs = await listAll(ctx);
    return { refs, nextCursor: null, progress: `the manual's ${refs.length} pages` };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const { text, response } = await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const page = parseManualPage(text, response.url);
    if (!page.title || !page.bodyHtml) throw new LibraryLayoutError(ref.url, "no page title or body field");
    // The footnotes' "[^]" links back to the text are navigation, not content.
    const body = page.bodyHtml.replace(/<a\b[^>]*href="#[^"]*"[^>]*>\s*\[\^\]\s*<\/a\s*>/gi, "");
    const bodyText = htmlToDocumentText(body);
    if (!bodyText) return { kind: "skip", reason: `${ref.url} has an empty body.` };
    const chapter = /^Chapter\s+(\d+)\b/i.exec(page.title)?.[1];
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "manual_section",
        // The manual's name before a page's own title, so a chapter reads as the AAO's and not another manual's.
        title: page.title === MANUAL_NAME ? page.title : `${MANUAL_NAME}, ${page.title}`,
        citations: [],
        agency: "U.S. Citizenship and Immigration Services, Administrative Appeals Office",
        editionDate: parseStatedDate(page.reviewedText),
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        text: `${page.title}\n\n${bodyText}`,
        metadata: {
          manual: MANUAL_NAME,
          pageTitle: page.title,
          ...(chapter ? { chapter: Number(chapter) } : {}),
          statedDates: page.reviewedText ? { lastReviewedUpdated: page.reviewedText } : {},
        },
        fetch: { response },
      },
    };
  },
  // No legalUpdateItem: the legal-update feed follows the USCIS Policy Manual and EOIR's manuals, not this one
  // (docs/LIBRARY.md 2.4); a revised chapter is a new version of its page, which the feed does not report anyway.
};
