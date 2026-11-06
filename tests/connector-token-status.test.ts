import assert from "node:assert/strict";
import test from "node:test";
import {
  accessTokenShape,
  organizationFromUserInfo,
  readVerifiedOAuthTokenStatus,
  requireRevocableConnectorToken,
} from "@/services/connector/token-shape";
import { fetchCurrentMemberState } from "@/services/connector/member-state";
import { connectorAudienceForRequest } from "@/services/connector/config";

const expectedToken = { clientId: "client_1", subject: "user_1" };
const activeToken = {
  clientId: "client_1",
  subject: "user_1",
  type: "oauth_token",
  scopes: ["practice:connector", "user:org:read"],
  revoked: false,
  expired: false,
};

test("binds OAuth authentication to the exact configured MCP resource URL", () => {
  const previousOrigin = process.env.CONNECTOR_PUBLIC_ORIGIN;
  process.env.CONNECTOR_PUBLIC_ORIGIN = "https://mcp.meritdesk.example";
  try {
    const request = new Request("https://attacker.example/api/mcp", {
      headers: { host: "attacker.example" },
    });
    assert.equal(
      connectorAudienceForRequest(request, true),
      "https://mcp.meritdesk.example/api/mcp"
    );
  } finally {
    if (previousOrigin === undefined) delete process.env.CONNECTOR_PUBLIC_ORIGIN;
    else process.env.CONNECTOR_PUBLIC_ORIGIN = previousOrigin;
  }
});

test("refuses to derive a production OAuth audience from request headers", () => {
  const previousOrigin = process.env.CONNECTOR_PUBLIC_ORIGIN;
  delete process.env.CONNECTOR_PUBLIC_ORIGIN;
  try {
    const request = new Request("https://attacker.example/api/mcp");
    assert.equal(connectorAudienceForRequest(request, true), null);
  } finally {
    if (previousOrigin === undefined) delete process.env.CONNECTOR_PUBLIC_ORIGIN;
    else process.env.CONNECTOR_PUBLIC_ORIGIN = previousOrigin;
  }
});

test("accepts an active OAuth token only when Clerk's record matches the authenticated identity", async () => {
  assert.deepEqual(await readVerifiedOAuthTokenStatus(async () => activeToken, expectedToken), activeToken);
});

test("preserves revoked and expired status from Clerk's verified token record", async () => {
  assert.equal((await readVerifiedOAuthTokenStatus(async () => ({ ...activeToken, revoked: true }), expectedToken)).revoked, true);
  assert.equal((await readVerifiedOAuthTokenStatus(async () => ({ ...activeToken, expired: true }), expectedToken)).expired, true);
});

test("fails closed on mismatched or incomplete Clerk token identity", async () => {
  await assert.rejects(
    readVerifiedOAuthTokenStatus(async () => ({ ...activeToken, subject: "user_2" }), expectedToken),
    /incomplete or mismatched/
  );
  await assert.rejects(
    readVerifiedOAuthTokenStatus(async () => ({ ...activeToken, clientId: "client_2" }), expectedToken),
    /incomplete or mismatched/
  );
  await assert.rejects(
    readVerifiedOAuthTokenStatus(async () => ({ ...activeToken, scopes: undefined }), expectedToken),
    /incomplete or mismatched/
  );
});

test("propagates verifier outages instead of treating them as an active token", async () => {
  await assert.rejects(
    readVerifiedOAuthTokenStatus(async () => { throw new Error("upstream unavailable"); }, expectedToken),
    /upstream unavailable/
  );
});

test("recognizes opaque Clerk OAuth tokens while refusing unrelated token shapes", () => {
  assert.deepEqual(accessTokenShape("oat_opaque-token_123"), { format: "opaque" });
  assert.equal(accessTokenShape("ak_api-key"), null);
  assert.equal(accessTokenShape("random-token"), null);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = `${encode({ typ: "at+jwt", kid: "key_1", alg: "RS256" })}.${encode({ org_id: "org_1", jti: "tok_1" })}.signature`;
  assert.deepEqual(accessTokenShape(jwt), { format: "jwt", claims: { orgId: "org_1", jti: "tok_1" } });
});

test("connector refuses JWT access tokens whose revocation cannot be checked live", () => {
  assert.doesNotThrow(() => requireRevocableConnectorToken({ format: "opaque" }));
  assert.throws(
    () => requireRevocableConnectorToken({ format: "jwt", claims: { orgId: "org_1", jti: "tok_1" } }),
    /requires an opaque OAuth access token/
  );
  assert.throws(() => requireRevocableConnectorToken(null), /requires an opaque OAuth access token/);
});

test("connector member state fetches the selected organization on every authentication", async () => {
  let userReads = 0;
  let membershipReads = 0;
  const readUser = async () => {
    userReads += 1;
    return { banned: false, locked: false };
  };
  const readMembership = async (orgId: string, userId: string) => {
    membershipReads += 1;
    assert.equal(orgId, "org_selected");
    assert.equal(userId, "user_1");
    return membershipReads === 1 ? { orgId, role: "org:member" } : null;
  };

  const first = await fetchCurrentMemberState("user_1", "org_selected", readUser, readMembership);
  const afterRemoval = await fetchCurrentMemberState("user_1", "org_selected", readUser, readMembership);
  assert.deepEqual(first.memberships, [{ orgId: "org_selected", role: "org:member" }]);
  assert.deepEqual(afterRemoval.memberships, []);
  assert.equal(userReads, 2);
  assert.equal(membershipReads, 2);
});

test("resolves opaque-token organization only from matching Clerk userinfo", async () => {
  let requestedUrl = "";
  let authorization = "";
  const orgId = await organizationFromUserInfo(
    "oat_opaque-token_123",
    "https://clerk.example.test/",
    "user_1",
    async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ user_id: "user_1", org_id: "org_1", email: "private@example.test" });
    }
  );
  assert.equal(orgId, "org_1");
  assert.equal(requestedUrl, "https://clerk.example.test/oauth/userinfo");
  assert.equal(authorization, "Bearer oat_opaque-token_123");
});

test("rejects mismatched opaque-token userinfo and non-HTTPS issuers", async () => {
  await assert.rejects(
    organizationFromUserInfo("oat_token", "https://clerk.example.test", "user_1", async () =>
      Response.json({ user_id: "user_2", org_id: "org_1" })
    ),
    /no matching user and firm/
  );
  await assert.rejects(
    organizationFromUserInfo("oat_token", "http://clerk.example.test", "user_1"),
    /must use HTTPS/
  );
});
