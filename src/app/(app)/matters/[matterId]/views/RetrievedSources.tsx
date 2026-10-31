import type { ReactNode } from "react";
import {
  classifyCitedUrls,
  readVerificationLog,
  summarizeLibraryUse,
  summarizeRetrievedSources,
  type CitedUrlStatus,
  type LibraryUse,
  type VerificationLogEntry,
} from "@/services/skill-runner/verification-log";
import { Badge, Muted, Section, type Tone } from "./primitives";

// Shown under every run whose report cites a URL or whose tools touched the
// web: the run's verification log is written by the app as the tools run,
// so it is the record of what was really retrieved, independent of what the
// report says. Rendered by SkillRunPanel for any skill; no skill opts in.

const citedLabel: Record<CitedUrlStatus, { label: string; tone: Tone }> = {
  fetched: { label: "retrieved in this run", tone: "green" },
  library: { label: "read from the library in this run", tone: "green" },
  search_result_only: { label: "search result only", tone: "amber" },
  not_retrieved: { label: "not retrieved in this run", tone: "red" },
};

const sourceLabel: Record<string, string> = {
  fetch_uscis_page: "government page",
  web_fetch: "web page",
  web_search: "search result",
};

/** A link only for http(s); anything else (the log holds web content) is shown as text. */
function SourceLink({ url, children }: { url: string; children?: ReactNode }) {
  if (!/^https?:\/\//i.test(url)) return <span className="break-all">{children ?? url}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="break-all underline">
      {children ?? url}
    </a>
  );
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

const libraryUseLabel: Record<LibraryUse["use"], string> = {
  read: "text read",
  lookup: "citation confirmed",
  search: "search result only",
};

function LibraryLine({ use }: { use: LibraryUse }) {
  return (
    <li>
      <SourceLink url={use.url}>{use.title || use.url}</SourceLink>
      {use.citation ? <span>, {use.citation}</span> : null}{" "}
      {/^[0-9a-f-]{36}$/i.test(use.documentId) ? (
        <>
          <a href={`/library/documents/${use.documentId}`} className="text-xs underline">
            library copy
          </a>{" "}
        </>
      ) : null}
      <Muted>
        ({libraryUseLabel[use.use]}; {use.source ?? "library"}, refreshed {use.sourceRefreshedAt ? day(use.sourceRefreshedAt) : "never"})
      </Muted>
      {use.sourceStale ? <> <Badge label="source stale" tone="amber" /></> : null}
      {use.precedentialStatus === "non_precedential" ? <> <Badge label="non-precedential" tone="amber" /></> : null}
    </li>
  );
}

function EntryLine({ entry }: { entry: VerificationLogEntry }) {
  return (
    <li>
      <SourceLink url={entry.url}>{entry.title || entry.url}</SourceLink>{" "}
      <Muted>
        ({sourceLabel[entry.source ?? "fetch_uscis_page"]}, {day(entry.fetchedAt)}
        {entry.pageAge ? `, dated ${entry.pageAge}` : ""}
        {entry.requestedUrl ? `, redirected from ${entry.requestedUrl}` : ""})
      </Muted>
    </li>
  );
}

export function RetrievedSources({ verificationLog, output }: { verificationLog: unknown; output: unknown }) {
  const log = readVerificationLog(verificationLog);
  const cited = output ? classifyCitedUrls(output, log) : [];
  if (log.length === 0 && cited.length === 0) return null;
  const { fetched, searchResults, failed } = summarizeRetrievedSources(log);
  const library = summarizeLibraryUse(log);
  const libraryUsed = library.filter((u) => u.use !== "search");
  const librarySeen = library.filter((u) => u.use === "search");

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-black/10 pt-3 text-sm dark:border-white/10">
      {cited.length > 0 && (
        <Section title="URLs cited in this report">
          <p className="mb-1 text-xs text-black/60 dark:text-white/60">
            Checked against what this run actually opened, on the web or in the app&apos;s library. A URL not retrieved in
            this run was cited from the case file or from memory; open it and confirm it before relying on it.
          </p>
          <ul className="flex flex-col gap-1">
            {cited.map(({ url, status }) => (
              <li key={url} className="flex items-start gap-2">
                <Badge label={citedLabel[status].label} tone={citedLabel[status].tone} />
                <SourceLink url={url} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {libraryUsed.length > 0 && (
        <Section title={`Library documents used in this run (${libraryUsed.length})`}>
          <p className="mb-1 text-xs text-black/60 dark:text-white/60">
            Read from the app&apos;s own copy of the official source; the link is the official URL. The refresh date is when
            the app last checked that source.
          </p>
          <ul className="flex list-inside list-disc flex-col gap-1">
            {libraryUsed.map((use) => (
              <LibraryLine key={use.documentId} use={use} />
            ))}
          </ul>
        </Section>
      )}

      {librarySeen.length > 0 && (
        <details>
          <summary className="cursor-pointer font-medium">Library search results seen but not opened ({librarySeen.length})</summary>
          <ul className="mt-1 flex list-inside list-disc flex-col gap-1">
            {librarySeen.map((use) => (
              <LibraryLine key={use.documentId} use={use} />
            ))}
          </ul>
        </details>
      )}

      {fetched.length > 0 && (
        <Section title={`Pages retrieved in this run (${fetched.length})`}>
          <ul className="flex list-inside list-disc flex-col gap-1">
            {fetched.map((entry) => (
              <EntryLine key={`${entry.url}-${entry.fetchedAt}`} entry={entry} />
            ))}
          </ul>
        </Section>
      )}

      {searchResults.length > 0 && (
        <details>
          <summary className="cursor-pointer font-medium">
            Search results seen but not opened ({searchResults.length})
          </summary>
          <ul className="mt-1 flex list-inside list-disc flex-col gap-1">
            {searchResults.map((entry) => (
              <EntryLine key={`${entry.url}-${entry.fetchedAt}`} entry={entry} />
            ))}
          </ul>
        </details>
      )}

      {failed.length > 0 && (
        <details>
          <summary className="cursor-pointer font-medium">Retrievals that failed ({failed.length})</summary>
          <ul className="mt-1 flex list-inside list-disc flex-col gap-1">
            {failed.map((entry, i) => (
              <li key={i}>
                {entry.url ? <SourceLink url={entry.url} /> : <span>search &quot;{entry.query ?? ""}&quot;</span>}{" "}
                <Muted>({String(entry.status).replace(/_/g, " ")})</Muted>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
