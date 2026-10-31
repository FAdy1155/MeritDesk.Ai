import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { lockedReasonText, type Entitlement } from "@/lib/billing/entitlement";
import { capText, MAX_RESULT_CHARS } from "../framing";

// The shapes every connector tool returns: plain text the app wrote (with
// any quoted data already framed by ../framing.ts), or an error the caller
// can act on. MCP tool errors are results with isError, so the calling model
// sees the message; protocol errors are kept for malformed requests.

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text: capText(text, MAX_RESULT_CHARS).text }] };
}

/** Why a case-work tool is refused to a client that is not on the allow list. */
export function unrecognizedClientMessage(clientId: string): string {
  return `The case-work tools are not available through this connection: the app or client it was made from (OAuth client id ${clientId}) is not on this platform's list of recognized Claude and ChatGPT clients, so only the library tools work. The firm's owner/admin can see this client id on the app's Firm page; the platform's operator decides whether to recognize it.`;
}

/** Why every tool but get_connection_info is refused while the firm is locked, and where to subscribe (never here). */
export function lockedFirmMessage(entitlement: Entitlement, billingUrl: string): string {
  return `MeritDesk.AI is locked for this firm (${entitlement.state}: ${lockedReasonText(entitlement)}). The tools are unavailable until the firm's owner subscribes on the website's Billing page: ${billingUrl}. Payment happens only there, never in this conversation.`;
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * A result with structuredContent (the tool declares an outputSchema) and
 * the same object as JSON text, which is the shape ChatGPT's search and
 * fetch expect (developers.openai.com/api/docs/mcp) and what clients
 * without structured output read.
 */
export function structuredResult<T extends Record<string, unknown>>(value: T): CallToolResult {
  return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
}
