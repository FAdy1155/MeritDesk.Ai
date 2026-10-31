"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { getDocumentDownloadUrlAction, requestDocumentIngestAction } from "../actions";
import { Badge, type Tone } from "./views/primitives";

/** One row of listDocuments (src/lib/documents/service.ts), as the page passes it in. */
export type DocumentListItem = {
  id: string;
  fileName: string;
  type: string;
  version: number;
  sizeBytes: number | null;
  malwareScanStatus: string;
  pageCount: number | null;
  ingestionNote: string | null;
  ingestedAt: Date | null;
  extractedTextChars: number | null;
  ingestStalled: boolean;
};

const SCAN_BADGES: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Scan pending", tone: "neutral" },
  clean: { label: "Scan clean", tone: "green" },
  infected: { label: "Infected", tone: "red" },
  error: { label: "Not scanned", tone: "amber" },
};

const buttonClass =
  "rounded-md border border-black/20 px-2 py-0.5 text-xs font-medium text-black/70 dark:border-white/20 dark:text-white/70 disabled:opacity-50";

// Fixed locale, so the server render and the browser agree on separators.
const formatCount = (n: number) => n.toLocaleString("en-US");

function formatSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function textBadge(doc: DocumentListItem): { label: string; tone: Tone } {
  if (doc.malwareScanStatus === "infected") return { label: "Not processed", tone: "neutral" };
  if (doc.extractedTextChars) return { label: `Text extracted, ${formatCount(doc.extractedTextChars)} chars`, tone: "green" };
  if (doc.ingestedAt === null) return { label: "Text pending", tone: "neutral" };
  return { label: "No text extracted", tone: "neutral" };
}

function isInProgress(doc: DocumentListItem): boolean {
  return doc.malwareScanStatus === "pending" && doc.ingestedAt === null && !doc.ingestStalled;
}

/** Why a document that has not scanned clean cannot be downloaded (getDocumentDownloadUrl refuses it too). */
function downloadUnavailableLabel(doc: DocumentListItem): string {
  if (doc.malwareScanStatus === "infected") return "Download blocked";
  if (doc.malwareScanStatus === "error") return "Not downloadable (not scanned)";
  return "Downloadable after scan";
}

export function DocumentList({ documents, canEdit }: { documents: DocumentListItem[]; canEdit: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The scan and extraction run in the background worker; poll while any
  // document is still being processed. A stalled one (no result a few
  // minutes after it was queued) stops the polling and offers Start scan instead.
  useEffect(() => {
    if (!documents.some(isInProgress)) return;
    const id = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(id);
  }, [documents, router]);

  function download(doc: DocumentListItem) {
    setError(null);
    setBusyId(doc.id);
    startTransition(async () => {
      try {
        const url = await getDocumentDownloadUrlAction(doc.id);
        window.open(url, "_blank", "noopener,noreferrer");
      } catch (err) {
        setError(`Could not download ${doc.fileName}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusyId(null);
      }
    });
  }

  function rescan(doc: DocumentListItem) {
    setError(null);
    setBusyId(doc.id);
    startTransition(async () => {
      try {
        await requestDocumentIngestAction(doc.id);
      } catch (err) {
        setError(`Could not queue a scan for ${doc.fileName}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusyId(null);
        router.refresh();
      }
    });
  }

  if (documents.length === 0) {
    return <p className="text-sm text-black/50 dark:text-white/50">No documents yet.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2 text-sm">
        {documents.map((doc) => {
          const infected = doc.malwareScanStatus === "infected";
          // Fails closed, like the server: only a clean scan releases the file.
          const downloadable = doc.malwareScanStatus === "clean";
          const scan = SCAN_BADGES[doc.malwareScanStatus] ?? { label: doc.malwareScanStatus, tone: "neutral" as Tone };
          const text = textBadge(doc);
          const details = [
            doc.type.replace(/_/g, " "),
            `v${doc.version}`,
            formatSize(doc.sizeBytes),
            doc.pageCount ? `${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}` : null,
          ]
            .filter(Boolean)
            .join(", ");
          const canRescan = canEdit && (doc.malwareScanStatus === "error" || doc.ingestStalled);
          return (
            <li
              key={doc.id}
              className={`flex flex-col gap-1 rounded-md border p-2 ${
                infected
                  ? "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40"
                  : "border-black/10 dark:border-white/10"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-all">
                  {doc.fileName} <span className="text-xs text-black/50 dark:text-white/50">({details})</span>
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge label={scan.label} tone={scan.tone} />
                  <Badge label={text.label} tone={text.tone} />
                  {canRescan && (
                    <button type="button" className={buttonClass} disabled={isPending} onClick={() => rescan(doc)}>
                      {busyId === doc.id ? "Queuing..." : doc.malwareScanStatus === "error" ? "Scan again" : "Start scan"}
                    </button>
                  )}
                  {downloadable ? (
                    <button type="button" className={buttonClass} disabled={isPending} onClick={() => download(doc)}>
                      {busyId === doc.id ? "Opening..." : "Download"}
                    </button>
                  ) : (
                    <span
                      className={`text-xs font-medium ${infected ? "text-red-700 dark:text-red-400" : "text-black/50 dark:text-white/50"}`}
                    >
                      {downloadUnavailableLabel(doc)}
                    </span>
                  )}
                </div>
              </div>
              {infected && (
                <p className="text-xs font-medium text-red-700 dark:text-red-400">
                  The malware scan flagged this file. It cannot be downloaded and skill runs do not read it.
                </p>
              )}
              {doc.ingestionNote && <p className="text-xs text-black/60 dark:text-white/60">{doc.ingestionNote}</p>}
              {doc.malwareScanStatus === "error" && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  This file could not be scanned for malware, so it cannot be downloaded and skill runs do not read it.
                </p>
              )}
              {doc.ingestStalled && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  No scan result yet. The background worker may not be running
                  {canEdit ? "; use Start scan to queue it again." : "."}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="text-xs text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}
