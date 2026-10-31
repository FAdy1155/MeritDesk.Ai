// Readers for what a skill_runs row stores as jsonb: the parts of
// input_snapshot the matter page shows (the case note, the Retry link) and
// escalation_flags. The columns are jsonb, so every reader checks the shape
// instead of trusting a cast. Client-safe: no server imports.

/** Longest case note a run accepts; triggerSkillRunAction refuses anything longer, and the run form counts against it. */
export const MAX_ATTORNEY_NOTE_CHARS = 20_000;

function snapshotField(inputSnapshot: unknown, key: string): unknown {
  return inputSnapshot && typeof inputSnapshot === "object" ? (inputSnapshot as Record<string, unknown>)[key] : undefined;
}

/** The case note the run was queued with (input_snapshot.attorneyNote); null when there was none. */
export function readAttorneyNote(inputSnapshot: unknown): string | null {
  const note = snapshotField(inputSnapshot, "attorneyNote");
  return typeof note === "string" && note.trim() ? note : null;
}

/** The failed run this one retries (input_snapshot.retryOfRunId, set by retrySkillRun), if any. */
export function readRetryOfRunId(inputSnapshot: unknown): string | null {
  const id = snapshotField(inputSnapshot, "retryOfRunId");
  return typeof id === "string" ? id : null;
}

/** skill_runs.escalation_flags (what the skill's extractEscalationFlags returned), non-empty strings only. */
export function readEscalationFlags(escalationFlags: unknown): string[] {
  if (!Array.isArray(escalationFlags)) return [];
  return escalationFlags.filter((flag): flag is string => typeof flag === "string" && flag.trim().length > 0);
}
