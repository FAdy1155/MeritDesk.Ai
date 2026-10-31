import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { withTenantContext } from "@/db/client";
import { skillDefinitions } from "@/db/schema";
import { toJsonSchemaObject } from "../json-schema";
import { computeSkillContentHash, loadBundledReferences, type ReferenceFile } from "../skill-content";
// Types only: tools.ts imports this module for its registry.
import type { SkillTool, ToolExecutionContext } from "../tools";

// legal-argument-research's one client tool. Its only bundled reference,
// references/eoir-motions.md, has no motion-by-motion standards section yet
// and sends the model to four reference files of two other firm skills in
// the same plugin: "use the element structure in the motion-elements.md file
// of the eoir-motion-self-review Skill in this plugin as a cross check", and
// "Deadlines and filing mechanics for motions are in the icpm-mechanics.md
// file of eoir-motion-self-review and the icpm-checklist.md and
// bia-checklist.md files of eoir-filing-compliance". In the plugin the model
// opens those files; a run here has only this skill's own references in its
// prompt, so load_motion_references returns them.
//
// Only those reference files, never the other skills' SKILL.md: the model
// reads them as the cross-check eoir-motions.md describes and runs neither
// review (tools/companion-skills.ts loads a whole skill, for build skills
// that perform another skill as one of their steps). The version rule is
// companion-skills.ts's: each skill's latest seeded skill_definitions
// version, its stored reference_files, or, for a version seeded before those
// were stored, the files on disk if they still hash to that version's
// content_hash.

// JSON around the tool result in every later request, on top of the text.
const RESULT_JSON_OVERHEAD_BYTES = 200;

// The four files eoir-motions.md names, keyed as the model asks for them,
// with what each one cross-checks in this skill's report.
const MOTION_REFERENCES = {
  "eoir-motion-self-review/references/motion-elements.md": {
    skill: "eoir-motion-self-review",
    path: "references/motion-elements.md",
    use: "The element structure of each motion type, with its governing authority and the objections OPLA or the Judge will reach for first: a cross-check for governingStandard (what must be shown, anchor authority) and for strengthAssessment.governmentsLikelyCounter.",
  },
  "eoir-motion-self-review/references/icpm-mechanics.md": {
    skill: "eoir-motion-self-review",
    path: "references/icpm-mechanics.md",
    use: "Filing deadlines and filing mechanics for motions: a cross-check for governingStandard.deadlinesAndLimits.",
  },
  "eoir-filing-compliance/references/icpm-checklist.md": {
    skill: "eoir-filing-compliance",
    path: "references/icpm-checklist.md",
    use: "The Immigration Court Practice Manual checklist, including motion-specific deadlines, limits and contents: a cross-check for governingStandard.deadlinesAndLimits for a motion before the Immigration Judge.",
  },
  "eoir-filing-compliance/references/bia-checklist.md": {
    skill: "eoir-filing-compliance",
    path: "references/bia-checklist.md",
    use: "The BIA Practice Manual checklist, including motions to reopen and reconsider before the Board: a cross-check for governingStandard.deadlinesAndLimits for a motion before the BIA.",
  },
} as const;
type MotionReference = keyof typeof MOTION_REFERENCES;
const MOTION_REFERENCE_IDS = Object.keys(MOTION_REFERENCES) as [MotionReference, ...MotionReference[]];

const RUN_NOTES = [
  "These files belong to two other firm skills, eoir-motion-self-review and eoir-filing-compliance, which review a draft filing. Your references/eoir-motions.md points to them as a cross-check: read them for what the motion must show, the objections to expect, and its deadlines and limits. Do not run either skill's review or report its findings.",
  'Where a file speaks of "the draft", of "SKILL.md" or of its steps, it means that skill and its review, which is not loaded here. Read it as guidance on what the motion must show; any live verification it asks for is done in this run with web_search and web_fetch.',
  "Every authority they name is an unverified anchor, as their own cautions say: set verified to false for it until this run has read the authority's own text (retrieved in this run, or a copy among the matter's documents). The same holds for their Recent updates entries.",
  "Their deadline and fee figures are a framework to reason with, not confirmed current law. State a deadline or limit in governingStandard.deadlinesAndLimits as confirmed only when a source retrieved in this run supports it, and say so where it is not.",
  "Your SKILL.md's currency rule applies to them as it does to references/eoir-motions.md: where a source retrieved in this run differs from them, follow the retrieved source and report the area in verificationAndCurrencyNote.volatileAreasConfirmed.",
  "The controlling circuit is the one you established in the snapshot; nothing in these files changes it.",
];

const UNAVAILABLE_INSTRUCTION =
  "Take the standard, its elements and the deadlines from retrieved, verified research alone, as references/eoir-motions.md says to until its standards section is written, and say in governingStandard.deadlinesAndLimits which deadline or limit could not be confirmed from a source retrieved in this run.";

const loadMotionReferencesInputSchema = z.object({
  files: z
    .array(z.enum(MOTION_REFERENCE_IDS))
    .min(1)
    .describe("The reference files to load, as references/eoir-motions.md names them"),
});

// Files already returned in a run (keyed by the run's tool context), so a
// second call does not resend the same text with every request.
const loadedFiles = new WeakMap<ToolExecutionContext, Set<MotionReference>>();

type SeededReferences = { version: number; contentHash: string; files: ReferenceFile[] };

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
 * The references of one skill's latest seeded version: its stored copy, or
 * the files on disk if they still hash to that version's content_hash. A
 * string is the reason they cannot be loaded.
 */
async function loadSeededReferences(ctx: ToolExecutionContext, skill: string): Promise<SeededReferences | string> {
  // skill_definitions is global (no tenant_id); the read still runs in the
  // run's tenant context, as every query a tool makes does.
  const [definition] = await withTenantContext(ctx.tenantId, (tx) =>
    tx
      .select({
        version: skillDefinitions.version,
        contentHash: skillDefinitions.contentHash,
        skillMarkdown: skillDefinitions.skillMarkdown,
        referenceFiles: skillDefinitions.referenceFiles,
      })
      .from(skillDefinitions)
      .where(eq(skillDefinitions.name, skill))
      .orderBy(desc(skillDefinitions.version))
      .limit(1)
  );
  if (!definition) {
    return `The ${skill} skill has no seeded version in this app's database (npm run db:seed-skills has not been run for it), so its references cannot be loaded.`;
  }
  const { version, contentHash } = definition;
  const stored = readReferenceFiles(definition.referenceFiles);
  if (stored) return { version, contentHash, files: stored };

  const onDisk = await loadBundledReferences(skill);
  if (computeSkillContentHash(definition.skillMarkdown, onDisk) !== contentHash) {
    return (
      `The ${skill} references on this worker differ from the ones its skill version ${version} was seeded with, ` +
      "and that version does not store its own copy, so they cannot be loaded consistently."
    );
  }
  return { version, contentHash, files: onDisk };
}

async function executeLoadMotionReferences(input: unknown, ctx: ToolExecutionContext) {
  const parsed = loadMotionReferencesInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      content: `Input validation failed: ${parsed.error.message}. Call load_motion_references again with files drawn from: ${MOTION_REFERENCE_IDS.join(", ")}.`,
      isError: true,
    };
  }
  const requested = [...new Set(parsed.data.files)];
  const loaded = loadedFiles.get(ctx) ?? new Set<MotionReference>();
  const pending = requested.filter((id) => !loaded.has(id));
  const already = requested.filter((id) => loaded.has(id));
  const alreadyNote = already.length
    ? `Already loaded earlier in this run; the text is in that tool result above: ${already.join(", ")}.`
    : null;
  if (pending.length === 0) return { content: alreadyNote ?? "" };

  // One read per skill, however many of its files were asked for.
  const bySkill = new Map<string, SeededReferences | string>();
  for (const skill of new Set(pending.map((id) => MOTION_REFERENCES[id].skill))) {
    try {
      bySkill.set(skill, await loadSeededReferences(ctx, skill));
    } catch (err) {
      bySkill.set(skill, `Could not load the ${skill} references: ${err instanceof Error ? err.message : String(err)}.`);
    }
  }

  const sections: string[] = [];
  const failures: string[] = [];
  const returned: MotionReference[] = [];
  for (const id of pending) {
    const { skill, path, use } = MOTION_REFERENCES[id];
    const seeded = bySkill.get(skill);
    if (seeded === undefined || typeof seeded === "string") {
      failures.push(`${id}: ${seeded ?? "not loaded"}`);
      continue;
    }
    const file = seeded.files.find((f) => f.path === path);
    if (!file) {
      failures.push(`${id}: not among the references of ${skill} skill version ${seeded.version}.`);
      continue;
    }
    sections.push(
      [
        `# ${id} (${skill} skill version ${seeded.version}, content hash ${seeded.contentHash.slice(0, 12)})`,
        "",
        `What it cross-checks here: ${use}`,
        "",
        file.content,
      ].join("\n")
    );
    returned.push(id);
  }

  const failureNote = failures.length
    ? `Not loaded:\n${failures.map((f) => `- ${f}`).join("\n")}\nFor what these files would have covered: ${UNAVAILABLE_INSTRUCTION}`
    : null;
  if (returned.length === 0) {
    return { content: [failureNote, alreadyNote].filter(Boolean).join("\n\n"), isError: true };
  }

  const content = [
    ["## How to use these files in this run", "", ...RUN_NOTES.map((note) => `- ${note}`)].join("\n"),
    ...sections,
    ...(failureNote ? [failureNote] : []),
    ...(alreadyNote ? [alreadyNote] : []),
  ].join("\n\n---\n\n");

  // The text stays in every later request of the run.
  const cost = JSON.stringify(content).length + RESULT_JSON_OVERHEAD_BYTES;
  if (ctx.requestBytes.used + cost > ctx.requestBytes.limit) {
    return {
      content: `These files do not fit: the conversation is too close to the API's request size limit. Load fewer of them, or none. ${UNAVAILABLE_INSTRUCTION}`,
      isError: true,
    };
  }
  ctx.requestBytes.used += cost;
  for (const id of returned) loaded.add(id);
  loadedFiles.set(ctx, loaded);
  return { content };
}

/**
 * Tool key load_motion_references_legal_argument_research; the model sees
 * it as load_motion_references.
 */
export const loadMotionReferencesTool: SkillTool = {
  definition: {
    name: "load_motion_references",
    description:
      "Load the reference files your references/eoir-motions.md points to in two other firm skills, until its motion-by-motion standards section is written: eoir-motion-self-review/references/motion-elements.md (the element structure of each motion type and the objections to expect, the cross-check for the governing standard and the government's likely counter), and, for deadlines and filing mechanics, eoir-motion-self-review/references/icpm-mechanics.md, eoir-filing-compliance/references/icpm-checklist.md (Immigration Court) and eoir-filing-compliance/references/bia-checklist.md (the Board). " +
      "Returns the files as the firm seeded them, with notes on how to use them in this run; it does not run either skill. " +
      "Call it once the motion type and forum are framed, with the files that apply; a substantive argument that is not a motion needs none. One call per file is enough, since its text stays in the conversation. " +
      "An authority named in them is not verified by loading it: verify it from its own text, retrieved in this run, before marking it verified.",
    input_schema: toJsonSchemaObject(loadMotionReferencesInputSchema) as Anthropic.Tool.InputSchema,
  },
  execute: executeLoadMotionReferences,
};
