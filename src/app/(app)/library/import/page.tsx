import Link from "next/link";
import { getCurrentTenantIfEntitled } from "@/lib/tenant";
import { isLibraryImportAdmin, loadImportPage } from "@/services/library/import-service";
import { formatUtc, muted, OfficialLink, ToneBadge } from "../ui";
import { ImportForm } from "./ImportForm";

// Import from the official site (/library/import): the library sources
// whose sites refuse automated tools (docs/LIBRARY_SOURCES.md section 1)
// are kept up to date by a platform operator who opens the official page in
// their own browser, saves it, and gives the app the file. Only the
// platform's operators (LIBRARY_IMPORT_ADMINS) see the form: the library is
// shared by every firm (src/services/library/import-service.ts says why).

export default async function LibraryImportPage() {
  const current = await getCurrentTenantIfEntitled();
  if (!current) return null;
  const { userId } = current;
  if (!isLibraryImportAdmin(userId)) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        <h1 className="text-xl font-semibold">Import from official site</h1>
        <p className={`text-sm ${muted}`}>
          The library is shared by every firm on the platform, so importing into it is limited to the platform&apos;s operators. If a
          source on the Library page is overdue, tell them.
        </p>
        <p className="text-sm">
          <Link href="/library" className="underline">
            Back to the library
          </Link>
        </p>
      </div>
    );
  }

  let data: Awaited<ReturnType<typeof loadImportPage>> | null = null;
  let loadError: string | null = null;
  try {
    data = await loadImportPage();
  } catch {
    loadError = "The library's import records could not be read. If the database was just updated, run the migrations (npm run db:migrate).";
  }
  const names = new Map(data?.sources.map((s) => [s.code, s.name]) ?? []);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Import from official site</h1>
        <p className={`text-sm ${muted}`}>
          These sources&apos; websites refuse automated tools, and the app does not disguise itself to get past that. Open the
          official page in your own browser, save it (&quot;Save page as&quot;, &quot;Webpage, HTML only&quot;) or download the official
          PDF, and give it here with the address it came from. The app reads it with the same parser the automatic collector uses,
          checks it the same way, and stores it as a new version when it changed. Every import is recorded with who made it and the
          file&apos;s fingerprint. Never import a copy from anywhere but the official site.
        </p>
        <p className="text-sm">
          <Link href="/library" className="underline">
            Back to the library
          </Link>
        </p>
        {loadError && <p className="text-sm text-red-700 dark:text-red-300">{loadError}</p>}
      </div>

      {data && (
        <>
          <ImportForm sources={data.sources.map((s) => ({ code: s.code, name: s.name, paths: s.paths }))} maxBytes={data.maxBytes} />

          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">Sources</h2>
            <ul className="flex flex-col gap-2 text-sm">
              {data.sources.map((s) => (
                <li key={s.code} className="flex flex-col gap-0.5 rounded-md border border-black/10 p-3 dark:border-white/10">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    {s.manual ? <ToneBadge label="Manual import" tone="gray" /> : <ToneBadge label="Automatic" tone="gray" title="Not in LIBRARY_MANUAL_SOURCES: its daily run reads the site." />}
                    {s.manual && s.stale && <ToneBadge label="Overdue" tone="amber" title={`No import in the last ${s.intervalDays} days.`} />}
                  </div>
                  <p className={`text-xs ${muted}`}>
                    {s.documentCount.toLocaleString("en-US")} documents; last import {formatUtc(s.lastImportAt)}; expected about every {s.intervalDays} days.
                  </p>
                  <p className="text-xs">
                    Official site: <OfficialLink url={s.officialUrl} />
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">Latest imports</h2>
            {data.recent.length === 0 ? (
              <p className={`text-sm ${muted}`}>None yet.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-xs">
                {data.recent.map((r, i) => (
                  <li key={i} className="flex flex-col">
                    <span>
                      {formatUtc(r.at)}: {names.get(r.sourceCode) ?? r.sourceCode}, <span className="font-medium">{r.outcome}</span>
                      {r.documentId && r.documentVersion ? (
                        <>
                          {" "}
                          (
                          <Link href={`/library/documents/${r.documentId}`} className="underline">
                            version {r.documentVersion}
                          </Link>
                          )
                        </>
                      ) : null}
                    </span>
                    <span className={`break-all ${muted}`}>{r.officialUrl}</span>
                    {r.errorMessage && <span className="text-red-700 dark:text-red-300">{r.errorMessage}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
