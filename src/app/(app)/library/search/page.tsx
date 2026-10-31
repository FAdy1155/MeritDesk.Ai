import Link from "next/link";
import { isQueryCanceledError } from "@/lib/errors/safe-error";
import { getCurrentTenant } from "@/lib/tenant";
import { getLibraryGroup, isLibraryGroupCode, LIBRARY_GROUPS } from "@/services/library/groups";
import { loadLibrarySources, searchLibraryForPage } from "@/services/library/service";
import type { LibrarySearchResult, LibrarySourceStatusRow } from "@/services/library/search";
import { formatUtc, muted, OfficialLink, precedentialBadge, Snippet, ToneBadge } from "../ui";

// Full-text search of the library (searchLibrary in src/services/library/
// search.ts), with the same filters the skill runs' search_library tool
// takes. A GET form, so every search is a link. Read-only for every role.

const PAGE_SIZE = 20;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

function isoDate(value: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export default async function LibrarySearchPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await getCurrentTenant();
  const params = await searchParams;
  const q = first(params.q).slice(0, 500);
  const group = isLibraryGroupCode(first(params.group)) ? first(params.group) : "";
  const source = first(params.source).slice(0, 80);
  const from = isoDate(first(params.from));
  const to = isoDate(first(params.to));
  const precedential = first(params.precedential) === "1";
  const court = first(params.court).slice(0, 200);
  const country = first(params.country).slice(0, 80);
  const offset = Math.min(Math.max(Number(first(params.offset)) || 0, 0), 1000);
  const hasFilter = Boolean(group || source || from || to || precedential || court || country);

  let sources: LibrarySourceStatusRow[] = [];
  let result: LibrarySearchResult | null = null;
  let error: string | null = null;
  try {
    sources = await loadLibrarySources();
    if (q || hasFilter) {
      result = await searchLibraryForPage({
        query: q,
        groups: group ? [group] : undefined,
        sources: source ? [source] : undefined,
        dateFrom: from,
        dateTo: to,
        precedentialOnly: precedential,
        court: court || null,
        country: country || null,
        limit: PAGE_SIZE,
        offset,
      });
    }
  } catch (err) {
    error = isQueryCanceledError(err)
      ? "The search could not be run: it took too long. Add words, a source, a court or a date range to narrow it, and try again."
      : "The search could not be run. Check the query (unbalanced quotes are fine; very long queries are cut) and try again.";
  }

  const pageHref = (nextOffset: number) => {
    const search = new URLSearchParams();
    if (q) search.set("q", q);
    if (group) search.set("group", group);
    if (source) search.set("source", source);
    if (from) search.set("from", from);
    if (to) search.set("to", to);
    if (precedential) search.set("precedential", "1");
    if (court) search.set("court", court);
    if (country) search.set("country", country);
    if (nextOffset) search.set("offset", String(nextOffset));
    return `/library/search?${search.toString()}`;
  };
  const input = "rounded-md border border-black/20 bg-transparent px-2 py-1 text-sm dark:border-white/20";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <p className="text-sm">
          <Link href="/library" className="underline">
            Library
          </Link>{" "}
          / Search
        </p>
        <h1 className="text-xl font-semibold">Search the library</h1>
        <p className={`text-sm ${muted}`}>
          Words, a &quot;quoted phrase&quot;, alternatives with OR, -word to leave one out, or a citation (27 I&amp;N Dec. 316,
          8 C.F.R. 1003.38, INA 240A). A citation puts the document that is that authority first.
        </p>
      </div>

      <form action="/library/search" className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 text-sm dark:border-white/10">
        <div className="flex gap-2">
          <input name="q" type="search" defaultValue={q} placeholder="Search" className={`flex-1 ${input}`} />
          <button type="submit" className="rounded-md bg-black px-3 py-1 text-sm text-white dark:bg-white dark:text-black">
            Search
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1">
            Group
            <select name="group" defaultValue={group} className={input}>
              <option value="">All</option>
              {LIBRARY_GROUPS.filter((g) => !g.planned).map((g) => (
                <option key={g.code} value={g.code}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            Source
            <select name="source" defaultValue={source} className={input}>
              <option value="">All</option>
              {sources.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            From
            <input name="from" type="date" defaultValue={from ?? ""} className={input} />
          </label>
          <label className="flex items-center gap-1">
            To
            <input name="to" type="date" defaultValue={to ?? ""} className={input} />
          </label>
          <label className="flex items-center gap-1">
            Court or agency
            <input name="court" type="text" defaultValue={court} className={`w-44 ${input}`} />
          </label>
          <label className="flex items-center gap-1">
            Country
            <input name="country" type="text" defaultValue={country} className={`w-36 ${input}`} />
          </label>
          <label className="flex items-center gap-1">
            <input name="precedential" type="checkbox" value="1" defaultChecked={precedential} />
            Precedential only
          </label>
        </div>
      </form>

      {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      {!result && !error && <p className={`text-sm ${muted}`}>Enter a search, or choose a group or source to browse its newest documents.</p>}

      {result && (
        <div className="flex flex-col gap-3">
          <p className={`text-sm ${muted}`}>
            {result.hits.length === 0
              ? "No document matches."
              : q
                ? `Showing ${offset + 1}-${offset + result.hits.length} of ${result.total.toLocaleString("en-US")}${result.totalCapped ? "+" : ""}.`
                : `Newest documents, ${offset + 1}-${offset + result.hits.length}.`}
            {result.citation && result.citation.kind !== "other" ? ` Read as the citation ${result.citation.normalized}.` : ""}
            {result.hits.some((h) => h.matchedBy === "title_similarity") ? " No word matched; these titles are similar to the search." : ""}
            {q && result.order === "date" && result.hits.length > 0 ? " Too many documents match to rank them by relevance, so they are listed newest first; add words or filters to narrow the search." : ""}
          </p>
          {result.hits.map((hit) => {
            const precedent = precedentialBadge(hit.precedentialStatus);
            const groupName = getLibraryGroup(hit.source.groupCode)?.name ?? hit.source.groupCode;
            return (
              <article key={hit.id} className="flex flex-col gap-1 rounded-lg border border-black/10 p-3 text-sm dark:border-white/10">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/library/documents/${hit.id}`} className="font-semibold underline">
                    {hit.title}
                  </Link>
                  {precedent && <ToneBadge label={precedent.label} tone={precedent.tone} />}
                  {hit.matchedBy === "citation" && <ToneBadge label="Citation match" tone="green" />}
                  {hit.withdrawnAt && <ToneBadge label="Withdrawn" tone="red" />}
                  {hit.supersededById && <ToneBadge label="Superseded" tone="amber" />}
                  {hit.source.stale && <ToneBadge label="Source stale" tone="amber" title={`Last successful update ${formatUtc(hit.source.lastSuccessAt)}`} />}
                </div>
                {hit.citations.length > 0 && <p>{hit.citations.join("; ")}</p>}
                <p className={`text-xs ${muted}`}>
                  {[hit.court ?? hit.agency, hit.date ?? (hit.documentYear ? String(hit.documentYear) : null), hit.source.name, groupName]
                    .filter(Boolean)
                    .join(" | ")}
                </p>
                {hit.snippet && (
                  <p className="text-sm">
                    <Snippet text={hit.snippet} />
                  </p>
                )}
                <p className="text-xs">
                  Official: <OfficialLink url={hit.officialUrl} />
                </p>
              </article>
            );
          })}
          <div className="flex gap-4 text-sm">
            {offset > 0 && (
              <Link href={pageHref(Math.max(0, offset - PAGE_SIZE))} className="underline">
                Previous
              </Link>
            )}
            {result.hits.length === PAGE_SIZE && (q ? offset + PAGE_SIZE < result.total : true) && (
              <Link href={pageHref(offset + PAGE_SIZE)} className="underline">
                Next
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
