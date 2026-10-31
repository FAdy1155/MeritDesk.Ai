import { SKILL_MODULES, type SupportedSkillName } from "./index";
import type { SkillCategory, SkillKind } from "./types";
import type { MatterCaseType } from "@/lib/matters/case-types";

/**
 * The plain-data view of the registry the matter page needs to draw its
 * skill picker, run form and run list: no schemas, no functions, so it
 * serializes across the Server -> Client Component boundary. The matter page
 * (a Server Component) builds this and passes it to SkillRunPanel as a prop;
 * client code should import only the SkillCatalogEntry *type* from here, so
 * zod and the skill schemas stay out of the browser bundle. Client-safe
 * either way: nothing here imports server-only code.
 */
export type SkillCatalogEntry = {
  name: SupportedSkillName;
  /** The module's imperative label, the run button's text ("Run claim evaluation"). */
  label: string;
  /** The label as a name for a run in the run list ("Claim evaluation"). */
  runTitle: string;
  category: SkillCategory;
  kind: SkillKind;
  description: string;
  needsNote: boolean;
  notePlaceholder: string | null;
  /**
   * What the case note should contain, shown as help text above the note
   * box: the module's notePlaceholder without its "Case note for <label>
   * (optional):" lead-in. Null for skills without a note.
   */
  noteHelp: string | null;
  applicableCaseTypes: MatterCaseType[] | null;
  /** Skills an attorney could mistake for this one; the run form shows their descriptions side by side. */
  similarSkills: SupportedSkillName[];
};

/**
 * Groups of skills whose names or purposes are close enough to be confused
 * on the matter page (two briefs, two declarations, a build and the review
 * that checks it). Only a cross-reference: the run form shows each one's own
 * module description, so nothing here says what a skill does. Typed by
 * skill name, so a renamed or removed skill fails tsc here.
 */
const SIMILAR_SKILL_GROUPS: readonly (readonly SupportedSkillName[])[] = [
  ["brief-draft", "asylum-merits-brief"],
  ["declaration-draft", "declaration-draft-concise"],
  ["asylum-interview-prep-build", "asylum-interview-prep-review"],
  ["packet-build", "packet-review"],
  ["i90-packet-build", "i90-packet-review"],
  ["vawa-packet-build", "vawa-packet-review"],
  ["eoir-filing-compliance", "eoir-motion-self-review"],
  ["country-conditions-research", "legal-argument-research"],
];

function similarSkillsOf(name: SupportedSkillName): SupportedSkillName[] {
  const similar = new Set<SupportedSkillName>();
  for (const group of SIMILAR_SKILL_GROUPS) {
    if (!group.includes(name)) continue;
    for (const other of group) if (other !== name) similar.add(other);
  }
  return [...similar];
}

/** "Run claim evaluation" -> "Claim evaluation"; "Draft declaration" stays as it is. */
function runTitleOf(label: string): string {
  const title = label.replace(/^Run\s+/, "");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

// Every notePlaceholder starts "Case note for <label> (optional): " (the
// convention in docs/ADDING_A_SKILL.md); the rest is the instruction.
const NOTE_LEAD_IN = /^Case note for .+? \(optional\):\s*/;

function noteHelpOf(placeholder: string | undefined): string | null {
  if (!placeholder) return null;
  const help = placeholder.replace(NOTE_LEAD_IN, "").trim();
  return help ? help.charAt(0).toUpperCase() + help.slice(1) : null;
}

export function getSkillCatalog(): SkillCatalogEntry[] {
  return SKILL_MODULES.map((skill) => ({
    name: skill.name,
    label: skill.label,
    runTitle: runTitleOf(skill.label),
    category: skill.category,
    kind: skill.kind,
    description: skill.description,
    needsNote: skill.needsNote ?? false,
    notePlaceholder: skill.notePlaceholder ?? null,
    noteHelp: skill.needsNote ? noteHelpOf(skill.notePlaceholder) : null,
    applicableCaseTypes: skill.applicableCaseTypes ? [...skill.applicableCaseTypes] : null,
    similarSkills: similarSkillsOf(skill.name),
  }));
}
