import type { ProfileDiffEntry } from "./diff";

// Which skills read which part of the practice profile: the customize
// skill's "explain the ripple" step. Derived by hand from each SKILL.md's
// own "Read PRACTICE_PROFILE.md for ..." instruction:
//
//   grep -n "PRACTICE_PROFILE" skills-content/*/SKILL.md
//
// plus the same paragraph's "confirm the controlling circuit" wording
// (brief-draft, packet-build, packet-review) and "escalate per the profile"
// (brief-draft), and "Under the work-product header, produce" (evidence-
// organizer). The skills not listed (asylum-merits-brief, eoir-written-
// pleadings, closing-statement, the VAWA, I-90, I-130 and AOS skills, and
// the rest) do not read the profile by name; the template's house style
// section says the fixed-format ones follow their own format files. Re-run
// the grep and update this map when a skill is added or its SKILL.md is
// re-synced.

/** Skills that read a whole section of the profile (every field in it). */
const SECTION_READERS: Record<string, readonly string[]> = {
  firm: [],
  usage: [],
  integrations: ["country-conditions-research", "legal-argument-research"],
  riskPosture: ["claim-evaluation", "legal-argument-research", "packet-build", "packet-review"],
  evidenceStandards: ["claim-evaluation", "packet-build", "packet-review"],
  // "house style" or "house conventions" as a whole.
  houseStyle: [
    "asylum-interview-prep-build",
    "asylum-interview-prep-review",
    "bench-memo",
    "claim-evaluation",
    "direct-exam",
    "packet-review",
  ],
  escalationRules: [
    "asylum-interview-prep-build",
    "asylum-interview-prep-review",
    "brief-draft",
    "claim-evaluation",
    "legal-argument-research",
    "packet-build",
    "packet-review",
  ],
  caseTypesInScope: [],
  matterWorkspaces: [],
  seedDocuments: [],
};

/** Skills that read one named field, on top of the section's readers. */
const FIELD_READERS: Record<string, readonly string[]> = {
  "firm.primaryCourts": ["bench-memo", "direct-exam"],
  "firm.controllingCircuit": [
    "bench-memo",
    "brief-draft",
    "direct-exam",
    "legal-argument-research",
    "packet-build",
    "packet-review",
  ],
  "firm.filingSourceOfTruth": ["evidence-organizer"],
  "evidenceStandards.countryConditionsSources": ["country-conditions-research", "evidence-organizer"],
  "evidenceStandards.countryConditionsTiering": ["country-conditions-research"],
  "evidenceStandards.countryConditionsRecencyYears": ["country-conditions-research", "evidence-organizer"],
  "evidenceStandards.corroborationSet": ["evidence-organizer"],
  "houseStyle.declarationTone": ["declaration-draft", "declaration-draft-concise", "packet-build"],
  "houseStyle.firstPersonConventions": ["declaration-draft", "declaration-draft-concise"],
  "houseStyle.signatureAndInterpreterBlocks": ["declaration-draft", "declaration-draft-concise", "packet-build"],
  "houseStyle.briefTone": ["brief-draft", "packet-build"],
  "houseStyle.headingStyle": ["brief-draft"],
  "houseStyle.pagination": ["brief-draft", "evidence-organizer", "packet-build"],
  "houseStyle.tabbingConvention": ["evidence-organizer", "packet-build"],
  "houseStyle.indexFormat": ["evidence-organizer", "packet-build"],
  "houseStyle.workProductHeader": [
    "asylum-interview-prep-build",
    "asylum-interview-prep-review",
    "bench-memo",
    "brief-draft",
    "claim-evaluation",
    "country-conditions-research",
    "declaration-draft",
    "declaration-draft-concise",
    "direct-exam",
    "evidence-organizer",
    "legal-argument-research",
    "packet-build",
    "packet-review",
  ],
};

const SECTION_TITLES: Record<string, string> = {
  firm: "Who we are",
  usage: "Who is using this",
  integrations: "Integrations",
  riskPosture: "Risk posture",
  evidenceStandards: "Evidence and element standards",
  houseStyle: "House style",
  escalationRules: "Escalation rules",
  caseTypesInScope: "Case types in scope",
  matterWorkspaces: "Matter workspaces",
  seedDocuments: "Seed documents reviewed",
};

// The template's own field labels.
const FIELD_LABELS: Record<string, string> = {
  "firm.name": "Firm name",
  "firm.practiceSetting": "Practice setting",
  "firm.primaryCourts": "Primary immigration court or courts",
  "firm.primaryAsylumOffice": "Asylum office",
  "firm.controllingCircuit": "Controlling circuit",
  "firm.filingSourceOfTruth": "Filing source of truth",
  "firm.practitioners": "Attorneys and accredited representatives using the skills",
  "firm.caseloadMix": "Caseload mix",
  "firm.description": "What drives most of the work",
  "usage.role": "Role",
  "usage.supervisingAttorney": "Supervising attorney",
  "evidenceStandards.nexusShowing": "Nexus showing the firm expects",
  "evidenceStandards.psgConservativeness": "How conservatively to define a particular social group",
  "evidenceStandards.psgNotes": "Particular social group notes",
  "evidenceStandards.persecutionThreshold": "Persecution threshold",
  "evidenceStandards.countryConditionsSources": "Accepted country conditions sources",
  "evidenceStandards.countryConditionsTiering": "Country conditions source tiers",
  "evidenceStandards.countryConditionsRecencyYears": "Country conditions recency rule",
  "evidenceStandards.corroborationSet": "Expected corroboration set",
  "evidenceStandards.credibilityPractice": "Credibility and consistency practice",
  "evidenceStandards.oneYearBarHandling": "One year bar handling",
  "houseStyle.declarationTone": "Declaration tone and format",
  "houseStyle.firstPersonConventions": "First person conventions",
  "houseStyle.signatureAndInterpreterBlocks": "Signature and interpreter blocks",
  "houseStyle.briefTone": "Brief tone",
  "houseStyle.headingStyle": "Heading style",
  "houseStyle.tabbingConvention": "Tabbing and exhibit convention",
  "houseStyle.indexFormat": "Index format",
  "houseStyle.pagination": "Pagination",
  "houseStyle.expertDeclarationTemplatePath": "Expert declaration template path",
  "houseStyle.workProductHeader": "Work product header",
  "matterWorkspaces.enabled": "Separate workspace for each client matter",
  "matterWorkspaces.crossMatterContext": "Cross matter context",
};

/** "House style: Brief tone" for a diff path; the section title alone for a whole-section path. */
export function profilePathLabel(path: string): string {
  const section = path.split(".")[0];
  const title = SECTION_TITLES[section] ?? section;
  if (path === section) return title;
  return `${title}: ${FIELD_LABELS[path] ?? path.slice(section.length + 1)}`;
}

/**
 * The skills that read the field at `path` (a diff path such as
 * "houseStyle.briefTone", or a whole section such as "riskPosture"), sorted.
 * Empty when no skill names the field; every run still receives the whole
 * rendered profile.
 */
export function skillsReadingPath(path: string): string[] {
  const section = path.split(".")[0];
  const skills = new Set(SECTION_READERS[section] ?? []);
  for (const [fieldPath, readers] of Object.entries(FIELD_READERS)) {
    if (fieldPath === path || fieldPath.startsWith(`${path}.`) || path.startsWith(`${fieldPath}.`)) {
      for (const skill of readers) skills.add(skill);
    }
  }
  return [...skills].sort();
}

export type RippleEntry = ProfileDiffEntry & { label: string; skills: string[] };

/** Each changed field with the skills it reaches, plus every skill any of the changes reaches. */
export function profileChangeRipple(entries: ProfileDiffEntry[]): { entries: RippleEntry[]; skills: string[] } {
  const all = new Set<string>();
  const withSkills = entries.map((entry) => {
    const skills = skillsReadingPath(entry.path);
    for (const skill of skills) all.add(skill);
    return { ...entry, label: profilePathLabel(entry.path), skills };
  });
  return { entries: withSkills, skills: [...all].sort() };
}
