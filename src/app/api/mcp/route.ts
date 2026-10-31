import { clerkConnectorAuthenticator } from "@/services/connector/clerk-auth";
import { defaultConnectorDeps } from "@/services/connector/deps";
import { handleConnectorRequest } from "@/services/connector/http";

// The connector: one remote MCP server (Streamable HTTP, stateless) for
// Claude and ChatGPT, authenticated with Clerk-issued OAuth access tokens.
// src/proxy.ts lets requests through to here without a session; this handler
// authenticates every one itself (src/services/connector/http.ts).
// docs/CONNECTORS.md describes the tools, setup and limits.

// Claude allows a tool call up to 240 seconds; no tool here needs more than a few.
export const maxDuration = 60;

function handler(request: Request): Promise<Response> {
  return handleConnectorRequest(request, { authenticate: clerkConnectorAuthenticator, deps: defaultConnectorDeps });
}

export { handler as GET, handler as POST, handler as DELETE };
