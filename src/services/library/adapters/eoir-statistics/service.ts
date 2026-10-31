import "server-only";
import { withGlobalReadContext } from "@/db/client";
import {
  currentSnapshot,
  judgeProfile,
  latestAttempt,
  listCourts,
  queryStats,
  searchJudges,
  type AttemptView,
  type CourtSummary,
  type JudgeProfile,
  type JudgeSummary,
  type SnapshotView,
  type StatQuery,
  type StatResult,
} from "./queries";

// What the /library/eoir-statistics page and the skill runs' statistics
// tools use: the reads of ./queries.ts, each in a read-only global
// transaction (withGlobalReadContext). The statistics are the same for every
// firm and read-only to every role.

export type EoirStatsOverview = { snapshot: SnapshotView | null; latest: AttemptView | null; courts: CourtSummary[] };

export async function loadEoirStatsOverview(): Promise<EoirStatsOverview> {
  return withGlobalReadContext(async (tx) => {
    const snapshot = await currentSnapshot(tx);
    return { snapshot, latest: await latestAttempt(tx), courts: snapshot ? await listCourts(tx, snapshot) : [] };
  });
}

export async function searchEoirJudges(params: { query?: string | null; court?: string | null; limit?: number; offset?: number }): Promise<{ snapshot: SnapshotView | null; judges: JudgeSummary[]; total: number }> {
  return withGlobalReadContext(async (tx) => {
    const snapshot = await currentSnapshot(tx);
    if (!snapshot) return { snapshot, judges: [], total: 0 };
    return { snapshot, ...(await searchJudges(tx, snapshot, params)) };
  });
}

export async function getEoirJudgeProfile(params: { judgeCode: string; fyFrom?: number | null; fyTo?: number | null }): Promise<{ snapshot: SnapshotView | null; profile: JudgeProfile | null }> {
  return withGlobalReadContext(async (tx) => {
    const snapshot = await currentSnapshot(tx);
    if (!snapshot) return { snapshot, profile: null };
    return { snapshot, profile: await judgeProfile(tx, snapshot, params) };
  });
}

export async function queryEoirStats(query: StatQuery): Promise<{ snapshot: SnapshotView | null; result: StatResult | null }> {
  return withGlobalReadContext(async (tx) => {
    const snapshot = await currentSnapshot(tx);
    if (!snapshot) return { snapshot, result: null };
    return { snapshot, result: await queryStats(tx, snapshot, query) };
  });
}
