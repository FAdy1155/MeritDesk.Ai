import { authorizationServerMetadataResponse, metadataPreflight } from "@/services/connector/metadata";

// Clerk's authorization server metadata, repeated on this origin for MCP
// clients that look for it here (the 2025-03-26 authorization spec). Clerk
// is the authorization server; nothing here issues tokens. Public:
// src/proxy.ts lets it through.

export function GET(): Promise<Response> {
  return authorizationServerMetadataResponse();
}

export function OPTIONS(): Response {
  return metadataPreflight();
}
