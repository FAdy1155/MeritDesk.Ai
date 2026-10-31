import "../../../load-env";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import { extractCitations } from "../citations";
import { resultRows, type LibraryDb, type LibraryTransactions } from "../db";
import { runBackfillChunk, runDaily, type PipelineDeps } from "../pipeline";
import { prepareDocument } from "../prepare";
import { runManualImport } from "../manual-import";
import { getLibraryAdapter, missingEnv } from "../registry";
import { listSources, lookupCitation, readDocument, searchLibrary } from "../search";
import { loadHttpCache, saveHttpCache, syncSources } from "../store";
import type { DocumentRef, LibraryDocumentInput, LibraryHttpResponse, LibrarySourceAdapter } from "../types";

// Checks the library's migration, row-level security, store and search SQL
// against PGlite (Postgres compiled to WebAssembly, a devDependency), so they
// run without a Postgres server:
//
//   npm run library:db-check              offline: a fixture source, every step checked
//   npm run library:db-check -- --live 3  also runs the BIA/AG adapter live for 3 documents
//   npm run library:db-check -- --live-source olrc_usc_title_8:3 --live-source govinfo_constitution:2
//                                          runs those registered collectors live (N documents
//                                          each, default 2) through the store twice, and
//                                          looks up, searches and reads what they stored
//
// The database is in memory and thrown away. The fixture source's documents
// exist only in that throwaway database: they test the code, they are not
// library content. Writes run as a role row-level security applies to, with
// the service-role setting the worker's withServiceContext sets; reads run
// read-only with no setting, like withGlobalReadContext.

const MIGRATIONS = "./src/db/migrations";
let failures = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// The fixture source
// ---------------------------------------------------------------------------

// Fixture dates are in 1901, plainly not real decisions, and in the past
// (prepare.ts sets aside a decision date later than the day it was read).
type FixtureDoc = { id: string; page: number; title: string; text: string; date: string; precedential: boolean; summary?: string };

const fixture = {
  docs: new Map<string, FixtureDoc>(),
  failOnce: new Set<string>(),
  fetched: [] as string[],
};

function setFixtureDocs(docs: FixtureDoc[]): void {
  fixture.docs = new Map(docs.map((d) => [d.id, d]));
}

const fixtureAdapter: LibrarySourceAdapter = {
  code: "dbcheck_fixture",
  group: "bia-ag-precedents",
  name: "DB check fixture source",
  description: "Throwaway documents for npm run library:db-check; never part of the library.",
  coverage: "Fixture",
  cadence: "Daily",
  officialUrl: "https://fixture.invalid/",
  hosts: ["fixture.invalid"],
  license: "public_domain",
  recheckAfterDays: 30,
  async listUpdates() {
    return { refs: [...fixture.docs.values()].map(refOf) };
  },
  async backfill(_ctx, cursor) {
    const all = [...fixture.docs.values()].map(refOf);
    const offset = typeof cursor === "number" ? cursor : 0;
    const next = offset + 2;
    return { refs: all.slice(offset, next), nextCursor: next < all.length ? next : null, progress: `fixture ${offset}` };
  },
  async fetchDocument(_ctx, ref) {
    fixture.fetched.push(ref.externalId);
    if (fixture.failOnce.delete(ref.externalId)) throw new Error(`fixture failure for ${ref.externalId}`);
    const d = fixture.docs.get(ref.externalId);
    if (!d) return { kind: "skip", reason: `${ref.externalId} is gone` };
    const document: LibraryDocumentInput = {
      externalId: d.id,
      docType: "decision",
      title: d.title,
      citations: [`99 I&N Dec. ${d.page} (BIA 2099)`],
      court: "Board of Immigration Appeals",
      decisionDate: d.date,
      precedentialStatus: d.precedential ? "precedential" : "non_precedential",
      officialUrl: `https://fixture.invalid/${d.id}.pdf`,
      text: d.text,
      metadata: d.summary ? { summary: d.summary } : {},
    };
    return { kind: "document", document };
  },
  legalUpdateItem(document) {
    return { itemType: "BIA precedent", crossSourceKey: `fixture:${document.externalId}` };
  },
};

function refOf(d: FixtureDoc): DocumentRef {
  return { externalId: d.id, url: `https://fixture.invalid/${d.id}.pdf`, title: d.title, fingerprint: `${d.title}|${d.text.length}|${d.date}` };
}

const BASE_DOCS: FixtureDoc[] = [
  {
    id: "F-1",
    page: 5,
    title: "Matter of FIXTURE-ALPHA",
    date: "1901-01-10",
    precedential: true,
    summary: "A particular social group must be defined with particularity and be socially distinct.",
    text: "The respondent claims membership in a particular social group. See 8 U.S.C. 1158(b)(1)(B)(i); 8 C.F.R. 1208.13. We cite 27 I&N Dec. 316 and INA 208.",
  },
  {
    id: "F-2",
    page: 10,
    title: "Matter of FIXTURE-BETA",
    date: "1901-03-02",
    precedential: true,
    text: "Cancellation of removal requires exceptional and extremely unusual hardship. See section 240A(b)(1)(D) of the Act and 99 I&N Dec. 5.",
  },
  {
    id: "F-3",
    page: 20,
    title: "Matter of FIXTURE-GAMMA",
    date: "1901-06-30",
    precedential: false,
    text: "An unpublished decision about motions to reopen and the time limit in 8 C.F.R. 1003.2(c)(2), citing 99 I&N Dec. 5 and 99 I&N Dec. 10.",
  },
];

/** A second fixture source whose documents state a country (the country filter, per-source listing validators). */
const COUNTRY_DOCS = [
  { id: "C-1", title: "Burma 2099 Human Rights Report", country: "Myanmar (Burma)", text: "Arbitrary detention and forced labor." },
  { id: "C-2", title: "Honduras 2099 Human Rights Report", country: "Honduras", text: "Gangs extort small businesses and recruit children." },
  { id: "C-3", title: "Northern Triangle 2099 overview", countries: ["Honduras", "Guatemala", "El Salvador"], text: "Gangs operate across borders." },
];

const countryAdapter: LibrarySourceAdapter = {
  ...fixtureAdapter,
  code: "dbcheck_countries",
  group: "country-conditions",
  name: "DB check country fixture",
  legalUpdateItem: undefined,
  async listUpdates() {
    return { refs: COUNTRY_DOCS.map((d) => ({ externalId: d.id, url: `https://fixture.invalid/${d.id}`, title: d.title })) };
  },
  async fetchDocument(_ctx, ref) {
    const d = COUNTRY_DOCS.find((c) => c.id === ref.externalId)!;
    return {
      kind: "document",
      document: {
        externalId: d.id,
        docType: "report",
        title: d.title,
        citations: [],
        precedentialStatus: "not_applicable",
        officialUrl: ref.url,
        text: d.text,
        // One stated country is keyed by prepare.ts; a list carries its keys the way the country-conditions collectors write them.
        metadata: d.country ? { country: d.country } : { countries: d.countries, countryKeys: ["honduras", "guatemala", "el-salvador"] },
      },
    };
  },
};

/**
 * A third fixture source that can be imported by hand (../manual-import.ts):
 * a saved page at https://fixture.invalid/doc/<name>.html, read by its own
 * fetchDocument through the import's ctx.http.
 */
const importFixtureAdapter: LibrarySourceAdapter = {
  ...fixtureAdapter,
  code: "dbcheck_import",
  group: "other-agency-guidance",
  name: "DB check import fixture",
  legalUpdateItem: undefined,
  manualImportPaths: [{ path: /^\/doc\/[\w-]+\.html$/, file: "html", role: "document", label: "A fixture page" }],
  manualImportIntervalDays: 35,
  async fetchDocument(ctx, ref) {
    const { text, response } = await ctx.http.getText(ref.url, { expect: "html" });
    const title = /<h1>([^<]+)<\/h1>/.exec(text)?.[1] ?? ref.externalId;
    const body = /<main>([\s\S]*)<\/main>/.exec(text)?.[1] ?? "";
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "notice",
        title,
        citations: [],
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        text: body.replace(/<[^>]+>/g, " "),
        fetch: { response },
      },
    };
  },
  async parseImported(ctx, input) {
    return importFixtureAdapter.fetchDocument(ctx, { externalId: new URL(input.url).pathname, url: input.url });
  },
};

// ---------------------------------------------------------------------------

async function main() {
  const live = process.argv.indexOf("--live");
  const liveCount = live >= 0 ? Number(process.argv[live + 1] ?? 3) : 0;

  const liveSources: { code: string; count: number }[] = [];
  process.argv.forEach((arg, i) => {
    if (arg !== "--live-source") return;
    const [code, n] = (process.argv[i + 1] ?? "").split(":");
    if (code) liveSources.push({ code, count: Math.max(1, Number(n) || 2) });
  });

  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf-8")) as { entries: { tag: string }[] };
  console.log(`migrations ${journal.entries[0].tag} to ${journal.entries[journal.entries.length - 1].tag} (${journal.entries.length}) applied to PGlite`);

  // The app's runtime role: not a superuser, no BYPASSRLS, owns no table (README "Database roles").
  await client.exec(`
    CREATE ROLE app_runtime NOSUPERUSER NOBYPASSRLS NOLOGIN;
    GRANT USAGE ON SCHEMA public TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
  `);

  const tx: LibraryTransactions = {
    write: (fn) =>
      db.transaction(async (t) => {
        await t.execute(sql`set local role app_runtime`);
        await t.execute(sql`set local app.is_service_role = 'true'`);
        return fn(t as unknown as LibraryDb);
      }),
    read: (fn) =>
      db.transaction(
        async (t) => {
          await t.execute(sql`set local role app_runtime`);
          return fn(t as unknown as LibraryDb);
        },
        { accessMode: "read only" }
      ),
  };
  const logs: string[] = [];
  const deps: PipelineDeps = { tx, log: (line) => logs.push(line) };

  await check("RLS is enabled and forced on every library table", async () => {
    const rows = resultRows<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      await db.execute(sql`select relname, relrowsecurity, relforcerowsecurity from pg_class where relname like 'library_%' and relkind = 'r' order by relname`)
    );
    assert.equal(rows.length, 8, `expected 8 library tables, found ${rows.map((r) => r.relname).join(", ")}`);
    for (const r of rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity, `${r.relname} is not forced`);
  });

  await check("the runtime role cannot write the library outside service context", async () => {
    await assert.rejects(
      db.transaction(async (t) => {
        await t.execute(sql`set local role app_runtime`);
        await t.execute(
          sql`insert into library_sources (code, group_code, name, description, coverage, cadence, official_url, license) values ('x', 'treaties', 'x', 'x', 'x', 'x', 'https://x.invalid/', 'public_domain')`
        );
      }),
      (err: unknown) => /row-level security/i.test(String((err as { cause?: { message?: string } }).cause?.message ?? (err as Error).message))
    );
  });

  await check("sources sync, and the runtime role reads them without any setting", async () => {
    await tx.write((t) => syncSources(t, [{ adapter: fixtureAdapter, missingEnv: [], disabled: false }]));
    const sources = await tx.read((t) => listSources(t));
    assert.equal(sources.length, 1);
    assert.equal(sources[0].status, "pending");
  });

  await check("first daily run stores every document and is the legal-update baseline", async () => {
    setFixtureDocs(BASE_DOCS);
    const result = await runDaily(fixtureAdapter.code, { adapter: fixtureAdapter }, deps);
    assert.equal(result.status, "completed", result.message ?? "");
    assert.equal(result.counts.inserted, 3);
    assert.equal(result.counts.legalUpdates, 0, "the baseline run must not feed legal updates");
    const [source] = await tx.read((t) => listSources(t));
    assert.equal(source.status, "ok");
    assert.equal(source.documentCount, 3);
  });

  await check("an unchanged listing is skipped without fetching", async () => {
    fixture.fetched = [];
    const result = await runDaily(fixtureAdapter.code, { adapter: fixtureAdapter }, deps);
    assert.equal(result.counts.skippedUnchanged, 3);
    assert.equal(fixture.fetched.length, 0);
  });

  await check("a changed document gets a new version and keeps the old text", async () => {
    setFixtureDocs([{ ...BASE_DOCS[0], text: `${BASE_DOCS[0].text} A corrected sentence.` }, BASE_DOCS[1], BASE_DOCS[2]]);
    const result = await runDaily(fixtureAdapter.code, { adapter: fixtureAdapter }, deps);
    assert.equal(result.counts.updated, 1);
    const rows = resultRows<{ version: number; versions: number | string }>(
      await db.execute(
        sql`select d.version, (select count(*) from library_document_versions v where v.document_id = d.id) as versions from library_documents d where external_id = 'F-1'`
      )
    );
    assert.equal(rows[0].version, 2);
    assert.equal(Number(rows[0].versions), 1);
  });

  await check("a new document after the baseline feeds legal_updates; one the monitor has is deduplicated", async () => {
    await db.execute(sql`
      insert into legal_updates (source, external_id, item_type, title, official_url, listed_on_url, retrieved_at, content_hash, raw_excerpt, status)
      values ('eoir_ag_bia_precedent', 'ID 1', 'BIA precedent', 'Already listed', 'https://www.fixture.invalid/F-5.pdf', 'https://fixture.invalid/', now(), 'h', 'x', 'pending_summary')`);
    setFixtureDocs([
      ...BASE_DOCS,
      { id: "F-4", page: 30, title: "Matter of FIXTURE-DELTA", date: "1901-07-01", precedential: true, text: "Withholding of removal under INA 241(b)(3)." },
      { id: "F-5", page: 40, title: "Matter of FIXTURE-EPSILON", date: "1901-07-02", precedential: true, text: "Already on the legal-update list." },
    ]);
    const result = await runDaily(fixtureAdapter.code, { adapter: fixtureAdapter }, deps);
    assert.equal(result.counts.inserted, 2);
    assert.equal(result.counts.legalUpdates, 1);
    const rows = resultRows<{ source: string; status: string; title: string }>(
      await db.execute(sql`select source, status, title from legal_updates where source like 'library:%'`)
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "library:dbcheck_fixture");
    assert.equal(rows[0].status, "pending_summary");
    assert.equal(rows[0].title, "Matter of FIXTURE-DELTA");
  });

  await check("search: websearch query, weighted rank, snippet, filters", async () => {
    const result = await tx.read((t) => searchLibrary(t, { query: '"particular social group"' }));
    assert.equal(result.hits[0]?.title, "Matter of FIXTURE-ALPHA");
    assert.match(result.hits[0].snippet, /\[\[/);
    const precedential = await tx.read((t) => searchLibrary(t, { query: "motions reopen", precedentialOnly: true }));
    assert.equal(precedential.hits.length, 0, "the non-precedential document must be filtered out");
    const unfiltered = await tx.read((t) => searchLibrary(t, { query: "motions reopen" }));
    assert.equal(unfiltered.hits[0]?.precedentialStatus, "non_precedential");
    const dated = await tx.read((t) => searchLibrary(t, { query: "removal", dateFrom: "1901-03-01", dateTo: "1901-03-31" }));
    assert.deepEqual(dated.hits.map((h) => h.title), ["Matter of FIXTURE-BETA"]);
    const court = await tx.read((t) => searchLibrary(t, { query: "removal", court: "nowhere" }));
    assert.equal(court.hits.length, 0);
    const grouped = await tx.read((t) => searchLibrary(t, { query: "removal", groups: ["bia-ag-precedents"], sources: ["dbcheck_fixture"] }));
    assert.ok(grouped.hits.length >= 2);
  });

  await check("search: a stated citation ranks its document first; a misspelled title is found by similarity", async () => {
    const byCitation = await tx.read((t) => searchLibrary(t, { query: "99 I&N Dec. 10" }));
    assert.equal(byCitation.hits[0]?.title, "Matter of FIXTURE-BETA");
    assert.equal(byCitation.hits[0]?.matchedBy, "citation");
    const fuzzy = await tx.read((t) => searchLibrary(t, { query: "Matter of FIXTURE-GAMA" }));
    assert.equal(fuzzy.hits[0]?.title, "Matter of FIXTURE-GAMMA");
  });

  await check("search: more matches than the rank cap are listed newest first; no words lists the newest first", async () => {
    const ranked = await tx.read((t) => searchLibrary(t, { query: "removal" }));
    assert.equal(ranked.order, "rank");
    assert.ok(ranked.hits.length >= 2, "the fixtures have several documents about removal");
    const capped = await tx.read((t) => searchLibrary(t, { query: "removal", rankCap: 1 }));
    assert.equal(capped.order, "date");
    assert.deepEqual(new Set(capped.hits.map((h) => h.id)), new Set(ranked.hits.map((h) => h.id)), "the same documents, in another order");
    const dates = capped.hits.map((h) => h.date).filter((d): d is string => d !== null);
    assert.deepEqual(dates, [...dates].sort().reverse(), "newest first");
    const byCitation = await tx.read((t) => searchLibrary(t, { query: "99 I&N Dec. 10", rankCap: 1 }));
    if (byCitation.order === "date") assert.equal(byCitation.hits[0]?.matchedBy, "citation", "a citation match still comes first");
    const newest = await tx.read((t) => searchLibrary(t, { query: "", sources: ["dbcheck_fixture"] }));
    assert.equal(newest.order, "date");
    const newestDates = newest.hits.map((h) => h.date).filter((d): d is string => d !== null);
    assert.ok(newestDates.length >= 2);
    assert.deepEqual(newestDates, [...newestDates].sort().reverse(), "newest first");
    const indexed = resultRows<{ n: number | string }>(
      await db.execute(sql`select count(*) as n from pg_indexes where indexname = 'library_documents_newest_idx'`)
    );
    assert.equal(Number(indexed[0]?.n), 1);
  });

  await check("global reads: statement_timeout is set for the transaction only, also in a READ ONLY one", async () => {
    const inside = await tx.read(async (t) => {
      await t.execute(sql`select set_config('statement_timeout', ${String(5000)}, true)`);
      return resultRows<{ v: string }>(await t.execute(sql`select current_setting('statement_timeout') as v`))[0]?.v;
    });
    assert.equal(inside, "5s");
    const after = resultRows<{ v: string }>(await db.execute(sql`select current_setting('statement_timeout') as v`))[0]?.v;
    assert.equal(after, "0");
  });

  await check("citation lookup: exact, pin page, cited-by count, similar", async () => {
    const exact = await tx.read((t) => lookupCitation(t, "99 I. & N. Dec. 5"));
    assert.equal(exact.matches[0]?.title, "Matter of FIXTURE-ALPHA");
    assert.equal(exact.matches[0]?.matchedBy, "exact");
    assert.equal(exact.matches[0]?.citedByCount, 2, "BETA and GAMMA cite 99 I&N Dec. 5");
    const pin = await tx.read((t) => lookupCitation(t, "99 I&N Dec. 12"));
    assert.equal(pin.matches[0]?.title, "Matter of FIXTURE-BETA");
    assert.equal(pin.matches[0]?.matchedBy, "pin_page");
    const byName = await tx.read((t) => lookupCitation(t, "Matter of FIXTURE-DELT"));
    assert.equal(byName.matches[0]?.title, "Matter of FIXTURE-DELTA");
    assert.equal(byName.matches[0]?.matchedBy, "similar");
  });

  await check("reader: slices the text and reports the next offset", async () => {
    const [hit] = (await tx.read((t) => searchLibrary(t, { query: "cancellation" }))).hits;
    const first = await tx.read((t) => readDocument(t, hit.id, 0, 20));
    assert.ok(first);
    assert.equal(first.text.length, 20);
    assert.equal(first.nextOffset, 20);
    const rest = await tx.read((t) => readDocument(t, hit.id, 20, 100_000));
    assert.equal(rest?.nextOffset, null);
    assert.equal(first.text + rest!.text, BASE_DOCS[1].text);
  });

  await check("a very large text is stored whole and indexed up to the cap", async () => {
    const words: string[] = [];
    for (let i = 0, length = 0; length < 1_200_000; i++) {
      const word = `w${i.toString(36)}x`;
      words.push(word);
      length += word.length + 1;
    }
    const big = words.join(" ");
    setFixtureDocs([{ id: "F-BIG", page: 50, title: "Matter of FIXTURE-LARGE", date: "1901-08-01", precedential: true, text: big }]);
    const result = await runDaily(fixtureAdapter.code, { adapter: fixtureAdapter }, deps);
    assert.equal(result.counts.inserted, 1, result.message ?? "");
    const [row] = resultRows<{ text_chars: number; len: number }>(
      await db.execute(sql`select text_chars, length(text) as len from library_documents where external_id = 'F-BIG'`)
    );
    assert.equal(row.len, big.length);
    const early = await tx.read((t) => searchLibrary(t, { query: words[5] }));
    assert.equal(early.hits[0]?.title, "Matter of FIXTURE-LARGE");
  });

  await check("backfill walks in chunks, retries a failed document, then completes", async () => {
    await db.execute(sql`delete from library_backfill_state`);
    setFixtureDocs([
      ...BASE_DOCS,
      { id: "F-6", page: 60, title: "Matter of FIXTURE-ZETA", date: "1901-09-01", precedential: true, text: "Asylum one-year deadline." },
    ]);
    fixture.failOnce.add("F-6");
    const first = await runBackfillChunk(fixtureAdapter.code, { adapter: fixtureAdapter }, deps);
    assert.equal(first.more, true);
    const second = await runBackfillChunk(fixtureAdapter.code, { adapter: fixtureAdapter }, deps);
    assert.equal(second.counts.failed, 1, "F-6 fails once");
    assert.equal(second.more, true, "the failed document is retried");
    const third = await runBackfillChunk(fixtureAdapter.code, { adapter: fixtureAdapter }, deps);
    assert.equal(third.counts.inserted, 1, "F-6 stored on retry");
    assert.equal(third.more, false);
    const [state] = resultRows<{ status: string; chunks_done: number }>(await db.execute(sql`select status, chunks_done from library_backfill_state`));
    assert.equal(state.status, "complete");
    const done = await runBackfillChunk(fixtureAdapter.code, { adapter: fixtureAdapter }, deps);
    assert.equal(done.runId, null, "a complete backfill does nothing");
  });

  await check("listing validators are kept per source: two sources reading one URL do not overwrite each other", async () => {
    await tx.write((t) => syncSources(t, [{ adapter: countryAdapter, missingEnv: [], disabled: false }]));
    const url = "https://fixture.invalid/listing";
    const response = (etag: string): LibraryHttpResponse => ({
      url,
      requestedUrl: url,
      redirects: [],
      status: 200,
      notModified: false,
      contentType: "text/html",
      charset: null,
      body: Buffer.from(""),
      sha256: etag,
      etag: `"${etag}"`,
      lastModified: null,
      retrievedAt: new Date(),
    });
    await tx.write((t) => saveHttpCache(t, fixtureAdapter.code, new Map([[url, response("a")]])));
    await tx.write((t) => saveHttpCache(t, countryAdapter.code, new Map([[url, response("b")]])));
    await tx.write((t) => saveHttpCache(t, fixtureAdapter.code, new Map([[url, response("c")]])));
    const first = await tx.write((t) => loadHttpCache(t, fixtureAdapter.code));
    const second = await tx.write((t) => loadHttpCache(t, countryAdapter.code));
    assert.equal(first.get(url)?.etag, '"c"');
    assert.equal(second.get(url)?.etag, '"b"');
  });

  await check("country filter: a stated country is keyed (aliases folded) and filters search", async () => {
    const result = await runDaily(countryAdapter.code, { adapter: countryAdapter }, deps);
    assert.equal(result.counts.inserted, 3, result.message ?? "");
    const burma = await tx.read((t) => searchLibrary(t, { query: "", country: "Myanmar" }));
    assert.deepEqual(burma.hits.map((h) => h.title), ["Burma 2099 Human Rights Report"]);
    const honduras = await tx.read((t) => searchLibrary(t, { query: "gangs", country: "honduras" }));
    assert.deepEqual(honduras.hits.map((h) => h.title).sort(), ["Honduras 2099 Human Rights Report", "Northern Triangle 2099 overview"]);
    const none = await tx.read((t) => searchLibrary(t, { query: "gangs", country: "Iceland" }));
    assert.equal(none.hits.length, 0);
  });

  await check("prepare: a decision date later than the day the document was read is set aside, not stored", async () => {
    const doc = prepareDocument(
      fixtureAdapter,
      {
        externalId: "F-FUTURE",
        docType: "decision",
        title: "Matter of FIXTURE-FUTURE",
        citations: [],
        decisionDate: "2999-03-06",
        publishedDate: "2099-01-02",
        precedentialStatus: "precedential",
        officialUrl: "https://fixture.invalid/F-FUTURE.pdf",
        text: "A listing typo.",
        metadata: { statedDates: { listed: "03/06/2999" } },
      },
      null
    );
    assert.equal(doc.decisionDate, null);
    assert.deepEqual(doc.metadata.datesSetAside, { decisionDate: "2999-03-06", publishedDate: "2099-01-02", reason: "later than the day the document was read" });
    assert.deepEqual(doc.metadata.statedDates, { listed: "03/06/2999" });
  });

  await check('citations: "section N of the Act" is read as the INA only in text about the INA', async () => {
    const csa = extractCitations("The Administrator may add a substance to schedule I under section 202 of the Act.");
    assert.equal(csa.length, 0, JSON.stringify(csa));
    const ina = extractCitations("Under section 240A(b)(1) of the Act, 8 U.S.C. 1229b(b)(1), the applicant must show hardship.");
    assert.deepEqual(ina.map((c) => c.normalized), ["INA 240A", "8 U.S.C. 1229b"]);
    const aao = extractCitations("See Jul292010_04F1101 and JAN122005_126G1103.");
    assert.deepEqual(aao.map((c) => c.normalized), ["AAO JUL292010_04F1101", "AAO JAN122005_126G1103"]);
  });

  const importDeps = { ...deps, adapter: importFixtureAdapter };
  const page = (title: string, body: string) => Buffer.from(`<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`);
  const IMPORT_URL = "https://fixture.invalid/doc/fixture-notice-1.html";

  await check("manual import: a saved page goes through the source's own parser and the versioned upsert; the run and the audit log record it", async () => {
    const result = await runManualImport({ code: importFixtureAdapter.code, url: IMPORT_URL, bytes: page("Fixture notice 1", "A notice about visas."), importedBy: "user_dbcheck", tenantId: null }, importDeps);
    assert.ok(result.ok && result.outcome === "inserted", JSON.stringify(result));
    const [doc] = resultRows<{ title: string; metadata: { importedManually?: { by: string; fileSha256: string } }; official_url: string }>(
      await db.execute(sql`select title, metadata, official_url from library_documents where source_code = ${importFixtureAdapter.code}`)
    );
    assert.equal(doc.title, "Fixture notice 1");
    assert.equal(doc.official_url, IMPORT_URL);
    assert.equal(doc.metadata.importedManually?.by, "user_dbcheck");
    const [run] = resultRows<{ kind: string; status: string }>(await db.execute(sql`select kind, status from library_fetch_runs where id = ${result.ok ? result.runId : null}`));
    assert.deepEqual(run, { kind: "manual_import", status: "completed" });
    const log = resultRows<{ outcome: string; actor_user_id: string }>(await db.execute(sql`select outcome, actor_user_id from library_import_log`));
    assert.deepEqual(log, [{ outcome: "inserted", actor_user_id: "user_dbcheck" }]);
  });

  await check("manual import: the same page again is unchanged (provenance aside); a changed page is a new version", async () => {
    const same = await runManualImport({ code: importFixtureAdapter.code, url: IMPORT_URL, bytes: page("Fixture notice 1", "A notice about visas."), importedBy: "user_other" }, importDeps);
    assert.ok(same.ok && same.outcome === "unchanged" && same.version === 1, JSON.stringify(same));
    const changed = await runManualImport({ code: importFixtureAdapter.code, url: IMPORT_URL, bytes: page("Fixture notice 1", "A corrected notice about visas."), importedBy: "user_other" }, importDeps);
    assert.ok(changed.ok && changed.outcome === "updated" && changed.version === 2, JSON.stringify(changed));
  });

  await check("manual import: a refused address or file is logged and stores nothing; the log is append-only", async () => {
    const offHost = await runManualImport({ code: importFixtureAdapter.code, url: "https://elsewhere.invalid/doc/x.html", bytes: page("x", "y"), importedBy: "user_dbcheck" }, importDeps);
    assert.ok(!offHost.ok && offHost.outcome === "rejected" && offHost.runId === null);
    const pdf = await runManualImport({ code: importFixtureAdapter.code, url: IMPORT_URL, bytes: Buffer.from("%PDF-1.4\n%%EOF\n"), importedBy: "user_dbcheck" }, importDeps);
    assert.ok(!pdf.ok && pdf.outcome === "rejected");
    const archived = await runManualImport(
      { code: importFixtureAdapter.code, url: IMPORT_URL, bytes: Buffer.from(page("x", "y").toString().replace("<head>", "<head><!-- BEGIN WAYBACK TOOLBAR INSERT -->")), importedBy: "user_dbcheck" },
      importDeps
    );
    assert.ok(!archived.ok && /Internet Archive/.test(archived.error));
    const [{ n }] = resultRows<{ n: number }>(await db.execute(sql`select count(*)::int as n from library_documents where source_code = ${importFixtureAdapter.code}`));
    assert.equal(n, 1);
    // No policy allows UPDATE or DELETE, so in service context they see no rows; outside it an insert is refused.
    await tx.write((t) => t.execute(sql`delete from library_import_log`));
    await tx.write((t) => t.execute(sql`update library_import_log set outcome = 'x'`));
    const log = resultRows<{ outcome: string }>(await db.execute(sql`select outcome from library_import_log order by created_at`));
    assert.deepEqual(log.map((l) => l.outcome), ["inserted", "unchanged", "updated", "rejected", "rejected", "rejected"]);
    await assert.rejects(
      db.transaction(async (t) => {
        await t.execute(sql`set local role app_runtime`);
        await t.execute(sql`insert into library_import_log (source_code, actor_user_id, official_url, file_sha256, file_bytes, outcome) values (${importFixtureAdapter.code}, 'x', 'https://x.invalid/', 'x', 1, 'x')`);
      })
    );
  });

  await check("a manual source syncs as manual, its daily run and backfill are skipped", async () => {
    const manual = { ...importFixtureAdapter, code: "dos_visa_bulletin" };
    await tx.write((t) => syncSources(t, [{ adapter: manual, missingEnv: [], disabled: false, manual: true }]));
    const [row] = resultRows<{ status: string; freshness: { staleAfterHours: number } }>(await db.execute(sql`select status, freshness from library_sources where code = 'dos_visa_bulletin'`));
    assert.equal(row.status, "manual");
    assert.equal(row.freshness.staleAfterHours, importFixtureAdapter.manualImportIntervalDays! * 24);
    assert.equal((await runDaily("dos_visa_bulletin", {}, deps)).status, "skipped");
    assert.equal((await runBackfillChunk("dos_visa_bulletin", {}, deps)).runId, null);
    await tx.write((t) => syncSources(t, [{ adapter: manual, missingEnv: [], disabled: false, manual: false }]));
    const [after] = resultRows<{ status: string }>(await db.execute(sql`select status from library_sources where code = 'dos_visa_bulletin'`));
    assert.equal(after.status, "pending", "a source taken off LIBRARY_MANUAL_SOURCES goes back to pending");
  });

  for (const { code, count } of liveSources) {
    const real = getLibraryAdapter(code);
    if (!real) {
      await check(`live: ${code}`, async () => assert.fail(`no registered collector has the code ${code}`));
      continue;
    }
    const missing = missingEnv(real);
    if (missing.length) {
      console.log(`skip  live: ${code} needs ${missing.join(" and ")}`);
      continue;
    }
    // The first run keeps the first N refs it lists; the second keeps the
    // same documents if they are listed again (a since-filtered listing can
    // list others the second time, which are new documents, not repeats).
    let firstIds: Set<string> | null = null;
    const limited: LibrarySourceAdapter = {
      ...real,
      async listUpdates(ctx, since) {
        const listing = await real.listUpdates(ctx, since);
        if (!firstIds) {
          const refs = listing.refs.slice(0, count);
          firstIds = new Set(refs.map((r) => r.externalId));
          return { refs };
        }
        return { refs: listing.refs.filter((r) => firstIds!.has(r.externalId)) };
      },
    };
    await check(`live: ${code} stores ${count} document(s) from the official source, then finds, looks up and reads them`, async () => {
      await tx.write((t) => syncSources(t, [{ adapter: real, missingEnv: [], disabled: false }]));
      const result = await runDaily(real.code, { adapter: limited }, deps);
      assert.ok(result.status === "completed" || result.status === "partial", `${result.status}: ${result.message ?? ""}`);
      assert.ok(result.counts.inserted > 0, `nothing stored: ${JSON.stringify(result.counts)} ${result.message ?? ""}`);
      const stored = await tx.read((t) => searchLibrary(t, { query: "", sources: [real.code], limit: 50, includeWithdrawn: true }));
      assert.equal(stored.hits.length, result.counts.inserted);
      for (const hit of stored.hits) {
        const read = await tx.read((t) => readDocument(t, hit.id, 0, 300));
        assert.ok(read, `${hit.title} cannot be read back`);
        const word = hit.title.split(/[^A-Za-z]+/).filter((w) => w.length >= 5).sort((a, b) => b.length - a.length)[0];
        if (word && read.textKind !== "none") {
          const found = await tx.read((t) => searchLibrary(t, { query: word, sources: [real.code], includeWithdrawn: true, limit: 50 }));
          assert.ok(found.hits.some((h) => h.id === hit.id), `a search for "${word}" does not find ${hit.title}`);
        }
        if (hit.citations[0]) {
          const lookup = await tx.read((t) => lookupCitation(t, hit.citations[0]));
          assert.ok(lookup.matches.some((m) => m.id === hit.id), `looking up "${hit.citations[0]}" does not find ${hit.title}`);
        }
        const country = read.metadata.country;
        if (typeof country === "string" && Array.isArray(read.metadata.countryKeys)) {
          const byCountry = await tx.read((t) => searchLibrary(t, { query: "", country, sources: [real.code], includeWithdrawn: true, limit: 50 }));
          assert.ok(byCountry.hits.some((h) => h.id === hit.id), `the country filter "${country}" does not find ${hit.title}`);
        }
        console.log(`      ${hit.title.slice(0, 90)} | ${hit.citations[0] ?? "no citation"} | ${read.textKind}, ${read.textChars} characters | ${hit.officialUrl}`);
      }
      const again = await runDaily(real.code, { adapter: limited }, deps);
      assert.equal(again.counts.inserted, 0, `the second run inserted again: ${JSON.stringify(again.counts)}`);
      console.log(`      second run: ${JSON.stringify(again.counts)}`);
    });
  }

  if (liveCount > 0) {
    const real = getLibraryAdapter("eoir_ag_bia_precedents")!;
    const limited: LibrarySourceAdapter = {
      ...real,
      async listUpdates(ctx, since) {
        const listing = await real.listUpdates(ctx, since);
        return { refs: listing.refs.slice(0, liveCount) };
      },
    };
    await check(`live: the BIA/AG adapter stores ${liveCount} decision(s) from justice.gov`, async () => {
      await tx.write((t) => syncSources(t, [{ adapter: real, missingEnv: [], disabled: false }]));
      const result = await runDaily(real.code, { adapter: limited }, deps);
      assert.equal(result.status, "completed", result.message ?? "");
      assert.equal(result.counts.inserted, liveCount);
      const listed = await tx.read((t) => searchLibrary(t, { query: "", sources: [real.code], limit: 50 }));
      console.log(`      stored: ${listed.hits.map((h) => `${h.title}, ${h.citations[0]}`).join(" | ")}`);
      const first = listed.hits[listed.hits.length - 1];
      const lookup = await tx.read((t) => lookupCitation(t, first.citations[0]));
      assert.equal(lookup.matches[0]?.id, first.id);
      const search = await tx.read((t) => searchLibrary(t, { query: "Board", sources: [real.code] }));
      assert.ok(search.hits.length > 0, "a full-text search finds the stored decisions");
      const read = await tx.read((t) => readDocument(t, first.id, 0, 400));
      console.log(`      ${first.title}: ${read?.textChars} characters; opening: ${read?.text.replace(/\s+/g, " ").slice(0, 160)}`);
    });
  }

  console.log(logs.map((l) => `      ${l}`).join("\n"));
  await client.close();
  if (failures) {
    console.log(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
