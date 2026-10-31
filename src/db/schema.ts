import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  doublePrecision,
  boolean,
  date,
  uniqueIndex,
  index,
  primaryKey,
  customType,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const membershipRoleEnum = pgEnum("membership_role", [
  "owner_admin",
  "attorney",
  "paralegal",
  "read_only",
]);

export const practiceProfileStatusEnum = pgEnum("practice_profile_status", [
  "draft",
  "pending_confirmation",
  "active",
  "superseded",
]);

export const matterPartyRoleEnum = pgEnum("matter_party_role", [
  "petitioner",
  "beneficiary",
  "respondent",
  "derivative",
  "witness",
]);

export const documentTypeEnum = pgEnum("document_type", [
  "uploaded_evidence",
  "generated_draft",
  "final_docx",
  "receipt_notice",
  "other",
]);

export const skillRolloutStatusEnum = pgEnum("skill_rollout_status", [
  "draft",
  "canary",
  "ga",
  "deprecated",
]);

export const skillRunStatusEnum = pgEnum("skill_run_status", [
  "queued",
  "running",
  "needs_input",
  "completed",
  "failed",
]);

export const firmAttorneyRoleEnum = pgEnum("firm_attorney_role", ["attorney", "accredited_representative"]);

// ---------------------------------------------------------------------------
// Tenant / Membership
// ---------------------------------------------------------------------------

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  clerkOrgId: text("clerk_org_id").notNull(),
  subscriptionTier: text("subscription_tier").notNull().default("standard"),
  // The Clerk user who created the organization (the create-firm action's
  // caller, or organization.created's created_by); null for firms made in
  // the Clerk dashboard. The free month is granted once per creator
  // (user_trials below), so a second firm by the same person starts locked.
  createdByUserId: text("created_by_user_id"),
  // Set when the Clerk organization was deleted (organization.deleted): the
  // firm is unreachable from then on (getCurrentTenant, the connector, the
  // daily job all skip it) and its Stripe subscription was canceled. The
  // rows stay (a soft delete) so the audit log, the billing history and the
  // creator's used free month survive; nothing restores a deleted firm but
  // the operator, by hand.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugIdx: uniqueIndex("tenants_slug_idx").on(t.slug),
  clerkOrgIdx: uniqueIndex("tenants_clerk_org_idx").on(t.clerkOrgId),
}));

export const memberships = pgTable("memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(), // Clerk user id
  // The app role (src/lib/roles.ts). owner_admin mirrors Clerk's Admin role
  // and is written by the org sync; attorney, paralegal and read_only are
  // set by an owner/admin on the Firm page, and a new member starts as
  // read_only (migration 0016). A stored owner_admin counts only while
  // Clerk's live role is Admin (resolveAppRole).
  role: membershipRoleEnum("role").notNull().default("read_only"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantUserIdx: uniqueIndex("memberships_tenant_user_idx").on(t.tenantId, t.userId),
  tenantIdx: index("memberships_tenant_idx").on(t.tenantId),
}));

// ---------------------------------------------------------------------------
// Practice Profile (versioned) — the app-side equivalent of PRACTICE_PROFILE.md
// ---------------------------------------------------------------------------

export const practiceProfileVersions = pgTable("practice_profile_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  status: practiceProfileStatusEnum("status").notNull().default("draft"),
  // Structured config: risk posture per case type, evidence/element standards,
  // house style, escalation rules, template pointers.
  profileJson: jsonb("profile_json").notNull(),
  // Rendered Markdown injected verbatim into skill system prompts.
  renderedMarkdown: text("rendered_markdown"),
  diffFromPrevious: jsonb("diff_from_previous"),
  proposedBy: text("proposed_by"), // Clerk user id
  confirmedBy: text("confirmed_by"), // Clerk user id
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("practice_profile_versions_tenant_idx").on(t.tenantId),
  tenantVersionIdx: uniqueIndex("practice_profile_versions_tenant_version_idx").on(
    t.tenantId,
    t.versionNumber
  ),
  // At most one active version per tenant (0006_rls_tenant_setting.sql).
  // confirmVersion also serializes on the tenant's profile lock
  // (src/lib/practice-profile/service.ts); this holds even if a path skips it.
  oneActiveIdx: uniqueIndex("practice_profile_versions_one_active_idx")
    .on(t.tenantId)
    .where(sql`"status" = 'active'`),
}));

// ---------------------------------------------------------------------------
// Firm identity: the letterhead and the attorney/representative roster that
// skill runs and document generators use in place of the firm the skills
// were written for (src/lib/firm-identity/service.ts). Kept out of the
// practice profile on purpose: roster rows need stable ids (a generator
// names its signer by id, a signature belongs to one row), signature
// storage keys must never reach a rendered prompt, and contact details
// change on their own schedule, without the profile's propose/confirm cycle.
// ---------------------------------------------------------------------------

export const firmIdentities = pgTable("firm_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  legalName: text("legal_name").notNull(),
  // Street, suite, city/state/ZIP, one entry per letterhead line.
  addressLines: jsonb("address_lines").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  phone: text("phone"),
  fax: text("fax"),
  email: text("email"),
  website: text("website"),
  // Optional line some letterheads print under the address (e.g. where the
  // firm's attorneys are licensed), exactly as the firm prints it.
  licensureLine: text("licensure_line"),
  updatedBy: text("updated_by").notNull(), // Clerk user id
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // One identity per tenant.
  tenantIdx: uniqueIndex("firm_identities_tenant_idx").on(t.tenantId),
}));

export const firmAttorneys = pgTable("firm_attorneys", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  title: text("title"),
  role: firmAttorneyRoleEnum("role").notNull().default("attorney"),
  barState: text("bar_state"),
  barNumber: text("bar_number"),
  eoirId: text("eoir_id"),
  email: text("email"),
  isDefaultSigner: boolean("is_default_signer").notNull().default(false),
  // The signature image (PNG or JPEG), stored by the server under
  // tenants/<tenant>/firm-signatures/ after image-only validation and
  // re-serialization (src/lib/firm-identity/signature-image.ts). Never
  // served to the browser except as a short-lived preview URL for
  // owner_admin/attorney users; generators read it with getSignerSignature.
  // All null when no signature is on file.
  signatureS3Bucket: text("signature_s3_bucket"),
  signatureS3Key: text("signature_s3_key"),
  signatureS3VersionId: text("signature_s3_version_id"),
  signatureMediaType: text("signature_media_type"), // image/png | image/jpeg
  signatureSizeBytes: integer("signature_size_bytes"),
  // sha256 (hex) of the stored bytes; every read is checked against it.
  signatureSha256: text("signature_sha256"),
  signatureWidthPx: integer("signature_width_px"),
  signatureHeightPx: integer("signature_height_px"),
  signatureUploadedBy: text("signature_uploaded_by"), // Clerk user id
  signatureUploadedAt: timestamp("signature_uploaded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("firm_attorneys_tenant_idx").on(t.tenantId),
  // At most one default signer per tenant.
  oneDefaultSignerIdx: uniqueIndex("firm_attorneys_one_default_signer_idx")
    .on(t.tenantId)
    .where(sql`"is_default_signer" = true`),
}));

// ---------------------------------------------------------------------------
// Client / Matter / MatterParty
// ---------------------------------------------------------------------------

export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  aNumber: text("a_number"),
  dateOfBirth: text("date_of_birth"), // stored as ISO date string; no time zone semantics needed
  countryOfBirth: text("country_of_birth"),
  primaryLanguage: text("primary_language"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("clients_tenant_idx").on(t.tenantId),
}));

export const matters = pgTable("matters", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  caseType: text("case_type").notNull(), // one of MATTER_CASE_TYPES in src/lib/matters/case-types.ts (older rows may hold free text)
  status: text("status").notNull().default("open"), // one of MATTER_STATUSES in src/lib/matters/details.ts
  venue: text("venue"), // one of MATTER_VENUES in src/lib/matters/details.ts (older rows may hold free text)
  circuit: text("circuit"),
  court: text("court"),
  ntaDate: text("nta_date"),
  oneYearClockDate: text("one_year_clock_date"),
  nextHearingDate: text("next_hearing_date"),
  assignedAttorneyUserId: text("assigned_attorney_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("matters_tenant_idx").on(t.tenantId),
}));

export const matterParties = pgTable("matter_parties", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  matterId: uuid("matter_id").notNull().references(() => matters.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  role: matterPartyRoleEnum("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("matter_parties_tenant_idx").on(t.tenantId),
  matterIdx: index("matter_parties_matter_idx").on(t.matterId),
  matterClientRoleIdx: uniqueIndex("matter_parties_matter_client_role_idx").on(
    t.matterId,
    t.clientId,
    t.role
  ),
}));

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  matterId: uuid("matter_id").notNull().references(() => matters.id, { onDelete: "cascade" }),
  type: documentTypeEnum("type").notNull(),
  fileName: text("file_name").notNull(),
  s3Key: text("s3_key").notNull(),
  s3Bucket: text("s3_bucket").notNull(),
  // The S3 object version every read of this document uses: for an upload,
  // the version the malware scan read (set with the "clean" result), so bytes
  // PUT to the key afterwards through a still-valid upload URL are never
  // downloaded or given to a skill run; for a generated document, the
  // version the app wrote. Null without bucket versioning, and for rows
  // scanned before this column existed (those read the key's current object).
  s3VersionId: text("s3_version_id"),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  version: integer("version").notNull().default(1),
  // Written by the document-ingest job (src/services/ingest/ingest.ts): pdftotext
  // for PDFs, python-docx for .docx, a plain decode for text files. Capped in size.
  extractedText: text("extracted_text"),
  sensitivityTag: text("sensitivity_tag"), // e.g. "medical", "criminal", "minor", null
  malwareScanStatus: text("malware_scan_status").notNull().default("pending"), // pending|clean|infected|error
  // PDF page count from pdfinfo, set by the ingest job; the skill runner uses
  // it to stay under the API's per-request page limit.
  pageCount: integer("page_count"),
  // Plain-language outcome detail from the ingest job: the virus signature
  // when infected, or why scanning or text extraction did not happen. Null
  // when everything succeeded.
  ingestionNote: text("ingestion_note"),
  // When the ingest job was last queued for this document. The matter page
  // treats a pending document as stalled a few minutes after this (or after
  // created_at, if it was never queued) and offers to queue it again.
  ingestQueuedAt: timestamp("ingest_queued_at", { withTimezone: true }),
  // When the ingest job last finished with this document (any outcome). Null
  // while it has never run, which is how the UI tells "queued" from "done".
  ingestedAt: timestamp("ingested_at", { withTimezone: true }),
  uploadedBy: text("uploaded_by").notNull(), // Clerk user id
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("documents_tenant_idx").on(t.tenantId),
  matterIdx: index("documents_matter_idx").on(t.matterId),
}));

// ---------------------------------------------------------------------------
// SkillDefinition / SkillRun
// ---------------------------------------------------------------------------

export const skillDefinitions = pgTable("skill_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(), // e.g. "claim-evaluation", "packet-review"
  version: integer("version").notNull(),
  contentHash: text("content_hash").notNull(),
  skillMarkdown: text("skill_markdown").notNull(),
  // The references/*.md files this version inlines into the system prompt
  // ([{ path, content }], sorted by path), stored by the seed alongside
  // skill_markdown so a run sends exactly the content content_hash covers,
  // whatever the worker image has on disk. Null for versions seeded before
  // this column existed; runs of those read the files from disk and check
  // them against content_hash (src/services/skill-runner/run.ts).
  referenceFiles: jsonb("reference_files"),
  outputJsonSchema: jsonb("output_json_schema").notNull(),
  requiredTools: jsonb("required_tools").notNull().default(sql`'[]'::jsonb`),
  rolloutStatus: skillRolloutStatusEnum("rollout_status").notNull().default("draft"),
  canaryPercentage: integer("canary_percentage").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nameVersionIdx: uniqueIndex("skill_definitions_name_version_idx").on(t.name, t.version),
}));

export const skillRuns = pgTable("skill_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  matterId: uuid("matter_id").notNull().references(() => matters.id, { onDelete: "cascade" }),
  skillDefinitionId: uuid("skill_definition_id").notNull().references(() => skillDefinitions.id),
  skillName: text("skill_name").notNull(),
  skillVersion: integer("skill_version").notNull(),
  status: skillRunStatusEnum("status").notNull().default("queued"),
  // Which PracticeProfileVersion + which document versions fed this run, for reproducibility.
  inputSnapshot: jsonb("input_snapshot").notNull(),
  structuredOutput: jsonb("structured_output"),
  verificationLog: jsonb("verification_log").notNull().default(sql`'[]'::jsonb`),
  escalationFlags: jsonb("escalation_flags").notNull().default(sql`'[]'::jsonb`),
  transcriptS3Key: text("transcript_s3_key"),
  errorMessage: text("error_message"),
  requestedBy: text("requested_by").notNull(), // Clerk user id
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("skill_runs_tenant_idx").on(t.tenantId),
  matterIdx: index("skill_runs_matter_idx").on(t.matterId),
}));

// ---------------------------------------------------------------------------
// AuditLog (append-only)
// ---------------------------------------------------------------------------

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id"),
  // One of AUDIT_ACTIONS in src/lib/audit/service.ts (e.g. "document.download",
  // "skill_run.requested"); written only through recordAuditEvent.
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("audit_logs_tenant_idx").on(t.tenantId),
  createdAtIdx: index("audit_logs_created_at_idx").on(t.createdAt),
}));

// ---------------------------------------------------------------------------
// Connector (src/services/connector/, docs/CONNECTORS.md): the remote MCP
// server at /api/mcp that Claude and ChatGPT connect to. Both tables are
// tenant data under the usual tenant_isolation policy
// (src/db/migrations/0012_connector.sql).
// ---------------------------------------------------------------------------

/**
 * A firm's connector switches (one row per tenant; no row means both off).
 * The library tools need no switch. The case-work tools (matters, documents
 * lists, skill runs, legal updates) are listed only while case_work_enabled
 * is on AND disclosure_version is the current CONNECTOR_DISCLOSURE_VERSION
 * (src/lib/connector/disclosure.ts): a new disclosure turns them off until an
 * owner/admin acknowledges it again.
 */
export const tenantConnectorSettings = pgTable("tenant_connector_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  caseWorkEnabled: boolean("case_work_enabled").notNull().default(false),
  // The disclosure version the owner/admin acknowledged when turning case work on.
  disclosureVersion: text("disclosure_version"),
  disclosureAcknowledgedBy: text("disclosure_acknowledged_by"), // Clerk user id
  disclosureAcknowledgedAt: timestamp("disclosure_acknowledged_at", { withTimezone: true }),
  // Clean documents may get a short-lived download link through the connector. Off by default.
  allowDocumentDownloads: boolean("allow_document_downloads").notNull().default(false),
  updatedBy: text("updated_by").notNull(), // Clerk user id
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: uniqueIndex("tenant_connector_settings_tenant_idx").on(t.tenantId),
}));

/**
 * Token buckets for the connector's rate limits (src/services/connector/rate-limit.ts):
 * one row per tenant and bucket ("tenant", "user:<id>", "run:user:<id>", ...).
 * Refilled lazily by the statement that takes a token, so the row only
 * changes when a call is made.
 */
export const connectorRateBuckets = pgTable("connector_rate_buckets", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  bucketKey: text("bucket_key").notNull(),
  tokens: doublePrecision("tokens").notNull(),
  refilledAt: timestamp("refilled_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.tenantId, t.bucketKey] }),
}));

/**
 * OAuth client ids a firm's members connected the connector from that are
 * not on the platform's allow list (CONNECTOR_ALLOWED_CLIENT_IDS and
 * CONNECTOR_ALLOWED_CLIENT_ID_PREFIXES, src/services/connector/config.ts),
 * so they got the library tools only. The Firm page shows them to the
 * owner/admin, who passes the real Claude and ChatGPT ones to the
 * platform's operator (src/lib/connector/unrecognized-clients.ts). Never a
 * token, only the client id. Migration 0013.
 */
export const connectorUnrecognizedClients = pgTable("connector_unrecognized_clients", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  seenCount: integer("seen_count").notNull().default(1),
  lastUserId: text("last_user_id").notNull(), // Clerk user id of the member who last connected through it
}, (t) => ({
  pk: primaryKey({ columns: [t.tenantId, t.clientId] }),
  lastSeenIdx: index("connector_unrecognized_clients_last_seen_idx").on(t.tenantId, t.lastSeenAt),
}));

// ---------------------------------------------------------------------------
// Billing (src/lib/billing/, README "Trial, billing and emails"): every firm
// gets a free month, then pays per member through Stripe. The free month is
// kept here, not in Stripe; Stripe holds the subscription, and the webhook
// (src/app/api/webhooks/stripe/route.ts) copies what the app needs into
// tenant_billing. Migration 0014.
// ---------------------------------------------------------------------------

/**
 * One row per tenant (created with the tenant, backfilled for earlier
 * tenants by the migration). getEntitlement (src/lib/billing/entitlement.ts)
 * derives the firm's state from it: an active or trialing Stripe
 * subscription wins; otherwise the free month until trial_ends_at; a failed
 * payment gets a grace period from past_due_since; anything else is locked.
 */
export const tenantBilling = pgTable("tenant_billing", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  // The free month ends here (tenant creation plus TRIAL_DAYS). Null when the
  // firm got none: its creator had already used a free month with another
  // firm (user_trials), so the firm starts locked and Subscribe charges now.
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  // The operator's own firm: entitled without a subscription and sent no
  // billing emails. Set only by npm run billing:comp (src/lib/billing/cli/complimentary.ts).
  complimentary: boolean("complimentary").notNull().default(false),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  // The subscription's one item, whose quantity is the seat count (updated without a retrieve).
  stripeSubscriptionItemId: text("stripe_subscription_item_id"),
  // Stripe's `created` of the stored subscription: an event for a different,
  // older subscription is ignored, whatever order the events arrive in.
  subscriptionCreatedAt: timestamp("subscription_created_at", { withTimezone: true }),
  // The Checkout Session last opened for the firm and not yet completed: it
  // is expired in Stripe before a new one is created, so one firm can never
  // have two open Checkout pages that both end in a subscription.
  checkoutSessionId: text("checkout_session_id"),
  // Stripe's subscription status as last reported: trialing, active, past_due, canceled, unpaid, ...; null before any subscription.
  subscriptionStatus: text("subscription_status"),
  // Seats billed: the firm's member count, kept in step by the Clerk webhook and the daily job.
  seats: integer("seats").notNull().default(1),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  // When a payment last failed and was not made good since: the grace period (PAST_DUE_GRACE_DAYS) runs from here.
  pastDueSince: timestamp("past_due_since", { withTimezone: true }),
  // When the app recorded the firm as locked (trial ended without a subscription, or the subscription ended); null while not locked.
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  customerIdx: uniqueIndex("tenant_billing_customer_idx").on(t.stripeCustomerId),
  subscriptionIdx: uniqueIndex("tenant_billing_subscription_idx").on(t.stripeSubscriptionId),
}));

/**
 * Every email the app sent a firm (src/lib/email/): one row per tenant, kind
 * and dedupe key, which is what makes each reminder go out once (a trial
 * reminder is keyed by the trial end it announces, a receipt by its invoice).
 * Recipients' addresses are read from Clerk when sending and never stored;
 * only how many there were.
 */
export const emailSends = pgTable("email_sends", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // an EmailKind (src/lib/email/templates.ts)
  dedupeKey: text("dedupe_key").notNull().default(""),
  recipientCount: integer("recipient_count").notNull().default(0),
  providerMessageId: text("provider_message_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantKindKeyIdx: uniqueIndex("email_sends_tenant_kind_key_idx").on(t.tenantId, t.kind, t.dedupeKey),
}));

/**
 * Stripe event ids the webhook has taken, so a redelivered event is answered
 * without being applied twice. Global (not tenant data): written only in
 * service context by the webhook, which is the one reader too. received_at
 * is when the id was claimed (again, for a reclaim) and applied_at when the
 * event was applied and committed: a claim with no applied_at after ten
 * minutes belonged to a request that died, and the next delivery takes it
 * over. The daily job prunes rows older than seven days.
 */
export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
});

/**
 * Who has had a free month: one row per Clerk user, written when a firm the
 * user created got its trial (src/lib/billing/store.ts, startBilling). A
 * later firm by the same creator gets no trial. The row outlives the firm
 * (tenant_id is set null if the tenant row is ever deleted). Global,
 * service-written only, like stripe_webhook_events.
 */
export const userTrials = pgTable("user_trials", {
  clerkUserId: text("clerk_user_id").primaryKey(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every call of the create-firm action, per Clerk user: the action refuses
 * a user with FIRM_CREATION_DAILY_LIMIT attempts in the last day
 * (src/lib/tenants/create-firm.ts). Global, service-written only; the daily
 * job deletes rows older than seven days.
 */
export const firmCreationAttempts = pgTable("firm_creation_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkUserId: text("clerk_user_id").notNull(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userTimeIdx: index("firm_creation_attempts_user_time_idx").on(t.clerkUserId, t.attemptedAt),
}));

// ---------------------------------------------------------------------------
// Legal-update monitoring (src/services/monitoring/): the platform version of
// the eoir-weekly-update skill. legal_update_runs, legal_update_source_checks
// and legal_updates are GLOBAL, one copy for every firm and not tenant data:
// any context may read them, and only the monitor writes them, in service
// context (withServiceContext). RLS enforces both
// (src/db/migrations/0005_legal_updates.sql). legal_update_reviews is tenant
// data under the usual tenant_isolation policy: which items a firm's
// attorneys have reviewed, with their notes.
// ---------------------------------------------------------------------------

export const legalUpdateStatusEnum = pgEnum("legal_update_status", [
  // Listed when the source was first checked: already published before the
  // monitor started watching, so never shown or counted as new.
  "baseline",
  // New, waiting for its summary (the run's summary budget ran out, or the
  // linked document has not been read yet).
  "pending_summary",
  // Summarized from the fetched text, with at least one passage checked
  // against it.
  "published",
  // New, but no summary could be produced (shown with the quoted text only;
  // retried by later runs up to the attempt limit).
  "summary_failed",
  // Read and left out under the source rules in
  // skills-content/eoir-weekly-update/references/sources.md and routing.md
  // (statusReason says why); listed apart, never counted as unreviewed.
  "screened",
  // The same document another source already listed (crossSourceKey).
  "duplicate",
]);

/** One check of every source: the weekly schedule or an owner/admin's "Check now". */
export const legalUpdateRuns = pgTable("legal_update_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  trigger: text("trigger").notNull(), // schedule | manual
  status: text("status").notNull().default("running"), // running | completed | failed | interrupted
  pgBossJobId: text("pg_boss_job_id"),
  // Counts only: sources checked and failed, items new, summarized, screened, left pending.
  totals: jsonb("totals"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => ({
  startedAtIdx: index("legal_update_runs_started_at_idx").on(t.startedAt),
}));

/** What one run found at one source, so a failed or partial source is visible on its own. */
export const legalUpdateSourceChecks = pgTable("legal_update_source_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => legalUpdateRuns.id, { onDelete: "cascade" }),
  source: text("source").notNull(), // a LegalUpdateSourceKey (src/services/monitoring/sources.ts)
  // baseline (first successful check: everything listed was recorded as
  // already published) | ok | partial | failed | not_checked
  status: text("status").notNull(),
  indexUrls: jsonb("index_urls").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  itemsSeen: integer("items_seen").notNull().default(0),
  newItems: integer("new_items").notNull().default(0),
  revisedItems: integer("revised_items").notNull().default(0),
  // sha256 of the listing text the parser read, to tell a quiet week from an unchanged page.
  indexContentHash: text("index_content_hash"),
  notes: jsonb("notes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => ({
  sourceStartedIdx: index("legal_update_source_checks_source_started_idx").on(t.source, t.startedAt),
  runIdx: index("legal_update_source_checks_run_idx").on(t.runId),
}));

export const legalUpdates = pgTable("legal_updates", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull(), // a LegalUpdateSourceKey
  // Stable identifier within the source: "ID 4259", "PM 26-07", an FR
  // document number, a court's docket and opinion file. A later version of
  // the same item (its listed text changed) is a new row with the same
  // external_id and a new content_hash, pointing back through revision_of.
  externalId: text("external_id").notNull(),
  // The same document listed by two sources ("fr:2026-01868"); the second is stored as a duplicate.
  crossSourceKey: text("cross_source_key"),
  itemType: text("item_type").notNull(), // LegalUpdateItemType
  title: text("title").notNull(),
  citation: text("citation"),
  officialUrl: text("official_url").notNull(), // https, on the source's host allow list
  listedOnUrl: text("listed_on_url").notNull(),
  // The PDF the monitor reads before summarizing (opinions, memoranda, notices); null when the listing is enough.
  documentUrl: text("document_url"),
  publishedDateText: text("published_date_text"), // exactly as the source states it
  publishedOn: date("published_on", { mode: "string" }), // the stated date, parsed; null when it does not parse
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
  contentHash: text("content_hash").notNull(),
  // The listing's own text for the item (headnote, title, summary line),
  // quoted verbatim apart from whitespace.
  rawExcerpt: text("raw_excerpt").notNull(),
  // Passages of the linked document, each one cited by the API's citation
  // feature from the fetched PDF itself: [{ label, text, startPage, endPage }].
  documentQuotes: jsonb("document_quotes"),
  // Other facts the listing states (origin, case type, agencies), shown and given to the summarizer.
  listingFacts: jsonb("listing_facts"),
  circuit: text("circuit"), // "5" for a Fifth Circuit opinion; null otherwise
  courtWeight: text("court_weight"), // the Weight line routing.md prescribes
  aiSummary: text("ai_summary"),
  summaryModel: text("summary_model"),
  summarizedAt: timestamp("summarized_at", { withTimezone: true }),
  topics: text("topics").array().notNull().default(sql`'{}'::text[]`), // routing.md topic keys
  // Registered skill names this item matters to (src/services/monitoring/routing.ts).
  affectedSkills: text("affected_skills").array().notNull().default(sql`'{}'::text[]`),
  // Why each skill is affected, the passages the summary rests on, notes
  // against the firm's reference text, and open questions:
  // see LegalUpdateAnalysis in src/services/monitoring/types.ts.
  analysis: jsonb("analysis"),
  status: legalUpdateStatusEnum("status").notNull().default("pending_summary"),
  statusReason: text("status_reason"),
  summaryAttempts: integer("summary_attempts").notNull().default(0),
  revisionOf: uuid("revision_of"),
  firstSeenRunId: uuid("first_seen_run_id").references(() => legalUpdateRuns.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sourceItemHashIdx: uniqueIndex("legal_updates_source_item_hash_idx").on(t.source, t.externalId, t.contentHash),
  statusRetrievedIdx: index("legal_updates_status_retrieved_idx").on(t.status, t.retrievedAt),
  affectedSkillsIdx: index("legal_updates_affected_skills_idx").using("gin", t.affectedSkills),
  crossSourceIdx: index("legal_updates_cross_source_idx").on(t.crossSourceKey),
}));

/** A firm attorney's review of one legal update (one row per firm and item; a later review replaces the note). */
export const legalUpdateReviews = pgTable("legal_update_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  legalUpdateId: uuid("legal_update_id").notNull().references(() => legalUpdates.id, { onDelete: "restrict" }),
  reviewedBy: text("reviewed_by").notNull(), // Clerk user id
  note: text("note"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index("legal_update_reviews_tenant_idx").on(t.tenantId),
  tenantItemIdx: uniqueIndex("legal_update_reviews_tenant_item_idx").on(t.tenantId, t.legalUpdateId),
}));

// ---------------------------------------------------------------------------
// Library (src/services/library/, docs/LIBRARY.md): the app's own copy of
// the public, official immigration-law sources (decisions, statutes,
// regulations, manuals, guidance), collected directly from the government
// and court sites and refreshed daily. Every table here is GLOBAL, one copy
// for every firm, and holds no tenant or client data: any context may read
// it, and only the library worker writes it, in service context
// (withServiceContext). RLS enforces both, as for legal_updates
// (src/db/migrations/0007_library.sql).
// ---------------------------------------------------------------------------

/**
 * Whether the source's text may be stored in full. US federal government
 * works are public domain (full text); anything not clearly public domain is
 * link_only: metadata, a short excerpt and the official link.
 */
export const libraryLicenseEnum = pgEnum("library_license", ["public_domain", "link_only"]);

/** A source's standing after its last run (staleness is computed from last_success_at when read). */
export const librarySourceStatusEnum = pgEnum("library_source_status", [
  // Registered, never run.
  "pending",
  // The last daily run collected everything it listed.
  "ok",
  // The last run finished, but some documents failed or the run's cap was reached.
  "partial",
  // The last run failed (listing unreadable, host unreachable, layout changed).
  "failed",
  // The adapter needs an API key that is not configured; it is skipped.
  "needs_key",
  // Turned off in the deployment's environment (LIBRARY_DISABLED_SOURCES).
  "disabled",
  // Kept up to date by import from the official site (LIBRARY_MANUAL_SOURCES; migration 0010): no daily run.
  "manual",
]);

export const libraryPrecedentialStatusEnum = pgEnum("library_precedential_status", [
  "precedential",
  "non_precedential",
  "not_applicable",
  "unknown",
]);

/** What library_documents.text holds: the full text, an excerpt (link_only sources), or nothing (no text layer). */
export const libraryTextKindEnum = pgEnum("library_text_kind", ["full", "excerpt", "none"]);

/** manual_import (migration 0010): one file a platform operator imported from the official site (/library/import). */
export const libraryRunKindEnum = pgEnum("library_run_kind", ["daily", "backfill", "manual_import"]);

export const libraryRunStatusEnum = pgEnum("library_run_status", [
  "running",
  "completed",
  "partial",
  "failed",
  "skipped",
  "interrupted",
]);

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/** One collected source (one adapter in src/services/library/adapters/), with its display text and its standing. */
export const librarySources = pgTable("library_sources", {
  code: text("code").primaryKey(), // the adapter's code, e.g. "eoir_ag_bia_precedents"
  groupCode: text("group_code").notNull(), // a LibraryGroupCode (src/services/library/groups.ts)
  name: text("name").notNull(),
  description: text("description").notNull(),
  coverage: text("coverage").notNull(),
  cadence: text("cadence").notNull(),
  officialUrl: text("official_url").notNull(),
  license: libraryLicenseEnum("license").notNull(),
  // Why a link_only source keeps no full text (shown on /library).
  licenseNote: text("license_note"),
  status: librarySourceStatusEnum("status").notNull().default("pending"),
  // A plain sentence for the status: the missing API key, what failed.
  statusDetail: text("status_detail"),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastError: text("last_error"),
  documentCount: integer("document_count").notNull().default(0),
  // { staleAfterHours, latestDocumentDate, lastDailyRun: { at, status, counts }, backfill: { status, done },
  //   manualImport: { intervalDays } | null, lastManualImport: { at, externalId, outcome } }
  freshness: jsonb("freshness").notNull().default(sql`'{}'::jsonb`),
  // When the first successful daily run finished: documents a daily run finds
  // after this feed legal_updates (the first run is the baseline, never news).
  legalUpdatesBaselineAt: timestamp("legal_updates_baseline_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  groupIdx: index("library_sources_group_idx").on(t.groupCode),
}));

/** One document as the official source publishes it: a decision, a statute or regulation section, a manual chapter, a memorandum. */
export const libraryDocuments = pgTable("library_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceCode: text("source_code").notNull().references(() => librarySources.code, { onDelete: "restrict" }),
  // Stable within the source ("ID 4259", "8 CFR 1003.38", a docket and file).
  externalId: text("external_id").notNull(),
  docType: text("doc_type").notNull(), // LibraryDocType
  title: text("title").notNull(),
  // The document's own citations exactly as the source states them ("27 I&N Dec. 837 (DIR 2020)", "Interim Decision 3984").
  citations: text("citations").array().notNull().default(sql`'{}'::text[]`),
  court: text("court"),
  agency: text("agency"),
  // Dates as the source states them, parsed (YYYY-MM-DD); the stated text is in metadata.statedDates.
  decisionDate: date("decision_date", { mode: "string" }),
  publishedDate: date("published_date", { mode: "string" }),
  effectiveDate: date("effective_date", { mode: "string" }),
  editionDate: date("edition_date", { mode: "string" }),
  // The year the source states (a citation's "(BIA 1958)"), when no full date is stated or parses.
  documentYear: integer("document_year"),
  precedentialStatus: libraryPrecedentialStatusEnum("precedential_status").notNull().default("unknown"),
  // The page or file to cite (https, on the adapter's host list).
  officialUrl: text("official_url").notNull(),
  // The file the text was read from, after redirects, when it differs.
  originalUrl: text("original_url"),
  // The original file in S3 (library/<source>/...), only with LIBRARY_STORE_ORIGINALS and a public domain source.
  originalS3Key: text("original_s3_key"),
  originalSha256: text("original_sha256"),
  originalContentType: text("original_content_type"),
  // Full text for a public domain source; an excerpt for a link_only one. Never truncated for storage.
  text: text("text").notNull(),
  textKind: libraryTextKindEnum("text_kind").notNull().default("full"),
  textSha256: text("text_sha256").notNull(),
  textChars: integer("text_chars").notNull().default(0),
  // Title and citations weighted A, metadata.summary (a headnote or syllabus
  // the source states) B, court and agency C, the text D. Kept by the
  // library_documents_search_vector trigger (0007), which indexes at most the
  // first 200,000 characters of text (a tsvector is limited to 1 MB).
  searchVector: tsvector("search_vector"),
  // Facts the source states (volume, docket, judges, form number; summary: its
  // headnote or syllabus, searchable); never derived guesses.
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  // How the last fetch went (validators, sizes, extraction method); not versioned.
  fetchInfo: jsonb("fetch_info").notNull().default(sql`'{}'::jsonb`),
  // A change signal from the listing (the adapter's fingerprint); unchanged means the document is not fetched again.
  listingFingerprint: text("listing_fingerprint"),
  version: integer("version").notNull().default(1),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }).notNull().defaultNow(),
  lastChangedAt: timestamp("last_changed_at", { withTimezone: true }).notNull().defaultNow(),
  lastRunId: uuid("last_run_id"),
  // The source no longer lists it (or marks it withdrawn); kept, flagged.
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  withdrawnReason: text("withdrawn_reason"),
  // A later document that replaces it, when the source says so.
  supersededById: uuid("superseded_by_id"),
  supersededNote: text("superseded_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sourceExternalIdx: uniqueIndex("library_documents_source_external_idx").on(t.sourceCode, t.externalId),
  searchIdx: index("library_documents_search_idx").using("gin", t.searchVector),
  titleTrgmIdx: index("library_documents_title_trgm_idx").using("gin", t.title.op("gin_trgm_ops")),
  sourceDateIdx: index("library_documents_source_date_idx").on(t.sourceCode, t.decisionDate),
  officialUrlIdx: index("library_documents_official_url_idx").on(t.officialUrl),
  firstSeenIdx: index("library_documents_first_seen_idx").on(t.firstSeenAt),
  // The country filter (search.ts): metadata.countryKeys @> '["honduras"]'.
  countryKeysIdx: index("library_documents_country_keys_idx").using("gin", sql`(${t.metadata} -> 'countryKeys') jsonb_path_ops`),
  // A search with filters and no words (search.ts): the newest documents first.
  newestIdx: index("library_documents_newest_idx").on(
    sql`coalesce(${t.decisionDate}, ${t.publishedDate}, ${t.effectiveDate}) desc nulls last`,
    t.firstSeenAt.desc().nullsFirst()
  ),
}));

/** The text and metadata a document had before a change (version n is the row's state while it was version n). */
export const libraryDocumentVersions = pgTable("library_document_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().references(() => libraryDocuments.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  citations: text("citations").array().notNull().default(sql`'{}'::text[]`),
  officialUrl: text("official_url").notNull(),
  originalUrl: text("original_url"),
  originalS3Key: text("original_s3_key"),
  text: text("text").notNull(),
  textKind: libraryTextKindEnum("text_kind").notNull(),
  textSha256: text("text_sha256").notNull(),
  // The replaced row's dates, precedential status and metadata.
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
  replacedAt: timestamp("replaced_at", { withTimezone: true }).notNull().defaultNow(),
  replacedByRunId: uuid("replaced_by_run_id"),
}, (t) => ({
  documentVersionIdx: uniqueIndex("library_document_versions_document_version_idx").on(t.documentId, t.version),
}));

/**
 * Normalized citations (src/services/library/citations.ts) to documents.
 * relation "self": the document IS this authority (lookup_library_citation
 * finds it); "cites": the document's text cites it (capped per document).
 */
export const libraryCitations = pgTable("library_citations", {
  documentId: uuid("document_id").notNull().references(() => libraryDocuments.id, { onDelete: "cascade" }),
  relation: text("relation").notNull(), // self | cites
  normalized: text("normalized").notNull(), // "27 I&N Dec. 837", "8 U.S.C. 1158", "8 C.F.R. 1003.38"
  kind: text("kind").notNull(), // CitationKind
  // As written where it was found (the first occurrence).
  raw: text("raw").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.documentId, t.relation, t.normalized] }),
  normalizedIdx: index("library_citations_normalized_idx").on(t.normalized, t.relation),
  normalizedTrgmIdx: index("library_citations_normalized_trgm_idx").using("gin", t.normalized.op("gin_trgm_ops")),
}));

/** One daily or backfill run of one source, or one manual import, with its counts and what went wrong. */
export const libraryFetchRuns = pgTable("library_fetch_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceCode: text("source_code").notNull().references(() => librarySources.code, { onDelete: "cascade" }),
  kind: libraryRunKindEnum("kind").notNull(),
  status: libraryRunStatusEnum("status").notNull().default("running"),
  pgBossJobId: text("pg_boss_job_id"),
  // { listed, skippedUnchanged, fetched, notModified, inserted, updated, unchanged, failed, withdrawn, legalUpdates }
  counts: jsonb("counts").notNull().default(sql`'{}'::jsonb`),
  notes: jsonb("notes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  // Per-document failures, capped: [{ externalId, url, error }].
  failures: jsonb("failures").notNull().default(sql`'[]'::jsonb`),
  errorMessage: text("error_message"),
  cursorBefore: jsonb("cursor_before"),
  cursorAfter: jsonb("cursor_after"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => ({
  sourceStartedIdx: index("library_fetch_runs_source_started_idx").on(t.sourceCode, t.startedAt),
}));

/** Where a source's history walk stands, so backfill resumes chunk by chunk across restarts. */
export const libraryBackfillState = pgTable("library_backfill_state", {
  sourceCode: text("source_code").primaryKey().references(() => librarySources.code, { onDelete: "cascade" }),
  // The adapter's own cursor (opaque JSON); null before the first chunk.
  cursor: jsonb("cursor"),
  status: text("status").notNull().default("pending"), // pending | running | complete | failed
  chunksDone: integer("chunks_done").notNull().default(0),
  documentsDone: integer("documents_done").notNull().default(0),
  // Refs whose fetch failed in an earlier chunk ([{ ref, attempts, error }]), tried again before the next chunk.
  retryRefs: jsonb("retry_refs").notNull().default(sql`'[]'::jsonb`),
  lastChunkAt: timestamp("last_chunk_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * HTTP validators (ETag, Last-Modified) of listing pages the adapters read
 * with ctx.http's cached GET, saved only when the run that read the page
 * finished, so a conditional request never hides a page a failed run did
 * not finish processing. Keyed by source and URL: two sources may read the
 * same listing page, and each keeps its own validators.
 */
export const libraryHttpCache = pgTable("library_http_cache", {
  url: text("url").notNull(), // as the adapter requested it
  finalUrl: text("final_url").notNull(), // where the validators belong (after redirects)
  sourceCode: text("source_code").notNull().references(() => librarySources.code, { onDelete: "cascade" }),
  etag: text("etag"),
  lastModified: text("last_modified"),
  contentSha256: text("content_sha256"),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.sourceCode, t.url] }),
}));

/**
 * The audit log of imports from the official sites (/library/import,
 * src/services/library/manual-import.ts, migration 0010). The library is
 * global, so an import changes what every firm reads; the tenant-scoped
 * audit_logs cannot hold it. One row per attempt by a platform operator
 * (LIBRARY_IMPORT_ADMINS), refused ones included. Append-only: RLS lets
 * every context read it and service context insert, and no context update
 * or delete it.
 */
export const libraryImportLog = pgTable("library_import_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceCode: text("source_code").notNull().references(() => librarySources.code, { onDelete: "restrict" }),
  // The operator's Clerk user id, and the firm they were signed in to (context only: the library is not the firm's).
  actorUserId: text("actor_user_id").notNull(),
  actorTenantId: uuid("actor_tenant_id"),
  // The official address given for the file, and the linked page or file, when one was given.
  officialUrl: text("official_url").notNull(),
  linkedUrl: text("linked_url"),
  fileSha256: text("file_sha256").notNull(),
  fileBytes: integer("file_bytes").notNull(),
  fileContentType: text("file_content_type"),
  linkedFileSha256: text("linked_file_sha256"),
  // inserted | updated | unchanged (stored), rejected (the address or file was refused), failed (parsing or storing failed).
  outcome: text("outcome").notNull(),
  errorMessage: text("error_message"),
  externalId: text("external_id"),
  documentId: uuid("document_id").references(() => libraryDocuments.id, { onDelete: "set null" }),
  documentVersion: integer("document_version"),
  runId: uuid("run_id").references(() => libraryFetchRuns.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sourceCreatedIdx: index("library_import_log_source_created_idx").on(t.sourceCode, t.createdAt),
}));

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const tenantsRelations = relations(tenants, ({ many }) => ({
  memberships: many(memberships),
  practiceProfileVersions: many(practiceProfileVersions),
  firmAttorneys: many(firmAttorneys),
  clients: many(clients),
  matters: many(matters),
  documents: many(documents),
  skillRuns: many(skillRuns),
  auditLogs: many(auditLogs),
}));

export const mattersRelations = relations(matters, ({ one, many }) => ({
  tenant: one(tenants, { fields: [matters.tenantId], references: [tenants.id] }),
  parties: many(matterParties),
  documents: many(documents),
  skillRuns: many(skillRuns),
}));

export const matterPartiesRelations = relations(matterParties, ({ one }) => ({
  matter: one(matters, { fields: [matterParties.matterId], references: [matters.id] }),
  client: one(clients, { fields: [matterParties.clientId], references: [clients.id] }),
}));

export const skillRunsRelations = relations(skillRuns, ({ one }) => ({
  matter: one(matters, { fields: [skillRuns.matterId], references: [matters.id] }),
  skillDefinition: one(skillDefinitions, {
    fields: [skillRuns.skillDefinitionId],
    references: [skillDefinitions.id],
  }),
}));
