import "../../../../load-env";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import { resultRows, type LibraryDb, type LibraryTransactions } from "../../db";
import { EoirStatsAggregator } from "./aggregate";
import { judgeProfileLines, judgeSearchLines, statResultLines } from "./format";
import { loadEoirStatistics } from "./load";
import { DEFINITIONS } from "./model";
import { currentSnapshot, judgeProfile, queryStats, searchJudges, StatQueryError } from "./queries";
import { countRows, failSnapshot, finishSnapshot, pruneSnapshots, startSnapshot, writeAggregates } from "./store";

// Checks the EOIR statistics end to end without a Postgres server: every
// migration (0008 included) applied to PGlite, row-level security, the
// aggregator on a small fixture of EOIR's table layouts with known answers,
// the store (snapshots made current, superseded, pruned, a failed load
// cleaned up) and every query the tools and the page run, as the app's
// runtime role.
//
//   npx tsx --conditions=react-server src/services/library/adapters/eoir-statistics/check.ts
//   ... check.ts --live-prefix-mb 16   also loads the first 16 MB (compressed) of each
//                                      table of EOIR's live release and prints the tools' output
//
// The live option reads a prefix only: its counts are partial and are never
// written anywhere but this in-memory database.

const MIGRATIONS = "./src/db/migrations";

const tsv = (rows: string[][]) => rows.map((r) => r.join("\t")).join("\r\n") + "\r\n";

const LOOKUPS: Record<string, string> = {
  "tblLookupJudge.csv": tsv([
    ["idnJudge", "JUDGE_CODE", "JUDGE_NAME", "blnActive"],
    ["1", "AAA", "Judge, Alpha", "1"],
    ["2", "BBB", "Judge, Beta", "1"],
    ["3", "ZZZ", "<All Judges>", "0"],
    ["4", "NEW", "Judge, Newly Appointed", "1"],
  ]),
  "tblLookupBaseCity.csv": tsv([
    ["idnBaseCity", "BASE_CITY_CODE", "BASE_CITY", "BASE_STATE", "strRegion", "blnActive"],
    ["1", "HOU", "HOUSTON", "TX", "Southern", "1"],
    ["2", "SFR", "SAN FRANCISCO", "CA", "Western", "1"],
  ]),
  "tblLookupNationality.csv": tsv([
    ["ID", "NAT_CODE", "NAT_NAME", "blnActive"],
    ["1", "GT", "GUATEMALA", "1"],
    ["2", "HO", "HONDURAS", "1"],
  ]),
  "tblLookupCourtDecision.csv": tsv([
    ["idnCourtDecision", "strCaseType", "strDecCode", "strDecDescription", "strDecType", "blnActive"],
    ["1", "RMV", "X", "Remove", "C", "1"],
    ["2", "RMV", "R", "Relief Granted", "C", "1"],
    ["3", "RMV", "C", "Change of Venue", "O", "1"],
    ["4", "RMV", "X", "ZERO BOND", "O", "1"],
    ["5", "RMV", "O", "Other", "C", "0"],
  ]),
  "tblLookUp_Appln.csv": tsv([
    ["idnAppln", "strcode", "strdescription", "blnActive"],
    ["1", "ASYL", "ASYLUM", "1"],
    ["2", "42B", "EOIR42B", "1"],
  ]),
  "tblLookupCourtAppDecisions.csv": tsv([
    ["idnCourtApplnDec", "strCourtApplnDecCode", "strCourtApplnDecDesc", "blnActive"],
    ["1", "G", "GRANT", "1"],
    ["2", "D", "DENY", "1"],
    ["3", "W", "WITHDRAWN", "1"],
    ["4", "F", "FULL GRANT", "1"],
  ]),
  "tblLookupBIADecision.csv": tsv([
    ["idnBIAdec", "strCode", "strDescription", "blnActive"],
    ["1", "DIS", "Dismiss Appeal/Affirm IJ's Decision", "1"],
    ["2", "REM", "Remand", "1"],
  ]),
  "tbllookupAppealType.csv": tsv([
    ["idnAppealType", "strApplCode", "strApplDescription", "blnActive"],
    ["4", "Case Appeal", "Case Appeal", "1"],
  ]),
  "tblLookupCaseType.csv": tsv([
    ["idnCaseType", "strCode", "strDescription", "blnActive"],
    ["6", "RMV", "Removal", "1"],
  ]),
  "tblLookupCustodyStatus.csv": tsv([
    ["idnCustodyStatus", "strCode", "strDescription", "blnActive"],
    ["1", "N", "Never Detained", "1"],
    ["2", "D", "Detained", "1"],
    ["3", "R", "Released", "1"],
  ]),
  "tblLookupFiledBy.csv": tsv([
    ["idnFiled", "strCode", "strDescription", "blnActive"],
    ["1", "A", "Alien", "1"],
    ["3", "I", "DHS", "1"],
  ]),
};

const REPS = [
  ["IDNREPSASSIGNED", "IDNCASE", "STRATTYLEVEL", "STRATTYTYPE"],
  ["1", "1", "COURT", "ALIEN"],
  ["2", "2", "BIA", "ALIEN"],
  ["3", "3", "COURT", "ALIEN"],
];

const P = ["IDNPROCEEDING", "IDNCASE", "INPUT_DATE", "BASE_CITY_CODE", "IJ_CODE", "DEC_CODE", "OTHER_COMP", "COMP_DATE", "ABSENTIA", "CUSTODY", "CASE_TYPE", "NAT"];
const PROCEEDINGS = [
  P,
  ["101", "1", "2023-01-10 08:00:00.000", "HOU", "AAA", "R", " ", "2023-06-10 00:00:00.000", "N", "D", "RMV", "GT"],
  ["102", "2", "2023-02-01 00:00:00.000", "HOU", "AAA", "X", "", "2023-11-15 00:00:00.000", "Y", "N", "RMV", "HO"],
  ["103", "3", "2022-05-01 00:00:00.000", "HOU", "BBB", " ", "C", "2022-12-01 00:00:00.000", "N", "R", "RMV", "GT"],
  ["104", "4", "2024-01-01 00:00:00.000", "SFR", "AAA", "", "", "", "N", "N", "RMV", "GT"],
  ["105", "5", "2023-03-01 00:00:00.000", "HOU", "AAA", "X", "", "2023-04-01 00:00:00.000", "N", "D", "RMV", "GT"],
];

const APPLICATIONS = [
  ["IDNPROCEEDINGAPPLN", "IDNPROCEEDING", "IDNCASE", "APPL_CODE", "APPL_RECD_DATE", "APPL_DEC"],
  ["1", "101", "1", "ASYL", "2023-02-01 00:00:00.000", "G"],
  ["2", "105", "5", "ASYL", "2023-03-02 00:00:00.000", "D"],
  ["3", "102", "2", "ASYL", "2023-03-02 00:00:00.000", "D"],
  ["4", "103", "3", "ASYL", "2022-06-02 00:00:00.000", "W"],
  ["5", "104", "4", "ASYL", "2024-02-02 00:00:00.000", "G"],
  ["6", "101", "1", "42B", "2023-02-01 00:00:00.000", "G"],
];

const A = ["idnAppeal", "idncase", "idnProceeding", "strAppealCategory", "strAppealType", "datAppealFiled", "strFiledBy", "datBIADecision", "strBIADecision"];
const APPEALS = [
  A,
  ["1", "5", "105", "IJ", "Case Appeal", "2023-04-20 00:00:00.000", "A", "2024-01-01 00:00:00.000", "DIS"],
  ["2", "2", "102", "IJ", "Case Appeal", "2023-12-01 00:00:00.000", "A", "", " "],
  ["3", "1", "101", "IJ", "Case Appeal", "2023-07-01 00:00:00.000", "I", "2024-05-01 00:00:00.000", "REM"],
  ["4", "5", "105", "DD", "DD Visa", "2023-04-20 00:00:00.000", "A", "2024-01-01 00:00:00.000", "DIS"],
];

async function* batches(text: string): AsyncGenerator<string[]> {
  yield text.split("\r\n").filter((l) => l.length > 0);
}

function fixtureAggregate() {
  const agg = new EoirStatsAggregator();
  const notes: string[] = [];
  agg.loadLookups(new Map(Object.entries(LOOKUPS).map(([name, text]) => [name, Buffer.from(text, "utf-8")])), (m) => notes.push(m));
  return { agg, notes };
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function migrateAll(client: PGlite, db: ReturnType<typeof drizzle>): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const [has] = resultRows<{ n: number }>(await db.execute(sql`select count(*)::int as n from pg_tables where tablename = 'eoir_stats_snapshots'`));
  if (has.n === 0) {
    // Until the journal lists 0008, apply it here the way the migrator would.
    const file = path.join(MIGRATIONS, "0008_eoir_statistics.sql");
    for (const statement of fs.readFileSync(file, "utf-8").split("--> statement-breakpoint")) {
      if (statement.trim()) await client.exec(statement);
    }
    console.log("note: 0008 is not in the migration journal yet; applied it directly");
  }
}

async function main() {
  const at = process.argv.indexOf("--live-prefix-mb");
  const liveMb = at >= 0 ? Number(process.argv[at + 1] ?? 16) : 0;

  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzle(client, { schema });
  await migrateAll(client, db);
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

  await check("RLS is enabled and forced on every eoir_stats table", async () => {
    const rows = resultRows<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      await db.execute(sql`select relname, relrowsecurity, relforcerowsecurity from pg_class where relname like 'eoir_stats_%' and relkind = 'r' order by relname`)
    );
    assert.equal(rows.length, 10, rows.map((r) => r.relname).join(", "));
    for (const r of rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity, `${r.relname} is not forced`);
  });

  await check("the runtime role cannot write the statistics outside service context", async () => {
    await assert.rejects(
      db.transaction(async (t) => {
        await t.execute(sql`set local role app_runtime`);
        await t.execute(sql`insert into eoir_stats_snapshots (page_url, official_url) values ('https://x.invalid/', 'https://x.invalid/')`);
      }),
      (err: unknown) => /row-level security/i.test(String((err as { cause?: { message?: string } }).cause?.message ?? (err as Error).message))
    );
  });

  const { agg, notes } = fixtureAggregate();
  await check("the aggregator reads EOIR's table layouts and joins them", async () => {
    assert.deepEqual(notes, []);
    await agg.consume("reps", batches(tsv(REPS)));
    const p = await agg.consume("proceedings", batches(tsv(PROCEEDINGS) + "999\t1\r\n"));
    assert.equal(p.rows, 6);
    assert.equal(p.malformed, 1);
    assert.equal(p.used, 4);
    assert.equal(p.skipped["not completed (no COMP_DATE)"], 1);
    const a = await agg.consume("applications", batches(tsv(APPLICATIONS)));
    assert.equal(a.used, 5);
    const ap = await agg.consume("appeals", batches(tsv(APPEALS)));
    assert.equal(ap.used, 3);
  });

  await check("a table without a needed column fails the load with a layout error", async () => {
    const { agg: other } = fixtureAggregate();
    await assert.rejects(other.consume("proceedings", batches(tsv([["IDNPROCEEDING", "IDNCASE"], ["1", "2"]]))), /no longer has the layout/);
  });

  const result = agg.result();
  await check("judges and courts: EOIR's names, completions and years; the <All Judges> entry left out", async () => {
    const alpha = result.judges.find((j) => j.code === "AAA")!;
    assert.equal(alpha.name, "Judge, Alpha");
    assert.equal(alpha.completions, 3);
    assert.equal(alpha.firstFy, 2023);
    assert.equal(alpha.lastFy, 2024);
    assert.ok(result.judges.some((j) => j.code === "NEW" && j.completions === 0));
    assert.ok(!result.judges.some((j) => j.code === "ZZZ"));
    assert.equal(result.courts.find((c) => c.code === "HOU")!.completions, 4);
    const codes = result.codes.filter((c) => c.codeSet === "ij_decision" && c.code === "X");
    assert.equal(codes.length, 1);
    assert.equal(codes[0].description, "Remove");
    assert.equal(result.codes.find((c) => c.codeSet === "other_completion" && c.code === "X")?.description, "ZERO BOND");
    assert.equal(result.codes.find((c) => c.codeSet === "application_decision" && c.code === "F")?.grouping, "granted");
  });

  let firstId = "";
  await check("a load is written, made current, and its counts read back", async () => {
    firstId = await tx.write((t) =>
      startSnapshot(
        t,
        { releaseFolder: "EOIR Case Data 2026-0901", dataDate: "2026-09-01", listedLabel: "August 2026", pageUrl: "https://www.justice.gov/eoir/foia-library-0", officialUrl: "https://fileshare.eoir.justice.gov/EOIR%20Case%20Data.zip", codeKeyUrl: null, archiveEtag: '"x"', archiveLastModified: null, archiveBytes: 1 },
        { ...DEFINITIONS }
      )
    );
    const rowCounts = await writeAggregates(tx, firstId, result);
    await tx.write((t) => finishSnapshot(t, firstId, { tableCounts: result.tables, rowCounts, notes: [] }));
    const counted = await tx.read((t) => countRows(t, firstId));
    assert.equal(counted.eoir_stats_proceedings, rowCounts.proceedings);
    assert.equal(counted.eoir_stats_judges, result.judges.length);
  });

  await check("judge search by name, code and court", async () => {
    await tx.read(async (t) => {
      const snap = (await currentSnapshot(t))!;
      assert.equal(snap.id, firstId);
      assert.equal((await searchJudges(t, snap, { query: "alpha" })).judges[0].code, "AAA");
      assert.equal((await searchJudges(t, snap, { query: "bbb" })).judges[0].name, "Judge, Beta");
      const atSfr = await searchJudges(t, snap, { court: "SFR" });
      assert.equal(atSfr.total, 0, "AAA's SFR proceeding never completed, so AAA has no SFR completions");
      const atHou = await searchJudges(t, snap, { court: "hou" });
      assert.deepEqual(atHou.judges.map((j) => j.code).sort(), ["AAA", "BBB"]);
    });
  });

  await check("judge profile: completions, asylum against court and nation, appeals, processing", async () => {
    await tx.read(async (t) => {
      const snap = (await currentSnapshot(t))!;
      const p = (await judgeProfile(t, snap, { judgeCode: "aaa", fyFrom: 2020, fyTo: 2026 }))!;
      assert.equal(p.totals.completions, 3);
      assert.equal(p.totals.absentia, 1);
      assert.equal(p.totals.represented, 1);
      assert.deepEqual(p.asylum[0].counts, { granted: 1, denied: 2, other: 0, total: 3 });
      const hou = p.asylum.find((a) => a.scope === "court")!;
      assert.deepEqual(hou.counts, { granted: 1, denied: 2, other: 1, total: 4 });
      assert.equal(p.appeals.total, 2 + 1);
      assert.equal(p.appeals.pending, 1);
      assert.equal(p.appeals.groups.dismissed, 1);
      assert.equal(p.appeals.groups.remanded, 1);
      const fy2023 = p.processing.find((r) => r.fy === 2023)!;
      assert.equal(fy2023.judge!.n, 2);
      assert.equal(fy2023.judge!.mean, (151 + 31) / 2);
      assert.equal(p.asylumNationalities.find((n) => n.nationality === "GT")!.name, "GUATEMALA");
      const text = judgeProfileLines(snap, p).join("\n");
      assert.match(text, /do not predict the outcome of any individual case/);
      assert.match(text, /grant rate of decided 33\.3% \(1 of 3\) \[small number: 3\]/);
    });
  });

  await check("query_eoir_stats: applications, completions by nationality, appeals, processing, refusals", async () => {
    await tx.read(async (t) => {
      const snap = (await currentSnapshot(t))!;
      const byRep = await queryStats(t, snap, { measure: "applications", court: "HOU", groupBy: "represented" });
      assert.ok(byRep.defaultsApplied.some((d) => d.includes("ASYL")));
      assert.equal(byRep.totals.applications, 4);
      assert.equal(byRep.totals.grant_rate_of_decided, 1 / 3);
      const nat = await queryStats(t, snap, { measure: "completions", nationality: "gt", groupBy: "fy" });
      assert.equal(nat.table, "eoir_stats_proceedings_nat");
      assert.equal(nat.totals.completions, 3);
      const outcomes = await queryStats(t, snap, { measure: "completions", judge: "AAA", groupBy: "outcome" });
      assert.ok(outcomes.rows.some((r) => r.label === "Remove" && r.values.completions === 2));
      const appeals = await queryStats(t, snap, { measure: "appeals", judge: "AAA", groupBy: "decision" });
      assert.equal(appeals.totals.pending, 1);
      assert.ok(appeals.rows.some((r) => r.key === "REM" && r.label === "Remand"));
      const proc = await queryStats(t, snap, { measure: "processing", court: "HOU", custody: "D" });
      assert.equal(proc.rows.length, 1);
      await assert.rejects(queryStats(t, snap, { measure: "completions", judge: "AAA", nationality: "GT" }), StatQueryError);
      await assert.rejects(queryStats(t, snap, { measure: "applications", nationality: "GT", custody: "D" }), StatQueryError);
      const text = statResultLines(snap, byRep).join("\n");
      assert.match(text, /Snapshot: EOIR case data release "EOIR Case Data 2026-0901", data as of 2026-09-01/);
      assert.match(text, /Filters: court HOU, application ASYL/);
    });
  });

  await check("a second load supersedes the first, and the first is pruned", async () => {
    const secondId = await tx.write((t) =>
      startSnapshot(t, { releaseFolder: "EOIR Case Data 2026-1001", dataDate: "2026-10-01", listedLabel: "September 2026", pageUrl: "https://www.justice.gov/eoir/foia-library-0", officialUrl: "https://fileshare.eoir.justice.gov/EOIR%20Case%20Data.zip", codeKeyUrl: null, archiveEtag: '"y"', archiveLastModified: null, archiveBytes: 2 }, { ...DEFINITIONS })
    );
    const rowCounts = await writeAggregates(tx, secondId, result);
    await tx.write((t) => finishSnapshot(t, secondId, { tableCounts: result.tables, rowCounts, notes: [] }));
    assert.equal(await tx.write((t) => pruneSnapshots(t)), 1);
    const snap = await tx.read((t) => currentSnapshot(t));
    assert.equal(snap!.id, secondId);
    const left = resultRows<{ n: number }>(await db.execute(sql`select count(*)::int as n from eoir_stats_proceedings where snapshot_id = ${firstId}`));
    assert.equal(left[0].n, 0);
  });

  await check("a failed load leaves its snapshot as failed, with no rows, and the current one untouched", async () => {
    const failedId = await tx.write((t) =>
      startSnapshot(t, { releaseFolder: "x", dataDate: null, listedLabel: null, pageUrl: "https://www.justice.gov/eoir/foia-library-0", officialUrl: "https://fileshare.eoir.justice.gov/EOIR%20Case%20Data.zip", codeKeyUrl: null, archiveEtag: null, archiveLastModified: null, archiveBytes: null }, {})
    );
    await writeAggregates(tx, failedId, result);
    await failSnapshot(tx, failedId, "test failure");
    const counted = await tx.read((t) => countRows(t, failedId));
    assert.ok(Object.values(counted).every((n) => n === 0));
    const [row] = resultRows<{ status: string; error: string }>(await db.execute(sql`select status, error from eoir_stats_snapshots where id = ${failedId}`));
    assert.equal(row.status, "failed");
    assert.ok((await tx.read((t) => currentSnapshot(t)))!.id !== failedId);
  });

  if (liveMb > 0) {
    console.log(`\nLive: the first ${liveMb} MB (compressed) of each table of EOIR's current release...`);
    const outcome = await loadEoirStatistics({
      transactions: tx,
      signal: new AbortController().signal,
      log: (line) => console.log(`  ${line}`),
      force: true,
      maxCompressedBytesPerTable: liveMb * 1024 * 1024,
    });
    console.log(`  outcome: ${JSON.stringify(outcome)}`);
    await tx.read(async (t) => {
      const snap = (await currentSnapshot(t))!;
      const found = await searchJudges(t, snap, { court: "HOU", limit: 5 });
      console.log("\n--- search_eoir_judges {court: HOU} ---\n" + judgeSearchLines(snap, { court: "HOU" }, found, 0).join("\n"));
      const top = found.judges[0];
      if (top) {
        const p = (await judgeProfile(t, snap, { judgeCode: top.code }))!;
        console.log(`\n--- eoir_judge_profile {judge_code: ${top.code}} ---\n` + judgeProfileLines(snap, p).join("\n"));
      }
      const q = await queryStats(t, snap, { measure: "applications", application: "ASYL", groupBy: "nationality", fyFrom: 2020, limit: 8 });
      console.log("\n--- query_eoir_stats {measure: applications, group_by: nationality, fy_from: 2020} ---\n" + statResultLines(snap, q).join("\n"));
      const ap = await queryStats(t, snap, { measure: "appeals", court: "HOU", groupBy: "fy", fyFrom: 2018 });
      console.log("\n--- query_eoir_stats {measure: appeals, court: HOU, group_by: fy} ---\n" + statResultLines(snap, ap).join("\n"));
    });
  }

  await client.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
