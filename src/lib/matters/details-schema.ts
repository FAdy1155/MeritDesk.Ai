import { z } from "zod";
import { isMatterCaseType } from "./case-types";
import { MATTER_DETAIL_LABELS, MAX_DATE_YEAR, MIN_DATE_YEAR, isIsoCalendarDate, isMatterVenue, type MatterDateField } from "./details";

// Validation for the matter create form and the matter details form, run by
// their Server Actions (src/app/(app)/matters/actions.ts) on whatever the
// browser sent. Kept apart from ./details.ts so zod stays out of the client
// bundle. Every value here is written into skill runs' first message
// (buildUserContext in src/services/skill-runner/prompt.ts), so a text value
// is one line of printable text and a date is a real YYYY-MM-DD date.

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function line(label: string, max: number) {
  return z
    .string(`${label}: enter text.`)
    .trim()
    .max(max, `${label}: keep this under ${max} characters.`)
    .refine((v) => !CONTROL_CHARS.test(v), `${label}: use a single line of text, without line breaks or control characters.`);
}

/** An optional single-line field: "" means not set (stored as null). */
function optionalLine(label: string, max: number) {
  return line(label, max).optional().default("");
}

/** An optional date: "" means not set; anything else must be a real date written YYYY-MM-DD. */
function dateField(field: MatterDateField) {
  const label = MATTER_DETAIL_LABELS[field];
  return z
    .string(`${label}: enter a date.`)
    .trim()
    .optional()
    .default("")
    .refine(
      (v) => v === "" || isIsoCalendarDate(v),
      `${label}: enter a real date as YYYY-MM-DD, with a year from ${MIN_DATE_YEAR} to ${MAX_DATE_YEAR}.`
    );
}

/**
 * The details form. status and venue are checked against their controlled
 * lists by updateMatterDetails (src/lib/matters/service.ts), which also
 * accepts the value already stored, so a matter created before a list
 * existed can be saved without changing it.
 */
export const matterDetailsInputSchema = z.object({
  status: line(MATTER_DETAIL_LABELS.status, 60).min(1, "Status: choose a status."),
  venue: optionalLine(MATTER_DETAIL_LABELS.venue, 60),
  circuit: optionalLine(MATTER_DETAIL_LABELS.circuit, 100),
  court: optionalLine(MATTER_DETAIL_LABELS.court, 200),
  ntaDate: dateField("ntaDate"),
  oneYearClockDate: dateField("oneYearClockDate"),
  nextHearingDate: dateField("nextHearingDate"),
});
export type MatterDetailsInput = z.input<typeof matterDetailsInputSchema>;
export type MatterDetailsValues = z.output<typeof matterDetailsInputSchema>;

/** The create form: a new matter takes its case type and venue from the lists only. */
export const newMatterInputSchema = z.object({
  caseType: z
    .string("Case type: choose a case type.")
    .refine((v) => isMatterCaseType(v), "Case type: choose a case type from the list."),
  venue: optionalLine(MATTER_DETAIL_LABELS.venue, 60).refine(
    (v) => v === "" || isMatterVenue(v),
    "Venue: choose a venue from the list."
  ),
  circuit: optionalLine(MATTER_DETAIL_LABELS.circuit, 100),
  court: optionalLine(MATTER_DETAIL_LABELS.court, 200),
  ntaDate: dateField("ntaDate"),
  oneYearClockDate: dateField("oneYearClockDate"),
  nextHearingDate: dateField("nextHearingDate"),
});
export type NewMatterValues = z.output<typeof newMatterInputSchema>;

/** The schema's messages, each already prefixed with its field's label, as one sentence list. */
export function matterIssuesMessage(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join(" ");
}
