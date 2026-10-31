import "server-only";
import { listingHash } from "./diff";
import { bodyText, fetchOfficial, MAX_LISTING_BYTES, type Expected } from "./http";
import { daysBefore, usDate, utcDate } from "./parse/dates";
import {
  eoirFederalRegisterPageUrls,
  interimDecisionGaps,
  parseAgBiaIndex,
  parseEoirFederalRegisterPage,
  parseEoirNotices,
  parseManualLanding,
  parsePolicyManualChanges,
  parsePolicyMemoranda,
  parseVolumePage,
} from "./parse/eoir";
import { federalRegisterQueryUrl, parseFederalRegisterPage } from "./parse/federal-register";
import { parseUscisFormsUpdates, parseUscisPolicyManualUpdates } from "./parse/uscis";
import {
  ca10PagePassedDate,
  courtListing,
  parseCa10List,
  parseCa11Feed,
  parseCa1List,
  parseCa3List,
  parseCa4List,
  parseCa5List,
  parseCa6List,
  parseCa7List,
  parseCa8List,
  parseCa9Feed,
  type CourtParse,
} from "./parse/courts";
import type { SourceDefinition } from "./sources";
import { isAllowedHttpsUrl } from "./text";
import type { LegalUpdateSourceKey, ListingParse, ParsedItem } from "./types";

// One collector per source: fetch the listing page(s) the source section of
// sources.md names, parse them, and return the items with their links
// checked against the source's host lists. A page whose markup the parser no
// longer recognizes fails the check (ListingMarkupError) instead of passing
// for a quiet week. Collectors never write to the database.

export type CollectContext = {
  now: Date;
  /** When this source was last checked successfully; null before its first success. */
  lastSuccessAt: Date | null;
};

export type CollectResult = {
  items: ParsedItem[];
  rowsSeen: number;
  indexUrls: string[];
  indexContentHash: string;
  notes: string[];
};

export class ListingMarkupError extends Error {
  constructor(url: string) {
    super(`The listing at ${url} no longer has the layout the monitor reads (no list, table or feed was found), so nothing from it was used. The parser needs updating.`);
    this.name = "ListingMarkupError";
  }
}

type PageFetcher = (url: string, expect?: Expected) => Promise<string>;

type Collector = (ctx: CollectContext, get: PageFetcher) => Promise<{ parses: { url: string; parse: ListingParse }[]; notes?: string[] }>;

const single =
  (url: string, parse: (html: string, url: string) => ListingParse, expect: Expected = "html"): Collector =>
  async (_ctx, get) => ({ parses: [{ url, parse: parse(await get(url, expect), url) }] });

const court =
  (url: string | ((ctx: CollectContext) => string), parse: (html: string, url: string) => CourtParse, expect: Expected = "html"): Collector =>
  async (ctx, get) => {
    const target = typeof url === "string" ? url : url(ctx);
    return { parses: [{ url: target, parse: courtListing(parse(await get(target, expect), target)) }] };
  };

/** How far back a windowed source looks: a week before its last success, or `firstDays` before its first check. */
function since(ctx: CollectContext, firstDays: number, maxDays: number): Date {
  const from = ctx.lastSuccessAt ? daysBefore(ctx.lastSuccessAt, 7) : daysBefore(ctx.now, firstDays);
  const floor = daysBefore(ctx.now, maxDays);
  return from < floor ? floor : from;
}

const MAX_FEDERAL_REGISTER_PAGES = 5;
const MAX_CA10_PAGES = 6;
const MAX_CA8_DAYS = 21;

const COLLECTORS: Record<Exclude<LegalUpdateSourceKey, "ca2">, Collector> = {
  // sources.md section 1. Both of the two newest volumes are read, so the end
  // of the old volume is still covered when a new one opens.
  eoir_ag_bia_precedent: async (_ctx, get) => {
    const indexUrl = "https://www.justice.gov/eoir/ag-bia-decisions";
    const volumes = parseAgBiaIndex(await get(indexUrl), indexUrl);
    if (volumes.length === 0) throw new ListingMarkupError(indexUrl);
    const parses: { url: string; parse: ListingParse }[] = [];
    for (const volume of volumes.slice(0, 2)) {
      parses.push({ url: volume.url, parse: parseVolumePage(await get(volume.url), volume.url) });
    }
    const currentIds = parses[0].parse.items.map((i) => Number(i.externalId.replace(/\D/g, "")));
    const gaps = interimDecisionGaps(currentIds);
    const notes = gaps.length
      ? [
          `Interim Decision numbers not listed on ${volumes[0].label}: ${gaps.join(", ")}. AAO decisions share the numbering and are not listed there (sources.md); check each on justice.gov before treating it as anything else.`,
        ]
      : [];
    return { parses, notes };
  },
  eoir_policy_memoranda: single("https://www.justice.gov/eoir/policy-manual-eoir/part-V/memoranda/pm", parsePolicyMemoranda),
  eoir_icpm: single("https://www.justice.gov/eoir/policy-manual-eoir/part-II/icpm", (html, url) =>
    parseManualLanding(html, url, "Immigration Court Practice Manual (Policy Manual Part II)")
  ),
  eoir_bia_practice_manual: single("https://www.justice.gov/eoir/policy-manual-eoir/part-III/bia", (html, url) =>
    parseManualLanding(html, url, "BIA Practice Manual (Policy Manual Part III)")
  ),
  eoir_policy_manual_changes: single("https://www.justice.gov/eoir/policy-manual-eoir/part-VII/appendices/o", parsePolicyManualChanges),
  eoir_notices: single("https://www.justice.gov/eoir/notices-and-press-releases", parseEoirNotices),
  eoir_federal_register: async (ctx, get) => {
    const parses: { url: string; parse: ListingParse }[] = [];
    const notes: string[] = [];
    for (const [i, url] of eoirFederalRegisterPageUrls(ctx.now).entries()) {
      try {
        parses.push({ url, parse: parseEoirFederalRegisterPage(await get(url), url) });
      } catch (err) {
        // The prior year's page (read in January only) is a courtesy check.
        if (i === 0) throw err;
        notes.push(`The prior year's page ${url} could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { parses, notes };
  },
  federal_register: async (ctx, get) => {
    const from = utcDate(since(ctx, 14, 120));
    const parses: { url: string; parse: ListingParse }[] = [];
    for (let page = 1; page <= MAX_FEDERAL_REGISTER_PAGES; page++) {
      const url = federalRegisterQueryUrl(from, page);
      const parse = parseFederalRegisterPage(JSON.parse(await get(url, "json")));
      parses.push({ url, parse });
      if (!parse.hasNextPage) break;
      if (page === MAX_FEDERAL_REGISTER_PAGES) {
        parses[0].parse.notes.push(`More than ${MAX_FEDERAL_REGISTER_PAGES} pages of documents since ${from}; the oldest were not read this time.`);
      }
    }
    return { parses, notes: [`Documents published on or after ${from} were read.`] };
  },
  uscis_policy_manual_updates: single("https://www.uscis.gov/policy-manual/updates", parseUscisPolicyManualUpdates),
  uscis_forms_updates: async (_ctx, get) => {
    const parses: { url: string; parse: ListingParse }[] = [];
    for (const url of ["https://www.uscis.gov/forms/forms-updates", "https://www.uscis.gov/forms/forms-updates?page=1"]) {
      parses.push({ url, parse: parseUscisFormsUpdates(await get(url), url) });
    }
    return { parses };
  },
  ca1: court("https://www.ca1.uscourts.gov/opn/search-month", parseCa1List),
  ca3: court("https://www2.ca3.uscourts.gov/recentop/week/recprec.htm", parseCa3List),
  ca4: court("https://www.ca4.uscourts.gov/opinions/recent-opinions/published-only", parseCa4List),
  ca5: court(
    (ctx) =>
      `https://www.ca5.uscourts.gov/opinions?from=${utcDate(since(ctx, 30, 60))}&to=${utcDate(ctx.now)}&type=pub&type=pord&group=flat&pageSize=250`,
    parseCa5List
  ),
  ca6: court("https://www.opn.ca6.uscourts.gov/opinions/opinions.php", parseCa6List),
  ca7: court(
    "https://media.ca7.uscourts.gov/cgi-bin/rssExec.pl?Time=month&Author=any&Case=any&Submit=Submit&OpsOnly=yes",
    parseCa7List
  ),
  // One page per weekday since the last check (sources.md).
  ca8: async (ctx, get) => {
    const parses: { url: string; parse: ListingParse }[] = [];
    const from = since(ctx, 7, MAX_CA8_DAYS);
    for (let day = new Date(ctx.now); day >= from; day = daysBefore(day, 1)) {
      const weekday = day.getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      const url = `https://ecf.ca8.uscourts.gov/cgi-bin/opnByDate.pl?filedDate=${encodeURIComponent(usDate(day))}`;
      parses.push({ url, parse: courtListing(parseCa8List(await get(url))) });
    }
    return { parses };
  },
  ca9: court("https://www.ca9.uscourts.gov/opinions/index.xml", parseCa9Feed, "xml"),
  // Newest first, all decisions; read pages until they pass the window (sources.md).
  ca10: async (ctx, get) => {
    const parses: { url: string; parse: ListingParse }[] = [];
    const from = utcDate(since(ctx, 7, 45));
    for (let page = 0; page < MAX_CA10_PAGES; page++) {
      const url = `https://www.ca10.uscourts.gov/opinion/search/results?query=date%3Athisweek&page=${page}`;
      const parsed = parseCa10List(await get(url), url);
      parses.push({ url, parse: courtListing(parsed) });
      if (ca10PagePassedDate(parsed, from)) break;
    }
    return { parses };
  },
  ca11: court("https://media.ca11.uscourts.gov/opinions/rss/pubopnsfeed.php", parseCa11Feed, "xml"),
};

/** Notes that differ only in their leading count (one per page read) become one note with the total. */
function mergeCountNotes(notes: string[]): string[] {
  const totals = new Map<string, number>();
  const out: string[] = [];
  for (const note of notes) {
    const m = /^(\d+) (.+)$/.exec(note);
    if (!m) {
      out.push(note);
      continue;
    }
    if (!totals.has(m[2])) out.push(m[2]);
    totals.set(m[2], (totals.get(m[2]) ?? 0) + Number(m[1]));
  }
  return out.map((note) => (totals.has(note) ? `${totals.get(note)} ${note}` : note));
}

/**
 * Collects one source's current listing. Throws OfficialFetchError (fetch
 * refused or failed) or ListingMarkupError (page layout not recognized);
 * the caller records either as the source's failed check.
 */
export async function collectSource(source: SourceDefinition, ctx: CollectContext): Promise<CollectResult> {
  if (source.notCheckedReason) throw new Error(`${source.key} is not collected: ${source.notCheckedReason}`);
  const collector = COLLECTORS[source.key as Exclude<LegalUpdateSourceKey, "ca2">];
  const get: PageFetcher = async (url, expect = "html") =>
    bodyText(await fetchOfficial(url, { allowedHosts: source.indexHosts, expect, maxBytes: MAX_LISTING_BYTES }));
  const { parses, notes: collectorNotes = [] } = await collector(ctx, get);

  for (const { url, parse } of parses) {
    if (!parse.recognized) throw new ListingMarkupError(url);
  }
  const notes = [...collectorNotes, ...mergeCountNotes(parses.flatMap((p) => p.parse.notes))];
  const items: ParsedItem[] = [];
  let offHost = 0;
  for (const { url, parse } of parses) {
    for (const item of parse.items) {
      const linksOk =
        isAllowedHttpsUrl(item.officialUrl, source.documentHosts) &&
        (!item.documentUrl || isAllowedHttpsUrl(item.documentUrl, source.documentHosts));
      if (linksOk) items.push({ ...item, listedOnUrl: url });
      else offHost++;
    }
  }
  if (offHost) notes.push(`${offHost} item(s) linking outside ${source.documentHosts.join(", ")} or not over https were left out.`);
  return {
    items,
    rowsSeen: parses.reduce((n, p) => n + p.parse.rowsSeen, 0),
    indexUrls: parses.map((p) => p.url),
    indexContentHash: listingHash(parses.map((p) => p.parse.indexText).join("\n")),
    notes: [...new Set(notes)],
  };
}
