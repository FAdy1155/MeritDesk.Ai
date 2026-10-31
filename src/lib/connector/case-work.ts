import "server-only";
import { and, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { withTenantContext, type db, type TenantTransactionRunner } from "@/db/client";
import { clients, documents, matterParties, matters, skillRuns } from "@/db/schema";
import { AUDIT_ACTIONS, recordAuditEvent } from "@/lib/audit/service";
import { caseTypeLabel } from "@/lib/matters/case-types";
import { matterStatusLabel, matterVenueLabel } from "@/lib/matters/details";
import { readEscalationFlags } from "@/lib/skill-runs/snapshot";
import { listLegalUpdatesForTenant, type LegalUpdateView } from "@/services/monitoring/service";

// The tenant data the connector's case-work tools read
// (src/services/connector/tools/case-work.ts), each read in one
// withTenantContext transaction that filters by tenant in every query and
// writes the call's connector.tool_call audit entry in that same
// transaction: a read through the connector discloses client data to a
// third party (Anthropic or OpenAI), so it is recorded like a change.
//
// What these return is deliberately narrower than the matter page: party
// names and roles but no A-number, date of birth or contact details; a
// document's name, type, size and scan status but never its storage key,
// its bytes or its extracted text; a run's report, flags and error but not
// its input snapshot (case note, firm identity). Signature images, audit
// logs and other tenants' data are never read here.
//
// The last parameter, inTenant, is withTenantContext everywhere in the app;
// the connector check script passes a PGlite transaction runner instead.

/** Who is calling and through which tool; every function below records it. */
export type ConnectorCallContext = {
  tenantId: string;
  userId: string;
  oauthClientId: string;
  tool: string;
};

type Tx = typeof db;

async function recordCall(tx: Tx, ctx: ConnectorCallContext, after: Record<string, unknown>): Promise<void> {
  await recordAuditEvent(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: AUDIT_ACTIONS.connectorToolCall,
    resourceType: "connector_tool",
    resourceId: ctx.tool,
    after: { ...after, oauthClientId: ctx.oauthClientId },
  });
}

/** Records a call that failed before any data was read (invalid input, refused), in its own transaction. */
export async function recordConnectorCallOutcome(
  ctx: ConnectorCallContext,
  outcome: string,
  ids: { matterId?: string; skillRunId?: string; documentId?: string } = {},
  inTenant: TenantTransactionRunner = withTenantContext
): Promise<void> {
  await inTenant(ctx.tenantId, (tx) => recordCall(tx, ctx, { ...ids, outcome }));
}

export type ConnectorParty = { name: string; role: string };

export type ConnectorMatterSummary = {
  id: string;
  caseType: string;
  caseTypeLabel: string;
  status: string;
  statusLabel: string;
  venue: string | null;
  court: string | null;
  circuit: string | null;
  nextHearingDate: string | null;
  createdAt: string;
  updatedAt: string;
  parties: ConnectorParty[];
};

async function partiesByMatter(tx: Tx, tenantId: string, matterIds: string[]): Promise<Map<string, ConnectorParty[]>> {
  const out = new Map<string, ConnectorParty[]>();
  if (matterIds.length === 0) return out;
  const rows = await tx
    .select({ matterId: matterParties.matterId, role: matterParties.role, name: clients.fullName })
    .from(matterParties)
    // Both sides filtered by tenant, as listMatterParties does.
    .innerJoin(clients, and(eq(clients.id, matterParties.clientId), eq(clients.tenantId, tenantId)))
    .where(and(eq(matterParties.tenantId, tenantId), inArray(matterParties.matterId, matterIds)))
    .orderBy(matterParties.createdAt);
  for (const row of rows) {
    const list = out.get(row.matterId) ?? [];
    list.push({ name: row.name, role: row.role });
    out.set(row.matterId, list);
  }
  return out;
}

function summarize(row: typeof matters.$inferSelect, parties: ConnectorParty[]): ConnectorMatterSummary {
  return {
    id: row.id,
    caseType: row.caseType,
    caseTypeLabel: caseTypeLabel(row.caseType),
    status: row.status,
    statusLabel: matterStatusLabel(row.status),
    venue: matterVenueLabel(row.venue),
    court: row.court,
    circuit: row.circuit,
    nextHearingDate: row.nextHearingDate,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    parties,
  };
}

/** The firm's matters, newest first, with each one's parties (name and role only). */
export async function listMattersForConnector(
  ctx: ConnectorCallContext,
  params: { status?: string | null; caseType?: string | null; limit: number; offset: number },
  inTenant: TenantTransactionRunner = withTenantContext
): Promise<{ matters: ConnectorMatterSummary[]; total: number }> {
  const { tenantId } = ctx;
  return inTenant(tenantId, async (tx) => {
    const where: SQL[] = [eq(matters.tenantId, tenantId)];
    if (params.status) where.push(eq(matters.status, params.status));
    if (params.caseType) where.push(eq(matters.caseType, params.caseType));
    const [{ total }] = await tx.select({ total: count() }).from(matters).where(and(...where));
    const rows = await tx
      .select()
      .from(matters)
      .where(and(...where))
      .orderBy(desc(matters.createdAt))
      .limit(params.limit)
      .offset(params.offset);
    const parties = await partiesByMatter(tx, tenantId, rows.map((r) => r.id));
    // Which matters' parties went to the conversation, and the request that chose them (limit is at most 50).
    await recordCall(tx, ctx, {
      outcome: "ok",
      count: rows.length,
      matterIds: rows.slice(0, 50).map((r) => r.id),
      filters: { status: params.status ?? null, caseType: params.caseType ?? null },
      limit: params.limit,
      offset: params.offset,
    });
    return { matters: rows.map((r) => summarize(r, parties.get(r.id) ?? [])), total: Number(total) };
  });
}

export type ConnectorDocumentSummary = {
  id: string;
  fileName: string;
  type: string;
  mimeType: string | null;
  sizeBytes: number | null;
  pageCount: number | null;
  /** pending | clean | infected | error: only clean documents are ever read by skill runs or downloadable. */
  malwareScanStatus: string;
  textExtracted: boolean;
  uploadedAt: string;
};

export type ConnectorRunSummary = {
  id: string;
  skillName: string;
  skillVersion: number;
  status: string;
  escalationFlagCount: number;
  createdAt: string;
  completedAt: string | null;
};

function runSummary(row: {
  id: string;
  skillName: string;
  skillVersion: number;
  status: string;
  escalationFlags: unknown;
  createdAt: Date;
  completedAt: Date | null;
}): ConnectorRunSummary {
  return {
    id: row.id,
    skillName: row.skillName,
    skillVersion: row.skillVersion,
    status: row.status,
    escalationFlagCount: readEscalationFlags(row.escalationFlags).length,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** One matter with its documents list (no contents) and its most recent runs; null when it is not this firm's. */
export async function getMatterForConnector(
  ctx: ConnectorCallContext,
  matterId: string,
  params: { documentLimit: number; runLimit: number },
  inTenant: TenantTransactionRunner = withTenantContext
): Promise<{
  matter: ConnectorMatterSummary & { ntaDate: string | null; oneYearClockDate: string | null };
  documents: ConnectorDocumentSummary[];
  documentCount: number;
  recentRuns: ConnectorRunSummary[];
} | null> {
  const { tenantId } = ctx;
  return inTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(matters)
      .where(and(eq(matters.id, matterId), eq(matters.tenantId, tenantId)))
      .limit(1);
    if (!row) {
      await recordCall(tx, ctx, { matterId, outcome: "not_found" });
      return null;
    }
    const parties = await partiesByMatter(tx, tenantId, [row.id]);
    const docWhere = and(eq(documents.tenantId, tenantId), eq(documents.matterId, matterId));
    const [{ documentCount }] = await tx.select({ documentCount: count() }).from(documents).where(docWhere);
    const docs = await tx
      .select({
        id: documents.id,
        fileName: documents.fileName,
        type: documents.type,
        mimeType: documents.mimeType,
        sizeBytes: documents.sizeBytes,
        pageCount: documents.pageCount,
        malwareScanStatus: documents.malwareScanStatus,
        textExtracted: sql<boolean>`${documents.extractedText} is not null`,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(docWhere)
      .orderBy(desc(documents.createdAt))
      .limit(params.documentLimit);
    const runs = await tx
      .select({
        id: skillRuns.id,
        skillName: skillRuns.skillName,
        skillVersion: skillRuns.skillVersion,
        status: skillRuns.status,
        escalationFlags: skillRuns.escalationFlags,
        createdAt: skillRuns.createdAt,
        completedAt: skillRuns.completedAt,
      })
      .from(skillRuns)
      .where(and(eq(skillRuns.tenantId, tenantId), eq(skillRuns.matterId, matterId)))
      .orderBy(desc(skillRuns.createdAt))
      .limit(params.runLimit);
    await recordCall(tx, ctx, { matterId, outcome: "ok" });
    return {
      matter: {
        ...summarize(row, parties.get(row.id) ?? []),
        ntaDate: row.ntaDate,
        oneYearClockDate: row.oneYearClockDate,
      },
      documents: docs.map((d) => ({
        id: d.id,
        fileName: d.fileName,
        type: d.type,
        mimeType: d.mimeType,
        sizeBytes: d.sizeBytes,
        pageCount: d.pageCount,
        malwareScanStatus: d.malwareScanStatus,
        textExtracted: Boolean(d.textExtracted),
        uploadedAt: d.createdAt.toISOString(),
      })),
      documentCount: Number(documentCount),
      recentRuns: runs.map(runSummary),
    };
  });
}

/** The matter's case type, for the skill catalog; null when the matter is not this firm's. */
export async function getMatterCaseTypeForConnector(
  ctx: ConnectorCallContext,
  matterId: string,
  inTenant: TenantTransactionRunner = withTenantContext
): Promise<string | null> {
  const { tenantId } = ctx;
  return inTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ caseType: matters.caseType })
      .from(matters)
      .where(and(eq(matters.id, matterId), eq(matters.tenantId, tenantId)))
      .limit(1);
    await recordCall(tx, ctx, { matterId, outcome: row ? "ok" : "not_found" });
    return row?.caseType ?? null;
  });
}

export type ConnectorRunDetail = ConnectorRunSummary & {
  matterId: string;
  startedAt: string | null;
  /** The validated report (the skill's output schema); null until the run completes. */
  report: unknown;
  escalationFlags: string[];
  errorMessage: string | null;
  /** How many sources the run's verification log records (the log itself stays in the app). */
  verificationLogEntries: number;
};

/** One run of this firm's, with its report; null when it is not this firm's. */
export async function getSkillRunForConnector(
  ctx: ConnectorCallContext,
  runId: string,
  inTenant: TenantTransactionRunner = withTenantContext
): Promise<ConnectorRunDetail | null> {
  const { tenantId } = ctx;
  return inTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: skillRuns.id,
        matterId: skillRuns.matterId,
        skillName: skillRuns.skillName,
        skillVersion: skillRuns.skillVersion,
        status: skillRuns.status,
        structuredOutput: skillRuns.structuredOutput,
        escalationFlags: skillRuns.escalationFlags,
        errorMessage: skillRuns.errorMessage,
        verificationLogEntries: sql<number>`jsonb_array_length(case when jsonb_typeof(${skillRuns.verificationLog}) = 'array' then ${skillRuns.verificationLog} else '[]'::jsonb end)`,
        createdAt: skillRuns.createdAt,
        startedAt: skillRuns.startedAt,
        completedAt: skillRuns.completedAt,
      })
      .from(skillRuns)
      .where(and(eq(skillRuns.id, runId), eq(skillRuns.tenantId, tenantId)))
      .limit(1);
    if (!row) {
      await recordCall(tx, ctx, { skillRunId: runId, outcome: "not_found" });
      return null;
    }
    await recordCall(tx, ctx, { matterId: row.matterId, skillRunId: row.id, outcome: "ok" });
    return {
      ...runSummary(row),
      matterId: row.matterId,
      startedAt: row.startedAt?.toISOString() ?? null,
      report: row.status === "completed" ? row.structuredOutput : null,
      escalationFlags: readEscalationFlags(row.escalationFlags),
      errorMessage: row.errorMessage,
      verificationLogEntries: Number(row.verificationLogEntries),
    };
  });
}

/**
 * The firm's legal-update feed (the /updates page's list, at most 100 items).
 * The items are global and public; the firm's reviews of them are tenant
 * data. The call is recorded first, in its own transaction, then the list is
 * read the way the page reads it.
 */
export async function listLegalUpdatesForConnector(
  ctx: ConnectorCallContext,
  params: { view: LegalUpdateView; skill?: string | null }
) {
  await recordConnectorCallOutcome(ctx, "ok");
  return listLegalUpdatesForTenant(ctx.tenantId, { view: params.view, skill: params.skill ?? null });
}
