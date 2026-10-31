import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { LibraryLayoutError, type DocumentRef, type LibrarySourceAdapter } from "../../types";
import { parseGuidelineTables, readUscisPage, uscisText } from "./parse";
import { USCIS_AGENCY, USCIS_HOST } from "./run-pages";

// Form I-864P, HHS Poverty Guidelines for Affidavit of Support: the page
// USCIS keeps at https://www.uscis.gov/i-864p with the income tables a
// sponsor uses on Form I-864 (100% and 125% of the guidelines, for the 48
// states and territories, Alaska and Hawaii) and the date they take effect.
// One document, read every day with a conditional GET; USCIS replaces the
// tables each year, and earlier years are kept only as stored versions from
// when this collector read them (the page shows only the current year).
//
// The page also carries an earlier year's table in an accordion panel no
// heading opens, which no reader can see; it is left out of the text and
// the tables (parse.ts, dropOrphanAccordionPanels).
//
// US government work: public domain.

const I864P_URL = "https://www.uscis.gov/i-864p";
const HOSTS = [USCIS_HOST] as const;

const REF: DocumentRef = { externalId: "Form I-864P", url: I864P_URL, title: "Form I-864P, HHS Poverty Guidelines for Affidavit of Support" };

export const uscisI864pAdapter: LibrarySourceAdapter = {
  code: "uscis_i864p",
  group: "uscis-forms-fees",
  name: "USCIS Poverty Guidelines (Form I-864P)",
  description: "The HHS poverty guidelines USCIS publishes on Form I-864P for sponsors completing Form I-864, Affidavit of Support, with the date they take effect.",
  coverage: "The current I-864P page and its tables; earlier years only as stored versions from when this collector read them.",
  cadence: "Daily (USCIS updates the tables once a year)",
  officialUrl: I864P_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,

  async listUpdates() {
    return { refs: [REF] };
  },

  async backfill() {
    return { refs: [REF], nextCursor: null, progress: "the current page" };
  },

  async fetchDocument(ctx, ref) {
    const { text, response } = await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const page = readUscisPage(text);
    if (page.nodeType !== "immigration-form" || !page.articleHtml) throw new LibraryLayoutError(ref.url, "not the I-864P form page");
    const tables = parseGuidelineTables(page.articleHtml);
    if (tables.length === 0 || tables.some((t) => t.rows.length < 3)) throw new LibraryLayoutError(ref.url, "no poverty guideline tables under their headings");
    const body = uscisText(page.articleHtml);
    const effective = /\beffective (?:beginning|on|as of)\s+([A-Z][a-z]{2,8}\.?\s+\d{1,2},\s+\d{4})/i.exec(body);
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "guideline",
        title: page.heading ? `Form ${page.heading}` : (ref.title ?? "Form I-864P"),
        citations: ["Form I-864P"],
        agency: USCIS_AGENCY,
        effectiveDate: parseStatedDate(effective?.[1]),
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        text: body,
        metadata: {
          formNumber: "I-864P",
          effectiveText: effective ? effective[0] : null,
          guidelines: tables,
          lastReviewedUpdated: page.lastReviewed?.text ?? null,
          statedDates: { effective: effective?.[1] ?? null, lastReviewedUpdated: page.lastReviewed?.text ?? null },
          ...(page.orphanPanelsDropped ? { hiddenPanelsLeftOut: page.orphanPanelsDropped } : {}),
        },
        fetch: { response },
      },
    };
  },
};
