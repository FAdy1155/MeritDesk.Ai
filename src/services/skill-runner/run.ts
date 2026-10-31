import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { withTenantContext, type TenantTransactionRunner } from "@/db/client";
import { skillDefinitions, skillRuns, matters, documents, practiceProfileVersions } from "@/db/schema";
import { AUDIT_ACTIONS, SYSTEM_ACTORS, recordAuditEvent } from "@/lib/audit/service";
import { lockedReasonText, readEntitlement, type Entitlement } from "@/lib/billing/entitlement";
import { failUnfinishedSkillRun } from "@/lib/skill-runs/service";
import { describeErrorForLog, safeErrorMessage } from "@/lib/errors/safe-error";
import type { MembershipRole } from "@/lib/roles";
import { readRequesterRole } from "./tools/shared/signer";
import { loadFirmIdentitySnapshot } from "@/lib/firm-identity/service";
import type { FirmIdentitySnapshot } from "@/lib/firm-identity/schema";
import { loadRecentLegalUpdatesForSkill } from "@/services/monitoring/skill-runs";
import {
  readRecentLegalUpdatesSnapshot,
  type RecentLegalUpdatesSnapshot,
} from "@/services/monitoring/prompt-section";
import { getSkillModule, isSupportedSkillName, type AnySkillModule, type SupportedSkillName } from "./skills";
import { computeSkillContentHash, loadBundledReferences, type ReferenceFile } from "./skill-content";
import { toJsonSchemaObject } from "./json-schema";
import { buildRuntimeNotes, buildSystemPrompt, buildUserContext } from "./prompt";
import {
  getSkillTools,
  cleanupGeneratedDocuments,
  IMAGE_RETURNING_TOOL_KEYS,
  type ToolExecutionContext,
} from "./tools";
import {
  buildServerToolDefinitions,
  hasPendingServerToolUse,
  normalizeServerTools,
  sanitizeFallbackContent,
  serverToolUsage,
  ServerToolSourceRecorder,
} from "./server-tools";
import {
  DEFAULT_MAX_NATIVE_BASE64_BYTES,
  prepareDocumentInput,
  type DocumentInventoryEntry,
  type PreparedDocumentInput,
} from "./document-input";
import type { VerificationLogEntry } from "./verification-log";
import { getBoss } from "@/services/queue/boss";
import {
  QUEUED_RUNS_PER_TENANT_MAX,
  SKILL_RUN_JOB_EXPIRE_SECONDS,
  SKILL_RUN_JOB_HEARTBEAT_SECONDS,
  SKILL_RUN_QUEUE,
  type SkillRunJobData,
} from "@/services/queue/skill-run-job";

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type BetaToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;
type BetaToolUnion = Anthropic.Beta.BetaToolUnion;
type TurnRequest = Anthropic.Beta.Messages.MessageCreateParamsStreaming;

const anthropic = new Anthropic();

// --- Model settings (from the claude-api skill) -----------------------------

// Claude Opus 5.5, the skill's current default model.
export const MODEL = "claude-opus-5-5";
// Thinking is always on for this model (adaptive); effort is the only
// control, and its API default is "medium". Legal review and drafting are
// intelligence-sensitive work, so this pins "high".
const EFFORT = "high" as const;
// Server-side refusal fallback (beta): when a safety classifier declines a
// request, the API reruns it inside the same call on the model Anthropic
// recommends for that refusal category (fallbacks: "default"). Shipped on by
// default per the claude-api skill; the fallback model runs without this
// model's thinking blocks. To opt out, drop `betas` and `fallbacks` from
// turnRequest below.
const REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01";

// Per-turn output cap, thinking included. Every turn is streamed (the SDK
// requires streaming for long outputs, and it avoids HTTP timeouts), so the
// default is generous; drafting skills that hand a whole brief to
// generate_document in one call set maxTokens up to the model's 128K.
const DEFAULT_MAX_TOKENS = 64_000;
const MAX_MAX_TOKENS = 128_000;

// Bounded agentic loop: every model request counts (a turn, a tool round
// trip, a pause_turn continuation). Report-only skills finish in 1-2;
// skills with tools take more; research skills set maxIterations higher.
const DEFAULT_MAX_ITERATIONS = 12;
const MAX_MAX_ITERATIONS = 40;

// A turn that hits max_tokens is discarded (a cut-off tool call is never
// run and a cut-off report is never accepted) and retried this many times.
const MAX_TRUNCATION_RETRIES = 2;
// Consecutive re-sends of a turn whose streamed tool input was not parseable JSON.
const MAX_UNPARSEABLE_TOOL_INPUT_RETRIES = 2;

// Whole-run wall clock. The pg-boss job for a run expires an hour later
// (SKILL_RUN_JOB_EXPIRE_SECONDS in skill-run-job.ts), so a run always
// records its own outcome.
const RUN_DEADLINE_MS = 3 * 60 * 60 * 1000;

// Once a request's prompt passes this many tokens (of the 1M window), the
// next user turn tells the model to stop gathering and submit its report.
// Measured as the context of the request's last sampling iteration (see
// contextTokens), not the usage totals, which add up every server-side
// iteration of a turn that ran web tools.
const CONTEXT_WRAP_UP_TOKENS = 700_000;
// A turn that ran past the context window inside the API's own server-tool
// loop (stop_reason "model_context_window_exceeded") is dropped and asked
// again with the wrap-up instruction this many times before the run fails.
const MAX_CONTEXT_OVERFLOW_RETRIES = 2;

// The API accepts at most 32 MB per request, and every request resends the
// whole conversation: attachments, page images from render_and_qa_docx,
// PDFs web_fetch returned. The runner measures each request before sending
// it (the serialized JSON body), tells the model to wrap up once it passes
// REQUEST_WRAP_UP_BYTES, lets tools add bulky results only up to
// REQUEST_TOOL_LIMIT_BYTES, and never sends one over MAX_REQUEST_BYTES (a
// clear error instead of the API's 413). Decimal megabytes, to be safe.
const MAX_REQUEST_BYTES = 32_000_000;
const REQUEST_TOOL_LIMIT_BYTES = 30_000_000;
const REQUEST_WRAP_UP_BYTES = 26_000_000;
// Matter attachments get less of the request when the skill's tools keep
// adding bytes to every later request (page images, fetched PDFs).
const ATTACHMENT_BYTES_WITH_GROWING_TOOLS = 16 * 1024 * 1024;

// Images that tool results (render_and_qa_docx pages) add to the
// conversation are resent with every request. The API allows 20 images of
// any size per request, more only if every image is at most 2000 px per
// side (rendered pages are 850 x 1100 px). A skill with an image tool has
// this many slots kept free when matter images are attached (see
// document-input.ts), and the run never adds more than
// MAX_TOOL_IMAGES_PER_RUN page images (about 1,300 tokens each).
const RESERVED_TOOL_IMAGE_SLOTS = 10;
const FEW_IMAGES_ANY_SIZE = 20;
const MAX_IMAGES_PER_REQUEST = 600;
const MAX_TOOL_IMAGES_PER_RUN = 60;

/**
 * A request the user can fix or that is simply not allowed right now (a
 * retry of a run that is not failed, a retry already in progress). Server
 * Actions return its message to the UI instead of throwing it.
 */
export class SkillRunRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillRunRequestError";
  }
}

/**
 * Refuses a new run while the firm already has QUEUED_RUNS_PER_TENANT_MAX
 * runs waiting: a backlog beyond that is never useful, and a loop queuing
 * runs (a script, a misbehaving connector client) must not pile up work.
 * Counted inside the enqueue transaction; two enqueues in the same instant
 * can overshoot by one, which is fine. Exported for the check script.
 */
export async function assertQueueCapacity(tx: Parameters<typeof recordAuditEvent>[0], tenantId: string): Promise<void> {
  const [row] = await tx
    .select({ n: count() })
    .from(skillRuns)
    .where(and(eq(skillRuns.tenantId, tenantId), eq(skillRuns.status, "queued")));
  const queued = Number(row?.n ?? 0);
  if (queued >= QUEUED_RUNS_PER_TENANT_MAX) {
    throw new SkillRunRequestError(
      `The firm already has ${queued} runs waiting to start (the limit is ${QUEUED_RUNS_PER_TENANT_MAX}). Wait for some of them to finish before queuing more.`
    );
  }
}

/**
 * The worker's first step for a job: a run whose firm has become locked
 * (free month or subscription ended) since it was queued is failed, audited
 * as skill_run.failed with reason firm_locked, instead of started: a run
 * spends the platform's model budget. Returns true when the run was
 * refused. `inTenant` is the transaction runner (the check script passes
 * PGlite's). Exported for the check script.
 */
export async function refuseRunWhenLocked(
  params: { skillRunId: string; tenantId: string; entitlement: Entitlement },
  inTenant: TenantTransactionRunner = withTenantContext
): Promise<boolean> {
  if (params.entitlement.state !== "locked") return false;
  const changed = await failUnfinishedSkillRun(
    {
      tenantId: params.tenantId,
      skillRunId: params.skillRunId,
      fromStatuses: ["queued"],
      errorMessage:
        `This run did not start: ${lockedReasonText(params.entitlement)}. ` +
        "The firm's owner can subscribe on the Billing page; then use Retry to run it again.",
      actor: SYSTEM_ACTORS.skillRunWorker,
      reason: "firm_locked",
    },
    inTenant
  );
  if (changed) console.warn(`processSkillRun: SkillRun ${params.skillRunId} refused: tenant ${params.tenantId} is locked (${params.entitlement.reason})`);
  return true;
}

/**
 * Fast path: records the SkillRun as "queued" and hands it to the pg-boss
 * worker (see src/worker.ts), then returns immediately. The actual agentic
 * loop runs in processSkillRun below, out-of-process, so this no longer
 * holds a DB transaction or an HTTP request open for the run's duration.
 *
 * With retryOfRunId the new run is a Retry of that failed run (see
 * retrySkillRun): the link is kept in input_snapshot.retryOfRunId, and the
 * original row stays as it is, so the history shows both.
 */
export async function enqueueSkillRun(params: {
  tenantId: string;
  matterId: string;
  skillName: SupportedSkillName;
  requestedBy: string;
  /**
   * The requester's role now (from their Clerk session), kept as
   * input_snapshot.requesterRole: generators embed a stored signature image
   * only for an owner/admin or attorney's run (tools/shared/signer.ts).
   */
  requesterRole: MembershipRole;
  attorneyNote?: string;
  retryOfRunId?: string;
  /**
   * Set when the run is queued from Claude or ChatGPT through the connector
   * (src/services/connector/): the skill_run.requested entry says so
   * (after.via "connector"), and the connector's own connector.tool_call
   * entry is written in the same transaction as the run row.
   */
  connectorCall?: { tool: string; oauthClientId: string };
}) {
  const { tenantId, matterId, skillName, requestedBy, requesterRole, attorneyNote, retryOfRunId, connectorCall } = params;
  // skillName arrives from a Server Action, i.e. from the browser: check it
  // against the registry rather than trusting the static type.
  if (!isSupportedSkillName(skillName)) {
    throw new Error(`Unknown skill "${skillName}"`);
  }

  const runId = await withTenantContext(tenantId, async (tx) => {
    if (retryOfRunId) {
      // Locks the original row, so two Retry clicks (two tabs, a double
      // submit) on the same failed run are serialized and the second one
      // sees the first one's queued retry below.
      const [original] = await tx
        .select({ status: skillRuns.status, matterId: skillRuns.matterId, skillName: skillRuns.skillName })
        .from(skillRuns)
        .where(and(eq(skillRuns.id, retryOfRunId), eq(skillRuns.tenantId, tenantId)))
        .limit(1)
        .for("update");
      if (!original || original.matterId !== matterId || original.skillName !== skillName) {
        throw new SkillRunRequestError("The run to retry was not found.");
      }
      if (original.status !== "failed") {
        throw new SkillRunRequestError(`Only a failed run can be retried; this one is "${original.status}".`);
      }
      const [retryInProgress] = await tx
        .select({ id: skillRuns.id })
        .from(skillRuns)
        .where(
          and(
            eq(skillRuns.tenantId, tenantId),
            eq(skillRuns.matterId, matterId),
            inArray(skillRuns.status, ["queued", "running"]),
            sql`${skillRuns.inputSnapshot}->>'retryOfRunId' = ${retryOfRunId}`
          )
        )
        .limit(1);
      if (retryInProgress) {
        throw new SkillRunRequestError("A retry of this run is already queued or running.");
      }
    }
    await assertQueueCapacity(tx, tenantId);

    const [skillDef] = await tx
      .select()
      .from(skillDefinitions)
      .where(eq(skillDefinitions.name, skillName))
      .orderBy(desc(skillDefinitions.version))
      .limit(1);
    if (!skillDef) {
      throw new Error(`No SkillDefinition found for "${skillName}". Run the skill seed script first.`);
    }

    const [matter] = await tx
      .select()
      .from(matters)
      .where(and(eq(matters.id, matterId), eq(matters.tenantId, tenantId)))
      .limit(1);
    if (!matter) throw new Error("Matter not found");

    const matterDocuments = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), eq(documents.matterId, matterId)));

    const [activeProfile] = await tx
      .select()
      .from(practiceProfileVersions)
      .where(and(eq(practiceProfileVersions.tenantId, tenantId), eq(practiceProfileVersions.status, "active")))
      .limit(1);

    // The firm identity is not versioned, so the run keeps the copy it was
    // queued with: the prompt and any letterhead it generates use exactly this.
    const firmIdentity = await loadFirmIdentitySnapshot(tx, tenantId);
    // Published legal updates routed to this skill (src/services/monitoring/skill-runs.ts),
    // kept with the run like the firm identity, so a run and its prompt see the same items.
    const legalUpdates = await loadRecentLegalUpdatesForSkill(tenantId, skillName, { tx });

    const [run] = await tx
      .insert(skillRuns)
      .values({
        tenantId,
        matterId,
        skillDefinitionId: skillDef.id,
        skillName: skillDef.name,
        skillVersion: skillDef.version,
        status: "queued",
        inputSnapshot: {
          practiceProfileVersionId: activeProfile?.id ?? null,
          documentIds: matterDocuments.map((d) => ({ id: d.id, version: d.version })),
          attorneyNote: attorneyNote ?? null,
          requesterRole,
          firmIdentity,
          legalUpdates,
          ...(retryOfRunId ? { retryOfRunId } : {}),
        },
        requestedBy,
      })
      .returning();

    await recordAuditEvent(tx, {
      tenantId,
      actorUserId: requestedBy,
      action: AUDIT_ACTIONS.skillRunRequested,
      resourceType: "skill_run",
      resourceId: run.id,
      after: {
        status: "queued",
        matterId,
        skillName: skillDef.name,
        skillVersion: skillDef.version,
        retryOfRunId: retryOfRunId ?? null,
        // Whether a case note came with the request; never the note itself.
        attorneyNoteProvided: Boolean(attorneyNote),
        ...(connectorCall ? { via: "connector" } : {}),
      },
    });
    if (connectorCall) {
      await recordAuditEvent(tx, {
        tenantId,
        actorUserId: requestedBy,
        action: AUDIT_ACTIONS.connectorToolCall,
        resourceType: "connector_tool",
        resourceId: connectorCall.tool,
        after: {
          matterId,
          skillRunId: run.id,
          skillName: skillDef.name,
          oauthClientId: connectorCall.oauthClientId,
          outcome: "queued",
        },
      });
    }

    return run.id;
  });

  // The row is committed before the job is sent. If the send fails, fail
  // the row now (it would otherwise sit "queued" until the stuck-run sweep
  // finds it) and let the caller see the error.
  try {
    const boss = await getBoss();
    const data: SkillRunJobData = { skillRunId: runId, tenantId };
    const jobId = await boss.send(SKILL_RUN_QUEUE, data, {
      // No automatic retry: a run can have side effects (live fetches,
      // generated documents). The user retries a failed run explicitly.
      retryLimit: 0,
      expireInSeconds: SKILL_RUN_JOB_EXPIRE_SECONDS,
      heartbeatSeconds: SKILL_RUN_JOB_HEARTBEAT_SECONDS,
      // The tenant is the job's pg-boss group: the worker caps each tenant's
      // runs in progress (SKILL_RUN_TENANT_CONCURRENCY_ENV in skill-run-job.ts),
      // so one firm cannot take every slot.
      group: { id: tenantId },
    });
    if (!jobId) throw new Error("the queue did not accept the job");
  } catch (err) {
    const message = safeErrorMessage(err);
    await failUnfinishedSkillRun({
      tenantId,
      skillRunId: runId,
      fromStatuses: ["queued"],
      errorMessage: `This run could not be put on the background queue (${message}), so it never started. Use Retry to try again.`,
      actor: SYSTEM_ACTORS.skillRunQueue,
      reason: "enqueue_failed",
    }).catch((markErr) =>
      console.error(`enqueueSkillRun: could not mark SkillRun ${runId} failed after its enqueue failed: ${describeErrorForLog(markErr)}`)
    );
    throw err;
  }

  return runId;
}

/**
 * The Retry button: queues a fresh run of a failed run's skill on the same
 * matter, with the same case note, as a new row (the failed one stays in the
 * history). It reads the matter's current documents, practice profile and
 * the skill's latest version, like any new run. `requestedBy` and
 * `requesterRole` are the user who clicked Retry.
 */
export async function retrySkillRun(params: {
  tenantId: string;
  skillRunId: string;
  requestedBy: string;
  requesterRole: MembershipRole;
}): Promise<{ runId: string; matterId: string }> {
  const { tenantId, skillRunId, requestedBy, requesterRole } = params;
  const original = await withTenantContext(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: skillRuns.id,
        matterId: skillRuns.matterId,
        skillName: skillRuns.skillName,
        status: skillRuns.status,
        inputSnapshot: skillRuns.inputSnapshot,
      })
      .from(skillRuns)
      .where(and(eq(skillRuns.id, skillRunId), eq(skillRuns.tenantId, tenantId)))
      .limit(1);
    return row ?? null;
  });
  if (!original) throw new SkillRunRequestError("The run to retry was not found.");
  // Checked again under a row lock in enqueueSkillRun; this early check just
  // gives the clearer message.
  if (original.status !== "failed") {
    throw new SkillRunRequestError(`Only a failed run can be retried; this one is "${original.status}".`);
  }
  if (!isSupportedSkillName(original.skillName)) {
    throw new SkillRunRequestError(`The skill "${original.skillName}" is no longer available, so this run cannot be retried.`);
  }

  // Same rule as a new run: only skills that take a case note get one.
  const snapshot = original.inputSnapshot as { attorneyNote?: string | null };
  const attorneyNote = getSkillModule(original.skillName).needsNote
    ? snapshot.attorneyNote?.trim() || undefined
    : undefined;

  const runId = await enqueueSkillRun({
    tenantId,
    matterId: original.matterId,
    skillName: original.skillName,
    requestedBy,
    requesterRole,
    attorneyNote,
    retryOfRunId: original.id,
  });
  return { runId, matterId: original.matterId };
}

/**
 * Worker-side path: called only from src/worker.ts's pg-boss handler.
 *
 * Three short transactions instead of one held open for the whole run
 * (runs take minutes, drafting and research runs much longer): claim the
 * run (queued -> running, atomically, so a duplicate job delivery is a
 * no-op), load its inputs, then, after the loop, record completed or
 * failed. The polling UI sees "running" while the loop works, and a
 * failure is committed before it is re-thrown.
 *
 * The record step only moves a run that is still "running": once the
 * stuck-run sweep or a shutting-down worker has marked it failed, that
 * outcome stands (runs go queued -> running -> completed | failed, never
 * back). Each outcome gets its skill_run.completed / skill_run.failed audit
 * row in the same transaction.
 */
export async function processSkillRun(skillRunId: string, tenantId: string): Promise<void> {
  // The firm's billing state as of now, not as of the enqueue: a run queued
  // moments before the lock does not start (src/lib/billing/entitlement.ts).
  if (await refuseRunWhenLocked({ skillRunId, tenantId, entitlement: await readEntitlement(tenantId) })) return;

  const run = await withTenantContext(tenantId, async (tx) => {
    const [claimed] = await tx
      .update(skillRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(and(eq(skillRuns.id, skillRunId), eq(skillRuns.tenantId, tenantId), eq(skillRuns.status, "queued")))
      .returning();
    if (claimed) return claimed;
    const [existing] = await tx
      .select({ status: skillRuns.status })
      .from(skillRuns)
      .where(and(eq(skillRuns.id, skillRunId), eq(skillRuns.tenantId, tenantId)))
      .limit(1);
    console.warn(
      existing
        ? `processSkillRun: SkillRun ${skillRunId} is already "${existing.status}"; skipping duplicate delivery.`
        : `processSkillRun: SkillRun ${skillRunId} not found; skipping.`
    );
    return null;
  });
  if (!run) return;

  // Filled in by executeSkillLoop as it goes; recorded whether the run completes or fails.
  const audit: RunAudit = { documentInput: null, modelRun: null, verificationLog: [] };
  // A run queued before firm identities existed has none in its snapshot; it
  // gets the current one, recorded with its outcome.
  let lateFirmIdentity: FirmIdentitySnapshot | null = null;
  const snapshotWithAudit = () => ({
    ...(run.inputSnapshot as Record<string, unknown>),
    ...(lateFirmIdentity ? { firmIdentity: lateFirmIdentity } : {}),
    // The skill version pins the prompt (SKILL.md and references). The code
    // around it (generator scripts and their assets, output schemas, tools)
    // is whatever the worker image holds, so record which image ran: Fly
    // sets FLY_IMAGE_REF on every Machine; null elsewhere (local dev).
    workerImage: process.env.FLY_IMAGE_REF ?? null,
    ...(audit.documentInput ? { documentInput: audit.documentInput } : {}),
    ...(audit.modelRun ? { modelRun: audit.modelRun } : {}),
  });

  try {
    const inputs = await withTenantContext(tenantId, async (tx) => {
      const [skillDef] = await tx
        .select()
        .from(skillDefinitions)
        .where(eq(skillDefinitions.id, run.skillDefinitionId))
        .limit(1);
      if (!skillDef) throw new Error(`SkillDefinition ${run.skillDefinitionId} not found for SkillRun ${skillRunId}`);

      const [matter] = await tx
        .select()
        .from(matters)
        .where(and(eq(matters.id, run.matterId), eq(matters.tenantId, tenantId)))
        .limit(1);
      if (!matter) throw new Error("Matter not found");

      const matterDocuments = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), eq(documents.matterId, run.matterId)));

      const inputSnapshot = run.inputSnapshot as {
        practiceProfileVersionId: string | null;
        attorneyNote?: string | null;
        firmIdentity?: unknown;
        legalUpdates?: unknown;
      };
      let practiceProfileMarkdown: string | null = null;
      if (inputSnapshot.practiceProfileVersionId) {
        const [profile] = await tx
          .select()
          .from(practiceProfileVersions)
          .where(
            and(
              eq(practiceProfileVersions.id, inputSnapshot.practiceProfileVersionId),
              eq(practiceProfileVersions.tenantId, tenantId)
            )
          )
          .limit(1);
        practiceProfileMarkdown = profile?.renderedMarkdown ?? null;
      }
      let firmIdentity = readFirmIdentitySnapshot(inputSnapshot.firmIdentity);
      if (firmIdentity === undefined) {
        firmIdentity = lateFirmIdentity = await loadFirmIdentitySnapshot(tx, tenantId);
      }
      return {
        skillDef,
        matter,
        matterDocuments,
        practiceProfileMarkdown,
        firmIdentity,
        attorneyNote: inputSnapshot.attorneyNote,
        // Null for a run queued before it was recorded: such a run embeds no signature image.
        requesterRole: readRequesterRole(run.inputSnapshot),
        // Null for a run queued before the legal-update monitor existed: its prompt is unchanged.
        recentLegalUpdates: readRecentLegalUpdatesSnapshot(inputSnapshot.legalUpdates),
      };
    });

    const { output } = await executeSkillLoop({
      tenantId,
      matterId: run.matterId,
      requestedBy: run.requestedBy,
      skillName: inputs.skillDef.name,
      skillMarkdown: inputs.skillDef.skillMarkdown,
      referenceFiles: readStoredReferenceFiles(inputs.skillDef.referenceFiles),
      contentHash: inputs.skillDef.contentHash,
      practiceProfileMarkdown: inputs.practiceProfileMarkdown,
      firmIdentity: inputs.firmIdentity,
      recentLegalUpdates: inputs.recentLegalUpdates,
      skillRunId: run.id,
      matter: inputs.matter,
      matterDocuments: inputs.matterDocuments,
      attorneyNote: inputs.attorneyNote ?? undefined,
      requesterRole: inputs.requesterRole,
      audit,
    });

    const escalationFlags = getSkillModule(inputs.skillDef.name).extractEscalationFlags(output);
    const recorded = await withTenantContext(tenantId, async (tx) => {
      const [updated] = await tx
        .update(skillRuns)
        .set({
          status: "completed",
          structuredOutput: output,
          verificationLog: audit.verificationLog,
          escalationFlags,
          inputSnapshot: snapshotWithAudit(),
          completedAt: new Date(),
        })
        .where(and(eq(skillRuns.id, run.id), eq(skillRuns.tenantId, tenantId), eq(skillRuns.status, "running")))
        .returning({ id: skillRuns.id });
      if (!updated) return false;
      await recordAuditEvent(tx, {
        tenantId,
        actorUserId: SYSTEM_ACTORS.skillRunWorker,
        action: AUDIT_ACTIONS.skillRunCompleted,
        resourceType: "skill_run",
        resourceId: run.id,
        before: { status: "running" },
        after: {
          status: "completed",
          matterId: run.matterId,
          skillName: run.skillName,
          skillVersion: run.skillVersion,
          requestedBy: run.requestedBy,
          escalationFlagCount: escalationFlags.length,
        },
      });
      return true;
    });
    if (!recorded) {
      console.warn(
        `processSkillRun: SkillRun ${skillRunId} finished, but it had already been marked failed ` +
          "(by the stuck-run sweep or a worker shutdown); its report was not saved."
      );
    }
  } catch (err) {
    try {
      const recorded = await withTenantContext(tenantId, async (tx) => {
        const [updated] = await tx
          .update(skillRuns)
          .set({
            status: "failed",
            // Shown on the matter page; never a query's bound values or a tool's raw input.
            errorMessage: safeErrorMessage(err),
            // What the run did retrieve before failing stays on the record.
            verificationLog: audit.verificationLog,
            inputSnapshot: snapshotWithAudit(),
            completedAt: new Date(),
          })
          .where(and(eq(skillRuns.id, run.id), eq(skillRuns.tenantId, tenantId), eq(skillRuns.status, "running")))
          .returning({ id: skillRuns.id });
        if (!updated) return false;
        await recordAuditEvent(tx, {
          tenantId,
          actorUserId: SYSTEM_ACTORS.skillRunWorker,
          action: AUDIT_ACTIONS.skillRunFailed,
          resourceType: "skill_run",
          resourceId: run.id,
          before: { status: "running" },
          // The error text itself stays on the skill_runs row (see recordAuditEvent).
          after: {
            status: "failed",
            reason: "run_error",
            matterId: run.matterId,
            skillName: run.skillName,
            skillVersion: run.skillVersion,
            requestedBy: run.requestedBy,
          },
        });
        return true;
      });
      if (!recorded) {
        console.warn(`processSkillRun: SkillRun ${skillRunId} failed, but it had already been marked failed elsewhere.`);
      }
    } catch (recordErr) {
      // Keep the run's own error as the one pg-boss records; the stuck-run
      // sweep fails the row later if this write never lands.
      console.error(`processSkillRun: could not record the failure of SkillRun ${skillRunId}: ${describeErrorForLog(recordErr)}`);
    }
    throw err;
  }
}

/** Model-side facts about a run: which model served it and what it used. Stored as input_snapshot.modelRun. */
type ModelRunAudit = {
  model: string;
  /** Every model that produced a response (more than one only after a refusal fallback). */
  servedBy: string[];
  fallbackUsed: boolean;
  requests: number;
  maxTokens: number;
  stopReasons: Record<string, number>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    webSearchRequests: number;
    webFetchRequests: number;
  };
};

/** What a run records about itself beyond the enqueue-time snapshot. */
export type RunAudit = {
  /** How each matter document reached the model (stored as input_snapshot.documentInput). */
  documentInput: DocumentInventoryEntry[] | null;
  modelRun: ModelRunAudit | null;
  /** Every URL fetched or returned by a search, written by the app (stored as skill_runs.verification_log). */
  verificationLog: VerificationLogEntry[];
};

/** messages.countTokens over a set of user-content blocks; null if counting fails (estimates are used instead). */
async function countUserBlockTokens(content: Anthropic.ContentBlockParam[]): Promise<number | null> {
  try {
    const res = await anthropic.messages.countTokens({ model: MODEL, messages: [{ role: "user", content }] });
    return res.input_tokens;
  } catch (err) {
    console.warn(`countTokens failed; using token estimates for document budgeting: ${describeErrorForLog(err)}`);
    return null;
  }
}

/** One streamed model turn. Streaming is required for large max_tokens; finalMessage() assembles the response. */
async function streamTurn(body: TurnRequest): Promise<BetaMessage> {
  return anthropic.beta.messages.stream(body).finalMessage();
}

/** The limits a skill module asks for, checked against what the runner supports. */
function runLimits(skill: AnySkillModule): { maxTokens: number; maxIterations: number } {
  const maxTokens = skill.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxIterations = skill.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (!Number.isInteger(maxTokens) || maxTokens < 4_000 || maxTokens > MAX_MAX_TOKENS) {
    throw new Error(`Skill "${skill.name}" sets maxTokens ${maxTokens}; it must be a whole number from 4000 to ${MAX_MAX_TOKENS}`);
  }
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > MAX_MAX_ITERATIONS) {
    throw new Error(`Skill "${skill.name}" sets maxIterations ${maxIterations}; it must be a whole number from 1 to ${MAX_MAX_ITERATIONS}`);
  }
  return { maxTokens, maxIterations };
}

/** How many page images tool results may add, given the matter images already attached. */
function toolImageBudget(input: PreparedDocumentInput, usesImageTools: boolean): number {
  if (!usesImageTools) return 0;
  const { count, allAtMost2000Px } = input.attachedImages;
  const room = allAtMost2000Px ? MAX_IMAGES_PER_REQUEST - count : FEW_IMAGES_ANY_SIZE - count;
  return Math.max(0, Math.min(MAX_TOOL_IMAGES_PER_RUN, room));
}

/**
 * Every value in the report under a key named generated...DocumentId(s)
 * (e.g. generatedLetterDocumentId, generatedDocumentIds). Those fields are
 * the report's claim about which documents the run produced.
 */
function generatedDocumentIdsIn(output: unknown): string[] {
  const ids: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (/^generated\w*DocumentIds?$/.test(key)) {
          for (const id of Array.isArray(value) ? value : [value]) {
            if (typeof id === "string" && id.trim()) ids.push(id.trim());
          }
        } else {
          walk(value);
        }
      }
    }
  };
  walk(output);
  return ids;
}

function emptyModelAudit(maxTokens: number): ModelRunAudit {
  return {
    model: MODEL,
    servedBy: [],
    fallbackUsed: false,
    requests: 0,
    maxTokens,
    stopReasons: {},
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
    },
  };
}

function recordResponse(audit: ModelRunAudit, response: BetaMessage): void {
  audit.requests += 1;
  if (!audit.servedBy.includes(response.model)) audit.servedBy.push(response.model);
  if ((response.usage.iterations ?? []).some((it) => it.type === "fallback_message")) audit.fallbackUsed = true;
  const reason = response.stop_reason ?? "none";
  audit.stopReasons[reason] = (audit.stopReasons[reason] ?? 0) + 1;
  // Top-level usage covers the attempt that produced this message; a
  // declined attempt before a fallback is in usage.iterations only.
  audit.usage.inputTokens += response.usage.input_tokens;
  audit.usage.outputTokens += response.usage.output_tokens;
  audit.usage.cacheReadInputTokens += response.usage.cache_read_input_tokens ?? 0;
  audit.usage.cacheCreationInputTokens += response.usage.cache_creation_input_tokens ?? 0;
  const server = serverToolUsage(response);
  audit.usage.webSearchRequests += server.webSearch;
  audit.usage.webFetchRequests += server.webFetch;
}

/**
 * The context size of a response's request: the prompt of its last sampling
 * iteration. When a turn runs server tools (web search, web fetch) the API
 * samples several times inside one request, and the top-level usage fields
 * add up every iteration (the right numbers for billing, which
 * recordResponse keeps), so they overstate the context several times over.
 * usage.iterations lists each iteration; the last message (or fallback
 * message) iteration is the effective context. Falls back to the top-level
 * fields when the API sends no iterations.
 */
function contextTokens(response: BetaMessage): number {
  const iterations = response.usage.iterations ?? [];
  for (let i = iterations.length - 1; i >= 0; i--) {
    const it = iterations[i];
    if (it.type === "message" || it.type === "fallback_message") {
      return it.input_tokens + it.cache_read_input_tokens + it.cache_creation_input_tokens;
    }
  }
  return (
    response.usage.input_tokens +
    (response.usage.cache_read_input_tokens ?? 0) +
    (response.usage.cache_creation_input_tokens ?? 0)
  );
}

/**
 * A request over the API's 32 MB limit: refused by the API (a 413, which the
 * SDK reports as a plain APIError) or caught before sending.
 */
class RequestTooLargeError extends Error {
  constructor(skillName: string, sizeBytes: number, refusedByApi: boolean) {
    const mb = (sizeBytes / 1_000_000).toFixed(1);
    super(
      (refusedByApi
        ? `${skillName}: the API refused a ${mb} MB request as too large (413). `
        : `${skillName}: the next request would be ${mb} MB, over the API's 32 MB request limit. `) +
        "Matter attachments, rendered page images and fetched documents are resent with every request; " +
        "retry with fewer or smaller documents on the matter."
    );
    this.name = "RequestTooLargeError";
  }
}

/** Whether the skill's tools leave bulky content (page images, fetched PDFs) in every later request. */
function growsRequests(usesImageTools: boolean, serverTools: { name: string }[]): boolean {
  return usesImageTools || serverTools.some((t) => t.name === "web_fetch");
}

/** A streamed tool input the SDK could not parse as JSON (not an API error): safe to re-send the same turn. */
function isUnparseableToolInput(err: unknown): boolean {
  return err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError);
}

/**
 * The references/*.md files a run inlines: the copy stored with its skill
 * version, so the prompt is exactly what the version's content_hash covers
 * whatever the worker image has on disk. A version seeded before references
 * were stored has none; then the files on disk are used only if they hash to
 * the version's content_hash with its SKILL.md, and otherwise the run fails
 * rather than send a pairing that never existed as a version.
 */
async function referencesForRun(params: {
  skillName: string;
  skillMarkdown: string;
  referenceFiles: ReferenceFile[] | null;
  contentHash: string;
}): Promise<ReferenceFile[]> {
  if (params.referenceFiles) return params.referenceFiles;
  const onDisk = await loadBundledReferences(params.skillName);
  if (computeSkillContentHash(params.skillMarkdown, onDisk) !== params.contentHash) {
    throw new Error(
      `The ${params.skillName} references on this worker differ from the ones its skill version was seeded with, ` +
        "and that version does not store its own copy. Run npm run db:seed-skills against this database, then use Retry."
    );
  }
  return onDisk;
}

/**
 * input_snapshot.firmIdentity as stored: the snapshot, null (a stored null),
 * or undefined for a run queued before firm identities existed.
 */
function readFirmIdentitySnapshot(value: unknown): FirmIdentitySnapshot | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const candidate = value as Partial<FirmIdentitySnapshot>;
  if (typeof value !== "object" || !Array.isArray(candidate.attorneys) || !("firm" in candidate)) {
    throw new Error("This run's stored firm identity is malformed; use Retry to queue it again with the current one.");
  }
  return value as FirmIdentitySnapshot;
}

/** skill_definitions.reference_files as stored (jsonb), or null when absent or malformed. */
function readStoredReferenceFiles(value: unknown): ReferenceFile[] | null {
  if (!Array.isArray(value)) return null;
  const files = value.filter(
    (f): f is ReferenceFile =>
      typeof f === "object" &&
      f !== null &&
      typeof (f as ReferenceFile).path === "string" &&
      typeof (f as ReferenceFile).content === "string"
  );
  return files.length === value.length ? files : null;
}

export type SkillLoopDeps = {
  /** One model turn. Defaults to a streamed beta Messages request; tests inject a scripted one. */
  sendTurn?: (body: TurnRequest) => Promise<BetaMessage>;
  countTokens?: (content: Anthropic.ContentBlockParam[]) => Promise<number | null>;
};

/**
 * The agentic loop for one run: system prompt (SKILL.md + references +
 * recent legal updates + runtime notes + practice profile + firm identity), the matter documents,
 * the skill's client tools, its server tools, and a submit_report tool whose
 * schema is the skill's output schema. Returns the validated report.
 *
 * submit_report is the only way a run completes. Opus 5.5 does not accept a
 * forced tool_choice, so the loop forces it the other way: a turn that ends
 * without calling it is answered with a prompt to call it, a submission
 * that fails the schema (or names a generated document this run did not
 * produce) is answered with the error, and a turn cut off at max_tokens is
 * never read as a report.
 *
 * The history is append-only (thinking blocks are only valid in the exact
 * conversation that produced them, and prompt caching is a prefix match):
 * every response is pushed as received, apart from the fallback echo rule
 * in sanitizeFallbackContent, and a truncated turn is dropped rather than
 * edited.
 */
export async function executeSkillLoop(
  params: {
    tenantId: string;
    matterId: string;
    requestedBy: string;
    skillName: string;
    skillMarkdown: string;
    /**
     * The skill version's stored references (skill_definitions.reference_files),
     * or null for a version seeded before they were stored: then the files
     * on disk are used, but only if they are exactly what contentHash covers.
     */
    referenceFiles: ReferenceFile[] | null;
    /** skill_definitions.content_hash of the version this run is pinned to. */
    contentHash: string;
    practiceProfileMarkdown: string | null;
    /**
     * The firm identity the run was queued with (input_snapshot.firmIdentity):
     * rendered into the system prompt, and the source generator tools fill
     * letterhead and signer fields from. Null renders the "not set up" text.
     */
    firmIdentity: FirmIdentitySnapshot | null;
    /** The legal updates the run was queued with (input_snapshot.legalUpdates); null or absent adds no section. */
    recentLegalUpdates?: RecentLegalUpdatesSnapshot | null;
    /** The skill_runs row, for audit entries tools write; absent in tests. */
    skillRunId?: string;
    matter: typeof matters.$inferSelect;
    matterDocuments: (typeof documents.$inferSelect)[];
    attorneyNote?: string;
    /** input_snapshot.requesterRole; null or absent: generators embed no signature image. */
    requesterRole?: MembershipRole | null;
    audit: RunAudit;
  },
  deps: SkillLoopDeps = {}
): Promise<{ output: unknown }> {
  const sendTurn = deps.sendTurn ?? streamTurn;
  const countTokens = deps.countTokens ?? countUserBlockTokens;

  // Throws for a skill_definitions row whose name is no longer registered,
  // or a module with bad limits or server tool settings; processSkillRun
  // records that as a failed run.
  const skill = getSkillModule(params.skillName);
  const { maxTokens, maxIterations } = runLimits(skill);
  const serverTools = normalizeServerTools(skill.name, skill.serverTools);
  const schema = skill.outputSchema;

  const referenceFiles = await referencesForRun(params);
  const skillTools = getSkillTools(params.skillName);

  // eager_input_streaming: tool inputs (a whole brief for generate_document,
  // a long report for submit_report) stream as they are generated instead
  // of after server-side buffering. The server then no longer validates
  // them, which this loop does itself: every client tool checks its input
  // with zod, a turn that stopped at max_tokens never runs its tools, and
  // an input the SDK cannot parse at all re-sends the turn.
  const submitReportTool: Anthropic.Beta.BetaTool = {
    name: "submit_report",
    description: `Submit the final structured ${params.skillName} report. Call this once, on its own, when your work is complete and every other tool call has returned.`,
    input_schema: toJsonSchemaObject(schema) as Anthropic.Beta.BetaTool.InputSchema,
    eager_input_streaming: true,
  };
  const tools: BetaToolUnion[] = [
    submitReportTool,
    ...Object.values(skillTools).map((t): Anthropic.Beta.BetaTool => ({ ...t.definition, eager_input_streaming: true })),
    ...buildServerToolDefinitions(serverTools),
  ];

  const webSearch = serverTools.find((t) => t.name === "web_search") ?? null;
  const webFetch = serverTools.find((t) => t.name === "web_fetch") ?? null;
  const runtimeNotes = buildRuntimeNotes({ toolNames: Object.keys(skillTools), webSearch, webFetch });

  // Prompt caching: one explicit breakpoint on the system prompt (tools +
  // system, the large stable prefix), one on the first user message
  // (documents and matter context, resent unchanged every turn), and
  // top-level automatic caching for the growing tail. Review skills finish
  // in minutes, so the default 5-minute TTL; drafting and research turns can
  // run longer than 5 minutes (a cache entry's lifetime counts from the
  // start of the request), so they use the 1-hour TTL. One TTL for all three
  // keeps the longer-before-shorter ordering rule trivially satisfied.
  const longTurns = skill.kind !== "review" || serverTools.length > 0 || maxTokens > DEFAULT_MAX_TOKENS;
  const cacheControl: Anthropic.Beta.BetaCacheControlEphemeral = { type: "ephemeral", ttl: longTurns ? "1h" : "5m" };
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    {
      type: "text",
      text: buildSystemPrompt({
        skillMarkdown: params.skillMarkdown,
        practiceProfileMarkdown: params.practiceProfileMarkdown,
        referenceFiles,
        runtimeNotes,
        firmIdentity: params.firmIdentity,
        recentLegalUpdates: params.recentLegalUpdates,
      }),
      cache_control: cacheControl,
    },
  ];

  const ctx: ToolExecutionContext = {
    tenantId: params.tenantId,
    matterId: params.matterId,
    requestedBy: params.requestedBy,
    skillRunId: params.skillRunId ?? null,
    firmIdentity: params.firmIdentity,
    attorneyNote: params.attorneyNote?.trim() || null,
    requesterRole: params.requesterRole ?? null,
    verificationLog: params.audit.verificationLog,
    generatedDocuments: new Map(),
    toolImages: { budget: 0, used: 0 },
    requestBytes: { limit: REQUEST_TOOL_LIMIT_BYTES, used: 0 },
  };
  const recorder = new ServerToolSourceRecorder(ctx.verificationLog);
  const modelAudit = emptyModelAudit(maxTokens);
  params.audit.modelRun = modelAudit;

  const usesImageTools = skill.tools.some((key) => IMAGE_RETURNING_TOOL_KEYS.includes(key));
  const reservedToolImageSlots = usesImageTools ? RESERVED_TOOL_IMAGE_SLOTS : 0;
  const maxNativeBase64Bytes = growsRequests(usesImageTools, serverTools)
    ? ATTACHMENT_BYTES_WITH_GROWING_TOOLS
    : DEFAULT_MAX_NATIVE_BASE64_BYTES;
  let documentInput = await prepareDocumentInput(params.matterDocuments, {
    reservedToolImageSlots,
    countTokens,
    maxNativeBase64Bytes,
  });
  params.audit.documentInput = documentInput.inventory;
  ctx.toolImages.budget = toolImageBudget(documentInput, usesImageTools);

  // Documents first, then the matter context and inventory (long documents
  // before the question). The run date is fixed once, so the text-only
  // retry of the first message sends the same date.
  const runDate = new Date().toISOString().slice(0, 10);
  const firstMessage = (input: PreparedDocumentInput): BetaMessageParam => ({
    role: "user",
    content: [
      ...input.blocks,
      {
        type: "text",
        text: buildUserContext(params.matter, input.inventory, params.attorneyNote, runDate),
        cache_control: cacheControl,
      },
    ],
  });
  const messages: BetaMessageParam[] = [firstMessage(documentInput)];

  const turnRequest = (): TurnRequest => ({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    tools,
    messages,
    thinking: { type: "adaptive" },
    output_config: { effort: EFFORT },
    cache_control: cacheControl,
    betas: [REFUSAL_FALLBACK_BETA],
    fallbacks: "default",
    stream: true,
  });

  // Size of the request as it would be sent now (the JSON body).
  const requestBytes = (): number => Buffer.byteLength(JSON.stringify(turnRequest()), "utf8");

  // A turn whose streamed tool input could not be parsed at all has no
  // tool_use id to answer, so it is re-sent unchanged (capped).
  const requestTurn = async (): Promise<BetaMessage> => {
    const size = requestBytes();
    if (size > MAX_REQUEST_BYTES) {
      throw new RequestTooLargeError(params.skillName, size, false);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await sendTurn(turnRequest());
      } catch (err) {
        // The SDK has no class of its own for a 413; give it a readable message.
        if (err instanceof Anthropic.APIError && err.status === 413) {
          throw new RequestTooLargeError(params.skillName, size, true);
        }
        if (!isUnparseableToolInput(err) || attempt >= MAX_UNPARSEABLE_TOOL_INPUT_RETRIES) throw err;
        // Never log the error itself: its message ends with the partial tool input (case content).
        console.warn(`${params.skillName}: a streamed tool input was not parseable JSON; re-sending the turn: ${describeErrorForLog(err)}`);
      }
    }
  };

  const deadline = Date.now() + RUN_DEADLINE_MS;
  let truncations = 0;
  let contextOverflows = 0;
  let wrapUp = false;
  // True while the conversation ends in a server tool call the API has not
  // run yet (a paused turn, or results sent back for a turn that mixed client
  // and server tools). The API runs it on the next request; until then no
  // user text may be added.
  let awaitingServerTool = false;

  // The user turn that answers the last assistant turn may hold only
  // tool_result blocks while a server tool call in it is still pending;
  // otherwise it may also carry this reminder to finish.
  const wrapUpText = (iterationsLeft: number): string | null => {
    if (wrapUp) {
      return "The conversation is close to its context or request size limit. Do not search, fetch, render, or generate anything more: call submit_report now with what you have, and record anything unfinished wherever the report records gaps or open items.";
    }
    if (iterationsLeft <= 2) {
      return `Only ${iterationsLeft} turn(s) remain in this run. Finish now: call submit_report on its own with what you have, and record anything unfinished wherever the report records gaps or open items.`;
    }
    return null;
  };

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (Date.now() > deadline) {
        throw new Error(`${params.skillName} ran past the ${RUN_DEADLINE_MS / 3_600_000}-hour limit without submitting a report`);
      }

      let response: BetaMessage;
      try {
        response = await requestTurn();
      } catch (err) {
        // A 400 on the very first request, with files attached, most likely
        // means the API rejected one of them (a malformed PDF, an image it
        // can't decode). Retry once with every document as extracted text,
        // so the run still completes and reports the files as text-only or
        // not reviewed. No tool has run yet, so the retry is side-effect free.
        // A first request too large for the API is the same situation.
        const attachedNatively = documentInput.inventory.some((e) => e.disposition === "pdf" || e.disposition === "image");
        const rejectedFiles = err instanceof Anthropic.BadRequestError || err instanceof RequestTooLargeError;
        if (iteration > 0 || !rejectedFiles || !attachedNatively) throw err;
        console.warn(`${params.skillName}: first request rejected with files attached; retrying with extracted text only:`, err.message);
        documentInput = await prepareDocumentInput(params.matterDocuments, {
          reservedToolImageSlots,
          countTokens,
          maxNativeBase64Bytes,
          nativeDisabledReason: `the Claude API rejected this run's attached files (${err.message.slice(0, 300)})`,
        });
        params.audit.documentInput = documentInput.inventory;
        ctx.toolImages.budget = toolImageBudget(documentInput, usesImageTools);
        messages[0] = firstMessage(documentInput);
        response = await requestTurn();
      }
      recordResponse(modelAudit, response);
      if (contextTokens(response) > CONTEXT_WRAP_UP_TOKENS) wrapUp = true;
      const iterationsLeft = maxIterations - iteration - 1;

      if (response.stop_reason === "refusal") {
        // With fallbacks on, this means every model in the chain declined.
        throw new Error(
          `Model declined to run ${params.skillName} (category: ${response.stop_details?.category ?? "unknown"})`
        );
      }

      if (response.stop_reason === "max_tokens") {
        truncations += 1;
        if (truncations > MAX_TRUNCATION_RETRIES) {
          throw new Error(
            `${params.skillName} hit the ${maxTokens}-token per-turn output limit ${truncations} times; no truncated report was accepted. ` +
              "Raise maxTokens in the skill module (up to 128000) or shorten what one turn has to produce."
          );
        }
        // Drop the cut-off turn: its last tool call (a report, a document)
        // is incomplete, and editing a turn is not allowed. Say so and ask
        // again; while a server tool call is pending no user text is
        // allowed, so then the same request is simply sent again.
        console.warn(`${params.skillName}: turn ${iteration + 1} stopped at max_tokens (${maxTokens}); asking again`);
        if (!awaitingServerTool) {
          const reminder = wrapUpText(iterationsLeft);
          messages.push({
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `Your last turn was cut off at the ${maxTokens}-token output limit before it finished, and nothing from it was used. ` +
                  "Take that turn again within the limit: keep each tool call's input to what it needs. " +
                  "A document passed to generate_document must fit in one turn, and a report must not repeat a document's text." +
                  (reminder ? ` ${reminder}` : ""),
              },
            ],
          });
        }
        continue;
      }

      if (response.stop_reason === "model_context_window_exceeded") {
        // The API's own server-tool loop (searches, fetches) grew this one
        // request past the context window. Drop the turn, as for max_tokens,
        // and ask for the report with what the model already had; while a
        // server tool call is pending no user text is allowed, so then the
        // same request is sent again.
        contextOverflows += 1;
        wrapUp = true;
        if (contextOverflows > MAX_CONTEXT_OVERFLOW_RETRIES) {
          throw new Error(
            `${params.skillName} ran past the model's context window ${contextOverflows} times while researching; no report was produced. ` +
              "Retry, or lower the skill's web_fetch maxContentTokens / maxUses."
          );
        }
        console.warn(`${params.skillName}: turn ${iteration + 1} exceeded the context window; asking for the report`);
        if (!awaitingServerTool) {
          messages.push({
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Your last turn ran past the context window and nothing from it was used. " +
                  (wrapUpText(iterationsLeft) ?? ""),
              },
            ],
          });
        }
        continue;
      }

      // Every URL the web tools returned in this turn goes to the
      // verification log, written by the app, whatever the model says later.
      recorder.record(response.content, new Date());
      const content = sanitizeFallbackContent(response.content);
      const pendingServerTool = hasPendingServerToolUse(content);

      if (response.stop_reason === "pause_turn") {
        // The API paused its own server-tool loop; send the turn back as is
        // and it resumes (no user message: the API continues the same turn).
        messages.push({ role: "assistant", content });
        awaitingServerTool = pendingServerTool;
        if (requestBytes() > REQUEST_WRAP_UP_BYTES) wrapUp = true;
        continue;
      }

      if (response.stop_reason !== "tool_use" && response.stop_reason !== "end_turn" && response.stop_reason !== "stop_sequence") {
        throw new Error(`${params.skillName} stopped with an unexpected stop_reason "${response.stop_reason}"`);
      }

      const toolUses = content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
      messages.push({ role: "assistant", content });
      // What the next request already weighs; tools add what they return.
      ctx.requestBytes.used = requestBytes();
      if (ctx.requestBytes.used > REQUEST_WRAP_UP_BYTES) wrapUp = true;

      if (toolUses.length === 0) {
        const reminder = wrapUpText(iterationsLeft);
        awaitingServerTool = false;
        messages.push({
          role: "user",
          content:
            "Continue, and call submit_report with your final structured findings when ready." +
            (reminder ? ` ${reminder}` : ""),
        });
        continue;
      }

      let submittedOutput: unknown = null;
      const toolResults: BetaToolResultBlockParam[] = [];
      const submitAlone = toolUses.length === 1 && !pendingServerTool;

      for (const toolUse of toolUses) {
        if (toolUse.name === "submit_report") {
          if (!submitAlone) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content:
                "Not accepted: submit_report must be the only tool call in its turn, after the results of your other tool calls are back. Call it again on its own.",
              is_error: true,
            });
            continue;
          }
          const parsed = schema.safeParse(toolUse.input);
          if (!parsed.success) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: `Your submission did not match the required schema: ${parsed.error.message}. Call submit_report again with corrected input.`,
              is_error: true,
            });
            continue;
          }
          const unknownIds = generatedDocumentIdsIn(parsed.data).filter(
            (id) => ctx.generatedDocuments.get(id)?.origin !== "generated"
          );
          if (unknownIds.length > 0) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content:
                `Not accepted: ${unknownIds.join(", ")} ${unknownIds.length === 1 ? "is not a document" : "are not documents"} generated in this run. ` +
                "Use the document_id a generator tool returned. If no document could be generated, leave the field empty and say why in the report.",
              is_error: true,
            });
            continue;
          }
          submittedOutput = parsed.data;
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: "Report accepted." });
          continue;
        }

        const tool = skillTools[toolUse.name];
        if (!tool) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Unknown tool: ${toolUse.name}`,
            is_error: true,
          });
          continue;
        }

        try {
          const result = await tool.execute(toolUse.input, ctx);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.content,
            is_error: result.isError,
          });
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          });
        }
      }

      if (submittedOutput !== null) {
        return { output: submittedOutput };
      }

      const reminder = pendingServerTool ? null : wrapUpText(iterationsLeft);
      const userContent: BetaContentBlockParam[] = [...toolResults];
      if (reminder) userContent.push({ type: "text", text: reminder });
      messages.push({ role: "user", content: userContent });
      awaitingServerTool = pendingServerTool;
    }

    throw new Error(`${params.skillName} did not produce a valid report within ${maxIterations} turns`);
  } finally {
    await cleanupGeneratedDocuments(ctx);
  }
}
