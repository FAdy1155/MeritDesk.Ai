import { Readable } from "node:stream";
import zlib from "node:zlib";
import type { KnownFetch, LibraryHttp, LibraryHttpResponse } from "../../types";
import { entryDataOffset, locateCentralDirectory, parseCentralDirectory, ZIP_TAIL_BYTES, ZipFormatError, type ZipEntry } from "./zip";

// Reads EOIR's case data release (one ZIP64 file of about 4.5 GB on
// fileshare.eoir.justice.gov) by HTTP range requests through the library's
// polite client (robots.txt, pacing, retries, the host list): the central
// directory from the end of the file, small entries whole, and large
// entries streamed in pieces and inflated as they arrive, so the archive is
// never downloaded or held whole. Every piece after the first is asked for
// with If-Range on the release's ETag: if EOIR replaces the file during a
// read, the server answers with the whole new file instead of a range, which
// the byte cap refuses, and the read fails instead of mixing two releases.
//
// Used by the collector (the release's description) and by the statistics
// loader (./loader.ts); no database.

/** Bytes per range request for a streamed entry. */
export const STREAM_CHUNK_BYTES = 32 * 1024 * 1024;

/**
 * Timeout for the small range requests (the end of the file, the central
 * directory, the lookup tables, an entry's header). fileshare.eoir.justice.gov
 * can take over a minute to start answering a range of its 4.5 GB file (a
 * live probe timed out once at the default 60 seconds), so they get three.
 */
const SMALL_RANGE_TIMEOUT_MS = 3 * 60 * 1000;

export type ReleaseDirectory = {
  url: string;
  /** The response that read the end of the file (its validators identify the release). */
  response: LibraryHttpResponse;
  etag: string | null;
  lastModified: string | null;
  fileSize: number;
  zip64: boolean;
  entries: ZipEntry[];
};

export class ReleaseReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseReadError";
  }
}

function rangeHeaders(range: string, etag: string | null): Record<string, string> {
  return etag ? { Range: range, "If-Range": etag } : { Range: range };
}

function checkPartial(response: LibraryHttpResponse, expectedBytes: number | null, what: string, etag: string | null = null): void {
  if (etag && response.etag && response.etag !== etag) throw new ReleaseReadError(`${what}: the release file changed while it was being read (ETag ${response.etag}, was ${etag}); it is read again on the next run.`);
  if (response.status !== 206) throw new ReleaseReadError(`${what}: the server answered HTTP ${response.status}, not a byte range (206).`);
  if (expectedBytes !== null && response.body.length !== expectedBytes) {
    throw new ReleaseReadError(`${what}: asked for ${expectedBytes} bytes, got ${response.body.length}.`);
  }
}

/**
 * The release's central directory. With `conditional` (the validators of
 * the last read) a 304 comes back as `{ notModified: true }`.
 */
export async function readReleaseDirectory(
  http: LibraryHttp,
  url: string,
  conditional: KnownFetch | null = null
): Promise<{ notModified: true; response: LibraryHttpResponse } | ({ notModified: false } & ReleaseDirectory)> {
  const tailResponse = await http.get(url, { expect: "any", maxBytes: ZIP_TAIL_BYTES + 1024, timeoutMs: SMALL_RANGE_TIMEOUT_MS, headers: { Range: `bytes=-${ZIP_TAIL_BYTES}` }, conditional });
  if (tailResponse.notModified) return { notModified: true, response: tailResponse };
  checkPartial(tailResponse, null, "the end of the release file");
  const location = locateCentralDirectory(tailResponse.body);
  const etag = tailResponse.etag;
  let directory: Buffer;
  const relative = location.centralDirectoryOffset - location.tailStart;
  if (relative >= 0 && relative + location.centralDirectorySize <= tailResponse.body.length) {
    directory = tailResponse.body.subarray(relative, relative + location.centralDirectorySize);
  } else {
    const end = location.centralDirectoryOffset + location.centralDirectorySize - 1;
    const response = await http.get(tailResponse.url, {
      expect: "any",
      maxBytes: location.centralDirectorySize + 1024,
      timeoutMs: SMALL_RANGE_TIMEOUT_MS,
      headers: rangeHeaders(`bytes=${location.centralDirectoryOffset}-${end}`, etag),
    });
    checkPartial(response, location.centralDirectorySize, "the release's central directory", etag);
    directory = response.body;
  }
  return {
    notModified: false,
    url: tailResponse.url,
    response: tailResponse,
    etag,
    lastModified: tailResponse.lastModified,
    fileSize: location.fileSize,
    zip64: location.zip64,
    entries: parseCentralDirectory(directory, location.entryCount),
  };
}

/** The entries of one folder of the release, by their file name ("Lookup/tblLookupJudge.csv" -> "tblLookupJudge.csv"). */
export function entriesUnder(release: ReleaseDirectory, folder: string): Map<string, ZipEntry> {
  const out = new Map<string, ZipEntry>();
  for (const entry of release.entries) {
    const parts = entry.name.split("/");
    if (parts.length >= 2 && parts[parts.length - 2] === folder && parts[parts.length - 1]) out.set(parts[parts.length - 1], entry);
  }
  return out;
}

/**
 * The most one small entry (a lookup table, the readme, the schema files)
 * may hold once inflated. DEFLATE can grow a few MB of input to gigabytes, so
 * the size the archive states is checked first and inflating stops at it.
 */
export const SMALL_ENTRY_MAX_BYTES = 64 * 1024 * 1024;

function inflateWhole(entry: ZipEntry, data: Buffer): Buffer {
  if (entry.size > SMALL_ENTRY_MAX_BYTES) {
    throw new ReleaseReadError(`${entry.name}: the archive says it holds ${entry.size} bytes, more than the ${SMALL_ENTRY_MAX_BYTES} this reader inflates in memory.`);
  }
  let out: Buffer | null;
  try {
    out = entry.method === 0 ? data : entry.method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) }) : null;
  } catch (err) {
    throw new ReleaseReadError(`${entry.name}: could not be inflated within the ${entry.size} bytes the archive states (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (!out) throw new ZipFormatError(`${entry.name} uses compression method ${entry.method}`);
  if (out.length !== entry.size) throw new ReleaseReadError(`${entry.name}: ${out.length} bytes after inflating, the archive says ${entry.size}.`);
  if (zlib.crc32(out) >>> 0 !== entry.crc32 >>> 0) throw new ReleaseReadError(`${entry.name}: CRC-32 does not match the archive's.`);
  return out;
}

/**
 * Several small entries read with one range request covering all of them
 * (the lookup tables sit next to each other at the end of the archive).
 * Capped at maxSpanBytes so a changed layout cannot turn this into a large download.
 */
export async function readSmallEntries(
  http: LibraryHttp,
  release: ReleaseDirectory,
  entries: readonly ZipEntry[],
  maxSpanBytes = 8 * 1024 * 1024
): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (entries.length === 0) return out;
  const start = Math.min(...entries.map((e) => e.localHeaderOffset));
  // The local header's name and extra fields are at most 2 x 65,535 bytes; EOIR's are short. 1 KB margin per entry.
  const end = Math.max(...entries.map((e) => e.localHeaderOffset + 30 + 1024 + e.compressedSize));
  const last = Math.min(end, release.fileSize) - 1;
  if (last - start + 1 > maxSpanBytes) {
    throw new ReleaseReadError(`The entries asked for span ${last - start + 1} bytes of the archive, more than the ${maxSpanBytes} this reader fetches in one request.`);
  }
  const response = await http.get(release.url, { expect: "any", maxBytes: last - start + 1 + 1024, timeoutMs: SMALL_RANGE_TIMEOUT_MS, headers: rangeHeaders(`bytes=${start}-${last}`, release.etag) });
  checkPartial(response, last - start + 1, "the release's small files", release.etag);
  for (const entry of entries) {
    const at = entry.localHeaderOffset - start;
    const dataStart = entryDataOffset(entry, response.body.subarray(at, at + 30)) - start;
    if (dataStart + entry.compressedSize > response.body.length) throw new ReleaseReadError(`${entry.name} runs past the bytes read.`);
    out.set(entry.name, inflateWhole(entry, response.body.subarray(dataStart, dataStart + entry.compressedSize)));
  }
  return out;
}

export type StreamOptions = {
  signal?: AbortSignal;
  chunkBytes?: number;
  /**
   * Stop after this many compressed bytes (local tests read a prefix of a
   * table; the loader never sets it). The CRC is then not checked, and
   * `complete` on the result is false.
   */
  maxCompressedBytes?: number;
  onProgress?: (compressedRead: number, compressedTotal: number) => void;
};

/**
 * One entry's decompressed bytes, streamed: range requests of chunkBytes
 * each, inflated as they arrive (with back-pressure: the next range is
 * fetched when the consumer has taken what the last one gave). Checks the
 * size and CRC-32 the archive states when the whole entry was read.
 */
export async function* streamEntry(http: LibraryHttp, release: ReleaseDirectory, entry: ZipEntry, options: StreamOptions = {}): AsyncGenerator<Buffer> {
  if (entry.method !== 8 && entry.method !== 0) throw new ZipFormatError(`${entry.name} uses compression method ${entry.method}`);
  const header = await http.get(release.url, {
    expect: "any",
    maxBytes: 2048,
    timeoutMs: SMALL_RANGE_TIMEOUT_MS,
    headers: rangeHeaders(`bytes=${entry.localHeaderOffset}-${entry.localHeaderOffset + 1023}`, release.etag),
  });
  checkPartial(header, null, `the header of ${entry.name}`, release.etag);
  const dataStart = entryDataOffset(entry, header.body);
  const total = options.maxCompressedBytes !== undefined ? Math.min(entry.compressedSize, options.maxCompressedBytes) : entry.compressedSize;
  const complete = total === entry.compressedSize;
  const chunkBytes = options.chunkBytes ?? STREAM_CHUNK_BYTES;

  async function* compressed(): AsyncGenerator<Buffer> {
    let read = 0;
    while (read < total) {
      if (options.signal?.aborted) throw new ReleaseReadError("The read was stopped (the job ended or the worker is shutting down).");
      const length = Math.min(chunkBytes, total - read);
      const from = dataStart + read;
      const response = await http.get(release.url, {
        expect: "any",
        maxBytes: length + 1024,
        timeoutMs: 10 * 60 * 1000,
        headers: rangeHeaders(`bytes=${from}-${from + length - 1}`, release.etag),
      });
      checkPartial(response, length, `${entry.name} bytes ${from} to ${from + length - 1}`, release.etag);
      read += length;
      options.onProgress?.(read, total);
      yield response.body;
    }
  }

  let crc = 0;
  let produced = 0;
  if (entry.method === 0) {
    for await (const chunk of compressed()) {
      crc = zlib.crc32(chunk, crc);
      produced += chunk.length;
      yield chunk;
    }
  } else {
    const source = Readable.from(compressed());
    const inflater = zlib.createInflateRaw();
    source.on("error", (err) => inflater.destroy(err));
    source.pipe(inflater);
    try {
      for await (const chunk of inflater as AsyncIterable<Buffer>) {
        crc = zlib.crc32(chunk, crc);
        produced += chunk.length;
        yield chunk;
      }
    } catch (err) {
      // A prefix ends mid-stream: "unexpected end of file" is expected there and nothing else is.
      if (complete || !/unexpected end/i.test(err instanceof Error ? err.message : "")) {
        if (err instanceof ReleaseReadError) throw err;
        throw new ReleaseReadError(`${entry.name} could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      source.destroy();
      inflater.destroy();
    }
  }
  if (complete) {
    if (produced !== entry.size) throw new ReleaseReadError(`${entry.name}: ${produced} bytes after inflating, the archive says ${entry.size}.`);
    if (crc >>> 0 !== entry.crc32 >>> 0) throw new ReleaseReadError(`${entry.name}: CRC-32 does not match the archive's.`);
  }
}

/**
 * The lines of a streamed entry (CRLF or LF), decoded byte for byte
 * (latin1: the case tables are codes, dates and numbers; names are read
 * from the lookup tables, decoded separately). A partial last line of a
 * prefix read is dropped.
 */
export async function* streamLines(chunks: AsyncIterable<Buffer>, options: { complete: boolean } = { complete: true }): AsyncGenerator<string[]> {
  let rest = "";
  for await (const chunk of chunks) {
    const text = rest + chunk.toString("latin1");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline < 0) {
      rest = text;
      continue;
    }
    rest = text.slice(lastNewline + 1);
    const lines = text.slice(0, lastNewline).split("\n");
    for (let i = 0; i < lines.length; i++) if (lines[i].endsWith("\r")) lines[i] = lines[i].slice(0, -1);
    yield lines;
  }
  if (options.complete && rest.length > 0) yield [rest.endsWith("\r") ? rest.slice(0, -1) : rest];
}
