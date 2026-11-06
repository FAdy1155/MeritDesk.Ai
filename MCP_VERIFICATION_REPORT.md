# MeritDesk.AI — MCP Verification Report

Date: 2026-11-06 (updated after CONNECTOR_PUBLIC_ORIGIN-only MCP URLs)

**Configuration change:** MCP resource URLs, OAuth audience, protected-resource metadata, billing links, and the `/setup` copy field come only from validated `CONNECTOR_PUBLIC_ORIGIN`. Request `Host` / `X-Forwarded-Host` / listen `PORT` are ignored and never rewrite the URL. See `MCP_SETUP.md`.

Instances used after restarting webpack-dev with an explicit origin:

- Production: `http://localhost:3100` (`next start`, `CONNECTOR_PUBLIC_ORIGIN=http://127.0.0.1:3100`, existing production bundle)
- Development: `http://localhost:3101` (`next dev --webpack`, restarted with `CONNECTOR_PUBLIC_ORIGIN=http://127.0.0.1:3101`)
- Setup page: `http://localhost:3101/setup`

This report is from live HTTP calls against those processes plus in-process MCP SDK tests. A `/setup` HTTP 200 is **not** treated as MCP working.

---

## Exact MCP endpoint

| Instance | Endpoint |
| --- | --- |
| Code | `POST /api/mcp` (`src/app/api/mcp/route.ts`, `MCP_ENDPOINT_PATH`) |
| Production process | `http://127.0.0.1:3100/api/mcp` |
| Development process | `http://127.0.0.1:3101/api/mcp` |
| URL `/setup` shows (3101, live) | `http://127.0.0.1:3101/api/mcp` |
| URL `/setup` shows (3100, live) | **404** — stale production bundle does not include the public `/setup` route |

Live check after the origin restart: `/setup` on 3101 copies `http://127.0.0.1:3101/api/mcp` (no port 3000), states that this is loopback HTTP for local protocol tests, and states that Claude/ChatGPT need public HTTPS. Protected-resource metadata `resource` is the same URL. OAuth issuer in that document is Clerk (`https://clerk.meritdesk.test` on 3101; build-time `https://example.com` on 3100), not the MCP origin.

Related public discovery URLs:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/api/mcp`
- `GET /.well-known/oauth-authorization-server` (proxy of Clerk’s document)

---

## Transport type

**Streamable HTTP**, stateless, JSON responses (`WebStandardStreamableHTTPServerTransport`, `enableJsonResponse: true`, no session id).

- JSON-RPC **POST** only; one message per request (batches → 400 after auth).
- **GET** (SSE) and **DELETE** (end session) are 405 **after** authentication (`Allow: POST`).
- Unauthenticated GET/DELETE/POST all return **401** first. That is what both live instances did.

Protocol version exercised in tests: **2025-06-18**.

There is **no stdio MCP server** and no `claude_desktop_config.json` command. Claude Desktop / claude.ai / ChatGPT are expected to call this HTTP URL with OAuth.

---

## Authentication method

Every live `/api/mcp` request is authenticated by `clerkConnectorAuthenticator` **before** JSON-RPC is parsed.

Required token:

1. `Authorization: Bearer <token>`
2. Shape: Clerk **opaque** OAuth token (`oat_…`). JWTs are refused so revocation can be checked on every call.
3. Clerk `authenticateRequest` with `acceptsToken: "oauth_token"` and audience = exact MCP resource URL
4. Scopes: `openid profile email user:org:read practice:connector`
5. Live Clerk membership + app tenant row for the chosen organization
6. Case-work tools additionally require the OAuth client id on `CONNECTOR_ALLOWED_CLIENT_IDS` / prefixes, and the firm’s case-work switch

A missing token returns 401 with:

```http
WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource", scope="openid profile email user:org:read practice:connector"
```

That is how Claude and ChatGPT are supposed to discover Clerk.

---

## Can MCP be initialized without PostgreSQL or Clerk?

| Path | Initialize + `tools/list` | Tool execution |
| --- | --- | --- |
| Live `http://127.0.0.1:3100/api/mcp` and `:3101/api/mcp` | **No.** Auth is Clerk. After a valid token, `defaultConnectorDeps.settings` / `entitlement` / rate limits hit Postgres. | Library tools need the library tables; case-work tools need tenant tables |
| In-process MCP SDK (injected authenticator, PGlite or stubs) | **Yes.** This is how the protocol was actually verified. | **Yes** for tools whose deps are wired |

Live `initialize` never reached JSON-RPC on 3100 or 3101: every POST without a real Clerk opaque token stopped at 401.

---

## MCP protocol initialization result

### Live HTTP (3100 and 3101)

| Call | Result |
| --- | --- |
| `POST /api/mcp` `initialize` (no token) | **401** `invalid_token` — not a JSON-RPC initialize result |
| `POST /api/mcp` `tools/list` (no token) | **401** |
| `POST` JWT bearer | **401** opaque token required |
| `POST` `Bearer oat_phase2faketokenvalue` | **401** “The access token is invalid or has expired.” (Clerk was asked; fake token rejected) |
| Protected-resource metadata | **200** |
| Authorization-server metadata | **502** `temporarily_unavailable` — Clerk issuer is not a real Clerk Frontend API |

**Live JSON-RPC initialize: not completed. BLOCKED on Clerk.**

### In-process Streamable HTTP (injected auth, no Clerk)

`tests/connector-http.test.ts`:

- `initialize` → HTTP 200, `protocolVersion: "2025-06-18"`, tools capability present
- `tools/list` → includes `list_matters` for an authorized read-only member
- `tools/call` `list_matters` → structured firm data

**In-process initialize: PASS.**

---

## Actual tools discovered

From MCP `tools/list` in-process (not from `/setup` copy).

**Always (when the firm is not locked):**

| Tool | Group |
| --- | --- |
| `get_connection_info` | account |
| `search` | library |
| `fetch` | library |
| `search_library` | library |
| `read_library_document` | library |
| `lookup_library_citation` | library |
| `search_eoir_judges` | library |
| `eoir_judge_profile` | library |
| `query_eoir_stats` | library |

**Case work, every role, when the firm switch is on and the OAuth client is allow-listed:**

`list_clients`, `list_matters`, `get_matter`, `list_skills`, `get_skill_run`, `list_legal_updates`

**Additionally for owner/admin, attorney, paralegal:**

`create_client`, `create_matter`, `add_matter_party`, `run_skill`

**Additionally when the firm allows download links:**

`get_document_download_link`

**Locked firm:** `get_connection_info` only.

**Unrecognized OAuth client / case-work switch off:** library + `get_connection_info` only.

---

## Tools successfully executed

Executed through the MCP SDK against the real tool implementations (PGlite for case work; empty library/EOIR stubs). Not executed through Claude or ChatGPT.

| Tool | Result |
| --- | --- |
| `get_connection_info` | PASS — firm name and role |
| `search` | PASS — empty structured results |
| `fetch` | PASS — invalid id refused |
| `search_library` | PASS — empty corpus |
| `lookup_library_citation` | PASS — not found (honest empty library) |
| `search_eoir_judges` | PASS — “EOIR stats not loaded” |
| `eoir_judge_profile` | PASS — same |
| `query_eoir_stats` | PASS — same |
| `list_clients` | PASS — “John Smith”; DOB not returned |
| `create_client` | PASS with `confirm: true` and ISO DOB; refused without `confirm` |
| `create_matter` | PASS for `i130`; `employment_based` invalid input |
| `add_matter_party` | PASS |
| `list_matters` | PASS |
| `get_matter` | PASS |
| `list_skills` | PASS — I-130 catalog |
| `get_skill_run` | PASS — unknown id refused |
| `list_legal_updates` | PASS — empty feed |
| `get_document_download_link` | PASS as refusal (switch off) |
| `read_library_document` | listed; not called with a real library id |
| `run_skill` | listed; not executed (needs worker + Anthropic) |

Read-only identity cannot create a client: PASS.

---

## Failed tests and causes

| Test | Cause | Configuration vs code |
| --- | --- | --- |
| Live JSON-RPC `initialize` / `tools/list` | No Clerk opaque access token | **Configuration** |
| Live Clerk authorization-server metadata | Issuer is placeholder (`https://example.com` on 3100 from the **build-time** publishable key; `https://clerk.meritdesk.test` on 3101 from the runtime dummy key). Fetch times out / 502 | **Configuration** |
| Live Postgres readiness | Dummy `DATABASE_URL` | **Configuration** |
| Claude Desktop / ChatGPT connection | Local HTTP, no public HTTPS origin, no Clerk OAuth | **Configuration** |
| `/setup` copy field on 3101 showed `:3000` | The process had inherited `CONNECTOR_PUBLIC_ORIGIN=http://127.0.0.1:3000`. Code now copies only that variable (never Host). Restarted 3101 with `CONNECTOR_PUBLIC_ORIGIN=http://127.0.0.1:3101`; live `/setup` copies `http://127.0.0.1:3101/api/mcp` | **Fixed and verified live** |
| `/setup` on 3100 | Stale `next start` bundle: `/setup` is 404. MCP metadata on 3100 is already `http://127.0.0.1:3100/api/mcp`. Source now includes `/setup` as a public route (`src/proxy.ts`) | **Stale production bundle** |
| Employment-based visa matter | Not in `MATTER_CASE_TYPES` | **Not implemented** |
| Standalone MCP case-note tool | Does not exist | **Not implemented** |

Code defects fixed during this verification:

1. `create_client` `date_of_birth` regex (earlier in this session) — real ISO dates now validate.
2. `/setup` missing from Clerk public routes.
3. MCP / OAuth resource URLs were derived from request `Host` (webpack-dev advertised `:3000`). They now come only from validated `CONNECTOR_PUBLIC_ORIGIN`. Covered by `tests/connector-origin.test.ts` (3100 vs 3101, inherited `:3000` not rewritten by `PORT=3101`, missing env does not invent localhost:3000, Clerk issuer stays separate from the resource URL).

---

## Minimum credentials required

### PostgreSQL (Neon or any Postgres 15+)

| Variable | Role | Format |
| --- | --- | --- |
| `DATABASE_URL` | App runtime role, **pooled** | `postgresql://app_runtime:PASSWORD@HOST-pooler/DB?sslmode=require` |
| `MIGRATION_DATABASE_URL` | Table owner | `postgresql://neondb_owner:PASSWORD@HOST/DB?sslmode=require` |
| `QUEUE_DATABASE_URL` | Same runtime role, **direct** (not PgBouncer) | `postgresql://app_runtime:PASSWORD@HOST/DB?sslmode=require` |

The runtime role must be `NOSUPERUSER NOBYPASSRLS` and must not own the tables (`src/db/client.ts` refuses a bypassing role). See README “Database roles”.

Migrations: **ready**. Journal `src/db/migrations/meta/_journal.json` runs `0000` through `0018_usage_quotas_admin` (includes `0012_connector` and `0013_connector_unrecognized_clients`). Command:

```bash
npm run db:migrate
```

Uses `MIGRATION_DATABASE_URL`, else `DATABASE_URL`. Then `npm run db:seed-skills` for the skill catalog.

### Clerk (required for any live MCP handshake)

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_test_…` / `pk_live_…` (also encodes the OAuth issuer host) |
| `CLERK_SECRET_KEY` | `sk_test_…` / `sk_live_…` |
| `CLERK_WEBHOOK_SECRET` | Org/membership sync |
| `CLERK_OAUTH_ISSUER` | Optional override of the Frontend API URL |

Dashboard:

- Organizations on; user-created orgs **off**
- Custom scope **`practice:connector`**
- Default dynamic-client scopes: `openid profile email user:org:read practice:connector`
- **Opaque** access tokens (not JWT)
- Publish **CIMD**; PKCE required
- Redirect URIs only if pre-registering a client (Claude `https://claude.ai/api/mcp/auth_callback`; ChatGPT the callback shown in its MCP UI)

### Connector

| Variable | Purpose |
| --- | --- |
| `CONNECTOR_PUBLIC_ORIGIN` | `https://<public-host>` (no path). Required in production; MCP 500 without it. Locally set it to the URL you will paste into Claude/ChatGPT |
| `CONNECTOR_ALLOWED_CLIENT_IDS` | After first Claude/ChatGPT connections, or case work stays hidden |

Skill runs also need `ANTHROPIC_API_KEY` on the worker and `QUEUE_DATABASE_URL`. Uploads need S3. Not required for `initialize` + read-only library `tools/list`.

**Minimum to complete a live `initialize` + `tools/list`:** real Clerk keys + opaque member token + `CONNECTOR_PUBLIC_ORIGIN` matching the URL used + migrated `DATABASE_URL` + a provisioned firm membership. Library tool bodies then need library rows; case-work tools need the firm switch and allow list.

---

## Exact Claude Desktop configuration

MeritDesk is a **remote HTTP MCP server with OAuth**, not a local stdio process.

Do not add a `command` / `npx` block to `claude_desktop_config.json`. That is not this project’s transport.

1. Use Claude **Pro, Max, Team, or Enterprise** (Free cannot add this custom connector).
2. Deploy (or tunnel) the app at an **https** origin. Paste:

   ```text
   https://<CONNECTOR_PUBLIC_ORIGIN host>/api/mcp
   ```

   Local `http://127.0.0.1:3100/api/mcp` and `http://127.0.0.1:3101/api/mcp` are **not** usable by Claude’s hosted OAuth client (HTTP loopback).
3. Claude Desktop / claude.ai: **Settings → Connectors → Add custom connector**.
4. Name: `MeritDesk.AI`. URL: the `https://…/api/mcp` value. **Leave OAuth client ID and secret empty.**
5. Connect → Clerk sign-in → choose the firm → allow `practice:connector`.
6. In a chat: Search and tools → enable MeritDesk.

Team/Enterprise: an Owner may need to add it under organization connectors first.

Claude Code:

```bash
claude mcp add --transport http meritdesk https://<host>/api/mcp
```

Case work still needs that client’s id on the allow list (CIMD). DCR-only random ids will only see library tools.

**Claude Desktop was not connected in this verification.**

---

## Exact ChatGPT connection instructions

1. ChatGPT **Business / Enterprise / Edu** for write tools (`create_client`, `create_matter`, `run_skill`, download links). ChatGPT Pro: `search` / `fetch` only.
2. Workspace admin may need to allow custom MCP (developer mode).
3. chatgpt.com → **Plugins** → **+** → **Add custom MCP server**.
4. Name: `MeritDesk.AI`.
5. Endpoint: `https://<host>/api/mcp` (ChatGPT requires **public HTTPS**; localhost HTTP will not work).
6. Authentication: **OAuth**. Leave client id/secret empty unless you pre-registered an app in Clerk.
7. Acknowledge the warning → create → connect → MeritDesk sign-in → choose firm.
8. New chat → pick the plugin or `@MeritDesk.AI`.

**ChatGPT was not connected in this verification.**

---

## Whether `/setup` matches the implementation

Checked live HTML at `http://localhost:3101/setup` (200).

Accurate:

- Remote MCP, OAuth, no installable desktop agent
- Leave client ID / secret blank
- Claude custom connector; Free not supported
- ChatGPT Plugins → custom MCP server; Business/Enterprise/Edu for writes
- Case-work may be missing until the owner enables it and the platform allow-lists the client
- Uploads stay in the web app, not MCP

Verified on the running 3101 setup page (200):

- Copied server address is `http://127.0.0.1:3101/api/mcp` (matches `CONNECTOR_PUBLIC_ORIGIN` and live protected-resource metadata). Port 3000 is not present.
- Loopback HTTP is labelled as local-only; Claude Desktop / claude.ai / ChatGPT are stated to need public HTTPS.
- Protected-resource metadata URL is shown; OAuth issuer is described as Clerk, not this origin.

Still incomplete (docs, not protocol):

- Does not mention Claude Code `--transport http`
- Wording “Settings → Connectors” vs `docs/CONNECTORS.md` “Customize, Connectors” for personal plans (UI variant, not a protocol mismatch)

---

## Is MCP genuinely functional, or still blocked?

**The MCP implementation is real Streamable HTTP with OAuth, a 2025-06-18 handshake, a full tool catalog, and working tool handlers.** That was proven in-process, including a John Smith create/list/get workflow.

**The running 3100/3101 servers are not a usable MCP server for Claude or ChatGPT right now.** Live `/api/mcp` only proves the auth gate: 401 + resource metadata. JSON-RPC initialize never ran against those processes. Clerk OAuth metadata is 502. Postgres is down. `/setup` returning 200 does not change that.

Status for “can I point Claude Desktop or ChatGPT at localhost and work”: **BLOCKED**.
