# MeritDesk.AI implementation status

Updated: 2026-11-06

## Complete in this repository (code + local tests)

| Area | Status |
|---|---|
| Firm registration / onboarding | Implemented (`createFirmAction`, Clerk webhook repair) |
| Multi-user orgs and roles | Implemented (Clerk Admin + Firm-page app roles) |
| Tenant isolation | Implemented (RLS + filters + 0017 FKs); PGlite suite |
| Session auth | Clerk |
| MCP connector | Implemented; local SDK/HTTP tests; live ChatGPT unverified |
| Document upload / ingest | Implemented; malware fail-closed; live S3 unverified |
| Skill runner | Implemented; retries on 429/5xx via Anthropic SDK (`maxRetries: 5`) |
| AI usage tracking | Implemented this pass (per-run + monthly) |
| Usage / storage quotas | Implemented this pass |
| Billing, trial, seats, portal, webhooks | Implemented; Stripe test-mode unverified live |
| Operator suspension | Implemented this pass (`/platform`) |
| Complimentary access | CLI (`npm run billing:comp`) |
| Email | SES worker path; skipped cleanly if `SES_FROM_ADDRESS` unset |
| Audit log | Append-only tenant audit |
| Health / ready | Implemented this pass |
| Fly + Dockerfiles | Present; Compose added for optional self-host |
| CI | typecheck, lint, env check, tests, build |

## Incomplete until external accounts are configured

| Item | Blocker |
|---|---|
| Live Clerk OAuth (opaque tokens, audience, revocation, org removal) | Operator Clerk app |
| Claude / ChatGPT discovery and tool calls | Deployed origin + allow-listed client ids |
| Stripe test then live checkout, webhooks, seats | Stripe keys + webhook endpoint |
| S3 upload/download, KMS, CORS, version pin | AWS bucket |
| Malware scan + sandbox | Linux worker image / Fly worker |
| SES production sending | Domain identity + production access |
| Neon role flags and PITR | Neon project |
| Anthropic Zero Data Retention | Anthropic org approval before real PII |
| Two-firm UI/API adversarial pass | Staging with two orgs |

## Intentionally not built

- In-app operator grant of complimentary access (stays CLI so a firm admin cannot self-grant).
- Usage-based Stripe metering (seat license + hard caps; no extra Stripe product).
- Separate `PLATFORM_ADMINS` env (operators are `LIBRARY_IMPORT_ADMINS`).
- Worker HTTP health port (no public service; process supervision only).

## Verified in this session

- `npm test`: 65 passed, 0 failed (includes origin/port generation, quotas, suspension, untrusted-fence, usage RLS, and prior MCP/Stripe/isolation suites)
- `npm run typecheck`: pass
- `npm run lint`: pass
- `npm run env:check`: pass
- `npx drizzle-kit check`: pass
- Production build: pass on this Windows host with `next build --webpack` (native Turbopack bindings are unavailable here; Linux CI/Fly `npm run build` is unchanged)

## Blocked on this machine

- No Docker executable, so the worker image and untrusted-tool sandbox were not built or run.
- No live Clerk, Stripe, S3, SES, Anthropic, Neon production, or ChatGPT/Claude session.
