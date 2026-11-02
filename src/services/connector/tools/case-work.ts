import { z } from "zod";
import { safeErrorMessage } from "@/lib/errors/safe-error";
import { MATTER_STATUSES } from "@/lib/matters/details";
import { matterPartyRoleEnum } from "@/db/schema";
import { newMatterInputSchema } from "@/lib/matters/details-schema";
import { caseTypeLabel, MATTER_CASE_TYPES } from "@/lib/matters/case-types";
import { EDITOR_ROLES } from "@/lib/roles";
import { MAX_ATTORNEY_NOTE_CHARS } from "@/lib/skill-runs/snapshot";
import { DOWNLOAD_URL_EXPIRES_SECONDS } from "@/lib/s3";
import type { ConnectorCallContext } from "@/lib/connector/case-work";
import { getSkillCatalog } from "@/services/skill-runner/skills/catalog";
import { getSkillModule, isSupportedSkillName } from "@/services/skill-runner/skills";
import { SkillRunRequestError } from "@/services/skill-runner/run";
import { capText, dataJson, frameData } from "../framing";
import { runSkillRules } from "../rate-limit";
import { REDACTED, redactIdentifiers } from "../redact";
import { defineConnectorTool, type ConnectorTool, type ConnectorToolContext } from "../types";
import { errorResult, textResult } from "./results";

// The case-work tools: the firm's matters, their documents lists, the skill
// catalog, skill runs and their reports, and the legal-update feed. Listed
// only while the firm's case-work switch is on (src/lib/connector/settings.ts),
// and only to OAuth clients on the platform's allow list (../server.ts), and
// per role as in the web app: every role may read; queuing a run and taking
// a download link need an editor role (EDITOR_ROLES), and the download link
// tool appears only when the firm also allows download links. Both of those
// re-check the caller with Clerk (no role cache) and need confirm: true.
//
// Every call writes a connector.tool_call audit entry: the reads in
// src/lib/connector/case-work.ts write it in their own transaction, run_skill
// in enqueueSkillRun's, the download link in getDocumentDownloadUrl's, and
// a call refused for its input here, through recordOutcome.
//
// What comes back is framed as the firm's data (../framing.ts): file names,
// party names and the reports skill runs wrote from client documents are
// text the app did not write.

const FIRM_SOURCE = "the firm's records in this app (client and case data; skill run reports are generated from client documents)";
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** Not read-only: the call creates something (a run) or lets a client document out of the app (a link). */
const ACTING = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const MATTER_STATUS_KEYS = MATTER_STATUSES.map(([key]) => key) as [string, ...string[]];
const DOCUMENT_LIST_LIMIT = 100;
const RECENT_RUNS = 10;
const REPORT_MAX_CHARS = 80_000;

const matterId = z.string().uuid().describe("The matter's id, from list_matters.");

function callContext(ctx: ConnectorToolContext, tool: string): ConnectorCallContext {
  return { tenantId: ctx.identity.tenantId, userId: ctx.identity.userId, oauthClientId: ctx.identity.oauthClientId, tool };
}

function firmData(lead: string, value: unknown, hint?: string) {
  return textResult(`${lead}\n${frameData(FIRM_SOURCE, dataJson(value), undefined, hint)}`);
}

const listClientsTool = defineConnectorTool({
  name: "list_clients",
  title: "List the firm's clients",
  description:
    "Lists this firm's client records by name and id only. It never returns A-numbers, dates of birth or contact details. Use a returned client id with add_matter_party to link a client to a matter. Every call is recorded in the firm's audit log.",
  group: "case_work",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).optional().describe("Clients per call (default 20)."),
    offset: z.number().int().min(0).max(10_000).optional().describe("Clients to skip for the next page."),
  }),
  annotations: READ_ONLY,
  async run(q, ctx) {
    const limit = q.limit ?? 20;
    const offset = q.offset ?? 0;
    const result = await ctx.deps.caseWork.listClients(callContext(ctx, "list_clients"), { limit, offset });
    const more = offset + result.clients.length < result.total ? ` More: call list_clients with offset ${offset + result.clients.length}.` : "";
    return firmData(`Clients ${result.clients.length ? `${offset + 1}-${offset + result.clients.length}` : "none"} of ${result.total}.${more}`, result.clients);
  },
});

const createClientTool = defineConnectorTool({
  name: "create_client",
  title: "Create a client",
  description:
    "Creates a client record for this firm. Only provide personal details the user has explicitly supplied and confirmed. Any values passed here are also part of the conversation with the connected AI provider. A-number, date of birth and contact details are optional. Requires confirm: true after the user reviews the exact details. Available to owner/admin, attorney and paralegal roles; audited.",
  group: "case_work",
  inputSchema: z.object({
    full_name: z.string().trim().min(1).max(200),
    a_number: z.string().trim().max(20).optional(),
    date_of_birth: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/).refine((v) => {
      const date = new Date(v + "T00:00:00.000Z");
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === v;
    }, "Enter a real date as YYYY-MM-DD.").optional(),
    country_of_birth: z.string().trim().max(100).optional(),
    primary_language: z.string().trim().max(100).optional(),
    contact_email: z.string().trim().email().max(254).optional(),
    contact_phone: z.string().trim().max(50).optional(),
    confirm: z.literal(true).describe("The user has confirmed these exact client details should be saved."),
  }),
  annotations: ACTING,
  availableTo: (ctx) => EDITOR_ROLES.includes(ctx.identity.role),
  freshIdentity: true,
  async run(q, ctx) {
    const call = callContext(ctx, "create_client");
    try {
      const created = await ctx.deps.caseWork.createClient(call, {
        fullName: q.full_name,
        aNumber: q.a_number,
        dateOfBirth: q.date_of_birth,
        countryOfBirth: q.country_of_birth,
        primaryLanguage: q.primary_language,
        contactEmail: q.contact_email,
        contactPhone: q.contact_phone,
      });
      return textResult(`Created client "${created.fullName}". client_id: ${created.id}. Use list_clients to find it later or add_matter_party to link it to a matter.`);
    } catch (err) {
      await ctx.deps.caseWork.recordOutcome(call, "failed");
      return errorResult(`The client could not be created (${safeErrorMessage(err)}).`);
    }
  },
});

const createMatterTool = defineConnectorTool({
  name: "create_matter",
  title: "Create an immigration matter",
  description:
    "Creates a matter using the same case-type and venue choices as the MeritDesk matter form. caseType must be one of: " + MATTER_CASE_TYPES.map(([key, label]) => key + " (" + label + ")").join("; ") + ". It does not automatically attach a client; use add_matter_party after creating or finding the client. Requires confirm: true after the user reviews the case type and dates. Available to owner/admin, attorney and paralegal roles; audited.",
  group: "case_work",
  inputSchema: newMatterInputSchema.extend({
    confirm: z.literal(true).describe("The user has confirmed this exact matter should be created."),
  }),
  annotations: ACTING,
  availableTo: (ctx) => EDITOR_ROLES.includes(ctx.identity.role),
  freshIdentity: true,
  async run(q, ctx) {
    const values = { caseType: q.caseType, venue: q.venue, circuit: q.circuit, court: q.court, ntaDate: q.ntaDate, oneYearClockDate: q.oneYearClockDate, nextHearingDate: q.nextHearingDate };
    const call = callContext(ctx, "create_matter");
    try {
      const created = await ctx.deps.caseWork.createMatter(call, values);
      return textResult(`Created matter ${created.id} (case type: ${caseTypeLabel(created.caseType)}). Use add_matter_party to link a client, get_matter to inspect it, and list_skills to see available legal skills.`);
    } catch (err) {
      await ctx.deps.caseWork.recordOutcome(call, "failed");
      return errorResult(`The matter could not be created (${safeErrorMessage(err)}).`);
    }
  },
});

const addMatterPartyTool = defineConnectorTool({
  name: "add_matter_party",
  title: "Link a client to a matter",
  description:
    "Links an existing client of this firm to an existing matter of this firm with a party role. Use list_clients and list_matters to obtain ids. Requires confirm: true after the user confirms the client, matter and role. Available to owner/admin, attorney and paralegal roles; audited.",
  group: "case_work",
  inputSchema: z.object({
    matter_id: z.string().uuid(),
    client_id: z.string().uuid(),
    role: z.enum(matterPartyRoleEnum.enumValues),
    confirm: z.literal(true).describe("The user has confirmed this client, matter and party role should be linked."),
  }),
  annotations: ACTING,
  availableTo: (ctx) => EDITOR_ROLES.includes(ctx.identity.role),
  freshIdentity: true,
  async run(q, ctx) {
    const call = callContext(ctx, "add_matter_party");
    try {
      const result = await ctx.deps.caseWork.addMatterParty(call, {
        matterId: q.matter_id,
        clientId: q.client_id,
        role: q.role,
      });
      return textResult(`Linked client ${q.client_id} to matter ${q.matter_id} as ${q.role}. Party id: ${result.id}.`);
    } catch (err) {
      await ctx.deps.caseWork.recordOutcome(call, "refused", { matterId: q.matter_id });
      return errorResult(`The client could not be linked to this matter (${safeErrorMessage(err)}).`);
    }
  },
});

const listMattersTool = defineConnectorTool({
  name: "list_matters",
  title: "List the firm's matters",
  description:
    "The firm's matters in this app, newest first: each matter's id, case type, status, venue, court, circuit, next hearing date and its parties (name and role). Filters by status and case type; up to 50 per call with an offset for more. Reading this sends client names to the conversation, and each call is recorded in the firm's audit log.",
  group: "case_work",
  inputSchema: z.object({
    status: z.enum(MATTER_STATUS_KEYS).optional().describe("Only matters with this status."),
    case_type: z.string().trim().max(60).optional().describe("Only matters of this case type key, e.g. asylum_defensive, i130, vawa."),
    limit: z.number().int().min(1).max(50).optional().describe("Matters per call (default 20)."),
    offset: z.number().int().min(0).max(10_000).optional().describe("Matters to skip, for the next page."),
  }),
  annotations: READ_ONLY,
  async run(q, ctx) {
    const limit = q.limit ?? 20;
    const offset = q.offset ?? 0;
    const { matters, total } = await ctx.deps.caseWork.listMatters(callContext(ctx, "list_matters"), {
      status: q.status ?? null,
      caseType: q.case_type ?? null,
      limit,
      offset,
    });
    const more = offset + matters.length < total ? ` More: list_matters with offset ${offset + matters.length}.` : "";
    return firmData(`Matters ${matters.length ? `${offset + 1}-${offset + matters.length}` : "none"} of ${total}.${more}`, matters);
  },
});

const getMatterTool = defineConnectorTool({
  name: "get_matter",
  title: "Get a matter",
  description:
    "One matter's details (case type, status, venue, court, circuit, NTA, one-year clock and next hearing dates, parties), its documents list (name, type, size, pages, malware scan status, whether text was extracted; never the file contents) and its 10 most recent skill runs with their status. Each call is recorded in the firm's audit log.",
  group: "case_work",
  inputSchema: z.object({ matter_id: matterId }),
  annotations: READ_ONLY,
  async run({ matter_id }, ctx) {
    const found = await ctx.deps.caseWork.getMatter(callContext(ctx, "get_matter"), matter_id, {
      documentLimit: DOCUMENT_LIST_LIMIT,
      runLimit: RECENT_RUNS,
    });
    if (!found) return errorResult(`No matter of this firm has the id ${matter_id}. list_matters gives the ids.`);
    const note =
      found.documentCount > found.documents.length
        ? ` Showing the newest ${found.documents.length} of ${found.documentCount} documents.`
        : "";
    return firmData(
      `Matter ${matter_id}.${note} Only documents whose malware scan is "clean" are ever read by skill runs. Skill run reports: get_skill_run.`,
      found
    );
  },
});

const listSkillsTool = defineConnectorTool({
  name: "list_skills",
  title: "List skills for a matter",
  description:
    "The firm skills this app can run on a matter: each skill's name, label, category, kind (review, build or research), description, whether it takes a case note and what the note should contain, and whether it is built for the matter's case type (those come first). Each call is recorded in the firm's audit log.",
  group: "case_work",
  inputSchema: z.object({ matter_id: matterId }),
  annotations: READ_ONLY,
  async run({ matter_id }, ctx) {
    const caseType = await ctx.deps.caseWork.getMatterCaseType(callContext(ctx, "list_skills"), matter_id);
    if (caseType === null) return errorResult(`No matter of this firm has the id ${matter_id}. list_matters gives the ids.`);
    const skills = getSkillCatalog()
      .map((s) => ({
        name: s.name,
        label: s.runTitle,
        category: s.category,
        kind: s.kind,
        builtForThisCaseType: s.applicableCaseTypes === null || s.applicableCaseTypes.some((t) => t === caseType),
        description: s.description,
        takesCaseNote: s.needsNote,
        caseNoteShouldContain: s.noteHelp,
        similarSkills: s.similarSkills,
      }))
      .sort((a, b) => Number(b.builtForThisCaseType) - Number(a.builtForThisCaseType));
    const canRun = EDITOR_ROLES.includes(ctx.identity.role);
    return textResult(
      `Skills for this ${caseTypeLabel(caseType)} matter (${skills.length}). ${
        canRun
          ? "run_skill queues one; it runs in the background and is billed to the firm."
          : "Your role in the firm cannot queue skill runs."
      }\n${dataJson(skills)}`
    );
  },
});

const runSkillTool = defineConnectorTool({
  name: "run_skill",
  title: "Queue a skill run",
  description:
    "Queues a run of one firm skill on a matter, the same as the Run button on the matter page: it reads the matter's clean documents, the firm's practice profile and identity, runs in the background (minutes, longer for drafting and research skills), costs the firm model usage, and may add generated documents to the matter. " +
    "Requires confirm set to true, given only after the user has agreed to this specific run. Returns the run id; get_skill_run reports its status and, when done, its report. Available to owner/admin, attorney and paralegal roles. Recorded in the firm's audit log.",
  group: "case_work",
  inputSchema: z.object({
    matter_id: matterId,
    skill_name: z.string().trim().min(1).max(80).describe("The skill's name, from list_skills."),
    attorney_note: z
      .string()
      .max(MAX_ATTORNEY_NOTE_CHARS)
      .optional()
      .describe("The case note for skills that take one (list_skills says what it should contain). Ignored by skills that take none."),
    confirm: z.literal(true).describe("true: the user has confirmed this run on this matter."),
  }),
  annotations: ACTING,
  availableTo: (ctx) => EDITOR_ROLES.includes(ctx.identity.role),
  freshIdentity: true,
  extraRateRules: (identity) => runSkillRules(identity.userId),
  async run(q, ctx) {
    const call = callContext(ctx, "run_skill");
    if (!isSupportedSkillName(q.skill_name)) {
      await ctx.deps.caseWork.recordOutcome(call, "unknown_skill", { matterId: q.matter_id });
      return errorResult(`Unknown skill "${q.skill_name}". list_skills gives the names.`);
    }
    const note = getSkillModule(q.skill_name).needsNote ? q.attorney_note?.trim() || undefined : undefined;
    let runId: string;
    try {
      runId = await ctx.deps.caseWork.enqueueSkillRun({
        tenantId: ctx.identity.tenantId,
        matterId: q.matter_id,
        skillName: q.skill_name,
        requestedBy: ctx.identity.userId,
        requesterRole: ctx.identity.role,
        attorneyNote: note,
        connectorCall: { tool: "run_skill", oauthClientId: ctx.identity.oauthClientId },
      });
    } catch (err) {
      if (err instanceof Error && err.message === "Matter not found") {
        await ctx.deps.caseWork.recordOutcome(call, "not_found", { matterId: q.matter_id });
        return errorResult(`No matter of this firm has the id ${q.matter_id}. list_matters gives the ids.`);
      }
      if (err instanceof SkillRunRequestError) {
        await ctx.deps.caseWork.recordOutcome(call, "refused", { matterId: q.matter_id });
        return errorResult(err.message);
      }
      // The run row may exist and be marked failed (an enqueue failure); its audit entries were written with it.
      return errorResult(`The run could not be queued (${safeErrorMessage(err)}). The matter page shows any run that was created.`);
    }
    return textResult(
      `Queued run ${runId} of ${q.skill_name} on matter ${q.matter_id}${note ? " with the case note" : ""}. It runs in the background; get_skill_run with this run_id reports its status and, once completed, its report.`
    );
  },
});

const getSkillRunTool = defineConnectorTool({
  name: "get_skill_run",
  title: "Get a skill run",
  description:
    `One skill run's status (queued, running, completed, failed), timing, escalation flags, error message if it failed, and, once completed, its structured report as the matter page shows it (cut at 80,000 characters), with A-numbers and dates of birth replaced by "${REDACTED}". The report still names the client and holds the case's facts and other dates. Each call is recorded in the firm's audit log.`,
  group: "case_work",
  inputSchema: z.object({ run_id: z.string().uuid().describe("The run's id, from run_skill or get_matter.") }),
  annotations: READ_ONLY,
  async run({ run_id }, ctx) {
    const found = await ctx.deps.caseWork.getSkillRun(callContext(ctx, "get_skill_run"), run_id);
    if (!found) return errorResult(`No skill run of this firm has the id ${run_id}.`);
    const run = redactIdentifiers(found);
    const { report, ...rest } = run;
    const reportText = report === null ? null : capText(dataJson(report), REPORT_MAX_CHARS, "The full report is on the matter page.").text;
    const lead =
      run.status === "completed"
        ? `Run ${run_id} completed. The report is the skill's draft work product for attorney review; A-numbers and dates of birth in it are replaced by "${REDACTED}" (the matter page has them).`
        : run.status === "failed"
          ? `Run ${run_id} failed; errorMessage says why. A failed run can be retried from the matter page.`
          : `Run ${run_id} is ${run.status}; get_skill_run again later for its report.`;
    return textResult(`${lead}\n${frameData(FIRM_SOURCE, dataJson({ ...rest, report: reportText === null ? null : "(below)" }) + (reportText ? `\n\nReport:\n${reportText}` : ""))}`);
  },
});

const listLegalUpdatesTool = defineConnectorTool({
  name: "list_legal_updates",
  title: "List legal updates",
  description:
    "The firm's legal-update feed as on the Updates page: new precedents, policy memoranda, Federal Register items and court opinions the app's monitor found, each with its official URL, date, summary, the skills it affects, and whether someone at the firm marked it reviewed (review notes are not included). Unreviewed items of the last 90 days by default. Each call is recorded in the firm's audit log.",
  group: "case_work",
  inputSchema: z.object({
    view: z.enum(["unreviewed", "all"]).optional().describe("unreviewed (default): not yet marked reviewed, last 90 days. all: everything recent."),
    skill: z.string().trim().max(80).optional().describe("Only items that affect this skill (a name from list_skills)."),
    limit: z.number().int().min(1).max(50).optional().describe("Items to return (default 20)."),
  }),
  annotations: READ_ONLY,
  async run(q, ctx) {
    const items = await ctx.deps.caseWork.listLegalUpdates(callContext(ctx, "list_legal_updates"), {
      view: q.view ?? "unreviewed",
      skill: q.skill ?? null,
    });
    const limit = q.limit ?? 20;
    const shown = items.slice(0, limit).map((item) => ({
      id: item.id,
      title: item.title,
      source: item.sourceLabel,
      itemType: item.itemType,
      citation: item.citation,
      officialUrl: item.officialUrl,
      publishedDate: item.publishedDateText,
      retrievedAt: item.retrievedAt.toISOString(),
      status: item.status,
      summary: item.aiSummary ? item.aiSummary.slice(0, 2_000) : null,
      listingExcerpt: item.aiSummary ? null : item.rawExcerpt.slice(0, 1_000),
      courtWeight: item.courtWeight,
      affectedSkills: item.affectedSkills,
      reviewed: item.review !== null,
      reviewedAt: item.review?.reviewedAt.toISOString() ?? null,
    }));
    return textResult(
      `${shown.length} of ${items.length} legal update(s). Cite each by its officialUrl; a summary was written by the app's monitor from the official text.\n${frameData(
        "the app's legal-update monitor (official sources, summarized by the app)",
        dataJson(shown)
      )}`
    );
  },
});

const documentDownloadLinkTool = defineConnectorTool({
  name: "get_document_download_link",
  title: "Get a document download link",
  description:
    `A link to download one of a matter's documents, valid for ${Math.round(DOWNLOAD_URL_EXPIRES_SECONDS / 60)} minutes, only for a document whose malware scan came back clean (other documents are refused). Anyone who has the link can open the file until it expires. Requires confirm set to true, given only after the user has agreed to take this document's link. Offered only when the firm allows download links, to owner/admin, attorney and paralegal roles. Each link issued, and each refusal, is recorded in the firm's audit log.`,
  group: "case_work",
  inputSchema: z.object({
    matter_id: matterId,
    document_id: z.string().uuid().describe("The document's id, from get_matter."),
    confirm: z.literal(true).describe("true: the user has confirmed they want a download link for this document."),
  }),
  annotations: ACTING,
  availableTo: (ctx) => ctx.settings.allowDocumentDownloads && EDITOR_ROLES.includes(ctx.identity.role),
  freshIdentity: true,
  async run(q, ctx) {
    try {
      const url = await ctx.deps.caseWork.documentDownloadUrl(ctx.identity.tenantId, q.document_id, ctx.identity.userId, {
        matterId: q.matter_id,
        connectorCall: { tool: "get_document_download_link", oauthClientId: ctx.identity.oauthClientId },
      });
      return textResult(`Download link (expires in ${Math.round(DOWNLOAD_URL_EXPIRES_SECONDS / 60)} minutes; it gives the file to whoever opens it):\n${url}`);
    } catch (err) {
      if (err instanceof Error && err.message === "Document not found") {
        await ctx.deps.caseWork.recordOutcome(callContext(ctx, "get_document_download_link"), "not_found", {
          matterId: q.matter_id,
          documentId: q.document_id,
        });
        return errorResult("No document with that id belongs to that matter of this firm.");
      }
      // The refusals for unscanned, infected or unscannable files say why (their audit rows are written).
      if (err instanceof Error && /^Download (blocked|not available)/.test(err.message)) return errorResult(err.message);
      return errorResult(`The link could not be issued (${safeErrorMessage(err)}).`);
    }
  },
});

export const CASE_WORK_TOOLS: readonly ConnectorTool[] = [
  listClientsTool,
  createClientTool,
  createMatterTool,
  addMatterPartyTool,
  listMattersTool,
  getMatterTool,
  listSkillsTool,
  runSkillTool,
  getSkillRunTool,
  listLegalUpdatesTool,
  documentDownloadLinkTool,
];
