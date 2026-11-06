# MeritDesk.AI deployment

This is the production launch path. `DEPLOY.md` is the longer original runbook; keep both in step. Use **synthetic client data** until the production checklist in `PRODUCTION_CHECKLIST.md` is done.

## Architecture

| Piece | Role |
|---|---|
| GitHub Actions | CI (`ci.yml`: env contract, typecheck, lint, tests, production build) and the Deploy workflow (`deploy.yml`) |
| Fly.io web app | Next.js: pages, `/api/mcp`, Clerk/Stripe webhooks, `/api/health`, `/api/ready` |
| Fly.io worker | pg-boss jobs: skill runs, document ingest, library, billing emails. Runs migrations on release |
| Neon Postgres | Tenant data with forced RLS. Runtime role must be `NOSUPERUSER NOBYPASSRLS` and must not own tables |
| Clerk | Sign-in and Organizations (one firm per org) |
| AWS S3 | Private, versioned, KMS-encrypted documents |
| AWS SES | Account and billing email (worker) |
| Stripe | $20/user/month after a 30-day trial |
| Anthropic | Skill-runner model calls |

## 1. Secrets and environment

1. Copy `.env.example` to `.env.local` for development.
2. Run `npm run env:check` after adding a `process.env.NAME` reference.
3. Production secrets go on **both** Fly apps unless noted otherwise. Never commit `.env.local`.

Required at runtime (web): `DATABASE_URL`, `QUEUE_DATABASE_URL`, `ANTHROPIC_API_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (build-time), `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_DOCUMENTS_BUCKET`, `CONNECTOR_PUBLIC_ORIGIN`.

Worker also needs `MIGRATION_DATABASE_URL`. Billing needs `STRIPE_SECRET_KEY` (both apps), `STRIPE_PRICE_ID` and `STRIPE_WEBHOOK_SECRET` (web). Email needs `SES_FROM_ADDRESS` (worker). Operators: `LIBRARY_IMPORT_ADMINS`.

## 2. Database

Create the runtime role as README "Database roles" describes, then:

```bash
npm run db:migrate
npm run db:seed-skills
```

On Fly this is the worker `release_command` (`npm run release`). After the first migration, grant table privileges to `app_runtime` if default privileges were not set.

**Backups:** Neon point-in-time recovery is the backup system. Confirm PITR is on for the production project, pick a retention window (at least 7 days), and record who can restore. Do not add a second backup product unless Neon is unavailable. Restore is: create a new Neon branch/timeline at the recovery timestamp, point `DATABASE_URL` / `QUEUE_DATABASE_URL` / `MIGRATION_DATABASE_URL` at it on a staging Fly app, verify, then cut over.

**Migration 0017** composite FKs are `NOT VALID`. Before `VALIDATE CONSTRAINT` in production, run the preflight counts in `PRODUCTION_READINESS.md` and repair mismatches with a reviewed plan. Never drop customer rows automatically.

## 3. Fly.io

```bash
fly apps create <web-app-name>
fly apps create <worker-app-name>
```

Put those names in `fly.toml` and `fly.worker.toml`. Set secrets (`DEPLOY.md` steps 6–10). Deploy worker first (migrations), then web:

```bash
fly deploy -c fly.worker.toml
fly scale count 1 -a <worker-app-name>
fly deploy -c fly.toml --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<pk_live_or_test>
```

Or GitHub Actions → **Deploy to Fly.io**.

Web health check: `GET /api/health` (liveness, no database). Readiness: `GET /api/ready` (Postgres `select 1`). Worker has no HTTP port; Fly watches the process. `kill_timeout` is 120s; `WORKER_SHUTDOWN_GRACE_SECONDS` must stay below that.

## 4. HTTPS and domain

Follow `DEPLOY.md` "Your own domain, with Cloudflare in front":

- Fly certs + Cloudflare DNS, SSL/TLS **Full (strict)**
- Skip bot challenges for `/api/` and `/.well-known/`
- `TRUST_CF_CONNECTING_IP=true` only while every request reaches Fly through Cloudflare
- Set `CONNECTOR_PUBLIC_ORIGIN=https://app.<domain>` on both apps

## 5. Clerk, Stripe, SES, connector

Follow `DEPLOY.md` steps 8–12. Opaque OAuth access tokens, scope `practice:connector`, `CONNECTOR_ALLOWED_CLIENT_IDS` after the first Claude/ChatGPT connection. Turn DCR off after those clients work.

## 6. Platform operators

Set `LIBRARY_IMPORT_ADMINS` to Clerk user ids (`user_...`). Those users can:

- Import official library sources at `/library/import`
- Open `/platform` to list firms, see usage/storage, and suspend or restore access

Complimentary access remains `npm run billing:comp` (not in the web UI).

## 7. Usage limits

Defaults (override with env):

| Plan | AI tokens / UTC month | Document storage |
|---|---|---|
| Free month | 3,000,000 | 2 GB |
| Subscribed | 10,000,000 per seat | 10 GB per seat |
| Complimentary | unlimited | unlimited |

Tokens counted: uncached input + cache writes. Cache reads do not consume the cap. Enforcement is at skill-run enqueue/start and document upload.

## 8. Docker Compose (optional, not Fly)

On a Linux Docker host:

```bash
docker compose build --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
docker compose up
```

Still requires Neon/Clerk/S3/Stripe/Anthropic credentials in `.env.local`. The worker image expects Linux user namespaces for the untrusted-tools sandbox.

## 9. Verify after deploy

1. `curl -fsS https://<origin>/api/health`
2. `curl -fsS https://<origin>/api/ready`
3. Sign in, create a firm, confirm trial on Billing (usage meters visible)
4. Upload a tiny PDF, confirm ingest, run one cheap skill on fake data
5. Stripe test-mode checkout and webhook 200s
6. Connector initialize against `/api/mcp` (see `docs/CONNECTORS.md`)

Do not put real client files in until Anthropic Zero Data Retention is approved and S3/KMS/CORS have been checked on a non-production bucket.
