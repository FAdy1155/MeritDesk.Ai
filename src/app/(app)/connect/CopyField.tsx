"use client";

import { useState } from "react";

/** A value shown in a code box with a Copy button (the connector address on the Connect page). */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="rounded bg-black/5 px-2 py-1 text-sm break-all dark:bg-white/10" aria-label={label}>
        {value}
      </code>
      <button type="button" onClick={copy} className="rounded-md border border-black/15 px-3 py-1 text-xs font-medium dark:border-white/20">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
