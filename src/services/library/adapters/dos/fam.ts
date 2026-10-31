import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { anchors, htmlToDocumentText, inlineText, resolveUrl } from "../../extract/html";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import { decodeHtml, parseFamChanges, parseFamSection, parseFamTree, type FamTransmittal } from "./parse";

// The Foreign Affairs Manual's consular volumes, from the State
// Department's public FAM site (fam.state.gov): 9 FAM (Visas), 8 FAM
// (Passports and Consular Reports of Birth Abroad, with U.S. citizenship and
// nationality) and 7 FAM (Consular Affairs), with the appendices the
// volumes' tables of contents link. One document per page the table of
// contents links: a subchapter ("9 FAM 502.1") or an appendix ("7 FAM 200
// Appendix A"), read from its HTML page (a Word export, windows-1252).
//
// - The home page links each volume's table of contents and change list;
//   the table of contents page loads its tree from a JSON endpoint whose
//   address it names; the change list page carries the volume's recent
//   change transmittals (CTs) as a JSON array.
// - Daily: every page of the three volumes. A page's listing fingerprint
//   covers its table-of-contents entry and the volume's newest transmittal,
//   so a new transmittal has every page of that volume checked again with a
//   conditional GET (the site answers 304 for an unchanged page), and
//   nothing is fetched on a day without one.
// - Backfill: 9 FAM, then 8 FAM, then 7 FAM, PAGE_SIZE pages per chunk. The
//   site sets no Crawl-delay, so pages come about a second apart.
// - The public FAM marks redacted pages "[REDACTED]" in its table of
//   contents; they hold what the Department releases, nothing more.
//
// US government work: public domain, stored in full. A manual is not
// precedent: not_applicable.

const HOME_URL = "https://fam.state.gov/";
const HOSTS = ["fam.state.gov"] as const;
const AGENCY = "U.S. Department of State";
const PAGE_SIZE = 80;
/** The consular volumes, in the order backfill walks them. */
const VOLUME_IDS = ["09FAM", "08FAM", "07FAM"] as const;

type Listing = {
  volume: string;
  volumeId: string;
  volumeTitle: string | null;
  tocText: string;
  tocPath: string[];
  volumeNewestTransmittal: string | null;
  tocUrl: string;
};

type Cursor = { volumes: string[]; offset: number };

function isCursor(value: unknown): value is Cursor {
  const c = value as Cursor;
  return Boolean(c) && Array.isArray(c.volumes) && c.volumes.every((v) => typeof v === "string") && Number.isInteger(c.offset) && c.offset >= 0;
}

/** "09FAM" as the manual cites it: "9 FAM". */
function volumeLabel(volumeId: string): string {
  return `${Number(volumeId.slice(0, 2))} FAM`;
}

type VolumeLinks = { id: string; detailsUrl: string; changesUrl: string };

async function readHome(ctx: LibraryAdapterContext): Promise<Map<string, VolumeLinks>> {
  const { text, response } = await ctx.http.getText(HOME_URL, { expect: "html" });
  const out = new Map<string, VolumeLinks>();
  for (const id of VOLUME_IDS) {
    let detailsUrl: string | null = null;
    let changesUrl: string | null = null;
    for (const a of anchors(text)) {
      const url = resolveUrl(a.href, response.url);
      if (!url) continue;
      const path = new URL(url).pathname;
      if (path.toLowerCase() === `/volumes/details/${id.toLowerCase()}`) detailsUrl ??= url;
      if (path.toLowerCase() === `/volumes/changes/${id.toLowerCase()}`) changesUrl ??= url;
    }
    if (detailsUrl && changesUrl) out.set(id, { id, detailsUrl, changesUrl });
  }
  if (out.size === 0) throw new LibraryLayoutError(HOME_URL, "no links to the consular volumes' tables of contents and change lists");
  for (const id of VOLUME_IDS) if (!out.has(id)) ctx.note(`${volumeLabel(id)} is not linked from the FAM home page; it was not read.`);
  return out;
}

type VolumeListing = { refs: DocumentRef[]; title: string | null; newest: FamTransmittal | null };

async function readVolume(ctx: LibraryAdapterContext, links: VolumeLinks): Promise<VolumeListing> {
  const label = volumeLabel(links.id);
  const changes = await ctx.http.getText(links.changesUrl, { expect: "html" });
  const transmittals = parseFamChanges(changes.text);
  if (!transmittals) throw new LibraryLayoutError(links.changesUrl, `no change-transmittal list for ${label}`);
  const cardTitle = /<h4\b[^>]*class=["'][^"']*card-title[^"']*["'][^>]*>([\s\S]*?)<\/h4>/i.exec(changes.text)?.[1];
  const title = cardTitle ? inlineText(cardTitle).replace(new RegExp(`^${label}\\s*`, "i"), "") || null : null;
  // The newest transmittal by its date (the list's own order is by an internal key).
  const newest = [...transmittals].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || b.number.localeCompare(a.number))[0] ?? null;

  const details = await ctx.http.getText(links.detailsUrl, { expect: "html" });
  const apiPath = new RegExp(`["'](/api/Tree/GetTreeByVolumeId\\?Id=${links.id})["']`, "i").exec(details.text)?.[1];
  if (!apiPath) throw new LibraryLayoutError(links.detailsUrl, `the table of contents does not name its tree for ${label}`);
  const treeUrl = resolveUrl(apiPath, details.response.url)!;
  const { data, response } = await ctx.http.getJson<unknown>(treeUrl);
  const tree = parseFamTree(data, links.id, response.url);
  if (!tree || tree.leaves.length === 0) throw new LibraryLayoutError(treeUrl, `no pages in the ${label} table of contents`);
  for (const s of tree.skipped.slice(0, 10)) ctx.note(`${label}: a table-of-contents entry links outside the volume and was left out: ${s}`);

  const refs = tree.leaves.map((leaf): DocumentRef => {
    const listing: Listing = {
      volume: label,
      volumeId: links.id,
      volumeTitle: title,
      tocText: leaf.text,
      tocPath: leaf.path,
      volumeNewestTransmittal: newest ? `${newest.number}${newest.date ? ` (${newest.date})` : ""}` : null,
      tocUrl: links.detailsUrl,
    };
    return {
      externalId: leaf.id,
      url: leaf.url,
      title: `${label} ${leaf.text}`,
      fingerprint: sha256Hex([links.id, leaf.text, leaf.url, newest?.number ?? "", newest?.date ?? ""].join("\u0000")).slice(0, 32),
      listing,
    };
  });
  return { refs, title, newest };
}

export const dosFamAdapter: LibrarySourceAdapter = {
  code: "dos_fam_consular",
  group: "foreign-affairs-manual",
  name: "Foreign Affairs Manual, consular volumes (State Department)",
  description:
    "The State Department's Foreign Affairs Manual volumes on visas (9 FAM), passports and U.S. citizenship and nationality (8 FAM) and consular affairs (7 FAM), one document per subchapter or appendix, from the public FAM site.",
  coverage:
    "Every subchapter and appendix the public tables of contents of 9 FAM, 8 FAM and 7 FAM link (about 380 pages when this collector was written; 9 FAM's public table of contents links no appendices). Redacted pages hold only what the public site shows.",
  cadence: "Daily",
  officialUrl: HOME_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 30,

  async listUpdates(ctx) {
    const home = await readHome(ctx);
    const refs: DocumentRef[] = [];
    for (const id of VOLUME_IDS) {
      const links = home.get(id);
      if (links) refs.push(...(await readVolume(ctx, links)).refs);
    }
    return { refs };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const home = await readHome(ctx);
    const state: Cursor = isCursor(cursor) ? cursor : { volumes: [...VOLUME_IDS], offset: 0 };
    const id = state.volumes[0];
    if (id === undefined) return { refs: [], nextCursor: null, progress: "every consular volume is done" };
    const rest = state.volumes.slice(1);
    const links = home.get(id);
    if (!links) {
      ctx.note(`${id} is no longer linked from the FAM home page; it was skipped.`);
      return { refs: [], nextCursor: rest.length ? { volumes: rest, offset: 0 } : null, progress: `${id} skipped` };
    }
    const { refs: all } = await readVolume(ctx, links);
    const refs = all.slice(state.offset, state.offset + PAGE_SIZE);
    const nextOffset = state.offset + PAGE_SIZE;
    const nextCursor: Cursor | null = nextOffset < all.length ? { volumes: state.volumes, offset: nextOffset } : rest.length ? { volumes: rest, offset: 0 } : null;
    return {
      refs,
      nextCursor,
      progress: `${volumeLabel(id)}, pages ${Math.min(state.offset + 1, all.length)} to ${state.offset + refs.length} of ${all.length}; ${rest.length} more volume(s) after this one`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.volume || !listing.tocText) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    // The site's servers each give the same file a different ETag (a mismatched
    // If-None-Match answers 200 even when the file is unchanged), so only the
    // Last-Modified date, which they agree on, is sent back.
    const response = await ctx.http.get(ref.url, { expect: "html", conditional: ref.known ? { ...ref.known, etag: null } : null });
    if (response.notModified) return { kind: "not_modified" };
    const html = decodeHtml(response.body, response.charset);
    const page = parseFamSection(html);
    if (!page) throw new LibraryLayoutError(response.url, "not a FAM page (no Word section body)");
    const text = htmlToDocumentText(page.bodyHtml);
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "manual_section",
        title: page.title ?? `${listing.volume} ${listing.tocText}`,
        citations: page.citation ? [page.citation] : [],
        agency: AGENCY,
        publishedDate: parseStatedDate(page.transmittalDateText),
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        text,
        textKind: text ? "full" : "none",
        metadata: {
          manual: "Foreign Affairs Manual",
          volume: listing.volume,
          ...(listing.volumeTitle ? { volumeTitle: listing.volumeTitle } : {}),
          ...(page.citation ? { section: page.citation } : {}),
          ...(page.heading ? { sectionHeading: page.heading } : {}),
          ...(page.chapter ? { chapter: page.chapter } : {}),
          tableOfContents: [...listing.tocPath, listing.tocText],
          ...(/\[REDACTED\]/i.test(listing.tocText) ? { redactedInPublicVersion: true } : {}),
          ...(page.transmittal ? { changeTransmittal: page.transmittal } : {}),
          ...(page.officeOfOrigin ? { officeOfOrigin: page.officeOfOrigin } : {}),
          statedDates: page.ctLine ? { changeTransmittal: page.ctLine } : {},
          ...(listing.volumeNewestTransmittal ? { volumeNewestTransmittalWhenListed: listing.volumeNewestTransmittal } : {}),
          tableOfContentsPage: listing.tocUrl,
        },
        fetch: { response },
      },
    };
  },
};
