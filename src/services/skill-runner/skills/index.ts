import type { z } from "zod";
import type { AnySkillModule } from "./types";

// THE skill registry: the only shared list a new skill touches. To wire a
// skill, add one import line and one SKILL_MODULES entry below, both in
// alphabetical order by skill name (keeps parallel additions from landing on
// the same line). Everything else (SupportedSkillName, SKILL_SCHEMAS, the
// runner's schema/tool/escalation lookups, the seed script, the matter-page
// catalog) is derived from this array. See docs/ADDING_A_SKILL.md.
import { aosPacketReview } from "./aos-packet-review";
import { asylumFeeProofPacket } from "./asylum-fee-proof-packet";
import { asylumInterviewPrepBuild } from "./asylum-interview-prep-build";
import { asylumInterviewPrepReview } from "./asylum-interview-prep-review";
import { asylumMeritsBrief } from "./asylum-merits-brief";
import { benchMemo } from "./bench-memo";
import { briefDraft } from "./brief-draft";
import { claimEvaluation } from "./claim-evaluation";
import { closingStatement } from "./closing-statement";
import { countryConditionsResearch } from "./country-conditions-research";
import { declarationDraft } from "./declaration-draft";
import { declarationDraftConcise } from "./declaration-draft-concise";
import { directExam } from "./direct-exam";
import { eoirFilingCompliance } from "./eoir-filing-compliance";
import { eoirMotionSelfReview } from "./eoir-motion-self-review";
import { eoirWrittenPleadings } from "./eoir-written-pleadings";
import { evidenceOrganizer } from "./evidence-organizer";
import { i130ExpediteBuild } from "./i130-expedite-build";
import { i90PacketBuild } from "./i90-packet-build";
import { i90PacketReview } from "./i90-packet-review";
import { legalArgumentResearch } from "./legal-argument-research";
import { orthographyCheck } from "./orthography-check";
import { packetBuild } from "./packet-build";
import { packetReview } from "./packet-review";
import { vawaPacketBuild } from "./vawa-packet-build";
import { vawaPacketReview } from "./vawa-packet-review";

export const SKILL_MODULES = [
  aosPacketReview,
  asylumFeeProofPacket,
  asylumInterviewPrepBuild,
  asylumInterviewPrepReview,
  asylumMeritsBrief,
  benchMemo,
  briefDraft,
  claimEvaluation,
  closingStatement,
  countryConditionsResearch,
  declarationDraft,
  declarationDraftConcise,
  directExam,
  eoirFilingCompliance,
  eoirMotionSelfReview,
  eoirWrittenPleadings,
  evidenceOrganizer,
  i130ExpediteBuild,
  i90PacketBuild,
  i90PacketReview,
  legalArgumentResearch,
  orthographyCheck,
  packetBuild,
  packetReview,
  vawaPacketBuild,
  vawaPacketReview,
] as const;

type RegisteredSkill = (typeof SKILL_MODULES)[number];

export type SupportedSkillName = RegisteredSkill["name"];

export type SkillSchemas = { [S in RegisteredSkill as S["name"]]: S["outputSchema"] };

/** The validated submit_report payload type for one skill. */
export type SkillOutput<N extends SupportedSkillName> = z.infer<SkillSchemas[N]>;

const MODULES_BY_NAME = new Map<string, AnySkillModule>();
for (const skill of SKILL_MODULES) {
  // Two parallel branches registering the same name would otherwise
  // silently shadow each other; fail loudly at import time instead.
  if (MODULES_BY_NAME.has(skill.name)) {
    throw new Error(`Skill "${skill.name}" is registered twice in src/services/skill-runner/skills/index.ts`);
  }
  MODULES_BY_NAME.set(skill.name, skill);
}

export const SKILL_SCHEMAS = Object.fromEntries(
  SKILL_MODULES.map((skill) => [skill.name, skill.outputSchema])
) as SkillSchemas;

export function isSupportedSkillName(name: string): name is SupportedSkillName {
  return MODULES_BY_NAME.has(name);
}

/** Looks up a registered skill; throws for an unknown name (never returns undefined). */
export function getSkillModule(name: string): AnySkillModule {
  const skill = MODULES_BY_NAME.get(name);
  if (!skill) throw new Error(`Unknown skill "${name}": it is not registered in src/services/skill-runner/skills/index.ts`);
  return skill;
}

/**
 * True when a stored structured_output still parses against the skill's
 * current schema. The matter page uses this to fall back to the generic
 * view for runs produced by an older schema, instead of letting a dedicated
 * view crash on a missing field.
 */
export function outputMatchesCurrentSchema(name: string, output: unknown): boolean {
  const skill = MODULES_BY_NAME.get(name);
  return skill ? skill.outputSchema.safeParse(output).success : false;
}

export type { AnySkillModule, SkillModule, SkillCategory, SkillKind } from "./types";
