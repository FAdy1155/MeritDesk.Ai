import { metadataPreflight, protectedResourceMetadataResponse } from "@/services/connector/metadata";

// RFC 9728 protected resource metadata for the connector at /api/mcp
// (src/services/connector/config.ts). Served at the path the MCP
// authorization spec derives from the endpoint's path and at the root
// well-known path; Claude and ChatGPT are pointed here by the 401's
// WWW-Authenticate header. Public: src/proxy.ts lets it through.

export function GET(request: Request): Response {
  return protectedResourceMetadataResponse(request);
}

export function OPTIONS(): Response {
  return metadataPreflight();
}
