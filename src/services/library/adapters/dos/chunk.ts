import type { BackfillChunk, DocumentRef } from "../../types";

// Backfill over a list the collector reads whole each time (an index page, a
// sitemap): `size` refs from the cursor's offset, in the list's own order.
// A list that grew or shrank between chunks only shifts the window: a ref
// seen twice is skipped by its fingerprint, and the last chunk ends the walk.

export type OffsetCursor = { offset: number };

export function offsetOf(cursor: unknown): number {
  const offset = cursor && typeof cursor === "object" ? (cursor as { offset?: unknown }).offset : undefined;
  return typeof offset === "number" && Number.isInteger(offset) && offset > 0 ? offset : 0;
}

export function chunkOf(refs: DocumentRef[], cursor: unknown, size: number, what = "pages"): BackfillChunk {
  const offset = offsetOf(cursor);
  const slice = refs.slice(offset, offset + size);
  const next = offset + size;
  return {
    refs: slice,
    nextCursor: next < refs.length ? ({ offset: next } satisfies OffsetCursor) : null,
    progress: `${what} ${Math.min(offset + 1, refs.length)} to ${offset + slice.length} of ${refs.length}`,
  };
}
