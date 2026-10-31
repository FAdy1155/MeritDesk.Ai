import Link from "next/link";
import { getCurrentTenant } from "@/lib/tenant";
import { decisionLine, fyRange, int, pct, smallFlag, snapshotStale } from "@/services/library/adapters/eoir-statistics/format";
import { DEFINITIONS, NOT_A_PREDICTION } from "@/services/library/adapters/eoir-statistics/model";
import type { JudgeProfile, JudgeSummary } from "@/services/library/adapters/eoir-statistics/queries";
import { getEoirJudgeProfile, loadEoirStatsOverview, searchEoirJudges, type EoirStatsOverview } from "@/services/library/adapters/eoir-statistics/service";
import { formatUtc, muted, OfficialLink, ToneBadge } from "../ui";

// EOIR court and judge statistics: the app's aggregate of EOIR's public case
// data release (src/services/library/adapters/eoir-statistics/), with the
// snapshot it comes from, a judge search, one judge's profile and the
// courts. The same figures the skill runs get from search_eoir_judges,
// eoir_judge_profile and query_eoir_stats. A GET form, so every view is a
// link. Read-only for every role.

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

function fyParam(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1950 && n <= 2100 ? n : null;
}

const cell = "border-b border-black/10 px-2 py-1 align-top dark:border-white/10";

export default async function EoirStatisticsPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  await getCurrentTenant();
  const params = await searchParams;
  const q = first(params.q).slice(0, 100);
  const court = first(params.court).slice(0, 5).toUpperCase();
  const judgeCode = first(params.judge).slice(0, 5).toUpperCase();
  const fyFrom = fyParam(first(params.from));
  const fyTo = fyParam(first(params.to));

  let overview: EoirStatsOverview | null = null;
  let judges: { judges: JudgeSummary[]; total: number } | null = null;
  let profile: JudgeProfile | null = null;
  let error: string | null = null;
  try {
    overview = await loadEoirStatsOverview();
    if (overview.snapshot && (q || court)) judges = await searchEoirJudges({ query: q || null, court: court || null, limit: 30 });
    if (overview.snapshot && judgeCode) profile = (await getEoirJudgeProfile({ judgeCode, fyFrom, fyTo })).profile;
  } catch {
    error = "The EOIR statistics could not be read. If the database was just updated, run the migrations (npm run db:migrate).";
  }
  const snapshot = overview?.snapshot ?? null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm">
          <Link href="/library" className="underline">
            Library
          </Link>
        </p>
        <h1 className="text-xl font-semibold">EOIR court and judge statistics</h1>
        <p className={`text-sm ${muted}`}>
          Counts this app computes from EOIR&apos;s public case data release (the &quot;EOIR Case Data&quot; file in EOIR&apos;s FOIA
          library), loaded when EOIR posts a new release: completions and outcomes by judge and court, asylum and other relief,
          Board appeals and processing times. They are not figures EOIR publishes, and only aggregate counts are kept: no
          record of any person or case.
        </p>
        <p className="text-sm text-amber-800 dark:text-amber-200">{NOT_A_PREDICTION}</p>
        {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      </div>

      <SnapshotCard overview={overview} />

      {snapshot && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Find a judge</h2>
          <form action="/library/eoir-statistics" className="flex flex-wrap gap-2">
            <input
              name="q"
              type="search"
              defaultValue={q}
              placeholder="Judge's name as EOIR records it, or judge code"
              className="min-w-64 flex-1 rounded-md border border-black/20 bg-transparent px-3 py-1.5 text-sm dark:border-white/20"
            />
            <input
              name="court"
              defaultValue={court}
              placeholder="Court code (HOU)"
              className="w-36 rounded-md border border-black/20 bg-transparent px-3 py-1.5 text-sm dark:border-white/20"
            />
            <button type="submit" className="rounded-md bg-black px-3 py-1.5 text-sm text-white dark:bg-white dark:text-black">
              Search
            </button>
          </form>
          {judges && <JudgeList judges={judges.judges} total={judges.total} />}
        </section>
      )}

      {snapshot && judgeCode && !profile && !error && <p className="text-sm">No judge has the code {judgeCode} in this snapshot.</p>}
      {snapshot && profile && <ProfileView profile={profile} fyFrom={fyFrom} fyTo={fyTo} />}

      {snapshot && overview && overview.courts.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Courts</h2>
          <p className={`text-xs ${muted}`}>Immigration courts (EOIR base cities) by completions in the release. Select a court to list its judges.</p>
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                <th className={cell}>Court</th>
                <th className={cell}>Code</th>
                <th className={cell}>Region</th>
                <th className={cell}>Completions</th>
                <th className={cell}>Fiscal years</th>
              </tr>
            </thead>
            <tbody>
              {overview.courts
                .filter((c) => c.completions > 0)
                .map((c) => (
                  <tr key={c.code}>
                    <td className={cell}>
                      <Link href={`/library/eoir-statistics?court=${encodeURIComponent(c.code)}`} className="underline">
                        {c.name ?? c.code}
                      </Link>
                      {c.lookupActive === false && <span className={muted}> (inactive)</span>}
                    </td>
                    <td className={cell}>{c.code}</td>
                    <td className={cell}>{c.region ?? ""}</td>
                    <td className={cell}>{int(c.completions)}</td>
                    <td className={cell}>{fyRange(c.firstFy, c.lastFy)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Definitions</h2>
        <ul className={`flex list-disc flex-col gap-1 pl-5 text-xs ${muted}`}>
          {Object.values(DEFINITIONS).map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function SnapshotCard({ overview }: { overview: EoirStatsOverview | null }) {
  const snapshot = overview?.snapshot ?? null;
  const latest = overview?.latest ?? null;
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-black/10 p-4 text-sm dark:border-white/10">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Data snapshot</h2>
        {snapshot ? (
          snapshotStale(snapshot) ? (
            <ToneBadge label="Stale" tone="amber" title="No newer release has been loaded for over 45 days." />
          ) : (
            <ToneBadge label="Current" tone="green" />
          )
        ) : (
          <ToneBadge label="Not loaded yet" tone="gray" />
        )}
        {latest && latest.status === "loading" && <ToneBadge label="Loading a release" tone="gray" />}
        {latest && latest.status === "failed" && <ToneBadge label="Last load failed" tone="red" title={latest.error} />}
      </div>
      {snapshot ? (
        <dl className={`grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs ${muted}`}>
          <dt>Release</dt>
          <dd>
            {snapshot.releaseFolder ?? "folder not stated"}
            {snapshot.listedLabel ? ` (listed by EOIR as ${snapshot.listedLabel})` : ""}
          </dd>
          <dt>Data as of</dt>
          <dd>{snapshot.dataDate ?? "not stated by the release"}</dd>
          <dt>Loaded</dt>
          <dd>{formatUtc(snapshot.loadedAt)}</dd>
          <dt>Official file</dt>
          <dd>
            <OfficialLink url={snapshot.officialUrl} />
          </dd>
          <dt>Listed on</dt>
          <dd>
            <OfficialLink url={snapshot.pageUrl} />
          </dd>
          {snapshot.codeKeyUrl && (
            <>
              <dt>Code key</dt>
              <dd>
                <OfficialLink url={snapshot.codeKeyUrl} />
              </dd>
            </>
          )}
          <dt>Rows kept</dt>
          <dd>
            {Object.entries(snapshot.rowCounts)
              .map(([k, v]) => `${k} ${int(Number(v))}`)
              .join("; ")}
          </dd>
        </dl>
      ) : (
        <p className={`text-xs ${muted}`}>
          The worker has not loaded EOIR&apos;s case data release yet. It checks EOIR&apos;s FOIA library every day and loads a new
          release when one is posted.
        </p>
      )}
      {snapshot && snapshot.notes.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-amber-800 dark:text-amber-200">
          {snapshot.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {latest && latest.status === "failed" && latest.error && (
        <p className="text-xs text-red-700 dark:text-red-300">
          Last attempt ({formatUtc(latest.startedAt)}): {latest.error}
        </p>
      )}
    </article>
  );
}

function JudgeList({ judges, total }: { judges: JudgeSummary[]; total: number }) {
  if (judges.length === 0) return <p className="text-sm">No judge matches.</p>;
  return (
    <div className="flex flex-col gap-1">
      <p className={`text-xs ${muted}`}>
        {total} judge{total === 1 ? "" : "s"}
        {total > judges.length ? `, the first ${judges.length} shown` : ""}. Names are EOIR&apos;s.
      </p>
      <ul className="flex flex-col gap-1 text-sm">
        {judges.map((j) => (
          <li key={j.code}>
            <Link href={`/library/eoir-statistics?judge=${encodeURIComponent(j.code)}`} className="underline">
              {j.name ?? "(no name in EOIR's lookup)"}
            </Link>{" "}
            <span className={`text-xs ${muted}`}>
              [{j.code}] {int(j.completions)} completions{j.firstFy ? `, ${fyRange(j.firstFy, j.lastFy)}` : ""}
              {j.courts.length ? `; ${j.courts.slice(0, 3).map((c) => `${c.courtName ?? c.court} ${int(c.completions)}`).join(", ")}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProfileView({ profile: p, fyFrom, fyTo }: { profile: JudgeProfile; fyFrom: number | null; fyTo: number | null }) {
  const t = p.totals;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-black/10 p-4 text-sm dark:border-white/10">
      <div>
        <h2 className="text-lg font-semibold">
          {p.judge.name ?? "(no name in EOIR's lookup)"} <span className={`text-sm ${muted}`}>[{p.judge.code}]</span>
        </h2>
        <p className={`text-xs ${muted}`}>
          {fyRange(p.period.fyFrom, p.period.fyTo)} ({p.period.applied}). Courts in the release:{" "}
          {p.judge.courts.map((c) => `${c.courtName ?? c.court} (${c.court}) ${int(c.completions)}, ${fyRange(c.firstFy, c.lastFy)}`).join("; ") || "none"}.
        </p>
        <form action="/library/eoir-statistics" className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <input type="hidden" name="judge" value={p.judge.code} />
          <label>
            From FY <input name="from" defaultValue={fyFrom ?? ""} className="w-16 rounded border border-black/20 bg-transparent px-1 dark:border-white/20" />
          </label>
          <label>
            to FY <input name="to" defaultValue={fyTo ?? ""} className="w-16 rounded border border-black/20 bg-transparent px-1 dark:border-white/20" />
          </label>
          <button type="submit" className="rounded border border-black/20 px-2 py-0.5 dark:border-white/20">
            Apply
          </button>
        </form>
      </div>

      <p>
        {int(t.completions)} completions: {int(t.decisions)} decisions, {int(t.otherCompletions)} other completions (change of venue,
        transfer, administrative closure and similar){t.noCode ? `, ${int(t.noCode)} with no code` : ""}. In absentia {int(t.absentia)} (
        {t.decisions ? pct(t.absentia / t.decisions) : "n/a"} of decisions). Represented {int(t.represented)} (
        {t.completions ? pct(t.represented / t.completions) : "n/a"}). Detained {int(t.detained)}, released {int(t.released)}, never
        detained {int(t.neverDetained)}.
      </p>

      <h3 className="font-semibold">Asylum (ASYL) decisions</h3>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-xs">
        {[...p.asylum.map((a) => ({ k: a.label, c: a.counts })), ...p.asylumBy.map((a) => ({ k: `This judge, ${a.value}`, c: a.counts }))].map((r) => (
          <li key={r.k}>
            <span className="font-medium">{r.k}:</span> {decisionLine(r.c)}
          </li>
        ))}
      </ul>

      <h3 className="font-semibold">Other relief before this judge</h3>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-xs">
        {p.relief.length ? (
          p.relief.map((r) => (
            <li key={r.appl}>
              <span className="font-medium">
                {r.appl} {r.description ?? ""}:
              </span>{" "}
              {decisionLine(r.counts)}
            </li>
          ))
        ) : (
          <li>none in the period</li>
        )}
      </ul>

      <h3 className="font-semibold">Asylum by nationality (this judge)</h3>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-xs">
        {p.asylumNationalities.length ? (
          p.asylumNationalities.map((n) => (
            <li key={n.nationality}>
              <span className="font-medium">{n.name ?? n.nationality}:</span> {decisionLine(n.counts)}
            </li>
          ))
        ) : (
          <li>none in the period</li>
        )}
      </ul>

      <h3 className="font-semibold">Outcomes</h3>
      <table className="w-full text-left text-xs">
        <thead>
          <tr>
            <th className={cell}>Case type</th>
            <th className={cell}>Kind</th>
            <th className={cell}>Code</th>
            <th className={cell}>EOIR description</th>
            <th className={cell}>Completions</th>
            <th className={cell}>Share</th>
          </tr>
        </thead>
        <tbody>
          {p.outcomes.map((o) => (
            <tr key={`${o.caseType}|${o.kind}|${o.code}`}>
              <td className={cell}>{o.caseType}</td>
              <td className={cell}>{o.kind === "decision" ? "decision" : o.kind === "other" ? "other completion" : "none"}</td>
              <td className={cell}>{o.code}</td>
              <td className={cell}>{o.description ?? ""}</td>
              <td className={cell}>{int(o.n)}</td>
              <td className={cell}>{t.completions ? pct(o.n / t.completions) : "n/a"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="font-semibold">By fiscal year</h3>
      <table className="w-full text-left text-xs">
        <thead>
          <tr>
            <th className={cell}>FY</th>
            <th className={cell}>Completions</th>
            <th className={cell}>Decisions</th>
            <th className={cell}>Other completions</th>
            <th className={cell}>In absentia</th>
            <th className={cell}>Median days, this judge</th>
            <th className={cell}>Median days, all courts</th>
          </tr>
        </thead>
        <tbody>
          {p.completionsByFy.map((r) => {
            const proc = p.processing.find((x) => x.fy === r.fy);
            return (
              <tr key={r.fy}>
                <td className={cell}>{r.fy}</td>
                <td className={cell}>{int(r.completions)}</td>
                <td className={cell}>{int(r.decisions)}</td>
                <td className={cell}>{int(r.otherCompletions)}</td>
                <td className={cell}>{int(r.absentia)}</td>
                <td className={cell}>{proc?.judge ? `${proc.judge.p50} (${int(proc.judge.n)})${smallFlag(proc.judge.n)}` : "n/a"}</td>
                <td className={cell}>{proc?.national ? `${proc.national.p50} (${int(proc.national.n)})` : "n/a"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3 className="font-semibold">Board appeals (Case Appeal) from these completions</h3>
      <p className="text-xs">
        {int(p.appeals.total)} appeals; {int(p.appeals.pending)} pending; {int(p.appeals.total - p.appeals.pending)} decided
        {smallFlag(p.appeals.total - p.appeals.pending)}
        {Object.keys(p.appeals.groups).length
          ? `: ${Object.entries(p.appeals.groups)
              .sort((a, b) => b[1] - a[1])
              .map(([g, n]) => `${g.replace(/_/g, " ")} ${int(n)} (${pct(n / Math.max(1, p.appeals.total - p.appeals.pending))})`)
              .join(", ")}`
          : ""}
        . Filed by: {Object.entries(p.appeals.filedBy).map(([k, n]) => `${k} ${int(n)}`).join(", ") || "none"}.
      </p>
      <p className="text-xs text-amber-800 dark:text-amber-200">{NOT_A_PREDICTION}</p>
    </section>
  );
}
