import { parseStatedDate } from "@/services/monitoring/parse/dates";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibraryDocType,
  type LibrarySourceAdapter,
} from "../../types";
import {
  fetchUscisFile,
  fingerprintOf,
  pdfExtraction,
  pdfOriginal,
  permanentFetchProblem,
  readSitemap,
  sinceFilter,
  SITEMAP_URL,
  USCIS_AGENCY,
  USCIS_HOSTS,
} from "./common";
import { fileExtension, fileKey, parseMemoHeader, supersessionStatements, titleFromFileName, urlPath } from "./parse";
import { readCurrentMemoranda } from "./policy-memoranda";
import { readTrigPages } from "./trig-exemptions";

// The USCIS policy documents that no listing page carries: legal documents
// (legal opinions, delegations of authority, court orders, settlement
// agreements, letters of agreement), notices, policy fact sheets, policy
// questions and answers (stakeholder engagements, liaison meetings), court
// injunctions and Policy Manual resources, as PDFs in USCIS's file folders
// the site map lists (/sites/default/files/document/legal-docs/, /notices/,
// /fact-sheets/, /questions-and-answers/, /injunctions/,
// /policy-manual-resources/).
//
// - No page lists these files with titles: a file's title is its SUBJECT
//   line when it has one, else its file name (metadata.titleSource says
//   which). Its date is the one its first page prints beside its memorandum
//   number, when it has one; the site map's lastmod is kept in the metadata
//   and is not a document date.
// - Left out by rule (counted in the run's notes): files the TRIG pages link
//   (held, with their titles, by uscis_trig_exemptions); files the Policy
//   Memoranda page lists (held by uscis_policy_memoranda); grant program
//   files (grant awards, notices of funding); citizenship test study
//   material (the civics questions and vocabulary lists); translations,
//   whose file names end in a language; and files other than PDFs.
// - Daily: files whose lastmod is since the last run (with a margin).
//   Backfill: every file in scope, newest lastmod first.

const FOLDERS = /^\/sites\/default\/files\/document\/(legal-docs|notices|fact-sheets|questions-and-answers|injunctions|policy-manual-resources)\/[^/]+$/i;
const PAGE_SIZE = 80;
// Whole words only: "grant" inside "Immigrant" is not a grant file.
const GRANT = /(?:^|[^a-z])(?:grants?|nofo|awards?)(?=[^a-z]|$)|grantprogram|\d+kgrant/i;
const CIVICS = /(?:^|[_-])(?:100q|65-20q?|ooc_|civics|reading_vocab|writing_vocab|m_17\d\dtxt)/i;
const TRANSLATION =
  /[-_ ](?:arabic|chinese|simp_chinese|trad_chinese|korean|tagalog|vietnamese|spanish|spa|chi|cre|kor|pol|ptb|french|german|hindi|japanese|polish|portuguese|russian|urdu|creole|hat|es)(?:[-_ ]archive|[-_ ]\d{4}[-_ ]\w+)?\.[a-z]{2,4}$/i;

type Listing = { folder: string; lastmod: string | null };
type Cursor = { offset: number };

function isCursor(value: unknown): value is Cursor {
  return Boolean(value) && Number.isInteger((value as Cursor).offset) && (value as Cursor).offset >= 0;
}

/** Why a file is not collected here, or null when it is. */
function leftOutBecause(url: string, trigFiles: Set<string>, memoFiles: Set<string>): string | null {
  const name = fileKey(url);
  if (memoFiles.has(name)) return "listed on the Policy Memoranda page (held by the memoranda collector)";
  if (trigFiles.has(urlPath(url))) return "linked from the TRIG pages (held by the TRIG collector)";
  if (fileExtension(url) !== "pdf") return "not a PDF";
  if (GRANT.test(name)) return "a grant program file";
  if (CIVICS.test(name)) return "citizenship test study material";
  if (TRANSLATION.test(name)) return "a translation";
  return null;
}

async function listAll(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const trig = await readTrigPages(ctx);
  const trigFiles = new Set(trig.files.keys());
  const memoFiles = new Set((await readCurrentMemoranda(ctx)).map((r) => fileKey(r.url)));
  const reasons = new Map<string, number>();
  const seen = new Set<string>();
  const refs: DocumentRef[] = [];
  for (const u of await readSitemap(ctx)) {
    let url: URL;
    try {
      url = new URL(u.loc);
    } catch {
      continue;
    }
    const folder = FOLDERS.exec(url.pathname)?.[1]?.toLowerCase();
    if (url.hostname !== "www.uscis.gov" || !folder || seen.has(url.pathname)) continue;
    seen.add(url.pathname);
    const why = leftOutBecause(u.loc, trigFiles, memoFiles);
    if (why) {
      reasons.set(why, (reasons.get(why) ?? 0) + 1);
      continue;
    }
    const listing: Listing = { folder, lastmod: u.lastmod };
    refs.push({ externalId: url.pathname, url: u.loc, title: titleFromFileName(u.loc), fingerprint: fingerprintOf(u.loc, u.lastmod), listing });
  }
  for (const [why, n] of reasons) ctx.note(`${n} file(s) left out: ${why}.`);
  if (refs.length < 50) throw new LibraryLayoutError(SITEMAP_URL, `only ${refs.length} files in the policy document folders`);
  return refs.sort(
    (x, y) => ((y.listing as Listing).lastmod ?? "").localeCompare((x.listing as Listing).lastmod ?? "") || x.externalId.localeCompare(y.externalId)
  );
}

const KINDS: Record<string, { label: string; docType: LibraryDocType }> = {
  "legal-docs": { label: "Legal document", docType: "other" },
  notices: { label: "Notice", docType: "notice" },
  "fact-sheets": { label: "Fact sheet", docType: "web_guidance" },
  "questions-and-answers": { label: "Questions and answers", docType: "web_guidance" },
  injunctions: { label: "Injunction", docType: "other" },
  "policy-manual-resources": { label: "Policy Manual resource", docType: "web_guidance" },
};

export const uscisPolicyDocumentsAdapter: LibrarySourceAdapter = {
  code: "uscis_policy_documents",
  group: "uscis-policy-guidance",
  name: "USCIS legal documents, notices, fact sheets and Q&As",
  description:
    "USCIS's legal documents (legal opinions, delegations of authority, court orders and settlements), notices, policy fact sheets, questions and answers from stakeholder engagements, injunctions and Policy Manual resources, as PDFs in the folders its site map lists.",
  coverage:
    "Every PDF the uscis.gov site map lists in the legal documents, notices, fact sheets, questions and answers, injunctions and Policy Manual resources folders, except grant program files, citizenship test study material, translations and files the TRIG pages link.",
  cadence: "Daily",
  officialUrl: SITEMAP_URL,
  hosts: USCIS_HOSTS,
  license: "public_domain",
  staleAfterHours: 72,
  recheckAfterDays: 180,
  maxDocumentsPerDailyRun: 60,

  async listUpdates(ctx, since) {
    const all = await listAll(ctx);
    return { refs: sinceFilter(all, (r) => ((r.listing as Listing).lastmod ?? "").slice(0, 10) || null, since, 3, 0) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const all = await listAll(ctx);
    const offset = isCursor(cursor) ? cursor.offset : 0;
    if (offset >= all.length) return { refs: [], nextCursor: null, progress: "every file is done" };
    const refs = all.slice(offset, offset + PAGE_SIZE);
    const next = offset + refs.length;
    return { refs, nextCursor: next < all.length ? { offset: next } : null, progress: `files ${offset + 1} to ${next} of ${all.length}, newest lastmod first` };
  },

  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    let file;
    try {
      file = await fetchUscisFile(ctx, ref.url, ref.known);
    } catch (err) {
      const problem = permanentFetchProblem(err);
      if (problem) return { kind: "skip", reason: problem };
      throw err;
    }
    if (file.kind === "not_modified") return { kind: "not_modified" };
    if (file.kind !== "pdf") return { kind: "skip", reason: `${file.response.url} answered ${file.response.contentType || "an unknown type"}, not a PDF.` };
    const pdf = file.pdf;
    const text = pdf.pagesWithText > 0 ? pdf.text : "";
    const header = parseMemoHeader(text);
    const kind = KINDS[listing?.folder ?? ""] ?? { label: "Document", docType: "other" as const };
    // Only a memorandum's own statements of what it replaces: in a court order
    // or opinion, "vacated" and "rescinded" describe the litigation instead.
    const supersedes = header.number || header.subject ? supersessionStatements(text, header.number) : [];
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: header.number?.startsWith("PM-") ? "policy_memorandum" : kind.docType,
        title: header.subject ?? titleFromFileName(ref.url),
        citations: header.number ? [header.number] : [],
        agency: USCIS_AGENCY,
        publishedDate: parseStatedDate(header.dateText),
        precedentialStatus: "not_applicable",
        officialUrl: ref.url,
        originalUrl: file.response.url !== ref.url ? file.response.url : null,
        text,
        textKind: text ? "full" : "none",
        metadata: {
          documentKind: kind.label,
          folder: listing?.folder ?? null,
          titleSource: header.subject ? "subject line" : "file name",
          ...(header.number ? { memoNumber: header.number } : {}),
          ...(supersedes.length ? { supersedes } : {}),
          statedDates: header.dateText ? { issued: header.dateText } : {},
          ...(listing?.lastmod ? { sitemapLastmod: listing.lastmod } : {}),
          pageCount: pdf.pageCount,
          ...(pdf.pagesWithText === 0 ? { textNote: "The PDF has no text layer (a scan); no OCR is run." } : {}),
        },
        original: pdfOriginal(file.response),
        fetch: { response: file.response, extraction: pdfExtraction(pdf) },
      },
    };
  },
};
