// The editable details of a matter (status, venue, circuit, court and its
// key dates): the controlled lists the matter forms offer, their labels, and
// the strict date check. Skill runs read these fields through
// buildUserContext (src/services/skill-runner/prompt.ts): status and venue
// as the labels below, the rest verbatim, so what is stored must be exactly
// what a skill should read. Client-safe: no zod and no
// server imports (the zod schema the Server Actions use is in
// ./details-schema.ts).

/** Workflow states of a matter in this app. matters.status defaults to "open". */
export const MATTER_STATUSES = [
  ["open", "Open"],
  ["on_hold", "On hold"],
  ["closed", "Closed"],
] as const;

export type MatterStatus = (typeof MATTER_STATUSES)[number][0];

/** Where the matter is pending. The first three keys predate this list and are kept as they are stored. */
export const MATTER_VENUES = [
  ["asylum_office", "USCIS Asylum Office"],
  ["eoir", "Immigration Court (EOIR)"],
  ["bia", "Board of Immigration Appeals"],
  ["uscis_service_center", "USCIS Service Center"],
  ["uscis_field_office", "USCIS Field Office"],
] as const;

export type MatterVenue = (typeof MATTER_VENUES)[number][0];

/**
 * The federal courts of appeals with regional jurisdiction, stored as the
 * name a skill reads ("Fifth Circuit"). The forms also take free text for
 * anything else, and a value stored before this list existed is kept as is.
 */
export const FEDERAL_CIRCUITS = [
  "First Circuit",
  "Second Circuit",
  "Third Circuit",
  "Fourth Circuit",
  "Fifth Circuit",
  "Sixth Circuit",
  "Seventh Circuit",
  "Eighth Circuit",
  "Ninth Circuit",
  "Tenth Circuit",
  "Eleventh Circuit",
  "D.C. Circuit",
] as const;

/** The matters columns the details form edits, in form order. */
export const MATTER_DETAIL_FIELDS = [
  "status",
  "venue",
  "circuit",
  "court",
  "ntaDate",
  "oneYearClockDate",
  "nextHearingDate",
] as const;

export type MatterDetailField = (typeof MATTER_DETAIL_FIELDS)[number];

export const MATTER_DETAIL_LABELS: Record<MatterDetailField, string> = {
  status: "Status",
  venue: "Venue",
  circuit: "Circuit",
  court: "Court or office",
  ntaDate: "NTA date",
  oneYearClockDate: "One-year clock date",
  nextHearingDate: "Next hearing date",
};

export const MATTER_DATE_FIELDS = ["ntaDate", "oneYearClockDate", "nextHearingDate"] as const;

export type MatterDateField = (typeof MATTER_DATE_FIELDS)[number];

const STATUS_LABELS = Object.fromEntries(MATTER_STATUSES) as Record<string, string>;
const VENUE_LABELS = Object.fromEntries(MATTER_VENUES) as Record<string, string>;

export function isMatterStatus(value: string): value is MatterStatus {
  return Object.prototype.hasOwnProperty.call(STATUS_LABELS, value);
}

export function isMatterVenue(value: string): value is MatterVenue {
  return Object.prototype.hasOwnProperty.call(VENUE_LABELS, value);
}

export function isFederalCircuit(value: string): boolean {
  return (FEDERAL_CIRCUITS as readonly string[]).includes(value);
}

function humanizeKey(value: string): string {
  const text = value.replace(/_/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : value;
}

/** Label for a stored status; a value outside the list is shown humanized. */
export function matterStatusLabel(value: string): string {
  return STATUS_LABELS[value] ?? humanizeKey(value);
}

/** Label for a stored venue; null when none is set. */
export function matterVenueLabel(value: string | null): string | null {
  if (!value) return null;
  return VENUE_LABELS[value] ?? humanizeKey(value);
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Earliest and latest year the date fields accept, to catch typed years such as 0202 or 20226. */
export const MIN_DATE_YEAR = 1900;
export const MAX_DATE_YEAR = 2100;

/**
 * True only for a real calendar date written exactly YYYY-MM-DD (what an
 * <input type="date"> submits) with a year from MIN_DATE_YEAR to
 * MAX_DATE_YEAR: 2026-02-30, 2026-2-3 and 13/10/2026 are all refused.
 */
export function isIsoCalendarDate(value: string): boolean {
  const match = ISO_DATE_RE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < MIN_DATE_YEAR || year > MAX_DATE_YEAR) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// The dates are calendar dates with no time zone, so they are formatted in
// UTC: the server render and the browser always print the same day.
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

/** "2026-10-13" -> "Oct 13, 2026". A stored value that is not a valid date is returned as it is. */
export function formatMatterDate(value: string): string {
  return isIsoCalendarDate(value) ? DATE_FORMAT.format(new Date(`${value}T00:00:00Z`)) : value;
}
