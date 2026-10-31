import { DEFINITIONS, NOT_A_PREDICTION, SMALL_N } from "./model";
import type { DecisionCounts, JudgeProfile, JudgeSummary, SnapshotView, StatResult } from "./queries";

// The text the skill tools return (and the helpers the page shares):
// percentages, counts with their denominators, the small-number flag, the
// line that names the snapshot every result comes from, and each tool's
// result. Pure, so the local check prints exactly what the model is given.

export function int(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function pct(value: number | null, digits = 1): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(digits)}%`;
}

export function smallFlag(denominator: number): string {
  return denominator > 0 && denominator < SMALL_N ? ` [small number: ${denominator}]` : "";
}

/** "granted 120, denied 80, other or no decision 40 (240 applications); grant rate of decided 60.0% (120 of 200); grant share of all 50.0% (120 of 240)". */
export function decisionLine(c: DecisionCounts): string {
  if (c.total === 0) return "no applications";
  const decided = c.granted + c.denied;
  return (
    `granted ${int(c.granted)}, denied ${int(c.denied)}, other or no decision ${int(c.other)} (${int(c.total)} applications); ` +
    `grant rate of decided ${decided ? pct(c.granted / decided) : "n/a"} (${int(c.granted)} of ${int(decided)})${smallFlag(decided)}; ` +
    `grant share of all ${pct(c.granted / c.total)} (${int(c.granted)} of ${int(c.total)})`
  );
}

/** Whether the loaded release is overdue: EOIR posts monthly, so a snapshot loaded more than 45 days ago is stale. */
export function snapshotStale(snapshot: SnapshotView, now = new Date()): boolean {
  return !snapshot.loadedAt || now.getTime() - snapshot.loadedAt.getTime() > 45 * 24 * 60 * 60 * 1000;
}

export function snapshotLine(snapshot: SnapshotView): string {
  const loaded = snapshot.loadedAt ? snapshot.loadedAt.toISOString().slice(0, 10) : "unknown";
  return (
    `Snapshot: EOIR case data release ${snapshot.releaseFolder ? `"${snapshot.releaseFolder}"` : "(folder not stated)"}` +
    `${snapshot.dataDate ? `, data as of ${snapshot.dataDate}` : ""}${snapshot.listedLabel ? ` (listed by EOIR as ${snapshot.listedLabel})` : ""}, loaded by this app ${loaded}` +
    `${snapshotStale(snapshot) ? " (STALE: no newer release loaded for over 45 days; say so)" : ""}. ` +
    `Official source: ${snapshot.officialUrl} (EOIR FOIA library: ${snapshot.pageUrl}).` +
    (snapshot.notes.length ? ` Notes from the load: ${snapshot.notes.join(" ")}` : "")
  );
}

export function fyRange(from: number | null, to: number | null): string {
  if (from === null && to === null) return "all fiscal years";
  if (from !== null && to !== null) return from === to ? `FY ${from}` : `FY ${from} to FY ${to}`;
  return from !== null ? `FY ${from} onward` : `through FY ${to}`;
}

export const RESULT_HEADER =
  "From this app's EOIR statistics: aggregate counts it computes from EOIR's public case data release (not figures EOIR publishes). Cite them as computed from EOIR case data, with the snapshot below.";

const HEADER = RESULT_HEADER;

export function judgeSearchLines(snapshot: SnapshotView, q: { name?: string | null; court?: string | null }, found: { judges: JudgeSummary[]; total: number }, offset: number): string[] {
  const lines = [
    HEADER,
    snapshotLine(snapshot),
    "",
    `Immigration judges matching ${[q.name ? `"${q.name}"` : null, q.court ? `court ${q.court.toUpperCase()}` : null].filter(Boolean).join(" at ")}: ${found.total === 0 ? "none" : `${offset + 1}-${offset + found.judges.length} of ${found.total}`}.`,
    "",
    ...found.judges.flatMap((j, i) => [
      `${offset + i + 1}. ${j.name ?? "(no name in EOIR's lookup)"} [judge_code ${j.code}]${j.lookupActive === false ? " (inactive in EOIR's judge list)" : ""}: ${int(j.completions)} completions${j.firstFy ? `, ${fyRange(j.firstFy, j.lastFy)}` : ""}`,
      ...(j.courts.length
        ? [`   Courts: ${j.courts.slice(0, 5).map((c) => `${c.courtName ?? c.court} (${c.court}) ${int(c.completions)}, ${fyRange(c.firstFy, c.lastFy)}`).join("; ")}${j.courts.length > 5 ? `; and ${j.courts.length - 5} more` : ""}`]
        : []),
    ]),
    offset + found.judges.length < found.total ? `More: call search_eoir_judges again with offset ${offset + found.judges.length}.` : "",
    "",
    "Names are EOIR's (tblLookupJudge); the court is where the judge's completed proceedings were. Use eoir_judge_profile with a judge_code for outcomes, relief, appeals and processing times.",
  ];
  return lines;
}

export function judgeProfileLines(snapshot: SnapshotView, p: JudgeProfile): string[] {
  const t = p.totals;
  const lines = [
    HEADER,
    snapshotLine(snapshot),
    "",
    `Immigration Judge ${p.judge.name ?? "(no name in EOIR's lookup)"} [judge_code ${p.judge.code}]. Period: ${fyRange(p.period.fyFrom, p.period.fyTo)} (${p.period.applied}), by fiscal year of completion.`,
    `Courts (whole release): ${p.judge.courts.map((c) => `${c.courtName ?? c.court} (${c.court}) ${int(c.completions)}, ${fyRange(c.firstFy, c.lastFy)}`).join("; ") || "none"}.`,
    "",
    `Completions in the period: ${int(t.completions)} (judge's decisions ${int(t.decisions)}; other completions such as change of venue, transfer or administrative closure ${int(t.otherCompletions)}; no code ${int(t.noCode)}).`,
    `In absentia: ${int(t.absentia)} (${t.decisions ? pct(t.absentia / t.decisions) : "n/a"} of ${int(t.decisions)} decisions).`,
    `Represented at the court: ${int(t.represented)} of ${int(t.completions)} (${t.completions ? pct(t.represented / t.completions) : "n/a"}). Custody: detained ${int(t.detained)}, released ${int(t.released)}, never detained ${int(t.neverDetained)}, of ${int(t.completions)}.`,
    "",
    "By fiscal year (completions; decisions; other completions; in absentia):",
    ...p.completionsByFy.map((r) => `- FY ${r.fy}: ${int(r.completions)}; ${int(r.decisions)}; ${int(r.otherCompletions)}; ${int(r.absentia)}`),
    "",
    `Outcomes (EOIR's decision and completion codes, with EOIR's descriptions; share of the ${int(t.completions)} completions):`,
    ...p.outcomes.map((o) => `- ${o.caseType} ${o.kind === "decision" ? "decision" : o.kind === "other" ? "other completion" : ""} ${o.code || ""}: ${o.description ?? "(no description in the lookup)"}: ${int(o.n)} (${t.completions ? pct(o.n / t.completions) : "n/a"})`),
    "",
    "Asylum applications (ASYL) decided in completed proceedings in the period:",
    ...p.asylum.map((a) => `- ${a.label}: ${decisionLine(a.counts)}`),
    "Asylum, this judge, by representation and custody:",
    ...p.asylumBy.map((a) => `- ${a.value}: ${decisionLine(a.counts)}`),
    "",
    "Applications for relief before this judge in the period (top by number):",
    ...p.relief.map((r) => `- ${r.appl} ${r.description ?? ""}: ${decisionLine(r.counts)}`),
    "",
    "Asylum by nationality, this judge (top 10 by number):",
    ...(p.asylumNationalities.length ? p.asylumNationalities.map((n) => `- ${n.name ?? n.nationality} (${n.nationality}): ${decisionLine(n.counts)}`) : ["- none"]),
    "",
    "Processing time, days from receipt by the court to completion (median, to within 30 days; mean exact):",
    ...p.processing.map(
      (r) =>
        `- FY ${r.fy}: this judge ${r.judge ? `median ${r.judge.p50}, mean ${r.judge.mean} (${int(r.judge.n)} completions)${smallFlag(r.judge.n)}` : "n/a"}; all courts ${r.national ? `median ${r.national.p50}, mean ${r.national.mean} (${int(r.national.n)})` : "n/a"}`
    ),
    "",
    `Appeals to the Board (Case Appeal) from this judge's completions in the period: ${int(p.appeals.total)}; pending ${int(p.appeals.pending)}; decided ${int(p.appeals.total - p.appeals.pending)}${smallFlag(p.appeals.total - p.appeals.pending)}.`,
    ...Object.entries(p.appeals.groups)
      .sort((a, b) => b[1] - a[1])
      .map(([g, n]) => `- ${g.replace(/_/g, " ")}: ${int(n)} (${pct(n / Math.max(1, p.appeals.total - p.appeals.pending))} of decided)`),
    `Filed by: ${Object.entries(p.appeals.filedBy).map(([k, n]) => `${k} ${int(n)}`).join(", ") || "none"}.`,
    "",
    "Definitions:",
    ...[DEFINITIONS.completion, DEFINITIONS.outcome, DEFINITIONS.represented, DEFINITIONS.applicationRates, DEFINITIONS.appeals, DEFINITIONS.biaGrouping, DEFINITIONS.processingTime, DEFINITIONS.smallNumbers].map((d) => `- ${d}`),
    "",
    NOT_A_PREDICTION,
  ];
  return lines;
}

function valueText(column: string, v: number | null): string {
  if (v === null) return "n/a";
  if (/rate|share/.test(column)) return pct(v);
  return int(v);
}

function resultLines(r: StatResult): string[] {
  const denominatorColumn = r.measure === "applications" ? "applications" : r.measure === "appeals" ? "decided" : r.measure === "completions" ? "decisions" : "completions_timed";
  const row = (label: string, values: Record<string, number | null>) =>
    `- ${label}: ${r.columns.map((c) => `${c.replace(/_/g, " ")} ${valueText(c, values[c] ?? null)}`).join("; ")}${smallFlag(Number(values[denominatorColumn] ?? 0))}`;
  return [
    `Measure ${r.measure}, from ${r.table}. Filters: ${Object.entries(r.filters).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}.${r.defaultsApplied.length ? ` Defaults applied: ${r.defaultsApplied.join("; ")}.` : ""} Grouped by ${r.groupBy}.`,
    "",
    ...(r.rows.length ? r.rows.map((x) => row(`${x.key}${x.label ? ` (${x.label})` : ""}`, x.values)) : ["- no rows match these filters"]),
    r.truncated ? `(More groups than the limit; narrow the filters or raise limit.)` : "",
    row("Total over the filters", r.totals),
  ];
}

export function statResultLines(snapshot: SnapshotView, r: StatResult): string[] {
  const defs =
    r.measure === "completions"
      ? [DEFINITIONS.completion, DEFINITIONS.outcome, DEFINITIONS.represented, DEFINITIONS.custody]
      : r.measure === "applications"
        ? [DEFINITIONS.applications, DEFINITIONS.applicationRates, DEFINITIONS.represented]
        : r.measure === "appeals"
          ? [DEFINITIONS.appeals, DEFINITIONS.biaGrouping]
          : [DEFINITIONS.processingTime];
  const lines = [HEADER, snapshotLine(snapshot), "", ...resultLines(r), "", "Definitions:", ...[DEFINITIONS.fiscalYear, ...defs, DEFINITIONS.smallNumbers].map((d) => `- ${d}`), "", NOT_A_PREDICTION];
  return lines;
}
