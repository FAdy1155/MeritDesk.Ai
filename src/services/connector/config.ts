// Where the connector lives, who issues its tokens, which scope its tokens
// must carry and which OAuth clients may reach the firm's data. Kept free of
// server imports: the route handlers, the Firm page and the in-process check
// script all read it. Environment variables are read on every call, so a
// test (or a restart with new settings) sees the current values.

/** The MCP endpoint's path (src/app/api/mcp/route.ts). The server URL a firm enters in Claude or ChatGPT is the origin plus this. */
export const MCP_ENDPOINT_PATH = "/api/mcp";

/**
 * The protected resource metadata (RFC 9728) for the endpoint, at the path
 * the MCP authorization spec derives from the endpoint's own path. The same
 * document is also served at the root well-known path for clients that only
 * look there.
 */
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/** The scope that makes Clerk's consent screen show an organization selector and put the chosen one in the org_id claim. */
export const ORG_SCOPE = "user:org:read";

/** The default of CONNECTOR_REQUIRED_SCOPE. */
export const DEFAULT_CONNECTOR_SCOPE = "practice:connector";

/**
 * The custom Clerk scope every connector token must carry
 * (CONNECTOR_REQUIRED_SCOPE, default practice:connector). Clerk issues
 * OAuth tokens for every OAuth application of the instance; requiring a
 * scope that only the connector's clients are given marks the grant as
 * intended for this connector. This is an additional grant check, not a
 * substitute for resource binding: clerk-auth.ts also passes the exact MCP
 * resource URL to Clerk's authenticateRequest audience validation. It does
 * not tell Claude from an impostor client: the client allow list below does that.
 */
export function connectorRequiredScope(): string {
  const value = readEnv("CONNECTOR_REQUIRED_SCOPE")?.trim();
  return value && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value) ? value : DEFAULT_CONNECTOR_SCOPE;
}

/**
 * The OAuth scopes the connector asks Clerk for: the OpenID scopes identify
 * the user, user:org:read makes the consent screen show an organization
 * selector (how a member of several firms picks one), and the required
 * custom scope marks the token as one for this connector. Claude requests
 * the scopes in the 401's scope parameter, or else scopes_supported;
 * ChatGPT requests the scopes the metadata advertises.
 */
export function connectorScopes(): string[] {
  return ["openid", "profile", "email", ORG_SCOPE, connectorRequiredScope()];
}

/** Display name in the metadata and the MCP initialize response. */
export const CONNECTOR_NAME = "MeritDesk.AI";

/** Runtime env lookup (bracket access so Next.js does not inline a compile-time value). */
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" ? value : undefined;
}

function listEnv(name: string): string[] {
  return (readEnv(name) ?? "")
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Raw CONNECTOR_PUBLIC_ORIGIN, unread until called. */
export function connectorPublicOriginEnv(): string | undefined {
  return readEnv("CONNECTOR_PUBLIC_ORIGIN");
}

/**
 * A prefix may only be an https URL with a path (https://claude.ai/...), so
 * it pins the host: "https://claude.ai" without the slash would also match
 * https://claude.ai.attacker.example/.
 */
function isSafeClientIdPrefix(prefix: string): boolean {
  return /^https:\/\/[a-z0-9.-]+(:\d+)?\/.*$/i.test(prefix);
}

let warnedPrefixes = "";

/**
 * The OAuth client ids allowed to use the case-work tools:
 * CONNECTOR_ALLOWED_CLIENT_IDS (exact ids) and
 * CONNECTOR_ALLOWED_CLIENT_ID_PREFIXES (https URL prefixes, for clients
 * that identify themselves with a Client ID Metadata Document URL). Anyone
 * can register a client with Clerk under any name (DCR), so a token's client
 * is trusted with client data only when its id is listed here; with
 * neither variable set, no client is.
 */
export function connectorClientAllowList(): { ids: string[]; prefixes: string[] } {
  const ids = listEnv("CONNECTOR_ALLOWED_CLIENT_IDS");
  const rawPrefixes = listEnv("CONNECTOR_ALLOWED_CLIENT_ID_PREFIXES");
  const prefixes = rawPrefixes.filter(isSafeClientIdPrefix);
  const rejected = rawPrefixes.filter((p) => !isSafeClientIdPrefix(p)).join(" ");
  if (rejected && rejected !== warnedPrefixes) {
    warnedPrefixes = rejected;
    console.error(`[connector] CONNECTOR_ALLOWED_CLIENT_ID_PREFIXES: ignoring ${rejected} (each prefix must be an https URL with a path, ending in a slash after the host)`);
  }
  return { ids, prefixes };
}

/** Whether any client is allowed at all (the Firm page says so when none is). */
export function connectorClientAllowListConfigured(): boolean {
  const { ids, prefixes } = connectorClientAllowList();
  return ids.length > 0 || prefixes.length > 0;
}

/** Whether the token's OAuth client may use the case-work tools. */
export function isAllowedConnectorClient(clientId: string | null | undefined): boolean {
  if (!clientId) return false;
  const { ids, prefixes } = connectorClientAllowList();
  return ids.includes(clientId) || prefixes.some((p) => clientId.startsWith(p));
}

export type ConnectorOriginParse =
  | { ok: true; origin: string; https: boolean; loopback: boolean }
  | { ok: false; error: string };

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * CONNECTOR_PUBLIC_ORIGIN: an http(s) origin with no path. HTTP is allowed
 * only on loopback so local protocol tests can set http://127.0.0.1:3101;
 * Claude and ChatGPT still need a public https origin. Host headers are never
 * consulted: a request claiming :3000 cannot override a configured port.
 */
export function parseConnectorPublicOrigin(raw: string | undefined | null): ConnectorOriginParse {
  const value = raw?.trim() ?? "";
  if (!value) {
    return {
      ok: false,
      error:
        "CONNECTOR_PUBLIC_ORIGIN is not set. Set it to the origin MCP clients will call (no path), for example http://127.0.0.1:3101 locally or https://app.example.com in production. The MCP URL is that origin plus /api/mcp.",
    };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      ok: false,
      error: `CONNECTOR_PUBLIC_ORIGIN is not a valid URL. Use an absolute http(s) origin with no path, for example https://app.example.com`,
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "CONNECTOR_PUBLIC_ORIGIN must use http or https." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "CONNECTOR_PUBLIC_ORIGIN must not include a username or password." };
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    return {
      ok: false,
      error: "CONNECTOR_PUBLIC_ORIGIN must be an origin only (no path, query or fragment). Do not append /api/mcp; the app adds it.",
    };
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    return {
      ok: false,
      error: "CONNECTOR_PUBLIC_ORIGIN must use https except on localhost or 127.0.0.1. Claude and ChatGPT require a public HTTPS origin.",
    };
  }
  return { ok: true, origin: url.origin, https: url.protocol === "https:", loopback };
}

/** Clerk's issuer is its Frontend API, not the MCP origin. When set, it must be an https origin. */
export function parseClerkOAuthIssuer(raw: string | undefined | null): { ok: true; issuer: string | null } | { ok: false; error: string } {
  const value = raw?.trim() ?? "";
  if (!value) return { ok: true, issuer: null };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "CLERK_OAUTH_ISSUER is not a valid URL. Use Clerk's Frontend API origin, for example https://clerk.example.com" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, error: "CLERK_OAUTH_ISSUER must be https (Clerk's Frontend API URL, no path)." };
  }
  if (url.username || url.password || (url.pathname && url.pathname !== "/") || url.search || url.hash) {
    return { ok: false, error: "CLERK_OAUTH_ISSUER must be an https origin only (no path, userinfo, query or fragment)." };
  }
  return { ok: true, issuer: url.origin };
}

/**
 * Logs and, when the value is present but invalid or when production is
 * missing it, throws. Safe to call from instrumentation at process start.
 * Does not skip Clerk token checks.
 */
export function assertConnectorEnvironment(production = process.env.NODE_ENV === "production"): void {
  const rawOrigin = connectorPublicOriginEnv();
  const origin = parseConnectorPublicOrigin(rawOrigin);
  if (!origin.ok) {
    const message = `[connector] ${origin.error}`;
    if (production || Boolean(rawOrigin?.trim())) {
      throw new Error(message);
    }
    console.error(message);
  } else {
    const mismatch = connectorListenPortMismatch(origin);
    if (mismatch) console.error(`[connector] ${mismatch}`);
  }
  const issuer = parseClerkOAuthIssuer(readEnv("CLERK_OAUTH_ISSUER"));
  if (!issuer.ok) throw new Error(`[connector] ${issuer.error}`);
}

export type ConnectorPublicSurface = {
  origin: string;
  mcpUrl: string;
  metadataUrl: string;
  billingUrl: string;
  https: boolean;
  loopback: boolean;
  /** Hosted Claude/ChatGPT need HTTPS even when this process is on loopback HTTP. */
  hostedClientsNeedHttps: boolean;
};

export function connectorPublicSurface(): ConnectorPublicSurface | { error: string } {
  const parsed = parseConnectorPublicOrigin(connectorPublicOriginEnv());
  if (!parsed.ok) return { error: parsed.error };
  return {
    origin: parsed.origin,
    mcpUrl: connectorResourceUrl(parsed.origin),
    metadataUrl: `${parsed.origin}${PROTECTED_RESOURCE_METADATA_PATH}`,
    billingUrl: `${parsed.origin}/billing`,
    https: parsed.https,
    loopback: parsed.loopback,
    hostedClientsNeedHttps: true,
  };
}

/**
 * When CONNECTOR_PUBLIC_ORIGIN is loopback HTTP but this process is listening
 * on a different PORT (webpack-dev -p 3101 while the env still says :3000),
 * the copied MCP URL is still the configured origin. Callers must change the
 * env; Host is never used to rewrite it.
 */
export function connectorListenPortMismatch(
  parsed: { origin: string; loopback: boolean; https: boolean },
  listenPort = readEnv("PORT")
): string | null {
  if (!parsed.loopback) return null;
  const listen = listenPort?.trim() ?? "";
  if (!/^\d+$/.test(listen)) return null;
  const originPort = new URL(parsed.origin).port || (parsed.https ? "443" : "80");
  if (originPort === listen) return null;
  return `CONNECTOR_PUBLIC_ORIGIN is ${parsed.origin} but this process PORT is ${listen}. The MCP URL remains ${parsed.origin}/api/mcp. Update CONNECTOR_PUBLIC_ORIGIN to the origin MCP clients will call (for this listen port, typically http://127.0.0.1:${listen}) and restart. The request Host header is ignored.`;
}

export function connectorEndpointHelp(surface: ConnectorPublicSurface): string {
  if (surface.https) {
    return "This is the HTTPS MCP endpoint. Paste it into Claude or ChatGPT. Use OAuth and leave the client ID and secret empty.";
  }
  return "This origin is HTTP on loopback. It is valid for local protocol tests only. Claude Desktop, claude.ai and ChatGPT require a public HTTPS CONNECTOR_PUBLIC_ORIGIN (a deployed host or HTTPS tunnel) and cannot complete OAuth against this address.";
}

/** Kept for callers that still pass a Vary header; origin is never taken from the request. */
export const ORIGIN_VARY = "Host, X-Forwarded-Host, X-Forwarded-Proto";

/**
 * The public origin of the app. Always CONNECTOR_PUBLIC_ORIGIN after
 * validation. Request Host / X-Forwarded-Host / PORT are ignored so a
 * webpack-dev default of :3000 cannot override a configured 3100/3101
 * (or a staging/production https origin).
 */
export function resolveConnectorOrigin(
  _headers?: Pick<Headers, "get">,
  _requestUrl?: string,
  _production = process.env.NODE_ENV === "production"
): { origin: string | null; fromRequest: boolean; error: string | null } {
  const parsed = parseConnectorPublicOrigin(connectorPublicOriginEnv());
  if (parsed.ok) return { origin: parsed.origin, fromRequest: false, error: null };
  console.error(`[connector] ${parsed.error}`);
  return { origin: null, fromRequest: false, error: parsed.error };
}

/** resolveConnectorOrigin for a route handler's request. */
export function connectorOrigin(_request?: Request): { origin: string | null; fromRequest: boolean; error: string | null } {
  return resolveConnectorOrigin();
}

/** The MCP server URL: what a firm enters in Claude or ChatGPT, and the protected resource's identifier. */
export function connectorResourceUrl(origin: string): string {
  return `${origin}${MCP_ENDPOINT_PATH}`;
}

/** Exact protected-resource audience expected for this incoming MCP request. */
export function connectorAudienceForRequest(
  request: Request,
  production = process.env.NODE_ENV === "production"
): string | null {
  const { origin } = resolveConnectorOrigin(request.headers, request.url, production);
  return origin ? connectorResourceUrl(origin) : null;
}

/**
 * Clerk's Frontend API URL, which is the issuer of its OAuth tokens and
 * serves its authorization server metadata. CLERK_OAUTH_ISSUER overrides it
 * (no trailing slash, exactly the `issuer` Clerk's
 * /.well-known/oauth-authorization-server states); otherwise it is decoded
 * from the publishable key, which encodes the Frontend API host
 * (pk_live_<base64 of "clerk.example.com$">), as @clerk/mcp-tools does.
 */
export function clerkIssuer(): string | null {
  const override = parseClerkOAuthIssuer(readEnv("CLERK_OAUTH_ISSUER"));
  if (!override.ok) {
    console.error(`[connector] ${override.error}`);
    return null;
  }
  if (override.issuer) return override.issuer;
  const key = readEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")?.trim();
  if (!key) return null;
  const encoded = key.replace(/^pk_(test|live)_/, "");
  try {
    const host = Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
    if (!/^[a-z0-9.-]+$/i.test(host)) return null;
    return `https://${host}`;
  } catch {
    return null;
  }
}

/** RFC 9728 protected resource metadata for the endpoint. */
export function protectedResourceMetadata(origin: string, issuer: string) {
  return {
    resource: connectorResourceUrl(origin),
    authorization_servers: [issuer],
    scopes_supported: connectorScopes(),
    bearer_methods_supported: ["header"],
    resource_name: CONNECTOR_NAME,
  };
}

/** The WWW-Authenticate value of a 401 (and of a 403 with an error code), pointing at the metadata. */
export function wwwAuthenticate(origin: string, error?: { code: "invalid_token" | "insufficient_scope"; description: string }): string {
  const parts = [`resource_metadata="${origin}${PROTECTED_RESOURCE_METADATA_PATH}"`, `scope="${connectorScopes().join(" ")}"`];
  if (error) {
    parts.unshift(`error="${error.code}"`);
    // Quoted-string: no quotes or backslashes inside.
    parts.push(`error_description="${error.description.replace(/["\\]/g, "'")}"`);
  }
  return `Bearer ${parts.join(", ")}`;
}
