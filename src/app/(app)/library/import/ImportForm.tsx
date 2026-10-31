"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { importFromOfficialSiteAction, type ImportActionState } from "./actions";

// The import form: the source, the official address, the saved file, and
// the optional linked page or file. File sizes are sent alongside the files
// so the action can tell a request cut short from a whole one.

export type ImportFormSource = {
  code: string;
  name: string;
  paths: { role: "document" | "linked"; file: "html" | "pdf"; label: string }[];
};

const input = "w-full rounded-md border border-black/20 bg-transparent px-3 py-1.5 text-sm dark:border-white/20";

export function ImportForm({ sources, maxBytes }: { sources: ImportFormSource[]; maxBytes: number }) {
  const [state, formAction, pending] = useActionState<ImportActionState, FormData>(importFromOfficialSiteAction, null);
  const [code, setCode] = useState(sources[0]?.code ?? "");
  const [fileSize, setFileSize] = useState("");
  const [linkedFileSize, setLinkedFileSize] = useState("");
  const [tooLarge, setTooLarge] = useState<string | null>(null);
  const source = sources.find((s) => s.code === code);
  const documents = source?.paths.filter((p) => p.role === "document") ?? [];
  const linked = source?.paths.filter((p) => p.role === "linked") ?? [];

  const onFile = (set: (v: string) => void, what: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    set(f ? String(f.size) : "");
    setTooLarge(f && f.size > maxBytes ? `The ${what} is ${(f.size / 1048576).toFixed(1)} MB; an import takes at most ${maxBytes / 1048576} MB.` : null);
  };

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-lg border border-black/10 p-4 text-sm dark:border-white/10">
      <label className="flex flex-col gap-1">
        <span className="font-medium">Source</span>
        <select name="source" value={code} onChange={(e) => setCode(e.target.value)} className={input}>
          {sources.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      {documents.length > 0 && (
        <div className="text-xs text-black/60 dark:text-white/60">
          <p>This source takes:</p>
          <ul className="list-disc pl-5">
            {documents.map((p, i) => (
              <li key={i}>{p.label}</li>
            ))}
          </ul>
        </div>
      )}
      <label className="flex flex-col gap-1">
        <span className="font-medium">Official address</span>
        <input name="url" type="url" required placeholder="https://..." className={input} />
        <span className="text-xs text-black/60 dark:text-white/60">Copy it from the browser&apos;s address bar once the page has loaded.</span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium">Saved page or PDF</span>
        <input name="file" type="file" required accept=".html,.htm,.pdf,text/html,application/pdf" onChange={onFile(setFileSize, "file")} />
        <input type="hidden" name="fileSize" value={fileSize} />
        <span className="text-xs text-black/60 dark:text-white/60">
          A page: the browser&apos;s &quot;Save page as&quot;, &quot;Webpage, HTML only&quot;. A PDF: the official file itself, downloaded as it is.
        </span>
      </label>
      {linked.length > 0 && (
        <fieldset className="flex flex-col gap-2 rounded-md border border-black/10 p-3 dark:border-white/10">
          <legend className="px-1 text-xs font-medium">Linked page or file</legend>
          <ul className="list-disc pl-5 text-xs text-black/60 dark:text-white/60">
            {linked.map((p, i) => (
              <li key={i}>{p.label}</li>
            ))}
          </ul>
          <input name="linkedUrl" type="url" placeholder="https://... (its official address)" className={input} />
          <input name="linkedFile" type="file" accept=".html,.htm,.pdf,text/html,application/pdf" onChange={onFile(setLinkedFileSize, "linked file")} />
          <input type="hidden" name="linkedFileSize" value={linkedFileSize} />
        </fieldset>
      )}
      {tooLarge && <p className="text-xs text-red-700 dark:text-red-300">{tooLarge}</p>}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || Boolean(tooLarge)}
          className="rounded-md bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-black"
        >
          {pending ? "Importing..." : "Import"}
        </button>
        {pending && <span className="text-xs text-black/60 dark:text-white/60">Reading the file with the source&apos;s own parser; a long PDF can take a minute.</span>}
      </div>
      {state && (
        <div className={`rounded-md p-3 text-sm ${state.ok ? "bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-200" : "bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200"}`}>
          <p>{state.message}</p>
          {state.ok && (
            <p className="mt-1">
              <Link href={`/library/documents/${state.documentId}`} className="underline">
                Open the document
              </Link>
            </p>
          )}
          {state.ok && state.notes.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {state.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
