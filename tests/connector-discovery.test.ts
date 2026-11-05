import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ConnectorIdentity, ConnectorToolContext } from "@/services/connector/types";

// Importing the real server also loads the DB client through its rate-limit
// module. This test never queries the database; use a local dummy URL so it
// runs without developer or production credentials.
let createConnectorServer: typeof import("@/services/connector/server").createConnectorServer;
test.before(async () => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
  process.env.QUEUE_DATABASE_URL = process.env.DATABASE_URL;
  ({ createConnectorServer } = await import("@/services/connector/server"));
});

const identity: ConnectorIdentity = {
  userId: "user_test",
  oauthClientId: "allowed-test-client",
  clientAllowed: true,
  scopes: ["practice:connector"],
  tenantId: "00000000-0000-4000-8000-000000000001",
  tenantName: "Test firm",
  role: "read_only",
};

function context(overrides: Partial<ConnectorToolContext> = {}): ConnectorToolContext {
  return {
    identity,
    settings: {
      caseWorkActive: true,
      caseWorkSwitch: true,
      disclosureOutdated: false,
      disclosureVersion: "test",
      disclosureAcknowledgedBy: "user_test",
      disclosureAcknowledgedAt: new Date("2026-01-01T00:00:00.000Z"),
      allowDocumentDownloads: false,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    entitlement: {
      state: "active",
      reason: "complimentary",
      trialEndsAt: null,
      graceEndsAt: null,
      subscription: null,
      lockedAt: null,
      trialDaysLeft: 0,
      complimentary: true,
    },
    billingUrl: "https://example.test/billing",
    deps: {} as ConnectorToolContext["deps"],
    reauthenticate: async () => identity,
    ...overrides,
  };
}

async function discoverTools(ctx: ConnectorToolContext): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "connector-discovery-test", version: "1.0.0" });
  const server = createConnectorServer(ctx);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const response = await client.listTools();
    return response.tools.map((tool) => tool.name);
  } finally {
    await client.close();
    await server.close();
  }
}

test("MCP tools/list exposes list_matters to an authorized read-only member", async () => {
  const names = await discoverTools(context());
  assert.ok(names.includes("get_connection_info"));
  assert.ok(names.includes("list_matters"));
});

test("MCP tools/list hides case-work tools when the firm switch is off", async () => {
  const names = await discoverTools(context({
    settings: { ...context().settings, caseWorkActive: false, caseWorkSwitch: false },
  }));
  assert.ok(names.includes("get_connection_info"));
  assert.ok(!names.includes("list_matters"));
});

test("MCP tools/list hides case-work tools from an unrecognized OAuth client", async () => {
  const names = await discoverTools(context({ identity: { ...identity, clientAllowed: false } }));
  assert.ok(names.includes("get_connection_info"));
  assert.ok(!names.includes("list_matters"));
});

test("MCP tools/list leaves only account tools when entitlement is locked", async () => {
  const names = await discoverTools(context({ entitlement: { ...context().entitlement, state: "locked", reason: "no_trial" } }));
  assert.deepEqual(names, ["get_connection_info"]);
});
