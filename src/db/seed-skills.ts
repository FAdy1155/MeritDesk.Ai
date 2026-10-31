import "../load-env";
import { desc, eq } from "drizzle-orm";
import { db } from "./client";
import { skillDefinitions } from "./schema";
import { SKILL_MODULES, type AnySkillModule } from "../services/skill-runner/skills";
import { readSkillContent } from "../services/skill-runner/skill-content";
import { toJsonSchemaObject } from "../services/skill-runner/json-schema";

// Versioned seed: for every skill registered in
// src/services/skill-runner/skills/index.ts, hash SKILL.md plus every bundled
// references/*.md. If that hash differs from the latest skill_definitions
// row for the skill (or there is no row yet), insert version latest+1.
// Re-running with unchanged content is a no-op, and existing rows are never
// updated in place: skill_runs.skill_definition_id points at the exact
// version each past run used. Each version stores its references too
// (reference_files), and runs use that stored copy rather than the files on
// the worker's disk, so the row is the whole prompt the version sends.
//
// skill_definitions is global (no tenant_id, no RLS policy), which is why
// this uses the unscoped db rather than withTenantContext.

async function seedSkill(skill: AnySkillModule) {
  const { skillMarkdown, referenceFiles, contentHash } = await readSkillContent(skill.name);

  const [latest] = await db
    .select({ version: skillDefinitions.version, contentHash: skillDefinitions.contentHash })
    .from(skillDefinitions)
    .where(eq(skillDefinitions.name, skill.name))
    .orderBy(desc(skillDefinitions.version))
    .limit(1);

  if (latest && latest.contentHash === contentHash) {
    console.log(`Unchanged ${skill.name} v${latest.version} (hash ${contentHash.slice(0, 12)})`);
    return;
  }

  const version = (latest?.version ?? 0) + 1;

  // (name, version) is unique (skill_definitions_name_version_idx). If a
  // concurrent seed run already took this version number, skip rather than
  // fail; re-running reconciles against whatever it inserted.
  const inserted = await db
    .insert(skillDefinitions)
    .values({
      name: skill.name,
      version,
      contentHash,
      skillMarkdown,
      referenceFiles,
      outputJsonSchema: toJsonSchemaObject(skill.outputSchema),
      // Client tool keys, then the Anthropic-hosted server tools (web_search, web_fetch).
      requiredTools: [
        ...skill.tools,
        ...(skill.serverTools ?? []).map((t) => (typeof t === "string" ? t : t.name)),
      ],
      rolloutStatus: "ga",
      canaryPercentage: 100,
    })
    .onConflictDoNothing({ target: [skillDefinitions.name, skillDefinitions.version] })
    .returning({ id: skillDefinitions.id });

  if (inserted.length === 0) {
    console.warn(`Skipped ${skill.name} v${version}: another seed run inserted it first. Re-run to verify.`);
    return;
  }

  console.log(
    latest
      ? `Seeded ${skill.name} v${version} (content changed since v${latest.version}; hash ${contentHash.slice(0, 12)})`
      : `Seeded ${skill.name} v${version} (new; hash ${contentHash.slice(0, 12)})`
  );
}

async function main() {
  for (const skill of SKILL_MODULES) {
    await seedSkill(skill);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
