import { ORG_SCOPE, connectorRequiredScope } from "./config";
import { ConnectorAuthError } from "./types";

// What a connector access token must look like before anything is sent to
// Clerk: either a JWT access token (header typ at+jwt) or an opaque OAuth
// access token (oat_ prefix). Other shapes (API keys, random bytes) are
// refused before making a network call. Nothing here
// verifies anything: signature, issuer, expiry, and opaque token validity are Clerk's check
// (src/services/connector/clerk-auth.ts). Free of server imports so the
// check script can exercise it. requireTokenGrants holds the checks on a
// verified token that need no network call either.

/** Longer than any access token Clerk issues; anything bigger is refused unread. */
export const MAX_ACCESS_TOKEN_CHARS = 8_192;

const JWT_FORMAT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const OAUTH_JWT_TYPES = ["at+jwt", "application/at+jwt"];
const OPAQUE_OAUTH_FORMAT = /^oat_[A-Za-z0-9_-]+$/;

export type AccessTokenShape =
  | { format: "jwt"; claims: AccessTokenClaims }
  | { format: "opaque" };

/** The connector requires tokens whose revocation can be checked on every request. */
export function requireRevocableConnectorToken(shape: AccessTokenShape | null): asserts shape is { format: "opaque" } {
  if (shape?.format !== "opaque") {
    throw new ConnectorAuthError(
      401,
      "invalid_token",
      "This connector requires an opaque OAuth access token so revoked connections stop working immediately. Reconnect after the firm's Clerk OAuth application is configured for opaque access tokens."
    );
  }
}

export type AccessTokenClaims = {
  /** The token's id (jti), the key of the revocation check's cache. */
  jti: string | null;
  /** The organization chosen on Clerk's consent screen (needs the user:org:read scope). */
  orgId: string | null;
};

/** A failed upstream status check is an error, never evidence of an active token. */
export type VerifiedOAuthTokenStatus = {
  revoked: boolean;
  expired: boolean;
  clientId: string;
  subject: string;
  type: string;
  scopes: string[];
};

/**
 * Clerk's verified token record is authoritative for the OAuth client,
 * subject, type, grants, expiry, and revocation. Refuse partial responses or
 * any identity mismatch instead of treating a successful signature check as
 * enough to bind a request to the authenticated user.
 */
export async function readVerifiedOAuthTokenStatus(
  verify: () => Promise<Partial<VerifiedOAuthTokenStatus>>,
  expected: { clientId: string; subject: string }
): Promise<VerifiedOAuthTokenStatus> {
  const state = await verify();
  if (
    typeof state.clientId !== "string" || state.clientId !== expected.clientId ||
    typeof state.subject !== "string" || state.subject !== expected.subject ||
    state.type !== "oauth_token" ||
    !Array.isArray(state.scopes) || !state.scopes.every((scope) => typeof scope === "string") ||
    typeof state.revoked !== "boolean" || typeof state.expired !== "boolean"
  ) {
    throw new Error("Clerk returned incomplete or mismatched connector token identity.");
  }
  return state as VerifiedOAuthTokenStatus;
}

/** Refuse malformed/oversized tokens before asking Clerk to process them. */
export function accessTokenShape(token: string): AccessTokenShape | null {
  if (token.length > MAX_ACCESS_TOKEN_CHARS) return null;
  if (OPAQUE_OAUTH_FORMAT.test(token)) return { format: "opaque" };
  const claims = accessTokenClaims(token);
  return claims ? { format: "jwt", claims } : null;
}

/** Resolve the selected firm for an opaque token from Clerk, never from caller input. */
export async function organizationFromUserInfo(
  token: string,
  issuer: string,
  expectedUserId: string,
  fetcher: typeof fetch = fetch
): Promise<string> {
  const issuerUrl = new URL(issuer);
  if (issuerUrl.protocol !== "https:") throw new Error("Clerk OAuth issuer must use HTTPS.");
  issuerUrl.pathname = `${issuerUrl.pathname.replace(/\/+$/, "")}/oauth/userinfo`;
  issuerUrl.search = "";
  issuerUrl.hash = "";

  const response = await fetcher(issuerUrl, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Clerk could not resolve the connector user's firm.");
  const data = await response.json() as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Clerk returned invalid connector user information.");
  }
  const userInfo = data as Record<string, unknown>;
  const userId = typeof userInfo.user_id === "string" ? userInfo.user_id : userInfo.sub;
  if (userId !== expectedUserId || typeof userInfo.org_id !== "string" || !userInfo.org_id) {
    throw new Error("Clerk returned no matching user and firm for the connector token.");
  }
  return userInfo.org_id;
}

function decodePart(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The bearer token of an Authorization header, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

/**
 * The unverified claims of a token shaped like a Clerk JWT access token, or
 * null when it is not one. Only for the pre-check and, after Clerk verified
 * the token, for reading its org_id and jti.
 */
export function accessTokenClaims(token: string): AccessTokenClaims | null {
  if (token.length > MAX_ACCESS_TOKEN_CHARS || !JWT_FORMAT.test(token)) return null;
  const [headerPart, payloadPart] = token.split(".");
  const header = decodePart(headerPart);
  const payload = decodePart(payloadPart);
  if (!header || !payload) return null;
  if (typeof header.typ !== "string" || !OAUTH_JWT_TYPES.includes(header.typ)) return null;
  if (typeof header.kid !== "string" || !header.kid || typeof header.alg !== "string" || header.alg === "none") return null;
  return {
    jti: typeof payload.jti === "string" && payload.jti ? payload.jti : null,
    orgId: typeof payload.org_id === "string" && payload.org_id ? payload.org_id : null,
  };
}

/**
 * What a verified token must grant before anything else is read: the
 * connector's custom scope (403 insufficient_scope naming it, so the client
 * can ask for it) and a firm, the org_id claim of the user:org:read scope
 * (403 insufficient_scope naming that scope; no fallback to the user's only
 * firm). Returns the organization id.
 */
export function requireTokenGrants(scopes: readonly string[], claims: AccessTokenClaims): string {
  requireConnectorScopes(scopes);
  if (!claims.orgId) {
    throw new ConnectorAuthError(
      403,
      "insufficient_scope",
      `This connection carries no firm. Disconnect, connect again and choose the firm on the consent screen (the connection must be granted the ${ORG_SCOPE} scope).`
    );
  }
  return claims.orgId;
}

export function requireConnectorScopes(scopes: readonly string[]): void {
  const requiredScope = connectorRequiredScope();
  if (!scopes.includes(requiredScope)) {
    throw new ConnectorAuthError(
      403,
      "insufficient_scope",
      `This connection was not granted the ${requiredScope} scope this app requires. Disconnect and connect again; if it persists, the app's Clerk setup must give connector clients that scope.`
    );
  }
  if (!scopes.includes(ORG_SCOPE)) {
    throw new ConnectorAuthError(
      403,
      "insufficient_scope",
      `This connection was not granted the ${ORG_SCOPE} scope needed to select a firm. Disconnect and connect again.`
    );
  }
}
