import type { ReactNode } from "react";
import type { StatusBadge as Badge, StatusTone } from "@/services/library/status";

// Small presentational pieces shared by the /library pages (server components).

export const muted = "text-black/60 dark:text-white/60";
export const badgeBase = "rounded px-1.5 py-0.5 text-xs font-medium";

const TONES: Record<StatusTone, string> = {
  green: "bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200",
  amber: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  red: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  gray: "bg-black/5 text-black/70 dark:bg-white/10 dark:text-white/70",
};

export function ToneBadge({ label, tone, title }: { label: string; tone: StatusTone; title?: string | null }) {
  return (
    <span className={`${badgeBase} ${TONES[tone]}`} title={title ?? undefined}>
      {label}
    </span>
  );
}

export function StatusBadgeView({ badge }: { badge: Badge }) {
  return <ToneBadge label={badge.label} tone={badge.tone} title={badge.detail} />;
}

export function formatUtc(date: Date | null | undefined): string {
  if (!date) return "never";
  return `${date.toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC`;
}

/** An https link that opens the official site; any other value is shown as text. */
export function OfficialLink({ url, children }: { url: string; children?: ReactNode }) {
  if (!/^https:\/\//i.test(url)) return <span className="break-all">{children ?? url}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="break-all underline">
      {children ?? url}
    </a>
  );
}

/** A snippet with search matches marked: [[word]] becomes a highlighted word; everything else is plain text. */
export function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[\[[\s\S]*?\]\])/g);
  return (
    <span>
      {parts.map((part, i) =>
        part.startsWith("[[") && part.endsWith("]]") ? (
          <mark key={i} className="rounded bg-yellow-200 px-0.5 text-black dark:bg-yellow-700 dark:text-white">
            {part.slice(2, -2)}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
}

export function precedentialBadge(status: string): { label: string; tone: StatusTone } | null {
  if (status === "precedential") return { label: "Precedential", tone: "green" };
  if (status === "non_precedential") return { label: "Non-precedential", tone: "amber" };
  return null;
}
