// Identifiers the connector keeps out of skill run results
// (get_skill_run, src/services/connector/tools/case-work.ts). A report is
// written from the client's documents and can carry the client's A-number
// and date of birth; neither is needed to discuss the work in Claude or
// ChatGPT. Removed:
//
// - the value of any key named for an A-number or a date of birth
//   (aNumber, a_number, alienNumber, dateOfBirth, date_of_birth, dob,
//   birthDate, ...), at any depth;
// - in every string, an A-number: "A" followed by 8 or 9 digits, with or
//   without dashes or spaces between the digit groups (A123456789,
//   A-123-456-789, A12-345-678), and a labeled one ("A-Number: 123 456 789",
//   "A# 123456789", "Alien No. 123-456-789").
//
// What stays: client names, facts, places and every other date, including a
// date of birth written into a sentence rather than under its own key, and
// a bare nine-digit number with no A or label. Documented in
// docs/CONNECTORS.md and the Firm page's disclosure.

export const REDACTED = "[redacted in connector]";

const REDACTED_KEYS = new Set(["anumber", "aliennumber", "alienregistrationnumber", "dateofbirth", "dob", "birthdate"]);

const LABELED_A_NUMBER = /\b((?:alien(?:\s+registration)?|A)[\s-]*(?:number|no\.?|#)\s*:?\s*)A?[\s-]?\d{2,3}[\s-]?\d{3}[\s-]?\d{3}\b/gi;
const BARE_A_NUMBER = /\bA[\s-]?\d{2,3}[\s-]?\d{3}[\s-]?\d{3}\b/g;

function normalizedKey(key: string): string {
  return key.replace(/[\s_-]/g, "").toLowerCase();
}

/** `text` with every A-number replaced by the redaction marker. */
export function redactIdentifierText(text: string): string {
  return text.replace(LABELED_A_NUMBER, `$1${REDACTED}`).replace(BARE_A_NUMBER, REDACTED);
}

/** A deep copy of `value` with A-numbers and dates of birth replaced by the redaction marker. */
export function redactIdentifiers<T>(value: T): T {
  return walk(value, 0) as T;
}

function walk(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactIdentifierText(value);
  if (value === null || typeof value !== "object" || depth > 64) return value;
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(normalizedKey(key)) && v !== null && v !== "" ? REDACTED : walk(v, depth + 1);
  }
  return out;
}
