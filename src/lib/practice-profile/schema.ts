import { z } from "zod";

// The app's structured equivalent of PRACTICE_PROFILE.md, the file the
// firm's skills read before they run. Sections and fields follow
// skills-content/_shared/PRACTICE_PROFILE.template.md section by section;
// the editor, the renderer and the ripple map (ripple.ts) all key off the
// field names here.
//
// Every answer is optional. An unset field (undefined, "", or the legacy
// "[PLACEHOLDER]" string earlier versions stored) means the firm has not
// answered it, and the rendered profile says so, so the skill applies its
// own default. Never pre-fill an answer the firm did not give: only values
// the template itself supplies as plugin defaults are seeded below.

export const PLACEHOLDER = "[PLACEHOLDER]";

export const postureEnum = z.enum(["aggressive", "standard", "conservative"]);
// legal_assistant predates the template's list (which has law clerk); kept so
// stored profiles still parse.
export const usageRoleEnum = z.enum(["attorney", "accredited_representative", "paralegal", "law_clerk", "legal_assistant"]);
export const integrationStatusEnum = z.enum(["connected", "not_connected", "error"]);
export const caseScopeStatusEnum = z.enum(["active", "planned", "not_offered"]);

const MAX_TEXT = 4000;
const MAX_ROWS = 50;

/** A free-text answer; unset means the firm has not answered (see isUnset). */
const answer = z.string().max(MAX_TEXT).optional();
const textList = z.array(z.string().max(MAX_TEXT)).max(MAX_ROWS).default([]);

export const practiceProfileSchema = z.object({
  // 1. Who we are
  firm: z.object({
    name: answer,
    practiceSetting: answer, // e.g. "private firm", "clinic", "nonprofit"
    primaryCourts: textList, // EOIR immigration courts
    primaryAsylumOffice: answer,
    controllingCircuit: answer,
    filingSourceOfTruth: answer,
    practitioners: textList, // attorneys and accredited representatives using the skills
    caseloadMix: answer,
    description: answer, // what drives most of the work, in one line
  }),
  // 2. Who is using this
  usage: z.object({
    role: usageRoleEnum.optional(),
    supervisingAttorney: answer,
  }),
  // 3. Integrations
  integrations: z
    .array(
      z.object({
        name: z.string().max(MAX_TEXT),
        usedBy: answer,
        status: integrationStatusEnum.optional(),
        fallback: answer,
      })
    )
    .max(MAX_ROWS)
    .default([]),
  // 4. Risk posture
  riskPosture: z
    .array(
      z.object({
        caseType: z.string().max(MAX_TEXT), // a TEMPLATE_RISK_POSTURE_CASE_TYPES key
        posture: postureEnum.optional(),
        notes: answer,
      })
    )
    .max(MAX_ROWS)
    .default([]),
  // 5. Evidence and element standards
  evidenceStandards: z.object({
    nexusShowing: answer,
    psgConservativeness: z.enum(["standard", "conservative"]).optional(),
    psgNotes: answer,
    persecutionThreshold: answer,
    countryConditionsSources: textList,
    countryConditionsTiering: answer,
    countryConditionsRecencyYears: z.number().int().positive().max(100).optional(),
    corroborationSet: textList,
    credibilityPractice: answer,
    oneYearBarHandling: answer,
  }),
  // 6. House style
  houseStyle: z.object({
    declarationTone: answer, // "Declaration tone and format"
    firstPersonConventions: answer,
    signatureAndInterpreterBlocks: answer,
    briefTone: answer,
    headingStyle: answer,
    tabbingConvention: answer,
    indexFormat: answer,
    pagination: answer,
    expertDeclarationTemplatePath: answer,
    workProductHeader: answer,
  }),
  // 7. Escalation rules
  escalationRules: z
    .array(
      z.object({
        decision: z.string().max(MAX_TEXT), // e.g. "Criminal bar analysis"
        whoDecides: answer,
        alwaysEscalate: z.boolean().optional(),
      })
    )
    .max(MAX_ROWS)
    .default([]),
  // 8. Case types in scope
  caseTypesInScope: z
    .array(
      z.object({
        caseType: z.string().max(MAX_TEXT), // a TEMPLATE_SCOPE_CASE_TYPES key (or a legacy one)
        status: caseScopeStatusEnum.optional(),
      })
    )
    .max(MAX_ROWS)
    .default([]),
  // 9. Matter workspaces
  matterWorkspaces: z.object({
    enabled: z.boolean().optional(),
    // The template's plugin default is Off.
    crossMatterContext: z.boolean().default(false),
  }),
  // 10. Seed documents reviewed. The rendered profile goes into every skill
  // run and the audit log keeps every confirmed version, so the editor asks
  // for descriptions without client names.
  seedDocuments: z
    .array(
      z.object({
        document: z.string().max(MAX_TEXT),
        dateReviewed: answer,
        learned: answer,
      })
    )
    .max(MAX_ROWS)
    .default([]),
});

export type PracticeProfile = z.infer<typeof practiceProfileSchema>;
export type EscalationRule = PracticeProfile["escalationRules"][number];

// ---------------------------------------------------------------------------
// Rows the template itself supplies. Labels are the template's wording.
// ---------------------------------------------------------------------------

/** Section 4 of the template: one row per case type. */
export const TEMPLATE_RISK_POSTURE_CASE_TYPES = [
  { key: "asylum_affirmative", label: "Affirmative asylum" },
  { key: "asylum_defensive", label: "Defensive asylum" },
  { key: "withholding_cat", label: "Withholding and CAT" },
  { key: "cancellation", label: "Cancellation of removal" },
] as const;

/** Section 8 of the template: one row per case type. */
export const TEMPLATE_SCOPE_CASE_TYPES = [
  { key: "asylum_affirmative", label: "Affirmative asylum before the Asylum Office" },
  { key: "asylum_defensive_withholding_cat", label: "Defensive asylum, withholding and CAT in Immigration Court" },
  { key: "cancellation", label: "Cancellation of removal" },
  { key: "eoir_motions", label: "Motions before the Immigration Court" },
  { key: "bia_appeals_motions", label: "BIA appeals and motions" },
  { key: "aos_marriage", label: "Marriage based adjustment of status" },
  { key: "i130", label: "I-130 petitions and expedite requests" },
  { key: "i90", label: "I-90 renewal and replacement" },
  { key: "vawa", label: "VAWA self-petitions" },
] as const;

// Keys earlier versions of this schema stored in caseTypesInScope, which the
// template now groups differently.
const LEGACY_SCOPE_LABELS: Record<string, string> = {
  asylum_defensive: "Defensive asylum",
  withholding_cat: "Withholding and CAT",
};

/** Section 3 of the template: the rows it fills in itself (Connected is the firm's answer). */
export const TEMPLATE_INTEGRATIONS: readonly PracticeProfile["integrations"][number][] = [
  {
    name: "Legal research, for example Westlaw or Lexis",
    usedBy: "legal-argument-research",
    fallback: "Web search, with every citation flagged for verification",
  },
  {
    name: "Country conditions research, for example Refworld or ecoi.net",
    usedBy: "country-conditions-research",
    fallback: "Web search, State Department and Human Rights Watch first",
  },
  { name: "ECAS electronic filing", usedBy: "evidence-organizer", fallback: "Paper filing checklist" },
];

/**
 * Section 7 of the template: "The first three rows are plugin defaults;
 * confirm them during setup." The template writes them as "Supervising
 * attorney, always escalated" and "Attorney only" (the decision always goes
 * to the attorney), hence alwaysEscalate on all three. They are also the
 * baseline an initial version is checked against for weakened escalation
 * (checks.ts).
 */
export const PLUGIN_DEFAULT_ESCALATION_RULES: readonly EscalationRule[] = [
  { decision: "Criminal bar analysis", whoDecides: "Supervising attorney", alwaysEscalate: true },
  { decision: "Relief strategy", whoDecides: "Attorney only", alwaysEscalate: true },
  { decision: "NTA pleadings", whoDecides: "Attorney only", alwaysEscalate: true },
];

/** Section 7 rows the template names but leaves for the firm to answer. */
export const TEMPLATE_OPEN_ESCALATION_DECISIONS = [
  "Sign off on YELLOW and RED claim evaluation calls",
  "One year bar exceptions",
] as const;

export const USAGE_ROLE_LABELS: Record<z.infer<typeof usageRoleEnum>, string> = {
  attorney: "Attorney",
  accredited_representative: "Accredited representative",
  paralegal: "Paralegal",
  law_clerk: "Law clerk",
  legal_assistant: "Legal assistant",
};

export function riskPostureCaseTypeLabel(key: string): string {
  return TEMPLATE_RISK_POSTURE_CASE_TYPES.find((c) => c.key === key)?.label ?? key;
}

export function scopeCaseTypeLabel(key: string): string {
  return TEMPLATE_SCOPE_CASE_TYPES.find((c) => c.key === key)?.label ?? LEGACY_SCOPE_LABELS[key] ?? key;
}

/** Same decision, whatever the spacing or case: how escalation rows are matched across versions. */
export function escalationDecisionKey(decision: string): string {
  return decision.trim().replace(/\s+/g, " ").toLowerCase();
}

/** True when the firm has not answered: undefined, null, blank, or the legacy "[PLACEHOLDER]". */
export function isUnset(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" || trimmed === PLACEHOLDER;
  }
  return false;
}

/**
 * The starting point for a firm's first profile (the cold-start-interview
 * case): every answer unset, plus only the rows and values the template
 * itself supplies (its integration rows, the plugin default escalation rules
 * and the named open escalation decisions, the case-type rows, and cross
 * matter context Off).
 */
export function emptyPracticeProfile(): PracticeProfile {
  return {
    firm: { primaryCourts: [], practitioners: [] },
    usage: {},
    integrations: TEMPLATE_INTEGRATIONS.map((row) => ({ ...row })),
    riskPosture: TEMPLATE_RISK_POSTURE_CASE_TYPES.map((c) => ({ caseType: c.key })),
    evidenceStandards: { countryConditionsSources: [], corroborationSet: [] },
    houseStyle: {},
    escalationRules: [
      ...PLUGIN_DEFAULT_ESCALATION_RULES.map((rule) => ({ ...rule })),
      ...TEMPLATE_OPEN_ESCALATION_DECISIONS.map((decision) => ({ decision })),
    ],
    caseTypesInScope: TEMPLATE_SCOPE_CASE_TYPES.map((c) => ({ caseType: c.key })),
    matterWorkspaces: { crossMatterContext: false },
    seedDocuments: [],
  };
}

// Fields that name a table row. They stay (as "") when blank so checks.ts
// can point at the row instead of the row silently losing its name.
const ROW_NAME_KEYS = new Set(["name", "caseType", "decision", "document"]);

function normalizeValue(value: unknown, rowKey: string | null): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (rowKey !== null && ROW_NAME_KEYS.has(rowKey)) return trimmed === PLACEHOLDER ? "" : trimmed;
    return isUnset(trimmed) ? undefined : trimmed;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => (isPlainRecord(item) ? normalizeRecord(item, true) : normalizeValue(item, null)))
      .filter((item) => item !== undefined && !isBlankRow(item));
  }
  if (isPlainRecord(value)) return normalizeRecord(value, false);
  return value;
}

/** `isRow`: the object is a table row (an array element), whose name field is kept even when blank. */
function normalizeRecord(record: Record<string, unknown>, isRow: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    const normalized = normalizeValue(v, isRow ? k : null);
    if (normalized !== undefined) out[k] = normalized;
  }
  return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBlankRow(item: unknown): boolean {
  return isPlainRecord(item) && Object.values(item).every((v) => v === undefined || v === "");
}

/**
 * Trims every answer, turns blank and legacy "[PLACEHOLDER]" answers into
 * unset, and drops list entries and table rows left entirely blank. Takes an
 * already-parsed profile (never raw request input) and keeps it valid
 * against the schema: row names stay as strings and lists stay lists.
 */
export function normalizePracticeProfile(profile: PracticeProfile): PracticeProfile {
  return normalizeValue(profile, null) as PracticeProfile;
}

/** Parses a stored profileJson (any version of this schema) and normalizes it; null if it no longer parses. */
export function readPracticeProfile(json: unknown): PracticeProfile | null {
  const parsed = practiceProfileSchema.safeParse(json);
  return parsed.success ? normalizePracticeProfile(parsed.data) : null;
}
