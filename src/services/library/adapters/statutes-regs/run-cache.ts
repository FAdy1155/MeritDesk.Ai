import type { KnownFetch, LibraryAdapterContext, LibraryHttpResponse } from "../../types";

// What one run of a collector reads once and uses for many documents: the
// statutes and regulations come as whole titles (a ZIP of the title's USLM
// XML, a bulk eCFR XML file), and every section of a title is one document.
// The run's context keys the cache, so it lives exactly as long as the run
// (the pipeline passes the same context to listUpdates or backfill and to
// every fetchDocument of that run) and nothing is shared between runs.

const RUNS = new WeakMap<LibraryAdapterContext, Map<string, Promise<unknown>>>();

function cacheOf(ctx: LibraryAdapterContext): Map<string, Promise<unknown>> {
  let cache = RUNS.get(ctx);
  if (!cache) {
    cache = new Map();
    RUNS.set(ctx, cache);
  }
  return cache;
}

/** The value `load` gives for `key` in this run, loaded at most once (a failed load is tried again next time). */
export function once<T>(ctx: LibraryAdapterContext, key: string, load: () => Promise<T>): Promise<T> {
  const cache = cacheOf(ctx);
  const hit = cache.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const promise = load();
  cache.set(key, promise);
  promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key);
  });
  return promise;
}

/**
 * Before `key` is loaded: when it is not held yet, drops all but the
 * `others` most recently added entries whose key starts with `prefix`, so a
 * run that walks several large titles holds two in memory at a time, not
 * all of them.
 */
export function makeRoom(ctx: LibraryAdapterContext, prefix: string, key: string, others: number): void {
  const cache = cacheOf(ctx);
  if ([...cache.keys()].some((k) => k.startsWith(key))) return;
  const held = [...new Set([...cache.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.split("#")[0]))];
  for (const old of held.slice(0, Math.max(0, held.length - others))) {
    for (const k of [...cache.keys()]) if (k.split("#")[0] === old) cache.delete(k);
  }
}

export type SharedFile<T> = { response: LibraryHttpResponse; value: T };

/** Keeps a file the run already fetched (a listing read with getListing) for sharedFile under `key`, so it is not fetched again. */
export function rememberFile<T>(ctx: LibraryAdapterContext, key: string, file: SharedFile<T>): void {
  cacheOf(ctx).set(`${key}#file`, Promise.resolve(file));
}

/**
 * A file many documents are read from, fetched once per run. With `known`
 * (the validators a document was stored with) and nothing cached yet, the
 * request is conditional: a 304 answers "not modified" for that document
 * (and for any later one stored with the same validators) without
 * downloading the file. Otherwise the file is downloaded, read with `read`
 * and kept for the rest of the run.
 */
export async function sharedFile<T>(
  ctx: LibraryAdapterContext,
  key: string,
  url: string,
  known: KnownFetch | null | undefined,
  fetchFile: (conditional: KnownFetch | null) => Promise<LibraryHttpResponse>,
  read: (response: LibraryHttpResponse) => T | Promise<T>
): Promise<{ notModified: true } | { notModified: false; file: SharedFile<T> }> {
  const cache = cacheOf(ctx);
  const full = cache.get(`${key}#file`) as Promise<SharedFile<T>> | undefined;
  if (full) return { notModified: false, file: await full };
  const conditional = known && known.url === url && (known.etag || known.lastModified) ? known : null;
  if (conditional) {
    const confirmed = cache.get(`${key}#304`) as Promise<KnownFetch> | undefined;
    const same = (k: KnownFetch) => k.etag === conditional.etag && k.lastModified === conditional.lastModified;
    if (confirmed && same(await confirmed)) return { notModified: true };
    const response = await fetchFile(conditional);
    if (response.notModified) {
      cache.set(`${key}#304`, Promise.resolve(conditional));
      return { notModified: true };
    }
    const file = Promise.resolve(read(response)).then((value) => ({ response, value }));
    cache.set(`${key}#file`, file);
    file.catch(() => cache.delete(`${key}#file`));
    return { notModified: false, file: await file };
  }
  const file = once(ctx, `${key}#file`, async () => {
    const response = await fetchFile(null);
    return { response, value: await read(response) };
  });
  return { notModified: false, file: await file };
}
