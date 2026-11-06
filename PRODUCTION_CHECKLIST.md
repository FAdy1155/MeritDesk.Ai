# MeritDesk.AI production checklist

Check an item only after you have **evidence** (command output, dashboard screenshot, or webhook delivery). A green local build is not enough.

## Repository

- [ ] `npm ci`
- [ ] `npm run env:check`
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build` with production-like placeholders (CI) or real `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- [ ] Branch protection requires the CI job

## Neon

- [ ] Runtime role: `NOSUPERUSER NOBYPASSRLS`, does not own tables
- [ ] App/worker use pooled `DATABASE_URL` and direct `QUEUE_DATABASE_URL`
- [ ] Migrations run as owner (`MIGRATION_DATABASE_URL`)
- [ ] PITR enabled; restore drill documented
- [ ] Migration 0017 preflight counts are zero (or repaired) before `VALIDATE CONSTRAINT`

## Clerk

- [ ] Organizations on; user-created orgs off (or limit 1)
- [ ] Default Admin / Member only; no custom roles
- [ ] Webhook `organization.*` and `organizationMembership.*` → `/api/webhooks/clerk`
- [ ] OAuth: `practice:connector`, PKCE, CIMD; DCR off after first connector clients
- [ ] Opaque access tokens; audience matches `CONNECTOR_PUBLIC_ORIGIN` + `/api/mcp`
- [ ] Ban/lock and org-removal revoke connector access on the next call

## Storage and worker

- [ ] S3 bucket private, versioning on, default encryption KMS
- [ ] CORS allows the production origin PUT
- [ ] Signed upload one-use / 150 MB confirmed in a browser against a **non-production** bucket
- [ ] Worker image: ClamAV signatures load; `UNTRUSTED_TOOLS_SANDBOX=required`
- [ ] Infected fixture is not marked clean; clean PDF extracts text

## Stripe

- [ ] Test mode Product/Price from `npm run stripe:setup`
- [ ] Webhook events listed in `DEPLOY.md` step 9; signature verified (400 on bad sig)
- [ ] Duplicate delivery returns already-processed; checkout + customer portal work
- [ ] Seat quantity follows member count
- [ ] Live mode keys, price, and webhook only after test mode passes

## Connector

- [ ] `CONNECTOR_PUBLIC_ORIGIN` is the exact HTTPS origin
- [ ] ChatGPT and Claude initialize, `tools/list`, and `list_matters` against the deployed URL
- [ ] Case-work tools hidden until firm switch + allow-listed client id
- [ ] Unrecognized client ids appear on the Firm page

## SaaS workflows (synthetic data)

- [ ] Create firm → 30-day trial (or locked if creator already used a trial)
- [ ] Invite a member; role set on Firm page; Billing seats match
- [ ] Upload → ingest → skill run on fake matter
- [ ] Quota: usage visible on Billing; over-cap upload or run refused with a clear error
- [ ] Subscribe (test card), lock after cancel/lapse, unlock on resubscribe
- [ ] `/platform` suspends a test firm; members see the suspension lock; restore works
- [ ] Deleted Clerk org makes the firm unreachable

## Edge / HTTPS

- [ ] Custom domain, Fly cert issued, Cloudflare Full (strict)
- [ ] Skip bot fight for `/api/` and `/.well-known/`
- [ ] `curl -fsS https://<origin>/api/health` and `/api/ready` succeed
- [ ] `TRUST_CF_CONNECTING_IP=true` only while Cloudflare proxies every request

## Legal / ops

- [ ] Anthropic Zero Data Retention approved before real client PII
- [ ] Privacy and terms URLs match the live site
- [ ] `LIBRARY_IMPORT_ADMINS` set to real operator user ids
- [ ] SES domain verified and out of sandbox before relying on email

**Launch decision:** do not enable real client data until every box above is checked with evidence.
