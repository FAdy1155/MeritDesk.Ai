import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentTenant } from "@/lib/tenant";
import { MAX_READ_CHARS } from "@/services/library/search";
import { loadLibraryDocument } from "@/services/library/service";
import { formatUtc, muted, OfficialLink, precedentialBadge, ToneBadge } from "../../ui";

// One library document: what the source states about it, its citations, its
// text (paged), its official link and, when the original file is stored, a
// link to it. Read-only for every role.

const HIDDEN_METADATA = new Set(["summary", "summaryKind", "statedDates"]);

function label(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/_/g, " ").toLowerCase();
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export default async function LibraryDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ documentId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await getCurrentTenant();
  const { documentId } = await params;
  const query = await searchParams;
  const rawOffset = Array.isArray(query.offset) ? query.offset[0] : query.offset;
  const offset = Math.max(0, Math.floor(Number(rawOffset) || 0));
  const doc = await loadLibraryDocument(documentId, offset);
  if (!doc) notFound();

  const precedent = precedentialBadge(doc.precedentialStatus);
  const summary = typeof doc.metadata.summary === "string" ? doc.metadata.summary : null;
  const statedDates = (doc.metadata.statedDates ?? {}) as Record<string, unknown>;
  const facts = Object.entries(doc.metadata).filter(([key]) => !HIDDEN_METADATA.has(key));
  const end = doc.offset + doc.text.length;
  const rows: [string, ReactNode][] = [
    ["Source", <Link key="s" href={`/library/search?source=${doc.source.code}`} className="underline">{doc.source.name}</Link>],
    ["Court", doc.court],
    ["Agency", doc.agency],
    ["Decided", doc.decisionDate],
    ["Published", doc.publishedDate],
    ["Effective", doc.effectiveDate],
    ["Edition", doc.editionDate],
    ["Year", !doc.decisionDate && !doc.publishedDate ? doc.documentYear : null],
    ["Dates as stated", Object.keys(statedDates).length ? Object.entries(statedDates).map(([k, v]) => `${k}: ${show(v)}`).join("; ") : null],
    ["Kind", label(doc.docType)],
    ["Identifier", doc.externalId],
    ["Official link", <OfficialLink key="o" url={doc.officialUrl} />],
    ["Read from", doc.originalUrl ? <OfficialLink key="r" url={doc.originalUrl} /> : null],
    [
      "Original file",
      doc.hasOriginal ? (
        <a key="f" href={`/library/documents/${doc.id}/original`} target="_blank" rel="noopener noreferrer" className="underline">
          Open the stored copy of the official file
        </a>
      ) : null,
    ],
    ["Library copy", `version ${doc.version}; first collected ${formatUtc(doc.firstSeenAt)}; last changed ${formatUtc(doc.lastChangedAt)}; last checked ${formatUtc(doc.lastCheckedAt)}`],
    ["Source refreshed", `${formatUtc(doc.source.lastSuccessAt)}${doc.source.stale ? " (stale)" : ""}`],
  ];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <p className="text-sm">
        <Link href="/library" className="underline">
          Library
        </Link>{" "}
        /{" "}
        <Link href={`/library/search?source=${doc.source.code}`} className="underline">
          {doc.source.name}
        </Link>
      </p>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{doc.title}</h1>
          {precedent && <ToneBadge label={precedent.label} tone={precedent.tone} />}
          {doc.withdrawnAt && <ToneBadge label="Withdrawn" tone="red" title={doc.withdrawnReason} />}
          {doc.supersededBy && <ToneBadge label="Superseded" tone="amber" />}
          {doc.source.stale && <ToneBadge label="Source stale" tone="amber" />}
        </div>
        {doc.citations.length > 0 && <p>{doc.citations.join("; ")}</p>}
        {doc.withdrawnAt && (
          <p className="text-sm text-red-700 dark:text-red-300">
            Withdrawn {formatUtc(doc.withdrawnAt)}{doc.withdrawnReason ? `: ${doc.withdrawnReason}` : ""}. Check the official site before relying on it.
          </p>
        )}
        {doc.supersededBy && (
          <p className="text-sm text-amber-800 dark:text-amber-200">
            Replaced by{" "}
            <Link href={`/library/documents/${doc.supersededBy.id}`} className="underline">
              {doc.supersededBy.title}
            </Link>
            {doc.supersededNote ? `. ${doc.supersededNote}` : ""}
          </p>
        )}
        <p className={`text-xs ${muted}`}>
          The library&apos;s copy of the official document, collected from the official site. Cite the official link.
        </p>
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-lg border border-black/10 p-4 text-sm dark:border-white/10">
        {rows
          .filter(([, value]) => value !== null && value !== undefined && value !== "")
          .map(([name, value]) => (
            <div key={name} className="contents">
              <dt className={muted}>{name}</dt>
              <dd className="break-words">{value}</dd>
            </div>
          ))}
      </dl>

      {summary && (
        <section className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">{doc.metadata.summaryKind === "headnote" ? "Headnote, as the source prints it" : "Summary, as the source prints it"}</h2>
          <blockquote className="whitespace-pre-line border-l-2 border-black/20 pl-3 text-sm dark:border-white/20">{summary}</blockquote>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Text</h2>
        {doc.textKind === "excerpt" && (
          <p className="text-sm text-amber-800 dark:text-amber-200">
            Only an excerpt is kept{doc.source.licenseNote ? `: ${doc.source.licenseNote}` : ""}. Read the full text at the official link.
          </p>
        )}
        {doc.textKind === "none" || doc.textChars === 0 ? (
          <p className={`text-sm ${muted}`}>The official file has no text layer (a scan, and no OCR is run). Read it at the official link.</p>
        ) : (
          <>
            <p className={`text-xs ${muted}`}>
              Characters {doc.offset.toLocaleString("en-US")}-{end.toLocaleString("en-US")} of {doc.textChars.toLocaleString("en-US")}.
            </p>
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-black/10 p-4 font-serif text-sm leading-relaxed dark:border-white/10">
              {doc.text}
            </pre>
            <div className="flex gap-4 text-sm">
              {doc.offset > 0 && (
                <Link href={`/library/documents/${doc.id}?offset=${Math.max(0, doc.offset - MAX_READ_CHARS)}`} className="underline">
                  Previous part
                </Link>
              )}
              {doc.nextOffset !== null && (
                <Link href={`/library/documents/${doc.id}?offset=${doc.nextOffset}`} className="underline">
                  Next part
                </Link>
              )}
            </div>
          </>
        )}
      </section>

      {facts.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">What the source states about it</summary>
          <dl className={`mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-xs ${muted}`}>
            {facts.map(([key, value]) => (
              <div key={key} className="contents">
                <dt>{label(key)}</dt>
                <dd className="break-all">{show(value)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {doc.versions.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">Earlier versions ({doc.versions.length})</summary>
          <ul className={`mt-2 list-disc pl-5 text-xs ${muted}`}>
            {doc.versions.map((v) => (
              <li key={v.version}>
                Version {v.version}: collected {formatUtc(v.validFrom)}, replaced {formatUtc(v.replacedAt)} (text sha256 {v.textSha256.slice(0, 12)})
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
