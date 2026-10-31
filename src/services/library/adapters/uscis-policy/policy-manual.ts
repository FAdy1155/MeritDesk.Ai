import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { anchors, htmlToDocumentText, resolveUrl } from "../../extract/html";
import { cleanText } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import { bodyText, fingerprintOf, USCIS_AGENCY, USCIS_HOSTS } from "./common";
import { headingLabel, parseBookExport, parsePmPage, sliceElement, type BookNode, type PmUpdate } from "./parse";

// The USCIS Policy Manual: every volume, part and chapter, each read from
// its own page on uscis.gov (the Guidance tab, with the Resources,
// Appendices and Updates tabs and the "Current as of" date).
//
// - Listing: the manual's "Print Manual" export, linked from the Policy
//   Manual's landing page: one page (about 12 MB) holding every volume, part
//   and chapter and the full Updates list. A page's fingerprint hashes its
//   own text in the export and the updates that name it, so a chapter is
//   fetched again only when its text or its update history changes. The
//   daily run lists every page this way (a manual has no "what's new" list
//   that catches unannounced corrections); unchanged pages cost nothing.
// - Backfill: the same pages in the manual's order, PAGE_SIZE per chunk
//   (about 10 seconds a page on uscis.gov). A page added mid-walk is caught
//   by the daily run.
// - Citations: USCIS cites a chapter as "10 USCIS-PM A.4". A page gets the
//   citation only where USCIS itself prints it for that page (the Affected
//   Sections of the updates, and the manual's own cross-references linked
//   to the page); it is never built from the page's numbers.
// - The policy alerts and technical updates themselves are documents of
//   the uscis_policy_manual_updates collector, which also feeds the legal
//   updates; this collector does not.

const LANDING_URL = "https://www.uscis.gov/policy-manual";
const PAGE_SIZE = 90;
/** The export is about 12 MB of HTML; room for it to grow. */
const EXPORT_MAX_BYTES = 64 * 1024 * 1024;

type Listing = {
  depth: number;
  heading: string;
  path: string[];
  citation: string | null;
  /** Updates the export lists for this page: "YYYY-MM-DD header". */
  updates: string[];
};

type Cursor = { offset: number };

function isCursor(value: unknown): value is Cursor {
  return Boolean(value) && Number.isInteger((value as Cursor).offset) && (value as Cursor).offset >= 0;
}

function slugOf(url: string): string {
  return new URL(url).pathname.replace(/^\/policy-manual\//, "");
}

/** The export's URL, from the landing page's "Print Manual" link. */
async function exportUrl(ctx: LibraryAdapterContext): Promise<string> {
  const { text, response } = await ctx.http.getText(LANDING_URL, { expect: "html" });
  const link = anchors(text).find((a) => /^Print Manual$/i.test(a.text) && /\/book\/export\/html\/\d+/.test(a.href));
  const url = link ? resolveUrl(link.href, response.url) : null;
  if (!url) throw new LibraryLayoutError(LANDING_URL, "no Print Manual link to the manual's export");
  return url;
}

/**
 * The citations USCIS prints for each page: the Affected Sections of the
 * updates ("10 USCIS-PM A.4" linked to the chapter), then the manual's own
 * cross-references whose link text is a citation. A page whose
 * cross-references disagree with each other keeps only what the updates say.
 */
function statedCitations(html: string, updates: PmUpdate[], base: string): Map<string, string> {
  const out = new Map<string, string>();
  const key = (url: string | null) => (url ? url.replace(/[#?].*$/, "") : null);
  for (const u of updates) {
    for (const a of u.affected) {
      const k = key(a.url);
      if (k && a.citation && !out.has(k)) out.set(k, a.citation);
    }
  }
  const inline = new Map<string, Set<string>>();
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>\s*(\d{1,2} USCIS-PM(?: [A-Z](?:\.\d{1,2})?)?)\s*<\/a>/g)) {
    const k = key(resolveUrl(m[1], base));
    if (!k || !/\/policy-manual\/volume-/.test(k)) continue;
    const set = inline.get(k) ?? new Set<string>();
    set.add(m[2].replace(/\s+/g, " "));
    inline.set(k, set);
  }
  for (const [k, set] of inline) if (!out.has(k) && set.size === 1) out.set(k, [...set][0]);
  return out;
}

/**
 * Every page the export lists. The daily run reads the export with a
 * conditional GET (getListing): when uscis.gov answers 304, nothing in the
 * manual changed and no page is listed.
 */
async function readManual(ctx: LibraryAdapterContext, daily = false): Promise<DocumentRef[]> {
  const url = await exportUrl(ctx);
  const options = { expect: "html" as const, maxBytes: EXPORT_MAX_BYTES, timeoutMs: 240_000 };
  let html: string;
  let response;
  if (daily) {
    const listing = await ctx.http.getListing(url, options);
    if (listing.unchanged) return [];
    ({ text: html, response } = listing);
  } else {
    response = await ctx.http.get(url, options);
    html = bodyText(response);
  }
  const parsed = parseBookExport(html, response.url);
  if (!parsed.recognized) throw new LibraryLayoutError(url, `only ${parsed.nodes.filter((n) => n.depth === 4).length} chapter pages found in the export`);
  if (parsed.updates.length === 0) throw new LibraryLayoutError(url, "the export's Updates list has no update blocks");
  const citations = statedCitations(html, parsed.updates, response.url);
  const updatesFor = new Map<string, string[]>();
  for (const u of parsed.updates) {
    const line = `${parseStatedDate(u.datetime) ?? u.dateText ?? ""} ${u.header}`;
    for (const a of u.affected) {
      if (!a.url) continue;
      const list = updatesFor.get(a.url) ?? [];
      list.push(line);
      updatesFor.set(a.url, list);
    }
  }
  return parsed.nodes.map((node: BookNode) => {
    const listing: Listing = {
      depth: node.depth,
      heading: node.heading,
      path: node.path,
      citation: citations.get(node.url) ?? null,
      updates: updatesFor.get(node.url) ?? [],
    };
    return {
      externalId: slugOf(node.url),
      url: node.url,
      title: titleFor(node.path),
      fingerprint: fingerprintOf(node.heading, node.url, node.path.join(" > "), node.text, listing.citation, listing.updates.join("\n")),
      listing,
    };
  });
}

/** "USCIS Policy Manual, Volume 10, Part A, Chapter 4 - Adjudication": the volume and part labels, then the page's own heading. */
function titleFor(path: string[]): string {
  if (path.length === 0) return "USCIS Policy Manual";
  const labels = path.slice(0, -1).map(headingLabel);
  return ["USCIS Policy Manual", ...labels, path[path.length - 1]].join(", ");
}

/** The sub-page links a volume or part page lists (its parts or chapters), as text lines. */
function subTreeLines(html: string): string[] {
  const nav = /<nav\b[^>]*class="nav-sub-tree"[^>]*>/i.exec(html);
  if (!nav) return [];
  return anchors(sliceElement(html, nav.index, "nav"))
    .map((a) => a.text)
    .filter(Boolean);
}

export const uscisPolicyManualAdapter: LibrarySourceAdapter = {
  code: "uscis_policy_manual",
  group: "uscis-policy-manual",
  name: "USCIS Policy Manual",
  description:
    "The USCIS Policy Manual, the agency's repository of its immigration policies: every volume, part and chapter as USCIS publishes it, with each page's resources, appendices, update history and the date it is current as of.",
  coverage:
    "Every volume, part and chapter page the manual's Print Manual export lists (12 volumes, about 130 parts and 520 chapters in October 2026). Retired Adjudicator's Field Manual files linked from the parts are not collected here.",
  cadence: "Daily",
  officialUrl: LANDING_URL,
  hosts: USCIS_HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 45,
  // A manual-wide technical update can touch hundreds of chapters; the rest wait for the next day.
  maxDocumentsPerDailyRun: 200,

  async listUpdates(ctx) {
    return { refs: await readManual(ctx, true) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const all = await readManual(ctx);
    const offset = isCursor(cursor) ? cursor.offset : 0;
    if (offset >= all.length) {
      if (offset > 0) ctx.note(`The cursor (offset ${offset}) is past the ${all.length} pages the export lists now; the walk is complete.`);
      return { refs: [], nextCursor: null, progress: "every page is done" };
    }
    const refs = all.slice(offset, offset + PAGE_SIZE);
    const next = offset + refs.length;
    return {
      refs,
      nextCursor: next < all.length ? { offset: next } : null,
      progress: `pages ${offset + 1} to ${next} of ${all.length}, in the manual's order`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    const response = await ctx.http.get(ref.url, { expect: "html", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const html = bodyText(response);
    const page = parsePmPage(html, response.url);
    if (!page.recognized) throw new LibraryLayoutError(response.url, "no Guidance tab on the Policy Manual page");
    const depth = listing?.depth ?? 4;
    const pageUrl = response.url.replace(/[#?].*$/, "");
    // The page's own Updates tab names it in its Affected Sections, with the citation USCIS prints.
    const ownCitation =
      page.updates.flatMap((u) => u.affected).find((a) => a.url && a.url.replace(/[#?].*$/, "") === pageUrl && a.citation)?.citation ??
      listing?.citation ??
      null;
    const guidance = htmlToDocumentText(page.guidanceHtml);
    // A volume page repeats its parts' appendices; they are kept with the parts.
    const appendices = page.appendicesHtml && depth > 2 ? htmlToDocumentText(page.appendicesHtml) : "";
    const subTree = depth < 4 ? subTreeLines(html) : [];
    const text = cleanText(
      [guidance, appendices, subTree.length ? `${depth === 2 ? "Parts" : "Chapters"}:\n${subTree.map((s) => `- ${s}`).join("\n")}` : ""]
        .filter(Boolean)
        .join("\n\n")
    );
    const currentAsOf = parseStatedDate(page.currentAsOf);
    const path = listing?.path ?? [page.title ?? ref.externalId];
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "manual_section",
        title: titleFor(path),
        citations: ownCitation ? [ownCitation] : [],
        agency: USCIS_AGENCY,
        // "Current as of" is the date the page's text is current to: the version date USCIS states.
        publishedDate: currentAsOf,
        precedentialStatus: "not_applicable",
        officialUrl: pageUrl,
        text,
        textKind: text ? "full" : "none",
        metadata: {
          manual: "USCIS Policy Manual",
          level: depth === 2 ? "volume" : depth === 3 ? "part" : "chapter",
          pageTitle: page.title,
          ...(path[0] ? { volume: path[0] } : {}),
          ...(path[1] ? { part: path[1] } : {}),
          ...(path[2] ? { chapter: path[2] } : {}),
          ...(ownCitation ? { citationAsPrinted: ownCitation } : {}),
          statedDates: page.currentAsOf ? { currentAsOf: page.currentAsOf } : {},
          tabCounts: page.counts,
          ...(page.alerts.length ? { alerts: page.alerts } : {}),
          resources: page.resources.slice(0, 300),
          updates: page.updates.map((u) => ({
            title: u.header,
            date: parseStatedDate(u.datetime) ?? parseStatedDate(u.dateText),
            dateText: u.dateText,
            url: u.readMoreUrl,
            affectedSections: u.affected.map((a) => [a.citation, a.title].filter(Boolean).join(" - ")),
          })),
          ...(page.appendicesHtml ? { appendices: [...page.appendicesHtml.matchAll(/<div class="accordion__header[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)].map((m) => htmlToDocumentText(m[1])) } : {}),
          ...(subTree.length ? { subPages: subTree } : {}),
        },
        fetch: { response },
      },
    };
  },
};
