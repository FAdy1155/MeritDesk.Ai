import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { db as appDb, TenantTransactionRunner } from "@/db/client";
import type { ConnectorCallContext } from "@/lib/connector/case-work";
import type { ConnectorIdentity, ConnectorToolContext } from "@/services/connector/types";

const TENANT = "a0000000-0000-4000-8000-000000000001";
const USER = "user_smith_firm";

const pg = new PGlite({ extensions: { pg_trgm } });
const db = drizzle(pg, { schema });
let connectorCaseWork: typeof import("@/lib/connector/case-work");
let createConnectorServer: typeof import("@/services/connector/server").createConnectorServer;

const pgliteTenant: TenantTransactionRunner = (tenantId, callback) =>
  db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE app_runtime`);
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return callback(tx as unknown as typeof appDb);
  });

test.before(async () => {
  await migrate(db, { migrationsFolder: path.resolve("src/db/migrations") });
  await pg.exec(`
    CREATE ROLE app_runtime NOSUPERUSER NOBYPASSRLS NOLOGIN;
    GRANT USAGE ON SCHEMA public TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
    INSERT INTO tenants (id, name, slug, clerk_org_id) VALUES
      ('${TENANT}', 'Northbrook Immigration PLLC', 'northbrook-test', 'org_smith_test');
    INSERT INTO memberships (tenant_id, user_id, role) VALUES
      ('${TENANT}', '${USER}', 'owner_admin');
  `);
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
  process.env.QUEUE_DATABASE_URL = process.env.DATABASE_URL;
  connectorCaseWork = await import("@/lib/connector/case-work");
  ({ createConnectorServer } = await import("@/services/connector/server"));
});

test.after(async () => {
  await pg.close();
});

function toolText(response: { content: unknown }): string {
  return (response.content as Array<{ text?: string }>).map((block) => block.text ?? "").join("\n");
}

function editorContext(role: ConnectorIdentity["role"] = "owner_admin"): ConnectorToolContext {
  const identity: ConnectorIdentity = {
    userId: USER,
    oauthClientId: "allowed-test-client",
    clientAllowed: true,
    scopes: ["practice:connector"],
    tenantId: TENANT,
    tenantName: "Northbrook Immigration PLLC",
    role,
  };
  return {
    identity,
    settings: {
      caseWorkActive: true,
      caseWorkSwitch: true,
      disclosureOutdated: false,
      disclosureVersion: "test",
      disclosureAcknowledgedBy: USER,
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
    deps: {
      rateLimit: async () => ({ ok: true as const }),
      library: {
        search: async () => ({ hits: [], total: 0, totalCapped: false, citation: null, order: "rank" as const }),
        read: async () => null,
        lookup: async () => ({ citation: null, matches: [] }),
        eoirSearchJudges: async () => ({ snapshot: null, judges: [], total: 0 }),
        eoirJudgeProfile: async () => ({ snapshot: null, profile: null }),
        eoirQuery: async () => ({ snapshot: null, result: null }),
      },
      caseWork: {
        listClients: (call: ConnectorCallContext, params: { limit: number; offset: number }) =>
          connectorCaseWork.listClientsForConnector(call, params, pgliteTenant),
        createClient: (call: ConnectorCallContext, input: Parameters<typeof connectorCaseWork.createClientForConnector>[1]) =>
          connectorCaseWork.createClientForConnector(call, input, pgliteTenant),
        createMatter: (call: ConnectorCallContext, input: Parameters<typeof connectorCaseWork.createMatterForConnector>[1]) =>
          connectorCaseWork.createMatterForConnector(call, input, pgliteTenant),
        addMatterParty: (call: ConnectorCallContext, input: Parameters<typeof connectorCaseWork.addMatterPartyForConnector>[1]) =>
          connectorCaseWork.addMatterPartyForConnector(call, input, pgliteTenant),
        listMatters: (call: ConnectorCallContext, params: { status?: string | null; caseType?: string | null; limit: number; offset: number }) =>
          connectorCaseWork.listMattersForConnector(call, params, pgliteTenant),
        getMatter: (call: ConnectorCallContext, matterId: string, limits: { documentLimit: number; runLimit: number }) =>
          connectorCaseWork.getMatterForConnector(call, matterId, limits, pgliteTenant),
        getMatterCaseType: (call: ConnectorCallContext, matterId: string) =>
          connectorCaseWork.getMatterCaseTypeForConnector(call, matterId, pgliteTenant),
        getSkillRun: (call: ConnectorCallContext, runId: string) =>
          connectorCaseWork.getSkillRunForConnector(call, runId, pgliteTenant),
        listLegalUpdates: async () => [],
        recordOutcome: (call: ConnectorCallContext, outcome: string, ids?: { matterId?: string; skillRunId?: string; documentId?: string }) =>
          connectorCaseWork.recordConnectorCallOutcome(call, outcome, ids, pgliteTenant),
      },
    },
    reauthenticate: async () => identity,
  } as unknown as ConnectorToolContext;
}

async function withClient<T>(ctx: ConnectorToolContext, run: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "john-smith-workflow", version: "1.0.0" });
  const server = createConnectorServer(ctx);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("MCP handshake lists tools and runs the John Smith case-work workflow", async () => {
  const ctx = editorContext();
  await withClient(ctx, async (client) => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const required of [
      "get_connection_info",
      "list_clients",
      "create_client",
      "create_matter",
      "add_matter_party",
      "list_matters",
      "get_matter",
      "list_skills",
      "list_legal_updates",
      "search",
      "search_library",
      "run_skill",
    ]) {
      assert.ok(names.includes(required), `missing tool ${required}`);
    }
    assert.ok(listed.tools.find((t) => t.name === "create_client")?.inputSchema);

    const info = await client.callTool({ name: "get_connection_info", arguments: {} });
    assert.equal(info.isError, undefined);
    assert.match(toolText(info), /Northbrook Immigration PLLC/);
    assert.match(toolText(info), /owner\/admin/);

    const unconfirmed = await client.callTool({ name: "create_client", arguments: { full_name: "John Smith" } });
    assert.equal(unconfirmed.isError, true);

    const created = await client.callTool({
      name: "create_client",
      arguments: {
        full_name: "John Smith",
        date_of_birth: "1988-04-12",
        country_of_birth: "Nigeria",
        primary_language: "English",
        confirm: true,
      },
    });
    assert.equal(created.isError, undefined, toolText(created));
    const clientId = toolText(created).match(/client_id: ([0-9a-f-]{36})/)?.[1];
    assert.ok(clientId);

    const employment = await client.callTool({
      name: "create_matter",
      arguments: { caseType: "employment_based", confirm: true },
    });
    assert.equal(employment.isError, true);
    assert.match(toolText(employment).toLowerCase(), /case type/);

    const matter = await client.callTool({
      name: "create_matter",
      arguments: { caseType: "i130", confirm: true },
    });
    assert.equal(matter.isError, undefined, toolText(matter));
    const matterId = toolText(matter).match(/matter ([0-9a-f-]{36})/)?.[1];
    assert.ok(matterId);

    const linked = await client.callTool({
      name: "add_matter_party",
      arguments: { matter_id: matterId, client_id: clientId, role: "beneficiary", confirm: true },
    });
    assert.equal(linked.isError, undefined, toolText(linked));

    const clients = await client.callTool({ name: "list_clients", arguments: { limit: 20, offset: 0 } });
    assert.match(toolText(clients), /John Smith/);
    assert.doesNotMatch(toolText(clients), /1988-04-12/);

    const fetched = await client.callTool({ name: "get_matter", arguments: { matter_id: matterId } });
    assert.equal(fetched.isError, undefined);
    const fetchedText = toolText(fetched);
    assert.match(fetchedText, /John Smith/);
    assert.match(fetchedText, /i130/i);
    assert.doesNotMatch(fetchedText, /A123456789/);

    const skills = await client.callTool({ name: "list_skills", arguments: { matter_id: matterId } });
    assert.equal(skills.isError, undefined, toolText(skills));
    assert.match(toolText(skills), /I-130/);

    const library = await client.callTool({ name: "search_library", arguments: { query: "INA 203" } });
    assert.equal(library.isError, undefined, toolText(library));
    const search = await client.callTool({ name: "search", arguments: { query: "INA 203" } });
    assert.equal(search.isError, undefined, toolText(search));
    const fetch = await client.callTool({ name: "fetch", arguments: { id: "not-a-document-id" } });
    assert.equal(fetch.isError, true);
    const lookup = await client.callTool({ name: "lookup_library_citation", arguments: { citation: "8 C.F.R. 1003.38" } });
    assert.equal(lookup.isError, undefined, toolText(lookup));
    const judges = await client.callTool({ name: "search_eoir_judges", arguments: { name: "Smith" } });
    assert.equal(judges.isError, undefined, toolText(judges));
    const profile = await client.callTool({ name: "eoir_judge_profile", arguments: { judge_code: "SMI" } });
    assert.equal(profile.isError, undefined, toolText(profile));
    const stats = await client.callTool({ name: "query_eoir_stats", arguments: { measure: "completions" } });
    assert.equal(stats.isError, undefined, toolText(stats));
    const listedMatters = await client.callTool({ name: "list_matters", arguments: { limit: 20, offset: 0 } });
    assert.match(toolText(listedMatters), /John Smith/);
    const missingRun = await client.callTool({
      name: "get_skill_run",
      arguments: { run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
    assert.equal(missingRun.isError, true);
    const updates = await client.callTool({ name: "list_legal_updates", arguments: { view: "unreviewed" } });
    assert.equal(updates.isError, undefined, toolText(updates));
    const download = await client.callTool({
      name: "get_document_download_link",
      arguments: { matter_id: matterId, document_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", confirm: true },
    });
    assert.equal(download.isError, true);

    const missingNoteTool = names.includes("add_case_note") || names.includes("add_note");
    assert.equal(missingNoteTool, false);
  });
});

test("read-only MCP identity cannot create a client", async () => {
  await withClient(editorContext("read_only"), async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.includes("create_client"), false);
    const attempt = await client.callTool({
      name: "create_client",
      arguments: { full_name: "Should Fail", confirm: true },
    });
    assert.equal(attempt.isError, true);
  });
});
