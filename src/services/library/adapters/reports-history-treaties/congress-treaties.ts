import { htmlToDocumentText } from "../../extract/html";
import { cleanText } from "../../text";
import { LibraryLayoutError, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { isoDatePart } from "./common";

// The United States' own record of the two treaties U.S. protection claims
// rest on, from the Senate's treaty records in the Congress.gov API
// (https://api.congress.gov/v3/treaty, documented at
// https://github.com/LibraryOfCongress/api.congress.gov):
//
//   Treaty 100-20  the Convention against Torture (Treaty Doc. 100-20,
//                  transmitted 1988, advice and consent 27 October 1990)
//   Treaty 90-27   the Protocol relating to the Status of Refugees
//                  (Ex. K, 90th Congress, 2nd Session, transmitted 1968)
//
// The two records were identified from the API's own treaty lists for the
// 90th and 100th Congresses; fetchDocument checks that each record still
// carries its treaty's title and fails the run if it does not. (The United
// States is not a party to the 1951 Convention itself; it is bound to its
// articles 2 to 34 through the Protocol, so the Senate holds no record of
// the Convention.)
//
// Each record states the treaty's titles, when it was transmitted and
// considered, its index terms and, for the CAT, the Senate's resolution of
// advice and consent with the United States' reservations, understandings
// and declarations. The actions endpoint gives the
// Senate's steps with their dates (hearings, the executive report, the vote).
// The text kept is the resolution, verbatim, followed by the record's facts
// and actions as the API states them.
//
// Congress.gov does not serve its web pages to automated clients (HTTP 403,
// a Cloudflare challenge), so the official URL is the API record itself; the
// API key goes in the X-Api-Key header, never in the URL. Senate records are
// US government works: public domain, stored in full. The treaty texts
// themselves are kept as the UN depositary's records (./un-treaties.ts).

const API = "https://api.congress.gov/v3/treaty";
const HOSTS = ["api.congress.gov"] as const;
const API_TIMEOUT_MS = 150_000;
const BODY_RE = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i;

const TREATIES = [
  { congress: 100, number: 20, expect: /\btorture\b/i },
  { congress: 90, number: 27, expect: /\bstatus of refugees\b/i },
] as const;

type TreatyRecord = {
  congressReceived?: number;
  congressConsidered?: number;
  number?: number;
  suffix?: string;
  oldNumber?: string | null;
  oldNumberDisplayName?: string | null;
  transmittedDate?: string | null;
  inForceDate?: string | null;
  updateDate?: string | null;
  topic?: string | null;
  resolutionText?: string | null;
  titles?: { title?: string; titleType?: string }[];
  indexTerms?: { name?: string }[];
  countriesParties?: { name?: string }[];
  actions?: { count?: number; url?: string };
};
type TreatyAction = { actionCode?: string; actionDate?: string; text?: string; type?: string; committee?: { name?: string } | null };

type Listing = { congress: number; number: number };

function apiHeaders(ctx: LibraryAdapterContext): Record<string, string> {
  const key = ctx.env("CONGRESS_GOV_API_KEY");
  if (!key) throw new Error("CONGRESS_GOV_API_KEY is not set.");
  return { "X-Api-Key": key, Accept: "application/json" };
}

function recordUrl(t: Listing): string {
  return `${API}/${t.congress}/${t.number}`;
}

function refs(): DocumentRef[] {
  // No fingerprint: there is no listing to read, so each record is fetched every run (four API requests a day).
  return TREATIES.map((t) => ({ externalId: `treaty ${t.congress}-${t.number}`, url: recordUrl(t), title: `Senate treaty record ${t.congress}-${t.number}`, listing: { congress: t.congress, number: t.number } }));
}

export const congressTreatiesAdapter: LibrarySourceAdapter = {
  code: "congress_gov_treaty_records",
  group: "treaties",
  name: "Senate treaty records: Convention Against Torture and 1967 Refugee Protocol (Congress.gov API)",
  description:
    "The Senate's records of the Convention against Torture (Treaty Doc. 100-20) and the Protocol relating to the Status of Refugees (Ex. K, 90-2) from the Congress.gov API: titles, dates, the Senate's actions and, for the CAT, the resolution of advice and consent with the United States' reservations, understandings and declarations.",
  coverage:
    "The two Senate treaty records, in full as the API states them. The treaty texts are not in these records; the UN depositary's records hold their facts and links.",
  cadence: "Daily",
  officialUrl: "https://api.congress.gov/v3/treaty",
  hosts: HOSTS,
  license: "public_domain",
  requiredEnv: ["CONGRESS_GOV_API_KEY"],
  staleAfterHours: 48,

  async listUpdates() {
    return { refs: refs() };
  },

  async backfill() {
    return { refs: refs(), nextCursor: null, progress: "the two Senate treaty records" };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    const wanted = TREATIES.find((t) => t.congress === listing?.congress && t.number === listing?.number);
    if (!listing || !wanted) return { kind: "skip", reason: `${ref.externalId}: not one of the treaty records this collector follows.` };
    const url = recordUrl(listing);
    const { data, response } = await ctx.http.getJson<{ treaty?: TreatyRecord | TreatyRecord[] }>(`${url}?format=json`, { headers: apiHeaders(ctx), timeoutMs: API_TIMEOUT_MS });
    const record = Array.isArray(data?.treaty) ? data.treaty[0] : data?.treaty;
    if (!record || record.number !== listing.number) throw new LibraryLayoutError(url, "no treaty record in the response");
    const titles = (record.titles ?? []).filter((t): t is { title: string; titleType?: string } => Boolean(t.title?.trim()));
    const shortTitle = titles.find((t) => /short title/i.test(t.titleType ?? ""))?.title ?? titles[0]?.title ?? null;
    if (!shortTitle || !titles.some((t) => wanted.expect.test(t.title))) throw new LibraryLayoutError(url, `the record's titles no longer name the treaty this collector follows (${shortTitle ?? "no title"})`);

    const actionsUrl = record.actions?.url;
    let actions: TreatyAction[] = [];
    if (actionsUrl) {
      if (!actionsUrl.startsWith(`${url}/actions`)) throw new LibraryLayoutError(url, `the record's actions link is not this record's (${actionsUrl})`);
      const u = new URL(actionsUrl);
      u.searchParams.set("format", "json");
      u.searchParams.set("limit", "250");
      const { data: a } = await ctx.http.getJson<{ actions?: TreatyAction[] }>(u.toString(), { headers: apiHeaders(ctx), timeoutMs: API_TIMEOUT_MS });
      if (!Array.isArray(a?.actions)) throw new LibraryLayoutError(actionsUrl, "no actions array in the response");
      actions = a.actions.filter((x) => x && typeof x.text === "string" && x.text.trim() !== "").sort((x, y) => (x.actionDate ?? "").localeCompare(y.actionDate ?? ""));
    }

    // The Senate's vote on the resolution of advice and consent, as its action states it.
    const consent = actions.find((a) => /resolution of advice and consent to ratification agreed to/i.test(a.text ?? ""));
    // resolutionText is a whole HTML document: its <body> is the resolution.
    const resolutionHtml = record.resolutionText ? (BODY_RE.exec(record.resolutionText)?.[1] ?? record.resolutionText) : "";
    const resolution = resolutionHtml ? htmlToDocumentText(resolutionHtml) : "";
    const formalTitle = titles.find((t) => /formal title/i.test(t.titleType ?? ""))?.title ?? null;
    const citation = record.oldNumberDisplayName?.trim() || `Treaty Doc. ${record.congressReceived ?? listing.congress}-${record.number}${record.suffix?.trim() ?? ""}`;
    const indexTerms = (record.indexTerms ?? []).map((t) => t.name?.trim()).filter((t): t is string => Boolean(t));
    const facts = [
      citation,
      ...titles.map((t) => `${t.titleType ?? "Title"}: ${t.title}`),
      record.transmittedDate ? `Transmitted to the Senate: ${isoDatePart(record.transmittedDate) ?? record.transmittedDate}` : null,
      record.congressReceived ? `Congress received: ${record.congressReceived}` : null,
      record.congressConsidered ? `Congress considered: ${record.congressConsidered}` : null,
      record.inForceDate ? `In force: ${record.inForceDate}` : null,
      record.topic ? `Topic: ${record.topic}` : null,
      indexTerms.length ? `Index terms: ${indexTerms.join("; ")}` : null,
    ].filter((l): l is string => Boolean(l));
    const actionLines = actions.map((a) => `${a.actionDate ?? "(no date)"}  ${a.committee?.name ? `${a.committee.name}: ` : ""}${cleanText(a.text ?? "")}`);
    const text = [resolution, facts.join("\n"), actionLines.length ? `Actions\n${actionLines.join("\n")}` : null].filter(Boolean).join("\n\n");

    const statedDates: Record<string, string> = {};
    if (record.transmittedDate) statedDates.transmitted = record.transmittedDate;
    if (consent?.actionDate) statedDates.adviceAndConsent = consent.actionDate;
    if (record.inForceDate) statedDates.inForce = record.inForceDate;
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "treaty",
        title: shortTitle,
        citations: [citation],
        agency: "United States Senate",
        // The day the Senate agreed to the resolution of advice and consent, as its action states it.
        decisionDate: isoDatePart(consent?.actionDate),
        publishedDate: isoDatePart(record.transmittedDate),
        effectiveDate: isoDatePart(record.inForceDate),
        precedentialStatus: "not_applicable",
        officialUrl: url,
        text,
        metadata: {
          congressReceived: record.congressReceived ?? null,
          congressConsidered: record.congressConsidered ?? null,
          treatyNumber: record.number,
          ...(record.oldNumberDisplayName ? { oldNumber: record.oldNumberDisplayName.trim() } : {}),
          ...(formalTitle ? { formalTitle } : {}),
          indexTerms,
          ...(record.topic ? { topic: record.topic } : {}),
          ...(record.countriesParties?.length ? { parties: record.countriesParties.map((c) => c.name).filter(Boolean) } : {}),
          hasResolutionText: Boolean(resolution),
          actions: actions.map((a) => ({ date: a.actionDate ?? null, type: a.type ?? null, code: a.actionCode ?? null, committee: a.committee?.name ?? null, text: a.text ?? null })),
          ...(record.updateDate ? { recordUpdated: record.updateDate } : {}),
          statedDates,
          textNote: "The Senate's record of the treaty from the Congress.gov API: the resolution of advice and consent (when the record carries it), then the record's facts and the Senate's actions. The treaty text itself is not part of the record.",
        },
        fetch: { response },
      },
    };
  },
};
