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

const TENANT_A = "10000000-0000-4000-8000-000000000001";
const TENANT_B = "10000000-0000-4000-8000-000000000002";
const CLIENT_A = "20000000-0000-4000-8000-000000000001";
const CLIENT_B = "20000000-0000-4000-8000-000000000002";
const MATTER_A = "30000000-0000-4000-8000-000000000001";
const MATTER_B = "30000000-0000-4000-8000-000000000002";
const DOCUMENT_A = "40000000-0000-4000-8000-000000000001";
const DOCUMENT_B = "40000000-0000-4000-8000-000000000002";
const SKILL_DEFINITION = "50000000-0000-4000-8000-000000000001";
const RUN_A = "60000000-0000-4000-8000-000000000001";
const RUN_B = "60000000-0000-4000-8000-000000000002";
const PROFILE_A = "70000000-0000-4000-8000-000000000001";
const PROFILE_B = "70000000-0000-4000-8000-000000000002";
const AUDIT_A = "80000000-0000-4000-8000-000000000001";
const AUDIT_B = "80000000-0000-4000-8000-000000000002";

const pg = new PGlite({ extensions: { pg_trgm } });
const db = drizzle(pg, { schema });
let connectorCaseWork: typeof import("@/lib/connector/case-work");
let failUnfinishedSkillRun: typeof import("@/lib/skill-runs/service").failUnfinishedSkillRun;
let getDocumentDownloadUrl: typeof import("@/lib/documents/service").getDocumentDownloadUrl;
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
      ('${TENANT_A}', 'Firm A', 'firm-a', 'org_test_a'),
      ('${TENANT_B}', 'Firm B', 'firm-b', 'org_test_b');
    INSERT INTO memberships (tenant_id, user_id, role) VALUES
      ('${TENANT_A}', 'user_a', 'owner_admin'),
      ('${TENANT_B}', 'user_b', 'read_only');
    INSERT INTO practice_profile_versions (id, tenant_id, version_number, status, profile_json, rendered_markdown) VALUES
      ('${PROFILE_A}', '${TENANT_A}', 1, 'draft', '{"strategy":"Firm A private strategy"}', 'Firm A private strategy'),
      ('${PROFILE_B}', '${TENANT_B}', 1, 'draft', '{"strategy":"Firm B private strategy"}', 'Firm B private strategy');
    INSERT INTO firm_identities (tenant_id, legal_name, updated_by) VALUES
      ('${TENANT_A}', 'Firm A Legal Name', 'user_a'),
      ('${TENANT_B}', 'Firm B Legal Name', 'user_b');
    INSERT INTO firm_attorneys (tenant_id, full_name, signature_s3_key) VALUES
      ('${TENANT_A}', 'Attorney A', 'tenants/a/signature'),
      ('${TENANT_B}', 'Attorney B', 'tenants/b/signature');
    INSERT INTO clients (id, tenant_id, full_name, a_number, date_of_birth, contact_email, notes) VALUES
      ('${CLIENT_A}', '${TENANT_A}', 'Client A Secret', 'A123456789', '1990-01-01', 'a@example.test', 'Firm A private note'),
      ('${CLIENT_B}', '${TENANT_B}', 'Client B Secret', 'A987654321', '1991-02-02', 'b@example.test', 'Firm B private note');
    INSERT INTO matters (id, tenant_id, case_type) VALUES
      ('${MATTER_A}', '${TENANT_A}', 'asylum_defensive'),
      ('${MATTER_B}', '${TENANT_B}', 'asylum_defensive');
    INSERT INTO matter_parties (tenant_id, matter_id, client_id, role) VALUES
      ('${TENANT_A}', '${MATTER_A}', '${CLIENT_A}', 'respondent'),
      ('${TENANT_B}', '${MATTER_B}', '${CLIENT_B}', 'respondent');
    INSERT INTO documents (id, tenant_id, matter_id, type, file_name, s3_key, s3_bucket, extracted_text, uploaded_by) VALUES
      ('${DOCUMENT_A}', '${TENANT_A}', '${MATTER_A}', 'uploaded_evidence', 'a.pdf', 'a/key', 'private-test', 'Firm A confidential evidence', 'user_a'),
      ('${DOCUMENT_B}', '${TENANT_B}', '${MATTER_B}', 'uploaded_evidence', 'b.pdf', 'b/key', 'private-test', 'Firm B confidential evidence', 'user_b');
    INSERT INTO skill_definitions (id, name, version, content_hash, skill_markdown, output_json_schema) VALUES
      ('${SKILL_DEFINITION}', 'test-skill', 1, 'test-hash', 'test', '{}');
    INSERT INTO skill_runs (id, tenant_id, matter_id, skill_definition_id, skill_name, skill_version, input_snapshot, structured_output, requested_by) VALUES
      ('${RUN_A}', '${TENANT_A}', '${MATTER_A}', '${SKILL_DEFINITION}', 'test-skill', 1, '{"note":"Firm A private snapshot"}', '{"report":"Firm A private report"}', 'user_a'),
      ('${RUN_B}', '${TENANT_B}', '${MATTER_B}', '${SKILL_DEFINITION}', 'test-skill', 1, '{"note":"Firm B private snapshot"}', '{"report":"Firm B private report"}', 'user_b');
    INSERT INTO audit_logs (id, tenant_id, actor_user_id, action, resource_type, after) VALUES
      ('${AUDIT_A}', '${TENANT_A}', 'user_a', 'client.create', 'client', '{"private":"Firm A audit"}'),
      ('${AUDIT_B}', '${TENANT_B}', 'user_b', 'client.create', 'client', '{"private":"Firm B audit"}');
  `);
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
  process.env.QUEUE_DATABASE_URL = process.env.DATABASE_URL;
  connectorCaseWork = await import("@/lib/connector/case-work");
  ({ failUnfinishedSkillRun } = await import("@/lib/skill-runs/service"));
  ({ getDocumentDownloadUrl } = await import("@/lib/documents/service"));
  ({ createConnectorServer } = await import("@/services/connector/server"));
});

test.after(async () => {
  await pg.close();
});

async function withTenant<T>(tenantId: string, run: (tx: { query: typeof pg.query }) => Promise<T>): Promise<T> {
  return pg.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE app_runtime");
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return run(tx);
  });
}

async function withServiceSetting<T>(run: (tx: { query: typeof pg.query }) => Promise<T>): Promise<T> {
  return pg.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE app_runtime");
    await tx.exec("SET LOCAL app.is_service_role = 'true'");
    return run(tx);
  });
}

test("the migrated runtime role has forced RLS on tenant records", async () => {
  const result = await withTenant(TENANT_A, (tx) =>
    tx.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN (
         'tenants', 'memberships', 'practice_profile_versions', 'clients', 'matters', 'matter_parties',
         'documents', 'skill_runs', 'audit_logs', 'firm_identities', 'firm_attorneys', 'legal_update_reviews',
         'tenant_connector_settings', 'connector_rate_buckets', 'connector_unrecognized_clients', 'tenant_billing',
         'email_sends', 'stripe_webhook_events', 'user_trials', 'firm_creation_attempts'
       ) ORDER BY relname`
    )
  );
  assert.equal(result.rows.length, 20);
  assert.ok(result.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
});

test("Firm A cannot read Firm B clients, matters, or documents", async () => {
  const result = await withTenant(TENANT_A, async (tx) => {
    const clients = await tx.query<{ id: string; full_name: string; notes: string }>("SELECT id, full_name, notes FROM clients ORDER BY id");
    const matters = await tx.query<{ id: string }>("SELECT id FROM matters ORDER BY id");
    const documents = await tx.query<{ id: string; file_name: string; extracted_text: string }>("SELECT id, file_name, extracted_text FROM documents ORDER BY id");
    const runs = await tx.query<{ id: string; input_snapshot: { note: string }; structured_output: { report: string } }>("SELECT id, input_snapshot, structured_output FROM skill_runs ORDER BY id");
    const profiles = await tx.query<{ id: string; profile_json: { strategy: string } }>("SELECT id, profile_json FROM practice_profile_versions ORDER BY id");
    const identities = await tx.query<{ legal_name: string }>("SELECT legal_name FROM firm_identities");
    const attorneys = await tx.query<{ full_name: string; signature_s3_key: string }>("SELECT full_name, signature_s3_key FROM firm_attorneys");
    const memberships = await tx.query<{ user_id: string }>("SELECT user_id FROM memberships");
    const audit = await tx.query<{ id: string; after: { private: string } }>("SELECT id, after FROM audit_logs ORDER BY id");
    const directClient = await tx.query("SELECT id FROM clients WHERE id = $1", [CLIENT_B]);
    const directMatter = await tx.query("SELECT id FROM matters WHERE id = $1", [MATTER_B]);
    const directDocument = await tx.query("SELECT id FROM documents WHERE id = $1", [DOCUMENT_B]);
    return {
      clients: clients.rows, matters: matters.rows, documents: documents.rows, runs: runs.rows,
      profiles: profiles.rows, identities: identities.rows, attorneys: attorneys.rows,
      memberships: memberships.rows, audit: audit.rows, directClient, directMatter, directDocument,
    };
  });
  assert.deepEqual(result.clients.map((row) => row.id), [CLIENT_A]);
  assert.deepEqual(result.clients.map((row) => row.full_name), ["Client A Secret"]);
  assert.deepEqual(result.clients.map((row) => row.notes), ["Firm A private note"]);
  assert.deepEqual(result.matters.map((row) => row.id), [MATTER_A]);
  assert.deepEqual(result.documents.map((row) => row.id), [DOCUMENT_A]);
  assert.equal(result.documents.some((row) => row.file_name === "b.pdf"), false);
  assert.deepEqual(result.documents.map((row) => row.extracted_text), ["Firm A confidential evidence"]);
  assert.deepEqual(result.runs.map((row) => row.id), [RUN_A]);
  assert.equal(result.runs[0]?.input_snapshot.note, "Firm A private snapshot");
  assert.equal(result.runs[0]?.structured_output.report, "Firm A private report");
  assert.deepEqual(result.profiles.map((row) => row.id), [PROFILE_A]);
  assert.deepEqual(result.identities.map((row) => row.legal_name), ["Firm A Legal Name"]);
  assert.deepEqual(result.attorneys.map((row) => row.signature_s3_key), ["tenants/a/signature"]);
  assert.deepEqual(result.memberships.map((row) => row.user_id), ["user_a"]);
  assert.deepEqual(result.audit.map((row) => row.id), [AUDIT_A]);
  assert.equal(result.audit[0]?.after.private, "Firm A audit");
  assert.deepEqual(result.directClient.rows, []);
  assert.deepEqual(result.directMatter.rows, []);
  assert.deepEqual(result.directDocument.rows, []);
});

test("Firm B can see its own records", async () => {
  const result = await withTenant(TENANT_B, async (tx) => {
    const clients = await tx.query<{ id: string; notes: string }>("SELECT id, notes FROM clients");
    const matters = await tx.query<{ id: string }>("SELECT id FROM matters");
    const documents = await tx.query<{ id: string; extracted_text: string }>("SELECT id, extracted_text FROM documents");
    const runs = await tx.query<{ id: string; structured_output: { report: string } }>("SELECT id, structured_output FROM skill_runs");
    const audit = await tx.query<{ id: string }>("SELECT id FROM audit_logs");
    return { clients: clients.rows, matters: matters.rows, documents: documents.rows, runs: runs.rows, audit: audit.rows };
  });
  assert.deepEqual(result.clients.map((row) => row.id), [CLIENT_B]);
  assert.deepEqual(result.clients.map((row) => row.notes), ["Firm B private note"]);
  assert.deepEqual(result.matters.map((row) => row.id), [MATTER_B]);
  assert.deepEqual(result.documents.map((row) => row.id), [DOCUMENT_B]);
  assert.deepEqual(result.documents.map((row) => row.extracted_text), ["Firm B confidential evidence"]);
  assert.deepEqual(result.runs.map((row) => row.id), [RUN_B]);
  assert.equal(result.runs[0]?.structured_output.report, "Firm B private report");
  assert.deepEqual(result.audit.map((row) => row.id), [AUDIT_B]);
});

test("connector case-work services scope results and audit entries to the authenticated tenant", async () => {
  const callA: ConnectorCallContext = { tenantId: TENANT_A, userId: "user_a", oauthClientId: "test-client", tool: "list_matters" };
  const listedA = await connectorCaseWork.listMattersForConnector(callA, { limit: 20, offset: 0 }, pgliteTenant);
  assert.equal(listedA.total, 1);
  assert.deepEqual(listedA.matters.map((matter) => matter.id), [MATTER_A]);
  assert.deepEqual(listedA.matters[0]?.parties, [{ name: "Client A Secret", role: "respondent" }]);

  const clientsA = await connectorCaseWork.listClientsForConnector(callA, { limit: 20, offset: 0 }, pgliteTenant);
  assert.deepEqual(clientsA.clients.map((client) => client.fullName), ["Client A Secret"]);
  assert.equal("aNumber" in clientsA.clients[0]!, false);
  assert.equal("dateOfBirth" in clientsA.clients[0]!, false);
  assert.equal("contactEmail" in clientsA.clients[0]!, false);

  const matterA = await connectorCaseWork.getMatterForConnector(callA, MATTER_A, { documentLimit: 20, runLimit: 20 }, pgliteTenant);
  assert.ok(matterA);
  assert.deepEqual(matterA.documents.map((document) => document.id), [DOCUMENT_A]);
  assert.equal("s3Key" in matterA.documents[0]!, false);
  assert.equal("extractedText" in matterA.documents[0]!, false);
  assert.equal("storageKey" in matterA.documents[0]!, false);

  const crossFirmMatter = await connectorCaseWork.getMatterForConnector(callA, MATTER_B, { documentLimit: 20, runLimit: 20 }, pgliteTenant);
  assert.equal(crossFirmMatter, null);
  await assert.rejects(
    () => connectorCaseWork.addMatterPartyForConnector(
      { ...callA, tool: "add_matter_party" },
      { matterId: MATTER_A, clientId: CLIENT_B, role: "petitioner" },
      pgliteTenant
    ),
    /Client not found/
  );

  const callAudit = await withTenant(TENANT_A, (tx) =>
    tx.query<{ resource_id: string | null; after: { outcome?: string; matterId?: string } }>(
      "SELECT resource_id, after FROM audit_logs WHERE action = 'connector.tool_call' ORDER BY created_at"
    )
  );
  assert.deepEqual(callAudit.rows.map((row) => row.after.outcome), ["ok", "ok", "ok", "not_found"]);
  assert.equal(callAudit.rows.some((row) => row.after.matterId === MATTER_B && row.after.outcome === "not_found"), true);

  const callB: ConnectorCallContext = { tenantId: TENANT_B, userId: "user_b", oauthClientId: "test-client", tool: "list_matters" };
  const listedB = await connectorCaseWork.listMattersForConnector(callB, { limit: 20, offset: 0 }, pgliteTenant);
  assert.deepEqual(listedB.matters.map((matter) => matter.id), [MATTER_B]);
});

test("MCP tools/call executes list_matters against tenant-scoped services", async () => {
  const identity: ConnectorIdentity = {
    userId: "user_a",
    oauthClientId: "allowed-test-client",
    clientAllowed: true,
    scopes: ["practice:connector"],
    tenantId: TENANT_A,
    tenantName: "Firm A",
    role: "read_only",
  };
  const ctx = {
    identity,
    settings: {
      caseWorkActive: true,
      caseWorkSwitch: true,
      disclosureOutdated: false,
      disclosureVersion: "test",
      disclosureAcknowledgedBy: "user_a",
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
      caseWork: {
        listMatters: (call: ConnectorCallContext, params: { status?: string | null; caseType?: string | null; limit: number; offset: number }) =>
          connectorCaseWork.listMattersForConnector(call, params, pgliteTenant),
      },
    },
    reauthenticate: async () => identity,
  } as unknown as ConnectorToolContext;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tenant-isolation-test", version: "1.0.0" });
  const server = createConnectorServer(ctx);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const response = await client.callTool({ name: "list_matters", arguments: { limit: 20, offset: 0 } });
    assert.equal(response.isError, undefined);
    const blocks = response.content as Array<{ type: string; text?: string }>;
    const body = blocks.map((block) => block.type === "text" ? block.text ?? "" : "").join("\n");
    assert.ok(body.includes(MATTER_A));
    assert.ok(body.includes("Client A Secret"));
    assert.ok(!body.includes(MATTER_B));
    assert.ok(!body.includes("Client B Secret"));
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP create and link tools write only to the authenticated firm's tenant", async () => {
  const identity: ConnectorIdentity = {
    userId: "user_a",
    oauthClientId: "allowed-test-client",
    clientAllowed: true,
    scopes: ["practice:connector"],
    tenantId: TENANT_A,
    tenantName: "Firm A",
    role: "owner_admin",
  };
  const ctx = {
    identity,
    settings: {
      caseWorkActive: true,
      caseWorkSwitch: true,
      disclosureOutdated: false,
      disclosureVersion: "test",
      disclosureAcknowledgedBy: "user_a",
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
      caseWork: {
        createClient: (call: ConnectorCallContext, input: Parameters<typeof connectorCaseWork.createClientForConnector>[1]) =>
          connectorCaseWork.createClientForConnector(call, input, pgliteTenant),
        createMatter: (call: ConnectorCallContext, input: Parameters<typeof connectorCaseWork.createMatterForConnector>[1]) =>
          connectorCaseWork.createMatterForConnector(call, input, pgliteTenant),
        addMatterParty: (call: ConnectorCallContext, input: Parameters<typeof connectorCaseWork.addMatterPartyForConnector>[1]) =>
          connectorCaseWork.addMatterPartyForConnector(call, input, pgliteTenant),
        listMatters: (call: ConnectorCallContext, params: { status?: string | null; caseType?: string | null; limit: number; offset: number }) =>
          connectorCaseWork.listMattersForConnector(call, params, pgliteTenant),
        recordOutcome: (call: ConnectorCallContext, outcome: string, ids?: { matterId?: string; skillRunId?: string; documentId?: string }) =>
          connectorCaseWork.recordConnectorCallOutcome(call, outcome, ids, pgliteTenant),
      },
    },
    reauthenticate: async () => identity,
  } as unknown as ConnectorToolContext;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tenant-write-test", version: "1.0.0" });
  const server = createConnectorServer(ctx);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const createdClient = await client.callTool({
      name: "create_client",
      arguments: { full_name: "Synthetic MCP Client", confirm: true },
    });
    assert.equal(createdClient.isError, undefined);
    const clientText = (createdClient.content as Array<{ text?: string }>).map((block) => block.text ?? "").join("\n");
    const createdClientId = clientText.match(/client_id: ([0-9a-f-]{36})/)?.[1];
    assert.ok(createdClientId);

    const createdMatter = await client.callTool({
      name: "create_matter",
      arguments: { caseType: "asylum_defensive", confirm: true },
    });
    assert.equal(createdMatter.isError, undefined);
    const matterText = (createdMatter.content as Array<{ text?: string }>).map((block) => block.text ?? "").join("\n");
    const createdMatterId = matterText.match(/matter ([0-9a-f-]{36})/)?.[1];
    assert.ok(createdMatterId);

    const linked = await client.callTool({
      name: "add_matter_party",
      arguments: { matter_id: createdMatterId, client_id: createdClientId, role: "respondent", confirm: true },
    });
    assert.equal(linked.isError, undefined);

    const crossTenantLink = await client.callTool({
      name: "add_matter_party",
      arguments: { matter_id: MATTER_A, client_id: CLIENT_B, role: "petitioner", confirm: true },
    });
    assert.equal(crossTenantLink.isError, true);

    const firmA = await withTenant(TENANT_A, (tx) => tx.query<{ id: string; tenant_id: string }>(
      "SELECT id, tenant_id FROM clients WHERE id = $1 UNION ALL SELECT id, tenant_id FROM matters WHERE id = $2",
      [createdClientId, createdMatterId]
    ));
    assert.equal(firmA.rows.length, 2);
    assert.ok(firmA.rows.every((row) => row.tenant_id === TENANT_A));
    const firmB = await withTenant(TENANT_B, async (tx) => ({
      clients: await tx.query("SELECT id FROM clients WHERE id = $1", [createdClientId]),
      matters: await tx.query("SELECT id FROM matters WHERE id = $1", [createdMatterId]),
    }));
    assert.deepEqual(firmB.clients.rows, []);
    assert.deepEqual(firmB.matters.rows, []);
  } finally {
    await client.close();
    await server.close();
  }
});

test("document download service denies cross-tenant ids and audits every non-clean scan state", async () => {
  await assert.rejects(
    getDocumentDownloadUrl(TENANT_A, DOCUMENT_B, "user_a", { runTenant: pgliteTenant }),
    /Document not found/
  );
  await assert.rejects(
    getDocumentDownloadUrl(TENANT_A, DOCUMENT_A, "user_a", { runTenant: pgliteTenant }),
    /Download not available yet/
  );

  await withTenant(TENANT_A, async (tx) => {
    await tx.query("UPDATE documents SET malware_scan_status = 'clean', s3_version_id = NULL WHERE id = $1", [DOCUMENT_A]);
  });
  await assert.rejects(
    getDocumentDownloadUrl(TENANT_A, DOCUMENT_A, "user_a", { runTenant: pgliteTenant }),
    /did not provide an immutable object version/
  );

  const deniedAudit = await withTenant(TENANT_A, (tx) =>
    tx.query<{ resource_id: string | null; after: { reason?: string } }>(
      "SELECT resource_id, after FROM audit_logs WHERE action = 'document.download_blocked' ORDER BY created_at"
    )
  );
  assert.deepEqual(deniedAudit.rows.map((row) => row.after.reason), ["malware_scan_pending", "storage_version_unavailable"]);

  await withTenant(TENANT_A, async (tx) => {
    await tx.query("UPDATE documents SET malware_scan_status = 'infected' WHERE id = $1", [DOCUMENT_A]);
  });
  await assert.rejects(getDocumentDownloadUrl(TENANT_A, DOCUMENT_A, "user_a", { runTenant: pgliteTenant }), /malware scan flagged this file as infected/);

  await withTenant(TENANT_A, async (tx) => {
    await tx.query("UPDATE documents SET malware_scan_status = 'error' WHERE id = $1", [DOCUMENT_A]);
  });
  await assert.rejects(getDocumentDownloadUrl(TENANT_A, DOCUMENT_A, "user_a", { runTenant: pgliteTenant }), /file could not be scanned for malware/);

  const finalAudit = await withTenant(TENANT_A, (tx) =>
    tx.query<{ resource_id: string | null; after: { reason?: string } }>(
      "SELECT resource_id, after FROM audit_logs WHERE action = 'document.download_blocked' ORDER BY created_at"
    )
  );
  assert.deepEqual(finalAudit.rows.map((row) => row.after.reason), [
    "malware_scan_pending",
    "storage_version_unavailable",
    "malware_scan_infected",
    "malware_scan_error",
  ]);
  assert.equal(finalAudit.rows.some((row) => row.resource_id === DOCUMENT_B), false);
});

test("clean document download signs the exact scanned S3 version and audits issuance", async () => {
  await withTenant(TENANT_A, async (tx) => {
    await tx.query(
      "UPDATE documents SET malware_scan_status = 'clean', s3_version_id = 'scanned-version-1' WHERE id = $1",
      [DOCUMENT_A]
    );
  });
  let signed: { bucket: string; key: string; versionId?: string | null } | null = null;
  const url = await getDocumentDownloadUrl(TENANT_A, DOCUMENT_A, "user_a", {
    runTenant: pgliteTenant,
    signDownload: async (input) => {
      signed = input;
      return "https://private-storage.example.test/signed-download";
    },
  });
  assert.equal(url, "https://private-storage.example.test/signed-download");
  assert.deepEqual(signed, { bucket: "private-test", key: "a/key", versionId: "scanned-version-1" });
  const audit = await withTenant(TENANT_A, (tx) => tx.query<{ resource_id: string; after: { version: number; expiresInSeconds: number } }>(
    "SELECT resource_id, after FROM audit_logs WHERE action = 'document.download' AND resource_id = $1",
    [DOCUMENT_A]
  ));
  assert.deepEqual(audit.rows, [{
    resource_id: DOCUMENT_A,
    after: { matterId: MATTER_A, version: 1, expiresInSeconds: 300 },
  }]);
});

test("Firm A cannot create a row owned by Firm B", async () => {
  await assert.rejects(
    () => withTenant(TENANT_A, (tx) =>
      tx.query("INSERT INTO clients (tenant_id, full_name) VALUES ($1, $2)", [TENANT_B, "Unauthorized Client"])
    ),
    /row-level security/i
  );
});

test("tenant-aware foreign keys block cross-firm relationships even in service context", async () => {
  await assert.rejects(
    () => withServiceSetting((tx) =>
      tx.query(
        "INSERT INTO matter_parties (tenant_id, matter_id, client_id, role) VALUES ($1, $2, $3, 'petitioner')",
        [TENANT_A, MATTER_A, CLIENT_B]
      )
    ),
    /matter_parties_tenant_client_fk/i
  );
  await assert.rejects(
    () => withServiceSetting((tx) =>
      tx.query(
        "INSERT INTO documents (tenant_id, matter_id, type, file_name, s3_key, s3_bucket, uploaded_by) VALUES ($1, $2, 'uploaded_evidence', 'cross.pdf', 'cross/key', 'private-test', 'user_a')",
        [TENANT_A, MATTER_B]
      )
    ),
    /documents_tenant_matter_fk/i
  );
  await assert.rejects(
    () => withServiceSetting((tx) =>
      tx.query(
        "INSERT INTO skill_runs (tenant_id, matter_id, skill_definition_id, skill_name, skill_version, input_snapshot, requested_by) VALUES ($1, $2, $3, 'test-skill', 1, '{}', 'user_a')",
        [TENANT_A, MATTER_B, SKILL_DEFINITION]
      )
    ),
    /skill_runs_tenant_matter_fk/i
  );
});

test("an unset tenant context returns no tenant-owned rows", async () => {
  const result = await pg.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE app_runtime");
    const clients = await tx.query<{ id: string }>("SELECT id FROM clients");
    return clients.rows;
  });
  assert.deepEqual(result, []);
});

test("worker failure recovery is tenant-scoped and idempotent", async () => {
  const params = {
    tenantId: TENANT_A,
    skillRunId: RUN_A,
    fromStatuses: ["queued", "running"] as Array<"queued" | "running">,
    errorMessage: "Synthetic interrupted worker run.",
    actor: "worker_shutdown",
    reason: "worker_shutdown" as const,
  };
  assert.equal(await failUnfinishedSkillRun(params, pgliteTenant), true);
  assert.equal(await failUnfinishedSkillRun(params, pgliteTenant), false);
  assert.equal(await failUnfinishedSkillRun({ ...params, skillRunId: RUN_B }, pgliteTenant), false);

  const tenantA = await withTenant(TENANT_A, async (tx) => ({
    run: await tx.query<{ status: string; error_message: string }>("SELECT status, error_message FROM skill_runs WHERE id = $1", [RUN_A]),
    audit: await tx.query<{ count: number }>("SELECT count(*)::int AS count FROM audit_logs WHERE action = 'skill_run.failed' AND resource_id = $1", [RUN_A]),
  }));
  assert.deepEqual(tenantA.run.rows, [{ status: "failed", error_message: "Synthetic interrupted worker run." }]);
  assert.deepEqual(tenantA.audit.rows, [{ count: 1 }]);

  const tenantB = await withTenant(TENANT_B, (tx) => tx.query<{ status: string }>("SELECT status FROM skill_runs WHERE id = $1", [RUN_B]));
  assert.deepEqual(tenantB.rows, [{ status: "queued" }]);
});
