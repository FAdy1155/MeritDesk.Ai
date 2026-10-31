import Link from "next/link";
import { getCurrentTenant } from "@/lib/tenant";
import { LIBRARY_GROUPS, LIBRARY_SECTIONS, type LibraryGroup } from "@/services/library/groups";
import { isLibraryImportAdmin } from "@/services/library/import-service";
import { loadLibrarySources } from "@/services/library/service";
import { backfillInProgress, groupBadge, manualImportStatus, sourceBadge } from "@/services/library/status";
import type { LibrarySourceStatusRow } from "@/services/library/search";
import { formatUtc, muted, OfficialLink, StatusBadgeView, ToneBadge } from "./ui";

// The library's groups, in the order and words of the catalog the firm
// chose its sources from (src/services/library/groups.ts), with the app's
// own counts, update dates, statuses and official links (library_sources,
// written by the worker). Read-only for every role; the platform's
// operators (LIBRARY_IMPORT_ADMINS) also get the link to import the sources
// whose sites refuse automated tools (/library/import).

export default async function LibraryPage() {
  const { userId } = await getCurrentTenant();
  const canImport = isLibraryImportAdmin(userId);
  let sources: LibrarySourceStatusRow[] = [];
  let loadError: string | null = null;
  try {
    sources = await loadLibrarySources();
  } catch {
    loadError = "The library's status could not be read. If the database was just updated, run the migrations (npm run db:migrate).";
  }
  const byGroup = new Map<string, LibrarySourceStatusRow[]>();
  for (const s of sources) byGroup.set(s.groupCode, [...(byGroup.get(s.groupCode) ?? []), s]);
  const total = sources.reduce((n, s) => n + s.documentCount, 0);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Library</h1>
        <p className={`text-sm ${muted}`}>
          The app&apos;s own copy of the public, official sources of immigration law: decisions, statutes and regulations,
          agency manuals and guidance, collected directly from the government and court sites and refreshed every day.
          Skill runs search and read it with their library tools and cite each document by its official link. The
          official copy is always the one to cite; a count is a count of records, not a certification that a collection
          is complete.
        </p>
        <p className={`text-sm ${muted}`}>
          {total.toLocaleString("en-US")} documents in {sources.length} collected source{sources.length === 1 ? "" : "s"}.
        </p>
        <form action="/library/search" className="flex gap-2">
          <input
            name="q"
            type="search"
            placeholder="Search the library: words, a quoted phrase, or a citation such as 27 I&N Dec. 316"
            className="flex-1 rounded-md border border-black/20 bg-transparent px-3 py-1.5 text-sm dark:border-white/20"
          />
          <button type="submit" className="rounded-md bg-black px-3 py-1.5 text-sm text-white dark:bg-white dark:text-black">
            Search
          </button>
        </form>
        {canImport && (
          <p className="text-sm">
            <Link href="/library/import" className="underline">
              Import from official site
            </Link>{" "}
            <span className={muted}>(for the sources whose websites refuse automated tools)</span>
          </p>
        )}
        {loadError && <p className="text-sm text-red-700 dark:text-red-300">{loadError}</p>}
      </div>

      {LIBRARY_SECTIONS.map(({ section, intro }) => (
        <section key={section} className="flex flex-col gap-3">
          <div>
            <h2 className="text-lg font-semibold">{section}</h2>
            <p className={`text-sm ${muted}`}>{intro}</p>
          </div>
          {LIBRARY_GROUPS.filter((g) => g.section === section).map((group) => (
            <GroupCard key={group.code} group={group} sources={byGroup.get(group.code) ?? []} />
          ))}
        </section>
      ))}
    </div>
  );
}

function GroupCard({ group, sources }: { group: LibraryGroup; sources: LibrarySourceStatusRow[] }) {
  const badge = groupBadge(group, sources);
  const count = sources.reduce((n, s) => n + s.documentCount, 0);
  const lastSuccess = sources.reduce<Date | null>((latest, s) => (s.lastSuccessAt && (!latest || s.lastSuccessAt > latest) ? s.lastSuccessAt : latest), null);
  const collecting = sources.some(backfillInProgress);
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-black/10 p-4 text-sm dark:border-white/10">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{group.name}</h3>
        <StatusBadgeView badge={badge} />
        {collecting && <ToneBadge label="Collecting history" tone="gray" title="Earlier documents are still being collected in the background." />}
      </div>
      <p>{group.description}</p>
      {group.scopeNote && <p className={muted}>{group.scopeNote}</p>}
      {group.partlyPlanned && <p className="text-amber-800 dark:text-amber-200">{group.partlyPlanned}</p>}
      <dl className={`grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs ${muted}`}>
        <dt>Coverage</dt>
        <dd>{group.coverage ?? "Not stated"}</dd>
        <dt>Refreshed</dt>
        <dd>{group.cadence ?? "Not stated"}</dd>
        {!group.planned && (
          <>
            <dt>Documents</dt>
            <dd>{sources.length ? count.toLocaleString("en-US") : "none yet"}</dd>
            <dt>Last successful update</dt>
            <dd>{sources.length ? formatUtc(lastSuccess) : "not yet collected"}</dd>
          </>
        )}
      </dl>
      {sources.length > 0 && (
        <ul className="flex flex-col gap-2 border-t border-black/10 pt-2 dark:border-white/10">
          {sources.map((s) => (
            <SourceRow key={s.code} source={s} />
          ))}
        </ul>
      )}
      {sources.length > 0 && (
        <p className="text-xs">
          <Link href={`/library/search?group=${group.code}`} className="underline">
            Browse this group
          </Link>
        </p>
      )}
      {group.code === "eoir-statistics" && (
        <p className="text-xs">
          <Link href="/library/eoir-statistics" className="underline">
            Open the judge and court statistics
          </Link>
        </p>
      )}
    </article>
  );
}

function SourceRow({ source }: { source: LibrarySourceStatusRow }) {
  const badge = sourceBadge(source);
  const manual = manualImportStatus(source);
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{source.name}</span>
        {manual ? (
          <>
            <ToneBadge label="Manual import" tone="gray" title={badge.detail} />
            {manual.overdue && (
              <ToneBadge
                label={manual.lastImportAt ? "Overdue" : "Not imported yet"}
                tone="amber"
                title={manual.intervalDays ? `No import in the last ${manual.intervalDays} days.` : null}
              />
            )}
          </>
        ) : (
          <StatusBadgeView badge={badge} />
        )}
        {source.license === "link_only" && <ToneBadge label="Excerpts and links only" tone="gray" title={source.licenseNote} />}
      </div>
      <p className={`text-xs ${muted}`}>{source.description}</p>
      <p className={`text-xs ${muted}`}>
        Collected: {source.coverage}.{" "}
        {manual ? (
          <>
            Refreshed: by import from the official site, about every {manual.intervalDays ?? "few"} days (the site refuses automated tools).{" "}
            {source.documentCount.toLocaleString("en-US")} documents; last import {formatUtc(manual.lastImportAt)}.
          </>
        ) : (
          <>
            Refreshed: {source.cadence}. {source.documentCount.toLocaleString("en-US")} documents; last successful update {formatUtc(source.lastSuccessAt)}.
          </>
        )}
      </p>
      {!manual && badge.detail && badge.tone !== "green" && <p className="text-xs text-amber-800 dark:text-amber-200">{badge.detail}</p>}
      {source.license === "link_only" && source.licenseNote && <p className={`text-xs ${muted}`}>{source.licenseNote}</p>}
      <p className="text-xs">
        Official site: <OfficialLink url={source.officialUrl} />
      </p>
    </li>
  );
}
