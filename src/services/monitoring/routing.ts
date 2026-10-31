import type { AffectedSkillBasis } from "./types";

// Which of the firm's skills a new item matters to. Mirrors
// skills-content/eoir-weekly-update/references/routing.md: its topic table
// (each row's target reference files and the skills that read them), its
// "Skills with no reference file" list, and its court of appeals Weight
// lines. The summary step picks the topics and groups; the skills follow
// from this table, never from the model. Pure.
//
// The platform adds one rule routing.md does not have, for its USCIS skills
// (routing.md sends USCIS-only items to the summary for the USCIS plugin):
// an item whose quoted text names a form (I-485, G-28, EOIR-26) is matched to
// every registered skill whose own SKILL.md or references name that form.

export type RoutingTopic = {
  /** The routing.md row, as written there. */
  row: string;
  /** Target files, relative to the plugin root as routing.md gives them. */
  files: readonly string[];
  /** The skills that read those files. */
  skills: readonly string[];
  /**
   * Whether another circuit's opinion on this topic is kept (sources.md
   * section 6 and routing.md: asylum, withholding, CAT, motions, and
   * Immigration Court or BIA procedure).
   */
  keptForOtherCircuits: boolean;
};

const AUTHORITY_BANK = "skills/asylum-merits-brief/references/authority-bank.md";
const MOTION_ELEMENTS = "skills/eoir-motion-self-review/references/motion-elements.md";
const EOIR_MOTIONS = "skills/legal-argument-research/references/eoir-motions.md";
const ICPM_MECHANICS = "skills/eoir-motion-self-review/references/icpm-mechanics.md";
const ICPM_CHECKLIST = "skills/eoir-filing-compliance/references/icpm-checklist.md";
const BIA_CHECKLIST = "skills/eoir-filing-compliance/references/bia-checklist.md";

export const ROUTING_TOPICS = {
  asylum_elements: {
    row: "Asylum, withholding and CAT elements: PSG, nexus, persecution, torture, well-founded fear, changed country conditions, state protection, relocation",
    files: [AUTHORITY_BANK],
    skills: ["asylum-merits-brief"],
    keptForOtherCircuits: true,
  },
  hearing_practice: {
    row: "Hearing practice: credibility, corroboration, experts, record left open, hearing rights, pretermission",
    files: [AUTHORITY_BANK],
    skills: ["asylum-merits-brief"],
    keptForOtherCircuits: true,
  },
  motions: {
    row: "Motions: reopen, reconsider, rescind an in absentia order, notice and service of the NTA or hearing notice, terminate (including adjustment eligibility and inadmissibility bars), continue, change venue, sever, suppress, administrative closure, which tribunal decides a motion after remand",
    files: [MOTION_ELEMENTS, EOIR_MOTIONS],
    skills: ["eoir-motion-self-review", "legal-argument-research"],
    keptForOtherCircuits: true,
  },
  motion_filing_mechanics: {
    row: "Motion filing mechanics and deadlines (ICPM chapter 4 changes)",
    files: [ICPM_MECHANICS],
    skills: ["eoir-motion-self-review"],
    keptForOtherCircuits: true,
  },
  immigration_court_filing_rules: {
    row: "Immigration Court filing rules: ICPM changes, deadlines, late filings, service, fees and fee waivers, ECAS, EOIR-28, defective filings",
    files: [ICPM_CHECKLIST],
    skills: ["eoir-filing-compliance"],
    keptForOtherCircuits: true,
  },
  bia_rules: {
    row: "BIA rules: appeals, appeal deadlines, briefing, BIA motions, remand, summary dismissal, BIA fees, EOIR-27",
    files: [BIA_CHECKLIST],
    skills: ["eoir-filing-compliance"],
    keptForOtherCircuits: true,
  },
  citation_integrity_and_conduct: {
    row: "Citation integrity and practitioner conduct: generative AI, discipline for false or invented citations",
    files: [AUTHORITY_BANK, MOTION_ELEMENTS],
    skills: ["asylum-merits-brief", "eoir-motion-self-review"],
    keptForOtherCircuits: true,
  },
  log_only: {
    row: "Bond and detention, cancellation of removal, practitioner discipline on other grounds, anything no file above covers",
    files: [],
    skills: [],
    keptForOtherCircuits: false,
  },
  uscis_only: {
    row: "AAO decisions and USCIS-only items",
    files: [],
    skills: [],
    keptForOtherCircuits: false,
  },
} as const satisfies Record<string, RoutingTopic>;

export type RoutingTopicKey = keyof typeof ROUTING_TOPICS;
export const ROUTING_TOPIC_KEYS = Object.keys(ROUTING_TOPICS) as [RoutingTopicKey, ...RoutingTopicKey[]];

/** routing.md "Skills with no reference file": who an item can matter to beyond the table. */
export const NO_REFERENCE_FILE_GROUPS = {
  bench_memo: {
    skills: ["bench-memo"],
    scope: "hearing practice, credibility, pretermission, cancellation in the alternative, CAT, record preservation",
  },
  direct_exam: {
    skills: ["direct-exam"],
    scope: "credibility, corroboration and anything that changes what testimony must establish",
  },
  shared_skills: {
    skills: [
      "claim-evaluation",
      "brief-draft",
      "country-conditions-research",
      "evidence-organizer",
      "packet-build",
      "packet-review",
      "declaration-draft",
      "declaration-draft-concise",
    ],
    scope: "asylum element analysis, country conditions, evidence and corroboration",
  },
  asylum_fee_proof_packet: {
    skills: ["asylum-fee-proof-packet"],
    scope: "changes to the Annual Asylum Fee, the I-589 fee or the EOIR Payment Portal",
  },
} as const;

export type NoReferenceFileGroupKey = keyof typeof NO_REFERENCE_FILE_GROUPS;
export const NO_REFERENCE_FILE_GROUP_KEYS = Object.keys(NO_REFERENCE_FILE_GROUPS) as [
  NoReferenceFileGroupKey,
  ...NoReferenceFileGroupKey[],
];

/** The reference files routing.md appends to, by file name as the summary step names them. */
export const TARGET_REFERENCE_FILES = {
  "authority-bank.md": { skill: "asylum-merits-brief", path: AUTHORITY_BANK },
  "motion-elements.md": { skill: "eoir-motion-self-review", path: MOTION_ELEMENTS },
  "eoir-motions.md": { skill: "legal-argument-research", path: EOIR_MOTIONS },
  "icpm-mechanics.md": { skill: "eoir-motion-self-review", path: ICPM_MECHANICS },
  "icpm-checklist.md": { skill: "eoir-filing-compliance", path: ICPM_CHECKLIST },
  "bia-checklist.md": { skill: "eoir-filing-compliance", path: BIA_CHECKLIST },
} as const;

export type TargetReferenceFileName = keyof typeof TARGET_REFERENCE_FILES;
export const TARGET_REFERENCE_FILE_NAMES = Object.keys(TARGET_REFERENCE_FILES) as [
  TargetReferenceFileName,
  ...TargetReferenceFileName[],
];

const CIRCUIT_NAMES: Record<string, string> = {
  "1": "First",
  "2": "Second",
  "3": "Third",
  "4": "Fourth",
  "5": "Fifth",
  "6": "Sixth",
  "7": "Seventh",
  "8": "Eighth",
  "9": "Ninth",
  "10": "Tenth",
  "11": "Eleventh",
};

export function circuitName(circuit: string): string {
  return CIRCUIT_NAMES[circuit] ?? circuit;
}

/** routing.md: "Every court opinion entry carries a Weight line." */
export function courtWeightLine(circuit: string): string {
  if (circuit === "5") return "Binding in the Fifth Circuit, including the Houston Immigration Court.";
  return `Binding only in the ${circuitName(circuit)} Circuit. Persuasive in the Fifth Circuit and the Houston Immigration Court.`;
}

/**
 * routing.md: "Other-circuit opinions are kept only for asylum, withholding
 * of removal, CAT, motions, and Immigration Court or BIA procedure.
 * Everything else goes to the Screened table." Fifth Circuit opinions are
 * kept on every immigration topic.
 */
export function courtOpinionKept(circuit: string, topics: readonly RoutingTopicKey[]): boolean {
  if (circuit === "5") return true;
  return topics.some((t) => ROUTING_TOPICS[t].keptForOtherCircuits);
}

const FORM_NUMBER = /\b(I|G|N|AR|EOIR)-(\d{1,4}[A-Z]{0,4})\b/g;

/** Form numbers named in a text ("I-485", "G-28", "EOIR-26"), normalized and de-duplicated. */
export function extractFormNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(FORM_NUMBER)) out.add(`${m[1]}-${m[2]}`.toUpperCase());
  return [...out];
}

/** Form number -> registered skills whose SKILL.md or references name it. */
export function buildFormMentionIndex(skillTexts: readonly { skill: string; text: string }[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const { skill, text } of skillTexts) {
    for (const form of extractFormNumbers(text)) {
      const skills = index.get(form) ?? [];
      if (!skills.includes(skill)) skills.push(skill);
      index.set(form, skills);
    }
  }
  return index;
}

/**
 * The skills an item matters to and why: the routing.md rows the summary
 * step chose, the "Skills with no reference file" groups it named, and the
 * skills whose own text names a form the item's quoted text names.
 * Unregistered skill names are dropped.
 */
export function computeAffectedSkills(params: {
  topics: readonly RoutingTopicKey[];
  groups: readonly { group: NoReferenceFileGroupKey; reason: string }[];
  formNumbers: readonly string[];
  formIndex: ReadonlyMap<string, readonly string[]>;
  registeredSkills: ReadonlySet<string>;
}): { skills: string[]; bases: AffectedSkillBasis[] } {
  const bases: AffectedSkillBasis[] = [];
  const add = (skill: string, basis: string) => {
    if (!params.registeredSkills.has(skill)) return;
    if (!bases.some((b) => b.skill === skill && b.basis === basis)) bases.push({ skill, basis });
  };
  for (const topic of params.topics) {
    for (const skill of ROUTING_TOPICS[topic].skills) add(skill, `routing.md: ${ROUTING_TOPICS[topic].row.split(":")[0]}`);
  }
  for (const { group, reason } of params.groups) {
    for (const skill of NO_REFERENCE_FILE_GROUPS[group].skills) {
      add(skill, `routing.md, skills with no reference file (${NO_REFERENCE_FILE_GROUPS[group].scope}): ${reason}`);
    }
  }
  for (const form of params.formNumbers) {
    for (const skill of params.formIndex.get(form) ?? []) add(skill, `Form ${form} is named in this skill's own text`);
  }
  const skills = [...new Set(bases.map((b) => b.skill))].sort();
  return { skills, bases };
}
