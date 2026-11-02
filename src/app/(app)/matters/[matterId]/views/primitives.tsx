import type { ReactNode } from "react";

// Shared building blocks for the per-skill report views in this folder and
// for GenericReportView. Presentation only: no data fetching, no state.

const GREEN = "bg-[#edf6f0] text-[#477455]";
const AMBER = "bg-[#fbf3e7] text-[#946b2d]";
const RED = "bg-[#fbefef] text-[#a64e4e]";
const NEUTRAL = "bg-[#f1f4f7] text-[#68788d]";

export const toneClass = { green: GREEN, amber: AMBER, red: RED, neutral: NEUTRAL } as const;
export type Tone = keyof typeof toneClass;

export const ratingColor: Record<string, string> = {
  GREEN,
  YELLOW: AMBER,
  RED,
};

export const priorityColor: Record<string, string> = {
  blocking: RED,
  strongly_recommended: AMBER,
  optional: NEUTRAL,
};

export const severityColor: Record<string, string> = {
  BLOCKER: RED,
  MATERIAL: AMBER,
  POLISH: NEUTRAL,
};

export const coverageColor: Record<string, string> = {
  strong: GREEN,
  covered: GREEN,
  aligned: GREEN,
  ESTABLISHED: GREEN,
  thin: AMBER,
  THIN: AMBER,
  missing: RED,
  NOT_ESTABLISHED: RED,
};

export const statusColor: Record<string, string> = {
  clear: GREEN,
  not_triggered: GREEN,
  needs_confirmation: AMBER,
  triggered_waiver_contemplated: AMBER,
  problem: RED,
  escalate: RED,
};

export const verdictColor: Record<string, string> = {
  FILE: GREEN,
  FILE_AS_IS: GREEN,
  FILE_AFTER_FIXES: AMBER,
  REVISE_BEFORE_FILING: AMBER,
  DO_NOT_FILE: RED,
  REWRITE: RED,
};

const ALL_COLOR_MAPS = [ratingColor, priorityColor, severityColor, coverageColor, statusColor, verdictColor];

/** Best-known badge color for an enum value from any skill; neutral when unknown. */
export function badgeClassFor(value: string): string {
  for (const map of ALL_COLOR_MAPS) {
    if (map[value]) return map[value];
  }
  return NEUTRAL;
}

/** "strongly_recommended" -> "strongly recommended". */
export function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

export function yesNo(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return "unknown";
  return value ? "yes" : "no";
}

export function Badge({ label, className, tone }: { label: string; className?: string; tone?: Tone }) {
  const color = className ?? (tone ? toneClass[tone] : badgeClassFor(label));
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold ${color}`}>{humanize(label)}</span>;
}

/** Dimmed secondary text. */
export function Muted({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`text-[#77869a] ${className}`}>{children}</span>;
}

/** Every report view's outer wrapper. */
export function ReportBody({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4 text-sm leading-6 text-[#465b76]">{children}</div>;
}

export function Section({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <h4 className="mb-2 text-sm font-semibold text-[#293f5e]">{title}</h4>
      {children}
    </section>
  );
}

const calloutTone = {
  red: {
    box: "border-[#f0dada] bg-[#fff5f5]",
    title: "text-[#a64e4e]",
  },
  amber: {
    box: "border-[#f0dfbd] bg-[#fff9ef]",
    title: "text-[#8a642c]",
  },
  neutral: {
    box: "border-[#e4eaf1] bg-[#fbfcfe]",
    title: "",
  },
} as const;

/** Bordered, tinted box for things the attorney must not miss. */
export function Callout({
  title,
  tone = "red",
  children,
}: {
  title: ReactNode;
  tone?: keyof typeof calloutTone;
  children: ReactNode;
}) {
  return (
    <section className={`rounded-xl border p-4 ${calloutTone[tone].box}`}>
      <h4 className={`mb-2 text-sm font-semibold ${calloutTone[tone].title}`}>{title}</h4>
      {children}
    </section>
  );
}

export function BulletList({ items, className = "" }: { items: ReactNode[]; className?: string }) {
  return (
    <ul className={`list-inside list-disc ${className}`}>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** Flags / blocking-issue callout. Renders nothing when there are no items. */
export function Flags({ title, items, tone = "red" }: { title: ReactNode; items: ReactNode[]; tone?: "red" | "amber" }) {
  if (items.length === 0) return null;
  return (
    <Callout title={title} tone={tone}>
      <BulletList items={items} />
    </Callout>
  );
}

export type Column<T> = {
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
};

/** Compact report table; rows align to the top so long cells read cleanly. */
export function Table<T>({
  columns,
  rows,
  rowClassName,
  empty = "None.",
}: {
  columns: Column<T>[];
  rows: T[];
  rowClassName?: (row: T) => string;
  empty?: ReactNode;
}) {
  if (rows.length === 0) return <p className="text-xs text-black/50 dark:text-white/50">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-black/10 text-left dark:border-white/10">
            {columns.map((col, i) => (
              <th key={i} className={`py-1 ${i < columns.length - 1 ? "pr-2" : ""}`}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr
              key={ri}
              className={`border-b border-black/5 align-top dark:border-white/5 ${rowClassName?.(row) ?? ""}`}
            >
              {columns.map((col, ci) => (
                <td key={ci} className={`py-1 ${ci < columns.length - 1 ? "pr-2" : ""}`}>
                  {col.cell(row, ri)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type ChecklistItem = { badge: string; badgeClassName?: string; content: ReactNode };

/** Badge-led list, e.g. a prioritized edit checklist or severity-tagged defects. */
export function ChecklistList({ items }: { items: ChecklistItem[] }) {
  if (items.length === 0) return <p className="text-xs text-black/50 dark:text-white/50">None.</p>;
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2">
          <Badge label={item.badge} className={item.badgeClassName} />
          <span>{item.content}</span>
        </li>
      ))}
    </ul>
  );
}

export type CitationItem = { citation: string; verified: boolean; note?: ReactNode };

/**
 * Authorities the skill relied on or suggests reviewing. Every row carries
 * a verified / unverified marker: the skills never assert a citation as
 * verified unless they actually confirmed it, and the attorney checks every
 * unverified one before relying on it.
 */
export function CitationsList({ items }: { items: CitationItem[] }) {
  if (items.length === 0) return <p className="text-xs text-black/50 dark:text-white/50">None.</p>;
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2">
          <Badge label={item.verified ? "verified" : "unverified"} tone={item.verified ? "green" : "amber"} />
          <span>
            {item.citation}
            {item.note ? (
              <>
                {" - "}
                <Muted>{item.note}</Muted>
              </>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
