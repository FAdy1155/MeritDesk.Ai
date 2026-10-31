import { LibraryLayoutError, type LibraryHttp } from "../../types";
import { CASE_TABLES, EoirStatsAggregator, LOOKUP_TABLES, type AggregateResult } from "./aggregate";
import { FOIA_LIBRARY_URL, parseFoiaLibraryPage, type FoiaLibraryLinks } from "./parse";
import { entriesUnder, readReleaseDirectory, readSmallEntries, streamEntry, streamLines, type ReleaseDirectory } from "./release";
import { releaseFolder } from "./zip";

// Reads EOIR's current case data release and aggregates it (./aggregate.ts):
// the FOIA library page for the link (never a constructed URL), the
// archive's central directory, the lookup tables in one range request, then
// the four case tables streamed in 32 MB range requests (about 1.2 GB of
// the 4.5 GB archive; tbl_schedule, motions, charges and bonds are never
// read). Memory stays bounded: the tables are never held, only the
// aggregates and the packed per-proceeding join keys. No database: the job
// (./jobs.ts) writes the result with ./store.ts.

export type CurrentRelease = {
  links: FoiaLibraryLinks;
  pageUrl: string;
  release: ReleaseDirectory;
  folder: string | null;
  /** The date the release's folder name states ("EOIR Case Data 2026-0901" -> 2026-09-01), else null. */
  dataDate: string | null;
};

export async function readCurrentRelease(http: LibraryHttp): Promise<CurrentRelease> {
  const { text, response } = await http.getText(FOIA_LIBRARY_URL, { expect: "html" });
  const links = parseFoiaLibraryPage(text, response.url);
  if (!links) throw new LibraryLayoutError(FOIA_LIBRARY_URL, 'no "EOIR Case Data" link to a .zip file');
  const read = await readReleaseDirectory(http, links.caseData.url);
  if (read.notModified) throw new Error("unreachable: no conditional request was sent");
  const { folder, date } = releaseFolder(read.entries);
  return { links, pageUrl: response.url, release: read, folder, dataDate: date };
}

export type AggregateOptions = {
  signal?: AbortSignal;
  note: (message: string) => void;
  log?: (message: string) => void;
  /** Local tests only: read this many compressed bytes of each case table (a prefix), never the whole table. */
  maxCompressedBytesPerTable?: number;
};

export async function aggregateRelease(http: LibraryHttp, current: CurrentRelease, options: AggregateOptions): Promise<AggregateResult> {
  const { release } = current;
  const caseFiles = entriesUnder(release, "EOIR Case Data");
  const lookupFiles = entriesUnder(release, "Lookup");
  const missing = Object.values(CASE_TABLES).filter((f) => !caseFiles.has(f));
  if (missing.length) throw new LibraryLayoutError(release.url, `the release has no ${missing.join(", ")} in its "EOIR Case Data" folder`);

  const aggregator = new EoirStatsAggregator();
  const wantedLookups = Object.values(LOOKUP_TABLES)
    .map((t) => lookupFiles.get(t.file))
    .filter((e) => e !== undefined);
  const lookupBytes = await readSmallEntries(http, release, wantedLookups);
  aggregator.loadLookups(new Map([...lookupBytes].map(([name, bytes]) => [name.split("/").pop()!, bytes])), options.note);

  const prefix = options.maxCompressedBytesPerTable;
  for (const name of ["reps", "proceedings", "applications", "appeals"] as const) {
    const entry = caseFiles.get(CASE_TABLES[name])!;
    const started = Date.now();
    let lastLog = 0;
    const chunks = streamEntry(http, release, entry, {
      signal: options.signal,
      maxCompressedBytes: prefix,
      onProgress: (read, total) => {
        if (options.log && Date.now() - lastLog > 60_000) {
          lastLog = Date.now();
          options.log(`${entry.name}: ${Math.round((read / total) * 100)}% of ${total} compressed bytes`);
        }
      },
    });
    const counts = await aggregator.consume(name, streamLines(chunks, { complete: prefix === undefined || prefix >= entry.compressedSize }));
    // Memory after each table, so a full load shows its real footprint (the counts' indexes are typed arrays, outside the V8 heap).
    const mem = process.memoryUsage();
    const mb = (n: number) => Math.round(n / (1024 * 1024));
    options.log?.(
      `${CASE_TABLES[name]}: ${counts.rows} rows (${counts.used} used, ${counts.malformed} malformed) in ${Math.round((Date.now() - started) / 1000)} s; memory: rss ${mb(mem.rss)} MB, heap ${mb(mem.heapUsed)} MB, array buffers ${mb(mem.arrayBuffers)} MB`
    );
  }
  return aggregator.result();
}
