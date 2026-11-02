# MeritDesk.AI

A plugin-first AI connector for U.S. immigration law practices. MeritDesk exposes
a remote MCP server that brings its official immigration-law library and
firm-controlled case-work tools into Claude, ChatGPT and other recognized MCP
clients. The AI assistant is the primary work interface; the website is the
account, billing, firm-permissions and connector-setup portal. The underlying
matter, client and document services remain available for secure administration
and file uploads.

The legal skills are built on the firm's Claude Skills (see `skills-content/`).
See `.claude/plans/` (in the session that built this) for the original
architecture plan — this README is the practical "how do I actually run this"
companion.

**Deploying? Start with [DEPLOY.md](DEPLOY.md):** every step from this code
to a running app that Claude and ChatGPT can connect to, in order.

I (Claude) can write, type-check and build the code, but I can't create accounts, agree to
terms, or enter payment details on your behalf — those steps below are yours.

## 1. Create the external accounts

You'll need four things before this app can run for real. Free/starter tiers
are enough to develop against; costs only show up as you get real usage.
Billing (Stripe) and emails (Amazon SES) are set up later, in DEPLOY.md
("Billing with Stripe", "Emails with SES"); the app runs without them.

### Neon (Postgres database)

1. Create an account at neon.tech and a new project.
2. The project's default role owns the database and runs the migrations.
   The app and the worker must not use it: create a separate runtime role
   as described in "Database roles" below.
3. In `.env.local`, set `MIGRATION_DATABASE_URL` to the owner role's
   connection string, `DATABASE_URL` to the runtime role's **pooled**
   connection string (Dashboard, Connection Details, "Pooled connection"),
   and `QUEUE_DATABASE_URL` to the runtime role's **direct** (non-pooled)
   one.

### Database roles

Row-level security is the second layer of tenant isolation (every query
also filters by tenant in code), and Postgres never applies it to a
superuser or to a role with `BYPASSRLS`. Neon's project owner role may be
such a role. So the app connects as its own role, and the owner role is
kept for migrations:

- `src/db/client.ts` checks the role behind `DATABASE_URL` before the first
  query (the worker at startup, logging `[worker] database role: subject to
  row-level security`; the web app on its first request) and refuses to run
  anything as a superuser or a `BYPASSRLS` role, with an error that names
  the role.
- `npm run db:migrate` (and `drizzle-kit`) connect with
  `MIGRATION_DATABASE_URL`, falling back to `DATABASE_URL` when it is not
  set, which works only while `DATABASE_URL` is still the owner role.
- `npm run db:seed-skills` uses `DATABASE_URL`, like the app.
- pg-boss (`QUEUE_DATABASE_URL`) needs a direct connection, not Neon's
  pooled one (PgBouncer in transaction mode), for its own schema and
  maintenance queries. It creates and owns a `pgboss` schema on first
  start, so the role it connects as needs `CREATE` on the database. Use the
  runtime role here too, so the web app holds no owner credentials.

Create the runtime role once, in Neon's SQL Editor connected as the owner
role (the default `neondb_owner` and database `neondb` below; use your
names). Create it with SQL rather than in the Neon Console, so it holds
only the privileges granted here (a role created in the Console may be
given Neon's administrative role):

```sql
CREATE ROLE app_runtime WITH LOGIN PASSWORD '<a long random password>'
  NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
GRANT CONNECT, CREATE ON DATABASE neondb TO app_runtime;  -- CREATE: pg-boss's own schema
GRANT USAGE ON SCHEMA public TO app_runtime;
-- Tables the migrations create later, as the owner role:
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
-- Tables that already exist (run again after a migration created tables
-- before the line above was in place):
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
```

The runtime role owns no table, so `FORCE ROW LEVEL SECURITY` is not even
needed for it; it gets row access only. `audit_logs` refuses UPDATE and
DELETE by trigger for every role; `REVOKE UPDATE, DELETE ON audit_logs FROM
app_runtime;` adds a second refusal if you want one. To confirm the setup,
connect as the runtime role and run `SELECT rolsuper, rolbypassrls FROM
pg_roles WHERE rolname = current_user;` (both false).

### Clerk (authentication + multi-tenant organizations)

1. Create an app at dashboard.clerk.com.
2. Enable **Organizations** (Configure → Organizations).
3. Roles. Leave Clerk's two default organization roles as they are and
   create no custom role: custom roles need Clerk's paid B2B add-on in
   production, and the app does not use them. Clerk's **Admin**
   (`org:admin`) is the app's owner/admin; every other member is Clerk's
   **Member** (`org:member`), and their role in the app (attorney,
   paralegal or read-only) is kept by the app itself, in
   `memberships.role`, and set by an owner/admin in the Members section of
   the Firm page (`src/lib/tenants/members.ts`, `src/lib/tenants/membership.ts`;
   audited as `membership.role_changed`). A new member starts as read-only.
   On the Roles & Permissions page, leave the **creator role** at its
   default, `org:admin`, and the default role for invitations at
   `org:member`. Delete organization stays with the Admin role only
   (Clerk's default); do not give the Member role `org:sys_profile:delete`.
   If an owner does delete the organization in Clerk, the app marks the
   firm deleted, cancels its Stripe subscription at once with proration and
   makes the firm unreachable; its rows stay, and only the operator can
   bring it back, by hand ("Trial, billing and emails", "Firm deletion").

   How a request gets its role (`resolveAppRole` in `src/lib/roles.ts`,
   used by `getCurrentTenant` in `src/lib/tenant.ts`, the connector's
   `clerk-auth.ts` and the worker's membership reconciliation): the user's
   Clerk membership is verified first (the organization exists as a tenant
   and the user is a member of it); a Clerk Admin is `owner_admin`
   whatever the membership row says; a Clerk Member has the role stored on
   their membership row, or `read_only` when the row is missing (Clerk is
   asked live, and the row is created) or still says `owner_admin` (a
   demotion the sync has not written yet). So making or unmaking an
   owner/admin happens in Clerk's organization settings (the firm menu at
   the top, Manage organization, Members) and applies as soon as the
   user's session token carries it; giving an attorney or paralegal role
   happens on the Firm page and applies on the member's next request (the
   connector reads it on every call too). Nothing reads a custom Clerk
   role, and a stored `owner_admin` alone never makes anyone an
   owner/admin. The org-sync webhook (step 5) and the daily job keep the
   rows in step: an Admin's row becomes `owner_admin`, a Member's row keeps
   the role the firm gave them (or becomes `read_only` after a demotion
   from Admin).

   What each role may do is enforced in every Server Action (`requireRole`
   in `src/lib/tenant.ts`): owner/admin, attorney and paralegal may create
   matters, clients and parties, edit matter details, upload and rescan
   documents, run and retry skills, and draft the practice profile; only
   owner/admin and attorney may confirm a practice profile version (it
   becomes part of every later skill run's prompt), edit the firm identity
   on the Firm page (letterhead, attorney roster, signature images) and
   mark legal updates reviewed; only owner/admin may start a legal-update
   check outside the daily schedule, change the connector switches,
   subscribe the firm and set members' roles. `read_only` may open pages
   and download clean documents, nothing else. A skill run records the role
   of the user who queued it, and only runs queued by an owner/admin or
   attorney put a stored signature image on a generated document (see
   "Firm identity").

   **An instance that still has the four custom roles** of an earlier
   version (`org:owner_admin`, `org:attorney`, `org:paralegal`,
   `org:read_only`): deploy this version first, then in Clerk, in each
   organization's Members tab, change every `org:owner_admin` member to
   Admin and everyone else to Member (a member's stored app role is kept,
   so attorneys and paralegals stay what they were; anyone who was
   `org:member` is read-only until an owner/admin sets their role on the
   Firm page), set the creator role back to `org:admin`, and delete the
   four custom roles. Until an owner's Clerk role is Admin they are
   read-only in the app, so change the owners first. Migration
   `0016_members_default_role.sql` sets the column's default to
   `read_only`; no row changes.

   Under Configure > Organizations, turn **Allow user-created
   organizations** off (or, failing that, set the organization limit to a
   custom limit of 1 per user). The app's own Create firm form is the one
   way a user gets a firm: it refuses a second firm for a person who already
   belongs to one, limits a user to 3 attempts a day, and gives the free
   month once per person. With the switch on, Clerk's components (the
   organization switcher's "Create organization") would create organizations
   without those checks, and every one of them would start a new free month
   through the webhook.
4. Copy the publishable key and secret key into `.env.local` as
   `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` (the worker
   needs the secret key too: it reads a firm's owner/admin email addresses
   from Clerk when it sends billing emails, see "Trial, billing and
   emails").
5. Once you have a public URL for the app (even a temporary tunnel while
   developing), add a webhook endpoint at `<your-domain>/api/webhooks/clerk`,
   subscribed to `organization.*` and `organizationMembership.*` events. Copy
   the signing secret into `.env.local` as `CLERK_WEBHOOK_SECRET`. Without
   this webhook, signing up and creating an organization in Clerk will not
   create a matching `Tenant`/`Membership` row in the database, and the app
   will tell you so on first load.
6. For the Claude and ChatGPT connector (see "The Claude and ChatGPT
   connector" below and `docs/CONNECTORS.md` section 3), Clerk is the OAuth
   authorization server. Under OAuth applications, **Scopes** tab: create
   the custom scope `practice:connector` (or the value of
   `CONNECTOR_REQUIRED_SCOPE`); the connector refuses any token without it.
   Settings tab: turn on **Publish CIMD support**, and **Publish DCR support**
   only until the Claude and ChatGPT client ids are known (see
   `docs/CONNECTORS.md` section 3, "First connection"); set **Default scopes
   for dynamic clients** to `openid profile email user:org:read
   practice:connector`, keep **Require PKCE** on, keep the consent screen on,
   and keep **JWT access tokens** (the connector refuses opaque ones). The
   case-work tools also need the client allow list
   (`CONNECTOR_ALLOWED_CLIENT_IDS` / `CONNECTOR_ALLOWED_CLIENT_ID_PREFIXES`):
   with neither set, every connection gets the library tools only. No
   redirect URIs need adding for Claude or ChatGPT when they
   register themselves (CIMD or DCR); a pre-registered client needs
   `https://claude.ai/api/mcp/auth_callback` (Claude), a loopback
   `http://localhost:<port>/callback` (Claude Code), or the redirect URI
   ChatGPT shows for the server (`https://chatgpt.com/connector_platform_oauth_redirect`
   or `https://chatgpt.com/connector/oauth/<callback id>`).

### AWS (S3 document storage)

1. Create an S3 bucket (private, block all public access, **versioning
   on**). Versioning is required: the malware scan records the object
   version it read, and downloads and skill runs read only that version, so
   a file put again through a still-valid upload URL after its scan is
   never served. Without versioning every upload ends "Not scanned".
2. Encryption: set the bucket's default encryption to SSE-KMS. The app
   asks for SSE-KMS (`x-amz-server-side-encryption: aws:kms`, no key named)
   on every object it writes, browser uploads included. To refuse any write
   without it, add this statement to the bucket policy:
   ```json
   {
     "Sid": "DenyWritesWithoutKms",
     "Effect": "Deny",
     "Principal": "*",
     "Action": "s3:PutObject",
     "Resource": "arn:aws:s3:::<bucket>/*",
     "Condition": { "StringNotEquals": { "s3:x-amz-server-side-encryption": "aws:kms" } }
   }
   ```
3. CORS: the browser uploads straight to S3 with a presigned PUT that
   sends `Content-Type` and the encryption header (signed as part of the
   URL, so S3 refuses the PUT without it). Add a CORS rule allowing exactly
   that from the app's origins:
   ```json
   [
     {
       "AllowedOrigins": ["https://<web-app-name>.fly.dev", "http://localhost:3000"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["content-type", "x-amz-server-side-encryption"],
       "MaxAgeSeconds": 3000
     }
   ]
   ```
   Downloads and signature previews open their presigned URLs directly
   (a new tab, an image), so they need no CORS rule.
4. Create an IAM user (or role) with `s3:PutObject`, `s3:GetObject` and
   `s3:GetObjectVersion` scoped to that bucket, and its access key pair.
   If the objects end up under a customer managed KMS key, also give it
   `kms:GenerateDataKey` and `kms:Decrypt` on that key (uploads and reads
   are signed with this user's credentials).
5. Fill in `.env.local`: `AWS_REGION`, `AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY`, `S3_DOCUMENTS_BUCKET`.

### Anthropic (the Skill Runner)

1. Create a key at console.anthropic.com — use the **Claude API**, not a
   claude.ai consumer login.
2. **Before any real client PII flows through**, apply for **Zero Data
   Retention** given how sensitive this data is (asylum narratives, medical
   and criminal history, A-numbers). Talk to Anthropic sales/support about
   this — it's an account-level setting, not something in this codebase.
   The research skills' web tools are already configured in the
   ZDR-eligible way (see "Web research and the verification log" below).
3. Put the key in `.env.local` as `ANTHROPIC_API_KEY`.
4. In the Claude Console, leave **web search** enabled for the
   organization (Settings, Capabilities): research skills use the API's web
   search and web fetch tools, and a request that includes them fails if an
   administrator has disabled web search. An organization-level domain
   allow list there also limits what any skill can search or fetch.

Copy `.env.example` to `.env.local` and fill in all of the above.

## 2. First-time local setup

```bash
npm install
npm run db:migrate       # creates tables + row-level security policies, as the owner
                         # role (MIGRATION_DATABASE_URL); then grant the runtime role
                         # its access (see "Database roles") if you have not yet
npm run db:seed-skills   # inserts a new skill_definitions version for each registered
                         # skill whose SKILL.md or references changed; safe to re-run
npm run dev
```

Each skill version stores its SKILL.md and its `references/*.md`
(`skill_definitions.skill_markdown` and `reference_files`), and a run sends
exactly the stored copy of the version it is pinned to, whatever the files
on disk say. A version seeded before `reference_files` existed has no copy:
its runs read the files from disk and fail with a message to re-run the
seed if they no longer match that version's `content_hash`. What a version
does not store is code: generator scripts and their assets, output schemas
and tools come from the worker image that ran the run, recorded as
`skill_runs.input_snapshot.workerImage` (Fly's `FLY_IMAGE_REF`; null when
the worker runs outside Fly).

In a **second terminal**, start the skill-run worker:

```bash
npm run worker
```

Skill runs and upload processing (malware scan + text extraction) execute in
this worker process, not in the Next.js request. `npm run dev` alone will
only ever leave runs sitting in `queued` and uploads sitting at "Scan
pending". See "Skill runs now go through a background queue" and "Uploads:
malware scan and text extraction" below.

Then:

1. Open http://localhost:3000, sign up, and create your firm in the Create
   firm form (it creates the Clerk organization, makes you its owner, starts
   the free month, and lands you on the Connect page).
2. The Clerk webhook (see above) keeps memberships in step and creates the
   tenant for a firm made outside the app — while developing locally without a public
   URL, use a tunnel (e.g. `ngrok http 3000`) and point the Clerk webhook at
   the tunnel's URL instead of localhost.
3. Go to **Practice Profile** and run through the setup — every skill run
   reads this profile first, so nothing meaningful will work until it's
   filled in.
4. Go to **Firm** and enter the firm's letterhead details and its attorneys
   and accredited representatives (mark the default signer, and upload
   signature images if documents should carry them). Skill runs use these
   in place of the firm the skills were written for; until they are set,
   runs write placeholders such as [FIRM NAME] and flag the gap (see
   "Firm identity" below).
5. Create a matter, add a client as a party, upload its documents, and run
   a skill from the matter page: skills built for the matter's case type
   come first, grouped by category, and the rest are under Other skills.
   Choosing one opens its run form, which shows the skill's description,
   any similar skills to compare, warnings about anything that will limit
   the run (documents not scanned yet, no confirmed practice profile,
   incomplete firm identity for drafting skills), and what the optional
   case note should include (every skill offers one; for **I-130 expedite
   build**, the I-797C receipt details and the urgency, in your own words).
   Each completed run shows its escalation flags above the report.

### Type checking and lint

```bash
npm run typecheck   # next typegen && tsc --noEmit
npm run lint
```

Use `npm run typecheck`, not a bare `tsc --noEmit`. The global route type
helpers (`LayoutProps`, `PageProps`, `RouteContext`) are generated by Next
into `.next/types/`, which is gitignored along with `next-env.d.ts`, so on a
fresh clone (or after deleting `.next`) a bare `tsc` fails with "Cannot find
name 'LayoutProps'" in `src/app/layout.tsx`. `next typegen` writes them
without a full build; `next dev` and `next build` also write them.

### Skill runs now go through a background queue

Triggering a skill run inserts a `queued` row and returns immediately; the
`npm run worker` process (`src/worker.ts`, using `pg-boss` against
`QUEUE_DATABASE_URL`) picks it up, runs the same agentic loop that used to
run inline, and updates the row to `running` then `completed`/`failed`. The
matter page polls for status while any run is `queued`/`running`, so no
manual refresh is needed. A run that fails is not automatically retried
(these loops can have side effects like a live fetch or a generated
document, so blind retry isn't safe). A failed run has a **Retry** button
instead; see "Stuck runs, Retry, and worker shutdown" below.

The worker runs `src/worker.ts` with the `react-server` export condition:
the skill runner's modules import `server-only`, which throws under plain
Node unless that condition is set. `npm run worker` uses `tsx watch
--conditions=react-server` (restarts on file changes); `Dockerfile.worker`
uses `node --conditions=react-server --import tsx`, so Node itself is the
process that receives the stop signal, and `npm run worker:start` runs it
the same way locally (no restart on file changes, but Ctrl+C gets the
graceful shutdown described below). Queues are created on first
connection (`src/services/queue/boss.ts`); the legal-update queue is
created by `src/services/queue/monitoring-jobs.ts` wherever it is used.

### Worker concurrency

One worker process works on several jobs at once. Each limit is an
environment variable; `fly.worker.toml` sets them in `[env]`, next to the
VM size chosen for them, and the defaults below apply when one is unset:

| Variable | Default | Limits |
| --- | --- | --- |
| `SKILL_RUN_CONCURRENCY` | 4 (1 to 16) | skill runs in progress |
| `SKILL_RUN_TENANT_CONCURRENCY` | half of `SKILL_RUN_CONCURRENCY`, rounded up (2) | one tenant's skill runs in progress |
| `DOCUMENT_INGEST_CONCURRENCY` | 2 (1 to 8) | upload scan and extraction jobs in progress |
| `DOCUMENT_INGEST_TENANT_CONCURRENCY` | half of `DOCUMENT_INGEST_CONCURRENCY`, rounded up (1) | one tenant's upload jobs in progress |
| `LIBREOFFICE_CONCURRENCY` | 2 (1 to 8) | LibreOffice conversions at once, across all jobs |
| `MALWARE_SCAN_CONCURRENCY` | 1 (1 to 4) | `clamscan` runs at once, across all jobs |

An invalid value is logged and replaced by the default; the worker logs
the limits it uses at startup (`[worker] concurrency: ...`).

- **Slots.** pg-boss starts `SKILL_RUN_CONCURRENCY` pollers on the
  skill-run queue (`localConcurrency` in `src/worker.ts`), each working one
  job at a time, and `DOCUMENT_INGEST_CONCURRENCY` on the upload queue, so
  a new upload is never stuck behind long drafting runs. The stuck-run
  sweep and the daily legal-update check each have their own poller, so
  they run on schedule even when every slot is busy. The library's daily
  runs and backfill chunks have their own slots too
  (`LIBRARY_DAILY_CONCURRENCY`, `LIBRARY_BACKFILL_CONCURRENCY`; see
  `docs/LIBRARY.md`).
- **Per-tenant fairness.** Jobs are sent with their tenant as the pg-boss
  group, and the worker caps each tenant's jobs in progress
  (`localGroupConcurrency`). A firm at its limit gets no further slot until
  one of its jobs ends: its other runs stay `queued`, in order, while other
  firms' runs start, so one firm's backlog never takes every slot. The
  limit is counted in the worker process, which makes it exact with the one
  worker machine this deploy runs; with more machines, each applies it. A
  job queued without a group (by a web app deployed before this change) is
  not limited, and the worker logs a warning when it starts one.
- **Memory-heavy tools.** LibreOffice (document previews, the fee packet's
  PDF) and `clamscan` (upload scans, the form tools' downloaded blank
  forms) hold an in-process slot while they run
  (`src/services/queue/concurrency.ts`), so jobs that reach them at the
  same time take turns instead of exhausting memory. A wait is logged
  (`[limits] waiting for a LibreOffice slot ...`) and does not count
  against the tool's own timeout. Every LibreOffice conversion already uses
  its own profile directory inside its job's temporary directory, so
  concurrent conversions never share one.
- **Heartbeats and shutdown** are per job: each job in progress refreshes
  its own heartbeat, and a shutdown waits for every slot's job (see below).
- **Raising the limits.** Raise the VM's memory first: `fly.worker.toml`
  has the memory budget behind the defaults. More concurrent runs also
  mean more concurrent requests to the Anthropic API, so the organization's
  API rate limits bound how high `SKILL_RUN_CONCURRENCY` can usefully go.

### Stuck runs, Retry, and worker shutdown

- **Retry.** Every failed run has a Retry button. It queues a new run (a
  new row; the failed one stays in the list, and the new one carries a
  Retry badge and links back to it) of the same skill with the same case
  note, on the matter's current documents, the current practice profile
  and legal updates, and the skill's latest version.
  The link is stored as `input_snapshot.retryOfRunId`. Only a failed run
  can be retried, and only once at a time: a second Retry while the first
  is still queued or running is refused.
- **Stuck-run sweep.** The worker schedules a pg-boss job,
  `skill-run-stuck-sweep`, every 5 minutes
  (`src/services/skill-runner/stuck-runs.ts`). It marks a run failed, with
  a message saying what happened and to use Retry, when:
  - it is `running` but its pg-boss job has ended or no longer exists. Each
    skill-run job carries a 5-minute heartbeat that the worker refreshes
    every minute while the run works, so a crashed or killed worker's job is
    failed by pg-boss within minutes, and the sweep then fails the run
    (typically 5 to 15 minutes after the crash);
  - it has been `running` for more than 4.5 hours (the job's 4-hour expiry
    plus a margin), whatever its job says;
  - it has been `queued` for more than 10 minutes with no pg-boss job that
    would ever start it (the send failed, or the job ended or was deleted).
  Finding these runs is the one cross-tenant query in the worker: it runs
  in service context (`withServiceContext`) and reads only run ids, tenant
  ids, statuses and ages. Each change is made in that run's own tenant
  context and only if the run is still in the status the sweep saw, so a
  run that finished meanwhile is never overwritten.
- **Enqueue failures.** If the job cannot be put on the queue after the run
  row is created, the run is marked failed at once (instead of sitting
  `queued`) and the error is shown.
- **Graceful shutdown.** On SIGTERM or SIGINT (Fly sends `kill_signal`
  when it stops the machine for a deploy or restart) the worker stops
  taking jobs, waits up to 90 seconds (`WORKER_SHUTDOWN_GRACE_SECONDS`,
  optional, 1 to 280) for every job in progress, then stops pg-boss cleanly:
  upload scans still running go back on the queue (they have retries), and
  skill runs still running are marked failed with "interrupted by a worker
  shutdown, use Retry". A second signal stops waiting. `fly.worker.toml`
  sets `kill_signal = "SIGTERM"` and `kill_timeout = 120` (Fly's defaults
  are SIGINT and 5 seconds). Locally, `tsx watch` kills the worker 5
  seconds after a restart or Ctrl+C, so a run in progress then is failed by
  the sweep a few minutes later instead; `npm run worker:start` shuts down
  the way the deployed worker does. A legal-update check still running at
  shutdown is closed as interrupted by the next check, which keeps every
  item already recorded.
- **Runs only move forward:** queued, then running, then completed or
  failed. Once a run is failed (by the sweep or a shutdown), a worker that
  was somehow still working on it cannot flip it to completed; it logs that
  the report was discarded.

### Audit log

`audit_logs` (append-only: a trigger refuses UPDATE and DELETE) gets one row
per event below, written by the service layer in the same transaction as
the change it records, through `recordAuditEvent` in
`src/lib/audit/service.ts` (which also lists every action string):

| Action | When | Actor |
| --- | --- | --- |
| `document.upload_initiated` | an upload's document row is created and its presigned PUT URL issued | the uploading user |
| `document.download` | a presigned download URL is issued | the user |
| `document.download_blocked` | a download is refused because the file has not scanned clean (`after.reason`: `malware_scan_infected`, `malware_scan_pending` or `malware_scan_error`) | the user |
| `skill_run.requested` | a run is queued, including a Retry (`after.retryOfRunId`) | the requesting user |
| `skill_run.completed` | the worker records a run's report | `system:skill-run-worker` |
| `skill_run.failed` | a run is marked failed (`after.reason`: `run_error`, `enqueue_failed`, `stuck_running`, `worker_stopped`, `never_started`, `worker_shutdown`, `firm_locked`) | `system:skill-run-worker`, `system:skill-run-queue`, `system:stuck-run-sweeper` or `system:worker-shutdown` |
| `practice_profile.confirm` | a practice profile version is confirmed and becomes active (value kept from before this list) | the confirming user |
| `practice_profile.escalation_weakening_acknowledged` | a practice profile version that removes an escalation rule or turns off always escalate is proposed or confirmed with the acknowledgment ticked (`after.stage`: `propose` or `confirm`; `after.weakenings` lists each decision and change) | the proposing or confirming user |
| `firm_identity.update` | the firm's letterhead details are created or changed (`after.changedFields` names the fields) | the user |
| `firm_attorney.create` / `.update` / `.delete` | a roster entry is added, changed (including becoming or ceasing to be the default signer) or removed | the user |
| `firm_signature.upload` / `.remove` | a signature image is stored (with its sha256, type, size and dimensions) or removed | the user |
| `firm_signature.preview` | a 60-second preview URL for a signature image is issued | the user |
| `firm_signature.applied` | a generator embeds a signature image in a generated document (`after.documentId`, `after.skillRunId`) | `system:skill-run-worker` |
| `client.create` | a client record is created (the row's id only, no client details) | the user |
| `matter.create` | a matter is created (`after.caseType`) | the user |
| `matter_party.create` | a client is added to a matter (`after.matterId`, `after.clientId`, `after.role`) | the user |
| `matter.update` | a matter's details (status, venue, circuit, court, NTA date, one-year clock date, next hearing date) are changed on the matter page (`after.changedFields` names the fields; `before.status` / `after.status`) | the user |
| `legal_update.review` | an attorney or owner/admin marks a legal update reviewed (`after.hasNote`; the note is never logged) | the user |
| `legal_update.check_requested` | an owner/admin asks for a legal-update check now (`after.queued`) | the user |
| `connector_settings.update` | an owner/admin turns the connector's case work or download links on or off (`before`/`after`: `caseWorkEnabled`, `allowDocumentDownloads`, `disclosureVersion`; `after.disclosureAcknowledged`) | the user |
| `connector.tool_call` | a case-work tool of the Claude and ChatGPT connector is called, reads included (`resource_id` is the tool; `after.matterId`, `after.skillRunId` or `after.documentId`, `after.oauthClientId`, `after.outcome`; for `list_matters` also `after.matterIds` (at most 50), `after.filters`, `after.limit` and `after.offset`) | the user |
| `billing.trial_started` | the firm's free month starts with the tenant (`after.trialEndsAt`, `after.creatorUserId`) | the creating user, or `system:org-sync` |
| `billing.no_trial` | a new firm got no free month because its creator had already used one (`after.creatorUserId`, `after.earlierTenantId`); a `billing.locked` with reason `no_trial` follows | the creating user, or `system:org-sync` |
| `billing.checkout_started` | an owner/admin is sent to Stripe Checkout (`resource_id` is the session; `after.seats`, `after.firstChargeDeferredTo`, `after.expiredSessionId`) | the user |
| `billing.portal_opened` | an owner/admin opens Stripe's Customer Portal | the user |
| `billing.subscription_updated` | the subscription as the app knows it changed (`resource_id` is the subscription; `before`/`after`: `subscriptionId`, `subscriptionStatus`, `seats`, `cancelAtPeriodEnd`, `currentPeriodEnd`, `pastDueSince`; `after.event` is the Stripe event, `daily_refresh`, `daily_reconcile` or `seats_synced`) | `system:stripe-webhook`, `system:billing-daily` or `system:org-sync` |
| `billing.subscription_canceled` | the app canceled a Stripe subscription at once, prorated (`resource_id` is the subscription; `after.reason`: `superseded` with `after.replacedBy`, or `organization_deleted`) | `system:stripe-webhook`, `system:billing-daily` or `system:org-sync` |
| `billing.invoice_paid` | Stripe reported an invoice paid (`resource_id` is the invoice; `after.amountCents`, `after.currency`, `after.periodStart`, `after.periodEnd`, `after.seats`, `after.subscriptionId`) | `system:stripe-webhook` |
| `billing.payment_failed` | Stripe reported a failed payment (`after.invoiceId`, `after.graceEndsAt`, `after.attempt`) | `system:stripe-webhook` |
| `billing.locked` / `billing.unlocked` | the firm became locked (`after.reason`: `trial_ended`, `no_trial`, `subscription_canceled`, `subscription_unpaid`, `subscription_paused`, `grace_ended`) or regained access | `system:stripe-webhook`, `system:billing-daily`, `system:org-sync`, `system:billing-cli` or the creating user |
| `billing.complimentary_set` | the operator gave the firm complimentary access or took it away with `npm run billing:comp` (`after.complimentary`, `after.operator`) | `system:billing-cli` |
| `tenant.deleted` | the firm's Clerk organization was deleted; the tenant is marked deleted (`after.clerkOrgId`, `after.hadSubscription`, `after.subscriptionId`) | `system:org-sync` |
| `membership.role_changed` | an owner/admin set a member's app role in the Members section of the Firm page (`resource_id` is the membership row; `before.role` as it resolved for the member, null for a member with no row yet; `after.role`, `after.userId`) | the user |

Every row has the tenant, the actor (a Clerk user id, or a `system:` id for
what the app does itself, with the user the run was for in
`after.requestedBy`), the action, and the target (`resource_type` and
`resource_id`). Because the log can never be edited, entries hold ids,
statuses, counts and reason codes only: no file names, case notes, report
text or raw error text (the run's error stays on its `skill_runs` row).
`ip_address` is not filled in yet.

### Uploads: malware scan and text extraction

Uploading a document is two steps: the browser PUTs the file straight to S3,
then calls a server action that puts a `document-ingest` job on the queue.
The worker's job (`src/services/ingest/ingest.ts`) then:

1. Downloads the file (up to 150 MB; anything bigger is marked "error", not
   scanned) and notes the S3 object version it read. A bucket without
   versioning gives no version to pin, so the file is marked "error"
   without scanning.
2. Scans it with ClamAV (`clamscan`, with `--alert-exceeds-max` so a file too
   big to scan fully is reported, not passed; `runClamScan` in
   `src/services/ingest/clamav.ts`, which the form tools also use for blank
   forms they download from uscis.gov). The result goes in
   `documents.malware_scan_status`: `clean`, `infected` (with the signature in
   `ingestion_note`), or `error` when the scan couldn't run. A missing
   scanner or signature database is always `error`, never `clean`. A clean
   result is stored together with the version scanned
   (`documents.s3_version_id`).
3. Only for a clean file, extracts its text into `documents.extracted_text`:
   `pdftotext -layout` for PDFs (with `[Page N]` markers, and the page count
   from `pdfinfo`), `src/services/ingest/docx_to_text.py` (python-docx) for
   `.docx`, a plain decode for text files. Capped at 500,000 characters.
   Images and scanned PDFs have no text layer and no OCR is run; skill runs
   read those directly instead (below).

Each status change is conditional on the status the job started from, so a
second job for the same document (two worker machines, a retry) can never
overwrite another's result: an `infected` never turns `clean`.

**The gate fails closed.** Only a document whose scan came back `clean` can
be downloaded or given to a skill run, and both read the scanned version
only (`s3_version_id`), never whatever has been put to the key since (the
upload URL stays valid for 5 minutes). `infected`, `pending` (not scanned
yet) and `error` (could not be scanned) documents are refused by
`getDocumentDownloadUrl` (audited as `document.download_blocked`) and listed
to the model as excluded or not reviewed. Documents the app generates itself
(the expedite letter, drafts) are stored as `clean`, pinned to the version
written, and queued for text extraction only.

**Sandbox.** Every tool that reads uploaded or generated bytes (`clamscan`,
`pdfinfo`, `pdftotext`, python-docx, LibreOffice, `pdftoppm`, the Python
document generators) runs through `src/services/sandbox/untrusted-exec.ts`,
with an environment holding no secrets (no database URLs, API keys or AWS
keys). On the worker image each call also runs:

- as an unprivileged user leased for that call alone from a pool of 24
  (`doctools0` to `doctools23`, uids from 10001, each with its own group;
  `UNTRUSTED_TOOLS_UID` and `UNTRUSTED_TOOLS_UID_COUNT` in
  `Dockerfile.worker`), via `setpriv`, so two jobs running at once (two
  firms' uploads or drafts) never share an identity. With more calls at
  once than users, a call waits for one;
- in new network and PID namespaces (`unshare --net --pid --kill-child`):
  no network, and every process the tool starts dies with it, on exit or
  timeout. Any process still running as the leased user afterwards is
  killed before the user goes back to the pool;
- under `prlimit` limits: no file over 1 GB, at most 256 processes and
  threads.

A job's work directory belongs to root and the leased user's group only
while that call runs, and to root alone (mode 0700) between calls, so no
other pool user can enter it; it is handed over without following links.
Files the tools write are read back only if they are plain, singly linked
files a pool user created, and never past a size cap per kind of output
(text extraction keeps only the first part of an oversized output instead).
`Dockerfile.worker` sets `UNTRUSTED_TOOLS_SANDBOX=required`, so a worker
that cannot set all of that up refuses to run the tools instead of running
them with its own authority; the worker logs the sandbox it got at startup
(`[ingest] untrusted-tool sandbox: isolated: 24 uids from 10001, one per
call, ...`).

The matter page shows each document's scan status and whether text was
extracted, polls while a scan is in progress, and offers **Scan again** for an
`error` and **Start scan** for an upload with no result after a few minutes
(for example when the worker wasn't running). Only a `clean` document has a
Download button; `infected` ones are flagged in red.

**Locally on Windows** none of `clamscan`, `pdftotext`/`pdfinfo` or
`python3` + python-docx is installed by default, so uploads end as "Not
scanned" with a note saying which tool is missing; the worker logs what it
found at startup. Because the gate fails closed, such uploads can then be
neither downloaded nor read by skill runs (runs list them as not reviewed).
To exercise skill runs on uploaded documents locally, run the worker where
ClamAV, poppler-utils and python-docx are installed (WSL, or the
`Dockerfile.worker` image).

### How skill runs read matter documents

When a run starts, `src/services/skill-runner/document-input.ts` builds the
first message from every document on the matter that scanned clean, read at
its scanned version, in upload order:

- **PDFs** (scanned ones included) are attached as PDF document blocks, and
  **JPEG/PNG/GIF/WebP images** as image blocks, so the model reads pages,
  stamps, signatures and handwriting itself. Each is preceded by a label with
  its number, file name, type and version, so reports cite documents by name.
  The inventory after them also gives each document's id, which tools that
  open a matter document (`render_and_qa_docx`, the form and packet tools)
  take, and the matter section states the date of the run (UTC), which
  skills use for letter dates and deadline margins.
- **Word, text and other files** are attached as their extracted text.
- Everything has to fit the API's per-request limits (32 MB request, 600 PDF
  pages, the image size and count rules) and a 550,000-token share of the
  context window, checked with the token-counting endpoint. What doesn't fit
  falls back to its extracted text if there is room, and otherwise is listed
  as **not reviewed** with the reason, and the model is told to report it as
  such rather than guess. The run never fails just because the case file is
  big. Infected documents are left out and listed as excluded; documents not
  scanned yet or that could not be scanned are left out and listed as not
  reviewed, with the reason.
- Attachments get at most 24 MB of the 32 MB request, or 16 MB for skills
  whose tools keep adding to every later request (`render_and_qa_docx`
  page images, `web_fetch` PDFs). The runner measures each request before
  sending it: past 26 MB it tells the model to finish, `render_and_qa_docx`
  stops adding pages before 30 MB, and a request over 32 MB is never sent
  (the run fails with a message saying so rather than the API's bare 413).
- If the API rejects the attached files on the first request (a 400, or a
  413 for size), the run retries once with every document as extracted text.
- How each document was given to the model is stored on the run, in
  `skill_runs.input_snapshot.documentInput`.

Every loop iteration resends the documents, so the first message carries a
prompt-cache breakpoint; after the first request they are billed as cache
reads.

### How a skill run talks to the model

`src/services/skill-runner/run.ts`, following Anthropic's current guidance
for this model:

- **Model:** Claude Opus 5.5 (`claude-opus-5-5`), adaptive thinking, effort
  `high` (this model's API default is `medium`). Every turn is **streamed**,
  which the SDK requires for long outputs, with a per-turn output cap of
  64,000 tokens by default; drafting skills raise it to 128,000 with
  `maxTokens` in their module.
- **Never a truncated report:** a turn that stops at the output cap is
  discarded (its report or tool call is never used) and the model is told to
  take the turn again; a third truncation fails the run with a message
  naming the setting to raise.
- **Refusal fallback:** requests carry the server-side fallback beta
  (`fallbacks: "default"`), so if a safety classifier declines a request the
  API reruns it on Anthropic's recommended fallback model instead of the run
  failing. Which model served each run is recorded.
- **Prompt caching:** the system prompt (SKILL.md, references, recent legal
  updates, practice profile, firm identity, the closing CASE FILE CONTENT
  rules) and the first message (the
  matter documents) each carry a cache
  breakpoint, and the growing tail of the loop is cached automatically.
  Review skills use the 5-minute cache; drafting and research skills, whose
  turns can run longer than 5 minutes, use the 1-hour cache.
- **Bounded:** each skill has a cap on model requests (`maxIterations`,
  default 12) and every run a 3-hour wall clock. The model is told to submit
  what it has two requests before the cap, or when the conversation nears
  the context window (700,000 tokens, measured from the request's last
  sampling iteration in `usage.iterations`, since the top-level usage of a
  turn that ran web tools adds up every server-side iteration) or the 32 MB
  request limit. A turn the API stops with `model_context_window_exceeded`
  (its own web-tool loop outgrew the window) is dropped like a truncated
  one and the model is asked for its report; the third such turn fails the
  run.
- **Short database transactions:** the worker claims a run (queued to
  running) in one transaction, loads its inputs in another, and records the
  result in a third, instead of holding one open for the whole run. The
  matter page now shows "running" while a run works. The pg-boss job for a
  run expires after 4 hours, and a run a crashed worker left "running" is
  failed by the stuck-run sweep (see "Stuck runs, Retry, and worker
  shutdown").
- **Audit:** `skill_runs.input_snapshot.modelRun` holds the model, which
  model(s) actually served the run, stop reasons, and token and web-tool
  usage.

### Generated Word documents

Drafting skills (declarations, briefs, memos, question sets) produce their
deliverable with the generic `generate_document` tool: the model fills in a
structured spec (`src/services/skill-runner/document-spec.ts`) and
`src/services/docx-generator/templates/make_document.py` (python-docx)
builds a firm-neutral document from it: Times New Roman 12, 1 inch margins,
justified body, page numbers, optional caption, counsel block, court
heading, tables, signature blocks and a confidentiality banner. The .docx is
stored on the matter as a `generated_draft` document; `render_and_qa_docx`
then shows the model the rendered pages (LibreOffice + pdftoppm, in the
sandbox described under "Uploads", with a LibreOffice profile that never
updates links or runs macros) so it can fix layout problems before it
reports. It also renders a clean Word document already on the matter, but
only one whose package declares itself WordprocessingML
(`[Content_Types].xml`, checked in `src/lib/documents/ooxml.ts`), never
another zip renamed `.docx`. The report names the document by id,
and the runner rejects a report that names a document the run did not
generate. Each generation saves a new document, so superseded drafts from
the same run stay in the documents list.

Some skills produce their deliverable another way:

- **Firm scripts.** I-130 expedite build, the asylum fee proof packet and
  EOIR written pleadings run adapted copies of the firm's own generator
  scripts (`src/services/docx-generator/templates/<skill>/`), so the
  layout is the firm's exactly. The fee packet produces a filing-ready PDF
  and the same packet as a Word file.
- **Filled government forms.** The asylum packet build (I-589), VAWA packet
  build (I-360, I-485, I-765) and I-90 packet build (I-90, G-28) fill the
  official fillable PDFs with pypdf. The blank form is the one the attorney
  uploaded to the matter, or else the current one the app downloads from
  the form's uscis.gov page; a download is written to the run's
  verification log with its hash and scanned with ClamAV before anything
  opens it, and one that does not scan clean is not used. Signature fields
  are never filled, and the filled form stays fillable.
- **Corrected copies.** Orthography check does not rebuild the author's
  file: its `make_corrected_copy` tool edits only the text of each fix in
  the uploaded Word or text file (Word: directly or as tracked changes), and
  the report lists what the extracted text left out (text boxes, footnotes,
  comments) as not checked.

### Firm identity

The firm's skills were written for one firm and name it, its attorney and
its contact details. Each tenant enters its own on the **Firm** page
(`/firm`): letterhead details (legal name, address lines, phone, fax, email,
website, an optional licensure line) and a roster of attorneys and
accredited representatives (name, title, role, bar state and number, EOIR
ID, email, default signer), each with an optional signature image. Only
owner/admin and attorney users can change any of it, and every change is
audited (see "Audit log").

- **Skill runs.** A run stores the firm identity it was queued with in
  `skill_runs.input_snapshot.firmIdentity`, and its system prompt ends with
  a FIRM IDENTITY section telling the model to use this firm and its default
  signer (or the roster member the case note names) wherever the skill text
  names the original firm, its attorney or its contact details. Missing
  details become bracketed placeholders such as [FIRM NAME], and the report
  flags that firm identity setup is incomplete.
- **Generated letters.** The I-130 expedite letter's letterhead and signature
  block are filled in by the app from the firm identity, never by the model
  (`src/services/docx-generator/templates/i130-expedite/`, an adapted copy of
  the skill's script): the signer's signature image when one is on file,
  otherwise a `/s/` line, or blank space when the case note asks for a wet
  signature. Each use of a signature image is audited as
  `firm_signature.applied`. The asylum fee proof packet's counsel block,
  signature blocks and certificate of service signer are filled the same way
  (`src/services/docx-generator/templates/asylum-fee-proof-packet/`, an
  adapted copy of the skill's `scripts/fee_packet.py`); its PDF and Word file
  each record `firm_signature.applied` when the signature image is used.
  Written pleadings take their counsel block and signer from the firm
  identity too, with the firm's bare signature line for ink unless the case
  note asks for the pleadings to be signed.
- **Who signs, decided by the app** (`src/services/skill-runner/tools/shared/signer.ts`).
  The model reads the matter's documents, and a document can carry text
  written to change who signs, so the model's tool input alone never
  decides it: the signer is the default signer unless the model names
  another roster member whom the case note also names; the pleadings are
  signed only when the case note itself asks; and a stored signature image
  goes on a document only in a run queued by an owner/admin or attorney
  (the requester's role is recorded at enqueue as
  `input_snapshot.requesterRole`). A paralegal's run gets the `/s/` line
  instead, and the report says an attorney must sign or run the skill
  again. A generated document is still a matter document that every role,
  `read_only` included, can download, embedded signature and all.
- **Other drafts and forms.** A document built with `generate_document`
  prints a letterhead only when the model asks for the firm letterhead,
  which the app fills from the firm identity (for example, the closing
  statement's letter); any other counsel or signature lines in such drafts are written from
  the FIRM IDENTITY section and carry no signature image. The form tools
  fill preparer and representative fields from the firm identity and refuse
  firm or roster details typed by the model.
- **Signature images** are PNG or JPEG up to 512 KB and 2400 x 1200 px,
  uploaded through the app (not straight to S3), checked from their content,
  and stored re-encoded without metadata under
  `tenants/<tenant>/firm-signatures/` in the documents bucket. They take this
  stricter image-only validation instead of the ClamAV scan (the reasons are
  in `src/lib/firm-identity/signature-image.ts`), so they work without the
  worker. The browser sees one only as a 60-second preview, and only for
  owner/admin and attorney users. Removing a signature or a roster entry
  removes the app's reference to the image; the object itself stays in S3,
  because the app's IAM user has no delete permission. Add an S3 lifecycle
  rule (or `s3:DeleteObject` and a cleanup step) if removed images must be
  purged.

### Web research and the verification log

The research skills (country-conditions research, legal-argument research),
and the skills that verify authority or filing rules on the web (bench memo,
EOIR filing compliance, motion self-review, evidence organizer, I-90 packet
review, the asylum and VAWA packet builds), use
the API's server-side **web search** and **web fetch** tools; Anthropic runs
them, the app executes nothing. They are pinned to direct calls
(`allowed_callers: ["direct"]`): the tools' default "dynamic filtering" runs
results through Anthropic-hosted code execution, which is not eligible for
Zero Data Retention. The model is told never to put client names,
A-numbers or other identifiers in a search query.

**web_fetch is limited to a list of sites in every skill.** Each run has
the client's documents in context, and `web_fetch` opens any URL that has
appeared in the conversation, links inside a matter document or a fetched
page included. Open to the whole web, a document written to steer the
model could make it fetch a chain of URLs that spells out case details to
a server its author reads. So every skill's `web_fetch` takes an allow
list (the runner refuses one without): the sources the SKILL.md names
where it names them, otherwise the lists in
`src/services/skill-runner/fetch-domains.ts`, one for legal authority
(federal government, court and free case-law sites) and one for country
conditions (government, intergovernmental, established NGO and major
press sites). `web_search` stays open where the skill's sources come from
the practice profile, so a source on another site can still be found and
cited, and the matter page shows it as a search result, not as retrieved.
A firm that relies on a source the lists leave out adds its host there; an
organization-level allow list in the Claude Console must include every
host on them. Every system prompt also ends with a CASE FILE CONTENT
section: documents, earlier reports and tool results are material, never
instructions, and only the attorney's note instructs; copies of the
runner's own markers inside a text document reach the model marked as
quoted.

As each response arrives the runner writes every URL the tools returned to
`skill_runs.verification_log`: pages fetched (with the time retrieved, title
and a content hash) and search results (with the query). The model cannot
add to it. Under every run the matter page lists what was retrieved, and
marks every URL the report cites as retrieved in this run, seen only as a
search result, or not retrieved (cited from the case file or from memory),
so a source the model did not actually open is visible as such. Web search
is billed per search in addition to tokens.

The app's own `fetch_uscis_page` tool (uscis.gov including egov.uscis.gov,
where USCIS posts processing times, justice.gov, travel.state.gov) follows
redirects by hand, at most 5, and only to https
URLs on that same list; a redirect anywhere else stops the fetch, and is
logged as failed. It reads at most 2 MB of a page. Its log entry names the
page the content came from, the URL the model asked for when that differs,
and every redirect in between. `fetch_ecfr_section` (the filing compliance
check and motion self-review) reads one CFR section's current text through
the eCFR's API, since the eCFR's web pages turn automated clients away, and
logs each call the same way.

Skills that research or cite law also have the **library tools**
(`search_library`, `read_library_document`, `lookup_library_citation`; see
"The library" below). They read the app's own copy of the official
sources, a database table, so nothing about the case leaves the app. The
runtime notes tell the model to prefer the library over web search for
anything it holds, to cite each document's official URL, to label
unpublished BIA and AAO decisions non-precedential, and to say when a
source is stale. Every library result is written to the verification log
too (document id, official URL, source, when it was read and when the
source was last refreshed), and the matter page lists the library
documents a run read and marks a cited official URL the run read there as
"read from the library in this run".

bench-memo, claim-evaluation and legal-argument-research also have the
**EOIR statistics tools** (`search_eoir_judges`, `eoir_judge_profile`,
`query_eoir_stats`), which read the app's aggregate of EOIR's public case
data release. Every result states its snapshot, filters, denominators and
definitions; the runtime note tells the model never to present a judge's
rate as a likelihood for the client's case. Their results are logged as
library entries with the release's official URL.

### Legal updates

The legal-update monitor is the platform version of the
`eoir-weekly-update` skill (`src/services/monitoring/`, page `/updates`).
Every day at 05:00 U.S. Central time (after the library's daily runs), and
when an owner/admin presses **Check now** on `/updates`, the worker checks
the official sources listed in
`skills-content/eoir-weekly-update/references/sources.md` (AG and BIA
precedent, EOIR policy memoranda, the Immigration Court and BIA Practice
Manual update lines and the Policy Manual's table of changes, EOIR notices,
and immigration opinions from the courts of appeals), plus USCIS form
updates, USCIS Policy Manual updates and the Federal Register API. Only one
check runs at a time.

- **Fetching** goes through the library's polite HTTP client
  (`src/services/library/http/fetch.ts`): https only, each source's host
  allow list checked on every redirect, size and content-type limits,
  robots.txt honored (with its Crawl-delay), one request at a time per
  host, and backoff on 429 and 503. A page whose layout the parser no
  longer recognizes fails that source's check; it is never read as a quiet
  week.
- **Baseline.** The first successful check of each source records what is
  already published as the baseline, so turning the monitor on does not
  flood the feed. Later checks store each new item with the source's own
  text and link.
- **Summaries.** For an item whose listing is not enough, the linked PDF is
  read and passages are quoted through the API's citations feature, with
  page numbers. Claude then summarizes and routes the item strictly from
  that text, with `routing.md`, `sources.md` and the routing target files
  in its system prompt. Code checks every passage the summary relies on
  against the source text (an item with no verified passage is not
  published) and applies `routing.md`'s routing table and other-circuit
  screen itself. Each check summarizes at most 40 items and reads at most
  25 documents within 90 minutes; the rest wait for the next check.
- **Firm review.** Every item is flagged for attorney verification.
  Attorneys and owner/admins mark items reviewed with an optional note
  (audited as `legal_update.review`, without the note); the nav shows how
  many items of the last 90 days the firm has not reviewed. `/updates`
  also shows each source's result for the latest check.
- **Skill runs.** When a run is queued, the published items of the last 90
  days routed to its skill (at most 15) are stored in
  `skill_runs.input_snapshot.legalUpdates` and added to its system prompt
  as a RECENT LEGAL UPDATES section, after the skill's references. The
  section quotes the official text, gives each item's link, and tells the
  model to treat every item as unverified. Runs queued before the monitor
  existed have no such section.
- **Fed by the library.** Documents a library daily run finds for the
  first time in the sources the feed follows (BIA, AG and AAO precedents,
  the Supreme Court's immigration opinions, the USCIS Policy Manual and its
  updates, USCIS alerts, memoranda and forms, the fee schedule, TPS, EOIR
  memoranda, manuals and forms, the Federal Register, the Visa Bulletin
  and USCIS's filing charts; court of appeals opinions come from the
  monitor's own court checks) are added
  as items too, after each source's first successful daily run (the
  baseline), and summarized by the check like any other item. An item the
  monitor already has (same official URL, or the same Interim Decision or
  FR document number) is not added twice, in either direction. `/updates`
  filters them under "Library collections" and links each to the library's
  copy.
- **Not covered.** The Second Circuit has no machine-readable opinion list,
  so it is reported as not checked on every run. The monitor records the
  practice manuals' update lines and table-of-changes rows but does not
  compare chapter text. Court weight lines and the other-circuit screen
  follow `routing.md`, which is written for a Fifth Circuit firm.

The legal-update tables (`legal_updates` and its run tables) are global:
any tenant may read them, only the monitor writes them. Each firm's reviews
(`legal_update_reviews`) are tenant data like everything else.

### The library

The app keeps its own library of the public, official sources of
immigration law (`src/services/library/`, page `/library`), collected
directly from the government and court sites and refreshed every day. It
depends on no third-party research service (two optional collectors use
CourtListener, a third-party index of court opinions; they stay off until
the firm decides to give them a token, see `docs/LIBRARY.md` section 12).
`docs/LIBRARY.md` is the full
guide: the tables, the collector (adapter) contract, the registry, the
probe script, scheduling, licensing and politeness. In short:

- **Data.** Migration 0007 adds global tables (`library_sources`,
  `library_documents` with a weighted full-text index and trigram indexes,
  `library_document_versions`, `library_citations`, `library_fetch_runs`,
  `library_backfill_state`, `library_http_cache`) and the `pg_trgm`
  extension; 0008 adds the EOIR statistics aggregates (`eoir_stats_*`),
  0009 the index behind the search's country filter, and 0010 the manual
  import (the `manual` source status, the `manual_import` run kind and the
  append-only `library_import_log`), and 0011 the index behind a search
  with filters and no words. Like `legal_updates`,
  every role may read them and only the worker writes them, in service
  context; no tenant data goes in, and no client data goes out to the
  sources.
- **Collection.** 93 collectors, one per official source, cover the 25
  catalog groups on `/library` and EOIR's case data
  (`src/services/library/adapters/`; `docs/LIBRARY.md` section 12 lists
  every source, what it holds, and how it fared in the last live test).
  State penal codes and state court decisions on criminal statutes are
  shown as planned and not collected. Each source has a daily run
  (staggered from 01:00 U.S. Central time) and a background backfill that
  walks its history in resumable chunks, immigration core first. Requests
  identify the collector, honor robots.txt and its Crawl-delay
  (justice.gov and uscis.gov ask for 10 seconds, gao.gov for 7 minutes),
  go one at a time per host, back off on 429 and 503, and use conditional
  requests where the site supports them. PDFs are read with pdf.js in a
  worker thread (no poppler needed), with the sandboxed `pdftotext` as a
  fallback on the worker image. US government works are stored in full;
  sources whose terms restrict reuse (UN treaty records, the UNHCR
  Handbook, UK Home Office notes, EUAA reports, O*NET) keep metadata, a
  short excerpt and the official link.
- **Sites that refuse the collector.** At the last live test, www.state.gov,
  2009-2017.state.gov and travel.state.gov (the Visa Bulletin, country
  reports, consular, reciprocity and adoption pages, press releases),
  www.uscirf.gov, www.unhcr.org, acf.gov (ORR) and www.fna.usda.gov answered
  the collector with HTTP 403. Nothing works around a block. The 13 sources
  of `docs/LIBRARY_SOURCES.md` section 1 are kept up to date by hand
  instead (next item); any other source that is refused fails with that
  message on `/library` until the site allows the collector (set
  `LIBRARY_USER_AGENT_CONTACT` so its administrators can reach you) or you
  turn it off with `LIBRARY_DISABLED_SOURCES`.
- **Import from official site** (`/library/import`,
  `src/services/library/manual-import.ts`). For the sources in
  `LIBRARY_MANUAL_SOURCES` (by default those 13), a platform operator opens
  the official page in their own browser, saves it ("Save page as",
  "Webpage, HTML only") or downloads the official PDF, and gives the app the
  file with its official address. The app checks the address (https, on
  the source's hosts, a path its collector reads) and the file (HTML or PDF
  by its own bytes, at most 9 MB, not an Internet Archive copy, not a page
  that names another address as its own), parses it with the collector's
  own parser, runs the usual checks and versioned upsert, and records a
  `manual_import` run, `metadata.importedManually` (who, when, the file's
  SHA-256) and a `library_import_log` row for every attempt, refused ones
  included. Those sources get no daily run or backfill (they would fail
  every day with HTTP 403); `/library` shows them as "Manual import" with
  the last import date, and "Overdue" when none came within the source's
  expected interval (35 days for the Visa Bulletin, ORR and press releases,
  400 for the country reports, 100 for the rest).
  **Who may import:** only the Clerk user ids in `LIBRARY_IMPORT_ADMINS`,
  set on the web app. This is deliberately not a firm role: the library is
  one copy shared by every firm, so an import changes what every firm's
  pages and skill runs read, and a firm's own `owner_admin` (which each
  firm grants itself in Clerk) cannot be the gate. The operators who run
  the deployment are. The per-tenant audit log cannot hold these entries
  either, hence the global, append-only `library_import_log`.
- **Reading.** `/library` lists the groups with each source's document
  count, last successful update, status and official site;
  `/library/search` searches with filters (group, source, dates, court,
  country, precedential only); each document has a reader page.
  `/library/eoir-statistics` has the judge and court statistics. Read-only
  for every role. Every read of the library and the statistics, from a page
  or a skill run, runs with a Postgres `statement_timeout` (5 seconds for
  a search, 10 for the rest), so a broad search cannot hold the database
  every firm shares; a search matching more than 5,000 documents lists the
  newest first instead of ranking them all, and says so. Skill runs use the library tools (see "Web research and
  the verification log"); bench-memo, claim-evaluation and
  legal-argument-research also have the EOIR statistics tools.
- **EOIR statistics.** The `eoir-stats-load` job (03:41 Central daily)
  checks EOIR's case data release (a 4.5 GB ZIP on
  fileshare.eoir.justice.gov) and, when a new one is posted, streams the
  four tables it needs by range requests (about 1.2 GB) into the 0008
  aggregates: counts by judge, court, fiscal year, nationality, custody,
  representation, application and appeal, never a case or a person. Only
  the current snapshot is kept. `npm run eoir-stats:load [-- --force]` runs
  it by hand; `EOIR_STATS_LOAD=paused` stops it.
- **Environment.**

  | Variable | Default | What it does |
  | --- | --- | --- |
  | `LIBRARY_BACKFILL` | on (`.env.example` sets `paused`) | `paused` stops every history walk; daily runs go on |
  | `LIBRARY_BACKFILL_PAUSED_SOURCES` | none | source codes whose history walk is paused |
  | `LIBRARY_DISABLED_SOURCES` | none | source codes with no daily run and no backfill (`eoir_case_data` here also stops the statistics load) |
  | `LIBRARY_MANUAL_SOURCES` | the 13 sources of `docs/LIBRARY_SOURCES.md` section 1 | source codes kept up to date by import from the official site: no daily run, no backfill, "Manual import" on `/library`; `none` for no source. Set the same value on the worker and the web app |
  | `LIBRARY_IMPORT_ADMINS` | none (nobody can import) | Clerk user ids of the platform operators who may use `/library/import` (web app) |
  | `LIBRARY_DAILY_CONCURRENCY`, `LIBRARY_BACKFILL_CONCURRENCY` | 2 and 2 in code; `fly.worker.toml` sets 4 and 3 | daily runs and backfill chunks at once, each at most one per host |
  | `LIBRARY_DAILY_RUN_MINUTES`, `LIBRARY_BACKFILL_CHUNK_MINUTES` | 100, 50 | time budget of one daily run and one backfill chunk |
  | `LIBRARY_STORE_ORIGINALS`, `LIBRARY_S3_BUCKET` | off; the documents bucket | `true` keeps each fetched official file of a public domain source in S3 under `library/` (the IAM user then needs `s3:PutObject` and `s3:GetObject` there) |
  | `LIBRARY_USER_AGENT_CONTACT` | none | an email or URL added to the collector's User-Agent |
  | `LIBRARY_HOST_SPACING_MS` | 1000 | the least spacing between two requests to one host (a robots.txt Crawl-delay raises it, to 10 minutes at most) |
  | `LIBRARY_MAX_PDF_MB`, `LIBRARY_PDF_CONCURRENCY`, `LIBRARY_PDF_MEMORY_MB`, `LIBRARY_PDF_TIMEOUT_SECONDS`, `LIBRARY_PDF_MAX_PAGES`, `LIBRARY_PDF_MAX_CHARS`, `LIBRARY_PDF_FALLBACK` | 60, 1, 512, 120, 3000, 5,000,000, on | PDF size cap and text extraction limits |
  | `LIBRARY_MAX_RETRY_AFTER_SECONDS` | 300 | the longest Retry-After a request waits for |
  | `COURTLISTENER_API_TOKEN`, `COURTLISTENER_API_LIMITS` | unset; `5/minute,50/hour,125/day` | the two CourtListener collectors (see the third-party note in `docs/LIBRARY.md` section 12 before setting it) |
  | `API_DATA_GOV_KEY` | unset | GovInfo district court decisions and Regulations.gov |
  | `CONGRESS_GOV_API_KEY` | unset | CRS reports (Congress.gov API) |
  | `EOIR_STATS_LOAD` | on | `paused` stops the EOIR statistics load |

  A collector whose key is unset is skipped and shown on `/library` as
  "Needs API key" with the variable's name.
- **Backfill.** Each source's history walk resumes where it stopped
  (`library_backfill_state`), one chunk of at most 50 minutes at a time,
  kicked hourly and at worker start, in the order of `groups.ts`
  (BIA and AG precedents, statutes and regulations, the USCIS Policy
  Manual, the EOIR manuals, the FAM, the Visa Bulletin, the circuits and
  the Supreme Court, then the rest). The core groups finish in the first
  days; the long walks take weeks at the sites' pace: the AAO non-precedent
  decisions about three weeks of uscis.gov, the unpublished BIA decisions
  4 to 10 days of foia.eoir.justice.gov, GovInfo's courts of appeals several
  days, and CourtListener's history (if enabled) months on a free account.
  A source's first daily runs, before its history is in, fetch up to its
  daily maximum (often 200 to 500 documents), so in the first days the
  runs on uscis.gov and justice.gov go past 05:00; what a run does not
  reach waits for the next one.
  To start one source's history over, set its `library_backfill_state` row
  to `status = 'pending', cursor = NULL` as the owner role; stored
  documents are kept and skipped by fingerprint.
- **Storage, after the full backfill (estimates from the sampled
  documents).** Postgres: roughly 5 to 10 GB, most of it the AAO
  non-precedent decisions (about 170,000 with text) and the court opinions;
  the 280,000 unpublished BIA decisions are scans stored as listing facts
  only (well under 1 GB); the EOIR statistics about 0.5 GB. S3, only with
  `LIBRARY_STORE_ORIGINALS=true`: roughly 250 to 300 GB (unpublished BIA
  scans 100 to 150 GB, AAO PDFs about 100 GB, the rest tens of GB). Size
  the Neon plan and the bucket before turning backfill on in production.
- **Checks without a database server.** `npm run library:probe --
  <source>` runs one collector live against its official site and prints
  what it would store. `npm run library:smoke` does the same for every
  source at once (listing, first backfill chunk, two documents each), paced
  as the worker paces them. `npm run library:db-check` applies every
  migration to PGlite (in memory) and checks row-level security, the store
  (versions, citations, backfill, the legal-update feed, per-source listing
  validators), the manual import (provenance, versions, refusals and the
  append-only import log) and the search, country filter, lookup and reader queries;
  `-- --live 3` adds three live decisions from EOIR and `--live-source
  <code>[:N]` any registered source. `npm run eoir-stats:check` checks the
  EOIR statistics load and queries on PGlite.

### The Claude and ChatGPT connector

The app is also a remote MCP server at `<app origin>/api/mcp` that a firm's
members add to Claude (custom connector) or ChatGPT (custom MCP server),
each signing in with their own app account through OAuth, with Clerk as the
authorization server. `docs/CONNECTORS.md` is the full guide: the tools,
setup for the firm and for the platform, authentication, privacy, directory
submission, the requirements it was built to and what has not been verified.
In short:

- **Library tools for everyone:** `search` and `fetch` (the shapes ChatGPT
  deep research and company knowledge expect), `search_library`,
  `read_library_document`, `lookup_library_citation` and the three EOIR
  statistics tools. Read-only, global data, official URLs as citations.
- **Case-work tools per firm:** `list_matters`, `get_matter` (details,
  documents list with scan status, recent runs), `list_skills`, `run_skill`
  (editor roles, `confirm: true`, not read-only), `get_skill_run`,
  `list_legal_updates`, and `get_document_download_link` (clean documents,
  5-minute links, only with its own switch). Off until an owner/admin turns
  them on in the Firm page's connector section after acknowledging a
  versioned disclosure (`tenant_connector_settings`, migration 0012; audited
  as `connector_settings.update`). When off, they are not listed at all.
  They are also offered only to OAuth clients on the platform's allow list
  (`CONNECTOR_ALLOWED_CLIENT_IDS`, `CONNECTOR_ALLOWED_CLIENT_ID_PREFIXES`;
  none set means none): anyone can register a client named "Claude" with
  Clerk, so a client id, not a name, is what is trusted. Unlisted client ids
  are recorded (`connector_unrecognized_clients`, migration 0013) and shown
  to the owner/admin on the Firm page. Every case-work call is audited as
  `connector.tool_call`. `get_skill_run` replaces A-numbers and dates of
  birth with a redaction marker; reports still name the client.
- **Identity:** a JWT access token from Clerk carrying the custom scope
  (`practice:connector` by default) and the firm chosen on Clerk's consent
  screen (`org_id`, from the `user:org:read` scope; required, no fallback).
  User and firm resolve to tenant, membership and role through
  `resolveTenantMembership`, as `getCurrentTenant` does; owner/admin follows
  Clerk's current Admin role (cached 60 seconds for reads, read fresh for
  `run_skill` and download links), every other role is the member's row in
  the database, read on every call; banned or locked users are refused.
  Organizations not synced as tenants are refused.
- **Safety:** zod-validated inputs, results framed as quoted data and capped
  at 100,000 characters, an in-memory per-IP limit before authentication,
  Postgres token-bucket rate limits per member and per firm
  (`connector_rate_buckets`), stricter for `run_skill` (including a per-firm
  daily cap, `CONNECTOR_RUN_SKILL_DAILY_LIMIT`, default 50).
- **Routes:** `/api/mcp` and the `/.well-known/oauth-protected-resource`
  (root and `/api/mcp`) and `/.well-known/oauth-authorization-server`
  documents are public in `src/proxy.ts`; the handler authenticates every
  request itself.
- **Environment (web app):** `CONNECTOR_PUBLIC_ORIGIN` (the public origin,
  for example `https://app.example.com`; required in production, where the
  connector answers 500 without it), `CONNECTOR_ALLOWED_CLIENT_IDS` and
  `CONNECTOR_ALLOWED_CLIENT_ID_PREFIXES` (the recognized Claude and ChatGPT
  clients), and optionally `CONNECTOR_REQUIRED_SCOPE`,
  `CONNECTOR_RUN_SKILL_DAILY_LIMIT`, `CONNECTOR_IP_REQUESTS_PER_MINUTE`,
  `CONNECTOR_IP_AUTH_FAILURES_PER_MINUTE` and, rarely, `CLERK_OAUTH_ISSUER`.
- **Locked firms:** while a firm's free month or subscription has ended
  ("Trial, billing and emails" below), `tools/list` offers
  `get_connection_info` only, and every other call is refused with the
  state and the Billing page's URL (`CONNECTOR_PUBLIC_ORIGIN` plus
  `/billing`). During the free month `get_connection_info` says how many
  days are left. Subscribing happens on the website, never in Claude.
- **The Connect page** (`/connect`) is where a new firm lands and what the
  welcome email, the landing page, the Firm page and the nav point to: the
  connector address with a copy button and the steps for Claude (Free, Pro
  and Max; Team and Enterprise) and ChatGPT.

### Trial, billing and emails

Every firm gets its first 30 days free (once per person), then pays $20
per user per month through Stripe. Subscribing and paying happen only on
the website (the Billing page); the connector never asks for payment and
only points a locked firm there. Code: `src/lib/billing/` (the free month,
entitlement, Checkout and the portal, the Stripe webhook, seats, the daily
job, complimentary access), `src/lib/email/` (templates, SES, recipients,
the send log), `src/lib/tenants/` (firm creation, the org sync, the Clerk
webhook's events), `src/app/billing/`, `src/app/(app)/connect/`,
`src/app/(public)/` (the landing, pricing, terms and privacy pages; terms
and privacy are marked DRAFT for the firm's attorneys to finalize),
`src/app/AppShell.tsx` (the lock screen and the banners). Migration
`0014_billing.sql` adds `tenant_billing`, `email_sends` and
`stripe_webhook_events`, and starts a free month for every tenant that
already exists (its backfill runs as the service role, since the tables
force row-level security on their owner too); `0015_per_person_trials.sql`
adds `user_trials`, `firm_creation_attempts`, `tenants.created_by_user_id`
and `deleted_at`, and the billing columns named below.

- **Signup.** A signed-out visitor to `/` sees the landing page; `/pricing`,
  `/terms` and `/privacy` are public too (`src/proxy.ts`, exact paths). After
  sign-up, a user with no firm sees the Create firm form
  (`src/lib/tenants/create-firm.ts`): the action refuses a user who already
  belongs to a firm (in the app's rows or in Clerk) and a user who has
  tried 3 times in the last day (`firm_creation_attempts`,
  `FIRM_CREATION_DAILY_LIMIT`); then the organization is created in Clerk
  through the Backend API with the user as creator (who gets Clerk's
  creator role, Admin, the app's owner/admin), and the tenant (with
  `created_by_user_id`), its membership (`owner_admin`) and its billing row
  are written at once, so nothing waits for
  the org-sync webhook (which then finds the rows). The browser makes the
  firm active in the session and lands on `/connect`. In Clerk, "Allow
  user-created organizations" is **off** ("Clerk" above), so this form is
  the only way a user gets a firm and none of these checks can be skipped
  through Clerk's own components. A firm created in the Clerk dashboard
  gets its tenant and billing row from the webhook (`organization.created`,
  with `created_by` as the creator when Clerk sends it); if a session's
  firm is not synced yet, the app offers a "Set up the firm" button that
  writes the rows.
- **The free month** is `tenant_billing.trial_ends_at` (creation plus
  `TRIAL_DAYS`, default 30), kept in the app, not in Stripe, and given
  **once per person**: when a firm is created, its creator's row is written
  to `user_trials` (`clerk_user_id` primary key; `startBilling` in
  `src/lib/billing/store.ts`), and a creator who already has one gets a
  firm with `trial_ends_at` null, locked from the start (`billing.no_trial`
  in the audit log, reason `no_trial`); its Billing page says the free
  month was already used and Subscribe charges now. Both creation paths
  (the form and the webhook) apply the rule through
  `upsertTenantFromOrganization`. A firm with no known creator (the Clerk
  dashboard) gets the month: there is nobody to pin it on.
- **Entitlement.** `getEntitlement(tenantId)` (`src/lib/billing/entitlement.ts`)
  returns `{ state, reason, trialEndsAt, graceEndsAt, subscription, ... }`
  with `state` one of `trialing`, `active`, `past_due`, `locked`, computed
  on every read and memoized per request: a complimentary firm is `active`
  (`complimentary`); a live Stripe subscription (`active`, or `trialing`
  when the firm subscribed during its free month) wins; a failed payment
  keeps full access for `PAST_DUE_GRACE_DAYS` (7) from `past_due_since`
  with a banner, then locks (`grace_ended`); otherwise the free month until
  it ends; otherwise locked (`trial_ended`, `no_trial`,
  `subscription_canceled`, `subscription_unpaid`, `subscription_paused`). A
  banner shows during the free month's last 7 days and during the grace
  period.
- **The lock.** While a firm is locked nothing works but the Billing page
  and sign-out: every page under `src/app/(app)` shows the lock screen
  (Subscribe for the owner/admin, "ask your firm's owner" for the rest)
  while the Billing page stays reachable (it lives in `src/app/billing` for
  that reason); **every Server Action and route handler under
  `src/app/(app)` starts with `getCurrentEntitledTenant(action)`**
  (`src/lib/tenant.ts`: `getCurrentTenant` plus `requireEntitled`, which
  throws `EntitlementLockedError` with a message that says to subscribe),
  before its role check, whether it changes data (matters, clients,
  parties, matter details, uploads, scans, skill runs and retries, the
  firm identity and signatures, the connector settings, the practice
  profile, legal-update reviews and checks, library imports) or discloses
  it (document download URLs, the library's stored originals, a route
  handler the layout's lock screen does not cover); only the Billing
  page's actions and the onboarding actions use plain `getCurrentTenant`.
  A new action copies the first line of any existing one; the rule is also
  in `docs/ADDING_A_SKILL.md`. The worker re-reads the entitlement when it
  goes to start a queued run and fails the run instead (`skill_run.failed`
  with reason `firm_locked`; Retry works once the firm subscribes), and a
  firm may have at most 25 runs waiting (`QUEUED_RUNS_PER_TENANT_MAX`). The
  connector offers `get_connection_info` only.
- **Subscribing** (owner/admin only, `BILLING_ROLES`): the Billing page shows
  the state, the member count (one seat per member, every role) and the
  monthly amount. Subscribe is refused while the firm has any subscription
  that is not canceled (the portal is where that one is changed) and for a
  complimentary firm. It creates a Stripe Checkout Session in subscription
  mode for the per-user Price (`STRIPE_PRICE_ID`) with `quantity` = member
  count, on a Stripe customer created once per tenant
  (`metadata.tenant_id`) and reused; the session's `metadata.tenant_id` is
  the one thing the webhook reads to find the firm. The Checkout Session
  the firm opened before and did not finish (`checkout_session_id`) is
  expired in Stripe first, so two open Checkout pages can never both end
  in a subscription. While the free month still has more than two days to
  run, `subscription_data.trial_end` is set to the free month's end so the
  first charge is then (Stripe needs a trial end at least 48 hours out);
  closer to the end, or for a firm with no free month, the card is charged
  at once and the button says so. Manage billing opens Stripe's Customer
  Portal with a configuration the app creates and maintains itself
  (`src/lib/billing/portal.ts`: update the card, see invoices, cancel at
  the end of the period, change the billing contact; no quantity or plan
  changes, no pausing), so the dashboard's portal settings are not used.
  Both are audited. Stripe is called between short transactions, never
  inside one (`customers.create`, `sessions.expire`, `sessions.create`,
  `subscriptions.update`, `subscriptions.cancel`). A refusal comes back to
  the page as `?error=<code>`, mapped to fixed text
  (`src/lib/billing/errors.ts`); the cause is logged, never put in the URL.
- **The webhook** at `/api/webhooks/stripe` (public in `src/proxy.ts`,
  signature verified with `STRIPE_WEBHOOK_SECRET` against the raw body)
  handles `checkout.session.completed`, `customer.subscription.created`,
  `.updated`, `.deleted`, `invoice.paid` and `invoice.payment_failed`
  (`src/lib/billing/stripe-webhook.ts`). It never applies the payload: it
  retrieves the subscription (and an invoice, and its subscription) from
  Stripe first, outside any transaction, then in one service-context
  transaction claims the event id in `stripe_webhook_events`, locks the
  firm's `tenant_billing` row `FOR UPDATE`, applies Stripe's current state,
  queues the emails it calls for through pg-boss in that same transaction,
  and marks the claim `applied_at`; it commits as a whole or answers 500
  before anything is committed (Stripe retries). A redelivered id is
  answered 200 "Already processed"; a claim older than 10 minutes with no
  `applied_at` (the request died) is taken over by the next delivery; rows
  older than 7 days are pruned by the daily job. `applySubscription`
  (`src/lib/billing/subscription-sync.ts`) keeps `tenant_billing` in step
  (`subscription_status`, seats, `current_period_end`,
  `cancel_at_period_end`, `past_due_since`, `subscription_created_at`,
  `locked_at`) and refuses, in order: a subscription whose item is not on
  `STRIPE_PRICE_ID` (logged, applied false); one of a customer other than
  the firm's stored customer; for the stored subscription, a live status
  after a terminal one (`canceled`, `incomplete_expired`); a different
  subscription that is not live or is older (Stripe's `created`) than the
  stored one. A newer live subscription replaces the stored one, and if
  the stored one is still open in Stripe it is canceled at once with
  proration after the commit (`billing.subscription_canceled`, reason
  `superseded`), so a firm is never billed twice; a quantity that differs
  from the member count is set right after the commit. The checkout event
  is accepted only with `metadata.tenant_id` and only when its customer is
  the firm's stored customer. Every paid invoice is audited
  (`billing.invoice_paid`: amount, currency, period, seats). A stale
  `invoice.payment_failed` (the invoice is paid or void by now) records
  nothing.
- **Seats.** When the Clerk webhook adds or removes a membership, the
  subscription's one item is set to the member count (Stripe prorates by
  default) and `seats` stored; the Stripe webhook does the same when a
  subscription event's quantity differs from the member count; and the
  daily job first brings the firm's membership rows in step with Clerk's
  organization membership list (rows added and removed; an Admin's row
  `owner_admin`, a Member's row keeping the app role the firm gave them;
  skipped when the list cannot be read whole or is empty) and then sets
  the seats for every subscribed firm, so a missed delivery is made good
  within a day.
- **Firm deletion.** `organization.deleted` from Clerk marks the tenant
  deleted (`tenants.deleted_at`, a soft delete: the rows, the audit log,
  the billing history and the creator's used free month stay), removes its
  membership rows, cancels a live Stripe subscription at once with
  proration (`billing.subscription_canceled`, reason `organization_deleted`,
  and `tenant.deleted`), and from then on `getCurrentTenant`, the connector,
  the daily job and the emails all skip the firm. Nothing restores a
  deleted firm but the operator, by hand. Only Clerk's Admin role has
  Delete organization; do not give it to the Member role ("Clerk" above).
- **Emails** (`src/lib/email/`, plain text plus a simple HTML copy, no
  special characters) go to the firm's owner/admin members, at their
  **verified** addresses only (the primary when it is verified, else the
  first verified one), read from Clerk when sending (through
  `@clerk/backend`, which loads in the worker; `@clerk/nextjs/server` pulls
  in Next's client-side navigation module and does not) and never stored
  beyond the count. Each is sent at most once per tenant and occasion through
  `email_sends` (unique on tenant, kind and dedupe key): the row is the
  claim, inserted before SES is called, filled with SES's message id after,
  and deleted when SES refuses (so the retry sends); a crash in between
  leaves the claim, and the email is never sent twice. The kinds: the
  **welcome** (the free month, or that there is none, the Connect page, the
  connector address) at firm creation; the free month's **last week** and
  **last day** reminders and the **trial ended** notice (keyed by the
  trial's end); the **subscription confirmation** (keyed by the
  subscription); a **receipt** after every paid invoice with an amount,
  with the amount, billing period, seats and Stripe's hosted invoice link
  (keyed by the invoice); an **upcoming renewal** notice 7 days before each
  period ends (keyed by the period end); a **renew reminder** 3 days before
  a scheduled cancellation takes effect; **payment failed**, naming the
  grace period's end and Manage billing (keyed by the invoice); and after a
  subscription lapses and the firm is locked, a **subscribe again**
  reminder on lock day, then 7 and 14 days later, at most three. Every
  email is one pg-boss job on the `billing-email` queue (one in flight per
  tenant, kind and key; retried on an SES error), written in the
  transaction of the change that calls for it, worked by the worker; the
  daily job (`billing-daily`, 09:00 US Central, single-flight) queues the
  reminders due, records locks and unlocks, refreshes each subscribed
  firm's subscription from Stripe, cancels any extra subscription Stripe
  holds for the firm's customer (and adopts a live one the app missed),
  reconciles memberships and seats, and prunes old webhook and attempt
  rows. Without `SES_FROM_ADDRESS` each email is logged and skipped; the
  worker needs `CLERK_SECRET_KEY`, `STRIPE_SECRET_KEY` and
  `CONNECTOR_PUBLIC_ORIGIN` (the links). In the Stripe dashboard, keep
  Stripe's own "successful payments" customer emails off (Settings >
  Business > Customer emails) so firms do not get two receipts; the app's
  receipt links to Stripe's hosted invoice.
- **Complimentary access** (the operator's own firm):
  `tenant_billing.complimentary` makes the firm entitled without a
  subscription and stops its billing emails. It is set only from the
  command line, `npm run billing:comp -- <tenant id> on` (`off` takes it
  away; without `on`/`off` it prints the firm's standing), against
  `DATABASE_URL` in service context, and every change is audited as
  `billing.complimentary_set` with the operating system user who ran it.
  The tenant id is `tenants.id` (`SELECT id, name FROM tenants`). A
  complimentary firm with a Stripe subscription still pays it: cancel it
  in the portal or the dashboard.
- **Setup:** `npm run stripe:setup` creates the Product "MeritDesk.AI" and
  the $20 per-unit monthly Price with `STRIPE_SECRET_KEY` and prints
  `STRIPE_PRICE_ID` (idempotent, by lookup key). Environment: `STRIPE_SECRET_KEY`,
  `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `SES_FROM_ADDRESS`, `TRIAL_DAYS`
  (30), `PAST_DUE_GRACE_DAYS` (7); the rest is in DEPLOY.md ("Billing with
  Stripe", "Emails with SES").
- **Limits.** No taxes or VAT handling (enable Stripe Tax and
  `automatic_tax` if needed), no annual plan, no refunds in code (a
  superseded or deleted firm's subscription is canceled with proration,
  which credits the customer's balance), and the terms and privacy pages
  are drafts. The rows of `tenant_billing` are never deleted.

### Running document generation locally (I-130 expedite build and drafting skills)

The same applies to every skill with `generate_document` or
`render_and_qa_docx`: locally the tool returns the "not installed" error to
the model, which then reports the document as not generated (an empty
document id) instead of the run producing a file.

I-130 expedite build shells out to `python3`, `soffice` (LibreOffice headless), and
`pdftoppm` (poppler-utils) — see `src/services/docx-generator/generate.ts`.
**None of these are installed by default on Windows dev machines and this
wasn't set up as part of the build.** Without them, triggering
`i130-expedite-build` will fail with a clear "binary not found" error at the
`generate_docx` step (everything before that — the live USCIS verification
fetches — still works, since those only need network access). To actually
test the docx pipeline locally, either:

- Install Python 3 + `pip install -r requirements.txt` + LibreOffice +
  poppler-utils directly (requirements.txt also brings pypdf for the form
  fillers, and pdfplumber, Pillow, numpy and reportlab for the asylum fee
  proof packet, which also needs `qpdf`; the form tools' uscis.gov downloads
  need `clamscan`, and are refused without it), or
- Run it inside a Linux container/WSL that has all three, or
- Wait until this deploys to the Fly.io worker (see below), which bundles
  them by design.

## 3. What's deliberately not built yet

This is a first slice of the architecture plan, not the full product. The
code type-checks, lints and builds (`next build`), but most of it has never
run: the machine it was written on has no Postgres, Docker, ClamAV,
LibreOffice, poppler or Python. Treat nothing here as working until the
matching item in "5. First deploy checklist" has been done.

- **Never run end to end.** The migrations (row-level security, and 0006's
  fix to how the policies read the tenant setting) and the runtime-role
  check against a real database; pg-boss and the worker; the Clerk webhook;
  the tool sandbox (uid pool, namespaces, limits) and every tool in it;
  browser uploads with the encryption header and the bucket's CORS rule;
  the Anthropic requests (web tools, fallback beta, token counting); the
  legal-update monitor's fetches and summaries; the Claude and ChatGPT
  connector's OAuth with Clerk and its use from Claude and ChatGPT
  (`docs/CONNECTORS.md` section 8 lists what was checked in-process). There
  is no automated test suite.
- **The Python generators and form fillers** (the asylum fee proof packet,
  written pleadings, the orthography corrected copy, and the I-589, VAWA
  and I-90 form fillers) have not run anywhere: there was no Python where
  they were written. Generate one of each on the worker image before
  relying on them.
- **26 of the firm's 29 skills** are wired up as matter skills; all 29 are
  in `skills-content/`, copied from the firm's two Claude plugins.
  `docs/ADDING_A_SKILL.md` section 7 lists each one's tools and limits.
  The other 3 are not matter skills: `cold-start-interview` and `customize`
  are replaced by the Practice Profile pages, and `eoir-weekly-update`
  drives the legal-update monitor (see "Legal updates"). Wiring or changing
  a skill is the recipe in `docs/ADDING_A_SKILL.md`.
- **Earlier runs' output.** Skills that build on another skill's output
  read only the latest completed report of that skill on the same matter
  (`read_prior_skill_reports`); they cannot pick an older run or see one
  still queued or running, so run the skill another builds on first. A
  Word document a skill generated is a matter document, so later runs read
  it too.
- **No alerting.** Failed runs are not retried automatically (by design;
  Retry is manual), and stuck runs are failed by the sweep, but nobody is
  notified when runs fail or the worker is down, beyond the run status on
  the matter page and the worker's logs.
- **Billing has not run against Stripe or SES.** Self-serve signup, the
  free month (once per person), Stripe Checkout, the Customer Portal and
  its code-managed configuration, the webhook (retrieving every object
  from Stripe, out-of-order and stale events, superseded subscriptions),
  seat sync, membership reconciliation, firm deletion, complimentary
  access and the emails are built ("Trial, billing and emails") and
  checked in-process against PGlite with constructed, signed Stripe
  events and stubbed Stripe and Clerk calls; the first real Checkout,
  webhook delivery, portal session, subscription cancellation and SES
  send are on the first deploy checklist. Taxes, refunds and an annual
  plan are not built.
- **The library** holds what its collectors have collected. Every
  collector has run live from a development machine, but none has run in
  the deployed worker against Postgres, and its history is empty until the
  backfill has run. State penal codes and state court decisions on criminal
  statutes are planned, not collected. Several sites refuse the collector
  (see "The library": the State Department's sites, USCIRF, UNHCR, ORR,
  USDA), the CourtListener, GovInfo district and CRS collectors wait for
  their API keys, and some material cannot be collected at all (BALCA's
  decision files and HUD: robots.txt or the site refuses; the Canadian IRB:
  form-only listings and restrictive terms; GAO's archive since 2009).
  No OCR is run, so a scanned PDF without a text layer is stored with its
  metadata and link only (every unpublished BIA decision EOIR posts is
  such a scan), and full-text search covers the first 200,000 characters
  of a document. The library records later treatment of a decision only as
  "cited by" counts, not as a citator. Its pacing is per worker process:
  with more than one worker machine, raise `LIBRARY_HOST_SPACING_MS`.
- **Legal updates** do not cover the Second Circuit (no machine-readable
  opinion list) or the practice manuals' chapter text, and never edit the
  skills' text: routed items reach skill runs as a prompt section, and
  `skills-content/` is still re-synced from the firm's plugins by hand. See
  "Legal updates".
- **Uploads** get ClamAV signature scanning only: no sandboxed detonation
  and no OCR. Each scan runs `clamscan`, which loads the whole signature
  database (tens of seconds, about 1 GB of RAM), so scans take turns
  (`MALWARE_SCAN_CONCURRENCY`, default 1); a `clamd` daemon is the next step
  if upload volume grows. Documents scanned before `s3_version_id` existed
  have no pinned version and are read at the key's current object. There is
  no override to download or analyze a document that could not be scanned
  (an attorney-only, separately audited release would be the way to add
  one).
- **The sandbox** isolates each tool call (its own user, no network, its
  own PID namespace, file-size and process limits) but sets no memory cap
  per tool: LibreOffice and `clamscan` are bounded by taking turns for a
  slot, and the machine by its size and swap. A per-call cgroup is the next
  step if a tool ever exhausts memory.
- **web_fetch site lists are fixed in code** (`fetch-domains.ts`), not per
  firm. A source the firm's practice profile accepts but the lists leave
  out can be found and cited, but only as a search result, until its host
  is added.
- **Signed documents are ordinary matter documents.** Only runs queued by an
  owner/admin or attorney embed a signature image, but every role,
  `read_only` included, can download the result. There is no separate
  permission or attorney release step for documents that carry one.
- **Runs queued before this version** have no `input_snapshot.requesterRole`
  (they embed no signature image) and no `input_snapshot.legalUpdates`.

## 4. Deployment (Fly.io)

**This is a staging/test deploy path; use synthetic data only.** Real
client PII (asylum narratives, medical/criminal history, A-numbers) should
not go through this until the security baseline in the architecture plan is
actually done: Anthropic Zero Data Retention applied for, upload malware
scanning verified end to end on the deployed worker (ClamAV is wired in, see
"Uploads: malware scan and text extraction", but it has never run outside a
container build), a verified backup/restore drill, and a written
incident-response procedure.

Two Fly apps, same org: `Dockerfile` (the Next.js server) and
`Dockerfile.worker` (Node + Python3 + LibreOffice + poppler-utils + qpdf + ClamAV;
this is also the first environment where `i130-expedite-build`'s docx
generation, the upload malware scan and text extraction can actually run;
those binaries were never available on a local Windows dev machine). The
worker image fetches ClamAV signatures at build time, refreshes them at every
container start, and keeps them fresh with `freshclam` in daemon mode; the
comment in `Dockerfile.worker` explains the tradeoff. `fly.worker.toml` sizes
the worker VM (4 shared CPUs, 4 GB, 1 GB of swap) for the default
concurrency (see "Worker concurrency"): four skill runs, two LibreOffice
conversions and one ClamAV scan at a time, each scan loading the whole
signature database into memory. Its comments give the memory budget and
the cost tradeoff against the earlier 1-CPU, 2 GB machine.

Deploy from a checkout with LF line endings: `fly deploy` builds from your
working tree, and the images run on Linux. `.gitattributes` makes every
checkout LF, even with `core.autocrlf=true` on Windows, but files checked
out before it existed keep their endings until rewritten. With a clean
working tree (commit or stash first), `git rm --cached -r -q . && git
reset --hard` rewrites them all.

1. Create a Fly.io account and install `flyctl`, then `fly auth login`.
2. Do "1. Create the external accounts" above for Neon (with the runtime
   role from "Database roles"), Clerk, AWS (with the bucket's encryption
   and CORS settings; the CORS origin is the web app's URL from step 3),
   and Anthropic if you haven't already: you're about to hand their values
   to Fly as secrets.
3. `fly apps create <a-unique-web-app-name>` and
   `fly apps create <a-unique-worker-app-name>` (Fly app names are global,
   so pick something unlikely to collide). Put each into the `app = "..."`
   line of `fly.toml` and `fly.worker.toml` respectively, replacing the
   `REPLACE-WITH-...` placeholder.
4. Set secrets on **both** apps: `DATABASE_URL` and `QUEUE_DATABASE_URL`
   (the runtime role's pooled and direct connection strings),
   `ANTHROPIC_API_KEY`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY`, `S3_DOCUMENTS_BUCKET`. Both the web app
   (enqueues skill runs) and the worker (executes them, uploads generated
   documents) need all of these:
   ```bash
   fly secrets set -a <web-app-name>    DATABASE_URL=... QUEUE_DATABASE_URL=... ANTHROPIC_API_KEY=... AWS_REGION=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... S3_DOCUMENTS_BUCKET=...
   fly secrets set -a <worker-app-name> DATABASE_URL=... QUEUE_DATABASE_URL=... ANTHROPIC_API_KEY=... AWS_REGION=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... S3_DOCUMENTS_BUCKET=...
   ```
   Then, worker only (its release step runs the migrations as the owner
   role; the web app never holds the owner's credentials):
   ```bash
   fly secrets set -a <worker-app-name> MIGRATION_DATABASE_URL=...
   ```
   And web app only:
   ```bash
   fly secrets set -a <web-app-name> CLERK_SECRET_KEY=... CLERK_WEBHOOK_SECRET=placeholder-until-step-7
   ```
   Billing and emails ("Trial, billing and emails"; DEPLOY.md has the
   Stripe and SES steps): `STRIPE_SECRET_KEY` on both apps,
   `STRIPE_PRICE_ID` and `STRIPE_WEBHOOK_SECRET` on the web app, and
   `CLERK_SECRET_KEY`, `SES_FROM_ADDRESS` and `CONNECTOR_PUBLIC_ORIGIN` on
   the worker (it sends the emails).
   For the Claude and ChatGPT connector, also on the web app only, its
   public origin (no path; the connector's server URL is this plus
   `/api/mcp`; the connector refuses to answer in production without it).
   It is not a secret, but setting it here keeps it out of the image. The
   client allow list comes later, after a first test connection shows the
   client ids (`docs/CONNECTORS.md` section 3, "First connection"):
   ```bash
   fly secrets set -a <web-app-name> CONNECTOR_PUBLIC_ORIGIN=https://<web-app-name>.fly.dev
   ```
5. Deploy both, **worker first**:
   ```bash
   fly deploy -c fly.worker.toml
   fly scale count 1 -a <worker-app-name>
   fly deploy -c fly.toml --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<your real publishable key>
   ```
   The worker's deploy runs `npm run release` first (`release_command` in
   `fly.worker.toml`): `db:migrate` as the owner role, then `db:seed-skills`
   as the runtime role. If either fails, that deploy stops and nothing new
   runs. Deploying the worker first means the schema is migrated before
   either app's new code runs; do the same on every later deploy.
   (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` must be the real key at build time:
   Next.js inlines `NEXT_PUBLIC_*` vars into the client bundle. It's meant to
   be public, unlike the secret keys above, which are only ever set as Fly
   secrets and never passed as a build arg.)
6. Check the release step in the deploy output ("Running release command"
   with the migrations and the seeded skill versions). To run it by hand
   instead, from your own machine with `.env.local`'s
   `MIGRATION_DATABASE_URL` and `DATABASE_URL` pointed at the same Neon
   database: `npm run db:migrate` then `npm run db:seed-skills`, before
   deploying either app. After the first migration, run the `GRANT ... ON
   ALL TABLES` line from "Database roles" once more if the runtime role was
   created after the tables.
7. Note the web app's URL (`https://<web-app-name>.fly.dev`). Back in the
   Clerk dashboard, add the webhook endpoint at
   `https://<web-app-name>.fly.dev/api/webhooks/clerk`, subscribed to
   `organization.*` and `organizationMembership.*`. Copy the real signing
   secret and `fly secrets set CLERK_WEBHOOK_SECRET=<real value> -a <web-app-name>`.
8. Open the app, sign up, and create your firm in the Create firm form (the
   tenant and its free month are written at once, without waiting for the
   webhook). For a firm created in the Clerk dashboard instead, the app
   offers a "Set up the firm" button while the webhook from step 7 has not
   reached it yet.

Then work through "5. First deploy checklist" against the deployed apps,
with synthetic data.

## 5. First deploy checklist

None of this has been done yet. Each item says what to look for; the
figures in `fly.worker.toml` are estimates until the load items are done.

**Before deploying**

- [ ] **Database role.** Connected as the runtime role, `SELECT rolsuper,
  rolbypassrls FROM pg_roles WHERE rolname = current_user;` returns false,
  false. The worker app has `MIGRATION_DATABASE_URL` (the owner role); the
  web app does not.
- [ ] **Bucket.** Versioning on, default encryption SSE-KMS, the CORS rule
  from "AWS" with the web app's origin, and the IAM user's permissions
  (plus `kms:GenerateDataKey` and `kms:Decrypt` for a customer managed key).
- [ ] **Worker config.** `fly config validate -c fly.worker.toml` (needs `fly
  auth login`) accepts the top-level `swap_size_mb` and the `[env]` block,
  and `fly platform vm-sizes` shows that `shared-cpu-4x` allows 4gb.

**Deploy and migrations**

- [ ] **Order.** Worker first, so its `release_command` runs `npm run
  release` (`db:migrate`, including 0005_legal_updates and
  0006_rls_tenant_setting, then `db:seed-skills`) before the web app.
  `enqueueSkillRun` reads `legal_updates` inside its transaction, so a web
  app running against an unmigrated database cannot queue skill runs. If
  0006 stops on its new unique index, a tenant has two active practice
  profile versions; the migration's comment says how to find and fix them.
- [ ] **Row-level security after 0005 and 0006, as the runtime role.** A
  plain SELECT on `legal_updates` succeeds; INSERT or UPDATE outside
  `withServiceContext` is refused; `legal_update_reviews` is visible only in
  its own tenant context. Service-context requests (every page load's tenant
  lookup, the webhook, the stuck-run sweep, the monitor) keep working on
  pooled connections that earlier served a tenant transaction (no `invalid
  input syntax for type uuid` errors).

**Worker startup** (`fly logs -a <worker-app-name>`)

- [ ] `[worker] database role: subject to row-level security`.
- [ ] `[worker] concurrency: 4 skill run(s) at once, at most 2 per tenant;
  2 upload job(s) at once, at most 1 per tenant; 2 LibreOffice
  conversion(s) and 1 ClamAV scan(s) at once`, with no `[limits]` warnings.
- [ ] `[worker] listening on "legal-update-check" (schedule "0 5 * * *"
  America/Chicago)`, the `pgboss.schedule` row exists with that time zone
  (and the old Monday schedule is gone), and pg-boss 12 accepted policy
  `"exclusive"` and `heartbeatSeconds` 300 on `createQueue`.
- [ ] `[worker] library: N source(s); daily runs from 01:00 America/Chicago
  ...`, one `library-daily` schedule row per source (key = the source code),
  and the `library-backfill-kick` schedule. No `[library] could not record
  the library's sources` line (it means migration 0007 is missing).
- [ ] `[ingest] untrusted-tool sandbox: isolated: 24 uids from 10001, one per
  call, ...`, and the startup check of clamscan, pdftotext, python-docx and
  LibreOffice (with the signature database date and the LibreOffice
  version). Anything but `isolated` means every scan and render is refused
  until the cause it names is fixed.
- [ ] **Node heap cap.** `fly ssh console -a <worker-app-name> -C "node -e
  'console.log(require(\"v8\").getHeapStatistics().heap_size_limit/1048576)'"`
  prints about 1536.

**Sign-up, roles and the matter page**

- [ ] Signing up and creating the organization creates the tenant and the
  membership (the Clerk webhook). Making a member an Admin in Clerk, or a
  Member again, takes effect once their Clerk session token refreshes,
  whatever the webhook does. A role set in the Members section of the Firm
  page takes effect on the member's next request, and `audit_logs` gets a
  `membership.role_changed` row with the role before and after; the section
  refuses to change an owner/admin's role and shows the Owner/admin badge
  for every Clerk Admin.
- [ ] **Production build.** A `read_only` user forcing a run gets the role
  message from `triggerSkillRunAction`'s `{ok:false}` result, not the
  redacted production error.
- [ ] **Requester names.** The run list shows Clerk names (the current user
  marked "(you)"), not "Firm member (xxxxxx)". Otherwise look for
  `getRequesterLabels` errors (`getUserList` with `CLERK_SECRET_KEY`).
- [ ] **Times** render in UTC on the server and switch to local time after
  hydration, with no hydration-mismatch warning in the console.
- [ ] **Matter details.** An attorney or paralegal edits and saves;
  `read_only` does not see Edit details, and a forged call returns the role
  error. `audit_logs` gets a `matter.update` row with `after.changedFields`
  and no values, and the next run's Matter section shows the new values. A
  typed date such as 2026-02-30 is refused by the details form (inline
  error) and the create form (error page). Creating a client, a matter and
  a party writes `client.create`, `matter.create` and `matter_party.create`
  rows with ids only.
- [ ] **Run form keyboard flow.** Tab to a skill and press Enter; focus lands
  on the run form heading. Choose another skill returns focus to the picker
  heading. Other skills opens with Enter or Space. A screen reader announces
  the note label, help text and counter.
- [ ] **Pre-run warnings.** A pending scan (upload with the worker stopped),
  no confirmed practice profile, and an incomplete Firm page (shown for a
  build skill such as Draft declaration, not for a review skill such as Run
  packet review). The four new case-note boxes (packet-review,
  claim-evaluation, vawa-packet-review, aos-packet-review) show their help
  text.
- [ ] **Escalation flags.** A completed run with flags shows the red callout
  above the report and the "N escalation flags" badge on the collapsed row,
  including runs completed before this change.

**Billing and emails** (in Stripe test mode, with a test card)

- [ ] **Signup.** A new user signs up, creates a firm from the Create firm
  form, lands on `/connect`, and the Clerk dashboard shows them as Admin
  (`org:admin`); `tenant_billing` has the firm's row with
  `trial_ends_at` 30 days out and `audit_logs` has `billing.trial_started`.
  The welcome email arrives (or, without `SES_FROM_ADDRESS`, the worker logs
  that it skipped it).
- [ ] **Checkout.** Subscribe on the Billing page: Stripe's page shows one
  seat per member and the trial end; after paying with `4242 4242 4242 4242`
  the webhook's `checkout.session.completed` and
  `customer.subscription.created` arrive (Stripe dashboard, Webhooks), the
  Billing page says Subscribed, and the confirmation email arrives.
- [ ] **Seats.** Invite a member: the subscription's quantity in Stripe goes
  up within seconds (`billing.subscription_updated` with `seats_synced`);
  remove them: it goes down.
- [ ] **Portal.** Manage billing opens Stripe's portal with the app's own
  configuration (the dashboard's Customer portal page then lists
  "MeritDesk.AI (managed by the app)"): the card, invoices and cancel at
  period end are offered, quantities and plans are not; cancel at period
  end there and the Billing page says Subscription ending.
- [ ] **One subscription.** With a firm subscribed, Subscribe is gone from
  the Billing page and `/billing?error=already_subscribed` shows the fixed
  text; a second Checkout started before the first completed (two tabs)
  ends with one subscription live and the other canceled with proration
  (`billing.subscription_canceled`, reason `superseded`).
- [ ] **Second firm.** The same user signs out, signs up again with another
  address, is invited to no firm, and creates a firm: it works. The owner
  of an existing firm opening the Create firm form (by removing their
  membership first) gets a firm with no free month (`billing.no_trial`,
  the lock screen says to subscribe, Subscribe says "charges now"); a
  fourth attempt in a day is refused.
- [ ] **Lock.** Set a test firm's `trial_ends_at` to yesterday and its
  `subscription_status` to null in the database: every page shows the lock
  screen, the Billing page still opens, every form is refused (a client, a
  matter detail, a signature upload, the connector switch), a document
  download link is refused, a queued run is failed by the worker with
  reason `firm_locked`, and the connector's `tools/list` offers
  `get_connection_info` only. The next daily job (or
  `boss.send("billing-daily")` from a script) records `billing.locked` and
  sends the trial-ended email once.
- [ ] **Failed payment.** With Stripe's test clock or the `4000 0000 0000 0341`
  card on a renewal, `invoice.payment_failed` sets `past_due_since`, the
  banner shows the grace period's end, and the payment-failed email
  arrives; a paid invoice clears it, `billing.invoice_paid` is recorded and
  the receipt arrives.
- [ ] **Deletion.** Delete a test firm's organization in Clerk: its
  subscription is canceled in Stripe at once (`billing.subscription_canceled`,
  reason `organization_deleted`), `tenants.deleted_at` is set, and a
  session that still names the organization sees the "not set up" screen,
  never the firm's data.
- [ ] **Complimentary.** `npm run billing:comp -- <tenant id> on` against the
  deployed database unlocks the operator's firm without a subscription and
  `billing.complimentary_set` is recorded; `off` locks it again.

**Uploads and the tools**

- [ ] **Browser upload.** The PUT to S3 succeeds (no 403
  `SignatureDoesNotMatch`, no 400 checksum error, no CORS error in the
  console), and the object shows SSE-KMS encryption in the S3 console.
- [ ] **ClamAV.** EICAR ends infected with its download blocked; a clean PDF
  and a `.docx` scan clean with text extracted; a form tool with no
  uploaded blank downloads, scans and uses the uscis.gov form; a missing
  `clamscan` still refuses the download (fail closed).
- [ ] **Tool slots.** A third concurrent LibreOffice conversion logs
  `[limits] waiting for a LibreOffice slot`, and two simultaneous uploads
  log a ClamAV slot wait. Neither job times out because of the wait, and
  the fee packet build holds a LibreOffice slot.
- [ ] **Sandbox users.** During two concurrent uploads or renders, `ps -o
  uid,cmd` on the machine shows the tools under two different uids from
  10001 up, and a job's `/tmp/ingest-*` or `/tmp/docxgen-*` directory is
  root's with mode 0700 between tool calls.
- [ ] **Form tools after the shared-module refactor.** List and fill the
  I-589 (packet-build), I-90/G-28 (i90-packet-build) and I-360/I-485/I-765
  (vawa-packet-build) from uscis.gov downloads. Check the verification-log
  entries and that the firm-value fills match earlier behaviour.

**Skill runs**

- [ ] **First message.** The Matter section shows labels (for example `Case
  type: Asylum (defensive)`, `Status: Open`, `Venue: Immigration Court
  (EOIR)`) and the circuit as stored.
- [ ] **web_fetch allow lists.** A run of packet-build (the longest list,
  both lists combined) and of country-conditions-research is accepted by
  the API on its first request (a rejected `allowed_domains` fails the run
  at once). A search result outside the list shows on the matter page as a
  search result, not as retrieved.
- [ ] **Signatures.** i130-expedite-build queued by a paralegal produces the
  `/s/` line and the report says an attorney must sign; queued by an
  attorney, it embeds the default signer's image and records
  `firm_signature.applied`. A case note naming another roster member makes
  that person the signer; a name found only in a document does not.
- [ ] **fetch_uscis_page** on https://egov.uscis.gov processing-time pages:
  the fetch is allowed and logged. See whether the script-built page's text
  carries the times; if not, i130-expedite-build's check comes back
  unconfirmed.
- [ ] **read_prior_skill_reports** on real Postgres with RLS: run
  claim-evaluation and then bench-memo on one matter. The tool returns only
  that matter's claim-evaluation run (DISTINCT ON), never another matter's
  or tenant's. A large report (packet-build or vawa-packet-build) shows the
  TRUNCATED note, and a second call does not resend a report already
  returned in full.
- [ ] **evidence-organizer** on the worker: `generate_document` builds the
  Index of Documents, `render_and_qa_docx` shows its pages, the report
  carries `indexOfDocuments.generatedIndexOfDocumentsDocumentId`, and the
  matter page shows the Download Index of Documents button. Older runs
  render in `GenericReportView`.
- [ ] **asylum-interview-prep-review** on a matter with an uploaded `.docx`
  question set: `render_and_qa_docx` renders it by its inventory
  `document_id`.
- [ ] **Skill-run legal updates.** Queue a skill with a published routed item
  (for example asylum-merits-brief after a new asylum precedent).
  `skill_runs.input_snapshot.legalUpdates` is stored, and the system prompt
  has the RECENT LEGAL UPDATES section after the references. Runs queued
  before this deploy have none.

**Load, fairness and shutdown**

- [ ] **Fairness.** Queue 3 or more runs for one organization and 1 for
  another. At most 2 of the first run at once (each start logs `N of 4
  skill-run slots in use`), and the second starts right away. With both
  apps deployed, no `queued without a tenant group` warnings appear.
- [ ] **Memory under load.** With 4 runs in progress (2 or more using
  `generate_document` or `render_and_qa_docx`) plus an upload scan, check
  Fly metrics for OOM kills and swap use, also around freshclam updates.
- [ ] **Anthropic API** under 4 concurrent large runs: check for 429s. Lower
  `SKILL_RUN_CONCURRENCY` or raise the organization's limits if they appear.
- [ ] **Shutdown.** `fly machine restart` with 2 or more runs in progress
  logs `(N skill run(s), M upload job(s))`; each run still in progress
  after 90s is marked failed with the shutdown message (with a working
  Retry), and interrupted uploads are picked up again. A hard kill (`fly
  machine stop --signal SIGKILL`) leaves every run failed by the sweep
  within about 15 minutes (`stuck-run sweep failed SkillRun`). A
  legal-update check interrupted by shutdown is closed as interrupted by
  the next check, and items already recorded are kept.

**Practice profile**

- [ ] **Legacy version.** With an active version saved by old code,
  `/practice-profile` renders; Edit seeds the editor with legacy
  [PLACEHOLDER] values as empty fields; the review panel says no changes
  yet.
- [ ] **Propose and confirm.** The Pending confirmation section appears with
  per-field Read by lists and the rendered Markdown. Confirming as attorney
  or owner/admin writes one `practice_profile.confirm` row with before and
  after.
- [ ] **Weakening.** Removing NTA pleadings or setting Criminal bar analysis
  to Not always keeps Propose disabled until the checkbox is ticked.
  Proposing writes a `practice_profile.escalation_weakening_acknowledged`
  row (stage propose); confirm needs its own checkbox and writes a second
  row (stage confirm); posting `confirmVersionAction` without the
  acknowledgment is refused.
- [ ] **Concurrency and guards.** With the pending version open in two tabs,
  re-propose in one and confirm in the other; the confirm is refused with
  the changed-after-you-opened message. `saveDraftAction` with the active
  version's id (for example from the browser console as a paralegal) is
  refused and the active `profileJson` is unchanged. Tenants left with both
  a pending version and a separate draft by the old bug are not stuck.
- [ ] **In the prompt.** After confirming a new version, run
  claim-evaluation or country-conditions-research. PRACTICE_PROFILE.md in
  the prompt shows the ten numbered sections and "Not set by the firm
  (skill default applies)", and the report states the default it applied.

**Library**

- [ ] Everything in "6. Library first deploy checklist" below.

**Claude and ChatGPT connector** (`docs/CONNECTORS.md`; synthetic data only)

- [ ] **Clerk settings.** OAuth applications, Scopes: `practice:connector`
  exists. Settings: Publish CIMD support on (DCR only until the client ids are
  known), default scopes for dynamic clients `openid profile email
  user:org:read practice:connector`, Require PKCE on, consent screen on, JWT
  access tokens. `https://<clerk frontend api>/.well-known/oauth-authorization-server`
  lists `registration_endpoint`, `client_id_metadata_document_supported:
  true`, `none` in `token_endpoint_auth_methods_supported`, `S256`,
  `user:org:read` and `org_id`.
- [ ] **Environment.** `CONNECTOR_PUBLIC_ORIGIN` is set on the web app;
  `curl https://<web app>/.well-known/oauth-protected-resource/api/mcp`
  returns `resource` exactly `https://<web app>/api/mcp` and Clerk's issuer
  (exactly its metadata's `issuer`) as the only authorization server.
- [ ] **401.** `curl -i -X POST https://<web app>/api/mcp` returns 401 with
  `WWW-Authenticate: Bearer resource_metadata="..."`; `/matters` still
  redirects to sign-in.
- [ ] **Migrations 0012 and 0013.** `tenant_connector_settings`,
  `connector_rate_buckets` and `connector_unrecognized_clients` exist with
  forced RLS; as the runtime role each shows only its own tenant's rows.
- [ ] **Claude, custom connector.** Add the server URL with no client id;
  Connect opens Clerk's sign-in and a consent screen with an organization
  selector; the connector lists the library tools and `get_connection_info`
  only. `search` and `read_library_document` return official URLs. Decode
  the access token if you can (or read Clerk's logs): `scp` or `scope`
  holds `practice:connector` and `org_id` the chosen organization; without
  the scope every call is refused 403 naming it.
- [ ] **First connection, client ids.** With case work on but no allow list,
  `get_connection_info` says the client is not recognized and the Firm page
  lists its client id with when it was first seen. Add Claude's id (a CIMD
  URL: `CONNECTOR_ALLOWED_CLIENT_IDS`, or a prefix ending in a slash after
  the host in `CONNECTOR_ALLOWED_CLIENT_ID_PREFIXES`) and ChatGPT's, restart,
  and the case-work tools appear. Then turn Publish DCR support off and check
  both still connect.
- [ ] **Case work.** As owner/admin turn it on (the button stays disabled
  until the acknowledgment is ticked); `connector_settings.update` is
  written. Reconnect or refresh the tools in Claude: the case-work tools
  appear; as a `read_only` member `run_skill` is absent. `list_matters`,
  `get_matter` and `get_skill_run` write `connector.tool_call` rows.
  `run_skill` asks for confirmation in Claude, queues a run visible on the
  matter page, and writes `skill_run.requested` with `after.via: "connector"`
  plus `connector.tool_call` with the run id.
- [ ] **Member of two firms.** Connect choosing firm B: `get_connection_info`
  names firm B; nothing of firm A is listed. For this member, a token without
  a firm (an opaque token, or a client that did not get `user:org:read`) is
  refused with the reconnect message.
- [ ] **Role change and removal.** Set an attorney to read-only in the
  Members section of the Firm page: `run_skill` disappears from the next
  tool list and is refused. Change an Admin to Member in Clerk: within a
  minute `get_connection_info` shows the member's stored role instead of
  owner/admin. Remove the member from the organization: the next call is
  refused with 403.
- [ ] **Downloads.** Off: no `get_document_download_link`. On: absent for
  a `read_only` member; for an editor Claude asks for confirmation; a clean
  document gives a 5-minute link (`document.download` with `after.via:
  "connector"`); a pending or infected one is refused with
  `document.download_blocked`.
- [ ] **ChatGPT.** Add the server as a custom MCP server with OAuth (an
  admin may have to allow custom servers first); the OAuth flow completes
  (check which redirect URI ChatGPT used); a deep research run calls `search`
  and `fetch` and cites the official URLs.
- [ ] **Rate limits.** Six `run_skill` calls within an hour by one member:
  the sixth is refused with the wait time; `connector_rate_buckets` holds the
  member's and the firm's rows, including `run_skill:tenant:day`.
- [ ] **Revocation and bans.** Revoke a connection's token in Clerk and note
  whether the next call (after up to a minute) is refused 401: the logs say
  if Clerk's verify endpoint did not answer for JWT tokens, in which case
  revocation takes effect at token expiry (a day). Ban the user in Clerk: the
  next call after up to a minute is refused 401.

**Legal updates**

- [ ] **First Check now** as owner/admin: every source except ca2 ends
  baseline (ca2 not checked), the feed stays empty, and the source table
  shows item counts. A second Check now while one runs says one is already
  queued or running.
- [ ] **Claude calls on a later run with new items** (never run live). The
  quote call (PDF document block with citations, adaptive thinking, betas
  `[server-side-fallback-2026-07-01]`, fallbacks `"default"`) returns
  `page_location` citations. The summary call (`output_config.format` from
  `betaZodOutputFormat` plus the fallback beta) returns parseable JSON.
  Court opinions show document quotes with page numbers. Check the per-run
  token cost.
- [ ] **From the Fly worker's IPs:** justice.gov, uscis.gov,
  federalregister.gov and every uscourts.gov host still serve the listings
  to the monitor's User-Agent (watch for 403 or 429). Eighth Circuit PDFs
  stay served at https://ecf.ca8.uscourts.gov/opndir/.
- [ ] **/updates as each role:** `read_only` and paralegal see no review
  controls and no Check now; attorney sees review only; owner/admin sees
  both. The nav badge count matches unreviewed items of the last 90 days.
  `legal_update.review` rows carry `after.hasNote` and no note text.

## 6. Library first deploy checklist

None of this has been done against a deployment yet. The PGlite checks
(`npm run library:db-check`, `npm run eoir-stats:check`) cover the
migrations, row-level security, the store and the search queries on an
in-memory database; they say nothing about Neon, the Fly worker's IPs or
how the official sites answer them. "The library" above and
`docs/LIBRARY.md` explain each setting named here.

**Policy: the collector never evades bot protection.** It identifies itself
as `MeritDeskAI-Library/1.0` (plus
`LIBRARY_USER_AGENT_CONTACT`), honors robots.txt, and takes a 403 or a
challenge page as the site's answer. Do not change the User-Agent, imitate a
browser, send requests through other IPs or proxies, or use archive copies
to get around a refusal. A site that refuses the collector is kept up to
date by import from the official site (below), turned off with
`LIBRARY_DISABLED_SOURCES`, or asked, through its webmaster, to allow the
collector.

**API keys** (Fly secrets on the worker app, which runs the collectors;
never in a file or a URL). A collector whose key is unset is skipped and
shown on `/library` as "Needs API key"; nothing else depends on them.
Where to register: `docs/LIBRARY_SOURCES.md` section 2.

- [ ] `API_DATA_GOV_KEY` (api.data.gov; one key covers GovInfo and
  Regulations.gov): district court immigration decisions on GovInfo and the
  immigration agencies' Regulations.gov docket documents.
- [ ] `CONGRESS_GOV_API_KEY` (api.congress.gov): CRS reports on
  immigration and the Senate treaty records.
- [ ] `COURTLISTENER_API_TOKEN`, only if the firm approves it.
  CourtListener is run by the Free Law Project, a nonprofit third party,
  not a government or court site; the firm decides whether to use it before
  the token is set (`docs/LIBRARY.md` section 12). Without it the two
  CourtListener collectors stay off. For a paid membership, set
  `COURTLISTENER_API_LIMITS` to the account's allowance (default
  `5/minute,50/hour,125/day`).
- [ ] `LIBRARY_USER_AGENT_CONTACT` (worker): an email or URL of whoever runs
  the deployment, so a site's administrators can reach you.

**Import from the official site**

- [ ] `LIBRARY_IMPORT_ADMINS` on the web app: the Clerk user ids
  (`user_...`, comma-separated) of the platform operators who may import.
  Unset or empty, nobody can. It is not a firm role: the library is shared
  by every firm, so an import changes what every firm reads.
- [ ] `LIBRARY_MANUAL_SOURCES` unset on both apps (the default: the 13
  sources whose sites refused the collector at the last live test), or the
  same value on the worker and the web app.
- [ ] Someone owns the import schedule in `docs/LIBRARY_SOURCES.md`
  section 1: the Visa Bulletin monthly, around mid-month; the State
  Department country, religious freedom and trafficking reports once a year
  on release; the visa press releases weekly; the ORR guides and letters
  monthly or quarterly; the consular, reciprocity, adoption, USDA and UNHCR
  pages on the intervals that table gives. `/library` marks a manual source
  "Overdue" when no import came within its interval.
- [ ] One import as an operator (the Visa Bulletin, say): the result links
  to the stored document, `/library` shows the import date, and
  `library_import_log` has the attempt. A signed-in user who is not in
  `LIBRARY_IMPORT_ADMINS` gets no import form.

**Storage and backfill**

- [ ] Migrations 0007 to 0011, applied by the worker's `release_command`:
  the `pg_trgm` extension, the library and `eoir_stats_*` tables, the
  country filter index (0009), the manual import (0010) and
  `library_documents_newest_idx` (0011, for a search with filters and no
  words). As the runtime role, a SELECT on `library_documents` and
  `eoir_stats_snapshots` works and an INSERT outside `withServiceContext`
  is refused.
- [ ] Storage sized before backfill is on. Estimates from sampled
  documents, after the full history: Postgres roughly 5 to 10 GB, plus
  about 0.5 GB of EOIR statistics; S3, only with
  `LIBRARY_STORE_ORIGINALS=true`, roughly 250 to 300 GB under `library/`
  (the IAM user then needs `s3:PutObject` and `s3:GetObject` there).
- [ ] What backfill does: it starts at worker start and is kicked hourly,
  immigration core first. The core groups take days; the AAO non-precedent
  decisions about three weeks, the unpublished BIA decisions 4 to 10 days,
  CourtListener's history (if enabled) months on a free account. In the
  first days the daily runs on uscis.gov and justice.gov go past 05:00
  Central.
- [ ] How to pause it: `LIBRARY_BACKFILL=paused` on the worker stops every
  history walk (daily runs go on); `LIBRARY_BACKFILL_PAUSED_SOURCES=<code>,...`
  pauses some sources; `LIBRARY_DISABLED_SOURCES=<code>,...` stops a
  source's daily run and backfill; `EOIR_STATS_LOAD=paused` stops the EOIR
  statistics load. Set them with `fly secrets set` or in `[env]` of
  `fly.worker.toml`; the worker reads them when it restarts. A paused walk
  resumes where it stopped.
- [ ] From the Fly worker's IPs, before turning backfill on: `npm run
  library:smoke -- --out /tmp/smoke.json` (in `fly ssh console`; about an
  hour) reads every source's listing, first backfill chunk and two
  documents, stores nothing, and ends with the count of sources ok,
  partial and failed. Compare it with `docs/LIBRARY.md` section 12; the
  sites refused from the development machine may answer the worker's IPs
  differently.

**Worker startup** (`fly logs -a <worker-app-name>`)

- [ ] `[worker] library: 93 source(s), 13 kept up to date by manual
  import; daily runs from 01:00 America/Chicago (4 at once, one per host);
  backfill on (3 chunk(s) at once ...)`, with no `collector left out,
  misconfigured` line and no `[library] could not record the library's
  sources` line (that one means migration 0007 is missing).
  `pgboss.schedule` has one `library-daily` row per scheduled source (80
  with the default manual sources), the `library-backfill-kick` row and the
  `eoir-stats-load` row at `41 3 * * *` America/Chicago.

**After the first daily run** (the morning after the deploy; the runs start
at 01:00 Central)

- [ ] `/library`: each group shows a document count and a last successful
  update. Each source's badge is "Up to date" or says what is wrong:
  "Needs API key" (the variable it names is unset), "Last update failed" or
  "Partly updated" with the error (a 403 means the site refuses the
  collector: see the policy above), "Not yet updated" (its first run has not
  finished), "Turned off", or, for a manual source, "Manual import" with
  "Not imported yet" until its first import. "Collecting history" means its
  backfill is still walking.
- [ ] `library_fetch_runs` has a `daily` row per scheduled source with its
  counts and failures. A source's first successful daily run feeds no legal
  updates (the baseline). Once the first days' backlog is fetched, most
  daily runs finish before 05:00 (`finished_at`); if many do not, raise
  `LIBRARY_DAILY_CONCURRENCY`.
- [ ] A document's reader page shows its text, headnote and official link.
  `/library/search` finds a stored BIA precedent by its I&N Dec. citation
  and by words from it. A very broad search (one common word over the whole
  library) lists the newest documents first with a note that too many match
  to rank, or stops after 5 seconds with "it took too long"; either way it
  does not hold the database.
- [ ] EOIR statistics: the first `eoir-stats-load` (or `npm run
  eoir-stats:load`) logs `[eoir-stats] <table>: N rows` for its four tables
  and ends with one `current` snapshot; `/library/eoir-statistics` shows it,
  and a judge profile's asylum figures look plausible next to EOIR's own
  published adjudication statistics.
- [ ] Worker memory with backfill, daily runs and the statistics load
  going: one PDF extraction at a time (`LIBRARY_PDF_CONCURRENCY`), its
  thread under `LIBRARY_PDF_MEMORY_MB`; watch for `[limits] waiting for a
  PDF text extraction slot` and OOM kills.
- [ ] A skill run with the library tools (claim-evaluation, say): the run's
  verification log has `library` entries with the official URL and the
  source's refresh time, and the matter page lists the library documents
  read. Once a statistics snapshot is loaded, a judge figure the run quotes
  carries its snapshot and denominator.
