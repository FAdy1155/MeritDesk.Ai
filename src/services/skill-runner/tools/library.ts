import "server-only";
import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { withGlobalReadContext } from "@/db/client";
import { isQueryCanceledError } from "@/lib/errors/safe-error";
import { LIBRARY_GROUP_CODES } from "@/services/library/groups";
import {
  LIBRARY_SEARCH_TIMEOUT_MS,
  lookupCitation,
  readDocument,
  searchLibrary,
  type CitationMatch,
  type LibrarySearchHit,
  type SourceFreshness,
} from "@/services/library/search";
import { toJsonSchemaObject } from "../json-schema";
// Types only: tools.ts imports this module for its registry.
import type { SkillTool, ToolExecutionContext } from "../tools";
import type { VerificationLogEntry } from "../verification-log";
import { chargeRequestBytes } from "./shared/request-bytes";

// The library tools: search_library, read_library_document and
// lookup_library_citation read the app's own copy of the official sources
// (src/services/library/, docs/LIBRARY.md), collected from the government
// and court sites and refreshed daily. Read-only, global data: the run's
// tenant and matter are never involved, and nothing about the case leaves
// the app (the library is a database table, not a web search).
//
// Every result names each document's official URL (what to cite) and when
// its source was last refreshed, flags a source that is stale, and labels
// unpublished BIA and AAO decisions non-precedential. Every result the
// model sees is written to the run's verification log by the app, as
// web_search and web_fetch results are: a search hit as seen, a lookup as a
// citation confirmed in the library, a read as the official text read from
// the library's copy.

const SEARCH_RESULTS_PER_CALL = 10;
const DEFAULT_READ_CHARS = 20_000;
const MAX_READ_CHARS = 40_000;

export const searchInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      'What to find: words, a "quoted phrase", alternatives with OR, -word to exclude, or a citation (27 I&N Dec. 316, 8 C.F.R. 1003.38, INA 240A). Never put a client\'s name, A-number or other case detail in it.'
    ),
  groups: z
    .array(z.enum(LIBRARY_GROUP_CODES))
    .max(10)
    .optional()
    .describe("Limit to these library groups, e.g. [\"bia-ag-precedents\", \"circuit-courts\"]."),
  sources: z.array(z.string().max(80)).max(10).optional().describe("Limit to these source codes (each result shows its source code)."),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Earliest decision or publication date, YYYY-MM-DD."),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Latest decision or publication date, YYYY-MM-DD."),
  precedential_only: z.boolean().optional().describe("true for precedential decisions only (leaves out unpublished BIA and AAO decisions)."),
  court: z.string().max(200).optional().describe('Court or agency name to match, e.g. "Fifth Circuit", "Board of Immigration Appeals".'),
  country: z
    .string()
    .trim()
    .max(80)
    .optional()
    .describe('Country or area the document is about, e.g. "Honduras" or "Burma": matches the country conditions reports, TPS designations and other documents the library files by country.'),
  offset: z.number().int().min(0).max(1000).optional().describe("Results to skip, for the next page (the result says what to pass)."),
});

export const readInputSchema = z.object({
  document_id: z.string().uuid().describe("The document_id a search_library or lookup_library_citation result gave."),
  offset: z.number().int().min(0).optional().describe("Character offset to start from, to read on (the result says what to pass). Default 0."),
  max_chars: z.number().int().min(1_000).max(MAX_READ_CHARS).optional().describe(`Characters to return, at most ${MAX_READ_CHARS}. Default ${DEFAULT_READ_CHARS}.`),
});

export const lookupInputSchema = z.object({
  citation: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe(
      "One citation as written: 27 I&N Dec. 316, 26 I&N Dec. 826, 830 (pin page), Interim Decision 3984, 585 U.S. 198, 747 F.3d 773, 8 U.S.C. 1158(b), 8 C.F.R. 1003.38, INA 240A, 89 Fed. Reg. 12345, or a case name."
    ),
});

function day(date: Date | null): string {
  return date ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC` : "never";
}

/** "last refreshed ... (current)" or a STALE warning the model must pass on. */
export function refreshLine(source: SourceFreshness): string {
  if (!source.lastSuccessAt) {
    return `the app has not yet completed a refresh of this source from the official site: treat this copy as possibly out of date and say so`;
  }
  return source.stale
    ? `last refreshed from the official site ${day(source.lastSuccessAt)}: STALE (expected within ${source.staleAfterHours} hours); say so wherever you rely on it`
    : `last refreshed from the official site ${day(source.lastSuccessAt)} (current)`;
}

export function statusLabel(status: string): string {
  switch (status) {
    case "precedential":
      return "precedential";
    case "non_precedential":
      return "NON-PRECEDENTIAL (unpublished): label it non-precedential wherever you cite it";
    case "not_applicable":
      return "not a decision";
    default:
      return "precedential status not stated by the source";
  }
}

export function standingLines(item: { withdrawnAt: Date | null; supersededById?: string | null }): string[] {
  const lines: string[] = [];
  if (item.withdrawnAt) lines.push("   WITHDRAWN: the source no longer lists this document or marks it withdrawn; do not rely on it without checking the official site.");
  if (item.supersededById) lines.push("   SUPERSEDED: the source names a later document that replaces this one (read it for details).");
  return lines;
}

function logEntry(params: {
  action: "read" | "lookup" | "search";
  url: string;
  title: string;
  documentId: string;
  source: SourceFreshness;
  citation: string | null;
  precedentialStatus: string;
  query?: string;
  textRange?: string;
  content?: string;
}): VerificationLogEntry {
  return {
    source: params.action === "search" ? "library_search" : "library",
    url: params.url,
    fetchedAt: new Date().toISOString(),
    status: "ok",
    title: params.title,
    ...(params.query ? { query: params.query } : {}),
    ...(params.content ? { contentHash: crypto.createHash("sha256").update(params.content).digest("hex").slice(0, 16) } : {}),
    libraryAction: params.action === "search" ? undefined : params.action,
    libraryDocumentId: params.documentId,
    librarySource: params.source.name,
    librarySourceCode: params.source.code,
    sourceRefreshedAt: params.source.lastSuccessAt?.toISOString() ?? null,
    sourceStale: params.source.stale,
    citation: params.citation,
    precedentialStatus: params.precedentialStatus,
    ...(params.textRange ? { textRange: params.textRange } : {}),
  };
}

export const LIBRARY_RESULT_HEADER =
  "From this app's library: its own copies of official sources, collected directly from the government and court sites. Cite each document by its official URL (never the library), and say when a source is marked STALE.";

export function hitLines(hit: LibrarySearchHit, n: number): string[] {
  const meta = [hit.court ?? hit.agency, hit.date ?? (hit.documentYear ? String(hit.documentYear) : null), statusLabel(hit.precedentialStatus)].filter(Boolean);
  return [
    `${n}. ${hit.title}${hit.citations.length ? `, ${hit.citations.join("; ")}` : ""}`,
    `   document_id: ${hit.id} | ${meta.join(" | ")}${hit.matchedBy === "citation" ? " | matches the citation you searched" : hit.matchedBy === "title_similarity" ? " | similar title (no word match)" : ""}`,
    `   Source: ${hit.source.name} [${hit.source.code}], ${refreshLine(hit.source)}`,
    `   Official URL: ${hit.officialUrl}`,
    ...(hit.textKind === "excerpt" ? ["   The library keeps only an excerpt of this source (its terms restrict copying); open the official URL for the full text."] : []),
    ...(hit.textKind === "none" ? ["   The official file has no text layer (a scan): only its title and citation are searchable; open the official URL to read it."] : []),
    ...standingLines(hit),
    ...(hit.snippet ? [`   ${hit.snippet.replace(/\n+/g, " ").slice(0, 600)}`] : []),
  ];
}

async function executeSearch(input: unknown, ctx: ToolExecutionContext) {
  const parsed = searchInputSchema.safeParse(input);
  if (!parsed.success) return { content: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, isError: true };
  const q = parsed.data;
  let result;
  try {
    result = await withGlobalReadContext((tx) =>
      searchLibrary(tx, {
        query: q.query,
        groups: q.groups,
        sources: q.sources,
        dateFrom: q.date_from,
        dateTo: q.date_to,
        precedentialOnly: q.precedential_only,
        court: q.court,
        country: q.country,
        limit: SEARCH_RESULTS_PER_CALL,
        offset: q.offset,
      }),
      { statementTimeoutMs: LIBRARY_SEARCH_TIMEOUT_MS }
    );
  } catch (err) {
    if (isQueryCanceledError(err)) {
      return { content: "The library search took too long and was stopped: the query matches too much. Search again with more specific words (a quoted phrase, a case name, a citation) or filters (groups, sources, court, dates).", isError: true };
    }
    return { content: `The library search failed (${err instanceof Error ? err.message : String(err)}). Try again, or work without the library and say so.`, isError: true };
  }
  const offset = q.offset ?? 0;
  if (result.hits.length === 0) {
    return {
      content: `${LIBRARY_RESULT_HEADER}\n\nNo library document matches "${q.query}"${q.groups?.length || q.sources?.length || q.date_from || q.date_to || q.precedential_only || q.court || q.country ? " with these filters" : ""}. The library may not hold this source yet; if you have web tools, search the official site, otherwise treat the point as unverified.`,
    };
  }
  const lines = [
    LIBRARY_RESULT_HEADER,
    "",
    `Library search for "${q.query}": showing ${offset + 1}-${offset + result.hits.length} of ${result.total}${result.totalCapped ? "+" : ""}.${result.citation ? ` Read as the citation ${result.citation.normalized}.` : ""}${result.order === "date" ? " Too many documents match to rank them by relevance, so these are the newest; search again with more specific words or filters." : ""}`,
    "",
    ...result.hits.flatMap((hit, i) => [...hitLines(hit, offset + i + 1), ""]),
    offset + result.hits.length < result.total ? `More results: call search_library again with offset ${offset + result.hits.length}.` : "",
    "Read a document with read_library_document before relying on it: a snippet is not the holding.",
  ];
  const content = lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n").trim();
  if (!chargeRequestBytes(ctx, content)) {
    return { content: "The search results do not fit: the conversation is too close to the API's request size limit. Finish with what you have and say what you could not check.", isError: true };
  }
  for (const hit of result.hits) {
    ctx.verificationLog.push(
      logEntry({ action: "search", url: hit.officialUrl, title: hit.title, documentId: hit.id, source: hit.source, citation: hit.citations[0] ?? null, precedentialStatus: hit.precedentialStatus, query: q.query })
    );
  }
  return { content };
}

async function executeRead(input: unknown, ctx: ToolExecutionContext) {
  const parsed = readInputSchema.safeParse(input);
  if (!parsed.success) return { content: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, isError: true };
  const { document_id: id, offset = 0, max_chars = DEFAULT_READ_CHARS } = parsed.data;
  let doc;
  try {
    doc = await withGlobalReadContext((tx) => readDocument(tx, id, offset, max_chars));
  } catch (err) {
    return { content: `The library could not be read (${err instanceof Error ? err.message : String(err)}).`, isError: true };
  }
  if (!doc) return { content: `No library document has the id ${id}. Use an id a search_library or lookup_library_citation result gave.`, isError: true };
  if (offset > 0 && offset >= doc.textChars) {
    return { content: `offset ${offset} is past the end of this document's text (${doc.textChars} characters).`, isError: true };
  }

  const dates = [
    doc.decisionDate ? `decided ${doc.decisionDate}` : null,
    doc.publishedDate ? `published ${doc.publishedDate}` : null,
    doc.effectiveDate ? `effective ${doc.effectiveDate}` : null,
    doc.editionDate ? `edition ${doc.editionDate}` : null,
    !doc.decisionDate && !doc.publishedDate && doc.documentYear ? `year ${doc.documentYear}` : null,
  ].filter(Boolean);
  const summary = typeof doc.metadata.summary === "string" ? doc.metadata.summary : null;
  const end = doc.offset + doc.text.length;
  const lines = [
    LIBRARY_RESULT_HEADER,
    "",
    `${doc.title}${doc.citations.length ? `, ${doc.citations.join("; ")}` : ""}`,
    `document_id: ${doc.id} | ${[doc.court ?? doc.agency, ...dates, statusLabel(doc.precedentialStatus)].filter(Boolean).join(" | ")}`,
    `Source: ${doc.source.name} [${doc.source.code}], ${refreshLine(doc.source)}`,
    `Official URL (cite this): ${doc.officialUrl}`,
    `Library copy: version ${doc.version}, first collected ${day(doc.firstSeenAt)}, last checked against the source ${day(doc.lastCheckedAt)}.`,
    ...standingLines({ withdrawnAt: doc.withdrawnAt, supersededById: doc.supersededBy?.id ?? null }),
    ...(doc.supersededBy ? [`   Replaced by: ${doc.supersededBy.title} (document_id ${doc.supersededBy.id})${doc.supersededNote ? `. ${doc.supersededNote}` : ""}`] : []),
    ...(doc.textKind === "excerpt"
      ? [`Only an excerpt is kept: ${doc.source.licenseNote ?? "the source's terms restrict copying"}. Read the full text at the official URL.`]
      : []),
    ...(doc.textKind === "none" ? ["The official file has no text layer (a scan); the library holds no text for it. Read it at the official URL."] : []),
    ...(summary && doc.offset === 0 ? ["", "Summary or headnote as the source prints it:", summary] : []),
    "",
    doc.textChars > 0 ? `Text, characters ${doc.offset}-${end} of ${doc.textChars}:` : "",
    doc.text,
    "",
    doc.nextOffset !== null ? `[More text: call read_library_document with offset ${doc.nextOffset}.]` : doc.textChars > 0 ? "[End of the text.]" : "",
  ];
  const content = lines.join("\n").trim();
  if (!chargeRequestBytes(ctx, content)) {
    return { content: "This text does not fit: the conversation is too close to the API's request size limit. Ask for fewer characters (max_chars), or finish with what you have.", isError: true };
  }
  ctx.verificationLog.push(
    logEntry({
      action: "read",
      url: doc.officialUrl,
      title: doc.title,
      documentId: doc.id,
      source: doc.source,
      citation: doc.citations[0] ?? null,
      precedentialStatus: doc.precedentialStatus,
      textRange: `${doc.offset}-${end} of ${doc.textChars}`,
      content,
    })
  );
  return { content };
}

export function matchLines(match: CitationMatch, n: number): string[] {
  const how =
    match.matchedBy === "exact"
      ? "exact citation"
      : match.matchedBy === "pin_page"
        ? "the decision in that volume whose first page comes before your pin page: check the pin page in the text"
        : `similar, not exact (${Math.round((match.similarity ?? 0) * 100)}%): confirm it is the authority you mean`;
  return [
    `${n}. ${match.title}${match.citations.length ? `, ${match.citations.join("; ")}` : ""}`,
    `   document_id: ${match.id} | ${[match.court, match.date, statusLabel(match.precedentialStatus)].filter(Boolean).join(" | ")} | matched: ${how}`,
    `   Source: ${match.source.name} [${match.source.code}], ${refreshLine(match.source)}`,
    `   Official URL: ${match.officialUrl}`,
    ...(match.citedByCount ? [`   Cited by ${match.citedByCount}${match.citedByCount >= 1000 ? "+" : ""} document(s) in the library (search the citation to see them; the library does not track later treatment).`] : []),
    ...standingLines(match),
  ];
}

async function executeLookup(input: unknown, ctx: ToolExecutionContext) {
  const parsed = lookupInputSchema.safeParse(input);
  if (!parsed.success) return { content: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, isError: true };
  let result;
  try {
    result = await withGlobalReadContext((tx) => lookupCitation(tx, parsed.data.citation));
  } catch (err) {
    return { content: `The library lookup failed (${err instanceof Error ? err.message : String(err)}).`, isError: true };
  }
  const read = result.citation ? `Read as ${result.citation.kind === "other" ? "a name or a citation form the library does not parse" : `the citation ${result.citation.normalized}`}.` : "";
  if (result.matches.length === 0) {
    return {
      content: `${LIBRARY_RESULT_HEADER}\n\n${read} Not found in the library. That does not mean the authority does not exist: the library may not hold its source yet. If you have web tools, confirm it at the official site; otherwise mark it unverified.`,
    };
  }
  const content = [LIBRARY_RESULT_HEADER, "", read, "", ...result.matches.flatMap((m, i) => [...matchLines(m, i + 1), ""]), "A lookup confirms the citation and its official link, not what the authority holds: read it with read_library_document before relying on it."]
    .join("\n")
    .trim();
  if (!chargeRequestBytes(ctx, content)) {
    return { content: "The lookup result does not fit: the conversation is too close to the API's request size limit.", isError: true };
  }
  for (const match of result.matches) {
    ctx.verificationLog.push(
      logEntry({
        action: match.matchedBy === "exact" ? "lookup" : "search",
        url: match.officialUrl,
        title: match.title,
        documentId: match.id,
        source: match.source,
        citation: match.citations[0] ?? null,
        precedentialStatus: match.precedentialStatus,
        query: parsed.data.citation,
      })
    );
  }
  return { content };
}

const LIBRARY_SCOPE =
  "The library holds the official sources the app collects (shown on the app's Library page): BIA and Attorney General precedents, unpublished BIA and AAO decisions, federal court opinions, the INA and Title 8, immigration regulations and the Federal Register, the USCIS Policy Manual and guidance, forms and fees, TPS, the Foreign Affairs Manual, EOIR manuals and memoranda, other agency guidance, country conditions reports, oversight reports, treaties and the Visa Bulletin, as far as each has been collected.";

export const searchLibraryTool: SkillTool = {
  definition: {
    name: "search_library",
    description:
      "Search this app's own library of official immigration-law sources, kept as copies of the official documents collected directly from the government and court sites and refreshed daily. " +
      LIBRARY_SCOPE +
      " Use it before web_search for anything the library holds. Returns up to 10 results per call, each with its document_id, title and citations, court or agency, date, precedential status, a snippet, its official URL (the link to cite), and when its source was last refreshed (STALE when a refresh is overdue). Unpublished BIA and AAO decisions are labeled NON-PRECEDENTIAL. " +
      "A snippet is not the holding: read the document with read_library_document. Nothing you send leaves the app, but never put a client's name, A-number or other case detail in a query.",
    input_schema: toJsonSchemaObject(searchInputSchema) as Anthropic.Tool.InputSchema,
  },
  execute: executeSearch,
};

export const readLibraryDocumentTool: SkillTool = {
  definition: {
    name: "read_library_document",
    description:
      "Read a document from this app's library of official sources by the document_id search_library or lookup_library_citation gave: its title, citations, court or agency, dates, precedential status, the source's own summary or headnote, and its text as collected from the official site, up to 40,000 characters per call (call again with the offset it gives to read on). " +
      "The result gives the official URL to cite and when the source was last refreshed; quote only from the text it returns, and label a non-precedential decision as such. Every read is recorded in this run's verification log.",
    input_schema: toJsonSchemaObject(readInputSchema) as Anthropic.Tool.InputSchema,
  },
  execute: executeRead,
};

export const lookupLibraryCitationTool: SkillTool = {
  definition: {
    name: "lookup_library_citation",
    description:
      "Look up one citation in this app's library of official sources: I&N Dec. (with a pin page), Interim Decision numbers, U.S., F., F.2d, F.3d, F.4th, F. App'x and F. Supp. reports, U.S.C. and C.F.R. sections, INA sections, Fed. Reg. pages, AAO decision IDs, or a case name. " +
      "Returns the document that is that authority (exact match first; for a pin page, the decision whose first page precedes it; otherwise similar citations, flagged as not exact), with its official URL, precedential status, how many library documents cite it, and when its source was last refreshed. " +
      "Use it to confirm a citation before you rely on it; a citation it does not find is unverified, not wrong. Read the document with read_library_document before relying on what it holds.",
    input_schema: toJsonSchemaObject(lookupInputSchema) as Anthropic.Tool.InputSchema,
  },
  execute: executeLookup,
};
