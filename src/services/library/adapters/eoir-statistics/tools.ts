import "server-only";
import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { toJsonSchemaObject } from "@/services/skill-runner/json-schema";
// Types only: tools.ts imports this module for its registry.
import type { SkillTool, ToolExecutionContext } from "@/services/skill-runner/tools";
import { chargeRequestBytes } from "@/services/skill-runner/tools/shared/request-bytes";
import type { VerificationLogEntry } from "@/services/skill-runner/verification-log";
import { judgeProfileLines, judgeSearchLines, snapshotStale, statResultLines } from "./format";
import { EOIR_STATS_SOURCE_CODE } from "./model";
import { STAT_GROUPS, STAT_MEASURES, StatQueryError, type SnapshotView } from "./queries";
import { getEoirJudgeProfile, queryEoirStats, searchEoirJudges } from "./service";

// The EOIR statistics tools: search_eoir_judges, eoir_judge_profile and
// query_eoir_stats read the app's own aggregate of EOIR's public case data
// release (./store.ts, migration 0008). Read-only, global data: the run's
// tenant and matter are never involved and nothing about the case leaves
// the app. Every result states the snapshot it comes from, the filters and
// denominators behind each figure, the definitions it follows, and that
// rates describe historical outcomes and do not predict an individual case.
// Every result is written to the run's verification log (source "library",
// the release's official URL), as the library tools' results are.

const fy = z.number().int().min(1950).max(2100);

export const eoirSearchJudgesInputSchema = z.object({
  name: z.string().trim().max(100).optional().describe('Part of the judge\'s name as EOIR records it ("Smith", "Garcia M"), or EOIR\'s judge code.'),
  court: z.string().trim().max(5).optional().describe('EOIR\'s court (base city) code, e.g. "HOU" for Houston, "SFR" for San Francisco.'),
  offset: z.number().int().min(0).max(1000).optional(),
});

export const eoirJudgeProfileInputSchema = z.object({
  judge_code: z.string().trim().min(1).max(5).describe("EOIR's judge code, from search_eoir_judges."),
  fy_from: fy.optional().describe("First fiscal year (October to September). Default: the judge's last five fiscal years with completions."),
  fy_to: fy.optional().describe("Last fiscal year."),
});

export const eoirQueryStatsInputSchema = z.object({
  measure: z.enum(STAT_MEASURES).describe(
    "completions: completed proceedings and their outcomes (decision codes, in absentia). applications: applications for relief and the judge's decisions on them (default ASYL). appeals: appeals to the Board from completed proceedings and the Board's decisions (default CASE APPEAL). processing: days from the proceeding's receipt by the court to its completion."
  ),
  judge: z.string().trim().max(5).optional().describe("EOIR judge code."),
  court: z.string().trim().max(5).optional().describe("EOIR court (base city) code."),
  nationality: z.string().trim().max(3).optional().describe('EOIR nationality code (e.g. "GT" Guatemala, "HO" Honduras, "ES" El Salvador, "MX" Mexico). Completions by nationality have no judge; applications by nationality cover ASYL, ASYW and WCAT, without custody or representation.'),
  case_type: z.string().trim().max(3).optional().describe('EOIR case type, e.g. "RMV" removal, "AOC" asylum only, "WHO" withholding only.'),
  custody: z.enum(["D", "R", "N"]).optional().describe("D detained, R released, N never detained."),
  represented: z.boolean().optional().describe("true: the respondent had a representative at the immigration court; false: no representative on record."),
  application: z.string().trim().max(4).optional().describe('Application code for measure applications: ASYL asylum, ASYW withholding, WCAT CAT, 42B non-LPR cancellation, 42A LPR cancellation, 245 adjustment, VD voluntary departure, 212h, 212i waivers, and others EOIR lists.'),
  appeal_type: z.string().trim().max(30).optional().describe('Appeal type for measure appeals, e.g. "Case Appeal" (default), "Bond Appeal", "Appeal of IJ MTR", "Interlocutory Appeal".'),
  fy_from: fy.optional().describe("First fiscal year of completion."),
  fy_to: fy.optional().describe("Last fiscal year of completion."),
  group_by: z.enum(STAT_GROUPS).optional().describe("Break the counts down by this (default fy). outcome: the judge's decision codes; decision: application or Board decision codes."),
  limit: z.number().int().min(1).max(100).optional().describe("Most groups to return (default 40)."),
});

function logEntry(snapshot: SnapshotView, title: string, query: unknown, content: string): VerificationLogEntry {
  return {
    source: "library",
    url: snapshot.officialUrl,
    fetchedAt: new Date().toISOString(),
    status: "ok",
    title,
    query: JSON.stringify(query),
    contentHash: crypto.createHash("sha256").update(content).digest("hex").slice(0, 16),
    libraryAction: "read",
    librarySource: "EOIR case data release (FOIA library)",
    librarySourceCode: EOIR_STATS_SOURCE_CODE,
    sourceRefreshedAt: snapshot.loadedAt?.toISOString() ?? null,
    sourceStale: snapshotStale(snapshot),
    citation: null,
    precedentialStatus: "not_applicable",
  };
}

export const EOIR_NO_SNAPSHOT =
  "The app has not loaded EOIR's case data release yet (the statistics job runs daily in the worker), so there are no EOIR statistics to report. Say so; do not estimate figures.";

function invalid(error: z.ZodError) {
  return { content: `Invalid input: ${error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, isError: true };
}

function finish(ctx: ToolExecutionContext, snapshot: SnapshotView, title: string, query: unknown, lines: string[]) {
  const content = lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n").trim();
  if (!chargeRequestBytes(ctx, content)) {
    return { content: "The statistics do not fit: the conversation is too close to the API's request size limit. Ask for less (a narrower period, fewer groups) or finish with what you have.", isError: true };
  }
  ctx.verificationLog.push(logEntry(snapshot, title, query, content));
  return { content };
}

async function executeSearch(input: unknown, ctx: ToolExecutionContext) {
  const parsed = eoirSearchJudgesInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const q = parsed.data;
  if (!q.name && !q.court) return { content: "Give a name (or judge code), a court code, or both.", isError: true };
  let found;
  try {
    found = await searchEoirJudges({ query: q.name ?? null, court: q.court ?? null, limit: 15, offset: q.offset ?? 0 });
  } catch (err) {
    return { content: `The EOIR statistics could not be read (${err instanceof Error ? err.message : String(err)}).`, isError: true };
  }
  if (!found.snapshot) return { content: EOIR_NO_SNAPSHOT };
  const offset = q.offset ?? 0;
  return finish(ctx, found.snapshot, `EOIR statistics: judges matching ${q.name ?? ""} ${q.court ?? ""}`.trim(), q, judgeSearchLines(found.snapshot, { name: q.name, court: q.court }, found, offset));
}

async function executeProfile(input: unknown, ctx: ToolExecutionContext) {
  const parsed = eoirJudgeProfileInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const q = parsed.data;
  let read;
  try {
    read = await getEoirJudgeProfile({ judgeCode: q.judge_code, fyFrom: q.fy_from ?? null, fyTo: q.fy_to ?? null });
  } catch (err) {
    return { content: `The EOIR statistics could not be read (${err instanceof Error ? err.message : String(err)}).`, isError: true };
  }
  if (!read.snapshot) return { content: EOIR_NO_SNAPSHOT };
  const p = read.profile;
  if (!p) return { content: `No judge has the code ${q.judge_code.toUpperCase()} in this snapshot. Find the code with search_eoir_judges.`, isError: true };
  return finish(ctx, read.snapshot, `EOIR statistics: profile of judge ${p.judge.code}`, q, judgeProfileLines(read.snapshot, p));
}

async function executeQuery(input: unknown, ctx: ToolExecutionContext) {
  const parsed = eoirQueryStatsInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const q = parsed.data;
  let read;
  try {
    read = await queryEoirStats({
      measure: q.measure,
      judge: q.judge ?? null,
      court: q.court ?? null,
      nationality: q.nationality ?? null,
      caseType: q.case_type ?? null,
      custody: q.custody ?? null,
      represented: q.represented ?? null,
      application: q.application ?? null,
      appealType: q.appeal_type ?? null,
      fyFrom: q.fy_from ?? null,
      fyTo: q.fy_to ?? null,
      groupBy: q.group_by,
      limit: q.limit,
    });
  } catch (err) {
    if (err instanceof StatQueryError) return { content: err.message, isError: true };
    return { content: `The EOIR statistics could not be read (${err instanceof Error ? err.message : String(err)}).`, isError: true };
  }
  if (!read.snapshot) return { content: EOIR_NO_SNAPSHOT };
  const r = read.result!;
  return finish(ctx, read.snapshot, `EOIR statistics: ${r.measure} by ${r.groupBy}`, q, statResultLines(read.snapshot, r));
}

export const EOIR_STATS_SCOPE =
  "The app computes these from EOIR's public case data release (EOIR's FOIA library), loaded monthly as aggregate counts: no record of any person or case is kept, and nothing you send leaves the app. Never put a client's name, A-number or other case detail in a call.";

export const searchEoirJudgesTool: SkillTool = {
  definition: {
    name: "search_eoir_judges",
    description:
      "Find immigration judges in the app's EOIR statistics by name (as EOIR records it) or EOIR judge code, and/or by court code: each with EOIR's judge code, the courts and fiscal years of their completed proceedings and their number of completions. " +
      EOIR_STATS_SCOPE +
      " Use the judge_code with eoir_judge_profile or query_eoir_stats.",
    input_schema: toJsonSchemaObject(eoirSearchJudgesInputSchema) as Anthropic.Tool.InputSchema,
  },
  execute: executeSearch,
};

export const eoirJudgeProfileTool: SkillTool = {
  definition: {
    name: "eoir_judge_profile",
    description:
      "One immigration judge's historical record in the app's EOIR statistics, for a period of fiscal years (default: the judge's last five): completions by year, outcomes by EOIR decision code, in absentia, representation and custody mix, asylum decisions compared with the judge's court and all courts, asylum by representation, custody and nationality, other relief (cancellation, adjustment, voluntary departure, waivers), processing times, and Board appeal outcomes. " +
      "Every figure comes with its denominator and the snapshot. " +
      EOIR_STATS_SCOPE +
      " Rates describe past outcomes and do not predict any individual case: say so wherever you use them.",
    input_schema: toJsonSchemaObject(eoirJudgeProfileInputSchema) as Anthropic.Tool.InputSchema,
  },
  execute: executeProfile,
};

export const queryEoirStatsTool: SkillTool = {
  definition: {
    name: "query_eoir_stats",
    description:
      "Query the app's EOIR statistics: completions and outcomes, applications for relief and their grant and denial rates, Board appeal outcomes, or processing times, filtered by judge, court, nationality, case type, custody, representation, application, appeal type and fiscal years, grouped by one dimension. " +
      "Returns the counts, rates with their denominators, the filters applied and the snapshot; a combination the statistics do not hold (a judge by nationality for completions, for one) is refused with what to ask instead. " +
      EOIR_STATS_SCOPE +
      " Rates describe past outcomes and do not predict any individual case: say so wherever you use them.",
    input_schema: toJsonSchemaObject(eoirQueryStatsInputSchema) as Anthropic.Tool.InputSchema,
  },
  execute: executeQuery,
};
