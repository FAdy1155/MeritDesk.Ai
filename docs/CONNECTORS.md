# Claude and ChatGPT connector

The app is one remote MCP server, at `<app origin>/api/mcp`, that a firm's
members can add to Claude (as a custom connector, or from the Connectors
Directory once listed) and to ChatGPT (as a custom MCP server, or from the
plugin directory once listed). Each member signs in with their own app
account through OAuth; Clerk, the app's identity provider, is the
authorization server. Nothing is shared between members: every call acts as
the signed-in member, in the firm they chose, with their current role.

- **Library tools, for everyone.** Search and read the app's library of
  official immigration-law sources and its EOIR statistics. No client or firm
  data is involved, and no firm setting is needed.
- **Case-work tools, per firm and per client app.** The firm's matters,
  documents lists, skill catalog, skill runs and their reports, and the
  legal-update feed, plus queuing a skill run. Off until the firm's
  owner/admin turns them on from the Firm page after acknowledging a
  disclosure; listed per role; and offered only to a connection made from an
  OAuth client the platform recognizes (the client allow list, section 3).

Code: `src/services/connector/` (server, tools, auth, token shape, per-IP
and Postgres rate limits, redaction, metadata), `src/lib/connector/` (the
firm's switches, the disclosure, the tenant reads, unrecognized clients),
`src/app/api/mcp/route.ts` and `src/app/.well-known/`. Migration
`0012_connector.sql` adds `tenant_connector_settings` and
`connector_rate_buckets`; `0013_connector_unrecognized_clients.sql` adds
`connector_unrecognized_clients`; all three are under the usual
`tenant_isolation` policy.

Contents: 1. Tools. 2. How a firm connects. 3. Platform setup (Clerk,
the client allow list, environment). 4. How authentication works. 5. Privacy
and safety. 6. Submitting to the directories. 7. Researched requirements.
8. What was verified and what was not. 9. Open decisions and known limits.

## 1. Tools

| Tool | Group | Who sees it | Annotations | Audited |
| --- | --- | --- | --- | --- |
| `get_connection_info` | account | everyone | read-only | no |
| `search` | library | everyone | read-only | no |
| `fetch` | library | everyone | read-only | no |
| `search_library` | library | everyone | read-only | no |
| `read_library_document` | library | everyone | read-only | no |
| `lookup_library_citation` | library | everyone | read-only | no |
| `search_eoir_judges` | library | everyone | read-only | no |
| `eoir_judge_profile` | library | everyone | read-only | no |
| `query_eoir_stats` | library | everyone | read-only | no |
| `list_matters` | case work | every role | read-only | yes |
| `get_matter` | case work | every role | read-only | yes |
| `list_skills` | case work | every role | read-only | yes |
| `get_skill_run` | case work | every role | read-only | yes |
| `list_legal_updates` | case work | every role | read-only | yes |
| `run_skill` | case work | owner/admin, attorney, paralegal (`EDITOR_ROLES`) | not read-only, not destructive, open world, not idempotent | yes |
| `get_document_download_link` | case work | owner/admin, attorney, paralegal (`EDITOR_ROLES`), only when the firm allows download links | not read-only, not destructive, open world, not idempotent | yes |

Case-work tools are listed only when the firm's switch is on and the
connection's OAuth client is on the platform's allow list; otherwise they
are absent from `tools/list`, and a call to one is refused with a message
saying why (for an unrecognized client, that the client id is not on the
platform's list, naming it).

**Locked firms.** Every firm gets a free month, then pays per member on the
website (README "Trial, billing and emails"). While a firm is locked (the
free month ended without a subscription, the subscription was canceled or
went unpaid, or a failed payment's grace period ran out), `tools/list`
offers `get_connection_info` only, and every other call, library tools
included, is refused with the state and the Billing page's URL
(`CONNECTOR_PUBLIC_ORIGIN` plus `/billing`). `get_connection_info` always
states where the firm stands (days left in the free month, the next
payment, a failed payment's grace period, or the lock). Subscribing and
paying happen only on the website, never in Claude or ChatGPT: the
connector names the page and nothing more. Refusals for a locked firm
write nothing to the audit log. The state is read once per request
(`ConnectorDeps.entitlement`), so a payment that lands takes effect on the
next call.

Every tool has a `title` and `readOnlyHint`/`destructiveHint` (the Claude
directory requirement); read-only tools also say `idempotentHint: true` and
`openWorldHint: false` (ChatGPT uses these for confirmation behavior).
Two tools are marked not read-only, so Claude and ChatGPT ask the user
before calling them, and both also refuse any call without `confirm: true`:
`run_skill` creates a run, spends the firm's model budget and may add
generated documents to the matter; `get_document_download_link` lets a
client document leave the app through a bearer link into a third-party
conversation. Both re-check the caller with Clerk without the role cache
before they run (section 4).

**search and fetch** have the shapes ChatGPT deep research and company
knowledge expect: `search({ query })` returns `{ results: [{ id, title, url }] }`
(up to 10), `fetch({ id })` returns `{ id, title, text, url, metadata }`, each
as `structuredContent` with the same JSON in a text block, and each with an
`outputSchema`. `url` is always the document's official URL (the page or file
on the government or court site), never the app's reader page, so ChatGPT's
citations point at the official source. `fetch` returns up to 40,000
characters of the document's text, framed as quoted data like every other
library text (section 5): `text` starts with the line saying the block is
data, then the text between nonce markers. `metadata.source_summary` is
framed the same way, and every title (in `search` and `fetch`) has any
marker-like sequence defused. `metadata.continue_with` names the offset (in
the document's own text) to read on with `read_library_document`.

**search_library, read_library_document, lookup_library_citation** and the
EOIR statistics tools return the same text the skill runs' library tools
return (`src/services/skill-runner/tools/library.ts`,
`src/services/library/adapters/eoir-statistics/`), including the official
URL to cite, the source's last refresh (STALE when overdue), and the
non-precedential label for unpublished BIA and AAO decisions.

**What the case-work tools return** is deliberately narrower than the matter
page (`src/lib/connector/case-work.ts`): party names and roles, but no
A-number, date of birth or contact details from the client records; each
document's name, type, size, page count and malware scan status, but never
its storage key, its bytes or its extracted text; a run's status, flags,
error and (once completed) its report, but not its input snapshot (case
note, firm identity); legal updates with whether they were reviewed, but not
the review notes. Signature images, the audit log, API keys and other firms'
data are never read by any tool.

**Skill run reports are client data.** A report is written from the
client's documents. `get_skill_run` passes the whole run through
`src/services/connector/redact.ts` first: the value of any key named for an
A-number or a date of birth (`aNumber`, `a_number`, `alienNumber`,
`dateOfBirth`, `date_of_birth`, `dob`, `birthDate`, at any depth) and any
A-number in a string ("A" followed by 8 or 9 digits, with or without dashes
or spaces between the groups, and labeled forms such as "A-Number:
123 456 789") become `[redacted in connector]`. What a report still
contains: client names, the facts of the case, places, and every other
date, including a date of birth written into a sentence rather than under
its own key, and a bare nine-digit number with no "A" or label. The Firm
page's disclosure says so.

**Download links** (`get_document_download_link`) exist only when the firm
turned them on, only for editor roles, only with `confirm: true`, and only
for a document whose malware scan came back clean; they are the same
5-minute presigned links the matter page issues (`getDocumentDownloadUrl`),
pinned to the scanned version, and each one (and each refusal) writes
`document.download` or `document.download_blocked` with `after.via:
"connector"` plus a `connector.tool_call` row.

## 2. How a firm connects

**The firm's owner/admin, once (in the app).** The Connect page (`/connect`,
where a new firm lands after creating itself, and what the welcome email,
the landing page and the Firm page link to) shows the server URL with a
copy button and the steps below for Claude and ChatGPT. The Firm page,
section "Claude and ChatGPT connector", holds the switches. The library
tools need nothing.
To turn case work on, read the disclosure, tick the acknowledgment, and
select Turn case work on. Download links are a second switch, off by
default. Both are audited (`connector_settings.update`). The disclosure is
versioned (`CONNECTOR_DISCLOSURE_VERSION` in `src/lib/connector/disclosure.ts`,
now `2026-10-21.2`): when its text changes, the version must change too, and
case work pauses for every firm until an owner/admin acknowledges the new
text.

The same section warns when the platform recognizes no client yet (case
work then works for nobody), and lists to the owner/admin the **unrecognized
clients** members connected from: each client id with when it was first and
last seen. After the firm's first test connection, the real Claude or
ChatGPT client id shows up here for the platform's operator (section 3). A
client id nobody at the firm recognizes may mean a member authorized an app
that only called itself Claude: ask them to disconnect it.

**From Claude** (claude.ai, Desktop, mobile; Claude Code works the same way
with `claude mcp add --transport http <name> <server URL>`, but see section 3
on DCR):

1. Team or Enterprise plan: an Owner adds the connector once in Organization
   settings, Connectors, Add, Custom, Web, with the server URL. Free, Pro or
   Max plan: each person adds it under Customize, Connectors, Add custom
   connector. Leave the OAuth client ID and secret empty: Claude registers
   itself with Clerk (CIMD, or DCR while it is on, see section 3).
2. Members select Connect (Customize, Connectors). A Clerk sign-in page opens;
   the member signs in with their app account, chooses the firm on the
   consent screen, and allows access.
3. In a chat, turn the connector on from the + menu, Connectors. Read-only
   tools may run without a prompt; `run_skill` and
   `get_document_download_link` ask first.

**From ChatGPT:**

1. Open Plugins (chatgpt.com/plugins), select the plus button, then Add custom
   MCP server. Enter a name, the server URL and OAuth. On Business and
   Enterprise workspaces an admin may have to allow custom MCP servers first
   (OpenAI's help article calls this developer mode, under the workspace's
   settings).
2. Review the warning, continue, create, then connect: sign in to the app,
   choose the firm, allow access.
3. In a chat, pick the connector (tools menu or @). Deep research and company
   knowledge use `search` and `fetch`.

**A member of several firms** chooses the firm on Clerk's consent screen (the
`user:org:read` scope adds an organization selector there). To switch firms,
disconnect and connect again. `get_connection_info` shows the firm and role a
connection acts as, and whether its client is recognized.

## 3. Platform setup

### Clerk (the authorization server)

In the Clerk dashboard, OAuth applications
(clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth):

- **Scopes tab: create the connector's custom scope**, `practice:connector`
  (or whatever `CONNECTOR_REQUIRED_SCOPE` says). The connector refuses every
  token without it (403 `insufficient_scope` naming it). Clerk issues OAuth
  tokens for every OAuth application of the instance and documents no
  audience for the MCP resource, so this scope is what marks a token as one
  for the connector: a token issued for another OAuth application of the
  same instance, which is not given the scope, does not work here. Clerk's
  documentation says advertising a scope does not assign it and that scopes
  are assigned to the applications that may request them; for dynamic
  clients, add it to the default scopes below. Whether a dynamically
  registered client that names the scope in its request gets it beyond the
  defaults is not documented: confirm on the first connection (section 8).
  The scope alone does not tell Claude from an impostor that registered
  itself: the client allow list below does that.
- **Client onboarding (Settings tab):** turn on **Publish CIMD support**
  (Claude and ChatGPT both prefer Client ID Metadata Documents; a CIMD
  client's id is the https URL of its metadata document, which is stable and
  can be allow-listed). **Publish DCR support** is needed only while a client
  you need cannot use CIMD: with DCR every fresh connection registers a new
  client with a random id, which cannot be allow-listed, and it is a public
  registration endpoint anyone can use to create a client named "Claude".
  Recommended: CIMD on; DCR on only for the first test connections if a
  client does not use CIMD; DCR off once the Claude and ChatGPT ids are
  known. Consequence: a client that only does DCR (some Claude Code versions,
  and any MCP client without CIMD) can then no longer connect, and while DCR
  is on such a client gets the library tools only, because its random id is
  never on the allow list. Claude Code users who need case work need a
  version that uses CIMD, or a pre-registered OAuth application whose client
  id is allow-listed (`claude mcp add` with `--client-id`, if their version
  offers it).
- **Default scopes for dynamic clients:** `openid profile email
  user:org:read practice:connector`. Claude asks for the scopes in the 401's
  `scope` parameter (these five), but some clients send no `scope`, and
  without `user:org:read` the consent screen has no organization selector.
- **Authorization security:** **Require PKCE** on (Claude and ChatGPT always
  send S256; CIMD clients always use it).
- **Consent screen:** leave it on (Clerk forces it on with DCR and for CIMD
  clients).
- **Access token format:** JWT (the default for new OAuth applications). The
  connector accepts only JWT access tokens: it reads the firm from the
  `org_id` claim and refuses a token without it, so an opaque token is
  refused before anything is sent to Clerk. Clerk's documentation says JWT
  access tokens stay valid until they expire (a day by default) and only
  opaque ones can be revoked at once; see section 4 for what the connector
  does about revocation.
- **Organizations** must be on (they already are for the app), so Clerk
  advertises `user:org:read` and `org_id`.
- **Redirect URIs.** With CIMD or DCR the client brings its own redirect URI
  and nothing is configured here. Only if you pre-register an OAuth
  application for a client (Claude's "Use your own OAuth client", ChatGPT's
  registered client), add its callback: Claude's hosted apps use
  `https://claude.ai/api/mcp/auth_callback`; Claude Code uses a loopback
  `http://localhost:<any port>/callback` and `http://127.0.0.1:<any
  port>/callback`; ChatGPT uses `https://chatgpt.com/connector_platform_oauth_redirect`
  when the authorization server supports RFC 9207 issuer identification, and
  otherwise `https://chatgpt.com/connector/oauth/{callback_id}`, shown on the
  MCP server's page in ChatGPT. Copy the exact one ChatGPT shows. A
  pre-registered application's client id goes on the allow list, and the
  application must be given the custom scope.
- **Network:** Claude's requests (to the app and to Clerk's discovery and
  token endpoints) come from `160.79.104.0/21`; ChatGPT publishes its own
  ranges. Nothing in front of Clerk or the app should block them.

### The client allow list, and the first connection

The case-work tools are offered only to tokens whose OAuth client id is on
the platform's allow list (`src/services/connector/config.ts`):

- `CONNECTOR_ALLOWED_CLIENT_IDS`: exact client ids, separated by commas or
  spaces.
- `CONNECTOR_ALLOWED_CLIENT_ID_PREFIXES`: https URL prefixes, for CIMD
  client ids (which are URLs). Each prefix must be an https URL with a path,
  that is with a slash after the host (`https://claude.ai/`), so it pins the
  host; a prefix without one (`https://claude.ai`, which would also match
  `https://claude.ai.attacker.example/`) is ignored and logged.

With neither set, no client is recognized and case work is unavailable to
every connection (fail closed); the library tools work for every client.
Prefer exact ids; use a prefix only if a vendor's CIMD URL varies.

**First-connection procedure** (the platform's operator, with an owner/admin
of a test firm):

1. Deploy with `CONNECTOR_PUBLIC_ORIGIN` set and no allow list. Turn case
   work on for the test firm.
2. Connect once from Claude (claude.ai) and once from ChatGPT, as in
   section 2. Each connection works with the library tools only;
   `get_connection_info` says the client is not recognized and names its id.
3. On the Firm page, "Unrecognized clients" lists each client id with when
   it was first seen (also in `connector_unrecognized_clients`). Check that
   the ids are what you expect: a CIMD URL on `claude.ai` or `anthropic.com`
   for Claude, one on `openai.com` or `chatgpt.com` for ChatGPT. A random id
   means the client registered with DCR (that id will change on the next
   connection; see DCR above).
4. Add the ids to `CONNECTOR_ALLOWED_CLIENT_IDS` (`fly secrets set -a
   <web-app-name> CONNECTOR_ALLOWED_CLIENT_IDS="<claude id>,<chatgpt id>"`,
   which restarts the machines). Reconnect or refresh tools: the case-work
   tools appear.
5. Turn Publish DCR support off in Clerk and check both clients still
   connect.

Only client ids are stored, never tokens. A row is written (or its
`last_seen_at` and `seen_count` bumped) at most every ten minutes per firm,
client and web machine.

### Environment (web app)

| Variable | Default | What it does |
| --- | --- | --- |
| `CONNECTOR_PUBLIC_ORIGIN` | none (required in production) | The app's public origin, for example `https://app.example.com` (no path). The protected resource metadata's `resource` must equal the server URL the member entered exactly, and the Firm and Connect pages show `<origin>/api/mcp`. In production, without it (or with an invalid value) the connector and its metadata answer 500 and log why: the origin is never built from the request's `Host` or `X-Forwarded-Host`, which the caller controls. In development the request's host is used, and those responses say `Vary: Host, X-Forwarded-Host, X-Forwarded-Proto`. Also the origin of the Billing page a locked firm is pointed to (`<origin>/billing`) and of the links in the app's emails |
| `CONNECTOR_ALLOWED_CLIENT_IDS` | none | Recognized OAuth client ids (above) |
| `CONNECTOR_ALLOWED_CLIENT_ID_PREFIXES` | none | Recognized CIMD client id prefixes (above) |
| `CONNECTOR_REQUIRED_SCOPE` | `practice:connector` | The custom Clerk scope every token must carry. An invalid value (characters a scope cannot hold) falls back to the default |
| `CONNECTOR_RUN_SKILL_DAILY_LIMIT` | `50` | Skill runs one firm may queue through the connector per rolling day (a whole number of at least 1) |
| `CONNECTOR_IP_REQUESTS_PER_MINUTE` | `600` | Per-IP requests a minute on `/api/mcp`, per web machine, before authentication |
| `CONNECTOR_IP_AUTH_FAILURES_PER_MINUTE` | `30` | Per-IP refused bearer tokens a minute, per web machine; when used up, the IP is refused before authentication until the bucket refills |
| `CLERK_OAUTH_ISSUER` | decoded from `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk's issuer (Frontend API URL, no trailing slash), exactly as Clerk's `/.well-known/oauth-authorization-server` states `issuer`. Set it only if the decoded value differs |

`CLERK_SECRET_KEY` (already set) is what verifies the tokens and reads a
user's status and organization memberships.

### Routes

| Path | What |
| --- | --- |
| `POST /api/mcp` | the MCP endpoint (Streamable HTTP, stateless, JSON responses, one JSON-RPC message per request: a batch is refused with 400). `GET` and `DELETE` answer 405 once authenticated |
| `GET /.well-known/oauth-protected-resource/api/mcp` | RFC 9728 protected resource metadata (where the 401 points) |
| `GET /.well-known/oauth-protected-resource` | the same document, for clients that only look at the root |
| `GET /.well-known/oauth-authorization-server` | Clerk's own authorization server metadata, fetched and cached for an hour, for clients written to the 2025-03-26 MCP spec |

`src/proxy.ts` lists exactly these paths as public (the MCP handler
authenticates every request itself); everything else, including any other
path under `/api/mcp/`, still needs a session. Clerk's middleware still runs
on them and looks at the bearer token once on its own; the handler verifies
it with `acceptsToken: "oauth_token"`.

## 4. How authentication works

1. An unauthenticated request gets `401` with
   `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/api/mcp", scope="openid profile email user:org:read practice:connector"`.
   The same scopes are the metadata's `scopes_supported`.
2. The client reads the protected resource metadata
   (`resource: <origin>/api/mcp`, `authorization_servers: [<Clerk issuer>]`),
   then Clerk's authorization server metadata, registers (CIMD or DCR), and
   runs the authorization code flow with PKCE. The member signs in at Clerk
   and chooses the firm on the consent screen.
3. Every request carries `Authorization: Bearer <access token>`, and
   `src/services/connector/http.ts` then:
   - refuses 500 if the public origin is not configured (production);
   - applies the per-IP limits (`src/services/connector/ip-limit.ts`): 429
     with `Retry-After`, before anything is sent to Clerk;
   - authenticates with `src/services/connector/clerk-auth.ts`, in order:
     the token must be shaped like a Clerk JWT access token (three base64url
     parts, header `typ` `at+jwt`, a `kid`, not `alg: none`, at most 8,192
     characters; `src/services/connector/token-shape.ts`), or it is refused
     401 with no network call; Clerk verifies it
     (`authenticateRequest(..., { acceptsToken: "oauth_token" })`:
     signature against the instance's keys, expiry); it must carry the
     custom scope and the `org_id` claim (both 403 `insufficient_scope`,
     naming the scope; there is no fallback to the member's only firm);
     Clerk's Backend API is asked whether the token was revoked (below); the
     user is read from Clerk and refused 401 if banned or locked; the user's
     current organization memberships are read from Clerk and the token's
     organization must be one of them; user, organization, tenant and role
     resolve with `resolveTenantMembership`, the same function behind
     `getCurrentTenant`: Clerk's current Admin role (never a value from the
     token) makes an owner/admin, and any other member has the app role
     stored on their membership row (attorney, paralegal or read-only, set
     by an owner/admin on the Firm page), read from the database on every
     call; no custom Clerk role is read (README "Clerk"). The user,
     memberships and revocation answer are cached 60 seconds per process
     for reads; `run_skill` and `get_document_download_link` re-run the
     whole check with no cache just before they act, and refuse if the role
     no longer allows them;
   - reads the body (at most 256 KB) and refuses a JSON array (a JSON-RPC
     batch) with 400, so each request is one rate-limited, audited message;
   - notes an unrecognized client id for the Firm page, then serves the
     message with the tools this caller may use.
4. Refused with 403: a token without the connector's scope or without a
   firm; a token whose firm the member has left; an organization not synced
   as a tenant (the org-sync webhook has not run); a user the organization
   no longer lists (a member whose row the org sync has not written yet
   gets the row created instead, as read-only or owner/admin). Refused with 401 (the client re-authorizes): a missing,
   malformed, invalid or expired token; a token Clerk reports revoked; a
   banned or locked user.

**Revocation, honestly.** Clerk's SDK verifies JWT access tokens locally and
never sees a revocation. `@clerk/backend` (3.16.6 here) has a Backend API
call, `idPOAuthAccessToken.verify` (`POST
/oauth_applications/access_tokens/verify`), whose result has `revoked` and
`expired`; the SDK uses it only for opaque `oat_` tokens. The connector calls
it for every JWT access token (cached 60 seconds per token id) and refuses
the token if Clerk says revoked or expired. Clerk's documentation says JWT
access tokens remain valid until they expire and does not say whether this
endpoint reports a revoked JWT, so when the call fails the connector logs a
warning (at most every ten minutes) and accepts the token, which Clerk's
keys already verified. Until a real revocation is tested (section 8), assume
a revoked connection keeps working until its access token expires (a day by
Clerk's default). What takes effect within a minute regardless: removing
the member from the firm, making or unmaking an Admin, and banning or
locking the user; a role set in the Members section of the Firm page
applies on the next call. Switching Clerk to opaque tokens would make
revocation immediate but
removes the `org_id` claim the connector requires, so it is not an option
without a different way to carry the firm.

Clerk access tokens last a day; refresh tokens do not expire (Clerk's
defaults), so a connection stays until the member disconnects it, the
member loses access to the firm or the app, or (subject to the above) the
token is revoked in Clerk.

## 5. Privacy and safety

- **Where client data goes.** A case-work tool's result is placed in the
  member's Claude or ChatGPT conversation. From then on it is governed by
  Anthropic's or OpenAI's terms and retention for that account, not the
  app's; the disclosure on the Firm page says so and recommends business or
  enterprise plans whose terms exclude training. Whatever retention terms the
  firm has for the app's own Anthropic API key (README section 1 recommends
  Zero Data Retention for skill runs) do not cover a member's own Claude or
  ChatGPT account.
- **Which apps get client data.** Only connections from allow-listed OAuth
  clients (section 3). Anyone can register an OAuth client with Clerk while
  DCR is on and name it "Claude"; a member who authorizes such a client gets
  it the library tools only, and its id appears on the Firm page.
- **Audit.** Every case-work call writes `connector.tool_call` (actor,
  tenant, tool as `resource_id`, `after.matterId`, the run or document id,
  `after.oauthClientId`, `after.outcome`) in the same transaction as the read
  or change: reads in `src/lib/connector/case-work.ts`, `run_skill` in
  `enqueueSkillRun` (whose `skill_run.requested` row also gets
  `after.via: "connector"`), download links in `getDocumentDownloadUrl`.
  `list_matters` also records the ids of the matters it returned (at most
  50), its filters (`status`, `caseType`), `limit` and `offset`, so the log
  shows whose names went out. Calls refused for invalid input or an unknown
  matter, run or skill are recorded with their outcome. Not recorded: calls
  refused by a rate limit, by the per-IP limit, for a tool the caller cannot
  use, or for an unrecognized client (nothing was read; the client id is
  recorded separately), and the library tools (no firm data).
- **Prompt injection.** Text the app did not write (library text, including
  `fetch`'s text and source summary, file and party names, skill run reports
  generated from client documents, legal update summaries) goes out between
  two markers carrying a random nonce, after a line saying the block is
  quoted data, not instructions (`src/services/connector/framing.ts`). A
  marker-like sequence inside the data, or in a title that goes out
  unframed, is defused, so the data cannot close its block early. This
  lowers the risk; it does not remove it. The two tools that act
  (`run_skill`, `get_document_download_link`) need `confirm: true`, and
  their annotations make both clients ask the user first.
- **Sizes and pages.** A result is cut at 100,000 characters with a note
  (Claude accepts about 150,000 per result; Claude Code about 25,000 tokens by
  default); `fetch` text at 40,000; a run report at 80,000; matters 50 per
  page; documents 100 per matter; search 10 per call; legal updates 50.
  Request bodies over 256 KB are refused (413), JSON-RPC batches too (400).
- **Validation.** Every tool's input is a zod schema (also its published JSON
  schema); ids must be UUIDs; a failed check returns which field and why.
- **Per-IP limit before authentication** (`src/services/connector/ip-limit.ts`):
  in memory, per web machine (each machine counts on its own; a restart
  forgets). Each IP may make `CONNECTOR_IP_REQUESTS_PER_MINUTE` requests a
  minute (600), and each request whose bearer token is refused takes one of
  `CONNECTOR_IP_AUTH_FAILURES_PER_MINUTE` (30); while either is used up, the
  IP gets 429 before any call to Clerk. The tokenless request that starts
  OAuth discovery is not a failure. The client IP is Fly's `Fly-Client-IP`,
  else the last `X-Forwarded-For` entry. The limits are generous because
  every Claude user of every firm arrives from a few Anthropic addresses
  (and ChatGPT's from OpenAI's); the per-member and per-firm limits below
  are the ones that bound normal use. Together with the shape check (no
  network call for a token that is not a JWT access token), this bounds what
  unauthenticated traffic can make the app send to Clerk: a JWT-shaped token
  with an unknown key id still makes Clerk's SDK fetch the instance's keys,
  at most as often as the per-IP limits allow.
- **Rate limits** (`src/services/connector/rate-limit.ts`): Postgres token
  buckets per tenant, so they hold across machines. Every tool call takes a
  token from the member's bucket (30, refilled at 30 a minute) and the firm's
  (120, at 120 a minute); `run_skill` also from the member's (5, at 5 an hour)
  and the firm's (20 an hour) run buckets and the firm's daily run bucket
  (`CONNECTOR_RUN_SKILL_DAILY_LIMIT`, 50, refilled over a rolling 24 hours),
  a cap on what connections can spend of the firm's model budget. A refusal
  says how long to wait and takes nothing from any bucket. Rows are tiny and
  only change when a call is made; nothing prunes them (one row per member
  per bucket).

## 6. Submitting to the directories

Both directories list one public URL for everyone; each firm's members
connect to the same `<origin>/api/mcp` and choose their firm at sign-in. A
listing is optional: custom connectors work without one.

**Claude Connectors Directory** (claude.com/docs/connectors/building/submission):
submit at claude.ai/directory/manage, choose MCP connector, Universal URL,
authentication "client ID metadata documents" (or "OAuth with dynamic client
registration" while DCR is on). Have ready: the documentation URL (a public
page based on this file), a privacy policy URL, a support contact, an icon,
test credentials for a fully populated test firm (synthetic data only), and
the use cases (reads and writes data). Run every tool from Claude as a
custom connector first (the portal asks you to confirm). Review checks
titles and annotations, narrow descriptions with no behavioral
instructions, separate read and write tools, useful error messages and
reasonable result sizes. The reviewers' own client must be on the allow
list for them to see the case-work tools; if it registers with a different
id than claude.ai does, it shows up on the test firm's Firm page.

**ChatGPT plugin directory** (developers.openai.com/plugins/deploy/submission):
submit at platform.openai.com/plugins as a plugin ZIP that declares this
remote MCP server (`mcp.json` sets the authentication: CIMD or DCR, no client
secret in the package), after verifying the publisher identity and the
domain. The portal scans the tools; later server-side tool changes go live
after automated checks without a new ZIP. Company knowledge eligibility needs
the standard `search` and `fetch` schemas and `readOnlyHint` on the other
read-only tools, which the server has.

## 7. Researched requirements

Gathered 2026-10-21 from the vendors' current documentation.

| Requirement | Source | How it is met |
| --- | --- | --- |
| Streamable HTTP transport (legacy SSE still accepted by Claude) | claude.com/docs/connectors/building | `WebStandardStreamableHTTPServerTransport`, stateless, JSON responses |
| OAuth per the 2025-03-26, 2025-06-18 and 2025-11-25 MCP authorization specs | claude.com/docs/connectors/building; modelcontextprotocol.io/specification/2025-11-25/basic/authorization | Clerk as authorization server; the app is the resource server |
| 401 (not 200) with `WWW-Authenticate: Bearer resource_metadata=...`; optional `scope` | claude.com/docs/connectors/building/authentication; developers.openai.com/plugins/build/auth | `src/services/connector/http.ts` |
| Protected resource metadata (RFC 9728); `resource` equals the server URL exactly, path included; first `authorization_servers` entry is the issuer | same | `/.well-known/oauth-protected-resource/api/mcp` and root; `CONNECTOR_PUBLIC_ORIGIN` |
| Authorization server metadata (RFC 8414) with `code_challenge_methods_supported: ["S256"]` | MCP spec; OpenAI auth doc | Clerk publishes it (its documented sample shows S256) |
| DCR (RFC 7591) or CIMD; Claude uses CIMD only if both `client_id_metadata_document_supported: true` and `none` in `token_endpoint_auth_methods_supported` | claude.com/docs/connectors/building/authentication | Clerk dashboard switches (section 3) |
| PKCE S256 on every authorization request | Claude and OpenAI auth docs | Clerk "Require PKCE" |
| Redirect URIs: `https://claude.ai/api/mcp/auth_callback`; Claude Code loopback on any port; ChatGPT `https://chatgpt.com/connector_platform_oauth_redirect` or `https://chatgpt.com/connector/oauth/{callback_id}` | Claude and OpenAI auth docs | only needed for pre-registered clients (section 3) |
| Discovery, registration and token endpoints answer within 10 seconds (refresh 30) | Claude auth doc | Clerk's endpoints |
| Refresh: `invalid_grant` for a dead refresh token; rotate refresh tokens for public clients | Claude auth doc | Clerk's behavior (not verified) |
| Tool `title` plus `readOnlyHint` or `destructiveHint`; names of 64 characters or fewer; no behavioral instructions in descriptions; separate read and write tools | claude.com/docs/connectors/building/review-criteria | every tool |
| Result size about 150,000 characters (claude.ai) and 25,000 tokens (Claude Code); 240-second tool timeout | claude.com/docs/connectors/building | caps in section 5 |
| `search`/`fetch` shapes, structuredContent plus JSON text, non-empty `url` for citations | developers.openai.com/api/docs/mcp | `src/services/connector/tools/library.ts` |
| Annotations `readOnlyHint`, `destructiveHint`, `openWorldHint` set to actual behavior | developers.openai.com/plugins/build/mcp-server | every tool |
| Echo `resource` through the flow; put it in the token's audience; verify audience | developers.openai.com/plugins/build/auth; MCP spec "Token Audience Binding" | not met as written: Clerk documents no audience for the resource. The required custom scope stands in for it (section 9) |
| RFC 9207 `iss` in authorization responses for ChatGPT's stable redirect URI | OpenAI auth doc | depends on Clerk (not verified) |
| Clerk as MCP authorization server: `acceptsToken: "oauth_token"`, protected resource and authorization server metadata, DCR/CIMD switches, custom scopes (OAuth applications, Scopes) and default scopes for dynamic clients, `user:org:read` organization selector and `org_id` claim, JWT access tokens by default, a CIMD client's id is its metadata URL, JWTs valid until expiry | clerk.com/docs/nextjs/guides/development/mcp/build-mcp-server; clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth; clerk.com/docs/guides/configure/auth-strategies/oauth/verify-oauth-tokens; clerk.com/changelog/2026-01-08-jwt-oauth-access-tokens | `clerk-auth.ts`; the metadata is written here rather than with `@clerk/mcp-tools` because that package sets `resource` to the origin, which Claude's exact-match rule would reject for a server at `/api/mcp` |
| MCP TypeScript SDK | npmjs.com/package/@modelcontextprotocol/sdk | `@modelcontextprotocol/sdk` pinned at exactly `1.32.1` (latest 1.x on 2026-10-21; protocol versions up to 2025-11-25). The SDK's 2.x line is published as separate packages (`@modelcontextprotocol/server`); not used |
| Directory submission steps | claude.com/docs/connectors/building/submission; developers.openai.com/plugins/deploy/submission | section 6 |
| ChatGPT custom MCP servers on Business and Enterprise need an admin to allow them ("developer mode") | help.openai.com/en/articles/12584461 (search result; the page itself was not read) | stated as "may" in the app's instructions |

## 8. What was verified and what was not

Verified on the development machine:

- `npm run typecheck`, `npx eslint src` and `npx next build` (with the
  Dockerfile's placeholder environment) pass; the build lists `/api/mcp` and
  the three well-known routes as dynamic.
- An in-process check (a throwaway script, not committed) ran the real
  handler, MCP server and tools through the SDK's client and Streamable HTTP
  client transport against PGlite with every migration applied, as a role
  row-level security applies to, with a mocked token verifier. It checked:
  forced RLS on the three connector tables; the settings (disclosure version
  required, audited, isolated per tenant); the token buckets (refusal,
  rollback, per tenant); the case-work reads (tenant filter, no A-number, no
  storage key or extracted text, no input snapshot, audit rows with
  outcomes); the 401 challenge with the custom scope, and the metadata's
  `scopes_supported`; the tool list with case work off, on as read_only and
  as attorney, and with download links on; the `search` and `fetch` shapes;
  the framing; `run_skill` refusals and the `connectorCall` it passes to
  `enqueueSkillRun`; the hourly limit. And, for the security review: the
  scope and `org_id` checks (403 `insufficient_scope` naming the scope, no
  single-firm fallback); the allow list (exact ids, safe prefixes only, fail
  closed when unset); an unrecognized client getting the library tools only,
  a clear refusal for case work, and its id recorded per firm under RLS; the
  token shape check; the per-IP limits (429 before authentication, tokenless
  requests not counted); JSON-RPC batches refused 400, bad JSON 400,
  oversize 413; the download link's annotations, editor-only listing,
  `confirm`, and fresh re-check (a demotion seen by the fresh check refuses
  it, reads do not re-check); `run_skill`'s fresh re-check; `fetch`'s framed
  text and defused titles with a valid output shape; the `list_matters`
  audit fields; the redaction of A-numbers and dates of birth in
  `get_skill_run` (names and other dates kept); the daily run bucket; and
  the production origin rule (500 without `CONNECTOR_PUBLIC_ORIGIN`, never
  the forwarded host; the configured origin and no `Vary` with it).

Not verified (could not be, from here):

- Real Clerk OAuth: DCR and CIMD registration, the consent screen's
  organization selector, whether a dynamic client's token carries the custom
  scope (from the default scopes or from its request) and under which claim
  (`scp` or `scope`; Clerk's SDK reads either), the `org_id` claim, the
  client id Clerk puts in a CIMD client's token (expected: the metadata URL),
  `authenticateRequest` with real OAuth tokens, `getUser`'s `banned` and
  `locked`, `getOrganizationMembershipList`, and refresh-token behavior.
- Whether `idPOAuthAccessToken.verify` accepts a JWT access token and
  reports its revocation (section 4).
- Claude and ChatGPT connecting, discovering and calling the tools; deep
  research using `search` and `fetch`; how each client renders the
  confirmation for `run_skill` and `get_document_download_link`; the client
  ids each uses.
- `enqueueSkillRun`'s `connector.tool_call` row and `getDocumentDownloadUrl`'s
  connector path against Postgres (the check stubbed them), the legal-update
  tool against real data, the EOIR tools against a loaded snapshot, Neon and
  pg-boss.
- Whether Clerk honors the `resource` parameter or puts it in `aud`, returns
  `iss` per RFC 9207, and matches Claude Code's loopback redirect on any port.

## 9. Open decisions and known limits

- **Token audience and impostor clients (the risk exists now).** The MCP
  spec requires the server to accept only tokens issued for it. Clerk
  documents no audience for the MCP resource. Two risks follow, and both
  apply today, not only if another OAuth application is added later: any
  OAuth token of the app's Clerk instance would otherwise be accepted, and
  with DCR on anyone can register a client called "Claude" and send a firm
  attorney a convincing consent link. What is in place: the required custom
  scope (a token issued to an application without it is refused) and the
  client allow list (only recognized Claude and ChatGPT client ids get
  client data; everything else gets the public library and is listed on the
  Firm page). What remains: a recognized client's own tokens are trusted
  fully, and a CIMD prefix trusts every client id under it. A separate Clerk
  instance for the connector remains the stronger option if Clerk adds
  resource indicators or audiences.
- **DCR.** With DCR, Claude registers a new client on every fresh connection
  and the id cannot be allow-listed. Keep DCR off once the CIMD ids are
  known (section 3); decide whether Claude Code users without CIMD support
  need case work (a pre-registered, allow-listed client).
- **Revocation** takes effect at token expiry unless Clerk's verify endpoint
  turns out to report revoked JWTs (section 4). Shorter access token
  lifetimes, if Clerk offers them, would shorten that window; nothing in the
  app can.
- **Per-IP limits are per process.** Several web machines each allow the
  configured rate; a determined attacker with many addresses is bounded only
  by the cost of Clerk's key fetches and the Postgres limits after
  authentication. A shared store (or a proxy-level limit) would be the next
  step if this matters.
- **Several firms.** The firm is fixed per connection (chosen at consent). A
  `switch_firm` tool was not built: the token, not the server, says which
  organization was consented to.
- **Downloads.** A link is a bearer URL for 5 minutes; anyone the
  conversation shows it to can open it. Off by default; editors only; each
  link confirmed; the firm decides.
- **What `list_matters` shows.** Party names are included so a member can
  tell matters apart (matters have no title). If the firm prefers, show
  initials only.
- **Redaction** is pattern based (section 1): it removes A-numbers and dates
  of birth stored under their own keys and A-numbers in text, not every
  identifier a report can contain.
- **Rate limits** other than the daily run cap and the per-IP limits are
  constants in code; make them environment variables if a firm needs
  different ones.
- **Directory listing.** Needs a public documentation page, a privacy policy
  that covers the connector, a test firm with synthetic data, and a
  decision on who submits for the firm.
