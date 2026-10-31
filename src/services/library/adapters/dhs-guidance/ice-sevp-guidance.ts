import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { fetchFileText, fileFields, fileMetadata, fingerprintOf } from "./files";
import { broadcastHeader, mainElement, parseSevpBroadcasts, parseSevpSchoolsPage } from "./parse";

// The Student and Exchange Visitor Program's guidance, from two ICE pages:
// - the SEVP schools page: the Policy Guidance table (SEVP's interpretive
//   guidance to adjudicators and schools, each with SEVP's own description),
//   the DHS STEM Designated Degree Program lists (current and archived) and
//   the COVID-19 guidance SEVP archived when it ended on May 11, 2023
//   (held, flagged as withdrawn with SEVP's own statement);
// - the What's New page's Broadcast Messages, SEVP's numbered messages to
//   school officials, listed by month from 2016 (each PDF states its date
//   and number at the top). A message the page marks "(Rescinded)" is
//   flagged as withdrawn.
//
// Both pages are read every day (two requests); fingerprints skip what is
// unchanged. Backfill reads the same lists, CHUNK_SIZE documents a chunk,
// newest first as listed. US government work: public domain.

const SCHOOLS_URL = "https://www.ice.gov/sevis/schools";
const WHATS_NEW_URL = "https://www.ice.gov/sevis/whats-new";
const HOSTS = ["www.ice.gov", "ice.gov"] as const;
const AGENCY = "U.S. Immigration and Customs Enforcement, Student and Exchange Visitor Program";
const CHUNK_SIZE = 150;

type Kind = "policy_guidance" | "stem_list" | "covid_archived" | "broadcast_message";

type Listing = {
  kind: Kind;
  title: string;
  description: string | null;
  listedOn: string;
  listedMonth: string | null;
  year: number | null;
  withdrawnReason: string | null;
};

const KIND_LABEL: Record<Kind, string> = {
  policy_guidance: "SEVP policy guidance",
  stem_list: "DHS STEM Designated Degree Program List",
  covid_archived: "SEVP COVID-19 guidance (archived)",
  broadcast_message: "SEVP broadcast message",
};

function ref(kind: Kind, url: string, listing: Omit<Listing, "kind">): DocumentRef {
  const u = new URL(url);
  return {
    externalId: u.pathname,
    url,
    title: listing.title,
    fingerprint: fingerprintOf(kind, listing.title, url, listing.description, listing.listedMonth, listing.withdrawnReason),
    listing: { kind, ...listing },
  };
}

/** Every listed document, newest broadcast messages first, then the schools page's guidance. */
async function listAll(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const out = new Map<string, DocumentRef>();
  const add = (r: DocumentRef) => {
    if (!out.has(r.externalId)) out.set(r.externalId, r);
  };

  const whatsNew = await ctx.http.getText(WHATS_NEW_URL, { expect: "html" });
  const broadcasts = parseSevpBroadcasts(whatsNew.text, whatsNew.response.url, HOSTS);
  if (!broadcasts.recognized || broadcasts.messages.length === 0) throw new LibraryLayoutError(WHATS_NEW_URL, "no Broadcast Messages section with message links");
  for (const m of broadcasts.messages) {
    add(
      ref("broadcast_message", m.url, {
        title: m.title,
        description: null,
        listedOn: `${WHATS_NEW_URL}#broadcast-messages`,
        listedMonth: m.listedMonth,
        year: m.year,
        withdrawnReason: m.rescinded ? "SEVP's What's New page marks this broadcast message (Rescinded)." : null,
      })
    );
  }

  const schools = await ctx.http.getText(SCHOOLS_URL, { expect: "html" });
  const page = parseSevpSchoolsPage(schools.text, schools.response.url, HOSTS);
  if (page.problems.length) throw new LibraryLayoutError(SCHOOLS_URL, page.problems.join("; "));
  if (!page.items.some((i) => i.kind === "policy_guidance")) throw new LibraryLayoutError(SCHOOLS_URL, "no policy guidance links in the Policy Guidance table");
  for (const item of page.items) {
    const existing = out.get(new URL(item.url).pathname);
    if (existing && item.kind === "covid_archived") {
      // A broadcast message SEVP also lists among its archived COVID-19 guidance: kept as the message, flagged as ended.
      const listing = existing.listing as Listing;
      const reason = page.covidNote ?? "SEVP lists this as archived COVID-19 guidance.";
      if (!listing.withdrawnReason) {
        listing.withdrawnReason = reason;
        existing.fingerprint = fingerprintOf(listing.kind, listing.title, existing.url, listing.description, listing.listedMonth, reason);
      }
      continue;
    }
    add(
      ref(item.kind, item.url, {
        title: item.title,
        // The archived COVID-19 list prints a month after each link ("(Mar. 2020)"); the policy guidance table a description.
        description: item.kind === "covid_archived" ? null : item.description,
        listedOn: `${SCHOOLS_URL}#${item.kind === "policy_guidance" ? "policy-guidance" : item.kind === "stem_list" ? "dhs-stem-designated-degree-program-list-and-cip-code-nomination-process" : "nonimmigrant-students-and-sevp-certified-schools-covid-19-archived-guidance"}`,
        listedMonth: item.kind === "covid_archived" && item.description ? item.description.replace(/^\(|\)$/g, "") : null,
        year: null,
        withdrawnReason: item.kind === "covid_archived" ? (page.covidNote ?? "SEVP lists this as archived COVID-19 guidance.") : null,
      })
    );
  }
  return [...out.values()];
}

function isCursor(value: unknown): value is { offset: number } {
  return Boolean(value) && Number.isInteger((value as { offset: number }).offset) && (value as { offset: number }).offset >= 0;
}

export const iceSevpGuidanceAdapter: LibrarySourceAdapter = {
  code: "ice_sevp_guidance",
  group: "other-agency-guidance",
  name: "SEVP policy guidance and broadcast messages (ICE)",
  description:
    "The Student and Exchange Visitor Program's policy guidance, its broadcast messages to school officials, the DHS STEM Designated Degree Program lists and SEVP's archived COVID-19 guidance, from ICE's SEVP pages.",
  coverage:
    "The Policy Guidance table, the current and archived STEM lists and the archived COVID-19 guidance on SEVP's schools page, and every broadcast message SEVP's What's New page lists (January 2016 to the present).",
  cadence: "Daily",
  officialUrl: SCHOOLS_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 60,

  async listUpdates(ctx) {
    return { refs: await listAll(ctx) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const all = await listAll(ctx);
    const offset = isCursor(cursor) ? Math.min(cursor.offset, all.length) : 0;
    const refs = all.slice(offset, offset + CHUNK_SIZE);
    const next = offset + CHUNK_SIZE;
    return {
      refs,
      nextCursor: next < all.length ? { offset: next } : null,
      progress: `documents ${offset + 1} to ${offset + refs.length} of ${all.length} listed`,
    };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.kind || !listing.title) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const file = await fetchFileText(ctx, ref.url, ref.known, { htmlContent: (html) => mainElement(html) });
    if (file === "not_modified") return { kind: "not_modified" };
    const header = listing.kind === "broadcast_message" || /^Broadcast Message\b/i.test(listing.title) ? broadcastHeader(file.text) : null;
    const dateText = header?.dateText ?? null;
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: listing.kind === "broadcast_message" ? "notice" : listing.kind === "stem_list" ? "other" : "policy_memorandum",
        title: listing.kind === "stem_list" ? `${KIND_LABEL.stem_list}: ${listing.title}` : listing.title,
        citations: [],
        agency: AGENCY,
        publishedDate: parseStatedDate(dateText),
        documentYear: !dateText && listing.year ? listing.year : null,
        precedentialStatus: "not_applicable",
        ...fileFields(file),
        withdrawn: listing.withdrawnReason ? { reason: listing.withdrawnReason } : null,
        metadata: {
          series: KIND_LABEL[listing.kind],
          listedOn: listing.listedOn,
          ...(listing.description ? { summary: listing.description, summaryKind: "SEVP's description on the listing" } : {}),
          ...(header?.number ? { broadcastNumber: header.number } : {}),
          ...(listing.listedMonth ? { listedMonth: listing.listedMonth } : {}),
          statedDates: {
            ...(dateText ? { date: dateText } : {}),
            ...(listing.listedMonth ? { listedUnder: listing.listedMonth } : {}),
          },
          ...fileMetadata(file),
        },
      },
    };
  },
};
