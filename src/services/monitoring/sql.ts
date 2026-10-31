import { sql } from "drizzle-orm";
import { legalUpdates } from "@/db/schema";

/**
 * The date legal updates are sorted and windowed by: the date the source
 * states, else the (UTC) day the monitor retrieved the item.
 */
export const effectiveDate = sql`coalesce(${legalUpdates.publishedOn}, (${legalUpdates.retrievedAt} at time zone 'UTC')::date)`;
