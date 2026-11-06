import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { TenantResolutionError, resolveTenantMembership } from "@/lib/tenant";
import { safeErrorMessage } from "@/lib/errors/safe-error";
import { clerkIssuer, connectorAudienceForRequest, isAllowedConnectorClient } from "./config";
import { fetchCurrentMemberState } from "./member-state";
import { accessTokenShape, bearerToken, organizationFromUserInfo, readVerifiedOAuthTokenStatus, requireConnectorScopes, requireRevocableConnectorToken, type VerifiedOAuthTokenStatus } from "./token-shape";
import { ConnectorAuthError, type ConnectorAuthenticator, type ConnectorIdentity } from "./types";

// Authenticates a connector request with Clerk, the app's authorization
// server, in this order:
//
// 1. The bearer token must be shaped like a Clerk JWT or opaque OAuth access
//    token (./token-shape.ts); only opaque OAuth tokens are accepted because
//    JWT token verification cannot prove current revocation status.
// 2. Clerk verifies it with acceptsToken "oauth_token" and the exact MCP
//    resource URL as audience, rejecting missing or cross-resource audiences.
// 3. It must carry the connector's custom scope (CONNECTOR_REQUIRED_SCOPE,
//    ./config.ts) and the firm selected at consent. JWT tokens carry org_id;
//    opaque tokens resolve it from Clerk's authenticated userinfo endpoint.
// 4. Clerk's Backend API is asked whether the opaque token was revoked on
//    every request; this is the format Clerk can check against live status.
// 5. The user must not be banned or locked at Clerk, and must still belong
//    to the token's organization; the Clerk role (Admin or Member) is the
//    current one at Clerk, never a value from the token. Both are fetched
//    from Clerk on every request, so removal or a role change is not delayed
//    by a local membership cache.
// 6. The user and organization resolve to a tenant and membership exactly as
//    a browser session does (resolveTenantMembership in src/lib/tenant.ts):
//    a Clerk Admin is owner_admin; a Member has the app role stored on
//    their membership row, read from the database on every request, so a
//    role an owner/admin sets on the Firm page applies at once.
//
// Which OAuth client the token was issued to is checked against the
// platform's allow list (./config.ts) and reported as clientAllowed; an
// unlisted client still gets the library tools, never the case-work ones.

type MemberState = Awaited<ReturnType<typeof fetchCurrentMemberState>>;

async function memberState(userId: string, orgId: string): Promise<MemberState> {
  const client = await clerkClient();
  return fetchCurrentMemberState(
    userId,
    orgId,
    async (id) => {
      const user = await client.users.getUser(id);
      return { banned: user.banned, locked: user.locked };
    },
    async (organizationId, memberUserId) => {
      const page = await client.organizations.getOrganizationMembershipList({
        organizationId,
        userId: [memberUserId],
        limit: 1,
      });
      const membership = page.data.find((item) => item.publicUserData?.userId === memberUserId);
      return membership ? { orgId: membership.organization.id, role: membership.role } : null;
    }
  );
}

let lastRevocationWarningAt = 0;

/**
 * Whether Clerk reports the token revoked or expired, through the Backend
 * API's OAuth access token verify endpoint (POST
 * /oauth_applications/access_tokens/verify, @clerk/backend's
 * idPOAuthAccessToken.verify). Opaque tokens require a network lookup, so a
 * response that says revoked (or expired) refuses the token. If Clerk cannot
 * answer, authentication fails closed with a retryable server error. This is
 * called for every request; no local cache can extend a revoked connection's access.
 */
async function verifiedTokenStatus(
  token: string,
  expected: { clientId: string; subject: string }
): Promise<VerifiedOAuthTokenStatus> {
  let status: VerifiedOAuthTokenStatus;
  try {
    const client = await clerkClient();
    status = await readVerifiedOAuthTokenStatus(
      () => client.idPOAuthAccessToken.verify(token),
      expected
    );
  } catch (err) {
    if (Date.now() - lastRevocationWarningAt > 10 * 60_000) {
      lastRevocationWarningAt = Date.now();
      const status = (err as { status?: unknown }).status;
      console.warn(
        `[connector] Clerk's access token verify endpoint did not answer; connector authentication is failing closed (${typeof status === "number" ? `HTTP ${status}` : safeErrorMessage(err)})`
      );
    }
    // Never turn an unavailable revocation check into an authorization
    // decision. The caller maps this operational failure to HTTP 503.
    throw new Error("Clerk could not verify the connector access token status.");
  }
  return status;
}

export const clerkConnectorAuthenticator: ConnectorAuthenticator = async (request) => {
  const token = bearerToken(request);
  if (!token) throw new ConnectorAuthError(401, "invalid_token", "");

  const tokenShape = accessTokenShape(token);
  requireRevocableConnectorToken(tokenShape);

  const client = await clerkClient();
  const audience = connectorAudienceForRequest(request);
  if (!audience) {
    throw new Error("MCP public origin is not configured; refusing to verify an unbound OAuth token.");
  }
  const state = await client.authenticateRequest(request, {
    acceptsToken: "oauth_token",
    audience,
  });
  const auth = state.toAuth();
  if (!auth || auth.tokenType !== "oauth_token" || !auth.isAuthenticated || !auth.userId) {
    throw new ConnectorAuthError(401, "invalid_token", "The access token is invalid or has expired.");
  }
  const userId = auth.userId;
  const oauthClientId = auth.clientId;
  const scopes = auth.scopes ?? [];

  let orgId: string;
  requireConnectorScopes(scopes);
  const issuer = clerkIssuer();
  if (!issuer) throw new Error("Clerk OAuth issuer is not configured.");
  try {
    orgId = await organizationFromUserInfo(token, issuer, userId);
  } catch {
    throw new Error("Clerk could not verify the opaque connector token's user and firm.");
  }

  let verifiedStatus: VerifiedOAuthTokenStatus;
  let member: MemberState;
  try {
    [verifiedStatus, member] = await Promise.all([
      verifiedTokenStatus(
        token,
        { clientId: oauthClientId, subject: userId }
      ),
      memberState(userId, orgId),
    ]);
  } catch (err) {
    // Not the caller's fault: the handler answers 503.
    throw new Error(`Clerk user and organization memberships could not be read: ${safeErrorMessage(err)}`);
  }
  if (verifiedStatus.revoked || verifiedStatus.expired) {
    throw new ConnectorAuthError(401, "invalid_token", "The access token was revoked or expired.");
  }
  requireConnectorScopes(verifiedStatus.scopes);
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
