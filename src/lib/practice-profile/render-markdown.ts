import {
  USAGE_ROLE_LABELS,
  isUnset,
  riskPostureCaseTypeLabel,
  scopeCaseTypeLabel,
  type PracticeProfile,
} from "./schema";

/** What every field the firm has not answered reads as, so the skill applies its own default. */
export const NOT_SET = "Not set by the firm (skill default applies)";

const POSTURE_LABELS = { aggressive: "Aggressive", standard: "Standard", conservative: "Conservative" } as const;
const INTEGRATION_STATUS_LABELS = { connected: "Yes", not_connected: "No", error: "Error when tested" } as const;
const SCOPE_STATUS_LABELS = { active: "Active", planned: "Planned", not_offered: "Not offered" } as const;

function text(value: string | undefined): string {
  return isUnset(value) ? NOT_SET : (value as string).trim();
}

function list(values: string[], separator = ", "): string {
  const set = values.filter((v) => !isUnset(v)).map((v) => v.trim());
  return set.length ? set.join(separator) : NOT_SET;
}

function choice<T extends string>(value: T | undefined, labels: Record<T, string>): string {
  return value === undefined ? NOT_SET : labels[value];
}

function yesNo(value: boolean | undefined, yes = "Yes", no = "No"): string {
  return value === undefined ? NOT_SET : value ? yes : no;
}

/** A table cell: one line, with pipes escaped so firm text cannot break the table. */
function cell(value: string): string {
  return value.replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
}

/** A list item; a multi-line answer (a signature block, say) keeps its lines, indented under the item. */
function field(lines: string[], label: string, value: string, hint?: string): void {
  const suffix = hint ? ` *(${hint})*` : "";
  const valueLines = value.split(/\r?\n/);
  if (valueLines.length === 1) {
    lines.push(`- ${label}: ${value}${suffix}`);
    return;
  }
  lines.push(`- ${label}:${suffix}`);
  for (const line of valueLines) lines.push(line.trim() ? `  ${line}` : "");
}

/**
 * Renders a PracticeProfile into the Markdown injected verbatim into every
 * skill's system prompt as PRACTICE_PROFILE.md. It follows
 * skills-content/_shared/PRACTICE_PROFILE.template.md: the same ten
 * numbered sections, field labels and table columns, and the template's own
 * guidance lines where they change how a skill reads a section, because
 * the skills ask for those sections by name ("risk posture", "evidence &
 * element standards", "escalation rules", "controlling circuit", "first
 * person conventions" and so on). Keep it in step with the template.
 *
 * An unanswered field renders as NOT_SET, never as a guess; the stored
 * Markdown is fixed per version at propose time, so changing this only
 * affects versions proposed afterwards.
 */
export function renderPracticeProfileMarkdown(profile: PracticeProfile): string {
  const lines: string[] = [];
  const { firm, usage, evidenceStandards: ev, houseStyle: hs } = profile;

  lines.push("# Practice Profile");
  lines.push("");
  lines.push(
    `*The firm's practice profile, confirmed in the app. A field that reads "${NOT_SET}" has no answer from the firm: apply the skill's own default for it and say so where the skill records its assumptions. Never guess the firm's practices.*`
  );
  lines.push("");

  lines.push("## 1. Who we are");
  lines.push("");
  field(lines, "Firm name", text(firm.name));
  field(lines, "Practice setting", text(firm.practiceSetting));
  field(lines, "Primary immigration court or courts", list(firm.primaryCourts));
  field(lines, "Asylum office", text(firm.primaryAsylumOffice));
  field(
    lines,
    "Controlling circuit",
    text(firm.controllingCircuit),
    "decides which precedent binds, especially on nexus and particular social group"
  );
  field(lines, "Filing source of truth", text(firm.filingSourceOfTruth));
  field(lines, "Attorneys and accredited representatives using the plugins", list(firm.practitioners));
  field(lines, "Caseload mix", text(firm.caseloadMix));
  field(lines, "What drives most of the work, in one line", text(firm.description));
  lines.push("");

  lines.push("## 2. Who is using this");
  lines.push("");
  field(lines, "Role", choice(usage.role, USAGE_ROLE_LABELS));
  field(lines, "Supervising attorney", text(usage.supervisingAttorney));
  lines.push(
    "- Boundary: the plugins produce work product for a supervising attorney or accredited representative. They do not advise clients and they do not decide strategy."
  );
  lines.push("");

  lines.push("## 3. Integrations");
  lines.push("");
  lines.push(
    "*In this app a skill run can use only the tools the app gives that skill. An integration marked connected here is not available to a run unless the run has a tool for it; otherwise follow the fallback.*"
  );
  lines.push("");
  if (profile.integrations.length) {
    lines.push("| Integration | Used by | Connected | Fallback |");
    lines.push("|---|---|---|---|");
    for (const row of profile.integrations) {
      lines.push(
        `| ${cell(text(row.name))} | ${cell(text(row.usedBy))} | ${choice(row.status, INTEGRATION_STATUS_LABELS)} | ${cell(text(row.fallback))} |`
      );
    }
  } else {
    lines.push(`- Integrations: ${NOT_SET}`);
  }
  lines.push("");

  lines.push("## 4. Risk posture");
  lines.push("");
  lines.push(
    "*Aggressive, standard, or conservative for each case type. This changes how claim-evaluation scores borderline elements. When a posture is blank, the Skills apply standard and say so.*"
  );
  lines.push("");
  lines.push("| Case type | Posture | Notes |");
  lines.push("|---|---|---|");
  for (const row of profile.riskPosture) {
    const notes = isUnset(row.notes) ? "" : cell(row.notes as string);
    lines.push(`| ${cell(riskPostureCaseTypeLabel(row.caseType))} | ${choice(row.posture, POSTURE_LABELS)} | ${notes} |`);
  }
  lines.push("");

  lines.push("## 5. Evidence and element standards");
  lines.push("");
  lines.push("*The thresholds claim-evaluation scores against.*");
  lines.push("");
  field(lines, "Nexus showing the firm expects", text(ev.nexusShowing));
  const psg = ev.psgConservativeness
    ? `${POSTURE_LABELS[ev.psgConservativeness]}${isUnset(ev.psgNotes) ? "" : `. ${(ev.psgNotes as string).trim()}`}`
    : text(ev.psgNotes);
  field(lines, "How conservatively to define a particular social group", psg);
  field(lines, "Persecution threshold", text(ev.persecutionThreshold));
  const sources = list(ev.countryConditionsSources);
  field(
    lines,
    "Accepted country conditions sources, in tiers",
    isUnset(ev.countryConditionsTiering)
      ? sources
      : `${(ev.countryConditionsTiering as string).trim()}${sources === NOT_SET ? "" : `\nAccepted sources: ${sources}`}`
  );
  field(
    lines,
    "Country conditions recency rule",
    ev.countryConditionsRecencyYears === undefined
      ? NOT_SET
      : `Exclude sources older than ${ev.countryConditionsRecencyYears} years`,
    "the Skills exclude sources older than 6 years; a stricter firm rule wins"
  );
  field(lines, "Expected corroboration set", list(ev.corroborationSet, "; "));
  field(lines, "Credibility and consistency practice", text(ev.credibilityPractice));
  field(lines, "One year bar handling", text(ev.oneYearBarHandling));
  lines.push("");

  lines.push("## 6. House style");
  lines.push("");
  lines.push(
    "*Skills that carry their own fixed format, such as asylum-merits-brief, eoir-written-pleadings, closing-statement and the VAWA, I-90 and I-130 Skills, follow their own format files and do not read this section.*"
  );
  lines.push("");
  field(lines, "Declaration tone and format", text(hs.declarationTone));
  field(lines, "First person conventions", text(hs.firstPersonConventions));
  field(lines, "Signature and interpreter blocks", text(hs.signatureAndInterpreterBlocks));
  field(lines, "Brief tone", text(hs.briefTone));
  field(lines, "Heading style", text(hs.headingStyle));
  field(lines, "Tabbing and exhibit convention", text(hs.tabbingConvention));
  field(lines, "Index format", text(hs.indexFormat));
  field(lines, "Pagination", text(hs.pagination));
  field(lines, "Expert declaration template path", text(hs.expertDeclarationTemplatePath));
  field(
    lines,
    "Work product header",
    isUnset(hs.workProductHeader) ? NOT_SET : `"${(hs.workProductHeader as string).trim()}"`,
    "printed at the top of every work product deliverable"
  );
  lines.push("");

  lines.push("## 7. Escalation rules");
  lines.push("");
  lines.push("*Who decides each call.*");
  lines.push("");
  if (profile.escalationRules.length) {
    lines.push("| Decision | Who decides | Always escalated |");
    lines.push("|---|---|---|");
    for (const rule of profile.escalationRules) {
      lines.push(`| ${cell(text(rule.decision))} | ${cell(text(rule.whoDecides))} | ${yesNo(rule.alwaysEscalate)} |`);
    }
  } else {
    lines.push(`- Escalation rules: ${NOT_SET}`);
  }
  lines.push("");

  lines.push("## 8. Case types in scope");
  lines.push("");
  lines.push("| Case type | Status |");
  lines.push("|---|---|");
  for (const row of profile.caseTypesInScope) {
    lines.push(`| ${cell(scopeCaseTypeLabel(row.caseType))} | ${choice(row.status, SCOPE_STATUS_LABELS)} |`);
  }
  lines.push("");

  lines.push("## 9. Matter workspaces");
  lines.push("");
  field(lines, "Separate workspace for each client matter", yesNo(profile.matterWorkspaces.enabled));
  field(
    lines,
    "Cross matter context",
    profile.matterWorkspaces.crossMatterContext ? "On" : "Off",
    "plugin default: keep one client's information out of another client's matter"
  );
  lines.push("");

  lines.push("## 10. Seed documents reviewed");
  lines.push("");
  lines.push(
    "*Sample filings the firm shared during setup and what each one showed about house style. Treat every one as confidential client material.*"
  );
  lines.push("");
  if (profile.seedDocuments.length) {
    lines.push("| Document | Date reviewed | What we learned |");
    lines.push("|---|---|---|");
    for (const row of profile.seedDocuments) {
      lines.push(`| ${cell(text(row.document))} | ${cell(text(row.dateReviewed))} | ${cell(text(row.learned))} |`);
    }
  } else {
    lines.push("- None recorded.");
  }
  lines.push("");

  return lines.join("\n");
}
