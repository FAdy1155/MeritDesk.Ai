import type { LibraryGroupCode } from "../../groups";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibraryDocType,
  type LibraryHttpResponse,
  type LibrarySourceAdapter,
} from "../../types";
import { parseUscDownloadPage, type UscDownloadPage, type UscTitleDownload } from "./parse";
import { sharedFile, type SharedFile } from "./run-cache";
import {
  inaSectionFromSourceCredit,
  listUslmSections,
  readUslmSection,
  readUslmTitleMeta,
  sectionNumbers,
  uslmSectionFingerprint,
  type UslmSection,
  type UslmSectionEntry,
  type UslmTitleMeta,
} from "./uslm";
import { readZipEntry, zipEntries } from "./zip";

// The United States Code as the Office of the Law Revision Counsel of the
// U.S. House of Representatives publishes it: each title's USLM XML, in the
// ZIP the OLRC's download page links for the current release point
// (https://uscode.house.gov/download.html). One request per title
// per run brings the whole title; every section is one document, with its
// statutory and editorial notes (the uncodified provisions Congress enacted
// with it are set out there) and its source credit.
//
// - Daily: the download page with a conditional request (it changes when a
//   new release point is posted); when it changed, the title's ZIP, and
//   every section listed with a fingerprint of its text, so only sections
//   whose text changed are stored again.
// - Backfill: the title of the current release point, CHUNK sections per
//   chunk; every section is read from memory, so a chunk takes seconds.
// - Each section's link is the OLRC's permanent address for the section in
//   the current edition, https://uscode.house.gov/us/usc/t<title>/s<section>/,
//   which redirects to the current release point's page. It is formed from
//   the section's USLM identifier exactly as the OLRC's own Cite Checker
//   (https://uscode.house.gov/cite.html) forms it.
// - Prior release points (https://uscode.house.gov/priorreleasepoints.html)
//   are not collected: the library keeps the current Code and, from the day
//   collection starts, the earlier text of every section it changes
//   (library_document_versions).
//
// The U.S. Code is a work of the United States government: public domain,
// stored in full.

const DOWNLOAD_PAGE = "https://uscode.house.gov/download.html";
const HOSTS = ["uscode.house.gov"] as const;
const CHUNK = 500;
/** The largest title collected (Title 18) is about 12 MB of XML in a 2 MB ZIP. */
const MAX_ZIP_BYTES = 40 * 1024 * 1024;
const MAX_XML_BYTES = 120 * 1024 * 1024;
const PUBLISHER = "Office of the Law Revision Counsel, U.S. House of Representatives";

export type UscTitleSpec = {
  code: string;
  group: LibraryGroupCode;
  name: string;
  description: string;
  coverage: string;
  /** The title number as the OLRC writes it ("8", "18", "21"). */
  title: string;
  /** Keep only sections under these identifiers ("/us/usc/t21/ch13"); all sections when absent. */
  within?: readonly string[];
  docType: LibraryDocType;
  /** Read the Immigration and Nationality Act section from each source credit (Title 8). */
  inaParallel: boolean;
};

type TitleFile = {
  zipEntry: string;
  meta: UslmTitleMeta;
  xml: string;
  entries: UslmSectionEntry[];
  byId: Map<string, UslmSectionEntry>;
  sections: Map<string, UslmSection>;
};

type Listing = {
  identifier: string;
  zipUrl: string;
  releasePoint: string | null;
  releasePointText: string | null;
  releasePointDateText: string | null;
};

type Cursor = { release: string | null; offset: number };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && typeof c === "object" && Number.isInteger(c.offset) && c.offset >= 0 && (c.release === null || typeof c.release === "string");
}

function readDownloadPage(html: string, url: string, spec: UscTitleSpec): { page: UscDownloadPage; title: UscTitleDownload } {
  const page = parseUscDownloadPage(html, url);
  if (!page.releasePoint || page.titles.length === 0) throw new LibraryLayoutError(url, "no current release point or no title download links");
  const title = page.titles.find((t) => t.id === `us/usc/t${spec.title}`);
  if (!title) throw new LibraryLayoutError(url, `no XML download link for Title ${spec.title}`);
  return { page, title };
}

function readTitleZip(spec: UscTitleSpec, response: LibraryHttpResponse): TitleFile {
  const entries = zipEntries(response.body).filter((e) => /\.xml$/i.test(e.name));
  if (entries.length !== 1) throw new LibraryLayoutError(response.url, `the ZIP holds ${entries.length} XML files, not one`);
  const xml = readZipEntry(response.body, entries[0], MAX_XML_BYTES).toString("utf8");
  const meta = readUslmTitleMeta(xml);
  if (meta.docNumber !== spec.title) throw new LibraryLayoutError(response.url, `the XML is for title ${meta.docNumber ?? "(none)"}, not Title ${spec.title}`);
  let sections = listUslmSections(xml, spec.title);
  if (spec.within?.length) {
    sections = sections.filter((s) => s.ancestry.some((a) => a.identifier !== null && spec.within!.includes(a.identifier)));
  }
  if (sections.length === 0) throw new LibraryLayoutError(response.url, "no sections in the title's XML");
  return { zipEntry: entries[0].name, meta, xml, entries: sections, byId: new Map(sections.map((s) => [s.identifier, s])), sections: new Map() };
}

function sectionOf(file: TitleFile, entry: UslmSectionEntry): UslmSection {
  let section = file.sections.get(entry.identifier);
  if (!section) {
    section = readUslmSection(file.xml, entry);
    file.sections.set(entry.identifier, section);
  }
  return section;
}

async function loadTitle(
  ctx: LibraryAdapterContext,
  spec: UscTitleSpec,
  zipUrl: string,
  known: DocumentRef["known"]
): Promise<{ notModified: true } | { notModified: false; file: SharedFile<TitleFile> }> {
  return sharedFile(
    ctx,
    `usc:${spec.title}:${zipUrl}`,
    zipUrl,
    known,
    (conditional) => ctx.http.get(zipUrl, { expect: "any", maxBytes: MAX_ZIP_BYTES, timeoutMs: 180_000, conditional }),
    (response) => readTitleZip(spec, response)
  );
}

function headingOf(section: UslmSection): string {
  return (section.heading ?? "").replace(/\s+/g, " ").trim();
}

/** "8 U.S.C. § 1229b (INA § 240A) Cancellation of removal; adjustment of status". */
function titleFor(spec: UscTitleSpec, section: UslmSection, ina: string | null): string {
  const num = (section.numText ?? `§ ${section.numValue ?? ""}`).replace(/\.\s*$/, "").trim();
  return [`${spec.title} U.S.C. ${num}`, ina ? `(INA § ${ina})` : null, headingOf(section) || null].filter(Boolean).join(" ");
}

function refFor(spec: UscTitleSpec, file: TitleFile, entry: UslmSectionEntry, listing: Omit<Listing, "identifier">): DocumentRef {
  const section = sectionOf(file, entry);
  const ina = spec.inaParallel ? inaSectionFromSourceCredit(section.sourceCredit) : null;
  return {
    externalId: entry.identifier,
    url: listing.zipUrl,
    title: titleFor(spec, section, ina),
    fingerprint: uslmSectionFingerprint(section),
    listing: { ...listing, identifier: entry.identifier } satisfies Listing,
  };
}

async function currentRelease(ctx: LibraryAdapterContext, spec: UscTitleSpec, daily: boolean) {
  if (daily) {
    const { unchanged, text, response } = await ctx.http.getListing(DOWNLOAD_PAGE, { expect: "html" });
    if (unchanged) return null;
    return readDownloadPage(text, response.url, spec);
  }
  const { text, response } = await ctx.http.getText(DOWNLOAD_PAGE, { expect: "html" });
  return readDownloadPage(text, response.url, spec);
}

function listingOf(page: UscDownloadPage, title: UscTitleDownload): Omit<Listing, "identifier"> {
  return { zipUrl: title.xmlUrl, releasePoint: page.releasePoint, releasePointText: page.releasePointText, releasePointDateText: page.releasePointDateText };
}

export function createUscTitleAdapter(spec: UscTitleSpec): LibrarySourceAdapter {
  return {
    code: spec.code,
    group: spec.group,
    name: spec.name,
    description: spec.description,
    coverage: spec.coverage,
    cadence: "Checked daily; the OLRC posts a new release point when laws are classified to the Code",
    officialUrl: DOWNLOAD_PAGE,
    hosts: HOSTS,
    license: "public_domain",
    staleAfterHours: 48,
    recheckAfterDays: 60,
    // Every section of a title comes from the one ZIP the run already holds.
    maxDocumentsPerDailyRun: 3000,

    async listUpdates(ctx) {
      const release = await currentRelease(ctx, spec, ctx.mode === "daily");
      if (!release) return { refs: [] };
      const loaded = await loadTitle(ctx, spec, release.title.xmlUrl, null);
      if (loaded.notModified) return { refs: [] };
      const file = loaded.file.value;
      const listing = listingOf(release.page, release.title);
      return { refs: file.entries.map((entry) => refFor(spec, file, entry, listing)) };
    },

    async backfill(ctx, cursor): Promise<BackfillChunk> {
      const release = await currentRelease(ctx, spec, false);
      if (!release) throw new LibraryLayoutError(DOWNLOAD_PAGE, "the download page could not be read");
      let state: Cursor = isCursor(cursor) ? cursor : { release: release.page.releasePoint, offset: 0 };
      if (state.release !== release.page.releasePoint) {
        // A new release point since the walk began: start over on it; sections already stored are skipped by their fingerprints.
        ctx.note(`Release point ${release.page.releasePoint} replaced ${state.release ?? "the one the walk began on"}; the walk restarted on it.`);
        state = { release: release.page.releasePoint, offset: 0 };
      }
      const loaded = await loadTitle(ctx, spec, release.title.xmlUrl, null);
      if (loaded.notModified) throw new LibraryLayoutError(release.title.xmlUrl, "an unconditional request was answered 304");
      const file = loaded.file.value;
      const listing = listingOf(release.page, release.title);
      const slice = file.entries.slice(state.offset, state.offset + CHUNK);
      const next = state.offset + CHUNK;
      return {
        refs: slice.map((entry) => refFor(spec, file, entry, listing)),
        nextCursor: next < file.entries.length ? { release: state.release, offset: next } : null,
        progress: slice.length
          ? `Title ${spec.title} at release point ${release.page.releasePoint}: sections ${state.offset + 1} to ${state.offset + slice.length} of ${file.entries.length}`
          : `Title ${spec.title} at release point ${release.page.releasePoint}: done (${file.entries.length} sections)`,
      };
    },

    async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
      const listing = ref.listing as Listing | undefined;
      if (!listing?.zipUrl || !listing.identifier) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
      const loaded = await loadTitle(ctx, spec, listing.zipUrl, ref.known);
      if (loaded.notModified) return { kind: "not_modified" };
      const { response, value: file } = loaded.file;
      const entry = file.byId.get(listing.identifier);
      if (!entry) return { kind: "skip", reason: `${listing.identifier} is not in Title ${spec.title} as of ${listing.releasePointText ?? "this release point"}.` };
      const section = sectionOf(file, entry);
      const { numbers, range } = sectionNumbers(entry.identifier);
      if (numbers.length === 0) return { kind: "skip", reason: `${entry.identifier} names no section number.` };
      const ina = spec.inaParallel ? inaSectionFromSourceCredit(section.sourceCredit) : null;
      const citations = range ? [] : numbers.map((n) => `${spec.title} U.S.C. § ${n}`);
      if (ina) citations.push(`INA § ${ina}`);
      return {
        kind: "document",
        document: {
          externalId: entry.identifier,
          docType: spec.docType,
          title: titleFor(spec, section, ina),
          citations,
          agency: PUBLISHER,
          precedentialStatus: "not_applicable",
          officialUrl: `https://uscode.house.gov/us/usc/t${spec.title}/s${numbers[0]}/`,
          originalUrl: response.url,
          text: section.text,
          metadata: {
            uscTitle: spec.title,
            identifier: entry.identifier,
            sectionNumbers: numbers,
            ...(range ? { sectionRange: true } : {}),
            numberAsPrinted: section.numText,
            heading: headingOf(section) || null,
            status: section.status,
            hierarchy: entry.ancestry.map((a) => ({ level: a.level, identifier: a.identifier, num: a.num, heading: a.heading })),
            sourceCredit: section.sourceCredit,
            sourceCreditDates: section.sourceCreditDates,
            noteHeadings: section.noteHeadings,
            ...(spec.inaParallel
              ? {
                  inaSection: ina,
                  inaSectionBasis: ina
                    ? "The source credit names the section of the Immigration and Nationality Act (act June 27, 1952, ch. 477) this section was enacted as."
                    : section.sourceCredit
                      ? "The source credit does not open with the Immigration and Nationality Act; this section came from another law."
                      : "The section has no source credit.",
                }
              : {}),
            releasePoint: listing.releasePoint,
            releasePointText: listing.releasePointText,
            publication: file.meta.publicationName,
            positiveLaw: file.meta.positiveLaw === "yes" ? true : file.meta.positiveLaw === "no" ? false : null,
            titleXmlCreated: file.meta.created,
            statedDates: listing.releasePointDateText ? { currentThrough: listing.releasePointDateText } : {},
            linkNote: "The link is the OLRC's address for the section in the current edition of the Code; the text was read from the release point's XML download.",
          },
          original: { bytes: Buffer.from(file.xml.slice(entry.start, entry.end), "utf8"), contentType: "application/xml", extension: "xml" },
          fetch: { response, extraction: { format: "USLM XML", zipEntry: file.zipEntry, sectionXmlSha256: sha256Hex(file.xml.slice(entry.start, entry.end)) } },
        },
      };
    },
  };
}

// --- the three titles the library holds ---------------------------------------

export const olrcUscTitle8Adapter = createUscTitleAdapter({
  code: "olrc_usc_title_8",
  group: "ina-title-8",
  name: "Title 8, U.S. Code: Aliens and Nationality (OLRC)",
  description:
    "Every section of Title 8 of the United States Code, with its statutory and editorial notes and source credit, from the Office of the Law Revision Counsel's XML for the current release point. Sections enacted as part of the Immigration and Nationality Act carry the INA section number their source credit states.",
  coverage:
    "All of Title 8 as of the current OLRC release point (chapters 1 to 16, including repealed, transferred and omitted entries with their notes); the INA section parallel for each section whose source credit names the Act. Earlier release points are not collected.",
  title: "8",
  docType: "statute_section",
  inaParallel: true,
});

export const olrcUscTitle18Adapter = createUscTitleAdapter({
  code: "olrc_usc_title_18",
  group: "criminal-codes",
  name: "Title 18, U.S. Code: Crimes and Criminal Procedure (OLRC)",
  description:
    "Every section of Title 18 of the United States Code, the federal criminal code, with its notes and source credit, from the Office of the Law Revision Counsel's XML for the current release point.",
  coverage: "All of Title 18 (Parts I to V) as of the current OLRC release point; the Title 18 appendix is not collected. Earlier release points are not collected.",
  title: "18",
  docType: "criminal_code_section",
  inaParallel: false,
});

export const olrcUscTitle21ControlledSubstancesAdapter = createUscTitleAdapter({
  code: "olrc_usc_title_21_controlled_substances",
  group: "criminal-codes",
  name: "Title 21, U.S. Code, chapter 13: Drug Abuse Prevention and Control (OLRC)",
  description:
    "The Controlled Substances Act and the Controlled Substances Import and Export Act as classified to chapter 13 of Title 21, including the statutory drug schedules (21 U.S.C. 812) and the federal drug offenses, from the Office of the Law Revision Counsel's XML for the current release point.",
  coverage: "Every section of 21 U.S.C. chapter 13 (subchapters I and II) as of the current OLRC release point. The rest of Title 21 is not collected; the current schedules as amended by rule are in 21 CFR part 1308 (collected separately).",
  title: "21",
  within: ["/us/usc/t21/ch13"],
  docType: "criminal_code_section",
  inaParallel: false,
});
