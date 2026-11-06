# MeritDesk.AI — Real-World End-to-End Test Report

Date: 2026-11-06  
Environment: Windows 10, Node.js, existing cloned repository  
Test runner: `npm test` — **54 passed, 0 failed**

This report records only what was actually executed. Missing credentials are named. Claude Desktop and ChatGPT were **not** connected.

Status key: **PASS** tested successfully · **FAIL** tested and failed · **BLOCKED** needs credentials or external configuration · **NOT IMPLEMENTED** functionality does not exist.

---

## 1. Application startup

| Check | Status | Evidence |
| --- | --- | --- |
| Dependencies installed (`node_modules`) | PASS | Present; no package versions were changed |
| `.env.local` | BLOCKED | File does not exist. Copy `.env.example` and fill real values |
| Local Postgres / Docker / `psql` / `flyctl` | BLOCKED | None of these tools are installed on this machine |
| Database migrations / seed | BLOCKED | No `DATABASE_URL` / `MIGRATION_DATABASE_URL`. Schema was exercised only against in-process PGlite in tests |
| Worker (`npm run worker`) | BLOCKED | Needs `QUEUE_DATABASE_URL`, Anthropic, and S3 |
| Next.js production server | PASS | `npx next start -p 3100` with placeholder env. Port 3000 was already occupied by a different application |
| Next.js webpack dev server | PASS | `npx next dev --webpack -p 3101` (Windows is missing native `@next/swc-win32-x64-msvc`; webpack is required) |
| `GET /api/health` | PASS | Live `200` `{"ok":true,"service":"web",...}` |
| `GET /api/ready` | FAIL | Live `503` `{"ok":false,"checks":{"database":"error"}}` — expected with a dummy `DATABASE_URL` pointing at nothing |

Placeholder keys were used only so the process would boot. They are not valid Clerk, Neon, Stripe, or Anthropic credentials.

Windows notes:

- `next start` warns that `output: "standalone"` prefers `node .next/standalone/server.js`. The HTTP server still listened and answered.
- Native Next SWC is not installed; webpack works.

---

## 2. Web application

Authenticated UI flows need Clerk Organizations plus Neon. Those credentials are not in this workspace, so **no law-firm account was registered, no session was created, and no browser login completed**.

| Workflow | Status | What was verified |
| --- | --- | --- |
| Public landing `/` | PASS | Live `200`, title `MeritDesk.AI \| Immigration Law AI Connector`, page names Claude |
| Public pricing `/pricing` | PASS | Live `200` |
| Public terms `/terms` | PASS | Live `200` |
| Public privacy `/privacy` | PASS | Live `200` |
| Public setup `/setup` | PASS (after fix) | Linked from the landing page but previously missing from the Clerk public-route matcher, so unsigned visitors were sent to Clerk. After adding `/setup` to `src/proxy.ts`, webpack-dev `GET /setup` returned `200` with title `Connect Claude or ChatGPT \| MeritDesk.AI` and the MCP URL |
| Sign-in `/sign-in` | BLOCKED | Page shell `200`; completing sign-in needs a real Clerk publishable/secret key |
| Sign-up / register a law firm | BLOCKED | `/sign-up` shell `200`. Firm creation (`src/lib/tenants/create-firm.ts`) calls Clerk `organizations.createOrganization` and writes a tenant row |
| Log in / log out | BLOCKED | Clerk session |
| Create / manage workspace | BLOCKED | Firm page, identity, practice profile, connector switches all require a tenant session |
| Invite / create team members | BLOCKED | Invitations are Clerk organization settings; app roles (attorney / paralegal / read-only) are set on `/firm` |
| Create a client profile | BLOCKED in UI · PASS via MCP (PGlite) | `/clients` form exists (name, A-number, DOB, country, language, email, phone). No free-text notes field on the form |
| Create an immigration case | BLOCKED in UI · PASS via MCP for supported types | `/matters` form. Case types: asylum (affirmative/defensive), withholding/CAT, cancellation, VAWA, I-130, I-90. **No employment-based visa type** |
| Upload / manage case documents | BLOCKED | Uploader exists (`DocumentUploader`); needs S3, KMS, ClamAV worker |
| Add notes / case updates | NOT IMPLEMENTED as a standalone note | Case notes exist only as `attorney_note` on a skill run. `clients.notes` is a schema column unused by the UI and MCP `create_client` |
| Use AI features | BLOCKED | `run_skill` queues Anthropic work on the worker |
| Search / retrieve case information | BLOCKED in UI · PASS via MCP list/get | Web clients/matters pages are unfiltered tables. Library search UI needs a populated library DB |
| Dashboard statistics / case statuses | BLOCKED live | Home dashboard is a **connector control panel** (connect / case-work switch / billing), not case analytics. `/matters` lists status, venue, next hearing |
| User permissions | PASS (tests) · BLOCKED live | Editor vs read-only is enforced in MCP and tenant page-access tests |
| Tenant isolation | PASS (PGlite) | Cross-tenant reads/writes refused; see section 8 |

---

## 3. Database and storage

| Check | Status | Notes |
| --- | --- | --- |
| Neon / runtime role RLS | BLOCKED live · PASS in PGlite | Tests create `app_runtime` with `NOSUPERUSER NOBYPASSRLS` and confirm forced RLS |
| Migrations | BLOCKED live | `npm run db:migrate` needs `MIGRATION_DATABASE_URL` |
| Skill catalog seed | BLOCKED live | `npm run db:seed-skills` |
| S3 document store | BLOCKED | `S3_DOCUMENTS_BUCKET` + AWS keys + KMS |
| ClamAV ingest | BLOCKED | Worker job after upload |
| Upload policy | PASS | Filename, size, MIME, and file-signature tests |

---

## 4. MCP connection and handshake

**Transport:** Streamable HTTP, stateless, JSON responses, **POST only**, at `/api/mcp`.  
**Auth:** Clerk OAuth. Bearer token must be an **opaque** Clerk OAuth token (`oat_…`) with scope `practice:connector` (plus `openid profile email user:org:read`). JWT access tokens are refused so revocation can be checked on every call. Audience is the exact MCP resource URL.  
**Discovery:** RFC 9728 protected-resource metadata at `/.well-known/oauth-protected-resource` (and `/api/mcp` variant). `WWW-Authenticate` on 401 points clients at that document.

### Live HTTP (Next on port 3100, placeholder Clerk/DB)

| Check | Status | Result |
| --- | --- | --- |
| `POST /api/mcp` with no token | PASS | `401` + `WWW-Authenticate: Bearer resource_metadata="http://127.0.0.1:3100/.well-known/oauth-protected-resource", scope="openid profile email user:org:read practice:connector"` |
| `GET /api/mcp` with no token | PASS | `401` (auth runs before the method check) |
| `POST /api/mcp` with `Bearer not-a-real-token` or a JWT | PASS | `401 invalid_token` — opaque tokens required |
| `POST /api/mcp` with `Bearer oat_thisisnotarealtokenvalue` | PASS | `401` “The access token is invalid or has expired.” Clerk was asked; the fake token was rejected |
| Protected-resource metadata | PASS | `200` `resource: http://127.0.0.1:3100/api/mcp`, scopes as above |
| Authorization-server metadata proxy | BLOCKED | Live `502 temporarily_unavailable` — this host cannot fetch Clerk’s `/.well-known/oauth-authorization-server` without a real Clerk issuer |
| MCP `initialize` after a valid member token | BLOCKED | Needs a real Clerk OAuth opaque token for a provisioned firm |
| Claude Desktop / claude.ai connected | BLOCKED | Not configured; this machine is not reachable as a public HTTPS origin |
| ChatGPT connected | BLOCKED | Same |

### In-process protocol (MCP TypeScript SDK, PGlite)

| Check | Status |
| --- | --- |
| Streamable HTTP `initialize` (protocol `2025-06-18`) + `tools/list` + `tools/call` | PASS (`tests/connector-http.test.ts`) |
| In-memory SDK handshake + `tools/list` | PASS |
| Case-work hidden when firm switch is off | PASS |
| Case-work hidden for unrecognized OAuth client | PASS |
| Locked firm: only `get_connection_info` | PASS |

---

## 5. MCP tools discovered and tested

Owner/admin with case work on and a recognized client. `get_document_download_link` appears only when the firm also allows download links (it did not, in this run).

| Tool | Group | Executed | Status | Result |
| --- | --- | --- | --- | --- |
| `get_connection_info` | account | yes | PASS | Firm name “Northbrook Immigration PLLC”, role owner/admin |
| `search` | library | yes | PASS | Structured empty results (no library corpus) |
| `fetch` | library | yes | PASS | Invalid id refused |
| `search_library` | library | yes | PASS | Empty corpus handled |
| `read_library_document` | library | listed only | BLOCKED | Needs a real library document id from a populated DB |
| `lookup_library_citation` | library | yes | PASS | “Not found in the library” (honest empty result, not a placeholder success) |
| `search_eoir_judges` | library | yes | PASS | Reports that EOIR stats are not loaded yet |
| `eoir_judge_profile` | library | yes | PASS | Same |
| `query_eoir_stats` | library | yes | PASS | Same |
| `list_clients` | case work | yes | PASS | Returned “John Smith”; **did not** leak DOB |
| `create_client` | case work | yes | PASS | Unconfirmed call refused; confirmed call with `date_of_birth: 1988-04-12` created a client and returned `client_id` |
| `create_matter` | case work | yes | PASS for `i130`; employment type rejected | `employment_based` → invalid input “Case type: choose a case type from the list.” |
| `add_matter_party` | case work | yes | PASS | Linked John Smith as beneficiary |
| `list_matters` | case work | yes | PASS | Matter listed with John Smith |
| `get_matter` | case work | yes | PASS | I-130 + John Smith; no A-number leaked |
| `list_skills` | case work | yes | PASS | Catalog for the I-130 matter, including I-130 skills |
| `run_skill` | case work | listed only | BLOCKED | Needs pg-boss worker + `ANTHROPIC_API_KEY` + matter documents |
| `get_skill_run` | case work | yes | PASS | Unknown run id refused |
| `list_legal_updates` | case work | yes (empty feed) | BLOCKED for live feed | Tool works; monitor job needs DB + network collectors |
| `get_document_download_link` | case work | call while hidden | PASS | Refused (firm download switch off / not listed) |
| `add_case_note` / `add_note` | — | — | NOT IMPLEMENTED | Not in `tools/list` |

Read-only identity: `create_client` is absent from `tools/list` and a direct call is refused. **PASS**.

---

## 6. AI integration

| Check | Status | Notes |
| --- | --- | --- |
| Skill catalog in-process | PASS | `list_skills` returned real skill names/labels for I-130 |
| Queue a skill run (`run_skill` or matter-page Run) | BLOCKED | `ANTHROPIC_API_KEY`, worker, queue DB |
| Summarize a case | NOT IMPLEMENTED as a dedicated tool | Closest: skills such as claim evaluation / packet review, which still need `run_skill` |
| Identify missing information / documents | NOT IMPLEMENTED as a dedicated tool | Closest: packet-review / evidence-organizer skills via `run_skill` |
| Library-backed research | BLOCKED live | Library ingest jobs have not been run against Neon |

---

## 7. End-to-end immigration workflow (fictional)

Fictional firm in tests: **Northbrook Immigration PLLC**. Fictional client: **John Smith**, DOB 1988-04-12, country of birth Nigeria. No real client data was used.

| Step | Status | Notes |
| --- | --- | --- |
| 1. Create client John Smith | PASS | MCP `create_client` after `confirm: true` |
| 2. Employment-based visa case | NOT IMPLEMENTED | `create_matter` with `employment_based` is rejected. Supported types are asylum, withholding/CAT, cancellation, VAWA, I-130, I-90 only |
| 2b. Substitute case | PASS | Created an **I-130 Family Petition** matter and linked John Smith as beneficiary |
| 3. Client information / case notes | PASS for profile fields · NOT IMPLEMENTED for standalone notes | Profile fields stored; no MCP/UI case-note tool. Notes would be `attorney_note` on `run_skill` |
| 4. Upload a sample document | BLOCKED | S3 + scan worker. MCP never uploads files; Connect page tells users to upload in the web app |
| 5. Ask AI to summarize the case | BLOCKED | `run_skill` |
| 6. Ask AI for missing information/documents | BLOCKED | `run_skill` |
| 7. Retrieve client and case through MCP | PASS | `list_clients`, `list_matters`, `get_matter` |
| 8. Add a case note through MCP | NOT IMPLEMENTED | |
| 9. Retrieve updated case | PASS for party link · NOT IMPLEMENTED for note update | `get_matter` showed the beneficiary link |
| 10. Dashboard reflects the update | BLOCKED live | No signed-in dashboard. MCP list/get reflected the new client and matter |

---

## 8. Security and tenant isolation

| Check | Status | Evidence |
| --- | --- | --- |
| RLS forced on tenant tables | PASS | PGlite migration tests |
| Firm A cannot read Firm B clients/matters/documents | PASS | `tests/tenant-isolation.test.ts` |
| MCP writes stay in the authenticated tenant | PASS | create client/matter/party |
| Cross-tenant document download denied | PASS | |
| Unset tenant context returns no rows | PASS | |
| Read-only cannot create clients | PASS | |
| Missing MCP token → 401 + resource metadata | PASS | Live and unit |
| Invalid / JWT / fake opaque token → 401 | PASS | Live |
| Unrecognized OAuth client: library only | PASS | |
| Connector redacts A-numbers and DOB in skill reports | PASS (code + list_clients/get_matter) | `list_clients` did not return `1988-04-12` |
| Live Clerk session isolation in the browser | BLOCKED | No Clerk |

---

## 9. Bugs discovered and fixes applied

1. **`create_client` date-of-birth regex was wrong** (`src/services/connector/tools/case-work.ts`). The pattern was a double-escaped `\\d`, so a real ISO date such as `1988-04-12` failed validation. It is now `/^\d{4}-\d{2}-\d{2}$/` plus a calendar-date refine. Retested in the John Smith MCP workflow: **PASS**.

2. **Public `/setup` was not public** (`src/proxy.ts`). The landing and public nav link to `/setup`, but Clerk middleware only allowed `/`, `/pricing`, `/terms`, `/privacy`, sign-in/up, webhooks, health/ready, and MCP. Unsigned visitors were sent to Clerk. `/setup` is now in the public matcher. Retested on webpack-dev: **PASS** (`200`, connector instructions rendered). The already-running `next start` on 3100 still uses the old bundle, so it still redirects `/setup` until rebuilt.

No other product bugs were patched in this pass. Unimplemented case types and note tools were left unimplemented rather than faked.

---

## 10. Credentials still required for real-world use

Fill `.env.local` from `.env.example`. Do not commit it.

| Need | Variables / action |
| --- | --- |
| Postgres (Neon recommended) | `DATABASE_URL` (runtime role, pooled, **no** `BYPASSRLS`), `MIGRATION_DATABASE_URL` (owner), `QUEUE_DATABASE_URL` (runtime role, direct) |
| Clerk | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`. Enable Organizations. Create custom OAuth scope `practice:connector`. Access tokens must be **opaque**. Publish CIMD. Default dynamic-client scopes: `openid profile email user:org:read practice:connector`. Require PKCE |
| Public origin | `CONNECTOR_PUBLIC_ORIGIN=https://<your-host>` (no path). Required in production; MCP answers 500 without it |
| Client allow list | After the first Claude and ChatGPT connections, set `CONNECTOR_ALLOWED_CLIENT_IDS` (and optionally `CONNECTOR_ALLOWED_CLIENT_ID_PREFIXES`) from unrecognized clients on the Firm page. Until then, connections get **library tools only** |
| Anthropic | `ANTHROPIC_API_KEY` on the **worker** for skill runs |
| Object storage | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_DOCUMENTS_BUCKET` (versioned, KMS) |
| Billing (after the free month) | `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` |
| Email (optional) | `SES_FROM_ADDRESS` + SES-verified domain |
| Platform operators | `LIBRARY_IMPORT_ADMINS` (Clerk user ids) |

---

## 11. Connecting Claude Desktop and ChatGPT

**Do not treat this as a verified live connection.** These are the project’s real integration steps. The server URL is:

```text
https://<CONNECTOR_PUBLIC_ORIGIN host>/api/mcp
```

Example once deployed: `https://app.example.com/api/mcp`.  
Local `http://127.0.0.1:3100/api/mcp` answers 401 correctly but **cannot** be used by claude.ai or ChatGPT: they need a public HTTPS origin and a working Clerk OAuth issuer.

### Claude (claude.ai, Claude Desktop, Claude mobile)

Custom connectors need Claude **Pro, Max, Team, or Enterprise**. Claude Free does not support this flow.

1. In the MeritDesk app, an owner/admin opens `/connect` (or the public `/setup` page) and copies the server URL.
2. **Pro / Max:** Settings → Connectors → Add custom connector. Name it `MeritDesk.AI`, paste the URL. Leave OAuth client ID and secret **empty**.
3. **Team / Enterprise:** an Owner adds it once under Organization connectors, then each member connects with their own MeritDesk account.
4. Choose Connect. Sign in to MeritDesk, pick the firm, allow `practice:connector`.
5. In a chat, enable the connector from the tools / + menu.

Claude Code (HTTP transport; case work still needs a CIMD client id on the allow list):

```bash
claude mcp add --transport http meritdesk https://<your-host>/api/mcp
```

### ChatGPT

1. Business / Enterprise / Edu: an admin may need to allow custom MCP servers (developer mode). ChatGPT Pro can use `search` / `fetch` only; write tools need Business/Enterprise/Edu.
2. Plugins → + → Add custom MCP server.
3. Name: `MeritDesk.AI`. URL: `https://<your-host>/api/mcp`. Authentication: **OAuth**.
4. Acknowledge the warning, create, connect, sign in to MeritDesk, choose the firm.
5. In a chat, pick the connector from apps/plugins or `@`.

### First-connection allow list (required for case work)

1. Deploy with `CONNECTOR_PUBLIC_ORIGIN` set and the allow list **empty**.
2. Turn case work on for a test firm (Firm page disclosure).
3. Connect once from Claude and once from ChatGPT. Library tools work; `get_connection_info` names the unrecognized client id.
4. Copy those ids from the Firm page into `CONNECTOR_ALLOWED_CLIENT_IDS`.
5. Reconnect. Case-work tools appear. Turn Clerk DCR off once CIMD ids are stable.

Full Clerk and directory notes: `docs/CONNECTORS.md`.

---

## 12. Remaining blockers preventing real-world use

1. **No `.env.local` and no managed services on this machine** — Neon, Clerk, Stripe, S3, Anthropic, SES.
2. **No public HTTPS origin** — Claude and ChatGPT cannot complete OAuth against `127.0.0.1`.
3. **Clerk OAuth not configured here** — opaque tokens, `practice:connector` scope, CIMD, webhook, organizations.
4. **Empty client allow list** — even after OAuth works, case-work tools stay hidden until Claude/ChatGPT client ids are allow-listed.
5. **Skill runs and document uploads** — worker + Anthropic + S3 + malware scan.
6. **Employment-based visas** — not a matter type and not in the skill catalog.
7. **No standalone case-note tool** — notes only as `attorney_note` on `run_skill`.
8. **Library and EOIR corpora empty** until ingest jobs run against a real database.
9. **Windows native Next SWC missing** — use `next dev --webpack` / `next build --webpack` locally; Linux CI can use the default build.

What *is* usable once those credentials exist: Streamable HTTP MCP at `/api/mcp`, OAuth discovery, tenant-scoped case-work tools, and the web portal for firm setup, billing, uploads, and connector switches. That MCP path was exercised for real against the SDK and against the running HTTP server; it is not a mock.
