"use client";

import Link from "next/link";
import { useEffect, useId, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { SupportedSkillName } from "@/services/skill-runner/skills";
import type { SkillCatalogEntry } from "@/services/skill-runner/skills/catalog";
import { SKILL_CATEGORIES, type SkillKind } from "@/services/skill-runner/skills/types";
import { caseTypeLabel } from "@/lib/matters/case-types";
import { MAX_ATTORNEY_NOTE_CHARS } from "@/lib/skill-runs/snapshot";
import { retrySkillRunAction, triggerSkillRunAction } from "./skill-actions";
import { getDocumentDownloadUrlAction } from "../actions";
import { GenericReportView, hasSkillView, renderSkillView, type SkillViewActions } from "./views";
import { RetrievedSources } from "./views/RetrievedSources";
import { Badge, BulletList, Callout } from "./views/primitives";
import { LocalTime } from "./LocalTime";

/**
 * One skill run as the panel needs it, built server-side in page.tsx from a
 * skill_runs row: the jsonb columns the panel reads are already parsed
 * (escalation_flags, and the case note and Retry link from input_snapshot),
 * the requester's name is resolved, and outputMatchesSchema says whether
 * structured_output still parses against the skill's current schema (so the
 * schemas never ship to the browser). Only matching outputs go to a
 * dedicated view; the rest render through GenericReportView.
 */
export type SkillRunForPanel = {
  id: string;
  skillName: string;
  skillVersion: number;
  status: string;
  structuredOutput: unknown;
  verificationLog: unknown;
  escalationFlags: string[];
  errorMessage: string | null;
  requestedByLabel: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  attorneyNote: string | null;
  retryOfRunId: string | null;
  outputMatchesSchema: boolean;
};

/**
 * What the run form warns about before a run, computed server-side in
 * page.tsx. None of it blocks a run: each says what the run will do about it.
 */
export type PreRunChecks = {
  documentCount: number;
  /** Uploads whose malware scan has not finished (runs list them as not reviewed). */
  documentsPendingScan: number;
  /** Uploads that could not be scanned (runs list them as not reviewed). */
  documentsNotScanned: number;
  /** Uploads the scan flagged (runs exclude them). */
  documentsInfected: number;
  /** Whether the firm has an active (confirmed) practice profile version. */
  practiceProfileConfirmed: boolean;
  /** missingFirmIdentityFields for the firm's current identity; empty when complete. */
  firmIdentityMissing: string[];
};

const statusColor: Record<string, string> = {
  queued: "text-black/50 dark:text-white/50",
  running: "text-blue-600 dark:text-blue-400",
  completed: "text-green-700 dark:text-green-400",
  failed: "text-red-700 dark:text-red-400",
  needs_input: "text-amber-700 dark:text-amber-400",
};

const statusLabel: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  needs_input: "Needs input",
};

const kindLabel: Record<SkillKind, string> = {
  review: "Review",
  build: "Build",
  research: "Research",
};

const primaryButton =
  "rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black disabled:opacity-50";
const secondaryButton =
  "rounded-md border border-black/20 px-3 py-1.5 text-xs font-medium text-black/70 dark:border-white/20 dark:text-white/70 disabled:opacity-50";
const mutedText = "text-black/50 dark:text-white/50";
const linkClass = "underline";

// Fixed locale, so the server render and the browser agree on separators.
const formatCount = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${formatCount(n)} ${n === 1 ? one : many}`;

function appliesToCaseType(skill: SkillCatalogEntry, matterCaseType: string): boolean {
  return skill.applicableCaseTypes === null || (skill.applicableCaseTypes as string[]).includes(matterCaseType);
}

function isActive(run: SkillRunForPanel): boolean {
  return run.status === "queued" || run.status === "running";
}

function groupByCategory(skills: SkillCatalogEntry[]) {
  return SKILL_CATEGORIES.map((category) => ({
    ...category,
    skills: skills.filter((s) => s.category === category.id),
  })).filter((g) => g.skills.length > 0);
}

/** The run form's non-blocking warnings for `skill` on this matter, most specific first. */
function preRunWarnings(
  skill: SkillCatalogEntry,
  checks: PreRunChecks,
  matterCaseType: string,
  runs: SkillRunForPanel[]
): ReactNode[] {
  const warnings: ReactNode[] = [];
  if (!appliesToCaseType(skill, matterCaseType)) {
    const builtFor = (skill.applicableCaseTypes ?? []).map(caseTypeLabel).join(", ");
    warnings.push(
      `This skill is built for ${builtFor} matters, not ${caseTypeLabel(matterCaseType)}. It still runs on this matter.`
    );
  }
  const active = runs.filter((r) => r.skillName === skill.name && isActive(r)).length;
  if (active > 0) {
    warnings.push(`${plural(active, "run", "runs")} of this skill on this matter ${active === 1 ? "is" : "are"} already queued or running.`);
  }
  if (checks.documentCount === 0) {
    warnings.push(
      `This matter has no documents yet, so the run will have only the matter details${skill.needsNote ? " and your case note" : ""} to work from.`
    );
  }
  if (checks.documentsPendingScan > 0) {
    warnings.push(
      `${plural(checks.documentsPendingScan, "document is", "documents are")} still waiting for the malware scan. A run reads only documents that scanned clean, so these will be reported as not reviewed. Wait for the scan to include them.`
    );
  }
  if (checks.documentsNotScanned > 0) {
    warnings.push(
      `${plural(checks.documentsNotScanned, "document", "documents")} could not be scanned for malware and will be reported as not reviewed. Use Scan again in the documents list first.`
    );
  }
  if (checks.documentsInfected > 0) {
    warnings.push(
      `${plural(checks.documentsInfected, "document was", "documents were")} flagged as infected and will be left out of the run.`
    );
  }
  if (!checks.practiceProfileConfirmed) {
    warnings.push(
      <>
        No practice profile has been confirmed for this firm. The run will assume a standard posture throughout and
        flag the missing profile. Confirm one on the{" "}
        <Link href="/practice-profile" className={linkClass}>
          Practice Profile page
        </Link>
        .
      </>
    );
  }
  if (skill.kind === "build" && checks.firmIdentityMissing.length > 0) {
    warnings.push(
      <>
        The firm identity is incomplete (missing: {checks.firmIdentityMissing.join("; ")}). Drafts will carry bracketed
        placeholders such as [FIRM NAME] where those details belong, and the report will flag them. Complete it on the{" "}
        <Link href="/firm" className={linkClass}>
          Firm page
        </Link>
        .
      </>
    );
  }
  return warnings;
}

export function SkillRunPanel({
  matterId,
  matterCaseType,
  catalog,
  runs,
  canRun,
  preRunChecks,
}: {
  matterId: string;
  matterCaseType: string;
  catalog: SkillCatalogEntry[];
  /** Newest first. */
  runs: SkillRunForPanel[];
  /** False for read-only members: no skill picker, run form or Retry buttons (the actions refuse them too). */
  canRun: boolean;
  preRunChecks: PreRunChecks;
}) {
  const primarySkills = catalog.filter((s) => appliesToCaseType(s, matterCaseType));
  const otherSkills = catalog.filter((s) => !appliesToCaseType(s, matterCaseType));
  const matterTypeLabel = caseTypeLabel(matterCaseType);

  const [selectedName, setSelectedName] = useState<SupportedSkillName | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [runMessage, setRunMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [isRunPending, startRun] = useTransition();
  // Open from the start when nothing is built for this case type (a case
  // type created before the current list), so the picker is never empty.
  const [otherOpen, setOtherOpen] = useState(
    () => primarySkills.filter((s) => s.applicableCaseTypes !== null).length === 0
  );
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<{ runId: string; message: string } | null>(null);
  const [isRetryPending, startRetry] = useTransition();
  const router = useRouter();

  const idPrefix = useId();
  const pickerHeadingId = `${idPrefix}-picker-heading`;
  const formHeadingId = `${idPrefix}-form-heading`;

  const skillsByName = new Map(catalog.map((s) => [s.name as string, s]));
  const selected = selectedName ? (skillsByName.get(selectedName) ?? null) : null;

  // Skill runs execute in a background worker (see src/worker.ts), so this
  // polls for status transitions instead of getting them for free from a
  // blocking await. Stops itself once no run is queued/running.
  useEffect(() => {
    if (!runs.some(isActive)) return;
    const id = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(id);
  }, [runs, router]);

  // The picker and the run form take turns in the same place, so keyboard
  // focus moves to the heading of whichever one just appeared (after React
  // has committed it).
  function focusById(id: string) {
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  }

  function selectSkill(name: SupportedSkillName) {
    setRunMessage(null);
    setSelectedName(name);
    focusById(formHeadingId);
  }

  function backToPicker() {
    setRunMessage(null);
    setSelectedName(null);
    focusById(pickerHeadingId);
  }

  function handleRun(skill: SkillCatalogEntry) {
    setRunMessage(null);
    startRun(async () => {
      try {
        const result = await triggerSkillRunAction(matterId, skill.name, skill.needsNote ? notes[skill.name] : undefined);
        setRunMessage(
          result.ok
            ? { tone: "ok", text: `${skill.runTitle} is queued. It is at the top of the run list below, which updates while it works.` }
            : { tone: "error", text: `Could not start ${skill.runTitle}: ${result.error}` }
        );
      } catch (err) {
        setRunMessage({
          tone: "error",
          text: `Could not start ${skill.runTitle}: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        router.refresh();
      }
    });
  }

  // Queues a new run (a new row; this failed one stays in the list). The
  // refresh shows the new row even when queuing it failed, since a run that
  // could not be queued is recorded as failed.
  function handleRetry(run: SkillRunForPanel) {
    setRetryingId(run.id);
    setRetryError(null);
    startRetry(async () => {
      try {
        const result = await retrySkillRunAction(run.id);
        if (!result.ok) setRetryError({ runId: run.id, message: result.error });
      } catch (err) {
        setRetryError({ runId: run.id, message: err instanceof Error ? err.message : String(err) });
      } finally {
        setRetryingId(null);
        router.refresh();
      }
    });
  }

  function toggleExpanded(runId: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  // "Retry of" / "Retried as" links: open that run and move focus (and the
  // scroll position) to its row.
  function showRun(runId: string) {
    setExpandedIds((prev) => new Set(prev).add(runId));
    focusById(runToggleId(idPrefix, runId));
  }

  const actions: SkillViewActions = {
    downloadDocument: async (documentId) => {
      const url = await getDocumentDownloadUrlAction(documentId);
      window.open(url, "_blank", "noopener,noreferrer");
    },
  };

  const runsById = new Map(runs.map((r) => [r.id, r]));
  const retriesOf = new Map<string, SkillRunForPanel[]>();
  for (const run of runs) {
    if (!run.retryOfRunId) continue;
    retriesOf.set(run.retryOfRunId, [...(retriesOf.get(run.retryOfRunId) ?? []), run]);
  }

  // Render helpers rather than nested components, so React doesn't see a new
  // component type (and remount the list) on every render.
  function skillOption(skill: SkillCatalogEntry) {
    const lastRun = runs.find((r) => r.skillName === skill.name);
    return (
      <li key={skill.name}>
        <button
          type="button"
          onClick={() => selectSkill(skill.name)}
          className="flex h-full w-full flex-col gap-1 rounded-md border border-black/10 p-2 text-left hover:border-black/30 dark:border-white/10 dark:hover:border-white/30"
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{skill.label}</span>
            <Badge label={kindLabel[skill.kind]} tone="neutral" />
          </span>
          <span className="text-xs text-black/60 dark:text-white/60">{skill.description}</span>
          {lastRun && (
            <span className={`text-xs ${mutedText}`}>
              Last run: {statusLabel[lastRun.status] ?? lastRun.status}, <LocalTime value={lastRun.createdAt} />
            </span>
          )}
        </button>
      </li>
    );
  }

  function skillGroups(skills: SkillCatalogEntry[]) {
    return groupByCategory(skills).map((group) => (
      <div key={group.id} className="flex flex-col gap-2">
        <h4 className={`text-xs font-semibold uppercase tracking-wide ${mutedText}`}>{group.label}</h4>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">{group.skills.map(skillOption)}</ul>
      </div>
    ));
  }

  function picker() {
    return (
      <div className="flex flex-col gap-3">
        <div>
          <h3 id={pickerHeadingId} tabIndex={-1} className="text-sm font-medium outline-none">
            Choose a skill to run
          </h3>
          <p className={`text-xs ${mutedText}`}>
            Skills built for {matterTypeLabel} matters, and those for any matter, come first. Choosing one opens its
            run form; nothing runs until you press its run button.
          </p>
        </div>
        {primarySkills.length > 0 ? (
          skillGroups(primarySkills)
        ) : (
          <p className={`text-xs ${mutedText}`}>No skill is built for {matterTypeLabel} matters; see Other skills.</p>
        )}
        {otherSkills.length > 0 && (
          <details
            open={otherOpen}
            onToggle={(e) => setOtherOpen(e.currentTarget.open)}
            className="rounded-md border border-black/10 p-2 dark:border-white/10"
          >
            <summary className="cursor-pointer text-sm font-medium">
              Other skills ({otherSkills.length}), not built for {matterTypeLabel} matters
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              <p className={`text-xs ${mutedText}`}>These still run on this matter if you need them.</p>
              {skillGroups(otherSkills)}
            </div>
          </details>
        )}
      </div>
    );
  }

  function runForm(skill: SkillCatalogEntry) {
    const note = notes[skill.name] ?? "";
    const noteTooLong = note.trim().length > MAX_ATTORNEY_NOTE_CHARS;
    const warnings = preRunWarnings(skill, preRunChecks, matterCaseType, runs);
    const similar = skill.similarSkills.map((name) => skillsByName.get(name)).filter((s): s is SkillCatalogEntry => Boolean(s));
    const categoryLabel = SKILL_CATEGORIES.find((c) => c.id === skill.category)?.label ?? skill.category;
    const builtFor = skill.applicableCaseTypes ? skill.applicableCaseTypes.map(caseTypeLabel).join(", ") : "any matter";
    const ids = {
      heading: formHeadingId,
      note: `${idPrefix}-note`,
      noteHelp: `${idPrefix}-note-help`,
      noteCount: `${idPrefix}-note-count`,
    };

    return (
      <form
        aria-labelledby={ids.heading}
        className="flex flex-col gap-3 rounded-md border border-black/15 p-3 dark:border-white/15"
        onSubmit={(e) => {
          e.preventDefault();
          if (!noteTooLong) handleRun(skill);
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <h3 id={ids.heading} tabIndex={-1} className="font-medium outline-none">
              {skill.label}
            </h3>
            <p className={`text-xs ${mutedText}`}>
              {categoryLabel} | {kindLabel[skill.kind]} | Built for: {builtFor}
            </p>
          </div>
          <button type="button" className={secondaryButton} onClick={backToPicker}>
            Choose another skill
          </button>
        </div>

        <p className="text-sm">{skill.description}</p>

        {similar.length > 0 && (
          <div className="rounded-md bg-black/5 p-2 text-xs dark:bg-white/10">
            <p className="mb-1 font-medium">Similar skill{similar.length === 1 ? "" : "s"}, to compare before you run:</p>
            <ul className="flex flex-col gap-2">
              {similar.map((other) => (
                <li key={other.name}>
                  <span className="font-medium">{other.label}</span>: {other.description}{" "}
                  <button type="button" className={linkClass} onClick={() => selectSkill(other.name)}>
                    Switch to {other.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {warnings.length > 0 && (
          <Callout tone="amber" title="Before you run">
            <BulletList items={warnings} className="text-xs" />
            <p className="mt-1 text-xs">None of these stops the run.</p>
          </Callout>
        )}

        {skill.needsNote ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.note} className="text-sm font-medium">
              Case note (optional)
            </label>
            <div id={ids.noteHelp} className="text-xs text-black/70 dark:text-white/70">
              <p>
                For facts the uploaded documents will not show. The run reads the note together with the documents
                and the matter details.
              </p>
              {skill.noteHelp && (
                <p className="mt-1">
                  <span className="font-medium">What to include: </span>
                  {skill.noteHelp}
                </p>
              )}
            </div>
            <textarea
              id={ids.note}
              value={note}
              onChange={(e) => setNotes((prev) => ({ ...prev, [skill.name]: e.target.value }))}
              aria-describedby={`${ids.noteHelp} ${ids.noteCount}`}
              aria-invalid={noteTooLong}
              rows={6}
              className="resize-y rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20"
            />
            <p id={ids.noteCount} className={`text-xs ${noteTooLong ? "text-red-700 dark:text-red-400" : mutedText}`}>
              {formatCount(note.trim().length)} of {formatCount(MAX_ATTORNEY_NOTE_CHARS)} characters
              {noteTooLong ? ": shorten the note to run this skill." : ""}
            </p>
          </div>
        ) : (
          <p className={`text-xs ${mutedText}`}>
            This skill takes no case note: it works from the matter&apos;s documents and details.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={isRunPending || noteTooLong} className={primaryButton}>
            {isRunPending ? "Queuing..." : skill.label}
          </button>
          <p
            aria-live="polite"
            className={`text-xs ${runMessage?.tone === "error" ? "text-red-700 dark:text-red-400" : "text-green-700 dark:text-green-400"}`}
          >
            {runMessage?.text}
          </p>
        </div>
      </form>
    );
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-black/10 p-4 dark:border-white/10">
      <h2 className="font-medium">Skill runs</h2>

      {!canRun && (
        <p className={`text-xs ${mutedText}`}>
          Your role in this firm is read-only: you can open reports, but not start or retry runs.
        </p>
      )}

      {canRun && (selected ? runForm(selected) : picker())}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Runs on this matter</h3>
        <ul className="flex flex-col gap-2">
          {runs.map((run) => {
            const original = run.retryOfRunId ? runsById.get(run.retryOfRunId) : undefined;
            return (
              <RunRow
                key={run.id}
                toggleId={runToggleId(idPrefix, run.id)}
                run={run}
                skill={skillsByName.get(run.skillName) ?? null}
                expanded={expandedIds.has(run.id)}
                onToggle={() => toggleExpanded(run.id)}
                original={original ?? null}
                retries={retriesOf.get(run.id) ?? []}
                onShowRun={showRun}
                canRun={canRun}
                retrying={isRetryPending && retryingId === run.id}
                retryDisabled={isRetryPending}
                retryError={retryError?.runId === run.id ? retryError.message : null}
                onRetry={() => handleRetry(run)}
                actions={actions}
              />
            );
          })}
          {runs.length === 0 && <li className={`text-sm ${mutedText}`}>No skill runs yet.</li>}
        </ul>
      </div>
    </section>
  );
}

/** The id of a run row's expand button, so the "Retry of" / "Retried as" links can focus it. */
function runToggleId(idPrefix: string, runId: string): string {
  return `${idPrefix}-run-${runId}`;
}

function RunRow({
  toggleId,
  run,
  skill,
  expanded,
  onToggle,
  original,
  retries,
  onShowRun,
  canRun,
  retrying,
  retryDisabled,
  retryError,
  onRetry,
  actions,
}: {
  toggleId: string;
  run: SkillRunForPanel;
  /** The run's skill in the current catalog; null for a skill no longer registered. */
  skill: SkillCatalogEntry | null;
  expanded: boolean;
  onToggle: () => void;
  /** The failed run this one retries, when it is still in the list. */
  original: SkillRunForPanel | null;
  /** Runs that retry this one, newest first. */
  retries: SkillRunForPanel[];
  onShowRun: (runId: string) => void;
  canRun: boolean;
  retrying: boolean;
  retryDisabled: boolean;
  retryError: string | null;
  onRetry: () => void;
  actions: SkillViewActions;
}) {
  const bodyId = useId();
  const title = skill?.runTitle ?? run.skillName;
  const flagCount = run.escalationFlags.length;
  const finishedLabel = run.status === "failed" ? "Failed" : "Completed";

  return (
    <li className="rounded-md border border-black/10 dark:border-white/10">
      <button
        id={toggleId}
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        className="flex w-full flex-col gap-1 px-3 py-2 text-left text-sm sm:flex-row sm:items-center sm:justify-between"
        onClick={onToggle}
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{title}</span>
          <span className={`text-xs ${mutedText}`}>v{run.skillVersion}</span>
          {run.retryOfRunId && <Badge label="Retry" tone="neutral" />}
          {flagCount > 0 && <Badge label={plural(flagCount, "escalation flag", "escalation flags")} tone="red" />}
        </span>
        <span className="flex flex-wrap items-center gap-2 text-xs">
          <span className={mutedText}>
            <LocalTime value={run.createdAt} /> by {run.requestedByLabel}
          </span>
          <span className={`font-medium ${statusColor[run.status] ?? ""}`}>{statusLabel[run.status] ?? run.status}</span>
        </span>
      </button>

      {expanded && (
        <div id={bodyId} className="flex flex-col gap-3 border-t border-black/10 p-3 dark:border-white/10">
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            <div>
              <dt className={`inline ${mutedText}`}>Requested: </dt>
              <dd className="inline">
                <LocalTime value={run.createdAt} /> by {run.requestedByLabel}
              </dd>
            </div>
            {run.startedAt && (
              <div>
                <dt className={`inline ${mutedText}`}>Started: </dt>
                <dd className="inline">
                  <LocalTime value={run.startedAt} />
                </dd>
              </div>
            )}
            {run.completedAt && (
              <div>
                <dt className={`inline ${mutedText}`}>{finishedLabel}: </dt>
                <dd className="inline">
                  <LocalTime value={run.completedAt} />
                </dd>
              </div>
            )}
            <div>
              <dt className={`inline ${mutedText}`}>Skill version: </dt>
              <dd className="inline">v{run.skillVersion}</dd>
            </div>
            {run.retryOfRunId && (
              <div className="sm:col-span-2">
                <dt className={`inline ${mutedText}`}>Retry of: </dt>
                <dd className="inline">
                  {original ? (
                    <button type="button" className={linkClass} onClick={() => onShowRun(original.id)}>
                      the failed run requested <LocalTime value={original.createdAt} />
                    </button>
                  ) : (
                    "a failed run no longer in this list"
                  )}
                </dd>
              </div>
            )}
            {retries.length > 0 && (
              <div className="sm:col-span-2">
                <dt className={`inline ${mutedText}`}>Retried as: </dt>
                <dd className="inline">
                  {retries.map((retry, i) => (
                    <span key={retry.id}>
                      {i > 0 ? "; " : ""}
                      <button type="button" className={linkClass} onClick={() => onShowRun(retry.id)}>
                        the run requested <LocalTime value={retry.createdAt} />
                      </button>{" "}
                      ({(statusLabel[retry.status] ?? retry.status).toLowerCase()})
                    </span>
                  ))}
                </dd>
              </div>
            )}
          </dl>

          {run.attorneyNote ? (
            <details className="rounded-md border border-black/10 p-2 text-xs dark:border-white/10">
              <summary className="cursor-pointer font-medium">Case note used</summary>
              <p className="mt-2 whitespace-pre-wrap break-words">{run.attorneyNote}</p>
            </details>
          ) : (
            skill?.needsNote && <p className={`text-xs ${mutedText}`}>No case note was given for this run.</p>
          )}

          {run.status === "failed" && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-red-700 dark:text-red-400">{run.errorMessage}</p>
              {canRun && (
                <div>
                  <button
                    type="button"
                    disabled={retryDisabled}
                    onClick={onRetry}
                    title="Runs this skill again as a new run, with the same case note, on the matter's current documents and practice profile. This failed run stays in the list."
                    className={secondaryButton}
                  >
                    {retrying ? "Retrying..." : "Retry this run"}
                  </button>
                </div>
              )}
              {retryError && <p className="text-xs text-red-700 dark:text-red-400">Could not retry: {retryError}</p>}
            </div>
          )}

          {run.status === "completed" && Boolean(run.structuredOutput) && (
            <div>
              <p className={`mb-3 text-center text-xs font-semibold uppercase tracking-wide ${mutedText}`}>
                Privileged & Confidential - Attorney Work Product
              </p>
              <div className="mb-4">
                <EscalationFlags flags={run.escalationFlags} />
              </div>
              <RunOutput run={run} title={title} actions={actions} />
            </div>
          )}

          {(run.status === "completed" || run.status === "failed") && (
            <RetrievedSources
              verificationLog={run.verificationLog}
              output={run.status === "completed" ? run.structuredOutput : null}
            />
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The run's skill_runs.escalation_flags, ahead of the report: the items the
 * skill routes to the supervising attorney (each module's
 * extractEscalationFlags). A dedicated view may list them again in place.
 */
function EscalationFlags({ flags }: { flags: string[] }) {
  if (flags.length === 0) {
    return (
      <p className="rounded-md border border-black/10 p-2 text-xs text-black/60 dark:border-white/10 dark:text-white/60">
        This run recorded no escalation flags. Review the full report below before relying on it.
      </p>
    );
  }
  return (
    <Callout tone="red" title={`Escalation flags (${flags.length})`}>
      <p className="mb-1 text-xs">
        Items this skill routes to the supervising attorney. Review each one before relying on the report.
      </p>
      <BulletList items={flags} />
    </Callout>
  );
}

function RunOutput({ run, title, actions }: { run: SkillRunForPanel; title: string; actions: SkillViewActions }) {
  const dedicated = run.outputMatchesSchema ? renderSkillView(run.skillName, run.structuredOutput, actions) : null;
  if (dedicated) return dedicated;
  return (
    <>
      {hasSkillView(run.skillName) && (
        <p className={`mb-3 text-xs ${mutedText}`}>
          This run was produced by an earlier version of the {title} report format, so it is shown in the generic
          layout.
        </p>
      )}
      <GenericReportView output={run.structuredOutput} />
    </>
  );
}
