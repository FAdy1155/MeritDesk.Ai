import { extractPdfText } from "../../extract/pdf";
import { LibraryLayoutError, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { fetchFileText, fileFields, fileMetadata, fingerprintOf } from "./files";
import { crosswalkChapters, crosswalkParts, crosswalkPrecedence, crosswalkUpdated, parseAfmLinks, parsePolicyManualParts, parsePolicyManualVolumes } from "./parse";

// The retired Adjudicator's Field Manual, in the form USCIS still publishes
// it: USCIS retired the AFM in May 2020 and moved each chapter it has not
// yet folded into the Policy Manual, as a PDF ("AFM Chapter 10 - An Overview
// of the Adjudication Process (External)"), to the Policy Manual Part that
// will absorb it. USCIS's "Adjudicator's Field Manual Transition" crosswalk
// (a PDF, CROSSWALK_URL) names the remaining chapters and those Parts.
//
// - The crosswalk is read first; the Parts it names are found among the
//   links of the Policy Manual's volume pages (never built from the names),
//   and each Part page's "AFM Chapter" PDF links are the documents. A
//   chapter linked from several Parts is one document, with every Part noted.
// - Daily: the crosswalk is fetched conditionally; when it is unchanged
//   since the last complete daily run nothing else is read (USCIS updates
//   it whenever it moves AFM content). Backfill reads everything in one
//   chunk: about forty pages at uscis.gov's 10-second Crawl-delay.
// - The crosswalk itself is held too, as the AFM's transition notice.
//
// Earlier full editions of the AFM are not on uscis.gov (and robots.txt
// disallows its /sites/default/files/archive/ folder), so they are not
// collected. US government work: public domain, stored in full.

const CROSSWALK_URL = "https://www.uscis.gov/sites/default/files/document/policy-manual-afm/afm-pmcrosswalk.pdf";
const POLICY_MANUAL_URL = "https://www.uscis.gov/policy-manual";
const HOSTS = ["www.uscis.gov", "uscis.gov"] as const;
const AGENCY = "U.S. Citizenship and Immigration Services";

type Listing = {
  kind: "chapter" | "crosswalk";
  label: string;
  chapter: string | null;
  parts: { key: string; url: string }[];
  crosswalkUpdated: string | null;
  crosswalkPrecedence: string | null;
};

async function listFromCrosswalk(ctx: LibraryAdapterContext, crosswalkText: string): Promise<DocumentRef[]> {
  const parts = crosswalkParts(crosswalkText);
  const chapters = crosswalkChapters(crosswalkText);
  const updated = crosswalkUpdated(crosswalkText);
  const precedence = crosswalkPrecedence(crosswalkText);
  if (parts.length === 0 || chapters.length === 0) throw new LibraryLayoutError(CROSSWALK_URL, "no chapters or Policy Manual Parts in the crosswalk");

  // The Policy Manual index links the volumes; each volume page links its Parts.
  const index = await ctx.http.getText(POLICY_MANUAL_URL, { expect: "html" });
  const volumes = parsePolicyManualVolumes(index.text, index.response.url, HOSTS);
  const partUrls = new Map<string, string>();
  for (const volume of new Set(parts.map((p) => p.volume))) {
    const volumeUrl = volumes.get(volume);
    if (!volumeUrl) {
      ctx.note(`The Policy Manual index no longer links Volume ${volume}; its Parts were not read.`);
      continue;
    }
    const page = await ctx.http.getText(volumeUrl, { expect: "html" });
    for (const [key, url] of parsePolicyManualParts(page.text, page.response.url, HOSTS)) if (!partUrls.has(key)) partUrls.set(key, url);
  }

  const byPdf = new Map<string, { label: string; chapter: string | null; parts: { key: string; url: string }[] }>();
  for (const part of parts) {
    const key = `${part.volume}-${part.part}`;
    const url = partUrls.get(key);
    if (!url) {
      ctx.note(`Volume ${part.volume}, Part ${part.part} (named in the AFM crosswalk) is not linked from its volume page; it was not read.`);
      continue;
    }
    const page = await ctx.http.getText(url, { expect: "html" });
    for (const link of parseAfmLinks(page.text, page.response.url, HOSTS)) {
      const entry = byPdf.get(link.url) ?? { label: link.label, chapter: link.chapter, parts: [] };
      if (!entry.parts.some((p) => p.key === key)) entry.parts.push({ key, url: page.response.url });
      byPdf.set(link.url, entry);
    }
  }
  if (byPdf.size === 0) throw new LibraryLayoutError(POLICY_MANUAL_URL, "no AFM chapter links on the Policy Manual Parts the crosswalk names");
  const missing = chapters.filter((c) => ![...byPdf.values()].some((e) => e.chapter === c));
  if (missing.length) ctx.note(`The crosswalk names AFM chapter(s) ${missing.join(", ")}, but no Part page it names links them.`);

  const refs: DocumentRef[] = [...byPdf.entries()].map(([url, e]) => {
    const listing: Listing = { kind: "chapter", label: e.label, chapter: e.chapter, parts: e.parts, crosswalkUpdated: updated, crosswalkPrecedence: precedence };
    return {
      externalId: new URL(url).pathname,
      url,
      title: e.label,
      fingerprint: fingerprintOf(e.label, url, e.parts.map((p) => p.key).sort().join(","), updated),
      listing,
    };
  });
  const crosswalk: Listing = { kind: "crosswalk", label: "Adjudicator's Field Manual Transition", chapter: null, parts: [], crosswalkUpdated: updated, crosswalkPrecedence: precedence };
  refs.push({ externalId: new URL(CROSSWALK_URL).pathname, url: CROSSWALK_URL, title: crosswalk.label, fingerprint: fingerprintOf("crosswalk", updated), listing: crosswalk });
  return refs;
}

async function crosswalkText(ctx: LibraryAdapterContext, conditional: boolean): Promise<string | null> {
  if (conditional) {
    const listed = await ctx.http.getListing(CROSSWALK_URL, { expect: "pdf" });
    if (listed.unchanged) return null;
    return (await extractPdfText(listed.response.body)).text;
  }
  const response = await ctx.http.get(CROSSWALK_URL, { expect: "pdf" });
  return (await extractPdfText(response.body)).text;
}

export const uscisAfmAdapter: LibrarySourceAdapter = {
  code: "uscis_adjudicators_field_manual",
  group: "other-agency-guidance",
  name: "Adjudicator's Field Manual, remaining chapters (USCIS, retired)",
  description:
    "The chapters of USCIS's retired Adjudicator's Field Manual that USCIS still publishes as PDFs on the Policy Manual Parts that will absorb them, with USCIS's AFM transition crosswalk.",
  coverage:
    "Every remaining AFM chapter the crosswalk names and its Policy Manual Parts link, and the crosswalk itself; the full pre-2020 AFM is no longer published on uscis.gov and is not held.",
  cadence: "Daily (when USCIS updates the crosswalk)",
  officialUrl: CROSSWALK_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 90,

  async listUpdates(ctx) {
    const text = await crosswalkText(ctx, true);
    if (text === null) {
      ctx.note("The AFM crosswalk is unchanged since the last complete run; the Policy Manual Parts were not read again.");
      return { refs: [] };
    }
    return { refs: await listFromCrosswalk(ctx, text) };
  },

  async backfill(ctx) {
    const text = (await crosswalkText(ctx, false)) ?? "";
    const refs = await listFromCrosswalk(ctx, text);
    return { refs, nextCursor: null, progress: `${refs.length - 1} remaining AFM chapter PDF(s) and the crosswalk` };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.kind) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const file = await fetchFileText(ctx, ref.url, ref.known);
    if (file === "not_modified") return { kind: "not_modified" };
    const title = listing.kind === "crosswalk" ? "Adjudicator's Field Manual Transition (crosswalk to the USCIS Policy Manual)" : listing.label.replace(/\s*\(External\)\s*$/i, "");
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: listing.kind === "crosswalk" ? "notice" : "manual_section",
        title,
        citations: listing.chapter ? [`AFM Chapter ${listing.chapter}`] : [],
        agency: AGENCY,
        precedentialStatus: "not_applicable",
        ...fileFields(file),
        metadata: {
          manual: "Adjudicator's Field Manual (retired)",
          ...(listing.chapter ? { chapter: listing.chapter } : {}),
          linkLabel: listing.label,
          ...(listing.parts.length ? { policyManualParts: listing.parts.map((p) => p.url) } : {}),
          ...(listing.crosswalkPrecedence ? { crosswalkPrecedence: listing.crosswalkPrecedence } : {}),
          statedDates: listing.crosswalkUpdated ? { crosswalkLastUpdated: listing.crosswalkUpdated } : {},
          ...fileMetadata(file),
        },
      },
    };
  },
};
