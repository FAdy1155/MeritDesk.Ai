import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { LibraryLayoutError, type DocumentRef, type FetchDocumentResult, type LibrarySourceAdapter } from "../../types";
import { firstDayMonthYear, parseUnTreatyStatus } from "./parse";

// The three treaties U.S. protection claims rest on, from the depositary's
// own record: the United Nations Treaty Collection (treaties.un.org),
// "Status of Treaties" (Multilateral Treaties Deposited with the
// Secretary-General, MTDSG):
//
//   V-2   Convention relating to the Status of Refugees (Geneva, 1951)
//   V-5   Protocol relating to the Status of Refugees (New York, 1967)
//   IV-9  Convention against Torture and Other Cruel, Inhuman or Degrading
//         Treatment or Punishment (New York, 1984)
//
// Each status page states the place and date of conclusion, the entry into
// force, the registration, the number of signatories and parties, the
// United Nations Treaty Series citation, the link to the certified true
// copy, the depositary's note, and a row per participant (the United States'
// row is kept: the Protocol by accession, 1 Nov 1968; the CAT signed 18 Apr
// 1988 and ratified 21 Oct 1994). The MTDSG numbers are the depositary's
// identifiers and the externalIds here.
//
// License: link_only. The United Nations' terms of use
// (https://www.un.org/en/about-us/terms-of-use, linked from every UNTC page)
// allow copying "for the User's personal, non-commercial use, without any
// right to resell or redistribute", which a firm's research service is not.
// So the library keeps the depositary's facts (dates, citation, status, the
// U.S. row), the status block as a short excerpt and the official links, and
// never fetches or stores the certified true copy. The full treaty texts
// stay on treaties.un.org. The Senate's own records of the Protocol and the
// CAT (with the CAT's reservations, understandings and declarations) are
// public domain and stored in full by ./congress-treaties.ts.
//
// The pages carry no "what's new": each is read every day (three pages;
// treaties.un.org asks for 2 seconds between requests). The "STATUS AS AT"
// time stamp is left out of the stored text so a version is recorded only
// when the status itself changes.

const HOSTS = ["treaties.un.org"] as const;
const TREATIES = [
  { mtdsg: "V-2", url: "https://treaties.un.org/Pages/ViewDetails.aspx?src=TREATY&mtdsg_no=V-2&chapter=5&clang=_en" },
  { mtdsg: "V-5", url: "https://treaties.un.org/Pages/ViewDetails.aspx?src=TREATY&mtdsg_no=V-5&chapter=5&clang=_en" },
  { mtdsg: "IV-9", url: "https://treaties.un.org/Pages/ViewDetails.aspx?src=TREATY&mtdsg_no=IV-9&chapter=4&clang=_en" },
] as const;

function refs(): DocumentRef[] {
  // No fingerprint: the status page is the listing, so each is fetched every run (three pages).
  return TREATIES.map((t) => ({ externalId: `MTDSG ${t.mtdsg}`, url: t.url, title: `UN Treaty Collection, MTDSG ${t.mtdsg}`, listing: { mtdsg: t.mtdsg } }));
}

export const unTreatiesAdapter: LibrarySourceAdapter = {
  code: "untc_refugee_cat_treaties",
  group: "treaties",
  name: "Refugee Convention, 1967 Protocol and Convention Against Torture (UN Treaty Collection)",
  description:
    "The depositary's status records for the 1951 Convention relating to the Status of Refugees, its 1967 Protocol and the Convention against Torture: dates, Treaty Series citation, parties, the United States' participation, and links to the certified true copies.",
  coverage:
    "The three treaties' status pages on treaties.un.org: the facts, a short excerpt and the official links. The treaty texts are linked, not stored (the UN's terms of use bar redistribution).",
  cadence: "Daily",
  officialUrl: TREATIES[0].url,
  hosts: HOSTS,
  license: "link_only",
  licenseNote:
    "The United Nations' terms of use permit copying for personal, non-commercial use only and bar redistribution; the library keeps the depositary's facts, a short excerpt and the official link.",
  staleAfterHours: 48,

  async listUpdates() {
    return { refs: refs() };
  },

  async backfill() {
    return { refs: refs(), nextCursor: null, progress: "the three treaties' status pages" };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const { text: html, response } = await ctx.http.getText(ref.url, { expect: "html", timeoutMs: 120_000 });
    const s = parseUnTreatyStatus(html, response.url);
    if (!s) throw new LibraryLayoutError(ref.url, "no treaty title in the status block");
    const concludedText = firstDayMonthYear(s.concluded);
    const entryText = firstDayMonthYear(s.entryIntoForce);
    const citations = [ref.externalId];
    if (s.unts) citations.push(`${s.unts.volume} U.N.T.S. ${s.unts.page}`);
    const usColumns = s.unitedStates && s.participantColumns.length ? Object.fromEntries(s.participantColumns.slice(1).map((col, i) => [col, s.unitedStates![i + 1] ?? ""])) : null;
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "treaty",
        title: s.title.replace(/^\d+\s*\.\s*/, ""),
        citations,
        agency: "United Nations (depositary: the Secretary-General)",
        // The date the treaty was concluded ("Geneva, 28 July 1951") and its entry into force, as the depositary states them.
        decisionDate: parseStatedDate(concludedText),
        effectiveDate: parseStatedDate(entryText),
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        text: s.text,
        metadata: {
          mtdsgNumber: ref.externalId.replace(/^MTDSG /, ""),
          ...(s.chapter ? { chapter: s.chapter } : {}),
          ...(s.concluded ? { concluded: s.concluded } : {}),
          ...(s.entryIntoForce ? { entryIntoForce: s.entryIntoForce } : {}),
          ...(s.registration ? { registration: s.registration } : {}),
          ...(s.status ? { status: s.status } : {}),
          ...(s.textCitation ? { treatySeries: s.textCitation } : {}),
          ...(s.certifiedCopyUrl ? { certifiedTrueCopy: s.certifiedCopyUrl } : {}),
          participantsListed: s.participantCount,
          ...(usColumns ? { unitedStates: usColumns } : { unitedStates: null }),
          statedDates: { ...(s.concluded ? { concluded: s.concluded } : {}), ...(s.entryIntoForce ? { entryIntoForce: s.entryIntoForce } : {}) },
          textNote: "Link only: the treaty text is on treaties.un.org (certified true copy); the library keeps the depositary's status facts.",
        },
        fetch: { response },
      },
    };
  },
};
