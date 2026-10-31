import "server-only";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { collectSource, ListingMarkupError } from "./collectors";
import { diffSourceItems } from "./diff";
import { OfficialFetchError } from "./http";
import { SOURCES, type SourceDefinition } from "./sources";
import {
  closeInterruptedRuns,
  countSummaryBacklog,
  finishRun,
  loadKnownItems,
  loadSourceState,
  loadSummaryQueue,
  recordSourceCheck,
  saveSummaryOutcome,
  startRun,
  type RunTotals,
  type RunTrigger,
} from "./store";
import { loadSummarizerContext, summarizeItem } from "./summarize";

// One check of every official source (the daily schedule, or an
// owner/admin's "Check now"), the platform version of the
// eoir-weekly-update skill's Steps 2-5:
//
// 1. Each source is collected, diffed against what is stored, and recorded
//    with its own check row, in its own transaction. A source that fails
//    (fetch refused or failed, page layout not recognized, anything else) is
//    recorded as failed and the run moves on; nothing is guessed for it.
// 2. New items are summarized, newest first, within this run's budgets
//    (summaries, document reads, wall clock). Each item succeeds or fails on
//    its own; what the budget does not reach stays pending for the next run.
//
// The queue runs one check at a time (monitoring-jobs.ts), so a run that is
// still "running" when this starts was cut off, and is closed first.

const MAX_SUMMARIES_PER_RUN = 40;
const MAX_DOCUMENT_READS_PER_RUN = 25;
// Below the pg-boss job expiry (LEGAL_UPDATE_CHECK_EXPIRE_SECONDS) so the run records its own outcome.
const SUMMARY_PHASE_DEADLINE_MS = 90 * 60 * 1000;

function errorText(err: unknown): string {
  if (err instanceof OfficialFetchError || err instanceof ListingMarkupError) return err.message;
  if (err instanceof Error) return `Unexpected error: ${err.message}`.slice(0, 500);
  return "Unexpected error.";
}

async function checkSource(runId: string, source: SourceDefinition, now: Date, totals: RunTotals): Promise<void> {
  const startedAt = new Date();
  if (source.notCheckedReason) {
    await recordSourceCheck({ runId, source: source.key, startedAt, status: "not_checked", notes: [source.notCheckedReason] });
    totals.sourcesNotChecked++;
    return;
  }
  try {
    const state = await loadSourceState(source.key);
    const collected = await collectSource(source, { now, lastSuccessAt: state.lastSuccessAt });
    const diff = diffSourceItems({
      current: collected.items,
      known: await loadKnownItems(source.key),
      baselineEstablished: state.baselineEstablished,
    });
    const counts = await recordSourceCheck({
      runId,
      source: source.key,
      startedAt,
      status: state.baselineEstablished ? "ok" : "baseline",
      collected,
      diff,
      notes: state.baselineEstablished
        ? []
        : ["First successful check: everything listed was recorded as already published (the baseline), not as new."],
    });
    totals.sourcesChecked++;
    totals.baselined += counts.baselined;
    totals.newItems += counts.newItems;
    totals.revisedItems += counts.revisedItems;
    totals.duplicates += counts.duplicates;
    console.log(
      `[legal-updates] ${source.key}: ${collected.items.length} listed, ${counts.newItems} new, ${counts.revisedItems} revised, ${counts.baselined} baseline`
    );
  } catch (err) {
    totals.sourcesFailed++;
    console.warn(`[legal-updates] ${source.key} failed: ${describeErrorForLog(err)}`);
    try {
      await recordSourceCheck({ runId, source: source.key, startedAt, status: "failed", errorMessage: errorText(err) });
    } catch (recordErr) {
      console.error(`[legal-updates] could not record the failed check of ${source.key}: ${describeErrorForLog(recordErr)}`);
    }
  }
}

async function summarizePending(totals: RunTotals): Promise<void> {
  const queue = await loadSummaryQueue(MAX_SUMMARIES_PER_RUN);
  if (queue.length === 0) return;
  const ctx = await loadSummarizerContext();
  const budget = { documentReads: MAX_DOCUMENT_READS_PER_RUN };
  const deadline = Date.now() + SUMMARY_PHASE_DEADLINE_MS;
  for (const item of queue) {
    if (Date.now() > deadline) break;
    try {
      const outcome = await summarizeItem(ctx, item, budget);
      if (!outcome) continue; // document budget spent: stays pending
      await saveSummaryOutcome(item.id, outcome);
      if (outcome.status === "published") totals.summarized++;
      else if (outcome.status === "screened") totals.screened++;
      else totals.summaryFailed++;
    } catch (err) {
      totals.summaryFailed++;
      console.error(`[legal-updates] summary of ${item.id} failed: ${describeErrorForLog(err)}`);
      await saveSummaryOutcome(item.id, { status: "summary_failed", statusReason: "The summary step failed unexpectedly; it is retried on the next run." }).catch(
        (saveErr) => console.error(`[legal-updates] could not record the failed summary of ${item.id}: ${describeErrorForLog(saveErr)}`)
      );
    }
  }
}

export async function runLegalUpdateCheck(params: { trigger: RunTrigger; pgBossJobId?: string | null; now?: Date }): Promise<RunTotals> {
  const interrupted = await closeInterruptedRuns();
  if (interrupted) console.warn(`[legal-updates] closed ${interrupted} interrupted run(s)`);
  const runId = await startRun(params.trigger, params.pgBossJobId ?? null);
  const now = params.now ?? new Date();
  const totals: RunTotals = {
    sourcesChecked: 0,
    sourcesFailed: 0,
    sourcesNotChecked: 0,
    baselined: 0,
    newItems: 0,
    revisedItems: 0,
    duplicates: 0,
    summarized: 0,
    screened: 0,
    summaryFailed: 0,
    leftPending: 0,
  };
  try {
    for (const source of SOURCES) await checkSource(runId, source, now, totals);
    try {
      await summarizePending(totals);
    } catch (err) {
      // Loading the skill text failed, for example: the items stay pending.
      console.error(`[legal-updates] summary phase failed: ${describeErrorForLog(err)}`);
      totals.leftPending = await countSummaryBacklog();
      await finishRun(runId, "failed", totals, `Sources were checked, but summaries could not run: ${errorText(err)}`);
      return totals;
    }
    totals.leftPending = await countSummaryBacklog();
    await finishRun(runId, "completed", totals);
    return totals;
  } catch (err) {
    await finishRun(runId, "failed", totals, errorText(err)).catch(() => {});
    throw err;
  }
}
