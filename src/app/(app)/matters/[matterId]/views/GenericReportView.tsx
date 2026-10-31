import type { ReactNode } from "react";
import {
  Badge,
  BulletList,
  ChecklistList,
  CitationsList,
  Flags,
  Muted,
  ReportBody,
  Section,
  Table,
  badgeClassFor,
  ratingColor,
  priorityColor,
  severityColor,
  coverageColor,
  statusColor,
  verdictColor,
} from "./primitives";

// Fallback renderer for any skill without a dedicated view (and for runs
// whose stored output no longer matches the skill's current schema). It
// walks the structured output generically: top-level keys become sections,
// nested objects become sub-sections, arrays of objects become tables,
// arrays of strings become lists, and short enum-like strings ("GREEN",
// "strongly_recommended") become colored badges. A few shapes the firm's
// skills share get their dedicated primitive: { citation, verified } rows
// render as a CitationsList, { priority | severity, ... } rows as a
// ChecklistList, and string lists named like flags or blocking issues as a
// red callout.

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean | null | undefined {
  return value === null || value === undefined || ["string", "number", "boolean"].includes(typeof value);
}

/** "i589Findings" -> "I589 findings", "qa_report" -> "Qa report". */
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const KNOWN_ENUM_VALUES = new Set(
  [ratingColor, priorityColor, severityColor, coverageColor, statusColor, verdictColor].flatMap((m) => Object.keys(m))
);

function isEnumLike(value: string): boolean {
  if (value.length === 0 || value.length > 40) return false;
  if (KNOWN_ENUM_VALUES.has(value)) return true;
  return /^[A-Z][A-Z0-9_]*$/.test(value) || /^[a-z]+(_[a-z]+)+$/.test(value);
}

const FLAG_KEY = /flag|blocking|escalat/i;

function InlineValue({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined || value === "") return <Muted>none</Muted>;
  if (typeof value === "boolean") return <Badge label={value ? "yes" : "no"} tone="neutral" />;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    return isEnumLike(value) ? <Badge label={value} className={badgeClassFor(value)} /> : value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <Muted>none</Muted>;
    if (value.every((v) => typeof v === "string" || typeof v === "number")) return value.join(", ");
    return (
      <ul className="flex flex-col gap-1">
        {value.map((v, i) => (
          <li key={i}>
            <InlineValue value={v} />
          </li>
        ))}
      </ul>
    );
  }
  if (isPlainObject(value)) {
    return (
      <span>
        {Object.entries(value).map(([k, v], i) => (
          <span key={k}>
            {i > 0 ? "; " : ""}
            <Muted>{humanizeKey(k)}:</Muted> <InlineValue value={v} />
          </span>
        ))}
      </span>
    );
  }
  return String(value);
}

/** Column keys in first-seen order across every row. */
function columnKeys(rows: PlainObject[]): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

function textOf(row: PlainObject, skip: string[]): string {
  return Object.entries(row)
    .filter(([k, v]) => !skip.includes(k) && (typeof v === "string" || typeof v === "number") && v !== "")
    .map(([, v]) => String(v))
    .join(" - ");
}

function ArrayOfObjects({ rows }: { rows: PlainObject[] }) {
  if (rows.every((r) => typeof r.citation === "string" && typeof r.verified === "boolean")) {
    return (
      <CitationsList
        items={rows.map((r) => ({
          citation: r.citation as string,
          verified: r.verified as boolean,
          note: textOf(r, ["citation", "verified"]) || undefined,
        }))}
      />
    );
  }

  const badgeKey = ["priority", "severity"].find((k) => rows.every((r) => typeof r[k] === "string"));
  const allScalar = rows.every((r) => Object.values(r).every(isScalar));
  if (badgeKey && allScalar) {
    return (
      <ChecklistList
        items={rows.map((r) => ({
          badge: r[badgeKey] as string,
          badgeClassName: badgeClassFor(r[badgeKey] as string),
          content: textOf(r, [badgeKey]),
        }))}
      />
    );
  }

  return (
    <Table
      rows={rows}
      columns={columnKeys(rows).map((key) => ({
        header: humanizeKey(key),
        cell: (row: PlainObject) => <InlineValue value={row[key]} />,
      }))}
    />
  );
}

function GenericValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <p className="text-xs text-black/50 dark:text-white/50">None.</p>;
    if (value.every(isPlainObject)) return <ArrayOfObjects rows={value} />;
    return <BulletList items={value.map((v, i) => <InlineValue key={i} value={v} />)} />;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    const scalars = entries.filter(([, v]) => isScalar(v));
    const nested = entries.filter(([, v]) => !isScalar(v));
    return (
      <div className="flex flex-col gap-2">
        {scalars.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {scalars.map(([k, v]) => (
              <li key={k}>
                <Muted>{humanizeKey(k)}:</Muted> <InlineValue value={v} />
              </li>
            ))}
          </ul>
        )}
        {nested.map(([k, v]) => (
          <div key={k}>
            <h5 className="mb-1 text-xs font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
              {humanizeKey(k)}
            </h5>
            <GenericValue value={v} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <p>
      <InlineValue value={value} />
    </p>
  );
}

export function GenericReportView({ output }: { output: unknown }) {
  if (!isPlainObject(output)) {
    return (
      <ReportBody>
        <GenericValue value={output} />
      </ReportBody>
    );
  }

  return (
    <ReportBody>
      {Object.entries(output).map(([key, value]) => {
        // String lists named like flags / blocking issues get the red
        // callout; an empty one is omitted, the same as the dedicated views.
        if (Array.isArray(value) && value.every((v) => typeof v === "string") && FLAG_KEY.test(key)) {
          return <Flags key={key} title={humanizeKey(key)} items={value as string[]} />;
        }
        return (
          <Section key={key} title={humanizeKey(key)}>
            <GenericValue value={value} />
          </Section>
        );
      })}
    </ReportBody>
  );
}
