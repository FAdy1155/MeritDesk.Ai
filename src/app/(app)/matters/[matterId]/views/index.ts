import { createElement, type ComponentType, type ReactNode } from "react";
import type { SupportedSkillName } from "@/services/skill-runner/skills";
import type { SkillViewActions, SkillViewProps } from "./types";
import { GenericReportView } from "./GenericReportView";

// Skill name -> dedicated report view. A skill without an entry here still
// renders, through GenericReportView. To add a dedicated view, create
// ./<skill-name>.tsx and add one import line and one entry below, both in
// alphabetical order by skill name. See docs/ADDING_A_SKILL.md.
import { AosPacketReviewView } from "./aos-packet-review";
import { AsylumFeeProofPacketView } from "./asylum-fee-proof-packet";
import { AsylumInterviewPrepBuildView } from "./asylum-interview-prep-build";
import { AsylumInterviewPrepReviewView } from "./asylum-interview-prep-review";
import { AsylumMeritsBriefView } from "./asylum-merits-brief";
import { BenchMemoView } from "./bench-memo";
import { BriefDraftView } from "./brief-draft";
import { ClaimEvaluationView } from "./claim-evaluation";
import { ClosingStatementView } from "./closing-statement";
import { CountryConditionsResearchView } from "./country-conditions-research";
import { DeclarationDraftView } from "./declaration-draft";
import { DeclarationDraftConciseView } from "./declaration-draft-concise";
import { DirectExamView } from "./direct-exam";
import { EoirFilingComplianceView } from "./eoir-filing-compliance";
import { EoirMotionSelfReviewView } from "./eoir-motion-self-review";
import { EoirWrittenPleadingsView } from "./eoir-written-pleadings";
import { EvidenceOrganizerView } from "./evidence-organizer";
import { I130ExpediteBuildView } from "./i130-expedite-build";
import { I90PacketBuildView } from "./i90-packet-build";
import { I90PacketReviewView } from "./i90-packet-review";
import { LegalArgumentResearchView } from "./legal-argument-research";
import { OrthographyCheckView } from "./orthography-check";
import { PacketBuildView } from "./packet-build";
import { PacketReviewView } from "./packet-review";
import { VawaPacketBuildView } from "./vawa-packet-build";
import { VawaPacketReviewView } from "./vawa-packet-review";

type SkillViewMap = { [N in SupportedSkillName]?: ComponentType<SkillViewProps<N>> };

export const SKILL_VIEWS: SkillViewMap = {
  "aos-packet-review": AosPacketReviewView,
  "asylum-fee-proof-packet": AsylumFeeProofPacketView,
  "asylum-interview-prep-build": AsylumInterviewPrepBuildView,
  "asylum-interview-prep-review": AsylumInterviewPrepReviewView,
  "asylum-merits-brief": AsylumMeritsBriefView,
  "bench-memo": BenchMemoView,
  "brief-draft": BriefDraftView,
  "claim-evaluation": ClaimEvaluationView,
  "closing-statement": ClosingStatementView,
  "country-conditions-research": CountryConditionsResearchView,
  "declaration-draft": DeclarationDraftView,
  "declaration-draft-concise": DeclarationDraftConciseView,
  "direct-exam": DirectExamView,
  "eoir-filing-compliance": EoirFilingComplianceView,
  "eoir-motion-self-review": EoirMotionSelfReviewView,
  "eoir-written-pleadings": EoirWrittenPleadingsView,
  "evidence-organizer": EvidenceOrganizerView,
  "i130-expedite-build": I130ExpediteBuildView,
  "i90-packet-build": I90PacketBuildView,
  "i90-packet-review": I90PacketReviewView,
  "legal-argument-research": LegalArgumentResearchView,
  "orthography-check": OrthographyCheckView,
  "packet-build": PacketBuildView,
  "packet-review": PacketReviewView,
  "vawa-packet-build": VawaPacketBuildView,
  "vawa-packet-review": VawaPacketReviewView,
};

type AnySkillView = ComponentType<{ output: unknown; actions: SkillViewActions }>;

function lookupView(skillName: string): AnySkillView | undefined {
  return (SKILL_VIEWS as Record<string, AnySkillView | undefined>)[skillName];
}

export function hasSkillView(skillName: string): boolean {
  return lookupView(skillName) !== undefined;
}

/**
 * Renders the skill's dedicated view, or returns null if it has none. Only
 * pass output that matches the skill's current schema (see
 * outputMatchesCurrentSchema); anything else belongs in GenericReportView.
 * createElement rather than JSX on a looked-up variable: the views are
 * module-level components, never created during render.
 */
export function renderSkillView(skillName: string, output: unknown, actions: SkillViewActions): ReactNode | null {
  const view = lookupView(skillName);
  return view ? createElement(view, { output, actions }) : null;
}

export { GenericReportView };
export type { SkillViewActions, SkillViewProps };
