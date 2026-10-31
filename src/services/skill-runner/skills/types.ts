import type { z } from "zod";
import type { ToolKey } from "../tool-keys";
import type { MatterCaseType } from "@/lib/matters/case-types";

// Type-only imports above on purpose: the matter page's client components
// import SKILL_CATEGORIES from here, and nothing in this file should pull
// zod (or anything else) into the client bundle.

export type SkillCategory = "asylum" | "eoir" | "uscis" | "general";
export type SkillKind = "review" | "build" | "research";

/** Anthropic-hosted tools the API runs itself (no app code executes them). */
export type ServerToolName = "web_search" | "web_fetch";

/**
 * A server tool a skill asks for: just the name for the defaults, or an
 * object to restrict it. Domains are bare hostnames without a scheme
 * ("state.gov" also covers "www.state.gov"); web_search entries may add a
 * path ("hrw.org/world-report"), web_fetch entries may not. Give
 * allowedDomains or blockedDomains, never both. maxUses caps calls per API
 * request (each loop turn is one request), not per run.
 */
export type ServerToolConfig =
  | ServerToolName
  | {
      name: ServerToolName;
      allowedDomains?: readonly string[];
      blockedDomains?: readonly string[];
      maxUses?: number;
      /** web_fetch only: approximate cap on the text kept from one fetched page (PDFs are not capped). */
      maxContentTokens?: number;
    };

/** Display order and headings for the skill buttons on the matter page. */
export const SKILL_CATEGORIES: { id: SkillCategory; label: string }[] = [
  { id: "asylum", label: "Asylum" },
  { id: "eoir", label: "EOIR and court" },
  { id: "uscis", label: "USCIS" },
  { id: "general", label: "General" },
];

/**
 * Everything the app needs to know about one skill, in one file
 * (src/services/skill-runner/skills/<name>.ts). The skill's instructions
 * themselves live in skills-content/<name>/SKILL.md; this is the app-side
 * contract around them. See docs/ADDING_A_SKILL.md.
 *
 * Skill modules must stay client-safe: import zod, ../tool-keys and types
 * only. Never import tools.ts, run.ts, the DB, or anything "server-only".
 */
export type SkillModule<TSchema extends z.ZodType = z.ZodType> = {
  /** Must equal the skills-content/<name>/ directory name. Kebab-case. */
  name: string;
  /** Run button text on the matter page, e.g. "Run packet review"; the run list shows it without a leading "Run". */
  label: string;
  category: SkillCategory;
  kind: SkillKind;
  /** One sentence, shown under the label in the skill picker and in the run form; it is how attorneys tell similar skills apart. */
  description: string;
  /**
   * The submit_report input schema. Mirrors the SKILL.md's own output /
   * report / deliverables section, item for item, in the same order.
   */
  outputSchema: TSchema;
  /**
   * Pulls the items that need the supervising attorney's attention out of
   * a validated report; stored on skill_runs.escalation_flags. Method
   * syntax (not an arrow property) on purpose, so a module typed with its
   * own schema still assigns to the widened AnySkillModule.
   */
  extractEscalationFlags(output: z.infer<TSchema>): string[];
  /** Extra tools beyond submit_report, by key. Order is the order the model sees them. */
  tools: readonly ToolKey[];
  /**
   * Server-side web tools (research skills): the API searches and fetches
   * itself, and the runner logs every URL they returned to the run's
   * verification log. See server-tools.ts for the defaults.
   */
  serverTools?: readonly ServerToolConfig[];
  /**
   * Output token cap for each model turn, thinking included. Default 64000;
   * at most 128000. Raise it for skills that pass a long document (a brief,
   * a declaration) to generate_document in one call.
   */
  maxTokens?: number;
  /**
   * Model requests per run before the runner gives up (each turn, tool
   * round trip, and pause_turn continuation is one). Default 12; at most 40.
   */
  maxIterations?: number;
  /** Show the case note box in this skill's run form on the matter page. */
  needsNote?: boolean;
  /** "Case note for <label> (optional): <what to include>." The run form shows the part after the colon as help text above the note box. Only meaningful with needsNote. */
  notePlaceholder?: string;
  /**
   * Matter case types this skill is built for. Omit for skills that apply
   * to any matter. The matter page lists these skills first and the rest
   * under Other skills; it never blocks a run.
   */
  applicableCaseTypes?: readonly MatterCaseType[];
};

/** A skill module with its schema widened, for code that handles any skill. */
export type AnySkillModule = SkillModule<z.ZodType>;

/**
 * Identity helper that keeps `name` as a string literal type (so
 * SupportedSkillName in ./index.ts is a union of the registered names) and
 * types extractEscalationFlags' parameter from the module's own schema.
 */
export function defineSkill<const TName extends string, TSchema extends z.ZodType>(
  skill: SkillModule<TSchema> & { name: TName }
): SkillModule<TSchema> & { name: TName } {
  return skill;
}
