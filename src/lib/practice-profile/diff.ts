export type ProfileDiffEntry = {
  path: string;
  before: unknown;
  after: unknown;
};

/**
 * Shallow-per-field diff between two practice profile JSON objects, used to
 * show "current -> proposed" before a version is confirmed (mirrors the
 * `customize` skill's show-current-then-proposed workflow) and stored as
 * PracticeProfileVersion.diffFromPrevious for the audit trail. Arrays are
 * compared as whole values rather than diffed element-by-element: for a
 * profile this size, seeing "risk posture table changed" is more useful
 * than a line-level array diff, and it keeps this dependency-free. Callers
 * pass both sides through readPracticeProfile / normalizePracticeProfile
 * first, so a legacy "[PLACEHOLDER]" and an unset field compare equal.
 */
export function diffPracticeProfiles(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  pathPrefix = ""
): ProfileDiffEntry[] {
  const entries: ProfileDiffEntry[] = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);

  for (const key of keys) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    const beforeVal = (before ?? {})[key];
    const afterVal = (after ?? {})[key];

    const bothPlainObjects =
      isPlainObject(beforeVal) && isPlainObject(afterVal);

    if (bothPlainObjects) {
      entries.push(
        ...diffPracticeProfiles(
          beforeVal as Record<string, unknown>,
          afterVal as Record<string, unknown>,
          path
        )
      );
      continue;
    }

    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      entries.push({ path, before: beforeVal, after: afterVal });
    }
  }

  return entries;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One side of a diff entry for display: "not set" for an unanswered field, quoted text, or compact JSON. */
export function formatProfileDiffValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "not set";
  if (typeof value === "string") return `"${value}"`;
  if (Array.isArray(value) && value.length === 0) return "none";
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join(", ");
  return JSON.stringify(value);
}
