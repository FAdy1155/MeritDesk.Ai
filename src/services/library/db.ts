import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "@/db/schema";

// The database handle the library's store and search take: any drizzle
// Postgres database over the app schema. In the app it is the transaction
// withServiceContext (writes) or withGlobalReadContext (reads) opens
// (src/db/client.ts); the PGlite check (npm run library:db-check) passes its
// own, so the same SQL is exercised without a Postgres server.

export type LibraryDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/** How the library opens its transactions: `write` in service context, `read` read-only and global. */
export type LibraryTransactions = {
  write<T>(fn: (tx: LibraryDb) => Promise<T>): Promise<T>;
  read<T>(fn: (tx: LibraryDb) => Promise<T>): Promise<T>;
};

/** The rows of a raw `tx.execute(sql...)` result, whichever driver ran it. */
export function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}
