// Back-compat re-exports. Each skill's output schema now lives in its own
// module under ./skills/<name>.ts (mirroring that skill's SKILL.md output
// section), and SKILL_SCHEMAS / SupportedSkillName are derived from the
// registry in ./skills/index.ts. New code should import from "./skills"
// directly; nothing new needs to be added to this file when a skill is added.

export { SKILL_SCHEMAS, type SupportedSkillName, type SkillOutput } from "./skills";

export { claimEvaluationOutputSchema, type ClaimEvaluationOutput } from "./skills/claim-evaluation";
export { packetReviewOutputSchema, type PacketReviewOutput } from "./skills/packet-review";
export {
  i130ExpediteBuildOutputSchema,
  i130ExpediteLetterContentSchema,
  i130ExpediteLetterSpecSchema,
  type I130ExpediteBuildOutput,
  type I130ExpediteLetterContent,
  type I130ExpediteLetterSpec,
} from "./skills/i130-expedite-build";
export { aosPacketReviewOutputSchema, type AosPacketReviewOutput } from "./skills/aos-packet-review";
export { vawaPacketReviewOutputSchema, type VawaPacketReviewOutput } from "./skills/vawa-packet-review";
