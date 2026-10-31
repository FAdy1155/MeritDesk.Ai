import "server-only";
import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { ServerToolConfig, ServerToolName } from "./skills/types";
import type { VerificationLogEntry } from "./verification-log";

type BetaContentBlock = Anthropic.Beta.BetaContentBlock;
type BetaToolUnion = Anthropic.Beta.BetaToolUnion;

// Anthropic-hosted web search and web fetch (research skills). The API runs
// both inside its own server-side loop, so there is nothing to execute here:
// this module builds their definitions from a skill module's `serverTools`
// and reads their result blocks back out of each response, so the run's
// verification log lists every URL the model was really given, written by
// the app and not claimed by the model.
//
// Versions: web_search_20260209 / web_fetch_20260209 (the claude-api skill's
// current types for this model). Their default "dynamic filtering" runs the
// results through Anthropic-hosted code execution first, which is not
// eligible for Zero Data Retention; this app handles asylum narratives and
// the README asks firms to apply for ZDR, so both tools are pinned to direct
// calls (allowed_callers ["direct"]), the ZDR-eligible configuration. The
// cost is that a fetched page reaches the model unfiltered, which is what
// DEFAULT_FETCH_MAX_CONTENT_TOKENS bounds.
//
// Web search must not be disabled for the organization in the Claude
// Console; a domain list here must be a subset of any organization-level
// allowed list (the API rejects it otherwise).
//
// web_fetch always has an allow list: every matter skill has the client's
// case file in context, and an open fetch would let instructions planted in
// a document send case details to any site through the URLs it opens (see
// fetch-domains.ts). normalizeServerTools refuses a web_fetch without one.

const WEB_SEARCH_TYPE = "web_search_20260209" as const;
const WEB_FETCH_TYPE = "web_fetch_20260209" as const;
const DIRECT_ONLY: ["direct"] = ["direct"];

// Per API request (each loop turn and pause_turn continuation is one), not per run.
const DEFAULT_SEARCH_MAX_USES = 8;
const DEFAULT_FETCH_MAX_USES = 8;
// About 120 KB of page text. A whole State Department country report is
// longer; the cut is approximate and never applies to PDFs.
const DEFAULT_FETCH_MAX_CONTENT_TOKENS = 30_000;

type NormalizedServerTool = {
  name: ServerToolName;
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxUses: number;
  maxContentTokens?: number;
};

// A bare hostname (ASCII only, so a look-alike Unicode domain cannot slip
// through), optionally followed by a path for web_search. No scheme, no
// wildcard in the host, no port.
const DOMAIN_ENTRY = /^(?=.{1,253}(\/|$))([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(\/[\x21-\x7e]*)?$/;

/**
 * Checks and fills in defaults for a skill module's serverTools. Throws a
 * message naming the skill and the bad entry, so a misconfigured module
 * fails its first run (and the registry probe) instead of sending a request
 * the API would reject.
 */
export function normalizeServerTools(skillName: string, configs: readonly ServerToolConfig[] | undefined): NormalizedServerTool[] {
  const seen = new Set<ServerToolName>();
  return (configs ?? []).map((config) => {
    const c = typeof config === "string" ? { name: config } : config;
    const where = `Skill "${skillName}" serverTools entry "${c.name}"`;
    if (c.name !== "web_search" && c.name !== "web_fetch") throw new Error(`${where}: unknown server tool`);
    if (seen.has(c.name)) throw new Error(`${where}: listed twice`);
    seen.add(c.name);
    if (c.allowedDomains && c.blockedDomains) throw new Error(`${where}: give allowedDomains or blockedDomains, not both`);
    if (c.name === "web_fetch" && !c.allowedDomains?.length) {
      throw new Error(
        `${where}: web_fetch needs allowedDomains (a list from fetch-domains.ts, or the sources the SKILL.md names), since the run has the client's documents in context`
      );
    }
    for (const domain of [...(c.allowedDomains ?? []), ...(c.blockedDomains ?? [])]) {
      if (!DOMAIN_ENTRY.test(domain)) {
        throw new Error(`${where}: "${domain}" is not a bare lowercase hostname (no scheme, port, or wildcard host)`);
      }
      if (c.name === "web_fetch" && domain.includes("/")) {
        throw new Error(`${where}: web_fetch domain "${domain}" has a path; web_fetch matches on the domain only`);
      }
    }
    const maxUses = c.maxUses ?? (c.name === "web_search" ? DEFAULT_SEARCH_MAX_USES : DEFAULT_FETCH_MAX_USES);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 50) throw new Error(`${where}: maxUses must be 1-50`);
    if (c.maxContentTokens !== undefined && c.name !== "web_fetch") {
      throw new Error(`${where}: maxContentTokens applies to web_fetch only`);
    }
    const maxContentTokens = c.name === "web_fetch" ? (c.maxContentTokens ?? DEFAULT_FETCH_MAX_CONTENT_TOKENS) : undefined;
    if (maxContentTokens !== undefined && (!Number.isInteger(maxContentTokens) || maxContentTokens < 1_000 || maxContentTokens > 200_000)) {
      throw new Error(`${where}: maxContentTokens must be 1000-200000`);
    }
    return {
      name: c.name,
      allowedDomains: c.allowedDomains ? [...c.allowedDomains] : undefined,
      blockedDomains: c.blockedDomains ? [...c.blockedDomains] : undefined,
      maxUses,
      maxContentTokens,
    };
  });
}

/** The tools-array entries for a skill's server tools, in the module's order (stable, for prompt caching). */
export function buildServerToolDefinitions(tools: NormalizedServerTool[]): BetaToolUnion[] {
  return tools.map((t): BetaToolUnion => {
    const domains = {
      ...(t.allowedDomains ? { allowed_domains: t.allowedDomains } : {}),
      ...(t.blockedDomains ? { blocked_domains: t.blockedDomains } : {}),
    };
    if (t.name === "web_search") {
      return { type: WEB_SEARCH_TYPE, name: "web_search", allowed_callers: DIRECT_ONLY, max_uses: t.maxUses, ...domains };
    }
    return {
      type: WEB_FETCH_TYPE,
      name: "web_fetch",
      allowed_callers: DIRECT_ONLY,
      max_uses: t.maxUses,
      max_content_tokens: t.maxContentTokens,
      ...domains,
    };
  });
}

/**
 * Reads web_search / web_fetch results out of each response and appends
 * them to the run's verification log. Keeps every server_tool_use input it
 * has seen, because a result can arrive in a later response than its call
 * (a turn that mixed server and client tools, or a pause_turn).
 */
export class ServerToolSourceRecorder {
  private readonly calls = new Map<string, { name: string; input: Record<string, unknown> }>();

  constructor(private readonly log: VerificationLogEntry[]) {}

  record(content: BetaContentBlock[], receivedAt: Date): void {
    const at = receivedAt.toISOString();
    for (const block of content) {
      if (block.type === "server_tool_use") {
        this.calls.set(block.id, { name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
      }
    }
    for (const block of content) {
      if (block.type === "web_search_tool_result") {
        const query = stringField(this.calls.get(block.tool_use_id)?.input, "query");
        if (Array.isArray(block.content)) {
          for (const result of block.content) {
            this.log.push({
              source: "web_search",
              url: result.url,
              fetchedAt: at,
              status: "ok",
              title: result.title ?? null,
              pageAge: result.page_age ?? null,
              query,
            });
          }
        } else {
          this.log.push({ source: "web_search", url: "", fetchedAt: at, status: block.content.error_code, query });
        }
      } else if (block.type === "web_fetch_tool_result") {
        const requested = stringField(this.calls.get(block.tool_use_id)?.input, "url");
        const result = block.content;
        if (result.type === "web_fetch_result") {
          const source = result.content.source;
          this.log.push({
            source: "web_fetch",
            url: result.url,
            fetchedAt: result.retrieved_at ?? at,
            status: "ok",
            title: result.content.title ?? null,
            contentHash: crypto.createHash("sha256").update(source.data).digest("hex").slice(0, 16),
          });
        } else {
          this.log.push({
            source: "web_fetch",
            url: requested ?? "",
            fetchedAt: at,
            status: result.error_code,
            query: requested,
          });
        }
      }
    }
  }
}

function stringField(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Server tool calls in this content that have no result block yet. The API
 * runs them at the start of the next request; until then the follow-up user
 * message may hold nothing but tool_result blocks (any other block ends the
 * turn and the request is rejected).
 */
export function hasPendingServerToolUse(content: readonly BetaContentBlock[]): boolean {
  const answered = new Set<string>();
  for (const block of content) {
    if ("tool_use_id" in block && typeof block.tool_use_id === "string") answered.add(block.tool_use_id);
  }
  return content.some((block) => block.type === "server_tool_use" && !answered.has(block.id));
}

/**
 * The assistant turn as it must be echoed back after a server-side refusal
 * fallback switched models mid-turn (the claude-api skill's echo rule):
 * before the last `fallback` block, drop thinking, redacted_thinking and
 * client tool_use blocks, and server_tool_use blocks without their result;
 * keep text, paired server-tool blocks, the fallback marker itself, and
 * everything after it. Content without a fallback block is returned as is.
 * The dropped tool_use blocks belong to the declined attempt and must never
 * be executed, so the runner reads tool calls from this sanitized content.
 */
export function sanitizeFallbackContent(content: BetaContentBlock[]): BetaContentBlock[] {
  let boundary = -1;
  content.forEach((block, i) => {
    if (block.type === "fallback") boundary = i;
  });
  if (boundary === -1) return content;
  const before = content.slice(0, boundary);
  const answered = new Set<string>();
  for (const block of content) {
    if ("tool_use_id" in block && typeof block.tool_use_id === "string") answered.add(block.tool_use_id);
  }
  const kept = before.filter((block) => {
    if (block.type === "thinking" || block.type === "redacted_thinking" || block.type === "tool_use") return false;
    if (block.type === "server_tool_use") return answered.has(block.id);
    return true;
  });
  return [...kept, ...content.slice(boundary)];
}

/** Server tool requests the API billed in one response (web search is charged per search). */
export function serverToolUsage(message: Anthropic.Beta.BetaMessage): { webSearch: number; webFetch: number } {
  const use = message.usage.server_tool_use;
  return { webSearch: use?.web_search_requests ?? 0, webFetch: use?.web_fetch_requests ?? 0 };
}
