import "server-only";
import { withGlobalReadContext } from "@/db/client";
import { readEntitlement } from "@/lib/billing/entitlement";
import { getConnectorSettings } from "@/lib/connector/settings";
import {
  getMatterCaseTypeForConnector,
  getMatterForConnector,
  getSkillRunForConnector,
  listLegalUpdatesForConnector,
  listMattersForConnector,
  recordConnectorCallOutcome,
} from "@/lib/connector/case-work";
import { recordUnrecognizedConnectorClient } from "@/lib/connector/unrecognized-clients";
import { getDocumentDownloadUrl } from "@/lib/documents/service";
import { getEoirJudgeProfile, queryEoirStats, searchEoirJudges } from "@/services/library/adapters/eoir-statistics/service";
import { LIBRARY_SEARCH_TIMEOUT_MS, lookupCitation, readDocument, searchLibrary } from "@/services/library/search";
import { enqueueSkillRun } from "@/services/skill-runner/run";
import { takeRateLimitTokens } from "./rate-limit";
import type { ConnectorDeps } from "./types";

// The real implementations behind the connector's tools: the library in
// read-only global transactions (as the /library pages and the skill runs'
// library tools read it), tenant data through withTenantContext.
export const defaultConnectorDeps: ConnectorDeps = {
  settings: getConnectorSettings,
  entitlement: (tenantId) => readEntitlement(tenantId),
  rateLimit: takeRateLimitTokens,
  recordUnrecognizedClient: (tenantId, clientId, userId) => recordUnrecognizedConnectorClient(tenantId, clientId, userId),
  library: {
    search: (params) => withGlobalReadContext((tx) => searchLibrary(tx, params), { statementTimeoutMs: LIBRARY_SEARCH_TIMEOUT_MS }),
    read: (id, offset, length) => withGlobalReadContext((tx) => readDocument(tx, id, offset, length)),
    lookup: (citation) => withGlobalReadContext((tx) => lookupCitation(tx, citation)),
    eoirSearchJudges: searchEoirJudges,
    eoirJudgeProfile: getEoirJudgeProfile,
    eoirQuery: queryEoirStats,
  },
  caseWork: {
    listMatters: listMattersForConnector,
    getMatter: getMatterForConnector,
    getMatterCaseType: getMatterCaseTypeForConnector,
    getSkillRun: getSkillRunForConnector,
    listLegalUpdates: listLegalUpdatesForConnector,
    recordOutcome: recordConnectorCallOutcome,
    enqueueSkillRun,
    documentDownloadUrl: getDocumentDownloadUrl,
  },
};
