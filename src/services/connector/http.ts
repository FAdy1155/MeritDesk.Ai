import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { safeErrorMessage } from "@/lib/errors/safe-error";
import { ORIGIN_VARY, connectorOrigin, wwwAuthenticate } from "./config";
import { admitConnectorRequest, connectorClientIp, recordConnectorAuthFailure } from "./ip-limit";
import { createConnectorServer } from "./server";
import { bearerToken } from "./token-shape";
import { ConnectorAuthError, type ConnectorAuthenticator, type ConnectorDeps } from "./types";

// The HTTP side of /api/mcp: MCP's Streamable HTTP transport in stateless
// mode (no session id, a new server per request, JSON responses rather than
// an SSE stream), so any web machine can answer any request and nothing is
// kept between requests. In order:
//
// 1. The public origin must be known (CONNECTOR_PUBLIC_ORIGIN in
//    production, ./config.ts); otherwise 500.
// 2. The caller's IP must be within its per-process limits (./ip-limit.ts);
//    otherwise 429, before anything is sent to Clerk.
// 3. The request is authenticated: without a valid access token the answer
//    is 401 with a WWW-Authenticate header that points at the protected
//    resource metadata, which is how Claude and ChatGPT discover the
//    authorization server (Clerk) and start OAuth.
// 4. The body is read (at most MAX_BODY_BYTES) and must be one JSON-RPC
//    message: a batch (a JSON array) is refused with 400. MCP removed
//    batching in its 2025-06-18 revision, and one message per request keeps
//    the per-call rate limits and audit one to one with requests.
//
// GET (a standalone SSE stream) and DELETE (ending a session) have no
// meaning without sessions: 405, as the transport spec allows.

/** The largest JSON-RPC request body accepted (tool arguments are small; a case note is at most 20,000 characters). */
const MAX_BODY_BYTES = 256 * 1024;

/** How long one firm's record of an unrecognized client is not rewritten (per process). */
const UNRECOGNIZED_CLIENT_RECORD_MS = 10 * 60_000;
const recentlyRecorded = new Map<string, number>();

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function authErrorResponse(origin: string, err: ConnectorAuthError, vary: Record<string, string>): Response {
  const headers: Record<string, string> = { ...vary };
  if (err.status === 401) {
    // A missing token gets the bare challenge (RFC 6750 section 3.1); a bad one names the error.
    headers["www-authenticate"] = wwwAuthenticate(origin, err.code === "invalid_token" && err.description ? { code: "invalid_token", description: err.description } : undefined);
  } else if (err.code === "insufficient_scope") {
    headers["www-authenticate"] = wwwAuthenticate(origin, { code: "insufficient_scope", description: err.description });
  }
  const description = err.description || "This endpoint needs an OAuth access token; connect through Claude or ChatGPT.";
  return jsonResponse(err.status, { error: err.code, error_description: description }, headers);
}

/** JSON-RPC error responses for a body refused before the transport reads it (no id is known). */
function jsonRpcError(status: number, code: number, message: string): Response {
  return jsonResponse(status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

/** The body as text, or null when it is larger than `max` bytes. */
async function readBodyText(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function noteUnrecognizedClient(deps: ConnectorDeps, tenantId: string, clientId: string, userId: string): Promise<void> {
  const key = `${tenantId}\n${clientId}`;
  const last = recentlyRecorded.get(key);
  if (last && Date.now() - last < UNRECOGNIZED_CLIENT_RECORD_MS) return;
  if (recentlyRecorded.size >= 1_000) recentlyRecorded.clear();
  recentlyRecorded.set(key, Date.now());
  try {
    await deps.recordUnrecognizedClient(tenantId, clientId, userId);
  } catch (err) {
    console.error(`[connector] unrecognized client could not be recorded: ${safeErrorMessage(err)}`);
  }
}

export async function handleConnectorRequest(
  request: Request,
  options: { authenticate: ConnectorAuthenticator; deps: ConnectorDeps }
): Promise<Response> {
  const { origin, fromRequest } = connectorOrigin(request);
  if (!origin) {
    // Logged by connectorOrigin. Fail closed: never build the challenge from the caller's Host header.
    return jsonResponse(500, { error: "server_error", error_description: "The connector is not configured on this server." });
  }
  const vary: Record<string, string> = fromRequest ? { vary: ORIGIN_VARY } : {};

  const ip = connectorClientIp(request);
  const admitted = admitConnectorRequest(ip);
  if (!admitted.ok) {
    return jsonResponse(
      429,
      { error: "rate_limited", error_description: `Too many requests from this address. Try again in about ${admitted.retryAfterSeconds} seconds.` },
      { "retry-after": String(admitted.retryAfterSeconds) }
    );
  }

  let identity;
  try {
    identity = await options.authenticate(request);
  } catch (err) {
    if (err instanceof ConnectorAuthError) {
      if (bearerToken(request)) recordConnectorAuthFailure(ip);
      return authErrorResponse(origin, err, vary);
    }
    console.error(`[connector] authentication failed: ${safeErrorMessage(err)}`);
    return jsonResponse(503, { error: "server_error", error_description: "Authentication could not be completed. Try again." }, { "retry-after": "5" });
  }

  if (request.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed", error_description: "This MCP endpoint is stateless: send JSON-RPC messages with POST." }, { allow: "POST" });
  }

  const text = await readBodyText(request, MAX_BODY_BYTES);
  if (text === null) return jsonRpcError(413, -32000, `Request body too large (the limit is ${MAX_BODY_BYTES} bytes).`);
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return jsonRpcError(400, -32700, "Parse error: Invalid JSON");
  }
  if (Array.isArray(message)) {
    return jsonRpcError(400, -32600, "Invalid Request: JSON-RPC batches are not accepted; send one message per request.");
  }

  if (!identity.clientAllowed) {
    await noteUnrecognizedClient(options.deps, identity.tenantId, identity.oauthClientId, identity.userId);
  }

  // The firm's switches and its billing state (free month, subscription,
  // locked), read once for this request; a locked firm gets
  // get_connection_info only (./server.ts).
  let settings;
  let entitlement;
  try {
    [settings, entitlement] = await Promise.all([options.deps.settings(identity.tenantId), options.deps.entitlement(identity.tenantId)]);
  } catch (err) {
    console.error(`[connector] firm settings could not be read: ${safeErrorMessage(err)}`);
    return jsonResponse(503, { error: "server_error", error_description: "The app could not be reached. Try again." }, { "retry-after": "5" });
  }
  const server = createConnectorServer({
    identity,
    settings,
    entitlement,
    billingUrl: `${origin}/billing`,
    deps: options.deps,
    // Headers only: the body has been read, and authentication never needs it.
    reauthenticate: () => options.authenticate(new Request(request.url, { headers: request.headers }), { fresh: true }),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_BODY_BYTES,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, {
      parsedBody: message,
      authInfo: { token: "", clientId: identity.oauthClientId, scopes: identity.scopes, extra: { userId: identity.userId, tenantId: identity.tenantId } },
    });
    response.headers.set("cache-control", "no-store");
    return response;
  } finally {
    // JSON response mode: handleRequest resolves once every response is written.
    await server.close().catch(() => undefined);
  }
}
