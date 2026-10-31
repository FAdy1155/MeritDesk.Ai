import { ORG_SCOPE, connectorRequiredScope } from "./config";
import { ConnectorAuthError } from "./types";

// What a connector access token must look like before anything is sent to
// Clerk: a JWT access token (header typ at+jwt, as Clerk issues them by
// default for OAuth applications) with a key id. A token of any other shape
// (an opaque oat_ token, an API key, random bytes) is refused here with no
// network call, so junk cannot make the app call Clerk. Nothing here
// verifies anything: the signature, issuer and expiry are Clerk's check
// (src/services/connector/clerk-auth.ts). Free of server imports so the
// check script can exercise it. requireTokenGrants holds the checks on a
// verified token that need no network call either.

/** Longer than any access token Clerk issues; anything bigger is refused unread. */
export const MAX_ACCESS_TOKEN_CHARS = 8_192;

const JWT_FORMAT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const OAUTH_JWT_TYPES = ["at+jwt", "application/at+jwt"];

export type AccessTokenClaims = {
  /** The token's id (jti), the key of the revocation check's cache. */
  jti: string | null;
  /** The organization chosen on Clerk's consent screen (needs the user:org:read scope). */
  orgId: string | null;
};

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
  const requiredScope = connectorRequiredScope();
  if (!scopes.includes(requiredScope)) {
    throw new ConnectorAuthError(
      403,
      "insufficient_scope",
      `This connection was not granted the ${requiredScope} scope this app requires. Disconnect and connect again; if it persists, the app's Clerk setup must give connector clients that scope.`
    );
  }
  if (!claims.orgId) {
    throw new ConnectorAuthError(
      403,
      "insufficient_scope",
      `This connection carries no firm. Disconnect, connect again and choose the firm on the consent screen (the connection must be granted the ${ORG_SCOPE} scope).`
    );
  }
  return claims.orgId;
}
