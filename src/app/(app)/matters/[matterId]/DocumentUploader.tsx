"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { initiateDocumentUploadAction, requestDocumentIngestAction } from "../actions";
import { MAX_DOCUMENT_UPLOAD_BYTES } from "@/lib/documents/upload-policy";

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
    if (file.size < 1 || file.size > MAX_DOCUMENT_UPLOAD_BYTES) {
      setError("Choose a non-empty file that is 150 MB or smaller.");
      return;
    }
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
        className="rounded-xl border border-[#dce4ee] bg-white px-3 py-2 text-sm text-[#344b66]"
        value={docType}
        onChange={(e) => setDocType(e.target.value as (typeof DOCUMENT_TYPES)[number][0])}
      >
        {DOCUMENT_TYPES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <input ref={fileInputRef} type="file" aria-label="File to upload" className="max-w-full text-sm text-[#64758c] file:mr-3 file:rounded-lg file:border-0 file:bg-[#edf3fc] file:px-3 file:py-2 file:text-xs file:font-semibold file:text-[#315d9c] hover:file:bg-[#e2ebf8]" />
      <button
        type="button"
        disabled={isPending}
        onClick={handleUpload}
        className="rounded-xl bg-[#17345f] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#244a7c] disabled:opacity-50"
      >
        {isPending ? "Uploading..." : "Upload document"}
      </button>
      <span aria-live="polite" className="text-xs text-red-600">
        {error}
      </span>
    </div>
  );
}
