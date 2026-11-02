import type { ReactNode } from "react";
import type { StatusBadge as Badge, StatusTone } from "@/services/library/status";

// Small presentational pieces shared by the /library pages (server components).

export const muted = "text-[#77869a]";
export const badgeBase = "inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold";

const TONES: Record<StatusTone, string> = {
  green: "bg-[#edf6f0] text-[#477455]",
  amber: "bg-[#fbf3e7] text-[#946b2d]",
  red: "bg-[#fbefef] text-[#a64e4e]",
  gray: "bg-[#f1f4f7] text-[#68788d]",
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
    <a href={url} target="_blank" rel="noopener noreferrer" className="break-all font-medium text-[#416da5] underline decoration-[#c4d2e4] underline-offset-2 hover:text-[#244d83]">
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
