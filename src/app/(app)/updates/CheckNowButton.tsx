"use client";

import { useState, useTransition } from "react";
import { checkLegalUpdatesNowAction } from "./actions";

/** Owner/admin only: queue a check of every source now. */
export function CheckNowButton() {
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    setMessage(null);
    startTransition(async () => {
      const result = await checkLegalUpdatesNowAction();
      if (!result.ok) setMessage({ tone: "error", text: result.error });
      else if (result.queued)
        setMessage({
          tone: "ok",
          text: "Check queued. It runs in the background worker and usually takes a few minutes; reload this page to see new items.",
        });
      else setMessage({ tone: "ok", text: "A check is already queued or running. New items appear here when it finishes." });
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-black"
      >
        {isPending ? "Queuing..." : "Check now"}
      </button>
      {message && (
        <p className={`text-xs ${message.tone === "ok" ? "text-black/60 dark:text-white/60" : "text-red-700 dark:text-red-300"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
