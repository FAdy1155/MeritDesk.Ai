import { LIBRARY_ADAPTERS } from "./adapters";
import { backfillRank, isLibraryGroupCode } from "./groups";
import type { LibrarySourceAdapter } from "./types";

// The registered collectors (./adapters/index.ts), checked once when this
// module loads. A bad adapter (duplicate code, unknown group, an official URL
// off its host list, a link_only source without its reason) is left out,
// with a message naming it: the worker logs it at startup and never runs
// that source, the probe prints it and exits non-zero, and every other
// collector (and the rest of the worker) keeps running. The web app reads
// library_sources for display; it loads the adapters only to import a file
// by hand (./import-service.ts), which runs the adapter's own parser.

const CODE = /^[a-z][a-z0-9_]{2,62}$/;

/** What is wrong with one adapter (empty when nothing); `seen` holds the codes of the adapters before it. */
function problemsOf(a: LibrarySourceAdapter, seen: Set<string>): string[] {
  const problems: string[] = [];
  if (!CODE.test(a.code)) problems.push("code must be lowercase snake_case, 3 to 63 characters");
  if (seen.has(a.code)) problems.push("an adapter registered earlier has the same code");
  if (!isLibraryGroupCode(a.group)) problems.push(`unknown group "${a.group}" (see src/services/library/groups.ts)`);
  if (!a.name?.trim() || !a.description?.trim() || !a.coverage?.trim() || !a.cadence?.trim()) {
    problems.push("name, description, coverage and cadence are all required");
  }
  if (!a.hosts?.length) problems.push("hosts is empty");
  else if (a.hosts.some((h) => h !== h.toLowerCase() || h.includes("/") || h.includes(":"))) {
    problems.push("hosts are bare lowercase host names (no scheme, port or path)");
  }
  try {
    const url = new URL(a.officialUrl);
    if (url.protocol !== "https:" || !a.hosts?.includes(url.hostname)) problems.push("officialUrl must be https on one of its hosts");
  } catch {
    problems.push("officialUrl is not a URL");
  }
  if (a.license !== "public_domain" && a.license !== "link_only") problems.push("license is public_domain or link_only");
  if (a.license === "link_only" && !a.licenseNote?.trim()) problems.push("a link_only source needs licenseNote (why the text is not stored)");
  const importFields = [a.parseImported, a.manualImportPaths, a.manualImportIntervalDays].filter((f) => f !== undefined).length;
  if (importFields > 0) {
    if (importFields < 3) problems.push("parseImported, manualImportPaths and manualImportIntervalDays go together");
    if (!a.manualImportPaths?.some((p) => p.role === "document")) problems.push("manualImportPaths names no document path");
    if (a.manualImportPaths?.some((p) => p.hosts?.some((h) => !a.hosts?.includes(h)))) problems.push("a manualImportPaths entry names a host off the adapter's hosts");
    if (!Number.isInteger(a.manualImportIntervalDays) || (a.manualImportIntervalDays ?? 0) < 1) problems.push("manualImportIntervalDays is a whole number of days");
  }
  return problems;
}

/** Each misconfigured adapter with what is wrong with it. */
export function adapterProblems(adapters: readonly LibrarySourceAdapter[]): { code: string; problems: string[] }[] {
  const seen = new Set<string>();
  const out: { code: string; problems: string[] }[] = [];
  for (const adapter of adapters) {
    const problems = problemsOf(adapter, seen);
    if (problems.length) out.push({ code: adapter.code || "(no code)", problems });
    seen.add(adapter.code);
  }
  return out;
}

const REJECTED = adapterProblems(LIBRARY_ADAPTERS);
const VALID: readonly LibrarySourceAdapter[] = (() => {
  const seen = new Set<string>();
  return LIBRARY_ADAPTERS.filter((adapter) => {
    const ok = problemsOf(adapter, seen).length === 0;
    seen.add(adapter.code);
    return ok;
  });
})();

/** The adapters left out because they are misconfigured, as messages (logged by the worker, printed by the probe). */
export function rejectedAdapterMessages(): string[] {
  return REJECTED.map((r) => `${r.code}: ${r.problems.join("; ")}`);
}

const BY_CODE = new Map(VALID.map((a) => [a.code, a]));

/** Every correctly configured adapter, in registry order. */
export function listLibraryAdapters(): readonly LibrarySourceAdapter[] {
  return VALID;
}

export function getLibraryAdapter(code: string): LibrarySourceAdapter | null {
  return BY_CODE.get(code) ?? null;
}

/** The required environment variables the adapter is missing (its API keys). */
export function missingEnv(adapter: LibrarySourceAdapter): string[] {
  return (adapter.requiredEnv ?? []).filter((name) => !process.env[name]?.trim());
}

function envList(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * The sources whose sites refused every automated request when they were
 * last tested (docs/LIBRARY_SOURCES.md section 1): the State Department's
 * sites, acf.gov, the USDA nutrition site and unhcr.org. They are kept up to
 * date by hand (Import from official site, /library/import) unless
 * LIBRARY_MANUAL_SOURCES says otherwise.
 */
export const DEFAULT_MANUAL_SOURCES: readonly string[] = [
  "dos_human_rights_reports",
  "dos_religious_freedom_reports",
  "dos_trafficking_reports",
  "dos_visa_bulletin",
  "dos_consular_post_nvc",
  "dos_reciprocity_civil_documents",
  "dos_intercountry_adoption",
  "dos_press_releases_visas",
  "orr_uac_policy_guide",
  "orr_urm_policy_guide",
  "orr_refugee_policy_letters",
  "usda_fns_noncitizen_eligibility",
  "unhcr_rsd_handbook",
];

/**
 * LIBRARY_MANUAL_SOURCES: sources kept up to date by manual import, whose
 * daily run and backfill are skipped (they would fail every day with the
 * site's HTTP 403) and which /library shows as "Manual import". Unset or
 * blank: DEFAULT_MANUAL_SOURCES; "none": no source; otherwise the codes
 * listed (a site that starts letting the collector through is taken off the
 * list to make its source automatic again).
 */
export function isManualSource(code: string): boolean {
  const raw = (process.env.LIBRARY_MANUAL_SOURCES ?? "").trim();
  if (!raw) return DEFAULT_MANUAL_SOURCES.includes(code);
  if (raw.toLowerCase() === "none") return false;
  return envList("LIBRARY_MANUAL_SOURCES").has(code);
}

/** The adapters a person can import by hand (they define parseImported), in registry order. */
export function importableAdapters(): readonly LibrarySourceAdapter[] {
  return VALID.filter((a) => a.parseImported);
}

/** LIBRARY_DISABLED_SOURCES: sources neither run daily nor backfilled in this deployment. */
export function isSourceDisabled(code: string): boolean {
  return envList("LIBRARY_DISABLED_SOURCES").has(code);
}

/**
 * Whether backfill may run for the source: LIBRARY_BACKFILL is not "paused"
 * (the default is on; .env.example pauses it for development machines) and
 * the source is not in LIBRARY_BACKFILL_PAUSED_SOURCES.
 */
export function backfillPausedReason(code: string): string | null {
  if ((process.env.LIBRARY_BACKFILL ?? "on").trim().toLowerCase() === "paused") return "LIBRARY_BACKFILL=paused";
  if (envList("LIBRARY_BACKFILL_PAUSED_SOURCES").has(code)) return "listed in LIBRARY_BACKFILL_PAUSED_SOURCES";
  return null;
}

/** Adapters in backfill order: the adapter's own priority, else its group's place (groups.ts), then registry order. */
export function adaptersInBackfillOrder(): LibrarySourceAdapter[] {
  return VALID.map((a, i) => ({ a, i }))
    .sort(
      (x, y) =>
        (x.a.backfillPriority ?? backfillRank(x.a.group)) - (y.a.backfillPriority ?? backfillRank(y.a.group)) || x.i - y.i
    )
    .map(({ a }) => a);
}

/**
 * The daily run's cron for each source: early morning U.S. Central time,
 * staggered 7 minutes apart from 01:00 through 04:53 and wrapping around, so
 * runs of sources on the same host do not start together and every daily
 * run starts before the 05:00 legal-update check that summarizes what they find.
 */
export function dailyCronFor(code: string): string {
  const index = VALID.findIndex((a) => a.code === code);
  const slot = (Math.max(index, 0) * 7) % (4 * 60);
  return `${slot % 60} ${1 + Math.floor(slot / 60)} * * *`;
}

export const LIBRARY_DAILY_TZ = "America/Chicago";
