import "server-only";
import type { db } from "@/db/client";
import { auditLogs } from "@/db/schema";

/**
 * Every action the app writes to audit_logs. The values are stable
 * identifiers that queries over the log rely on: never rename one that has
 * shipped (earlier rows keep the old value), add a new one instead.
 */
export const AUDIT_ACTIONS = {
  /** A user started an upload: the documents row now exists and a presigned PUT URL was issued for it. */
  documentUploadInitiated: "document.upload_initiated",
  /** A presigned GET URL for a document was issued to a user. */
  documentDownloadUrlIssued: "document.download",
  /**
   * A download was refused because the file has not passed the malware scan:
   * after.reason is malware_scan_infected, malware_scan_pending (not scanned
   * yet) or malware_scan_error (could not be scanned).
   */
  documentDownloadBlocked: "document.download_blocked",
  /** A user asked for a skill run (including a Retry of a failed one); the run row is queued. */
  skillRunRequested: "skill_run.requested",
  /** The worker recorded a run's validated report. */
  skillRunCompleted: "skill_run.completed",
  /** A run was marked failed: by the worker, the stuck-run sweep, a worker shutdown, or a failed enqueue. */
  skillRunFailed: "skill_run.failed",
  /** A pending practice profile version was confirmed and became the active one. The value predates this list. */
  practiceProfileActivated: "practice_profile.confirm",
  /**
   * A user acknowledged that a practice profile version weakens an escalation rule (removes one, or turns off
   * always escalate) when proposing it (after.stage "propose") or confirming it (after.stage "confirm");
   * after.weakenings lists { decision, change }.
   */
  practiceProfileEscalationWeakeningAcknowledged: "practice_profile.escalation_weakening_acknowledged",
  /** The firm identity (letterhead details) was created or changed; after.changedFields names the fields. */
  firmIdentityUpdated: "firm_identity.update",
  /** A person was added to the firm's attorney/representative roster. */
  firmAttorneyAdded: "firm_attorney.create",
  /** A roster entry was changed (after.changedFields), including becoming or ceasing to be the default signer. */
  firmAttorneyUpdated: "firm_attorney.update",
  /** A roster entry was removed. */
  firmAttorneyRemoved: "firm_attorney.delete",
  /** A signature image was stored for a roster entry (replacing any earlier one). */
  firmSignatureUploaded: "firm_signature.upload",
  /** A roster entry's signature image was removed. */
  firmSignatureRemoved: "firm_signature.remove",
  /** A short-lived preview URL for a signature image was issued to a user. */
  firmSignaturePreviewIssued: "firm_signature.preview",
  /** A generator embedded a roster entry's signature image in a generated document (after.documentId). */
  firmSignatureApplied: "firm_signature.applied",
  /** A client record was created (no client details are logged: the row's id only). */
  clientCreated: "client.create",
  /** A matter was created (after.caseType). */
  matterCreated: "matter.create",
  /** A client was added to a matter as a party (after.matterId, after.clientId, after.role). */
  matterPartyAdded: "matter_party.create",
  /** A matter's details (status, venue, circuit, court, NTA date, one-year clock date, next hearing date) were changed on the matter page; after.changedFields names the fields, before.status / after.status give the status. */
  matterUpdated: "matter.update",
  /** A firm attorney or owner/admin marked a legal update reviewed (after.hasNote says whether a note was given; the note itself is never logged). */
  legalUpdateReviewed: "legal_update.review",
  /** An owner/admin asked for a check of every legal-update source now (after.queued is false when one was already queued or running). */
  legalUpdateCheckRequested: "legal_update.check_requested",
  /**
   * An owner/admin changed the firm's connector switches (case work on or off, document download links on or
   * off); before/after hold caseWorkEnabled, allowDocumentDownloads and the acknowledged disclosureVersion.
   */
  connectorSettingsUpdated: "connector_settings.update",
  /**
   * A case-work tool of the connector (src/services/connector/) was called from Claude or ChatGPT: resource_id is
   * the tool name; after holds the matterId (when the tool has one), the run or document id it touched, the OAuth
   * client id the call came through and the outcome code; list_matters adds the returned matterIds (at most 50),
   * its filters, limit and offset. Read calls are recorded too: they disclose client
   * data to a third party. Never the arguments' text or what the tool returned.
   */
  connectorToolCall: "connector.tool_call",
  /** The firm's free month started (with the tenant); after.trialEndsAt, after.creatorUserId. */
  billingTrialStarted: "billing.trial_started",
  /** A new firm got no free month: its creator had already used one (after.creatorUserId, after.earlierTenantId); the firm starts locked. */
  billingNoTrial: "billing.no_trial",
  /** An owner/admin was sent to Stripe Checkout to subscribe; after holds the seats and whether the first charge is deferred to the trial's end. */
  billingCheckoutStarted: "billing.checkout_started",
  /** An owner/admin opened the Stripe Customer Portal (cards, invoices, cancellation). */
  billingPortalOpened: "billing.portal_opened",
  /**
   * The Stripe webhook changed what the app knows of the subscription (resource_id is the subscription id); before/after
   * hold subscriptionStatus, seats, cancelAtPeriodEnd and currentPeriodEnd, after.event the Stripe event type.
   */
  billingSubscriptionUpdated: "billing.subscription_updated",
  /** Stripe reported a failed payment (after.invoiceId, after.graceEndsAt); the grace period began. */
  billingPaymentFailed: "billing.payment_failed",
  /** Stripe reported an invoice paid (resource_id is the invoice; after.amountCents, after.currency, after.periodStart, after.periodEnd, after.subscriptionId). */
  billingInvoicePaid: "billing.invoice_paid",
  /**
   * The app canceled a Stripe subscription itself (resource_id is the subscription): after.reason is
   * `superseded` (a newer live subscription replaced it; after.replacedBy) or `organization_deleted`.
   */
  billingSubscriptionCanceled: "billing.subscription_canceled",
  /** The firm became locked (after.reason: trial_ended, no_trial, subscription_canceled, subscription_unpaid, subscription_paused, grace_ended). */
  billingLocked: "billing.locked",
  /** A locked firm regained access (after.reason: the entitlement reason now). */
  billingUnlocked: "billing.unlocked",
  /** The operator set or cleared the firm's complimentary access (after.complimentary, after.operator) with npm run billing:comp. */
  billingComplimentarySet: "billing.complimentary_set",
  /** The firm's Clerk organization was deleted: the tenant is marked deleted (after.hadSubscription). */
  tenantDeleted: "tenant.deleted",
  /**
   * An owner/admin set a member's app role on the Firm page (resource_id is the membership row): before.role is the
   * role as it resolved for the member (null for a member with no row yet), after.role the new one, after.userId
   * the member's Clerk user id. Owner/admin is Clerk's Admin role and is never set here.
   */
  membershipRoleChanged: "membership.role_changed",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * actor_user_id for actions the app takes itself, as opposed to a signed-in
 * user's Clerk id (which always starts "user_", so these never collide).
 * For a skill run the user it ran for is in the entry's `after.requestedBy`.
 */
export const SYSTEM_ACTORS = {
  /** The worker recording a run's outcome (src/services/skill-runner/run.ts). */
  skillRunWorker: "system:skill-run-worker",
  /** enqueueSkillRun failing a run it could not put on the queue. */
  skillRunQueue: "system:skill-run-queue",
  /** The scheduled stuck-run sweep (src/services/skill-runner/stuck-runs.ts). */
  stuckRunSweeper: "system:stuck-run-sweeper",
  /** A worker shutting down (SIGTERM/SIGINT) with a run still in progress (src/worker.ts). */
  workerShutdown: "system:worker-shutdown",
  /** The Stripe webhook applying an event (src/lib/billing/stripe-webhook.ts). */
  stripeWebhook: "system:stripe-webhook",
  /** The daily billing job: locks, reminders, seat reconciliation (src/lib/billing/daily.ts). */
  billingDaily: "system:billing-daily",
  /** The Clerk org-sync webhook creating a tenant and starting its free month. */
  orgSync: "system:org-sync",
  /** The operator's command line (npm run billing:comp). */
  billingCli: "system:billing-cli",
} as const;

export type AuditResourceType =
  | "document"
  | "skill_run"
  | "practice_profile_version"
  | "firm_identity"
  | "firm_attorney"
  | "client"
  | "matter"
  | "matter_party"
  | "legal_update"
  | "legal_update_run"
  | "connector_settings"
  | "connector_tool"
  | "billing"
  | "tenant"
  | "membership";

export type AuditEvent = {
  tenantId: string;
  /** A Clerk user id, or one of SYSTEM_ACTORS. */
  actorUserId: string;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string;
  /**
   * State before and after the action. audit_logs is append-only (a trigger
   * refuses UPDATE and DELETE), so whatever goes in here stays for the life
   * of the tenant: record ids, statuses, counts and reason codes, never
   * client content (file names, case notes, extracted text, report text)
   * or raw error text (errors can quote S3 keys, which carry file names).
   */
  before?: unknown;
  after?: unknown;
};

/**
 * Appends one audit_logs row. Always called with the transaction of the
 * change it records (a withTenantContext transaction for event.tenantId),
 * so the change and its audit row commit or roll back together; RLS on
 * audit_logs refuses a row for any other tenant.
 */
export async function recordAuditEvent(tx: typeof db, event: AuditEvent): Promise<void> {
  await tx.insert(auditLogs).values({
    tenantId: event.tenantId,
    actorUserId: event.actorUserId,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    before: event.before ?? null,
    after: event.after ?? null,
  });
}
