import "../../../load-env";
import { createAdapterContext, describeError } from "../pipeline";
import { prepareDocument } from "../prepare";
import { getLibraryAdapter, listLibraryAdapters, missingEnv, rejectedAdapterMessages } from "../registry";
import type { DocumentRef } from "../types";

// Tries one library collector live against its official source, without a
// database: lists documents the way the daily run (or a backfill chunk)
// would, fetches a few, and prints what would be stored, checked the same
// way the pipeline checks it. Nothing is written anywhere.
//
//   npm run library:probe -- <source code> [options]
//
//   --mode daily|backfill   which listing to read (default daily)
//   --cursor '<json>'       backfill cursor to start from (default: the first chunk)
//   --since YYYY-MM-DD      the daily run's "last success" (default: none)
//   --limit N               documents to fetch (default 3; 0 lists only)
//   --ref <externalId>      fetch this listed document instead of the first ones
//   --text N                characters of each document's text to print (default 600)
//   --list                  print every listed ref, not only the first 10
//
// Requests are paced and honor robots.txt exactly as in production
// (justice.gov asks for 10 seconds between requests), so a probe of a few
// documents can take a minute or two.

type Args = { code: string | null; mode: "daily" | "backfill"; cursor: unknown; since: Date | null; limit: number; ref: string | null; textChars: number; listAll: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { code: null, mode: "daily", cursor: null, since: null, limit: 3, ref: null, textChars: 600, listAll: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--mode") {
      const v = next();
      if (v !== "daily" && v !== "backfill") throw new Error("--mode is daily or backfill");
      args.mode = v;
    } else if (a === "--cursor") args.cursor = JSON.parse(next());
    else if (a === "--since") args.since = new Date(`${next()}T00:00:00Z`);
    else if (a === "--limit") args.limit = Math.max(0, Number(next()));
    else if (a === "--ref") args.ref = next();
    else if (a === "--text") args.textChars = Math.max(0, Number(next()));
    else if (a === "--list") args.listAll = true;
    else if (!a.startsWith("--") && !args.code) args.code = a;
    else throw new Error(`Unknown argument ${a}`);
  }
  return args;
}

function show(label: string, value: unknown): void {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return;
  console.log(`  ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rejected = rejectedAdapterMessages();
  for (const message of rejected) console.log(`MISCONFIGURED (left out of the library): ${message}`);
  if (rejected.length) process.exitCode = 1;
  if (!args.code) {
    console.log("Usage: npm run library:probe -- <source code> [--mode daily|backfill] [--cursor json] [--since YYYY-MM-DD] [--limit N] [--ref id] [--text N] [--list]\n");
    console.log("Registered sources:");
    for (const a of listLibraryAdapters()) console.log(`  ${a.code}  (${a.group}) ${a.name}`);
    return;
  }
  const adapter = getLibraryAdapter(args.code);
  if (!adapter) throw new Error(`No adapter with code "${args.code}". Run without arguments to list them.`);
  const missing = missingEnv(adapter);
  if (missing.length) {
    console.log(`${adapter.code} needs ${missing.join(" and ")} (the worker would mark it needs_key and skip it). Set it in .env.local to probe.`);
    process.exitCode = 1;
    return;
  }

  const notes: string[] = [];
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new Error("interrupted")));
  const ctx = createAdapterContext({
    adapter,
    mode: "probe",
    signal: controller.signal,
    note: (m) => {
      notes.push(m);
      console.log(`  [note] ${m}`);
    },
  });

  console.log(`${adapter.code}: ${adapter.name}`);
  console.log(`  group ${adapter.group}, license ${adapter.license}, hosts ${adapter.hosts.join(", ")}`);
  const started = Date.now();
  let refs: DocumentRef[];
  if (args.mode === "daily") {
    const listing = await adapter.listUpdates(ctx, args.since);
    refs = listing.refs;
    console.log(`\nlistUpdates: ${refs.length} ref(s) in ${((Date.now() - started) / 1000).toFixed(1)} s${listing.withdrawn?.length ? `, ${listing.withdrawn.length} withdrawn` : ""}`);
  } else {
    const chunk = await adapter.backfill(ctx, args.cursor);
    refs = chunk.refs;
    console.log(`\nbackfill: ${refs.length} ref(s) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    show("progress", chunk.progress);
    console.log(`  nextCursor: ${JSON.stringify(chunk.nextCursor)}`);
  }
  for (const ref of args.listAll ? refs : refs.slice(0, 10)) {
    console.log(`  - ${ref.externalId}  ${ref.title ?? ""}  ${ref.url}${ref.fingerprint ? `  [${ref.fingerprint.slice(0, 12)}]` : ""}`);
  }
  if (!args.listAll && refs.length > 10) console.log(`  ... ${refs.length - 10} more (--list prints all)`);
  const ids = new Set<string>();
  const duplicates = refs.filter((r) => (ids.has(r.externalId) ? true : (ids.add(r.externalId), false)));
  if (duplicates.length) console.log(`  WARNING: ${duplicates.length} repeated externalId(s), e.g. ${duplicates[0].externalId}`);

  const targets = args.ref ? refs.filter((r) => r.externalId === args.ref) : refs.slice(0, args.limit);
  if (args.ref && targets.length === 0) throw new Error(`${args.ref} is not among the listed refs.`);
  let problems = 0;
  for (const ref of targets) {
    console.log(`\n=== ${ref.externalId}`);
    const t = Date.now();
    try {
      const result = await adapter.fetchDocument(ctx, ref);
      if (result.kind !== "document") {
        console.log(`  ${result.kind}${result.kind === "skip" ? `: ${result.reason}` : ""}`);
        continue;
      }
      const doc = prepareDocument(adapter, result.document, ref);
      console.log(`  fetched and checked in ${((Date.now() - t) / 1000).toFixed(1)} s`);
      show("title", doc.title);
      show("docType", doc.docType);
      show("citations", doc.citations);
      show("normalized (lookup)", doc.selfCitations.map((c) => `${c.kind}: ${c.normalized}`));
      show("court", doc.court);
      show("agency", doc.agency);
      show("decisionDate", doc.decisionDate);
      show("publishedDate", doc.publishedDate);
      show("effectiveDate", doc.effectiveDate);
      show("editionDate", doc.editionDate);
      show("documentYear", doc.documentYear);
      show("precedentialStatus", doc.precedentialStatus);
      show("officialUrl", doc.officialUrl);
      show("originalUrl", doc.originalUrl);
      show("textKind", doc.textKind);
      console.log(`  text: ${doc.text.length} characters, sha256 ${doc.textSha256.slice(0, 16)}`);
      console.log(`  cites ${doc.citedCitations.length} authorities, e.g. ${doc.citedCitations.slice(0, 6).map((c) => c.normalized).join("; ") || "none"}`);
      const { summary, ...rest } = doc.metadata;
      show("metadata", rest);
      if (typeof summary === "string") console.log(`  summary: ${summary.slice(0, 400)}${summary.length > 400 ? " [...]" : ""}`);
      show("fetch", doc.fetchInfo);
      show("original", doc.original ? { bytes: doc.original.bytes.length, contentType: doc.original.contentType, sha256: doc.original.sha256.slice(0, 16) } : null);
      if (adapter.legalUpdateItem) show("legal update item", adapter.legalUpdateItem(result.document));
      if (args.textChars > 0) console.log(`  --- text (first ${args.textChars}) ---\n${doc.text.slice(0, args.textChars)}\n  ---`);
    } catch (err) {
      problems++;
      console.log(`  FAILED: ${describeError(err)}`);
    }
  }
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)} s: ${targets.length} fetched, ${problems} failed, ${notes.length} note(s).`);
  if (problems) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`probe failed: ${describeError(err)}`);
  process.exit(1);
});
