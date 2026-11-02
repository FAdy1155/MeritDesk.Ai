import type { z } from "zod";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Entitlement } from "@/lib/billing/entitlement";
import type { ConnectorSettingsView } from "@/lib/connector/settings";
import type { MembershipRole } from "@/lib/roles";
import type { RateLimitResult, RateLimitRule } from "./rate-limit";
import type * as caseWork from "@/lib/connector/case-work";
import type { getDocumentDownloadUrl } from "@/lib/documents/service";
import type { enqueueSkillRun } from "@/services/skill-runner/run";
import type { CitationLookupResult, LibraryDocumentView, LibrarySearchParams, LibrarySearchResult } from "@/services/library/search";
import type { getEoirJudgeProfile, queryEoirStats, searchEoirJudges } from "@/services/library/adapters/eoir-statistics/service";

// Shared shapes of the connector (the remote MCP server at /api/mcp). Types
// only, so the HTTP handler and the in-process check script can use them
// without loading Clerk or the database.

/** Who an access token belongs to, resolved the way the web app resolves a session (resolveTenantMembership). */
export type ConnectorIdentity = {
  userId: string;
  /** The OAuth client the token was issued to (Claude's or ChatGPT's registration with Clerk). */
  oauthClientId: string;
  /**
   * The client is on the platform's allow list (CONNECTOR_ALLOWED_CLIENT_IDS or
   * CONNECTOR_ALLOWED_CLIENT_ID_PREFIXES, src/services/connector/config.ts).
   * Only then are the case-work tools offered; any client gets the library tools.
   */
  clientAllowed: boolean;
  scopes: string[];
  tenantId: string;
  tenantName: string;
  /** The user's role in the firm now, as requireRole reads it in the web app: owner_admin for Clerk's Admin, else the app role stored for the member. */
  role: MembershipRole;
};

/**
 * A request the connector refuses before any MCP message is read: 401 for a
 * missing, invalid or expired token (the client then runs OAuth again), 403
 * for a valid token that cannot be used (no firm chosen, the firm is not set
 * up in the app, the user is no longer a member).
 */
export class ConnectorAuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: "invalid_token" | "insufficient_scope" | "access_denied",
    readonly description: string
  ) {
    super(description);
    this.name = "ConnectorAuthError";
  }
}

/**
 * Resolves a request's access token to its identity. `fresh` skips every
 * cache (the member's roles, the user's status, the token's revocation
 * state): the tools that change something or hand out a document ask for it.
 */
export type ConnectorAuthenticator = (request: Request, options?: { fresh?: boolean }) => Promise<ConnectorIdentity>;

/**
 * Everything the tools read and write, injected so the in-process check
 * (docs/CONNECTORS.md, "What was tested") can run the real MCP server and
 * tools against stubs. src/services/connector/deps.ts has the real ones.
 */
export type ConnectorDeps = {
  settings: (tenantId: string) => Promise<ConnectorSettingsView>;
  /** The firm's billing state (src/lib/billing/entitlement.ts): a locked firm gets get_connection_info only. */
  entitlement: (tenantId: string) => Promise<Entitlement>;
  rateLimit: (tenantId: string, rules: RateLimitRule[]) => Promise<RateLimitResult>;
  /** Notes a token from a client not on the allow list, for the Firm page (src/lib/connector/unrecognized-clients.ts). */
  recordUnrecognizedClient: (tenantId: string, clientId: string, userId: string) => Promise<void>;
  library: {
    search: (params: LibrarySearchParams) => Promise<LibrarySearchResult>;
    read: (id: string, offset: number, length: number) => Promise<LibraryDocumentView | null>;
    lookup: (citation: string) => Promise<CitationLookupResult>;
    eoirSearchJudges: typeof searchEoirJudges;
    eoirJudgeProfile: typeof getEoirJudgeProfile;
    eoirQuery: typeof queryEoirStats;
  };
  caseWork: {
    listClients: typeof caseWork.listClientsForConnector;
    createClient: typeof caseWork.createClientForConnector;
    createMatter: typeof caseWork.createMatterForConnector;
    addMatterParty: typeof caseWork.addMatterPartyForConnector;
    listMatters: typeof caseWork.listMattersForConnector;
    getMatter: typeof caseWork.getMatterForConnector;
    getMatterCaseType: typeof caseWork.getMatterCaseTypeForConnector;
    getSkillRun: typeof caseWork.getSkillRunForConnector;
    listLegalUpdates: typeof caseWork.listLegalUpdatesForConnector;
    recordOutcome: typeof caseWork.recordConnectorCallOutcome;
    enqueueSkillRun: typeof enqueueSkillRun;
    documentDownloadUrl: typeof getDocumentDownloadUrl;
  };
};

export type ConnectorToolContext = {
  identity: ConnectorIdentity;
  settings: ConnectorSettingsView;
  /** Whether the firm's free month or subscription allows the tools now; read once per request. */
  entitlement: Entitlement;
  /** <public origin>/billing: where the firm subscribes (payment never happens inside Claude). */
  billingUrl: string;
  deps: ConnectorDeps;
  /** The same request authenticated again with no cache (ConnectorAuthenticator's fresh option). */
  reauthenticate: () => Promise<ConnectorIdentity>;
};

export type ConnectorToolGroup = "account" | "library" | "case_work";

export type ConnectorTool = {
  name: string;
  title: string;
  description: string;
  group: ConnectorToolGroup;
  inputSchema: z.ZodObject;
  outputSchema?: z.ZodObject;
  annotations: Omit<ToolAnnotations, "title">;
  /** Beyond its group's switch: whether this caller may see and call it (role, the download setting). */
  availableTo?: (ctx: ConnectorToolContext) => boolean;
  /**
   * Re-check the caller with Clerk, skipping the 60-second role cache, before
   * running: for the tools that change something or hand out a document.
   */
  freshIdentity?: boolean;
  /** Rate limits on top of the per-call ones (run_skill). */
  extraRateRules?: (identity: ConnectorIdentity) => RateLimitRule[];
  /** Runs with input already validated against inputSchema. */
  run: (input: unknown, ctx: ConnectorToolContext) => Promise<CallToolResult>;
};

/** A tool whose run receives its schema's parsed type. */
export function defineConnectorTool<S extends z.ZodObject>(tool: Omit<ConnectorTool, "inputSchema" | "run"> & {
  inputSchema: S;
  run: (input: z.infer<S>, ctx: ConnectorToolContext) => Promise<CallToolResult>;
}): ConnectorTool {
  return tool as unknown as ConnectorTool;
}
