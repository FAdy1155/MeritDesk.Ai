"use client";

import { useState, useTransition } from "react";
import { markLegalUpdateReviewedAction } from "./actions";

const inputClass =
  "rounded-md border border-black/15 bg-transparent px-3 py-1.5 text-sm disabled:opacity-60 dark:border-white/20";

/** Review status of one legal update for the firm, and (for attorneys and owner/admins) the form to mark it reviewed. */
export function ReviewControl({
  legalUpdateId,
  review,
  canReview,
  reviewedByYou,
  noteMaxChars,
}: {
  legalUpdateId: string;
  review: { reviewedAt: string; note: string | null } | null;
  canReview: boolean;
  reviewedByYou: boolean;
  noteMaxChars: number;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(review?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await markLegalUpdateReviewedAction(legalUpdateId, note);
      if (result.ok) setEditing(false);
      else setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-2 border-t border-black/10 pt-3 text-sm dark:border-white/10">
      {review ? (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-green-800 dark:text-green-300">
            Reviewed{reviewedByYou ? " by you" : ""} on {review.reviewedAt}
          </span>
          {review.note && <p className="whitespace-pre-line text-black/70 dark:text-white/70">{review.note}</p>}
        </div>
      ) : (
        <span className="text-black/60 dark:text-white/60">Not reviewed by the firm yet.</span>
      )}

      {canReview && !editing && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="self-start rounded-md border border-black/15 px-3 py-1 text-xs font-medium dark:border-white/20"
        >
          {review ? "Change review note" : "Mark reviewed"}
        </button>
      )}

      {canReview && editing && (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-black/60 dark:text-white/60">
              Note for the firm (optional): what you checked, and what it changes for your matters.
            </span>
            <textarea
              className={inputClass}
              rows={3}
              maxLength={noteMaxChars}
              value={note}
              disabled={isPending}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={isPending}
              className="rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60 dark:bg-white dark:text-black"
            >
              {isPending ? "Saving..." : "Save as reviewed"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setNote(review?.note ?? "");
                setError(null);
              }}
              disabled={isPending}
              className="rounded-md border border-black/15 px-3 py-1.5 text-xs dark:border-white/20"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}
