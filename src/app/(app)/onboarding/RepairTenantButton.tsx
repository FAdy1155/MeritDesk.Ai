"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { repairTenantAction } from "./actions";

const buttonClass = "rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black";

/** Writes the rows for the session's firm when the org-sync webhook has not arrived (src/app/AppShell.tsx). */
export function RepairTenantButton() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    setError(null);
    startTransition(async () => {
      const result = await repairTenantAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <button type="button" className={`${buttonClass} w-fit`} onClick={run} disabled={isPending}>
        {isPending ? "Setting up..." : "Set up the firm"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
