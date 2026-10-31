import "../../../load-env";
import fs from "node:fs";
import { createAdapterContext, describeError } from "../pipeline";
import { prepareDocument } from "../prepare";
import { listLibraryAdapters, missingEnv, rejectedAdapterMessages } from "../registry";
import type { DocumentRef, LibrarySourceAdapter } from "../types";

// A live smoke test of every registered collector (or the ones named), in
// one process, without a database: for each source, the daily listing, the
// first backfill chunk, and a few documents fetched and checked exactly as
// the pipeline checks them (prepare.ts). Nothing is stored.
//
//   npm run library:smoke                         every registered source
//   npm run library:smoke -- uscis_tps eoir_icpm  only these
//   options: --docs N (documents per source, default 2), --attempts N (refs
//   tried at most, default docs + 4: a ref the collector skips is replaced by
//   the next), --since YYYY-MM-DD (the daily run's last success, default
//   three days ago), --minutes N (per source, default 60), --out report.json
//
// Sources run the way the worker runs them: one source at a time per host
// (grouped by the first host each lists), different hosts in parallel, and
// every request through the same polite client (robots.txt, Crawl-delay,
// one request in flight per host), so a run takes as long as its busiest
// host: an hour or more with uscis.gov and justice.gov at ten seconds a
// request. A source whose API key is unset is reported as needs_key and not
// run. The report (--out) is rewritten after each source.

type Step = { refs: number; seconds: number; error: string | null; nextCursor?: string | null; progress?: string | null };
type DocResult = {
  externalId: string;
  from: "daily" | "backfill";
  outcome: "document" | "not_modified" | "skip" | "failed";
  detail?: string;
  title?: string;
  docType?: string;
  officialUrl?: string;
  textKind?: string;
  textChars?: number;
  citations?: string[];
  date?: string | null;
  precedentialStatus?: string;
  legalUpdateItem?: string | null;
  seconds: number;
};
type SourceResult = {
  code: string;
  group: string;
  host: string;
  status: "ok" | "partial" | "failed" | "needs_key" | "not_run";
  missingEnv?: string[];
  daily?: Step;
  backfill?: Step;
  documents: DocResult[];
  notes: string[];
  seconds: number;
  problem: string | null;
};

function parseArgs(argv: string[]) {
  const args = { codes: [] as string[], docs: 2, attempts: 0, since: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), minutes: 60, out: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--docs") args.docs = Math.max(0, Number(next()));
    else if (a === "--attempts") args.attempts = Math.max(0, Number(next()));
    else if (a === "--since") args.since = new Date(`${next()}T00:00:00Z`);
    else if (a === "--minutes") args.minutes = Math.max(1, Number(next()));
    else if (a === "--out") args.out = next();
    else if (!a.startsWith("--")) args.codes.push(a);
    else throw new Error(`Unknown argument ${a}`);
  }
  return args;
}

const hostKey = (adapter: LibrarySourceAdapter) => adapter.hosts[0].replace(/^www\./, "");
const seconds = (since: number) => Math.round((Date.now() - since) / 100) / 10;

async function smokeOne(adapter: LibrarySourceAdapter, opts: { docs: number; attempts: number; since: Date; minutes: number }): Promise<SourceResult> {
  const started = Date.now();
  const result: SourceResult = { code: adapter.code, group: adapter.group, host: hostKey(adapter), status: "not_run", documents: [], notes: [], seconds: 0, problem: null };
  const missing = missingEnv(adapter);
  if (missing.length) {
    return { ...result, status: "needs_key", missingEnv: missing, problem: `needs ${missing.join(" and ")}` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`the smoke test's ${opts.minutes}-minute limit for one source`)), opts.minutes * 60 * 1000);
  const ctx = createAdapterContext({ adapter, mode: "probe", signal: controller.signal, note: (m) => result.notes.push(m.slice(0, 300)) });
  const candidates: { ref: DocumentRef; from: "daily" | "backfill" }[] = [];
  try {
    let t = Date.now();
    try {
      const listing = await adapter.listUpdates(ctx, opts.since);
      result.daily = { refs: listing.refs.length, seconds: seconds(t), error: null };
      candidates.push(...listing.refs.map((ref) => ({ ref, from: "daily" as const })));
    } catch (err) {
      result.daily = { refs: 0, seconds: seconds(t), error: describeError(err) };
    }
    t = Date.now();
    try {
      const chunk = await adapter.backfill(ctx, null);
      const cursor = chunk.nextCursor === null ? null : JSON.stringify(chunk.nextCursor);
      result.backfill = { refs: chunk.refs.length, seconds: seconds(t), error: null, nextCursor: cursor && cursor.length > 300 ? `${cursor.slice(0, 300)}...` : cursor, progress: chunk.progress ?? null };
      const seen = new Set(candidates.map((c) => c.ref.externalId));
      candidates.push(...chunk.refs.filter((ref) => !seen.has(ref.externalId)).map((ref) => ({ ref, from: "backfill" as const })));
    } catch (err) {
      result.backfill = { refs: 0, seconds: seconds(t), error: describeError(err) };
    }

    // Documents: the first listed refs, daily first; a skipped ref (not a
    // document after all) is replaced by the next one, a few times at most.
    let got = 0;
    for (const { ref, from } of candidates.slice(0, Math.max(opts.attempts, opts.docs + 4))) {
      if (got >= opts.docs || controller.signal.aborted) break;
      const d = Date.now();
      try {
        const fetched = await adapter.fetchDocument(ctx, ref);
        if (fetched.kind !== "document") {
          result.documents.push({ externalId: ref.externalId, from, outcome: fetched.kind, detail: fetched.kind === "skip" ? fetched.reason.slice(0, 300) : undefined, seconds: seconds(d) });
          continue;
        }
        const doc = prepareDocument(adapter, fetched.document, ref);
        const item = adapter.legalUpdateItem?.(fetched.document) ?? null;
        result.documents.push({
          externalId: doc.externalId,
          from,
          outcome: "document",
          title: doc.title.slice(0, 200),
          docType: doc.docType,
          officialUrl: doc.officialUrl,
          textKind: doc.textKind,
          textChars: doc.text.length,
          citations: doc.citations.slice(0, 3),
          date: doc.decisionDate ?? doc.publishedDate ?? doc.effectiveDate ?? doc.editionDate ?? (doc.documentYear ? String(doc.documentYear) : null),
          precedentialStatus: doc.precedentialStatus,
          legalUpdateItem: item ? item.itemType : null,
          seconds: seconds(d),
        });
        got++;
      } catch (err) {
        result.documents.push({ externalId: ref.externalId, from, outcome: "failed", detail: describeError(err), seconds: seconds(d) });
      }
    }

    const failedDocs = result.documents.filter((d) => d.outcome === "failed");
    const listingErrors = [result.daily?.error, result.backfill?.error].filter(Boolean) as string[];
    const problems = [...listingErrors.map((e) => `listing: ${e}`), ...failedDocs.map((d) => `${d.externalId}: ${d.detail}`)];
    if (got < Math.min(opts.docs, candidates.length) && !failedDocs.length && !listingErrors.length) {
      problems.push(`only ${got} of ${opts.docs} documents (the others were skipped by the collector)`);
    }
    result.problem = problems.length ? problems.join(" | ").slice(0, 1500) : null;
    // Failed: no listing could be read, or documents failed and none came through. A source whose
    // listings work but whose first refs were all skipped by the collector is partial, not failed.
    const listingOk = result.daily?.error === null || result.backfill?.error === null;
    const ok = listingErrors.length === 0 && failedDocs.length === 0 && got >= Math.min(opts.docs, candidates.length);
    result.status = ok ? "ok" : !listingOk || (failedDocs.length > 0 && got === 0) ? "failed" : "partial";
  } finally {
    clearTimeout(timer);
    result.seconds = seconds(started);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rejected = rejectedAdapterMessages();
  for (const message of rejected) console.log(`MISCONFIGURED (left out of the library): ${message}`);
  const all = listLibraryAdapters();
  const unknown = args.codes.filter((c) => !all.some((a) => a.code === c));
  if (unknown.length) throw new Error(`No registered source has the code ${unknown.join(", ")}.`);
  const chosen = args.codes.length ? all.filter((a) => args.codes.includes(a.code)) : all;

  const lanes = new Map<string, LibrarySourceAdapter[]>();
  for (const adapter of chosen) lanes.set(hostKey(adapter), [...(lanes.get(hostKey(adapter)) ?? []), adapter]);
  console.log(`${chosen.length} source(s) on ${lanes.size} host lane(s); since ${args.since.toISOString().slice(0, 10)}, ${args.docs} document(s) each.`);

  const results: SourceResult[] = [];
  const write = () => {
    if (args.out) fs.writeFileSync(args.out, JSON.stringify({ at: new Date().toISOString(), rejected, results }, null, 2));
  };
  await Promise.all(
    [...lanes.values()].map(async (lane) => {
      for (const adapter of lane) {
        const r = await smokeOne(adapter, args);
        results.push(r);
        const docs = r.documents.filter((d) => d.outcome === "document").length;
        console.log(
          `${r.status.padEnd(9)} ${r.code}: daily ${r.daily ? (r.daily.error ? "ERROR" : r.daily.refs) : "-"}, backfill ${r.backfill ? (r.backfill.error ? "ERROR" : r.backfill.refs) : "-"}, ${docs} document(s), ${r.seconds} s${r.problem ? ` | ${r.problem.slice(0, 300)}` : ""}`
        );
        write();
      }
    })
  );
  const by = (s: SourceResult["status"]) => results.filter((r) => r.status === s).length;
  console.log(`\n${results.length} source(s): ${by("ok")} ok, ${by("partial")} partial, ${by("failed")} failed, ${by("needs_key")} need an API key.`);
  write();
  if (rejected.length || by("failed")) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`smoke test failed: ${describeError(err)}`);
  process.exit(1);
});
