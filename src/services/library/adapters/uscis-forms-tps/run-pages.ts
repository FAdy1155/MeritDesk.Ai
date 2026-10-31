import type { LibraryAdapterContext, LibraryHttpResponse } from "../../types";

// What the collectors in this folder share: uscis.gov's host and agency
// name, and the pages a listing step already read in the current run.
//
// A listing step here reads pages fetchDocument then needs again (a form's
// page, to find its PDFs; a Forms Updates page, whose rows are the
// documents). They are kept for the rest of the run so a page is not asked
// for twice (uscis.gov asks for 10 seconds between requests). The memory is
// keyed by the run's context object and goes with it; a lookup that misses
// (a retry in a later run) fetches the page as usual.

export const USCIS_HOST = "www.uscis.gov";
export const USCIS_AGENCY = "U.S. Citizenship and Immigration Services";

export type RunPage = { text: string; response: LibraryHttpResponse };

const runs = new WeakMap<LibraryAdapterContext, Map<string, RunPage>>();

export function rememberPage(ctx: LibraryAdapterContext, url: string, page: RunPage): void {
  let pages = runs.get(ctx);
  if (!pages) runs.set(ctx, (pages = new Map()));
  pages.set(url, page);
  if (page.response.url !== url) pages.set(page.response.url, page);
}

/** A page read earlier in this run, if any; `forget` drops it once its only document is built. */
export function recallPage(ctx: LibraryAdapterContext, url: string, options: { forget?: boolean } = {}): RunPage | null {
  const pages = runs.get(ctx);
  const page = pages?.get(url) ?? null;
  if (page && options.forget) {
    pages!.delete(url);
    pages!.delete(page.response.url);
  }
  return page;
}

/** GETs an HTML page and keeps it for this run. */
export async function readRunPage(ctx: LibraryAdapterContext, url: string): Promise<RunPage> {
  const page = await ctx.http.getText(url, { expect: "html" });
  rememberPage(ctx, url, page);
  return page;
}

/** A page's path, lowercased, without a trailing slash: how this folder compares uscis.gov links ("/I-918" and "/i-918" are one page). */
export function pathKey(url: string): string {
  return new URL(url).pathname.replace(/\/+$/, "").toLowerCase();
}

/** Whether `url` is https on www.uscis.gov (the only host these collectors read pages from). */
export function isUscisUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === USCIS_HOST;
  } catch {
    return false;
  }
}
