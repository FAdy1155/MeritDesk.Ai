// The case types a matter can be created with. Shared by the matter create
// form, the matter page, and skill modules' applicableCaseTypes
// (src/services/skill-runner/skills/), so all of them stay on one
// vocabulary. Client-safe: no server imports.
export const MATTER_CASE_TYPES = [
  ["asylum_affirmative", "Asylum (affirmative)"],
  ["asylum_defensive", "Asylum (defensive)"],
  ["withholding_cat", "Withholding of Removal / CAT"],
  ["cancellation", "Cancellation of Removal"],
  ["vawa", "VAWA"],
  ["i130", "I-130 Family Petition"],
  ["i90", "I-90 Green Card Renewal"],
] as const;

export type MatterCaseType = (typeof MATTER_CASE_TYPES)[number][0];

/** The one label map for case type keys; every place that shows a case type reads it through caseTypeLabel. */
export const CASE_TYPE_LABELS: Record<MatterCaseType, string> = Object.fromEntries(MATTER_CASE_TYPES) as Record<
  MatterCaseType,
  string
>;

export function isMatterCaseType(value: string): value is MatterCaseType {
  return Object.prototype.hasOwnProperty.call(CASE_TYPE_LABELS, value);
}

/**
 * The label for a case type key. A key outside the list (matters created
 * before it existed store free text such as "asylum") is shown with its
 * underscores as spaces and a capital first letter, never as a blank.
 */
export function caseTypeLabel(value: string): string {
  if (isMatterCaseType(value)) return CASE_TYPE_LABELS[value];
  const text = value.replace(/_/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Unknown case type";
}
