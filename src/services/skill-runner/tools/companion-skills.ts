import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { withTenantContext } from "@/db/client";
import { skillDefinitions, skillRuns } from "@/db/schema";
import { computeSkillContentHash, loadBundledReferences, type ReferenceFile } from "../skill-content";
// Types only: tools.ts imports the modules that import this one.
import type { SkillTool, ToolExecutionContext } from "../tools";

// Another firm skill's instructions, loaded into a run. Several firm build
// skills run a second firm skill as one of their steps: a QA gate over their
// own output (asylum-interview-prep-build: "Then run the QA gate. Hand your
// own output to asylum-interview-prep-review and include its report";
// i90-packet-build's SECTION 8; vawa-packet-build's Step 10), or a companion
// for one build step (packet-build's Build order). In the plugin, invoking a
// skill loads its SKILL.md into the conversation. A run here has one skill
// version's SKILL.md and references as its system prompt, so these tools are
// that step: they return the other skill's instructions as seeded (its
// latest skill_definitions version, the same text a separate run of it would
// send), and the model performs the step under them in the same run and puts
// the result in its own submit_report payload.
//
// Nothing here runs the other skill: the model does, with that skill's text
// in front of it. The tools only supply the text, with the few lines that map
// its "ask first" questions and its output onto this run.

// JSON around the tool result in every later request, on top of the text.
const RESULT_JSON_OVERHEAD_BYTES = 200;

const noInputSchema = z.object({});

type CompanionDefinition = {
  version: number;
  contentHash: string;
  skillMarkdown: string;
  referenceFiles: unknown;
};

/** skill_definitions.reference_files as stored (jsonb), or null when absent or malformed. */
function readReferenceFiles(value: unknown): ReferenceFile[] | null {
  if (!Array.isArray(value)) return null;
  const files = value.filter(
    (f): f is ReferenceFile =>
      typeof f === "object" &&
      f !== null &&
      typeof (f as ReferenceFile).path === "string" &&
      typeof (f as ReferenceFile).content === "string"
  );
  return files.length === value.length ? files : null;
}

/**
 * The companion skill's latest seeded version, and the references of the
 * version this run is executing (null outside a stored run, or for a version
 * seeded before references were stored), so references the two skills share
 * word for word are not sent twice.
 */
async function loadCompanionDefinition(
  ctx: ToolExecutionContext,
  companionSkill: string
): Promise<{ companion: CompanionDefinition | null; ownReferences: ReferenceFile[] | null }> {
  return withTenantContext(ctx.tenantId, async (tx) => {
    // skill_definitions is global (no tenant_id); skill_runs is tenant data.
    const [companion] = await tx
      .select({
        version: skillDefinitions.version,
        contentHash: skillDefinitions.contentHash,
        skillMarkdown: skillDefinitions.skillMarkdown,
        referenceFiles: skillDefinitions.referenceFiles,
      })
      .from(skillDefinitions)
      .where(eq(skillDefinitions.name, companionSkill))
      .orderBy(desc(skillDefinitions.version))
      .limit(1);

    let ownReferences: ReferenceFile[] | null = null;
    if (ctx.skillRunId) {
      const [own] = await tx
        .select({ referenceFiles: skillDefinitions.referenceFiles })
        .from(skillRuns)
        .innerJoin(skillDefinitions, eq(skillDefinitions.id, skillRuns.skillDefinitionId))
        .where(and(eq(skillRuns.id, ctx.skillRunId), eq(skillRuns.tenantId, ctx.tenantId)))
        .limit(1);
      ownReferences = readReferenceFiles(own?.referenceFiles);
    }
    return { companion: companion ?? null, ownReferences };
  });
}

/**
 * The companion version's references: its stored copy, or, for a version
 * seeded before references were stored, the files on disk if they still hash
 * to that version's content_hash (the rule run.ts applies to a run's own
 * references). A string is an error for the model.
 */
async function companionReferences(
  companionSkill: string,
  companion: CompanionDefinition
): Promise<ReferenceFile[] | string> {
  const stored = readReferenceFiles(companion.referenceFiles);
  if (stored) return stored;
  const onDisk = await loadBundledReferences(companionSkill);
  if (computeSkillContentHash(companion.skillMarkdown, onDisk) !== companion.contentHash) {
    return (
      `The ${companionSkill} references on this worker differ from the ones its skill version ${companion.version} was seeded with, ` +
      "and that version does not store its own copy, so its instructions cannot be loaded consistently."
    );
  }
  return onDisk;
}

/**
 * One companion skill's instructions as a tool result: a header with its
 * version and the run notes under `heading`, its SKILL.md, then its
 * references (each one identical to this run's own is named, not resent).
 * Charges the text to ctx.requestBytes, since it stays in every later
 * request. `error` is the reason it could not be loaded, for the caller to
 * complete with what the model should do instead.
 */
export async function loadCompanionSkillText(
  ctx: ToolExecutionContext,
  params: { companionSkill: string; heading: string; notes: readonly string[] }
): Promise<{ content: string } | { error: string }> {
  const { companionSkill } = params;

  let loaded;
  try {
    loaded = await loadCompanionDefinition(ctx, companionSkill);
  } catch (err) {
    return { error: `Could not load the ${companionSkill} skill: ${err instanceof Error ? err.message : String(err)}.` };
  }
  const { companion, ownReferences } = loaded;
  if (!companion) {
    return {
      error: `The ${companionSkill} skill has no seeded version in this app's database (npm run db:seed-skills has not been run for it), so its instructions cannot be loaded.`,
    };
  }

  let references: ReferenceFile[] | string;
  try {
    references = await companionReferences(companionSkill, companion);
  } catch (err) {
    return {
      error: `Could not read the ${companionSkill} references: ${err instanceof Error ? err.message : String(err)}.`,
    };
  }
  if (typeof references === "string") return { error: references };

  const sections = [
    [
      `# ${companionSkill}/SKILL.md (skill version ${companion.version}, content hash ${companion.contentHash.slice(0, 12)})`,
      "",
      `## ${params.heading}`,
      "",
      ...params.notes.map((note) => `- ${note}`),
    ].join("\n"),
    companion.skillMarkdown,
  ];
  // Sorted by path, as the prompt orders a skill's own references.
  for (const ref of [...references].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const own = ownReferences?.find((r) => r.path === ref.path);
    sections.push(
      own && own.content === ref.content
        ? `# ${ref.path}\n\nIdentical, word for word, to your own ${ref.path}, which is already in your instructions; not repeated here.`
        : `# ${ref.path}\n\n${ref.content}`
    );
  }
  const content = sections.join("\n\n---\n\n");

  // The text stays in every later request of the run.
  const cost = JSON.stringify(content).length + RESULT_JSON_OVERHEAD_BYTES;
  if (ctx.requestBytes.used + cost > ctx.requestBytes.limit) {
    return {
      error: `The ${companionSkill} instructions do not fit: the conversation is too close to the API's request size limit.`,
    };
  }
  ctx.requestBytes.used += cost;
  return { content };
}

/**
 * Builds a "load the review skill" tool for a build skill whose SKILL.md
 * ends with a QA gate run by another firm skill. `runNotes` answer, for this
 * run, whatever the review skill asks to establish before it starts (a run
 * cannot stop to ask) and say where its report goes.
 */
export function createQaGateSkillTool(params: {
  /** The name the model sees and calls. */
  toolName: string;
  description: string;
  /** The review skill, by its skills-content/<name>/ directory name. */
  companionSkill: string;
  /** What not being able to load it means for the report; appended to every error. */
  unavailableInstruction: string;
  runNotes: readonly string[];
}): SkillTool {
  const { toolName, companionSkill, unavailableInstruction } = params;

  return {
    definition: {
      name: toolName,
      description: params.description,
      input_schema: { type: "object", properties: {} },
    },
    execute: async (input, ctx) => {
      const parsed = noInputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        return { content: `${toolName} takes no input; call it with an empty object.`, isError: true };
      }
      const result = await loadCompanionSkillText(ctx, {
        companionSkill,
        heading: "How to run this QA gate in this run",
        notes: params.runNotes,
      });
      if ("error" in result) return { content: `${result.error} ${unavailableInstruction}`, isError: true };
      return { content: result.content };
    },
  };
}
