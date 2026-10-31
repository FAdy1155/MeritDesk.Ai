import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { cachedPage, chunkOf, fetchFileText, fileFields, fileMetadata, fingerprintOf, isPdfUrl } from "./common";
import { dolArticle, firstH1, parseWhdFactSheetIndex, parseWhdHub, parseWhdLinkedGuidance, pathId, whdRevisionLine, yearOf } from "./parse";

// The Department of Labor's Wage and Hour Division (WHD) guidance on the
// immigration programs it enforces (D-1, E-3, H-1B, H-1B1, H-2A, H-2B and
// the U and T visa certifications), on dol.gov:
//
// - the program pages the WHD immigration hub links
//   (https://www.dol.gov/agencies/whd/immigration);
// - the WHD fact sheets and Field Assistance Bulletins those pages link
//   (dol.gov PDFs and fact sheet pages);
// - the fact sheets on WHD's fact sheet index whose titles name an
//   immigration program (the H-2A series 26 to 26h, H-1B, H-2B and the
//   others), English editions only.
//
// Every page and file is one document; the listing is read whole each day
// and unchanged entries are skipped by their fingerprints. dol.gov's
// robots.txt sets no Crawl-delay. US government work: public domain,
// stored in full.

const HOSTS = ["www.dol.gov", "dol.gov"] as const;
const HUB_URL = "https://www.dol.gov/agencies/whd/immigration";
const FACT_SHEETS_URL = "https://www.dol.gov/agencies/whd/fact-sheets";
const AGENCY = "U.S. Department of Labor, Wage and Hour Division";

type Listing = { label: string; kind: "program_page" | "linked_guidance" | "fact_sheet"; listedOn: string };

async function readAll(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const { text: hubHtml, response: hubResponse } = await cachedPage(ctx, HUB_URL);
  const hub = dolArticle(hubHtml);
  const programs = hub ? parseWhdHub(hub, hubResponse.url) : [];
  if (programs.length === 0) throw new LibraryLayoutError(HUB_URL, "no program page links in the article");
  const refs = new Map<string, DocumentRef>();
  const add = (url: string, listing: Listing) => {
    const id = pathId(url);
    if (refs.has(id)) return;
    refs.set(id, { externalId: id, url, title: listing.label, fingerprint: fingerprintOf(listing.label, url, listing.kind), listing });
  };
  for (const p of programs) {
    add(p.url, { label: p.label, kind: "program_page", listedOn: HUB_URL });
    const { text, response } = await cachedPage(ctx, p.url);
    const article = dolArticle(text);
    if (!article) {
      ctx.note(`${p.url} has no article body; its linked guidance was not read.`);
      continue;
    }
    for (const l of parseWhdLinkedGuidance(article, response.url)) add(l.url, { label: l.label, kind: "linked_guidance", listedOn: p.url });
  }
  const { text: fsHtml, response: fsResponse } = await cachedPage(ctx, FACT_SHEETS_URL);
  const fsArticle = dolArticle(fsHtml) ?? fsHtml;
  const sheets = parseWhdFactSheetIndex(fsArticle, fsResponse.url);
  if (sheets.length === 0) throw new LibraryLayoutError(FACT_SHEETS_URL, "no immigration program fact sheets in the index");
  for (const s of sheets) add(s.url, { label: s.label, kind: "fact_sheet", listedOn: FACT_SHEETS_URL });
  return [...refs.values()];
}

export const dolWhdImmigrationAdapter: LibrarySourceAdapter = {
  code: "dol_whd_immigration",
  group: "other-agency-guidance",
  name: "DOL Wage and Hour Division immigration guidance",
  description:
    "The Wage and Hour Division's pages, fact sheets and Field Assistance Bulletins on the worker protections of the H-1B, H-2A, H-2B, E-3, H-1B1 and D-1 programs and on U and T visa certifications.",
  coverage:
    "The program pages linked from WHD's immigration page, the WHD fact sheets and bulletins they link, and the immigration program fact sheets on WHD's fact sheet index (English editions).",
  cadence: "Daily",
  officialUrl: HUB_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 30,

  async listUpdates(ctx) {
    return { refs: await readAll(ctx) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const { items, nextCursor, progress } = chunkOf(await readAll(ctx), cursor, 200);
    return { refs: items, nextCursor, progress };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    const file = await fetchFileText(ctx, ref.url, ref.known, { htmlContent: (html) => dolArticle(html) });
    if (file === "not_modified") return { kind: "not_modified" };
    let title = listing?.label || ref.externalId;
    let revision: string | null = null;
    if (file.kind === "html") {
      const html = file.response.body.toString("utf-8");
      title = firstH1(dolArticle(html) ?? "") ?? firstH1(html) ?? title;
      revision = listing?.kind !== "program_page" ? whdRevisionLine(file.text) : null;
    } else if (isPdfUrl(ref.url)) {
      revision = whdRevisionLine(file.text);
    }
    const factSheet = /Fact Sheet\s*#\s*([\w-]+)/i.exec(`${title} ${file.text.slice(0, 400)}`)?.[1] ?? null;
    // Some links are labeled only "PDF" or "TEXT"; a bulletin then takes its title from its own heading and SUBJECT line.
    const genericLabel = /^(?:pdf|text|here|link)$/i.test(title.trim());
    const fab = /Field Assistance Bulletin\s*(?:No\.?\s*)?(\d{4}-\d+)/i.exec(`${listing?.label ?? ""} ${file.text.slice(0, 600)}`)?.[1] ?? null;
    // A bulletin is a memorandum dated in its heading ("March 15, 2019") before "FIELD ASSISTANCE BULLETIN No.".
    const heading = fab ? file.text.slice(0, Math.max(0, file.text.search(/FIELD ASSISTANCE BULLETIN/i))) : "";
    const issued = /\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4})\b/.exec(heading)?.[1] ?? null;
    if (genericLabel && fab) {
      const subject = /SUBJECT:\s*([^\n]+(?:\n(?![A-Z ]{4,}:)[^\n]+)?)/.exec(file.text.slice(0, 3000))?.[1]?.replace(/\s+/g, " ").trim();
      title = `Field Assistance Bulletin No. ${fab}${subject ? `: ${subject}` : ""}`;
    } else if (genericLabel && factSheet) title = `Fact Sheet #${factSheet}`;
    // A scan with a generic link label: the file's own name is all the source says about it.
    else if (genericLabel) title = decodeURIComponent(new URL(file.response.url).pathname.split("/").pop() ?? title);
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: fab ? "policy_memorandum" : "web_guidance",
        title,
        citations: [...(factSheet ? [`WHD Fact Sheet #${factSheet}`] : []), ...(fab ? [`Field Assistance Bulletin No. ${fab}`] : [])],
        agency: AGENCY,
        publishedDate: parseStatedDate(issued),
        documentYear: issued ? null : yearOf(revision),
        precedentialStatus: "not_applicable",
        ...fileFields(file),
        metadata: {
          kind: listing?.kind ?? null,
          linkLabel: listing?.label ?? null,
          listedOn: listing?.listedOn ?? null,
          ...(factSheet ? { factSheetNumber: factSheet } : {}),
          ...(fab ? { fieldAssistanceBulletin: fab } : {}),
          ...(revision || issued ? { statedDates: { ...(revision ? { revised: revision } : {}), ...(issued ? { issued } : {}) } } : {}),
          ...fileMetadata(file),
        },
      },
    };
  },
};
