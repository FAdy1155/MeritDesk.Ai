import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText } from "../../extract/html";
import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { cachedPage, chunkOf, fetchFileText, fileFields, fileMetadata, fingerprintOf } from "./common";
import { parseIerLetters, parseJmChapters, parseJmSections, pathId, yearOf, type IerLetter } from "./parse";

// Department of Justice guidance on justice.gov:
//
// - The Justice Manual's immigration chapters: the chapters its book
//   navigation lists whose titles concern immigration (4-7.000 Immigration
//   Litigation, 9-72.000 and 9-73.000 on visa and immigration offenses, as
//   of writing). Each numbered section ("4-7.010") is one document, cut
//   from its chapter page at the section's heading; the "[updated Month
//   YYYY]" line DOJ prints under a section is kept, as its year.
// - The Civil Rights Division's Immigrant and Employee Rights Section
//   (IER) technical assistance letters, the letters IER publishes in answer
//   to employers' and others' questions about the INA's anti-discrimination
//   provision (8 U.S.C. 1324b), Form I-9 and E-Verify. Each letter is its
//   PDF; many older ones are scans with no text layer, held with their
//   date, subject and link.
//
// justice.gov's robots.txt asks for 10 seconds between requests. US
// government work: public domain, stored in full.

const HOSTS = ["www.justice.gov", "justice.gov"] as const;
const JM_INDEX_URL = "https://www.justice.gov/jm/justice-manual";
const IER_LETTERS_URL = "https://www.justice.gov/crt/technical-assistance-letters";
const JM_CHAPTER = /immigra|\balien|naturaliz|\bvisa|passport|citizenship/i;

type SectionListing = { chapterUrl: string; chapterLabel: string; number: string; title: string };

async function jmRefs(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await cachedPage(ctx, JM_INDEX_URL);
  const chapters = parseJmChapters(text, response.url);
  if (chapters.length < 20) throw new LibraryLayoutError(JM_INDEX_URL, "the book navigation lists too few chapters");
  const wanted = chapters.filter((c) => JM_CHAPTER.test(c.label));
  if (wanted.length === 0) throw new LibraryLayoutError(JM_INDEX_URL, "no immigration chapters in the book navigation");
  const refs: DocumentRef[] = [];
  for (const chapter of wanted) {
    const { text: page, response: pageResponse } = await cachedPage(ctx, chapter.url);
    const { sections } = parseJmSections(page);
    if (sections.length === 0) throw new LibraryLayoutError(chapter.url, "no numbered section headings in the chapter body");
    for (const s of sections) {
      refs.push({
        externalId: `JM ${s.number}`,
        url: pageResponse.url,
        title: `${s.number} - ${s.title}`,
        fingerprint: fingerprintOf(s.number, s.title, htmlToDocumentText(s.html)),
        listing: { chapterUrl: pageResponse.url, chapterLabel: chapter.label, number: s.number, title: s.title } satisfies SectionListing,
      });
    }
  }
  return refs;
}

export const dojJusticeManualAdapter: LibrarySourceAdapter = {
  code: "doj_justice_manual_immigration",
  group: "other-agency-guidance",
  name: "DOJ Justice Manual: immigration chapters",
  description:
    "The sections of the Justice Manual's immigration chapters: immigration litigation in the Civil Division's Office of Immigration Litigation, and the prosecution of immigration, visa and passport offenses.",
  coverage: "Every numbered section of the Justice Manual chapters whose titles concern immigration, visas, passports or naturalization (4-7.000, 9-72.000 and 9-73.000 when this collector was written).",
  cadence: "Daily",
  officialUrl: "https://www.justice.gov/jm/jm-4-7000-immigration-litigation",
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 30,

  async listUpdates(ctx) {
    return { refs: await jmRefs(ctx) };
  },
  async backfill(ctx): Promise<BackfillChunk> {
    const refs = await jmRefs(ctx);
    return { refs, nextCursor: null, progress: `${refs.length} sections` };
  },
  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as SectionListing | undefined;
    if (!listing?.chapterUrl) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const { text, response } = await cachedPage(ctx, listing.chapterUrl);
    const section = parseJmSections(text).sections.find((s) => s.number === listing.number);
    if (!section) return { kind: "skip", reason: `${ref.externalId} is no longer on ${listing.chapterUrl}.` };
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "manual_section",
        title: `Justice Manual ${section.number} - ${section.title}`,
        citations: [`JM ${section.number}`, `Justice Manual ${section.number}`],
        agency: "U.S. Department of Justice",
        documentYear: yearOf(section.updatedText),
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        text: `${section.number} - ${section.title}\n\n${htmlToDocumentText(section.html)}`,
        metadata: {
          chapter: listing.chapterLabel,
          section: section.number,
          ...(section.updatedText ? { statedDates: { updated: section.updatedText } } : {}),
        },
        fetch: { response },
      },
    };
  },
};

type LetterListing = IerLetter;

async function ierRefs(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text, response } = await cachedPage(ctx, IER_LETTERS_URL);
  const at = text.indexOf("field_body");
  const end = text.indexOf("</article>", at);
  const letters = at >= 0 ? parseIerLetters(text.slice(at, end > at ? end : undefined), response.url) : [];
  if (letters.length < 10) throw new LibraryLayoutError(IER_LETTERS_URL, "too few dated letter links in the page body");
  return letters.map((l) => ({
    externalId: pathId(l.url),
    url: l.url,
    title: l.subject ?? l.dateText,
    fingerprint: fingerprintOf(l.dateText, l.subject, l.url, l.topics.join("|")),
    listing: l satisfies LetterListing,
  }));
}

export const dojIerLettersAdapter: LibrarySourceAdapter = {
  code: "doj_ier_technical_assistance_letters",
  group: "other-agency-guidance",
  name: "DOJ Immigrant and Employee Rights Section technical assistance letters",
  description:
    "Letters in which the Civil Rights Division's Immigrant and Employee Rights Section answers questions about the INA's anti-discrimination provision, Form I-9 verification, E-Verify and citizenship or immigration status in hiring.",
  coverage: "Every letter linked from IER's technical assistance letters page, by topic (letters from 2009 on, as IER lists them); scanned letters without a text layer are held with their date, subject and link.",
  cadence: "Daily",
  officialUrl: IER_LETTERS_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 24 * 7,
  recheckAfterDays: 90,

  async listUpdates(ctx) {
    return { refs: await ierRefs(ctx) };
  },
  async backfill(ctx, cursor): Promise<BackfillChunk> {
    // justice.gov: 10 seconds a request, and the media links redirect once, so about 40 letters per chunk.
    const { items, nextCursor, progress } = chunkOf(await ierRefs(ctx), cursor, 40);
    return { refs: items, nextCursor, progress };
  },
  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as LetterListing | undefined;
    if (!listing?.dateText) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const file = await fetchFileText(ctx, ref.url, ref.known);
    if (file === "not_modified") return { kind: "not_modified" };
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "web_guidance",
        title: `Technical assistance letter of ${listing.dateText}${listing.subject ? `: ${listing.subject}` : ""}`,
        citations: [],
        agency: "U.S. Department of Justice, Civil Rights Division, Immigrant and Employee Rights Section",
        publishedDate: parseStatedDate(listing.dateText),
        precedentialStatus: "not_applicable",
        ...fileFields(file),
        metadata: {
          ...(listing.subject ? { summary: listing.subject, summaryKind: "subject as IER's letters page states it" } : {}),
          topics: listing.topics,
          listedOn: IER_LETTERS_URL,
          statedDates: { letter: listing.dateText },
          ...fileMetadata(file),
        },
      },
    };
  },
};
