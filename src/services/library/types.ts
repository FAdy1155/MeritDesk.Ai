// The contract every library collector implements (docs/LIBRARY.md). One
// adapter per official source, in its group's folder under ./adapters/;
// the framework (./pipeline.ts, ./jobs.ts) schedules it, fetches politely
// through ctx.http, validates and stores what it returns, and keeps the
// run's books. Pure types: no server-only, no database, so adapters and the
// probe script (npm run library:probe) load without either.

import type { LegalUpdateItemType } from "@/services/monitoring/types";
import type { LibraryGroupCode } from "./groups";
import type { FetchExpect, PoliteFetchResult } from "./http/fetch";

export type LibraryLicense = "public_domain" | "link_only";
export type PrecedentialStatus = "precedential" | "non_precedential" | "not_applicable" | "unknown";
export type LibraryTextKind = "full" | "excerpt" | "none";

/** What a document is. Keep to this list; add a value here (one line) if a source needs another. */
export const LIBRARY_DOC_TYPES = [
  "decision", // an administrative decision (BIA, AG, AAO, OCAHO, BALCA, immigration judge)
  "opinion", // a court opinion
  "statute_section",
  "regulation_section",
  "constitution_provision",
  "criminal_code_section",
  "manual_section", // a chapter or section of a manual (USCIS PM, FAM, practice manuals, handbooks)
  "policy_memorandum",
  "policy_alert",
  "web_guidance",
  "form", // a form edition with its instructions
  "fee_schedule",
  "guideline", // poverty guidelines and similar tables
  "designation", // a TPS designation
  "bulletin", // a Visa Bulletin
  "federal_register_document",
  "report", // country conditions, GAO, CRS, OIG
  "legislative_history",
  "treaty",
  "statistics",
  "notice",
  "other",
] as const;
export type LibraryDocType = (typeof LIBRARY_DOC_TYPES)[number];

/** The pace ctx.http gives a request on a busy host: daily runs before backfill. */
export type FetchPriority = "interactive" | "daily" | "backfill";

/** Validators from the last fetch of a document, for a conditional GET. */
export type KnownFetch = {
  /** The URL the stored text was read from (after redirects). */
  url: string;
  etag: string | null;
  lastModified: string | null;
};

export type LibraryGetOptions = {
  expect: FetchExpect;
  /** Byte cap for the body (decompressed); defaults by expect (see ./http/client.ts). */
  maxBytes?: number;
  timeoutMs?: number;
  /** Send If-None-Match / If-Modified-Since when the request reaches known.url. */
  conditional?: KnownFetch | null;
  /**
   * Extra request headers (an API key header, Accept). Sent only to the
   * first URL's host, never across a redirect to another host. Put API keys
   * here, never in the URL: URLs are stored and logged.
   */
  headers?: Record<string, string>;
};

export type LibraryHttpResponse = PoliteFetchResult;

/** The polite HTTP client an adapter gets on ctx: its host list, robots.txt, pacing, retries and byte caps are applied for it. */
export type LibraryHttp = {
  get(url: string, options: LibraryGetOptions): Promise<LibraryHttpResponse>;
  /** GET and decode as text (charset from Content-Type, else UTF-8). */
  getText(url: string, options?: Partial<LibraryGetOptions>): Promise<{ text: string; response: LibraryHttpResponse }>;
  /** GET and parse JSON. */
  getJson<T = unknown>(url: string, options?: Partial<LibraryGetOptions>): Promise<{ data: T; response: LibraryHttpResponse }>;
  /**
   * A conditional GET of a listing page, with the validators saved after the
   * last daily run that stored everything it listed. `unchanged` (HTTP 304)
   * means nothing on the page changed since: return no refs for it. Use it
   * only for leaf listings whose content the adapter does not need when
   * unchanged; backfill and probe runs always get the page.
   */
  getListing(url: string, options?: Partial<LibraryGetOptions>): Promise<{ unchanged: boolean; text: string; response: LibraryHttpResponse }>;
};

export type LibraryAdapterContext = {
  sourceCode: string;
  /** "import": a file a person saved from the official site (./manual-import.ts); ctx.http serves only that file. */
  mode: "daily" | "backfill" | "probe" | "import";
  http: LibraryHttp;
  now: Date;
  /** Aborted when the worker shuts down or the run's time budget is spent. */
  signal: AbortSignal;
  /** A note for the run's record (and the probe's output): what was skipped and why. Deduplicated, capped. */
  note(message: string): void;
  /** An environment variable the adapter declared in requiredEnv or optionalEnv; undefined for any other name. */
  env(name: string): string | undefined;
};

/** One document as a listing names it: enough to fetch it and to tell whether it changed. */
export type DocumentRef = {
  /** Stable identifier within the source: the same document always gets the same one. */
  externalId: string;
  /** What fetchDocument reads (https, on the adapter's host list). */
  url: string;
  /** The listing's title, for logs and the probe. */
  title?: string;
  /**
   * A change signal from the listing (a hash of its caption, link and date
   * line, a revision date). When a stored document has the same fingerprint
   * and was fetched within recheckAfterDays, it is not fetched again.
   * Omit it to fetch every time the ref is listed.
   */
  fingerprint?: string;
  /** Whatever the adapter read from the listing and needs in fetchDocument (JSON-safe values only). */
  listing?: Record<string, unknown>;
  /** Set by the framework: validators from the last fetch, for a conditional GET. */
  known?: KnownFetch | null;
};

export type UpdateListing = {
  refs: DocumentRef[];
  /** Documents the source no longer lists or marks withdrawn: flagged, never deleted. */
  withdrawn?: { externalId: string; reason: string }[];
};

export type BackfillChunk = {
  refs: DocumentRef[];
  /** The cursor for the next chunk; null when the history walk is complete. JSON-safe. */
  nextCursor: unknown | null;
  /** A progress line for the run's record ("volume 27, entries 40-79 of 98"). */
  progress?: string;
};

/** A document exactly as the official source states it. Every field comes from the source, never from a guess. */
export type LibraryDocumentInput = {
  externalId: string;
  docType: LibraryDocType;
  title: string;
  /** The document's own citations as the source writes them; the pipeline normalizes them for lookup. */
  citations: string[];
  court?: string | null;
  agency?: string | null;
  /** YYYY-MM-DD, as stated by the source (the stated text goes in metadata.statedDates). */
  decisionDate?: string | null;
  publishedDate?: string | null;
  effectiveDate?: string | null;
  editionDate?: string | null;
  /** The year the source states, when it gives no full date (a citation's "(BIA 1958)"). */
  documentYear?: number | null;
  precedentialStatus: PrecedentialStatus;
  /** The page or file to cite: https, host on the adapter's list. */
  officialUrl: string;
  /** The file the text came from, when it differs (after redirects). */
  originalUrl?: string | null;
  /** Full text (public domain) or a short excerpt (link_only; the pipeline caps it). */
  text: string;
  /** Default "full"; "none" for a file with no text layer; link_only sources are always stored as "excerpt". */
  textKind?: LibraryTextKind;
  /**
   * Facts the source states: volume, docket, judges, form number, statedDates.
   * `summary`: the headnote, syllabus or summary the source itself prints
   * (searchable, shown above the text). JSON-safe values only.
   */
  metadata?: Record<string, unknown>;
  /** The original file, stored in S3 when LIBRARY_STORE_ORIGINALS is on and the source is public domain. */
  original?: { bytes: Buffer; contentType: string; extension: string } | null;
  /** How it was fetched (from ctx.http's response); stored in fetch_info, not versioned. */
  fetch?: { response: LibraryHttpResponse; extraction?: Record<string, unknown> } | null;
  /** The source says this document is withdrawn, rescinded or archived. */
  withdrawn?: { reason: string } | null;
  /** The source names the document that replaces this one (same source). */
  supersededBy?: { externalId: string; note?: string } | null;
};

export type FetchDocumentResult =
  | { kind: "document"; document: LibraryDocumentInput }
  /** The conditional GET came back 304: the stored copy is current. */
  | { kind: "not_modified" }
  /** Nothing to store for this ref (not a document after all); the reason goes in the run's notes. */
  | { kind: "skip"; reason: string };

/**
 * A kind of page or file a source's collector reads, which staff may import
 * by hand from the official site (./manual-import.ts): the import's address
 * must be https, on `hosts` (default: the adapter's), with a path `path`
 * matches, and the file must be what the collector reads there.
 */
export type ManualImportPath = {
  /** The address's path (pathname, case as the site writes it). */
  path: RegExp;
  /** The hosts this kind is on; default every host of the adapter. */
  hosts?: readonly string[];
  /** What the collector reads at such an address: the page's HTML, or a PDF file. */
  file: "html" | "pdf";
  /**
   * "document": a page or file that becomes one document; "linked": a page
   * or file the collector reads together with a document (the listing page
   * that states a document's number, title or date; a memorandum a page frames).
   */
  role: "document" | "linked";
  /** What it is, in words, for the import page ("A country's report page"). */
  label: string;
};

/** One file a person saved from the official site, with the address it was saved from. */
export type ManualImportFile = {
  /** The official address (https, on the adapter's hosts), as checked by ./manual-import.ts. */
  url: string;
  contentType: "text/html" | "application/pdf";
  bytes: Buffer;
};

/** What parseImported is given: the document's file and, when the person gave one, the linked page or file. */
export type ManualImportInput = ManualImportFile & { linked: ManualImportFile | null };

/** What a library-fed legal update says about a new document (see ./legal-updates.ts). */
export type LibraryLegalUpdateItem = {
  itemType: LegalUpdateItemType;
  /** The same document as the legal-update monitor keys it ("intdec:4259", "fr:2026-01868"). */
  crossSourceKey?: string | null;
  /** Court of appeals number ("5"), for a circuit opinion. */
  circuit?: string | null;
  /** The source's own words the summary step works from (headnote, opening); default: metadata.summary, else the text's opening. */
  excerpt?: string | null;
  /** The date as the source states it. */
  publishedDateText?: string | null;
  /** The listing page the document was found on (default: the adapter's officialUrl). */
  listedOnUrl?: string | null;
};

export interface LibrarySourceAdapter {
  /** Unique, lowercase snake_case, stable forever (it keys stored documents): "eoir_ag_bia_precedents". */
  code: string;
  group: LibraryGroupCode;
  /** Shown on /library under the group. */
  name: string;
  description: string;
  /** What this collector actually holds ("Volumes 8 to 30 as EOIR links them"). */
  coverage: string;
  /** How often it is refreshed, in words ("Daily"). */
  cadence: string;
  /** The official page people would open to see the source. */
  officialUrl: string;
  /** Every https host the adapter may reach (redirect hops included) and every host its official URLs are on. */
  hosts: readonly string[];
  license: LibraryLicense;
  /** Required for link_only: why the text is not stored in full (the source's terms). */
  licenseNote?: string;
  /** API keys the adapter cannot run without; unset, the source is skipped with status needs_key. */
  requiredEnv?: readonly string[];
  /** Variables the adapter may read but can run without. */
  optionalEnv?: readonly string[];
  /** Hours after the last successful run before the source is shown as stale (default 48). */
  staleAfterHours?: number;
  /** Re-fetch a listed, unchanged document after this many days, with a conditional GET (default 30). */
  recheckAfterDays?: number;
  /** Overrides the group's place in the backfill order (lower runs first). */
  backfillPriority?: number;
  /** Most documents one daily run fetches (default 500); the rest wait for the next run. */
  maxDocumentsPerDailyRun?: number;
  /** The daily run: refs to everything new or changed since `since` (the last successful daily run; null before the first). */
  listUpdates(ctx: LibraryAdapterContext, since: Date | null): Promise<UpdateListing>;
  /** One chunk of the source's history, from `cursor` (null for the first chunk). Chunks should take minutes, not hours. */
  backfill(ctx: LibraryAdapterContext, cursor: unknown | null): Promise<BackfillChunk>;
  /** Fetch one document and return it exactly as the source states it. */
  fetchDocument(ctx: LibraryAdapterContext, ref: DocumentRef): Promise<FetchDocumentResult>;
  /**
   * For sources the legal-update feed follows (precedents, opinions, USCIS
   * and EOIR policy, forms, TPS, the Federal Register, the Visa Bulletin):
   * how a document a daily run finds for the first time reads as a legal
   * update, or null to leave it out. Omit for sources the feed does not follow.
   */
  legalUpdateItem?(document: LibraryDocumentInput): LibraryLegalUpdateItem | null;
  /**
   * Sources whose sites refuse automated tools (docs/LIBRARY_SOURCES.md
   * section 1) can be imported by hand: a platform operator saves the page
   * or file in a browser and gives it with its official address. The three
   * fields below go together (registry.ts checks it).
   *
   * The pages and files an import may name, and what the collector reads at each.
   */
  manualImportPaths?: readonly ManualImportPath[];
  /** About how often the source publishes something to import; past it, /library shows the source as overdue. */
  manualImportIntervalDays?: number;
  /**
   * Turns an imported file into the document the automatic collector would
   * have stored from the same address: build the ref fetchDocument would get
   * (its externalId and listing facts, from the address, the page, or the
   * linked listing page) and call fetchDocument. `ctx.http` serves only the
   * imported file and the linked one, at their addresses; any other request
   * fails. Return a skip with the reason when the file is not one of this
   * source's documents.
   */
  parseImported?(ctx: LibraryAdapterContext, input: ManualImportInput): Promise<FetchDocumentResult>;
}

/** Thrown by an adapter when a listing's layout is not the one it reads: the run fails instead of passing for a quiet day. */
export class LibraryLayoutError extends Error {
  constructor(url: string, detail?: string) {
    super(
      `The page at ${url} no longer has the layout this collector reads${detail ? ` (${detail})` : ""}, so nothing from it was used. The collector needs updating.`
    );
    this.name = "LibraryLayoutError";
  }
}
