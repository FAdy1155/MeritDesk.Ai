import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorAuthError, type ConnectorDeps, type ConnectorIdentity } from "@/services/connector/types";

let handleConnectorRequest: typeof import("@/services/connector/http").handleConnectorRequest;
test.before(async () => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
  process.env.QUEUE_DATABASE_URL = process.env.DATABASE_URL;
  process.env.CONNECTOR_PUBLIC_ORIGIN = "https://connector.example.test";
  ({ handleConnectorRequest } = await import("@/services/connector/http"));
});

const identity: ConnectorIdentity = {
  userId: "user_http_test",
  oauthClientId: "http-test-client",
  clientAllowed: true,
  scopes: ["practice:connector", "user:org:read"],
  tenantId: "00000000-0000-4000-8000-000000000011",
  tenantName: "HTTP test firm",
  role: "read_only",
};

const deps = {
  settings: async () => ({
    caseWorkActive: true,
    caseWorkSwitch: true,
    disclosureOutdated: false,
    disclosureVersion: "test",
    disclosureAcknowledgedBy: identity.userId,
    disclosureAcknowledgedAt: new Date("2026-01-01T00:00:00.000Z"),
    allowDocumentDownloads: false,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  }),
  entitlement: async () => ({
    state: "active",
    reason: "complimentary",
    trialEndsAt: null,
    graceEndsAt: null,
    subscription: null,
    lockedAt: null,
    trialDaysLeft: 0,
    complimentary: true,
  }),
  rateLimit: async () => ({ ok: true }),
  caseWork: {
    listMatters: async () => ({
      total: 1,
      matters: [{
        id: "00000000-0000-4000-8000-000000000111",
        caseType: "asylum_defensive",
        status: "active",
        parties: [],
      }],
    }),
  },
} as unknown as ConnectorDeps;

async function mcpPost(message: unknown): Promise<Response> {
  return handleConnectorRequest(
    new Request("https://connector.example.test/api/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-test-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "fly-client-ip": "192.0.2.11",
      },
      body: JSON.stringify(message),
    }),
    { authenticate: async () => identity, deps }
  );
}

test("Streamable HTTP transport initializes and discovers authorized MCP tools", async () => {
  const initialized = await mcpPost({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "connector-http-test", version: "1.0.0" },
    },
  });
  assert.equal(initialized.status, 200);
  assert.match(initialized.headers.get("content-type") ?? "", /application\/json/);
  const initialization = await initialized.json() as {
    result?: { protocolVersion?: string; capabilities?: { tools?: unknown } };
  };
  assert.equal(initialization.result?.protocolVersion, "2025-06-18");
  assert.ok(initialization.result?.capabilities?.tools);

  const listed = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("cache-control"), "no-store");
  const response = await listed.json() as { result?: { tools?: Array<{ name: string }> } };
  assert.ok(response.result?.tools?.some((tool) => tool.name === "list_matters"));

  const called = await mcpPost({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_matters", arguments: { limit: 10 } },
  });
  assert.equal(called.status, 200);
  const toolResult = await called.json() as { result?: { content?: Array<{ text?: string }> } };
  assert.match(toolResult.result?.content?.[0]?.text ?? "", /00000000-0000-4000-8000-000000000111/);
});

test("MCP HTTP refuses a missing token with WWW-Authenticate and rejects GET", async () => {
  process.env.CONNECTOR_PUBLIC_ORIGIN = "https://connector.example.test";
  const missing = await handleConnectorRequest(
    new Request("https://connector.example.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "fly-client-ip": "192.0.2.88" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }),
    {
      authenticate: async () => {
        throw new ConnectorAuthError(401, "invalid_token", "Missing access token.");
      },
      deps,
    }
  );
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("www-authenticate") ?? "", /Bearer/);
  assert.match(missing.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/connector\.example\.test\/\.well-known\/oauth-protected-resource"/);

  const get = await handleConnectorRequest(
    new Request("https://connector.example.test/api/mcp", { method: "GET", headers: { authorization: "Bearer synthetic-test-token", "fly-client-ip": "192.0.2.88" } }),
    { authenticate: async () => identity, deps }
  );
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
});
