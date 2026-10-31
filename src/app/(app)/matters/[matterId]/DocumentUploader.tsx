"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { initiateDocumentUploadAction, requestDocumentIngestAction } from "../actions";

const DOCUMENT_TYPES = [
  ["uploaded_evidence", "Uploaded evidence"],
  ["receipt_notice", "Receipt notice"],
  ["other", "Other"],
] as const;

export function DocumentUploader({ matterId }: { matterId: string }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState<(typeof DOCUMENT_TYPES)[number][0]>("uploaded_evidence");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function handleUpload() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setError(null);
    startTransition(async () => {
      try {
        const { document, uploadUrl, uploadHeaders } = await initiateDocumentUploadAction({
          matterId,
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          type: docType,
        });
        // The server's headers, exactly: the encryption header is part of
        // the URL's signature, so S3 refuses the PUT without it.
        const res = await fetch(uploadUrl, { method: "PUT", headers: uploadHeaders, body: file });
        if (!res.ok) throw new Error(`Upload failed (${res.status})`);
        if (fileInputRef.current) fileInputRef.current.value = "";
        // The bytes are in S3: queue the malware scan and text extraction.
        try {
          await requestDocumentIngestAction(document.id);
        } catch (err) {
          setError(
            `Uploaded, but the malware scan could not be queued (${err instanceof Error ? err.message : "unknown error"}). ` +
              "A Start scan button appears on the document after a few minutes."
          );
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Document type"
        className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-xs dark:border-white/20"
        value={docType}
        onChange={(e) => setDocType(e.target.value as (typeof DOCUMENT_TYPES)[number][0])}
      >
        {DOCUMENT_TYPES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <input ref={fileInputRef} type="file" aria-label="File to upload" className="text-xs" />
      <button
        type="button"
        disabled={isPending}
        onClick={handleUpload}
        className="rounded-md bg-black px-3 py-1 text-xs font-medium text-white dark:bg-white dark:text-black disabled:opacity-50"
      >
        {isPending ? "Uploading..." : "Upload document"}
      </button>
      <span aria-live="polite" className="text-xs text-red-600">
        {error}
      </span>
    </div>
  );
}
