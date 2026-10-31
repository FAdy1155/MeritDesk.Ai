"use client";

import { useState, useTransition } from "react";
import { confirmVersionAction } from "./actions";

/**
 * The confirm step for a pending version. `fingerprint` pins the proposal the
 * confirmer is looking at (the action refuses if it changed since), and when
 * the version weakens an escalation rule the button stays disabled until the
 * confirmer ticks the acknowledgment, which the server checks again.
 */
export function ConfirmVersionForm({
  versionId,
  fingerprint,
  weakenings,
}: {
  versionId: string;
  fingerprint: string;
  /** describeEscalationWeakening() lines; empty when nothing is weakened. */
  weakenings: string[];
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isWorking, startTransition] = useTransition();
  const needsAcknowledgment = weakenings.length > 0;

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await confirmVersionAction(versionId, {
        fingerprint,
        acknowledgeEscalationWeakening: needsAcknowledgment && acknowledged,
      });
      // On success the action revalidates /practice-profile and the page re-renders with the new active version.
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {needsAcknowledgment && (
        <div className="flex flex-col gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          <p className="font-medium">This version weakens the escalation rules:</p>
          <ul className="list-disc pl-5">
            {weakenings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <p>
            Escalation rules are a safety and unauthorized-practice boundary: they are how the skills route criminal bar
            questions and strategy calls to an attorney instead of resolving them.
          </p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>
              I understand that this version weakens the escalation rules listed above, and I confirm it. The
              acknowledgment is recorded in the audit log.
            </span>
          </label>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={isWorking || (needsAcknowledgment && !acknowledged)}
          onClick={handleConfirm}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Confirm and activate
        </button>
        {error && <span className="text-xs text-red-700 dark:text-red-300">{error}</span>}
      </div>
    </div>
  );
}
