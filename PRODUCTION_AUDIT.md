# MeritDesk.AI production audit

Date: 2026-11-06  
Scope: local repository inspection and implementation in this working tree. No production cluster, live Clerk, live Stripe, live S3, or ChatGPT connection was exercised.

## Architecture (preserved)

Next.js 16 App Router, Clerk Organizations as tenants, Neon Postgres with **forced RLS** plus explicit `tenant_id` filters, Stripe Billing, private S3 with version pinning and ClamAV ingest, pg-boss worker, MCP connector at `/api/mcp`, official-source library.

The product was already a multi-tenant SaaS. This pass did not rebuild working features.

## What was already solid

- Tenant page data gated with `getCurrentTenantIfEntitled` (layout lock screen is not the authorization boundary).
- MCP HTTP: origin requirement, pre-auth IP limits, Clerk OAuth with MCP resource audience, opaque-token + revocation checks, per-tenant tool rate limits, allow-listed case-work clients.
- Stripe webhook signature verification, idempotency, stale-event rejection, seat sync, trials, cancellation, daily lock/reminder job.
- Document upload policy (150 MB, one-use signed PUT, attachment downloads, file-signature checks, malware fail-closed).
- Skill-runner prompt-injection baseline (`CASE_FILE_CONTENT_SECTION`, runner-marker neutralization).
- Untrusted-tool sandbox in `Dockerfile.worker`.
- Fly dual-app deploy, env contract script, existing automated tests (MCP discovery, RLS PGlite suite, Stripe webhook, uploads).

## Findings addressed in this pass

| Severity | Finding | Fix |
|---|---|---|
| P1 | No durable per-tenant AI metering or commercial caps; usage lived only on in-memory run audit | `skill_runs` usage columns, `tenant_usage_monthly`, enqueue/worker/upload enforcement, Billing meters |
| P1 | No operator suspension UI; complimentary-only CLI | `tenant_billing.operator_suspended`, `/platform` for `LIBRARY_IMPORT_ADMINS` |
| P1 | Fly health check hit `/` (Clerk/session path) | `GET /api/health` (liveness) and `GET /api/ready` (Postgres); Fly check path updated |
| P1 | CI did not run `npm test` | Tests added to `ci.yml` and `deploy.yml` |
| P2 | Extracted document text lacked an explicit untrusted fence | BEGIN/END UNTRUSTED DOCUMENT CONTENT wrappers + fence neutralization |
| P2 | Anthropic client used SDK default retries | `maxRetries: 5` on the skill-runner client |
| P2 | Requested launch docs missing (`PRODUCTION_AUDIT.md`, `IMPLEMENTATION_STATUS.md`, `DEPLOYMENT.md`, `PRODUCTION_CHECKLIST.md`) | Added; `.env.example` extended |

## Remaining risks (not claimed fixed)

1. **Live Clerk OAuth / ChatGPT / Claude** against the deployed `/api/mcp` URL is unverified. Code binds `audience` to the MCP resource URL; Clerk's issued-token behavior must be confirmed in the operator's Clerk application (opaque tokens, revocation, org removal).
2. **Pre-auth IP limits** trust `Fly-Client-IP`, else last `X-Forwarded-For`. Direct exposure or missing `TRUST_CF_CONNECTING_IP` behind Cloudflare weakens abuse controls. Documented in `src/services/connector/ip-limit.ts`.
3. **Service-context GUC** (`app.is_service_role`) bypasses RLS. Callers must stay server-owned (webhooks, operator console, CLI). `/platform` uses it after `LIBRARY_IMPORT_ADMINS` check.
4. **Migration 0017** FKs are `NOT VALID` until a reviewed production validate window.
5. **S3, ClamAV worker sandbox, Stripe live lifecycle, two-firm UI/API adversarial tests** need a non-production environment with real credentials. This host did not provide Docker or those accounts.
6. **Neon PITR / role flags** in the live project were not inspected.

## Security posture (code)

- AuthN: Clerk session on app routes; MCP authenticates every call; webhooks verify Svix/Stripe signatures; health/ready are public and return no tenant data.
- AuthZ: firm roles (`owner_admin`, `attorney`, `paralegal`, `read_only`); entitlement lock; connector client allow-list; operator list in env.
- Isolation: forced RLS + tenant filters + tenant-scoped FKs (0017).
- Uploads: metadata validation, SSE-KMS, version pin, malware gate before model/download.
- Secrets: not in repo; build uses placeholders; `check-env-example.mjs` requires documentation.

Do not certify production until `PRODUCTION_CHECKLIST.md` external items are done.
