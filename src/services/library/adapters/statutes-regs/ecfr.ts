import { parseStatedDate } from "@/services/monitoring/parse/dates";
import type { LibraryGroupCode } from "../../groups";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibraryHttpResponse,
  type LibrarySourceAdapter,
  type UpdateListing,
} from "../../types";
import { amendedDateAt, cfrEntryFingerprint, listEcfrEntries, readEcfrAmendedDates, readEcfrEntry, type CfrEntry, type CfrEntryText, type CfrPartInfo } from "./ecfr-xml";
import { parseEcfrTitles, parseEcfrVersions, type EcfrTitleInfo, type EcfrVersion } from "./parse";
import { makeRoom, once, sharedFile, type SharedFile } from "./run-cache";

// The Code of Federal Regulations as the Electronic Code of Federal
// Regulations (eCFR, kept by the Office of the Federal Register and GPO)
// states it, for a chosen set of titles and parts.
//
// Where each piece comes from, and why:
// - Text: GovInfo's bulk eCFR XML, one file per title
//   (https://www.govinfo.gov/bulkdata/ECFR, its file link read from the
//   bulk listing's JSON). The eCFR's own full-text API
//   (/api/versioner/v1/full/) and its point-in-time pages (/on/) are
//   disallowed for every crawler by https://www.ecfr.gov/robots.txt, and
//   its HTML pages send automated clients to a block page, so the text is
//   read from the bulk file GPO publishes for exactly this use.
// - Change detection and version history: the eCFR versioner API, which
//   robots.txt allows: titles.json (when each title last changed) and
//   versions/title-N.json (every version of every section since the eCFR's
//   point-in-time record began in January 2017, with the date each took
//   effect, whether it was substantive, and removals).
// - Point in time: the date of each version of a section is kept with it
//   (metadata.versions), and the stored text is the version in force on the
//   "amended through" date (AMDDATE) of the bulk file's volume that holds
//   the section; each volume states its own. Earlier versions' text is not
//   collected (the eCFR serves it only through the endpoints robots.txt
//   disallows); from the day collection starts, every change is kept in
//   library_document_versions.
// - Links: each section's eCFR address, https://www.ecfr.gov/current/title-N/section-X
//   (the form the eCFR documents for linking to the current text of a
//   section), and for an appendix the address of its part.
//
// Daily: titles.json, then for each title changed in the last few days the
// versions issued since then (per selected part); when a selected part
// changed, the title's bulk file, and its selected sections listed with a
// fingerprint of their text. Backfill: each title's selected sections,
// CHUNK at a time, all read from the one bulk file.
//
// Federal regulations are works of the United States government: public
// domain, stored in full.

const TITLES_URL = "https://www.ecfr.gov/api/versioner/v1/titles.json";
const HOSTS = ["www.ecfr.gov", "www.govinfo.gov"] as const;
const CHUNK = 400;
/** Title 29 is about 29 MB of XML. */
const MAX_BULK_BYTES = 80 * 1024 * 1024;
/** A daily run looks back this far past its last success: GovInfo posts the bulk file the evening a change is issued. */
const LOOKBACK_DAYS = 3;
/**
 * The eCFR's version record opens with every section as it stood at the end
 * of December 2016 or early in January 2017; a first version dated on or
 * before this day is that opening snapshot, not an amendment.
 */
const RECORD_BEGAN_BY = "2017-01-31";

export type CfrPartSelection = {
  part: string;
  /** Only these subparts ("P"); the whole part when absent. */
  subparts?: readonly string[];
  /** Only these sections ("4.7b"); the whole part when absent. */
  sections?: readonly string[];
};

export type CfrTitleSelection = { title: number; parts: "all" | readonly CfrPartSelection[] };

export type EcfrSpec = {
  code: string;
  group: LibraryGroupCode;
  name: string;
  description: string;
  coverage: string;
  officialUrl: string;
  selections: readonly CfrTitleSelection[];
};

type HeldEntry = { entry: CfrEntry; xml: Buffer; text: CfrEntryText; amendedThrough: string | null };

type TitleFile = {
  /** Each section with its XML, its text and the "amended through" date of the volume it is in. */
  entries: Map<string, HeldEntry>;
  order: string[];
  partInfo: Map<string, CfrPartInfo>;
};

type Listing = { title: number; identifier: string; part: string; xmlUrl: string };

type Cursor = { titles: number[]; offset: number };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && Array.isArray(c.titles) && c.titles.every((t) => Number.isInteger(t)) && Number.isInteger(c.offset) && c.offset >= 0;
}

function selectedParts(sel: CfrTitleSelection): Set<string> | null {
  return sel.parts === "all" ? null : new Set(sel.parts.map((p) => p.part));
}

function inSelection(sel: CfrTitleSelection, part: string, subpart: string | null, identifier: string): boolean {
  if (sel.parts === "all") return true;
  const p = sel.parts.find((x) => x.part === part);
  if (!p) return false;
  if (p.sections?.length && !p.sections.includes(identifier)) return false;
  if (p.subparts?.length && !(subpart && p.subparts.includes(subpart))) return false;
  return true;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function externalIdOf(title: number, identifier: string): string {
  return `${title} CFR ${identifier}`;
}

async function readTitles(ctx: LibraryAdapterContext): Promise<EcfrTitleInfo[]> {
  return once(ctx, "ecfr:titles", async () => {
    const { data } = await ctx.http.getJson<unknown>(TITLES_URL);
    const titles = parseEcfrTitles(data);
    if (!titles?.length) throw new LibraryLayoutError(TITLES_URL, "no titles in the answer");
    return titles;
  });
}

function versionsUrl(title: number, params: Record<string, string>): string {
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `https://www.ecfr.gov/api/versioner/v1/versions/title-${title}.json${query ? `?${query}` : ""}`;
}

/** Every version the versions API lists for the request, following its pages. */
async function readVersions(ctx: LibraryAdapterContext, title: number, params: Record<string, string>): Promise<EcfrVersion[]> {
  const out: EcfrVersion[] = [];
  for (let page = 1; page <= 50; page++) {
    const url = versionsUrl(title, page > 1 ? { ...params, page: String(page) } : params);
    const { data } = await ctx.http.getJson<unknown>(url);
    const parsed = parseEcfrVersions(data);
    if (!parsed) throw new LibraryLayoutError(url, "not a versions answer");
    out.push(...parsed.versions);
    if (!parsed.totalPages || page >= parsed.totalPages) return out;
  }
  ctx.note(`The eCFR versions of title ${title} run past 50 pages; only the first 50 were read.`);
  return out;
}

/** The full version history of a selected part (or, for a title taken whole, of the title), once per run. */
function partHistory(ctx: LibraryAdapterContext, sel: CfrTitleSelection, part: string): Promise<EcfrVersion[]> {
  if (sel.parts === "all") return once(ctx, `ecfr:versions:${sel.title}:*`, () => readVersions(ctx, sel.title, {}));
  return once(ctx, `ecfr:versions:${sel.title}:${part}`, () => readVersions(ctx, sel.title, { part }));
}

/** Versions issued on or after `since` in the selection. */
async function versionsIssuedSince(ctx: LibraryAdapterContext, sel: CfrTitleSelection, since: string): Promise<EcfrVersion[]> {
  const params = { "issue_date[gte]": since };
  const all: EcfrVersion[] = [];
  if (sel.parts === "all") all.push(...(await readVersions(ctx, sel.title, params)));
  else for (const p of sel.parts) all.push(...(await readVersions(ctx, sel.title, { ...params, part: p.part })));
  return all.filter((v) => inSelection(sel, v.part, v.subpart, v.identifier));
}

/** The bulk file's link, from GovInfo's bulk listing of the title. */
async function bulkUrl(ctx: LibraryAdapterContext, title: number): Promise<string> {
  return once(ctx, `ecfr:bulk-url:${title}`, async () => {
    const listingUrl = `https://www.govinfo.gov/bulkdata/json/ECFR/title-${title}`;
    const { data } = await ctx.http.getJson<{ files?: { name?: string; link?: string }[] }>(listingUrl);
    const file = data?.files?.find((f) => f.name === `ECFR-title${title}.xml` && typeof f.link === "string");
    if (!file?.link || !file.link.startsWith("https://www.govinfo.gov/")) throw new LibraryLayoutError(listingUrl, `no ECFR-title${title}.xml link`);
    return file.link;
  });
}

function readBulk(sel: CfrTitleSelection, response: LibraryHttpResponse): TitleFile {
  const xml = response.body.toString("utf8");
  if (!/<DLPSTEXTCLASS>/.test(xml.slice(0, 2000))) throw new LibraryLayoutError(response.url, "not a bulk eCFR XML file");
  const amended = readEcfrAmendedDates(xml);
  const { entries, partInfo } = listEcfrEntries(xml, selectedParts(sel));
  const kept = new Map<string, HeldEntry>();
  const order: string[] = [];
  for (const entry of entries) {
    if (entry.reserved || !inSelection(sel, entry.part, entry.subpart, entry.identifier)) continue;
    if (kept.has(entry.identifier)) continue;
    // Copies, so the title's whole text is not kept alive by slices of it.
    kept.set(entry.identifier, {
      entry,
      xml: Buffer.from(xml.slice(entry.start, entry.end), "utf8"),
      text: readEcfrEntry(xml, entry),
      amendedThrough: amendedDateAt(amended, entry.start),
    });
    order.push(entry.identifier);
  }
  if (kept.size === 0) throw new LibraryLayoutError(response.url, `none of the selected parts of title ${sel.title} has a section`);
  return { entries: kept, order, partInfo };
}

async function loadTitle(
  ctx: LibraryAdapterContext,
  sel: CfrTitleSelection,
  known: DocumentRef["known"]
): Promise<{ notModified: true } | { notModified: false; file: SharedFile<TitleFile>; url: string }> {
  const url = await bulkUrl(ctx, sel.title);
  // A run walks titles one after another; two are held at a time at most.
  const key = `ecfr:bulk:${sel.title}`;
  makeRoom(ctx, "ecfr:bulk:", key, 1);
  const loaded = await sharedFile(
    ctx,
    key,
    url,
    known,
    (conditional) => ctx.http.get(url, { expect: "xml", maxBytes: MAX_BULK_BYTES, timeoutMs: 300_000, conditional }),
    (response) => readBulk(sel, response)
  );
  return loaded.notModified ? loaded : { ...loaded, url };
}

function noteMissingParts(ctx: LibraryAdapterContext, sel: CfrTitleSelection, file: TitleFile): void {
  if (sel.parts === "all") return;
  for (const p of sel.parts) {
    if (![...file.entries.values()].some((e) => e.entry.part === p.part)) ctx.note(`Title ${sel.title} part ${p.part}: no selected section is in the bulk file.`);
    for (const s of p.sections ?? []) if (!file.entries.has(s)) ctx.note(`${sel.title} CFR ${s} is not in the bulk file.`);
  }
}

function refFor(sel: CfrTitleSelection, file: TitleFile, identifier: string, xmlUrl: string): DocumentRef {
  const { entry, text } = file.entries.get(identifier)!;
  return {
    externalId: externalIdOf(sel.title, identifier),
    url: xmlUrl,
    title: `${sel.title} CFR ${text.head}`,
    fingerprint: cfrEntryFingerprint(entry, text),
    listing: { title: sel.title, identifier, part: entry.part, xmlUrl } satisfies Listing,
  };
}

/** The chapter's agency as the heading prints it ("CHAPTER V—EXECUTIVE OFFICE FOR IMMIGRATION REVIEW, DEPARTMENT OF JUSTICE"). */
function agencyOf(entry: CfrEntry): string | null {
  const chapter = entry.ancestry.find((a) => a.type === "chapter")?.head ?? null;
  if (!chapter) return null;
  const at = chapter.indexOf("—");
  return (at >= 0 ? chapter.slice(at + 1) : chapter).trim() || null;
}

export function createEcfrAdapter(spec: EcfrSpec): LibrarySourceAdapter {
  const selectionOf = (title: number) => spec.selections.find((s) => s.title === title) ?? null;

  return {
    code: spec.code,
    group: spec.group,
    name: spec.name,
    description: spec.description,
    coverage: spec.coverage,
    cadence: "Daily",
    officialUrl: spec.officialUrl,
    hosts: HOSTS,
    license: "public_domain",
    staleAfterHours: 48,
    recheckAfterDays: 60,
    // Every section of a title comes from the one bulk file the run already holds.
    maxDocumentsPerDailyRun: 3000,

    async listUpdates(ctx, since): Promise<UpdateListing> {
      const titles = await readTitles(ctx);
      const sinceDay = since ? isoDay(new Date(since.getTime() - LOOKBACK_DAYS * 24 * 3600 * 1000)) : null;
      const refs: DocumentRef[] = [];
      const withdrawn: { externalId: string; reason: string }[] = [];
      for (const sel of spec.selections) {
        const info = titles.find((t) => t.number === sel.title);
        if (!info) throw new LibraryLayoutError(TITLES_URL, `title ${sel.title} is not listed`);
        let changedParts: Set<string> | null = null;
        if (sinceDay) {
          if (info.latest_issue_date && info.latest_issue_date < sinceDay) continue;
          const changed = await versionsIssuedSince(ctx, sel, sinceDay);
          if (changed.length === 0) continue;
          changedParts = new Set(changed.map((v) => v.part));
          // A section whose latest version is a removal is gone from the eCFR.
          const latest = new Map<string, EcfrVersion>();
          for (const v of changed) {
            const seen = latest.get(v.identifier);
            if (!seen || v.date >= seen.date) latest.set(v.identifier, v);
          }
          for (const v of latest.values()) {
            if (v.removed) withdrawn.push({ externalId: externalIdOf(sel.title, v.identifier), reason: `The eCFR records ${v.name.replace(/\s+/g, " ")} as removed effective ${v.date}.` });
          }
        }
        const loaded = await loadTitle(ctx, sel, null);
        if (loaded.notModified) continue;
        const file = loaded.file.value;
        if (!changedParts) noteMissingParts(ctx, sel, file);
        for (const id of file.order) {
          if (changedParts && !changedParts.has(file.entries.get(id)!.entry.part)) continue;
          refs.push(refFor(sel, file, id, loaded.url));
        }
      }
      return { refs, withdrawn };
    },

    async backfill(ctx, cursor): Promise<BackfillChunk> {
      const state: Cursor = isCursor(cursor) ? cursor : { titles: spec.selections.map((s) => s.title), offset: 0 };
      const title = state.titles[0];
      if (title === undefined) return { refs: [], nextCursor: null, progress: "every selected title is done" };
      const rest = state.titles.slice(1);
      const sel = selectionOf(title);
      if (!sel) {
        ctx.note(`Title ${title} is no longer selected; it was skipped.`);
        return { refs: [], nextCursor: rest.length ? { titles: rest, offset: 0 } : null };
      }
      const loaded = await loadTitle(ctx, sel, null);
      if (loaded.notModified) throw new LibraryLayoutError(`GovInfo bulk eCFR title ${title}`, "an unconditional request was answered 304");
      const file = loaded.file.value;
      if (state.offset === 0) noteMissingParts(ctx, sel, file);
      if (state.offset >= file.order.length) {
        // A stale cursor (the title has fewer sections than when the walk began): the title is done.
        return { refs: [], nextCursor: rest.length ? { titles: rest, offset: 0 } : null, progress: `Title ${title}: done (${file.order.length} sections)` };
      }
      const ids = file.order.slice(state.offset, state.offset + CHUNK);
      const next = state.offset + CHUNK;
      return {
        refs: ids.map((id) => refFor(sel, file, id, loaded.url)),
        nextCursor: next < file.order.length ? { titles: state.titles, offset: next } : rest.length ? { titles: rest, offset: 0 } : null,
        progress: `Title ${title}: sections ${state.offset + 1} to ${state.offset + ids.length} of ${file.order.length}; ${rest.length} more title(s) after this one`,
      };
    },

    async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
      const listing = ref.listing as Listing | undefined;
      if (!listing?.identifier || !Number.isInteger(listing.title)) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
      const sel = selectionOf(listing.title);
      if (!sel) return { kind: "skip", reason: `${ref.externalId}: title ${listing.title} is no longer selected.` };
      const loaded = await loadTitle(ctx, sel, ref.known);
      if (loaded.notModified) return { kind: "not_modified" };
      const { response, value: file } = loaded.file;
      const held = file.entries.get(listing.identifier);
      if (!held) return { kind: "skip", reason: `${ref.externalId} is not in the current eCFR text of title ${sel.title} (removed, reserved or moved).` };
      const { entry, text } = held;

      // The version history of this section, and the version in force on its volume's "amended through" date.
      const history = await partHistory(ctx, sel, entry.part);
      const amendedThroughIso = parseStatedDate(held.amendedThrough);
      const mine = history.filter((v) => v.identifier === entry.identifier).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const inForce = [...mine].reverse().find((v) => !amendedThroughIso || v.date <= amendedThroughIso) ?? null;
      // The first version of a section that was already in the CFR when the eCFR's
      // record began carries the record's opening date, not the date its text took effect.
      // (The record can list a section twice on its opening date, with two issue dates.)
      const baseline = inForce !== null && inForce.date === mine[0].date && inForce.date <= RECORD_BEGAN_BY;
      const effectiveDate = inForce && !baseline ? inForce.date : null;
      const part = file.partInfo.get(entry.part) ?? null;

      const citations = entry.kind === "section" ? [`${sel.title} C.F.R. § ${entry.identifier}`] : [`${sel.title} CFR ${entry.identifier}`];
      return {
        kind: "document",
        document: {
          externalId: externalIdOf(sel.title, entry.identifier),
          docType: "regulation_section",
          title: `${sel.title} CFR ${text.head}`,
          citations,
          agency: agencyOf(entry),
          effectiveDate,
          precedentialStatus: "not_applicable",
          officialUrl:
            entry.kind === "section"
              ? `https://www.ecfr.gov/current/title-${sel.title}/section-${entry.identifier}`
              : `https://www.ecfr.gov/current/title-${sel.title}/part-${entry.part}`,
          originalUrl: response.url,
          text: text.text,
          metadata: {
            cfrTitle: sel.title,
            identifier: entry.identifier,
            kind: entry.kind,
            heading: text.subject || null,
            part: entry.part,
            subpart: entry.subpart,
            hierarchy: entry.ancestry.map((a) => ({ level: a.type, n: a.n, heading: a.head })),
            partHeading: part?.head ?? null,
            partAuthority: part?.authority ?? null,
            partSource: part?.source ?? null,
            sourceNote: text.sourceNote,
            ...(text.notes.length ? { editorialNotes: text.notes } : {}),
            amendedThrough: held.amendedThrough,
            currentVersionDate: inForce?.date ?? null,
            versions: mine.map((v) => ({ date: v.date, issueDate: v.issue_date, substantive: v.substantive, removed: v.removed })),
            ...(baseline ? { currentVersionIsRecordStart: true } : {}),
            ...(mine.some((v) => amendedThroughIso && v.date > amendedThroughIso)
              ? { laterVersionsScheduled: mine.filter((v) => amendedThroughIso && v.date > amendedThroughIso).map((v) => v.date) }
              : {}),
            pointInTimeNote:
              "The text is the version in force on the amended-through date. The dates of earlier and scheduled versions come from the eCFR's version record, which begins in January 2017; their text is not stored.",
            statedDates: {
              ...(held.amendedThrough ? { amendedThrough: held.amendedThrough } : {}),
              ...(inForce ? { currentVersion: inForce.date } : {}),
            },
            ...(entry.kind === "appendix" ? { linkNote: "The link opens the appendix's part in the eCFR." } : {}),
          },
          original: { bytes: held.xml, contentType: "application/xml", extension: "xml" },
          fetch: { response, extraction: { format: "GovInfo bulk eCFR XML", element: entry.kind === "section" ? "DIV8" : "DIV9" } },
        },
      };
    },
  };
}

// --- the two collections the library holds ---------------------------------------

/**
 * The immigration parts of the CFR. Title 8 whole; in the other titles, the
 * parts that govern aliens, visas, immigration status, immigration
 * proceedings, immigration-related employment, detention and refugee and
 * unaccompanied-children programs (each checked against the eCFR's
 * structure of the title when this collector was written).
 */
export const IMMIGRATION_REGULATIONS: readonly CfrTitleSelection[] = [
  { title: 8, parts: "all" },
  // DHS: sexual abuse and assault prevention standards for immigration detention and holding facilities.
  { title: 6, parts: [{ part: "115" }] },
  // CBP: electronic passenger and crew arrival and departure manifests (APIS).
  {
    title: 19,
    parts: [
      { part: "4", sections: ["4.7b", "4.64"] },
      { part: "122", sections: ["122.49a", "122.49b", "122.49c", "122.49d", "122.75a", "122.75b"] },
    ],
  },
  // Labor (temporary and permanent foreign labor certification) and SSA (residence and citizenship for SSI).
  { title: 20, parts: [{ part: "655" }, { part: "656" }, { part: "416", subparts: ["P"] }] },
  // State: visas, departure control, nationality, passports, exchange visitors, the Torture Convention in extradition.
  { title: 22, parts: ["40", "41", "42", "46", "50", "51", "53", "62", "95"].map((part) => ({ part })) },
  // Justice: the INS and EOIR subparts of part 0, unfair immigration-related employment practices, OCAHO's rules, alien terrorist removal, trafficking in persons.
  { title: 28, parts: [{ part: "0", subparts: ["S", "U"] }, { part: "44" }, { part: "68" }, { part: "200" }, { part: "1100" }] },
  // Wage and Hour Division enforcement of the H-2A, H-2B, H-1B and related programs.
  { title: 29, parts: ["501", "502", "503", "504", "506", "507"].map((part) => ({ part })) },
  // Public Health Service: medical examination of aliens; Medicaid noncitizen eligibility.
  { title: 42, parts: [{ part: "34" }, { part: "435", sections: ["435.406"] }] },
  // HHS: exchange visitor waivers, alien physicians, refugee resettlement, Cuban/Haitian entrants, unaccompanied children; LSC restrictions on assistance to aliens.
  { title: 45, parts: ["50", "51", "400", "401", "410", "411", "1626"].map((part) => ({ part })) },
];

export const ecfrImmigrationRegulationsAdapter = createEcfrAdapter({
  code: "ecfr_immigration_regulations",
  group: "regulations",
  name: "Immigration regulations (eCFR)",
  description:
    "The immigration parts of the Code of Federal Regulations in titles 6, 8, 19, 20, 22, 28, 29, 42 and 45, section by section as the eCFR states them, with each section's source note and the dates of its versions since 2017. The drug schedules of 21 CFR part 1308 are collected with the federal criminal provisions.",
  coverage:
    "8 CFR whole (chapters I and V); 6 CFR 115; 19 CFR 4.7b, 4.64, 122.49a-122.49d, 122.75a-122.75b; 20 CFR 655, 656 and 416 subpart P; 22 CFR 40, 41, 42, 46, 50, 51, 53, 62 and 95; 28 CFR 0 subparts S and U, 44, 68, 200 and 1100; 29 CFR 501 to 504, 506 and 507; 42 CFR 34 and 435.406; 45 CFR 50, 51, 400, 401, 410, 411 and 1626. Current text only; the dates of each section's versions since January 2017 are kept, not their text.",
  officialUrl: "https://www.ecfr.gov/current/title-8",
  selections: IMMIGRATION_REGULATIONS,
});

export const ecfr21Cfr1308Adapter = createEcfrAdapter({
  code: "ecfr_21_cfr_1308",
  group: "criminal-codes",
  name: "Schedules of controlled substances, 21 CFR part 1308 (eCFR)",
  description:
    "The Drug Enforcement Administration's schedules of controlled substances as they stand in the eCFR, section by section, with each section's source note and the dates of its versions since 2017: the current federal schedules that controlled-substance removability and inadmissibility turn on.",
  coverage: "Every section of 21 CFR part 1308. Current text only; the dates of each section's versions since January 2017 are kept, not their text.",
  officialUrl: "https://www.ecfr.gov/current/title-21/part-1308",
  selections: [{ title: 21, parts: [{ part: "1308" }] }],
});
