import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibraryHttpResponse,
  type LibrarySourceAdapter,
} from "../../types";
import { parseConstitutionText, parseGovInfoMods, ratificationDate, type ConstitutionProvision, type GovInfoMods } from "./parse";
import { once, rememberFile, sharedFile } from "./run-cache";

// The Constitution of the United States, from the Government Publishing
// Office's edition on GovInfo: "The Constitution of the United States of
// America As Amended" (H. Doc. 110-50, 2007), package CDOC-110hdoc50. Its
// MODS record names the edition and links its HTML and PDF renditions;
// the HTML rendition is GPO's text, read here into provisions: the
// preamble, each section of Articles I to IV, Articles V to VII, and each
// of the 27 amendments with its proposal and ratification history, each
// with the notes the text refers to.
//
// Congress.gov's Constitution Annotated (constitution.congress.gov) is the
// other official text, but it answers automated clients with a challenge
// page, which this collector does not get past; the OLRC's copy of the
// Constitution (https://uscode.house.gov/static/constitution.pdf) is a
// two-column PDF that does not split into provisions reliably.
//
// The text has not changed since the 27th Amendment (1992). The daily run
// asks for the HTML with a conditional request and lists nothing when it
// is unchanged. GPO's text is a work of the United States government:
// public domain, stored in full.

const PACKAGE = "CDOC-110hdoc50";
const MODS_URL = `https://www.govinfo.gov/metadata/pkg/${PACKAGE}/mods.xml`;
const HOSTS = ["www.govinfo.gov"] as const;

type Edition = { mods: GovInfoMods; provisions: Map<string, ConstitutionProvision>; order: string[] };

type Listing = { id: string; htmlUrl: string };

async function readMods(ctx: LibraryAdapterContext): Promise<GovInfoMods> {
  return once(ctx, "constitution:mods", async () => {
    const { text } = await ctx.http.getText(MODS_URL, { expect: "xml" });
    const mods = parseGovInfoMods(text);
    if (!mods.htmlUrl || !mods.detailsUrl || !/CONSTITUTION/i.test(mods.title ?? "")) {
      throw new LibraryLayoutError(MODS_URL, "no Constitution title, details link or HTML rendition link");
    }
    return mods;
  });
}

function readEdition(mods: GovInfoMods, response: LibraryHttpResponse): Edition {
  const parsed = parseConstitutionText(response.body.toString("utf8"));
  if (!parsed.recognized) throw new LibraryLayoutError(response.url, parsed.notes.join(" ") || "no provisions");
  const amendments = parsed.provisions.filter((p) => p.kind === "amendment").length;
  const articles = new Set(parsed.provisions.filter((p) => p.kind !== "amendment" && p.article).map((p) => p.article));
  // The ratified Constitution has seven articles and twenty-seven amendments; anything else means the text was misread.
  if (amendments !== 27 || articles.size !== 7) throw new LibraryLayoutError(response.url, `read ${articles.size} articles and ${amendments} amendments`);
  return { mods, provisions: new Map(parsed.provisions.map((p) => [p.id, p])), order: parsed.provisions.map((p) => p.id) };
}

const editionKey = (url: string) => `constitution:${url}`;

function loadEdition(ctx: LibraryAdapterContext, mods: GovInfoMods, known: DocumentRef["known"]) {
  const url = mods.htmlUrl!;
  return sharedFile(
    ctx,
    editionKey(url),
    url,
    known,
    (conditional) => ctx.http.get(url, { expect: "html", conditional }),
    (response) => readEdition(mods, response)
  );
}

function citationsOf(p: ConstitutionProvision): string[] {
  const roman = (label: string | null) => (label ?? "").replace(/^(Article|Amendment)\s+/, "");
  switch (p.kind) {
    case "preamble":
      return ["U.S. Const. pmbl."];
    case "article_section":
      return [`U.S. Const. art. ${roman(p.article)}, § ${p.section}`];
    case "article":
      return [`U.S. Const. art. ${roman(p.article)}`];
    case "amendment":
      return [`U.S. Const. amend. ${roman(p.article)}`, ...p.sections.map((s) => `U.S. Const. amend. ${roman(p.article)}, § ${s}`)];
  }
}

function titleOf(p: ConstitutionProvision): string {
  if (p.kind === "preamble") return "U.S. Constitution, Preamble";
  if (p.kind === "article_section") return `U.S. Constitution, ${p.article}, Section ${p.section}`;
  return `U.S. Constitution, ${p.article}`;
}

function refsOf(edition: Edition, htmlUrl: string): DocumentRef[] {
  return edition.order.map((id) => {
    const p = edition.provisions.get(id)!;
    return {
      externalId: id,
      url: htmlUrl,
      title: titleOf(p),
      fingerprint: sha256Hex([id, p.text].join("\u0000")).slice(0, 32),
      listing: { id, htmlUrl } satisfies Listing,
    };
  });
}

async function listAll(ctx: LibraryAdapterContext, daily: boolean): Promise<DocumentRef[]> {
  const mods = await readMods(ctx);
  if (daily) {
    // A conditional request: the edition is static, so most days it is unchanged and nothing is listed.
    const { unchanged, response } = await ctx.http.getListing(mods.htmlUrl!, { expect: "html" });
    if (unchanged) return [];
    const edition = readEdition(mods, response);
    rememberFile(ctx, editionKey(mods.htmlUrl!), { response, value: edition });
    return refsOf(edition, mods.htmlUrl!);
  }
  const loaded = await loadEdition(ctx, mods, null);
  if (loaded.notModified) return [];
  return refsOf(loaded.file.value, mods.htmlUrl!);
}

export const govinfoConstitutionAdapter: LibrarySourceAdapter = {
  code: "govinfo_constitution",
  group: "constitution",
  name: "Constitution of the United States (GPO, GovInfo)",
  description:
    "The Constitution and its 27 amendments in the Government Publishing Office's edition, The Constitution of the United States of America As Amended (H. Doc. 110-50), one provision per article section or amendment, with each amendment's proposal and ratification history and the edition's notes.",
  coverage:
    "The preamble, every section of Articles I to IV, Articles V to VII with the signatures, and Amendments I to XXVII, from H. Doc. 110-50 (2007). The edition's historical note, unratified amendments and index are not collected.",
  cadence: "Static; checked daily",
  officialUrl: `https://www.govinfo.gov/app/details/${PACKAGE}`,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 180,

  async listUpdates(ctx) {
    return { refs: await listAll(ctx, ctx.mode === "daily") };
  },

  async backfill(ctx) {
    // One edition: the whole text is one chunk.
    const refs = await listAll(ctx, false);
    return { refs, nextCursor: null, progress: `${refs.length} provisions of H. Doc. 110-50` };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    if (!listing?.id) return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
    const mods = await readMods(ctx);
    const loaded = await loadEdition(ctx, mods, ref.known);
    if (loaded.notModified) return { kind: "not_modified" };
    const { response, value: edition } = loaded.file;
    const p = edition.provisions.get(listing.id);
    if (!p) return { kind: "skip", reason: `${listing.id} is not in the edition's text.` };
    const ratified = ratificationDate(p.ratificationCompletedText);
    return {
      kind: "document",
      document: {
        externalId: p.id,
        docType: "constitution_provision",
        title: titleOf(p),
        citations: citationsOf(p),
        agency: "U.S. Government Publishing Office",
        publishedDate: parseStatedDate(mods.dateIssued),
        precedentialStatus: "not_applicable",
        officialUrl: mods.detailsUrl!,
        originalUrl: response.url,
        text: p.text,
        metadata: {
          provisionKind: p.kind,
          article: p.article,
          section: p.section,
          ...(p.sections.length ? { sections: p.sections } : {}),
          printedHeading: p.printedHeading,
          footnotes: p.footnotes,
          ...(p.proposalAndRatification ? { proposalAndRatification: p.proposalAndRatification } : {}),
          ...(ratified ? { ratificationCompleted: ratified } : {}),
          edition: mods.title,
          editionCitation: mods.documentCitation,
          govinfoPackage: PACKAGE,
          pdfUrl: mods.pdfUrl,
          statedDates: {
            ...(mods.dateIssued ? { editionIssued: mods.dateIssued } : {}),
            ...(p.ratificationCompletedText ? { ratificationCompleted: p.ratificationCompletedText } : {}),
          },
          markersNote: "In the text, [1], [2] and so on are the clause numbers the edition prints; [note N] refers to the edition's note N, printed at the end.",
        },
        fetch: { response, extraction: { format: "GPO text (HTML rendition)" } },
      },
    };
  },
};
