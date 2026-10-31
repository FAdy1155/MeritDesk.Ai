import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  computeAffectedSkills,
  courtOpinionKept,
  extractFormNumbers,
  NO_REFERENCE_FILE_GROUP_KEYS,
  ROUTING_TOPIC_KEYS,
  TARGET_REFERENCE_FILE_NAMES,
  type RoutingTopicKey,
} from "./routing";
import { clip, normalizeForMatch, toPlainCharacters, verifyPassages } from "./text";
import type { AffectedSkillBasis, DocumentQuote, LegalUpdateAnalysis } from "./types";

// What the app does with the summary step's output before anything is
// stored: passages checked against the quoted source text, the routing.md
// rules applied by code (affected skills, the other-circuit screen), notes
// against the firm's reference text checked against that text. Pure.

/** The summary step's structured output (Claude, structured outputs). */
export const summaryOutputSchema = z.object({
  scope: z.object({
    decision: z.enum(["keep", "screen_out"]),
    reason: z.string(),
  }),
  summary: z.string(),
  quotedPassages: z.array(z.string()),
  topics: z.array(z.enum(ROUTING_TOPIC_KEYS)),
  alsoMattersTo: z.array(z.object({ group: z.enum(NO_REFERENCE_FILE_GROUP_KEYS), reason: z.string() })),
  checkAgainstFirmText: z.array(
    z.object({ file: z.enum(TARGET_REFERENCE_FILE_NAMES), heading: z.string(), note: z.string() })
  ),
  needsDecision: z.array(z.string()),
});
export type SummaryOutput = z.infer<typeof summaryOutputSchema>;

/**
 * The response JSON as a SummaryOutput, or null when it is not one. The
 * SDK's structured-output helper sends the enums as descriptions, so the
 * API does not enforce them: a topic, group or file the model made up is
 * dropped here (it can only narrow routing), while a missing or invalid
 * summary, scope or passage list still fails the item.
 */
export function parseSummaryOutput(json: unknown): SummaryOutput | null {
  if (!json || typeof json !== "object") return null;
  const raw = json as Record<string, unknown>;
  const keep = <T>(value: unknown, ok: (v: T) => boolean): unknown =>
    Array.isArray(value) ? (value as T[]).filter((v) => ok(v)) : value;
  const topics = new Set<string>(ROUTING_TOPIC_KEYS);
  const groups = new Set<string>(NO_REFERENCE_FILE_GROUP_KEYS);
  const files = new Set<string>(TARGET_REFERENCE_FILE_NAMES);
  const cleaned = {
    ...raw,
    topics: keep<string>(raw.topics, (t) => topics.has(t)),
    alsoMattersTo: keep<{ group?: string }>(raw.alsoMattersTo, (g) => typeof g?.group === "string" && groups.has(g.group)),
    checkAgainstFirmText: keep<{ file?: string }>(raw.checkAgainstFirmText, (c) => typeof c?.file === "string" && files.has(c.file)),
  };
  const parsed = summaryOutputSchema.safeParse(cleaned);
  return parsed.success ? parsed.data : null;
}

const MAX_SUMMARY_CHARS = 1200;
const RECENT_UPDATES_HEADING = /^#+\s*Recent updates\b/i;

function headingKey(line: string): string {
  return normalizeForMatch(line.replace(/^#+/, "")).toLowerCase();
}

/**
 * The heading lines of a reference file above its "Recent updates" heading:
 * the firm's curated text. Entries the plugin's weekly update appended are
 * not curated text and cannot be the section an item is checked against.
 */
export function curatedHeadings(fileText: string): Set<string> {
  const out = new Set<string>();
  for (const line of fileText.split(/\r?\n/)) {
    if (!/^#{1,6}\s/.test(line)) continue;
    if (RECENT_UPDATES_HEADING.test(line)) break;
    out.add(headingKey(line));
  }
  return out;
}

export type SummaryDecision = {
  status: "published" | "screened" | "summary_failed";
  statusReason: string | null;
  summary: string;
  topics: RoutingTopicKey[];
  affectedSkills: string[];
  analysis: Omit<LegalUpdateAnalysis, "document" | "modelsServed">;
};

export function applySummaryRules(params: {
  item: { itemType: string; circuit: string | null; rawExcerpt: string; title: string };
  documentQuotes: readonly DocumentQuote[];
  output: SummaryOutput;
  /** Reference file name (TARGET_REFERENCE_FILES key) -> its text. */
  targetFiles: ReadonlyMap<string, string>;
  formIndex: ReadonlyMap<string, readonly string[]>;
  registeredSkills: ReadonlySet<string>;
}): SummaryDecision {
  const { item, output } = params;
  const isCourt = item.itemType === "Court of appeals published opinion";
  const sourceTexts = [item.rawExcerpt, ...params.documentQuotes.map((q) => q.text)];
  const { verified, rejected } = verifyPassages(output.quotedPassages, sourceTexts);
  const topics = [...new Set(output.topics)];

  const checkAgainstFirmText = output.checkAgainstFirmText
    .filter((c) => {
      const text = params.targetFiles.get(c.file);
      return text !== undefined && curatedHeadings(text).has(headingKey(c.heading));
    })
    .map((c) => ({ file: c.file, heading: c.heading.trim(), note: toPlainCharacters(c.note) }));

  const formNumbers = isCourt ? [] : extractFormNumbers(sourceTexts.join("\n"));
  const affected: { skills: string[]; bases: AffectedSkillBasis[] } = computeAffectedSkills({
    topics,
    groups: output.alsoMattersTo.map((g) => ({ group: g.group, reason: toPlainCharacters(g.reason) })),
    formNumbers,
    formIndex: params.formIndex,
    registeredSkills: params.registeredSkills,
  });

  const analysis: SummaryDecision["analysis"] = {
    verifiedPassages: verified,
    rejectedPassages: rejected,
    affectedSkillBases: affected.bases,
    checkAgainstFirmText,
    needsDecision: output.needsDecision.map(toPlainCharacters).filter(Boolean),
    scope: { decision: output.scope.decision, reason: toPlainCharacters(output.scope.reason) },
  };
  const summary = clip(toPlainCharacters(output.summary), MAX_SUMMARY_CHARS);
  const base = { summary, topics, affectedSkills: affected.skills, analysis };

  if (output.scope.decision === "screen_out") {
    return { ...base, status: "screened", statusReason: `Screened out under sources.md: ${analysis.scope.reason}` };
  }
  if (isCourt && item.circuit && !courtOpinionKept(item.circuit, topics)) {
    return {
      ...base,
      status: "screened",
      statusReason:
        "Another circuit's opinion outside the topics routing.md keeps for other circuits (asylum, withholding of removal, CAT, motions, Immigration Court or BIA procedure).",
    };
  }
  if (verified.length === 0) {
    return {
      ...base,
      status: "summary_failed",
      statusReason: "The summary could not be tied to the quoted source text, so it was not published. Read the official text.",
    };
  }
  if (!summary) {
    return { ...base, status: "summary_failed", statusReason: "No summary was produced. Read the official text." };
  }
  return { ...base, status: "published", statusReason: null };
}

// --- Document quotations (the citation step) ---------------------------------

export const MAX_DOCUMENT_QUOTES = 12;
const MAX_QUOTE_CHARS = 3_000;

/** Text blocks of a response after its last fallback block (the model that finished the answer). */
export function finalTextBlocks(message: Anthropic.Beta.BetaMessage): Anthropic.Beta.BetaTextBlock[] {
  let start = 0;
  message.content.forEach((block, i) => {
    if (block.type === "fallback") start = i + 1;
  });
  return message.content.slice(start).filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text");
}

const KNOWN_LABELS = /^(Publication|Under review|Holding|Disposition|Subject|Operative|Effective date|Cancels)\b/i;

/** The cited passages of a quote response, labeled by the uncited label text before each. */
export function quotesFromMessage(message: Anthropic.Beta.BetaMessage): DocumentQuote[] {
  const quotes: DocumentQuote[] = [];
  let label = "";
  for (const block of finalTextBlocks(message)) {
    const cited = (block.citations ?? []).filter(
      (c): c is Anthropic.Beta.BetaCitationPageLocation => c.type === "page_location"
    );
    if (cited.length === 0) {
      const lines = block.text.split("\n").map((l) => l.trim()).filter(Boolean);
      const last = lines[lines.length - 1] ?? "";
      const known = KNOWN_LABELS.exec(last.replace(/^[-*\s]+/, ""));
      if (known) label = known[1];
      continue;
    }
    for (const c of cited) {
      const text = c.cited_text.replace(/\s+/g, " ").trim();
      if (!text || text.length > MAX_QUOTE_CHARS || quotes.some((q) => q.text === text)) continue;
      const start = c.start_page_number;
      // The API's end page is exclusive.
      const end = Math.max(start, c.end_page_number - 1);
      quotes.push({ label, text, startPage: start, endPage: end });
      if (quotes.length >= MAX_DOCUMENT_QUOTES) return quotes;
    }
  }
  return quotes;
}

