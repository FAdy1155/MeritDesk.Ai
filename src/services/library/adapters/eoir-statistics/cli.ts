import "../../../../load-env";
import { withGlobalReadContext, withServiceContext } from "@/db/client";
import type { LibraryTransactions } from "../../db";
import { loadEoirStatistics } from "./load";

// Runs the EOIR statistics load now, against the app's database (the
// worker's job does the same every day, ./jobs.ts):
//
//   npx tsx --conditions=react-server src/services/library/adapters/eoir-statistics/cli.ts [--force]
//
// Without --force it loads only a release that is not already the current
// snapshot. A full load streams about 1.2 GB from fileshare.eoir.justice.gov
// and takes tens of minutes. Ctrl-C stops it; the snapshot is then recorded
// as failed and its rows removed.

async function main() {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new Error("interrupted")));
  const transactions: LibraryTransactions = {
    write: (fn) => withServiceContext((tx) => fn(tx)),
    read: (fn) => withGlobalReadContext((tx) => fn(tx), { statementTimeoutMs: null }),
  };
  const outcome = await loadEoirStatistics({ transactions, signal: controller.signal, log: (line) => console.log(line), force: process.argv.includes("--force") });
  console.log(JSON.stringify(outcome));
  process.exit(0);
}

main().catch((err) => {
  console.error(`EOIR statistics load failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
