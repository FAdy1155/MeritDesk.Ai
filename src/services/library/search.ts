import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { libraryCitations, libraryDocuments, libraryDocumentVersions, librarySources } from "@/db/schema";
import { extractCitations, normalizeCitation, type FoundCitation } from "./citations";
import { countryKey } from "./country";
import { resultRows, type LibraryDb } from "./db";
import { getLibraryGroup } from "./groups";

// Reading the library: full-text search, citation lookup and the document
// reader, for the /library pages and the skill runs' library tools. Every
// function takes the transaction it reads in; the app opens it with
// withGlobalReadContext (read only, no tenant, no service role), the PGlite
// check with its own. Nothing here reads a tenant table.

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;
/** Characters one readDocument call returns at most. */
export const MAX_READ_CHARS = 60_000;
/** The headline (snippet) is computed over at most this much of the text. */
const HEADLINE_TEXT_CHARS = 100_000;
const COUNT_CAP = 1_000;
/**
 * Matching documents ranked at most. ts_rank_cd reads each match's whole
 * vector, so a query matching more (a common word over the whole library)
 * is listed newest first instead, and the result says so.
 */
export const RANK_CAP = 5_000;
/** statement_timeout of one search (the /library search page and the skill runs' search_library tool). */
export const LIBRARY_SEARCH_TIMEOUT_MS = 5_000;

export type SourceFreshness = {
  code: string;
  name: string;
  groupCode: string;
  groupName: string;
  officialUrl: string;
  license: "public_domain" | "link_only";
  status: string;
  lastSuccessAt: Date | null;
  staleAfterHours: number;
  /** No successful run within staleAfterHours (or never). */
  stale: boolean;
};

function freshnessOf(row: {
  code: string;
  name: string;
  groupCode: string;
  officialUrl: string;
  license: "public_domain" | "link_only";
  status: string;
  lastSuccessAt: Date | null;
  freshness: unknown;
}, now = Date.now()): SourceFreshness {
  const hours = Number((row.freshness as { staleAfterHours?: unknown } | null)?.staleAfterHours);
  const staleAfterHours = Number.isFinite(hours) && hours > 0 ? hours : 48;
  return {
    code: row.code,
    name: row.name,
    groupCode: row.groupCode,
    groupName: getLibraryGroup(row.groupCode)?.name ?? row.groupCode,
    officialUrl: row.officialUrl,
    license: row.license,
    status: row.status,
    lastSuccessAt: row.lastSuccessAt,
    staleAfterHours,
    stale: !row.lastSuccessAt || now - row.lastSuccessAt.getTime() > staleAfterHours * 60 * 60 * 1000,
  };
}

const sourceColumns = {
  code: librarySources.code,
  name: librarySources.name,
  groupCode: librarySources.groupCode,
  officialUrl: librarySources.officialUrl,
  license: librarySources.license,
  status: librarySources.status,
  lastSuccessAt: librarySources.lastSuccessAt,
  freshness: librarySources.freshness,
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type LibrarySearchParams = {
  query: string;
  groups?: string[];
  sources?: string[];
  /** YYYY-MM-DD; compared with the decision, publication or effective date, else the stated year. */
  dateFrom?: string | null;
  dateTo?: string | null;
  precedentialOnly?: boolean;
  /** Matched against the court or agency, case-insensitively. */
  court?: string | null;
  /** The country a document is about ("Honduras", "Burma"), matched on metadata.countryKeys (./country.ts). */
  country?: string | null;
  includeWithdrawn?: boolean;
  limit?: number;
  offset?: number;
  /** The PGlite check only: a lower RANK_CAP, so a few fixtures exceed it. */
  rankCap?: number;
};

export type LibrarySearchHit = {
  id: string;
  sourceCode: string;
  externalId: string;
  docType: string;
  title: string;
  citations: string[];
  court: string | null;
  agency: string | null;
  date: string | null;
  documentYear: number | null;
  precedentialStatus: string;
  officialUrl: string;
  textKind: string;
  withdrawnAt: Date | null;
  supersededById: string | null;
  rank: number;
  /** A passage around the matches, with each match wrapped in [[ and ]]. */
  snippet: string;
  source: SourceFreshness;
  /** How the hit was found: the citation the query states, or full-text and title matching. */
  matchedBy: "citation" | "text" | "title_similarity";
};

export type LibrarySearchResult = {
  hits: LibrarySearchHit[];
  /** Matching documents, counted up to COUNT_CAP. */
  total: number;
  totalCapped: boolean;
  /** The citation the query was read as, when it states one. */
  citation: FoundCitation | null;
  /**
   * How the hits are ordered: by relevance, or newest first when more than
   * RANK_CAP documents match (a citation match still comes first).
   */
  order: "rank" | "date";
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Text for a LIKE pattern, its wildcards and escape character escaped. */
function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Filter conditions on the search queries' aliases: library_documents as d, library_sources unaliased. */
function filters(params: LibrarySearchParams): SQL[] {
  const where: SQL[] = [];
  if (!params.includeWithdrawn) where.push(sql`d.withdrawn_at is null`);
  if (params.sources?.length) where.push(sql`d.source_code in (${sql.join(params.sources.map((s) => sql`${s}`), sql`, `)})`);
  if (params.groups?.length) where.push(sql`${librarySources.groupCode} in (${sql.join(params.groups.map((g) => sql`${g}`), sql`, `)})`);
  if (params.precedentialOnly) where.push(sql`d.precedential_status = 'precedential'`);
  if (params.court?.trim()) {
    const pattern = `%${likeEscape(params.court.trim())}%`;
    where.push(sql`(d.court ilike ${pattern} or d.agency ilike ${pattern})`);
  }
  const country = countryKey(params.country?.trim());
  if (country) where.push(sql`d.metadata -> 'countryKeys' @> ${JSON.stringify([country])}::jsonb`);
  const dated = sql`coalesce(d.decision_date, d.published_date, d.effective_date, d.edition_date)`;
  if (params.dateFrom && ISO.test(params.dateFrom)) {
    where.push(sql`(${dated} >= ${params.dateFrom}::date or (${dated} is null and d.document_year >= ${Number(params.dateFrom.slice(0, 4))}))`);
  }
  if (params.dateTo && ISO.test(params.dateTo)) {
    where.push(sql`(${dated} <= ${params.dateTo}::date or (${dated} is null and d.document_year <= ${Number(params.dateTo.slice(0, 4))}))`);
  }
  return where;
}

type HitRow = {
  id: string;
  source_code: string;
  external_id: string;
  doc_type: string;
  title: string;
  citations: string[];
  court: string | null;
  agency: string | null;
  date: string | null;
  document_year: number | null;
  precedential_status: string;
  official_url: string;
  text_kind: string;
  withdrawn_at: Date | string | null;
  superseded_by_id: string | null;
  rank: number | string;
  snippet: string | null;
  matched_by: "citation" | "text" | "title_similarity";
};

function toDate(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

/**
 * Full-text search (websearch_to_tsquery: quoted phrases, OR, -word) ranked
 * by ts_rank_cd over the weighted vector, with a ts_headline snippet. A query
 * that states a citation puts the document that is that authority first. With
 * no full-text match, titles are matched by trigram similarity (case names
 * spelled differently).
 */
export async function searchLibrary(tx: LibraryDb, params: LibrarySearchParams): Promise<LibrarySearchResult> {
  const query = params.query.trim().slice(0, 500);
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
  const offset = Math.min(Math.max(params.offset ?? 0, 0), 10_000);
  const where = filters(params);
  const whereSql = where.length ? sql`and ${sql.join(where, sql` and `)}` : sql``;
  const citation = query ? extractCitations(query, 1, { citationOnlyForms: true })[0] ?? null : null;

  if (!query) {
    // No query: the newest documents matching the filters, in the order of
    // library_documents_newest_idx (0011); the page's rows are chosen
    // first, so only they are read whole.
    const rows = resultRows<HitRow>(
      await tx.execute(sql`
        with page as (
          select d.id, coalesce(d.decision_date, d.published_date, d.effective_date) as sort_date, d.first_seen_at
          from ${libraryDocuments} d join ${librarySources} on ${librarySources.code} = d.source_code
          where true ${whereSql}
          order by coalesce(d.decision_date, d.published_date, d.effective_date) desc nulls last, d.first_seen_at desc
          limit ${limit} offset ${offset}
        )
        select d.id, d.source_code, d.external_id, d.doc_type, d.title, d.citations, d.court, d.agency,
               coalesce(d.decision_date, d.published_date, d.effective_date, d.edition_date)::text as date,
               d.document_year, d.precedential_status, d.official_url, d.text_kind, d.withdrawn_at, d.superseded_by_id,
               0 as rank, left(coalesce(d.metadata->>'summary', d.text), 300) as snippet, 'text' as matched_by
        from page join ${libraryDocuments} d on d.id = page.id
        order by page.sort_date desc nulls last, page.first_seen_at desc`)
    );
    return { hits: await withSources(tx, rows), total: rows.length + offset, totalCapped: false, citation: null, order: "date" };
  }

  const ts = sql`websearch_to_tsquery('english', ${query})`;
  // Candidates from the GIN index and, when the query states a citation, the
  // document that is that authority (library_citations); then the filters.
  const citationIds = citation
    ? sql`select document_id from ${libraryCitations} where relation = 'self' and normalized = ${citation.normalized}`
    : sql`select null::uuid as document_id where false`;
  const candidates = sql`
    with cit as (${citationIds}),
    candidates as (
      select id from ${libraryDocuments} where search_vector @@ ${ts}
      union
      select document_id from cit
    )`;
  const rankCap = Math.min(Math.max(params.rankCap ?? RANK_CAP, 1), RANK_CAP);
  // How many documents match after the filters, up to rankCap + 1: the
  // total shown, and whether the matches are few enough to rank.
  const [count] = resultRows<{ n: number | string }>(
    await tx.execute(sql`
      ${candidates}
      select count(*) as n from (
        select 1 from candidates x
        join ${libraryDocuments} d on d.id = x.id
        join ${librarySources} on ${librarySources.code} = d.source_code
        where true ${whereSql}
        limit ${rankCap + 1}) y`)
  );
  const total = Number(count?.n ?? 0);
  const order: "rank" | "date" = total > rankCap ? "date" : "rank";
  const citationBonus = sql`case when d.id in (select document_id from cit) then 10 else 0 end`;
  const rankSql = order === "rank" ? sql`ts_rank_cd(d.search_vector, ${ts}, 32) + ${citationBonus}` : citationBonus;

  const rows = total === 0 ? [] : resultRows<HitRow>(
    await tx.execute(sql`
      ${candidates},
      matched as (
        select d.id,
               ${rankSql} as rank,
               case when d.id in (select document_id from cit) then 'citation' else 'text' end as matched_by
        from candidates x
        join ${libraryDocuments} d on d.id = x.id
        join ${librarySources} on ${librarySources.code} = d.source_code
        where true ${whereSql}
        order by rank desc, coalesce(d.decision_date, d.published_date, d.effective_date) desc nulls last, d.id
        limit ${limit} offset ${offset}
      )
      select d.id, d.source_code, d.external_id, d.doc_type, d.title, d.citations, d.court, d.agency,
             coalesce(d.decision_date, d.published_date, d.effective_date, d.edition_date)::text as date,
             d.document_year, d.precedential_status, d.official_url, d.text_kind, d.withdrawn_at, d.superseded_by_id,
             m.rank, m.matched_by,
             ts_headline('english', coalesce(nullif(d.metadata->>'summary', ''), '') || E'\n' || left(d.text, ${HEADLINE_TEXT_CHARS}), ${ts},
               'StartSel="[[", StopSel="]]", MaxFragments=2, MaxWords=30, MinWords=12, FragmentDelimiter=" ... "') as snippet
      from matched m join ${libraryDocuments} d on d.id = m.id
      order by m.rank desc, coalesce(d.decision_date, d.published_date, d.effective_date) desc nulls last, d.id`)
  );

  if (rows.length === 0 && offset === 0) {
    // No full-text match: titles by trigram similarity (a case name spelled differently).
    const similar = resultRows<HitRow>(
      await tx.execute(sql`
        select d.id, d.source_code, d.external_id, d.doc_type, d.title, d.citations, d.court, d.agency,
               coalesce(d.decision_date, d.published_date, d.effective_date, d.edition_date)::text as date,
               d.document_year, d.precedential_status, d.official_url, d.text_kind, d.withdrawn_at, d.superseded_by_id,
               similarity(d.title, ${query}) as rank, left(coalesce(d.metadata->>'summary', d.text), 300) as snippet,
               'title_similarity' as matched_by
        from ${libraryDocuments} d join ${librarySources} on ${librarySources.code} = d.source_code
        where d.title % ${query} ${whereSql}
        order by similarity(d.title, ${query}) desc, d.id
        limit ${limit}`)
    );
    return { hits: await withSources(tx, similar), total: similar.length, totalCapped: false, citation, order: "rank" };
  }
  return { hits: await withSources(tx, rows), total: Math.min(total, COUNT_CAP), totalCapped: total > COUNT_CAP, citation, order };
}

async function withSources(tx: LibraryDb, rows: HitRow[]): Promise<LibrarySearchHit[]> {
  const codes = [...new Set(rows.map((r) => r.source_code))];
  const sources = codes.length
    ? await tx.select(sourceColumns).from(librarySources).where(sql`${librarySources.code} in (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})`)
    : [];
  const byCode = new Map(sources.map((s) => [s.code, freshnessOf(s)]));
  return rows
    .filter((r) => byCode.has(r.source_code))
    .map((r) => ({
      id: r.id,
      sourceCode: r.source_code,
      externalId: r.external_id,
      docType: r.doc_type,
      title: r.title,
      citations: r.citations ?? [],
      court: r.court,
      agency: r.agency,
      date: r.date,
      documentYear: r.document_year,
      precedentialStatus: r.precedential_status,
      officialUrl: r.official_url,
      textKind: r.text_kind,
      withdrawnAt: toDate(r.withdrawn_at),
      supersededById: r.superseded_by_id,
      rank: Number(r.rank),
      snippet: (r.snippet ?? "").replace(/\s+/g, " ").trim(),
      source: byCode.get(r.source_code)!,
      matchedBy: r.matched_by,
    }));
}

// ---------------------------------------------------------------------------
// Citation lookup
// ---------------------------------------------------------------------------

export type CitationMatch = {
  id: string;
  title: string;
  citations: string[];
  officialUrl: string;
  precedentialStatus: string;
  date: string | null;
  court: string | null;
  withdrawnAt: Date | null;
  source: SourceFreshness;
  /** How it matched: the exact citation, the document whose first page comes before a pin page, or a similar citation or title. */
  matchedBy: "exact" | "pin_page" | "similar";
  similarity?: number;
  /** Documents in the library whose text cites this one (up to 1000). */
  citedByCount: number;
};

export type CitationLookupResult = {
  /** The citation as read (normalized form), or null when the text states none this file knows. */
  citation: FoundCitation | null;
  matches: CitationMatch[];
};

const PIN_KINDS = new Set(["ina_dec", "us", "f", "f_app", "f_supp", "fed_reg"]);

async function documentsByIds(tx: LibraryDb, ids: string[]) {
  if (ids.length === 0) return [];
  return tx
    .select({
      id: libraryDocuments.id,
      title: libraryDocuments.title,
      citations: libraryDocuments.citations,
      officialUrl: libraryDocuments.officialUrl,
      precedentialStatus: libraryDocuments.precedentialStatus,
      date: sql<string | null>`coalesce(${libraryDocuments.decisionDate}, ${libraryDocuments.publishedDate}, ${libraryDocuments.effectiveDate}, ${libraryDocuments.editionDate})::text`,
      court: libraryDocuments.court,
      withdrawnAt: libraryDocuments.withdrawnAt,
      sourceCode: libraryDocuments.sourceCode,
    })
    .from(libraryDocuments)
    .where(sql`${libraryDocuments.id} in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
}

async function citedByCounts(tx: LibraryDb, normalized: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const n of normalized) {
    const [row] = resultRows<{ n: number | string }>(
      await tx.execute(sql`select count(*) as n from (select 1 from ${libraryCitations} where normalized = ${n} and relation = 'cites' limit 1000) x`)
    );
    out.set(n, Number(row?.n ?? 0));
  }
  return out;
}

/**
 * The library document that is the authority `text` cites: exact on its
 * normalized citation; for a reporter citation with a pin page that names no
 * decision's first page, the decision in that volume whose first page is
 * the closest one before it; otherwise the most similar citations and titles
 * (trigram), flagged as such.
 */
export async function lookupCitation(tx: LibraryDb, text: string): Promise<CitationLookupResult> {
  const input = text.trim().slice(0, 300);
  const citation = input ? normalizeCitation(input) : null;
  if (!citation) return { citation: null, matches: [] };
  const found: { id: string; matchedBy: CitationMatch["matchedBy"]; similarity?: number; normalized: string }[] = [];

  if (citation.kind !== "other") {
    const exact = await tx
      .select({ documentId: libraryCitations.documentId })
      .from(libraryCitations)
      .where(and(eq(libraryCitations.normalized, citation.normalized), eq(libraryCitations.relation, "self")))
      .limit(10);
    for (const row of exact) found.push({ id: row.documentId, matchedBy: "exact", normalized: citation.normalized });

    if (found.length === 0 && PIN_KINDS.has(citation.kind) && citation.volume !== undefined && citation.page !== undefined) {
      const reporter = citation.normalized.replace(/^\d+\s+/, "").replace(/\s+\d+$/, "");
      const prefix = `${citation.volume} ${reporter} `;
      const sameVolume = await tx
        .select({ documentId: libraryCitations.documentId, normalized: libraryCitations.normalized })
        .from(libraryCitations)
        .where(and(eq(libraryCitations.relation, "self"), sql`${libraryCitations.normalized} like ${`${likeEscape(prefix)}%`}`))
        .limit(2000);
      let best: { documentId: string; normalized: string; page: number } | null = null;
      for (const row of sameVolume) {
        const page = Number(row.normalized.slice(prefix.length));
        if (Number.isInteger(page) && page <= citation.page && (!best || page > best.page)) best = { ...row, page };
      }
      if (best) found.push({ id: best.documentId, matchedBy: "pin_page", normalized: best.normalized });
    }
  }

  if (found.length === 0) {
    const similar = resultRows<{ document_id: string; normalized: string; sim: number | string }>(
      await tx.execute(sql`
        select document_id, normalized, similarity(normalized, ${citation.normalized}) as sim
        from ${libraryCitations}
        where relation = 'self' and normalized % ${citation.normalized}
        order by sim desc limit 5`)
    );
    for (const row of similar) found.push({ id: row.document_id, matchedBy: "similar", similarity: Number(row.sim), normalized: row.normalized });
    if (found.length === 0) {
      const titles = resultRows<{ id: string; sim: number | string }>(
        await tx.execute(sql`
          select id, similarity(title, ${input}) as sim from ${libraryDocuments}
          where title % ${input} order by sim desc limit 5`)
      );
      for (const row of titles) found.push({ id: row.id, matchedBy: "similar", similarity: Number(row.sim), normalized: "" });
    }
  }

  const docs = await documentsByIds(tx, [...new Set(found.map((f) => f.id))]);
  const sources = docs.length
    ? await tx.select(sourceColumns).from(librarySources).where(sql`${librarySources.code} in (${sql.join([...new Set(docs.map((d) => d.sourceCode))].map((c) => sql`${c}`), sql`, `)})`)
    : [];
  const sourceByCode = new Map(sources.map((s) => [s.code, freshnessOf(s)]));
  const counts = await citedByCounts(tx, [...new Set(found.map((f) => f.normalized).filter(Boolean))]);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const seen = new Set<string>();
  const matches: CitationMatch[] = [];
  for (const f of found) {
    const doc = byId.get(f.id);
    const source = doc ? sourceByCode.get(doc.sourceCode) : undefined;
    if (!doc || !source || seen.has(f.id)) continue;
    seen.add(f.id);
    matches.push({
      id: doc.id,
      title: doc.title,
      citations: doc.citations,
      officialUrl: doc.officialUrl,
      precedentialStatus: doc.precedentialStatus,
      date: doc.date,
      court: doc.court,
      withdrawnAt: doc.withdrawnAt,
      source,
      matchedBy: f.matchedBy,
      ...(f.similarity !== undefined ? { similarity: f.similarity } : {}),
      citedByCount: f.normalized ? counts.get(f.normalized) ?? 0 : 0,
    });
  }
  return { citation, matches };
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export type LibraryDocumentView = {
  id: string;
  sourceCode: string;
  externalId: string;
  docType: string;
  title: string;
  citations: string[];
  court: string | null;
  agency: string | null;
  decisionDate: string | null;
  publishedDate: string | null;
  effectiveDate: string | null;
  editionDate: string | null;
  documentYear: number | null;
  precedentialStatus: string;
  officialUrl: string;
  originalUrl: string | null;
  hasOriginal: boolean;
  textKind: string;
  textChars: number;
  metadata: Record<string, unknown>;
  version: number;
  firstSeenAt: Date;
  lastCheckedAt: Date;
  lastChangedAt: Date;
  withdrawnAt: Date | null;
  withdrawnReason: string | null;
  supersededBy: { id: string; title: string } | null;
  supersededNote: string | null;
  source: SourceFreshness & { licenseNote: string | null; coverage: string };
  /** The slice asked for. */
  text: string;
  offset: number;
  /** The offset of the next slice, or null at the end. */
  nextOffset: number | null;
  versions: { version: number; validFrom: Date; replacedAt: Date; textSha256: string }[];
};

/** One document with a slice of its text (offset, at most `length` characters, capped at MAX_READ_CHARS). */
export async function readDocument(tx: LibraryDb, id: string, offset = 0, length = MAX_READ_CHARS): Promise<LibraryDocumentView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const start = Math.max(0, Math.floor(offset));
  const count = Math.min(Math.max(1, Math.floor(length)), MAX_READ_CHARS);
  const [row] = await tx
    .select({
      id: libraryDocuments.id,
      sourceCode: libraryDocuments.sourceCode,
      externalId: libraryDocuments.externalId,
      docType: libraryDocuments.docType,
      title: libraryDocuments.title,
      citations: libraryDocuments.citations,
      court: libraryDocuments.court,
      agency: libraryDocuments.agency,
      decisionDate: libraryDocuments.decisionDate,
      publishedDate: libraryDocuments.publishedDate,
      effectiveDate: libraryDocuments.effectiveDate,
      editionDate: libraryDocuments.editionDate,
      documentYear: libraryDocuments.documentYear,
      precedentialStatus: libraryDocuments.precedentialStatus,
      officialUrl: libraryDocuments.officialUrl,
      originalUrl: libraryDocuments.originalUrl,
      originalS3Key: libraryDocuments.originalS3Key,
      textKind: libraryDocuments.textKind,
      textChars: libraryDocuments.textChars,
      metadata: libraryDocuments.metadata,
      version: libraryDocuments.version,
      firstSeenAt: libraryDocuments.firstSeenAt,
      lastCheckedAt: libraryDocuments.lastCheckedAt,
      lastChangedAt: libraryDocuments.lastChangedAt,
      withdrawnAt: libraryDocuments.withdrawnAt,
      withdrawnReason: libraryDocuments.withdrawnReason,
      supersededById: libraryDocuments.supersededById,
      supersededNote: libraryDocuments.supersededNote,
      // substr is 1-based; only the slice leaves the database.
      text: sql<string>`substr(${libraryDocuments.text}, ${start + 1}, ${count})`,
    })
    .from(libraryDocuments)
    .where(eq(libraryDocuments.id, id))
    .limit(1);
  if (!row) return null;
  const [source] = await tx
    .select({ ...sourceColumns, licenseNote: librarySources.licenseNote, coverage: librarySources.coverage })
    .from(librarySources)
    .where(eq(librarySources.code, row.sourceCode));
  if (!source) return null;
  const supersededBy = row.supersededById
    ? (await tx.select({ id: libraryDocuments.id, title: libraryDocuments.title }).from(libraryDocuments).where(eq(libraryDocuments.id, row.supersededById)))[0] ?? null
    : null;
  const versions = await tx
    .select({
      version: libraryDocumentVersions.version,
      validFrom: libraryDocumentVersions.validFrom,
      replacedAt: libraryDocumentVersions.replacedAt,
      textSha256: libraryDocumentVersions.textSha256,
    })
    .from(libraryDocumentVersions)
    .where(eq(libraryDocumentVersions.documentId, id))
    .orderBy(desc(libraryDocumentVersions.version));
  const end = start + row.text.length;
  return {
    ...row,
    hasOriginal: Boolean(row.originalS3Key),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    supersededBy,
    source: { ...freshnessOf(source), licenseNote: source.licenseNote, coverage: source.coverage },
    offset: start,
    nextOffset: end < row.textChars ? end : null,
    versions,
  };
}

/** The stored original's key and type, for the reader's file link (null when none is stored). */
export async function documentOriginal(tx: LibraryDb, id: string): Promise<{ key: string; contentType: string | null } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await tx
    .select({ key: libraryDocuments.originalS3Key, contentType: libraryDocuments.originalContentType })
    .from(libraryDocuments)
    .where(eq(libraryDocuments.id, id))
    .limit(1);
  return row?.key ? { key: row.key, contentType: row.contentType } : null;
}

// ---------------------------------------------------------------------------
// Sources (the /library page)
// ---------------------------------------------------------------------------

export type LibrarySourceStatusRow = SourceFreshness & {
  description: string;
  coverage: string;
  cadence: string;
  licenseNote: string | null;
  statusDetail: string | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  documentCount: number;
  freshness: Record<string, unknown>;
};

export async function listSources(tx: LibraryDb): Promise<LibrarySourceStatusRow[]> {
  const rows = await tx.select().from(librarySources).orderBy(asc(librarySources.groupCode), asc(librarySources.name));
  return rows.map((r) => ({
    ...freshnessOf(r),
    description: r.description,
    coverage: r.coverage,
    cadence: r.cadence,
    licenseNote: r.licenseNote,
    statusDetail: r.statusDetail,
    lastAttemptAt: r.lastAttemptAt,
    lastError: r.lastError,
    documentCount: r.documentCount,
    freshness: (r.freshness ?? {}) as Record<string, unknown>,
  }));
}
