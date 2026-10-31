import "server-only";
import crypto from "node:crypto";
import { clerkClient } from "@clerk/nextjs/server";
import { TenantResolutionError, resolveTenantMembership } from "@/lib/tenant";
import { safeErrorMessage } from "@/lib/errors/safe-error";
import { isAllowedConnectorClient } from "./config";
import { accessTokenClaims, bearerToken, requireTokenGrants } from "./token-shape";
import { ConnectorAuthError, type ConnectorAuthenticator, type ConnectorIdentity } from "./types";

// Authenticates a connector request with Clerk, the app's authorization
// server, in this order:
//
// 1. The bearer token must be shaped like a Clerk JWT access token
//    (./token-shape.ts); anything else is refused with no call to Clerk.
// 2. Clerk verifies it (authenticateRequest with acceptsToken "oauth_token":
//    signature against the instance's keys, expiry, the at+jwt type).
// 3. It must carry the connector's custom scope (CONNECTOR_REQUIRED_SCOPE,
//    ./config.ts), so a token Clerk issued for another OAuth application of
//    the instance does not work here, and the org_id claim of the firm the
//    member chose at consent (the user:org:read scope).
// 4. Clerk's Backend API is asked whether the token was revoked (cached per
//    token for REVOCATION_CACHE_MS; see tokenRevoked for what is known).
// 5. The user must not be banned or locked at Clerk, and must still belong
//    to the token's organization; the Clerk role (Admin or Member) is the
//    current one at Clerk, never a value from the token. Both are read
//    through Clerk's Backend API and cached for MEMBER_CACHE_MS, so a ban, a
//    removal or a change between Admin and Member takes effect within a
//    minute (at once for the tools that ask for `fresh`).
// 6. The user and organization resolve to a tenant and membership exactly as
//    a browser session does (resolveTenantMembership in src/lib/tenant.ts):
//    a Clerk Admin is owner_admin; a Member has the app role stored on
//    their membership row, read from the database on every request, so a
//    role an owner/admin sets on the Firm page applies at once.
//
// Which OAuth client the token was issued to is checked against the
// platform's allow list (./config.ts) and reported as clientAllowed; an
// unlisted client still gets the library tools, never the case-work ones.

const MEMBER_CACHE_MS = 60_000;
const REVOCATION_CACHE_MS = 60_000;
const CACHE_MAX = 2_000;

type OrgMembership = { orgId: string; role: string };
type MemberState = { at: number; banned: boolean; locked: boolean; memberships: OrgMembership[] };
const memberCache = new Map<string, MemberState>();
const revocationCache = new Map<string, { at: number; revoked: boolean }>();

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, value);
}

async function memberState(userId: string, fresh: boolean): Promise<MemberState> {
  const cached = memberCache.get(userId);
  if (!fresh && cached && Date.now() - cached.at < MEMBER_CACHE_MS) return cached;
  const client = await clerkClient();
  const [user, list] = await Promise.all([
    client.users.getUser(userId),
    client.users.getOrganizationMembershipList({ userId, limit: 100 }),
  ]);
  const state: MemberState = {
    at: Date.now(),
    banned: user.banned,
    locked: user.locked,
    memberships: list.data.map((m) => ({ orgId: m.organization.id, role: m.role })),
  };
  remember(memberCache, userId, state);
  return state;
}

let lastRevocationWarningAt = 0;

/**
 * Whether Clerk reports the token revoked or expired, through the Backend
 * API's OAuth access token verify endpoint (POST
 * /oauth_applications/access_tokens/verify, @clerk/backend's
 * idPOAuthAccessToken.verify). Clerk's SDK verifies JWT access tokens
 * locally and never asks this for them; Clerk's documentation says JWT
 * access tokens stay valid until they expire and does not say whether the
 * endpoint reports a revoked JWT. So: a response that says revoked (or
 * expired) refuses the token; an error is logged (at most every ten
 * minutes) and the token, which Clerk's keys already verified, is accepted,
 * in which case revocation takes effect when the token expires (a day by
 * Clerk's default). Cached per token id for REVOCATION_CACHE_MS.
 */
async function tokenRevoked(token: string, jti: string | null, fresh: boolean): Promise<boolean> {
  const key = jti ?? crypto.createHash("sha256").update(token).digest("hex");
  const cached = revocationCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < REVOCATION_CACHE_MS) return cached.revoked;
  let revoked = false;
  try {
    const client = await clerkClient();
    const state = await client.idPOAuthAccessToken.verify(token);
    revoked = state.revoked === true || state.expired === true;
  } catch (err) {
    if (Date.now() - lastRevocationWarningAt > 10 * 60_000) {
      lastRevocationWarningAt = Date.now();
      const status = (err as { status?: unknown }).status;
      console.warn(
        `[connector] Clerk's access token verify endpoint did not answer for a JWT access token (${typeof status === "number" ? `HTTP ${status}` : safeErrorMessage(err)}); revocation then takes effect when the token expires`
      );
    }
  }
  remember(revocationCache, key, { at: Date.now(), revoked });
  return revoked;
}

export const clerkConnectorAuthenticator: ConnectorAuthenticator = async (request, options) => {
  const fresh = options?.fresh === true;
  const token = bearerToken(request);
  if (!token) throw new ConnectorAuthError(401, "invalid_token", "");

  const claims = accessTokenClaims(token);
  if (!claims) {
    throw new ConnectorAuthError(401, "invalid_token", "The access token is not an OAuth access token from this app's sign-in.");
  }

  const client = await clerkClient();
  const state = await client.authenticateRequest(request, { acceptsToken: "oauth_token" });
  const auth = state.toAuth();
  if (!auth || auth.tokenType !== "oauth_token" || !auth.isAuthenticated || !auth.userId) {
    throw new ConnectorAuthError(401, "invalid_token", "The access token is invalid or has expired.");
  }
  const userId = auth.userId;
  const oauthClientId = auth.clientId || "unknown";
  const scopes = auth.scopes ?? [];

  const orgId = requireTokenGrants(scopes, claims);

  let revoked: boolean;
  let member: MemberState;
  try {
    [revoked, member] = await Promise.all([tokenRevoked(token, claims.jti, fresh), memberState(userId, fresh)]);
  } catch (err) {
    // Not the caller's fault: the handler answers 503.
    throw new Error(`Clerk user and organization memberships could not be read: ${safeErrorMessage(err)}`);
  }
  if (revoked) throw new ConnectorAuthError(401, "invalid_token", "The access token was revoked.");
  if (member.banned || member.locked) {
    throw new ConnectorAuthError(401, "invalid_token", "This account cannot sign in to the app now (it is banned or locked).");
  }

  const membership = member.memberships.find((m) => m.orgId === orgId);
  if (!membership) {
    throw new ConnectorAuthError(403, "access_denied", "You are no longer a member of the firm chosen when this connection was made. Disconnect and connect again.");
  }

  try {
    const { tenant, membership: row } = await resolveTenantMembership(userId, membership.orgId, membership.role);
    const identity: ConnectorIdentity = {
      userId,
      oauthClientId,
      clientAllowed: isAllowedConnectorClient(auth.clientId),
      scopes,
      tenantId: tenant.id,
      tenantName: tenant.name,
      role: row.role,
    };
    return identity;
  } catch (err) {
    if (err instanceof TenantResolutionError) {
      throw new ConnectorAuthError(
        403,
        "access_denied",
        err.reason === "no_tenant"
          ? "This firm is not set up in the app yet (its organization has not been synced). Ask the firm's administrator."
          : "Your membership in this firm is not set up in the app yet. Ask the firm's administrator."
      );
    }
    throw err;
  }
};
