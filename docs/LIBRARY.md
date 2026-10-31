# The library

The app keeps its own library of the public, official sources of immigration
law: decisions, statutes, regulations, manuals, guidance, reports and the
Visa Bulletin, collected directly from the government and court sites and
refreshed every day. Skill runs search and read it with their library tools,
attorneys browse it at `/library`, and new documents from the sources the
legal-update feed follows reach `/updates`.

The firm decided the app must not depend on any third-party legal research
service. The list of sources to cover was taken once from such a service's
public catalog (its 25 groups are on `/library`, in its order and words);
nothing is fetched from that service, linked to it or derived from its data.
Every document comes from the official source, with its official URL.

Scope: every group on `/library` except state penal codes and state court
decisions on criminal statutes, which are shown as planned and not collected.
Federal criminal provisions (Title 18, the Title 21 schedules) and EOIR's
court and judge statistics are in scope.

This file is the guide for writing a collector (an adapter). Follow it
literally: a collector is a self-contained folder plus two lines in one
shared list. Section 12 lists every registered source, with what it holds
and how it fared in the last live test; section 13 is the EOIR statistics.

## 0. Checklist for a new collector

| # | File | Action |
|---|------|--------|
| 1 | `src/services/library/adapters/<group>/<source>.ts` | create: one `LibrarySourceAdapter` per official source |
| 2 | `src/services/library/adapters/<group>/parse.ts` (optional) | create: the page parsers, pure, so they can be tried on saved pages |
| 3 | `src/services/library/adapters/<group>/index.ts` | create (or add to): `export const <camelGroup>Adapters = [ ... ]` |
| 4 | `src/services/library/adapters/index.ts` | add 1 import line and 1 spread line, alphabetical by folder name |
| 5 | `npm run library:probe -- <code>` | run it live: listing, a few documents, the fields that would be stored |
| 6 | `npm run typecheck`, `npx eslint src` | clean |

`<group>` is the group's code from `src/services/library/groups.ts` (for
example `bia-ag-precedents`, `circuit-courts`, `uscis-policy-manual`). Several
sources can share a group folder (each circuit is its own adapter in
`circuit-courts/`), and a folder can hold a family of sources that spans
groups (`statutes-regs/`, `uscis-policy/`, `federal-courts/`): what places a
source on `/library` is its adapter's `group` field, never its folder. Do
not edit `types.ts`, `pipeline.ts`, `store.ts`, `search.ts`, `jobs.ts`,
`http/`, `extract/` or another group's folder; if the
framework lacks something you need, say so in your hand-off instead of
working around it. The one exception is a value missing from
`LIBRARY_DOC_TYPES` in `types.ts`: add it there (one line).

## 1. What the framework does for you

```
src/services/library/
  types.ts           the adapter contract (this file, section 2)
  groups.ts          the 26 groups (25 catalog groups plus EOIR statistics), backfill order
  registry.ts        validates the registered adapters, env keys, pausing, daily schedule
  adapters/          one folder per group; adapters/index.ts is the only shared list
  http/fetch.ts      politeFetch: https, host allow list per hop, robots.txt, pacing, retries, byte caps
  http/host-gate.ts  one request in flight per host, spaced by the default or the Crawl-delay
  http/robots.ts     RFC 9309 robots.txt parsing and matching
  http/client.ts     the ctx.http an adapter gets
  extract/html.ts    HTML to clean document text, plus anchors(), tableRows(), resolveUrl()
  extract/pdf.ts     PDF text with pdf.js in a worker thread (pdftotext fallback on the worker image)
  text.ts            cleanText(), excerpt(), sha256Hex(), repairMojibake()
  citations.ts       citation finding and normalization (I&N Dec., U.S., F., U.S.C., C.F.R., INA, ...)
  prepare.ts         validates and normalizes what fetchDocument returns
  store.ts           the writes: sources, runs, documents (versions, citations), backfill state
  pipeline.ts        runDaily(), runBackfillChunk()
  manual-import.ts   import from the official site: checks, the adapter's parseImported, the versioned upsert, the import log
  import-service.ts  who may import (LIBRARY_IMPORT_ADMINS) and the /library/import page's data (web app only)
  legal-updates.ts   the feed into legal_updates
  search.ts          searchLibrary(), lookupCitation(), readDocument()
  jobs.ts            pg-boss queues and schedules (registerLibraryJobs)
  country.ts         country keys for the country filter (metadata.countryKeys)
  cli/probe.ts       npm run library:probe
  cli/smoke.ts       npm run library:smoke (every source live, no database)
  cli/db-check.ts    npm run library:db-check (PGlite)
```

For every run, the pipeline:

1. calls your `listUpdates` (daily) or `backfill` (one chunk) for refs;
2. skips a ref whose stored document has the same `fingerprint` and was
   fetched within `recheckAfterDays`;
3. calls your `fetchDocument` for the rest, passing the stored copy's
   validators in `ref.known` for a conditional GET;
4. validates and normalizes the result (`prepare.ts`): https official URL on
   your hosts, real dates, clean text, a short excerpt only for `link_only`
   sources, citations normalized for lookup and the citations in the text
   collected for "cited by" counts;
5. stores it (`store.ts`): inserted as version 1, or a new version when
   anything the source states changed (the old state kept in
   `library_document_versions`), or only its check time updated;
6. for a daily run after the source's first successful one, feeds new
   documents to the legal updates when your adapter defines
   `legalUpdateItem`;
7. records the run in `library_fetch_runs` (counts, notes, per-document
   failures) and the source's standing in `library_sources`.

One document's failure never fails a run: it is recorded, and in backfill
retried before later chunks (up to 3 attempts). A listing that cannot be read
or parsed fails the run, and `/library` shows the source as failing.

## 2. The adapter contract (`types.ts`)

```ts
export interface LibrarySourceAdapter {
  code: string;                 // unique, lowercase snake_case, stable forever: it keys stored documents
  group: LibraryGroupCode;      // from groups.ts
  name: string;                 // shown on /library under the group
  description: string;          // one or two sentences, your own words
  coverage: string;             // what this collector actually holds, honestly ("Volumes 8 to 30 as EOIR links them")
  cadence: string;              // "Daily", "Monthly, when the State Department posts it"
  officialUrl: string;          // the official page people would open to see the source
  hosts: readonly string[];     // every https host fetched (redirect hops included) and every host official URLs are on
  license: "public_domain" | "link_only";
  licenseNote?: string;         // required for link_only: why the text is not stored (the source's terms)
  requiredEnv?: readonly string[];   // API keys; unset, the source is skipped and shown as "Needs API key"
  optionalEnv?: readonly string[];
  staleAfterHours?: number;     // default 48; set it from the cadence (a monthly source: 24 * 40)
  recheckAfterDays?: number;    // default 30: re-fetch a listed, unchanged document with a conditional GET
  backfillPriority?: number;    // overrides the group's place in the backfill order
  maxDocumentsPerDailyRun?: number;  // default 500
  listUpdates(ctx, since: Date | null): Promise<UpdateListing>;
  backfill(ctx, cursor: unknown | null): Promise<BackfillChunk>;
  fetchDocument(ctx, ref: DocumentRef): Promise<FetchDocumentResult>;
  legalUpdateItem?(document: LibraryDocumentInput): LibraryLegalUpdateItem | null;
  // Sources whose sites refuse automated tools (section 2.6); the three go together:
  manualImportPaths?: readonly ManualImportPath[];
  manualImportIntervalDays?: number;
  parseImported?(ctx, input: ManualImportInput): Promise<FetchDocumentResult>;
}
```

### 2.1 `listUpdates(ctx, since)`: the daily run

Return refs to everything new or changed at the source since `since` (the
start of the last successful daily run; `null` before the first). Read the
source's "what's new" page, feed, sitemap or API with a date filter when it
has one; otherwise list the current listing and let fingerprints skip what
is unchanged. A source with no notion of "new" (a manual) lists its whole
table of contents every day: the fingerprints make that cheap.

```ts
type UpdateListing = {
  refs: DocumentRef[];
  withdrawn?: { externalId: string; reason: string }[];  // flagged, never deleted
};

type DocumentRef = {
  externalId: string;           // stable within the source: the same document always gets the same id
  url: string;                  // what fetchDocument reads (https, on your hosts)
  title?: string;               // for logs and the probe
  fingerprint?: string;         // a hash of what the listing says about it (caption, link, date line)
  listing?: Record<string, unknown>;  // what fetchDocument needs from the listing (JSON-safe values only)
  known?: KnownFetch | null;    // set by the pipeline: the stored copy's validators
};
```

Choosing `externalId`: the source's own identifier when it has one (an
Interim Decision number, a docket and opinion file, a form number and
edition, a CFR section, a Federal Register document number); otherwise the
URL path. Never a position on a page, never something that changes when the
document is corrected. Changing how an adapter builds ids later duplicates
every document, so get it right first.

Choosing `fingerprint`: hash what the listing says about the document
(`sha256Hex(...).slice(0, 32)` from `text.ts`), so a corrected caption, a new
file link or a new revision date is fetched again and an untouched entry is
not. Omit it to fetch every listed ref every time (only for small listings).

### 2.2 `backfill(ctx, cursor)`: the history walk

Return one chunk of the source's history and the cursor for the next one
(`null` when done). The cursor is yours: any JSON (a page number, a date, a
list of volumes left and an offset). It is saved only after every ref in the
chunk was attempted, so an interrupted chunk is run again, and what it
already stored is skipped by its fingerprint.

```ts
type BackfillChunk = { refs: DocumentRef[]; nextCursor: unknown | null; progress?: string };
```

Size a chunk to finish in well under `LIBRARY_BACKFILL_CHUNK_MINUTES` (50 by
default), counting the host's pace: on a host whose robots.txt asks for 10
seconds, with one redirect per file, a document costs about 20 seconds, so
about 40 documents fit in a 15-minute chunk. Walk newest first unless the
source makes that impossible: the newest material is the most useful. Make
`backfill(ctx, null)` work from the current state of the source (read its
index), and tolerate a cursor that no longer matches it (a volume removed:
note it and move on).

### 2.3 `fetchDocument(ctx, ref)`: one document

Fetch the document and return it exactly as the source states it:

```ts
type FetchDocumentResult =
  | { kind: "document"; document: LibraryDocumentInput }
  | { kind: "not_modified" }               // your conditional GET came back 304
  | { kind: "skip"; reason: string };      // not a document after all (noted on the run)

type LibraryDocumentInput = {
  externalId: string;
  docType: LibraryDocType;       // decision, opinion, statute_section, regulation_section, manual_section, ...
  title: string;
  citations: string[];           // the document's own citations, as the source writes them
  court?: string | null;         // "Board of Immigration Appeals", "United States Court of Appeals for the Fifth Circuit"
  agency?: string | null;        // "U.S. Citizenship and Immigration Services"
  decisionDate?: string | null;  // YYYY-MM-DD, only when the source states it
  publishedDate?: string | null;
  effectiveDate?: string | null;
  editionDate?: string | null;
  documentYear?: number | null;  // a year the source states when it gives no full date
  precedentialStatus: "precedential" | "non_precedential" | "not_applicable" | "unknown";
  officialUrl: string;           // the page or file to cite: https, on your hosts
  originalUrl?: string | null;   // the file the text came from, when it differs (after redirects)
  text: string;                  // full text (public domain); for link_only the pipeline keeps an excerpt
  textKind?: "full" | "excerpt" | "none";   // "none": the file has no text layer
  metadata?: Record<string, unknown>;       // facts the source states; `summary`: its headnote or syllabus
  original?: { bytes: Buffer; contentType: string; extension: string } | null;  // stored when LIBRARY_STORE_ORIGINALS
  fetch?: { response: LibraryHttpResponse; extraction?: Record<string, unknown> } | null;
  withdrawn?: { reason: string } | null;
  supersededBy?: { externalId: string; note?: string } | null;
};
```

Rules, all enforced or checked somewhere, none optional:

- **Never invent.** Every field comes from the official source as fetched. A
  date that does not parse, or that you cannot tell is the decision date, is
  left null; the stated text goes in `metadata.statedDates` (and
  `prepare.ts` sets aside a decision or publication date later than the day
  the document was read, a typo at the source, naming it in
  `metadata.datesSetAside`). A title is the
  source's own; the conventional "Matter of" before an EOIR caption is the
  only addition the BIA adapter makes, and the caption as listed is kept in
  `metadata.listedName`. Never build a URL the source does not publish: take
  links from the page (`resolveUrl` against the page's final URL).
- **Precedential status** as the source states it: unpublished BIA decisions,
  AAO non-precedent decisions and unpublished court opinions are
  `non_precedential`; a statute, regulation or manual is `not_applicable`;
  `unknown` when the source does not say.
- **`metadata.summary`** holds the headnote, syllabus or summary the source
  itself prints, verbatim. It is searchable (weighted above the body text),
  shown above the text, and fed to the legal-update summaries. Never put a
  summary you wrote there.
- **Text** as clean text: `htmlToDocumentText()` for HTML (slice the page's
  content container first; `mainContent()` when there is no better one),
  `extractPdfText()` for PDFs (it keeps `[Page N]` markers). Do not cut it:
  the pipeline stores it whole and indexes the first 200,000 characters.
- **Pass `fetch: { response }`** from the response you read, so the stored
  copy keeps its validators (conditional requests later) and its size and
  hash.
- **`original`**: pass the file's bytes for PDFs and other files, so they are
  stored when `LIBRARY_STORE_ORIGINALS` is on (never for `link_only`).

### 2.4 `legalUpdateItem(document)`: the legal-update feed

Define it only for sources the feed follows: BIA and AG precedents, the
circuits, the Supreme Court, the USCIS Policy Manual, USCIS alerts and policy
memoranda, USCIS forms, TPS, EOIR memoranda and manuals, the Federal
Register, the Visa Bulletin. It turns a document a daily run finds for the
first time into a legal update, or returns null to leave it out:

```ts
type LibraryLegalUpdateItem = {
  itemType: LegalUpdateItemType;   // "BIA precedent", "Court of appeals published opinion", "Supreme Court opinion", ...
  crossSourceKey?: string | null;  // how the legal-update monitor keys the same document: "intdec:4259", "fr:2026-01868"
  circuit?: string | null;         // "5" for a Fifth Circuit opinion (adds the routing weight line)
  excerpt?: string | null;         // the source's own words to summarize from; default: metadata.summary, else the text's opening
  publishedDateText?: string | null;
  listedOnUrl?: string | null;     // the listing page; default: the adapter's officialUrl
};
```

The feed starts after the source's first successful daily run (the
baseline), never from backfill, and skips a document the monitor already
recorded (same official URL or cross-source key). The legal-update check at
05:00 Central summarizes it like any other item.

### 2.5 The context (`ctx`)

| Member | What it is |
|--------|-----------|
| `ctx.http.get(url, { expect, maxBytes?, timeoutMs?, conditional?, headers? })` | the polite fetch (section 4); `expect` is `html`, `xml`, `json`, `pdf`, `text` or `any` |
| `ctx.http.getText(url, options?)` | GET and decode (charset from the response, else UTF-8): `{ text, response }` |
| `ctx.http.getJson(url, options?)` | GET and parse JSON: `{ data, response }` |
| `ctx.http.getListing(url, options?)` | a conditional GET of a leaf listing page, with the validators saved after the last complete daily run: `{ unchanged, text, response }`; on `unchanged` return no refs for that page |
| `ctx.note(message)` | a note on the run's record (and in the probe's output): what was skipped and why |
| `ctx.env(name)` | an environment variable you declared in `requiredEnv` or `optionalEnv`; undefined for any other |
| `ctx.signal` | aborted at worker shutdown or when the run's time budget is spent; pass it to anything long |
| `ctx.mode` | `daily`, `backfill`, `probe`, or `import` (a file a person imported, section 2.6) |
| `ctx.now` | the run's start |

`response` (`LibraryHttpResponse`) has `url` (after redirects),
`requestedUrl`, `redirects`, `status`, `notModified`, `contentType`,
`charset`, `body` (a Buffer), `sha256`, `etag`, `lastModified`, `retrievedAt`.

Errors: throw `LibraryLayoutError(url, detail)` when a listing's layout is not
the one you parse (never return an empty listing for a page you could not
read: that passes for a quiet day). Fetch errors (`OfficialFetchError`) and
`PdfExtractionError` can be left to propagate; the pipeline records them with
a safe message.

### 2.6 Import from the official site: `parseImported(ctx, input)`

Some official sites refuse every automated tool (Cloudflare, Akamai, AWS
WAF). The library never gets around that; instead a platform operator
opens the page in a browser, saves it, and gives the app the file with its
official address (`/library/import`, `manual-import.ts`; who may do it:
README "The library"). A source supports this with three fields:

- `manualImportPaths`: the page and file kinds an import may name, each a
  path pattern (on `hosts`, default the adapter's), the file the collector
  reads there (`html` or `pdf`), its role and a label for the form.
  `document` paths become documents; `linked` paths are pages or files the
  collector reads with a document (the listing page that states a document's
  number, title or date; the memorandum a page frames).
- `manualImportIntervalDays`: about how often the source publishes
  something to import. For a source in `LIBRARY_MANUAL_SOURCES` it is the
  staleness threshold, so `/library` shows it overdue past that.
- `parseImported(ctx, { url, contentType, bytes, linked })`: build the ref
  fetchDocument would get for that address (its externalId exactly as the
  listing builds it, and the listing facts the address, the page itself or
  the linked listing page state) and call your own `fetchDocument` with the
  ctx you were given. In that ctx (`ctx.mode === "import"`), `ctx.http`
  serves only the imported file and the linked one, at their addresses (a
  trailing slash aside), as a 200 with no validators and under the same
  byte caps as a fetch; any other request fails with a message telling the
  person which page or file the collector also needs. Return a skip with
  the reason when the file is not one of the source's documents (a listing
  that does not link it, a release the source's filter leaves out); never
  fill a listing fact the import does not have with a guess, leave it out.

Before `parseImported` runs, `manual-import.ts` has checked the address
(https, on the hosts, a `manualImportPaths` path), the file (HTML or PDF by
its own bytes, a PDF with its end-of-file marker, an HTML page that ends
with `</html>`, at most 9 MB) and, for a page, that it is not an Internet
Archive copy and that neither the browser's "saved from" mark nor the
page's canonical link names another address. After it, the result goes
through `prepare.ts` and the store's versioned upsert like a fetched one,
with `metadata.importedManually = { by, at, fileSha256 }` (and the linked
file's address and hash). The store leaves `importedManually` out when it
compares versions, so importing the same page again, or the daily run later
reading it, is "unchanged". Each import is a `library_fetch_runs` row of
kind `manual_import`, and each attempt, refused ones included, a
`library_import_log` row. Imports do not feed the legal updates.

The 13 sources of `docs/LIBRARY_SOURCES.md` section 1 implement it.
`npm run library:db-check` imports a fixture page through a fixture
source's parseImported and checks the provenance, the versions, the
refusals and the append-only log. When the import was built, archived
official pages (the June 2026 Visa Bulletin and the 2024 China human rights
report) were imported and compared with what fetchDocument stores from the
same bytes: the same document, the same priority-date rows.

## 3. Registry convention

- One folder per group (`src/services/library/adapters/<group>/`, named as
  the group's code) or per family of sources that spans groups (section 0);
  each adapter's `group` field places it.
- Its `index.ts` exports the group's adapters, nothing else:

  ```ts
  // Federal circuit court opinions.
  import type { LibrarySourceAdapter } from "../../types";
  import { ca5Adapter } from "./ca5";
  import { ca9Adapter } from "./ca9";

  export const circuitCourtsAdapters: readonly LibrarySourceAdapter[] = [ca5Adapter, ca9Adapter];
  ```

- `src/services/library/adapters/index.ts` is the only shared list: one
  import line and one spread line per group, both in alphabetical order by
  folder name, so collectors added in parallel land on different lines:

  ```ts
  import { biaAgPrecedentsAdapters } from "./bia-ag-precedents";
  import { circuitCourtsAdapters } from "./circuit-courts";

  export const LIBRARY_ADAPTERS: readonly LibrarySourceAdapter[] = [
    ...biaAgPrecedentsAdapters,
    ...circuitCourtsAdapters,
  ];
  ```

- `registry.ts` checks every adapter when it loads (unique code, a known
  group, hosts as bare lowercase names, an https official URL on its hosts,
  a `licenseNote` for `link_only`). A misconfigured adapter is left out with
  a message naming it and what is wrong (the worker logs it as `[library]
  collector left out, misconfigured`, the probe prints it and exits
  non-zero); the other collectors and the rest of the worker keep running.
- Adapter modules import only `../../types`, `../../extract/*`,
  `../../text`, `../../citations`, `../../country`,
  `@/services/monitoring/parse/dates` (`parseStatedDate`), Node built-ins
  that do no I/O (`node:zlib` to read a ZIP or .docx), pure helpers of their
  own, and types. Never `@/db/*`, the store or the pipeline: the probe runs
  adapters without a database. One folder holds more than collectors:
  `adapters/eoir-statistics/` also holds the statistics load, store,
  queries, jobs and skill tools (section 13), which use the database; its
  collector (`eoir-case-data.ts`) and the pure readers it shares with the
  load (`parse.ts`, `zip.ts`, `release.ts`) import none of them.

## 4. Politeness (`http/fetch.ts`)

Every request an adapter makes goes through `ctx.http`, which:

- identifies the collector: `MeritDeskAI-Library/1.0 (...)`,
  with `LIBRARY_USER_AGENT_CONTACT` appended when set;
- fetches https only, from your `hosts` only, checking every redirect hop
  (at most 5); extra `headers` (an API key) go to the first URL's host only,
  never across a redirect to another host. Put API keys in headers, never in
  URLs: URLs are stored and logged (anything that looks like a key is
  redacted, but do not rely on it);
- honors robots.txt for every URL (RFC 9309: the group for our product
  token, else `*`; longest match wins; a robots.txt that answers 5xx or
  cannot be reached blocks the host for 10 minutes; a 4xx allows all,
  whatever the size of its body), cached a day per host and robots token
  (the library and the legal-update monitor crawl under different tokens in
  one worker, so a group naming one of them never decides what the other
  may fetch; the host is paced at the longest Crawl-delay asked of either). One exception, in
  `fetch.ts` (`ROBOTS_5XX_IS_ABSENT_HOSTS`): api.govinfo.gov, a keyed API
  that answers its robots.txt path with its own HTTP 500 error, is treated
  as having no robots.txt while that path answers 5xx (RFC 9309 2.3.1.4); a
  robots.txt it does serve is honored;
- paces each host: one request in flight, about one per second by default
  (`LIBRARY_HOST_SPACING_MS`), raised to the robots.txt Crawl-delay (capped at
  10 minutes; gao.gov asks for 7), doubled for 10 minutes after a 429 or
  503; the pace is shared by every job in the worker, and a daily run's
  request goes before a waiting backfill request on the same host. The wait
  for the host's turn is not part of a request's timeout;
- retries 429 and 503 after their Retry-After (up to
  `LIBRARY_MAX_RETRY_AFTER_SECONDS`, 300) or with backoff, and 500, 502, 504,
  timeouts and network errors with backoff, up to 4 attempts;
- caps the body (decompressed): HTML 15 MB, JSON 50 MB, PDF
  `LIBRARY_MAX_PDF_MB` (60), and checks the content type against `expect`
  (a PDF must start with `%PDF-`);
- sends `If-None-Match` / `If-Modified-Since` when `conditional` names the
  URL the request reaches, and reports a 304 as `notModified`.

Prefer a source's API or feed over scraping when it has one, ask for only
what you need (a date filter, a page size), and never fetch the same page
twice in a run.

## 5. Licensing

US federal government works are in the public domain: store the full text
(`license: "public_domain"`). This covers the federal courts, EOIR, USCIS,
DHS, DOJ, the State Department, the Federal Register, GovInfo, GAO, CRS and
the other federal agencies.

Anything not clearly public domain is `link_only`: UNHCR publications, the
Canadian IRB, the UK Home Office's notes, EUAA reports, commercial or
foreign publishers, and any source whose terms restrict reuse. Set
`licenseNote` to the reason in a sentence ("UNHCR's terms of use permit
links and brief quotation, not reproduction."), and explain it in a comment
in your adapter with a link to the terms. For a `link_only` source the
pipeline keeps the metadata, a short excerpt (1,500 characters at most,
cut at a sentence) and the official link, never the original file, whatever
the adapter returns. When the terms are unclear, choose `link_only` and say
so in your hand-off.

## 6. A worked example: AG and BIA precedent decisions

`adapters/bia-ag-precedents/` is the reference adapter; read it alongside
this section.

- `parse.ts`, pure:
  - `parseVolumeIndex(html, url)` reads the volume links from
    https://www.justice.gov/eoir/ag-bia-decisions (the AG/BIA list ends
    where the OCAHO list starts);
  - `parseVolumePage(html, url)` reads one volume page in either of its two
    layouts (older volumes: one table with a row per decision; newer: a
    table per decision followed by its official headnote), as entries of
    Interim Decision number, caption, citation, PDF link and headnote;
  - `parseDecisionHeader(text)` finds the "Decided <date>" line, and
    `citationParenthetical(citation)` the issuer and year in "(BIA 1958)".
- `eoir-ag-bia-precedents.ts`:
  - `listUpdates`: the index, then the two highest volumes (so the end of a
    volume is covered when a new one opens); refs keyed `ID <number>`, with
    a fingerprint over caption, citation, link and headnote;
  - `backfill`: every volume the index links, highest first, 40 entries per
    chunk (justice.gov asks for 10 seconds between requests, and each link
    redirects once); the cursor is `{ volumes: number[], offset }`;
  - `fetchDocument`: the PDF (conditional when it was fetched before), its
    text with pdf.js, the decision date only when it parses and its year
    agrees with the citation's (older volumes' text layers are OCR and can
    read "Juno 25, 19.78"), `textKind: "none"` for a scan with no text layer,
    the headnote in `metadata.summary`, the volume and Interim Decision
    number in `metadata`;
  - `legalUpdateItem`: "AG precedent" or "BIA precedent" from the citation's
    parenthetical, cross-source key `intdec:<number>` (the monitor's own key
    for the same decision), the headnote as the excerpt.

A minimal adapter for an HTML source, to copy from:

```ts
import { anchors, htmlToDocumentText, resolveUrl } from "../../extract/html";
import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { sha256Hex } from "../../text";
import { LibraryLayoutError, type DocumentRef, type LibrarySourceAdapter } from "../../types";

const INDEX = "https://www.example.gov/memos";   // the official listing page
const HOSTS = ["www.example.gov"] as const;

async function listAll(ctx: Parameters<LibrarySourceAdapter["listUpdates"]>[0]): Promise<DocumentRef[]> {
  const { text, response } = await ctx.http.getText(INDEX, { expect: "html" });
  const body = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(text)?.[1];
  if (!body) throw new LibraryLayoutError(INDEX, "no <main>");
  return anchors(body)
    .filter((a) => /\/memos\/[\w-]+$/.test(a.href))
    .map((a) => {
      const url = resolveUrl(a.href, response.url)!;
      return { externalId: new URL(url).pathname, url, title: a.text, fingerprint: sha256Hex(`${a.text}|${url}`).slice(0, 32), listing: { title: a.text } };
    });
}

export const exampleMemosAdapter: LibrarySourceAdapter = {
  code: "example_memos",
  group: "other-agency-guidance",
  name: "Example agency policy memoranda",
  description: "Policy memoranda the agency publishes on its memoranda page.",
  coverage: "Every memorandum the page lists.",
  cadence: "Daily",
  officialUrl: INDEX,
  hosts: HOSTS,
  license: "public_domain",
  async listUpdates(ctx) {
    return { refs: await listAll(ctx) };
  },
  async backfill(ctx) {
    // The page lists everything, so one chunk is the whole history.
    return { refs: await listAll(ctx), nextCursor: null, progress: "the whole listing" };
  },
  async fetchDocument(ctx, ref) {
    const { text, response } = await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(text)?.[1];
    if (!main) return { kind: "skip", reason: `${ref.url} has no <main>` };
    const dateLine = /Issued:\s*([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(main)?.[1] ?? null;
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "policy_memorandum",
        title: String(ref.listing?.title ?? ref.title ?? ref.url),
        citations: [],
        agency: "Example Agency",
        publishedDate: parseStatedDate(dateLine),
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        text: htmlToDocumentText(main),
        metadata: dateLine ? { statedDates: { issued: dateLine } } : {},
        fetch: { response },
      },
    };
  },
};
```

## 7. Testing a collector

### Live, without a database: `npm run library:probe`

```bash
npm run library:probe                                          # lists the registered sources
npm run library:probe -- eoir_ag_bia_precedents                # the daily listing, then 3 documents
npm run library:probe -- eoir_ag_bia_precedents --limit 0      # the listing only
npm run library:probe -- eoir_ag_bia_precedents --mode backfill --cursor '{"volumes":[8],"offset":0}' --limit 2
npm run library:probe -- eoir_ag_bia_precedents --ref "ID 4258" --text 2000
```

Options: `--mode daily|backfill`, `--cursor <json>` (backfill; default the
first chunk), `--since YYYY-MM-DD` (daily), `--limit N` documents to fetch
(default 3), `--ref <externalId>`, `--text N` characters of text to print
(default 600), `--list` every ref. It prints the listing (ids, titles, URLs,
fingerprints, repeated ids), then for each document every field that would
be stored, after the same checks the pipeline runs (`prepare.ts`): title,
type, citations and their normalized forms, court, dates, precedential
status, official and original URL, text length and opening, the citations
found in the text, metadata, fetch information, the original file, and the
legal-update item. A document that fails the checks is reported and the
probe exits non-zero. Requests are paced and honor robots.txt exactly as in
production, so a probe on justice.gov or uscis.gov takes 10 seconds per
request. Nothing is written anywhere.

Before handing a collector over, probe at least: the daily listing; the
first backfill chunk and one from the far end of the history (old layouts
differ); a document of each kind the source has; and a cursor that no longer
matches the source, if your cursor can go stale.

### Every source at once, live, without a database: `npm run library:smoke`

```bash
npm run library:smoke -- --out smoke.json                  # every registered source
npm run library:smoke -- uscis_tps eoir_icpm --docs 3      # only these
```

For each source: the daily listing (`--since`, default three days ago), the
first backfill chunk (`backfill(ctx, null)`), and `--docs` documents (2 by
default; a ref the collector skips is replaced by the next one) fetched and
checked as the pipeline checks them. Sources run as in the worker: one at a
time per first host, hosts in parallel, all through the same paced client,
so the run takes as long as its busiest host (more than an hour with
uscis.gov and justice.gov at 10 seconds a request). A source missing its API
key is reported `needs_key` and not run. Each source ends `ok` (both
listings read, every fetched document passed), `partial` or `failed`; the
JSON report (`--out`) keeps each listing's size, cursor and error and each
document's title, type, official URL, text size, dates and citations.

### The store and search, without a Postgres server: `npm run library:db-check`

Applies every migration to PGlite (Postgres in WebAssembly, in memory) and
checks row-level security, the pipeline and store (versions, citations,
skip by fingerprint, backfill chunks and retries, the legal-update feed and
its deduplication, a text of 1.2 million characters) and the search, lookup
and reader queries, with a throwaway fixture source.
`npm run library:db-check -- --live 3` also runs the BIA and AG adapter
live for three decisions and searches them, and
`--live-source <code>[:N]` (repeatable) does the same for any registered
source: N documents (default 2) stored by a real daily run, each read back,
found by a word of its title and looked up by its first citation, then a
second daily run that must insert nothing. Run it after changing anything
in `store.ts`, `search.ts`, `prepare.ts` or the migration.

## 8. Data model (migrations 0007 to 0011)

All global (no tenant column): every context may read, only service
context may write (RLS enabled and forced, as for `legal_updates`).

| Table | One row per | Notes |
|-------|-------------|-------|
| `library_sources` | registered adapter | display text (synced from the adapter at worker start), license, status (`pending`, `ok`, `partial`, `failed`, `needs_key`, `disabled`), last success and attempt, last error, document count, `freshness` (stale threshold, latest document date, last daily run, backfill progress), legal-update baseline |
| `library_documents` | document | unique `(source_code, external_id)`; title, citations, court, agency, decision/published/effective/edition dates, stated year, precedential status, official and original URL, original file key, text (full or excerpt), `text_sha256`, `metadata`, `fetch_info`, listing fingerprint, version, first seen, last checked, last changed, withdrawn and superseded fields, and `search_vector` |
| `library_document_versions` | replaced state | the text and metadata a document had before it changed |
| `library_citations` | (document, relation, normalized citation) | `self`: the document is this authority (lookup); `cites`: its text cites it (at most 400 per document) |
| `library_fetch_runs` | run | kind (`daily`, `backfill`, `manual_import`), status, counts, notes, failures (capped), cursor before and after |
| `library_backfill_state` | source | cursor, status (`pending`, `retrying`, `complete`, `failed`), chunks and documents done, refs to retry |
| `library_http_cache` | (source, listing URL) | ETag and Last-Modified saved after a complete daily run, for `getListing`; two sources reading one page keep their own |
| `library_import_log` | import attempt (section 2.6) | source, the operator's Clerk user id and the firm they were signed in to, official and linked addresses, file SHA-256 and size, outcome (`inserted`, `updated`, `unchanged`, `rejected`, `failed`), error, document, version and run. Append-only: every context may read it, service context may insert, and no policy allows UPDATE or DELETE |

Migration 0010 adds the manual import: the `manual` source status, the
`manual_import` run kind and `library_import_log`. Migration 0008 adds the EOIR statistics tables (section 13), and 0009 the
GIN index behind the country filter (`metadata -> 'countryKeys'`).
Migration 0011 adds `library_documents_newest_idx`, the order of a search
with filters and no words (newest first).

Search: `search_vector` is kept by a trigger: title and citations weight A,
`metadata.summary` B, court and agency C, the first 200,000 characters of
the text D (a tsvector is limited to 1 MB; the text is stored whole, in
TOAST). GIN indexes on it, on titles (`gin_trgm_ops`), on normalized
citations (`gin_trgm_ops`) and on `metadata -> 'countryKeys'`
(`jsonb_path_ops`). The country filter matches a country name or alias
(`country.ts`: "Myanmar" finds Burma) against `metadata.countryKeys`, which
the country-conditions collectors write and `prepare.ts` derives for any
other document that states `metadata.country` (TPS, reciprocity, adoption). `searchLibrary` uses `websearch_to_tsquery`,
ranks with `ts_rank_cd` (a query that states a citation puts that document
first) and snippets with `ts_headline`; with no word match it falls back to
title similarity. When more than `RANK_CAP` (5,000) documents match after
the filters, ranking them would read every match's vector, so they are
listed newest first instead (a citation match still first) and the result's
`order` is `date`; the search page and `search_library` say so. Every
read runs in `withGlobalReadContext` with a transaction-local
`statement_timeout`: 5 seconds for a search (`LIBRARY_SEARCH_TIMEOUT_MS`),
10 for the other reads; the worker's jobs and the command-line loaders
pass none. A cancelled search tells the user (or the model) to narrow it.
`lookupCitation` matches the normalized citation exactly,
then the decision whose first page precedes a pin page, then similar
citations and titles. `readDocument` returns a slice of the text (at most
60,000 characters).

## 9. Scheduling and operations (`jobs.ts`)

- **Daily runs** (`library-daily`): one pg-boss schedule per source (key =
  its code), early morning U.S. Central time: the source at registry
  position n starts 7n minutes after 01:00, wrapped within 01:00 to 04:59
  (7 and 240 share no factor, so the 92 sources get 92 different start
  minutes), so most finish before the 05:00 legal-update check; what a
  late or long run feeds is summarized by the next day's check. "stately"
  per source: one queued and one running at most. Retried twice, 30
  minutes apart; then the next day is the retry. A run has 100 minutes
  (`LIBRARY_DAILY_RUN_MINUTES`) and fetches at most
  `maxDocumentsPerDailyRun`; what it does not reach waits for the next run.
- **EOIR statistics** (`eoir-stats-load`, section 13): daily at 03:41
  Central, one load at a time, outside the per-source schedules.
- **Backfill** (`library-backfill`, kicked hourly by
  `library-backfill-kick` and once at worker start): one chunk per job, the
  next chunk queued when one finishes, in the order of `groups.ts`
  (immigration core first: BIA and AG precedents, statutes and regulations,
  the USCIS Policy Manual, EOIR manuals, the FAM, the Visa Bulletin, the
  circuits and the Supreme Court, AAO, unpublished BIA; then the rest). A
  chunk has 50 minutes (`LIBRARY_BACKFILL_CHUNK_MINUTES`).
- **One job per host at a time** on each queue (jobs grouped by the
  adapter's first host), on top of the per-host pacing of every request.
  Slots: `LIBRARY_DAILY_CONCURRENCY` (2; `fly.worker.toml` sets 4),
  `LIBRARY_BACKFILL_CONCURRENCY` (2; `fly.worker.toml` sets 3).
- **Manual sources**: `LIBRARY_MANUAL_SOURCES` (unset: the 13 sources
  whose sites refuse automated tools; `none`: no source) get no daily
  schedule and no backfill, are synced with status `manual` and a staleness
  threshold of their `manualImportIntervalDays`, and are kept up to date by
  import from the official site (section 2.6). Set the same value on the
  worker and the web app. `LIBRARY_IMPORT_ADMINS` (web app) lists the Clerk
  user ids of the platform operators who may import.
- **Pausing**: `LIBRARY_BACKFILL=paused` (all sources),
  `LIBRARY_BACKFILL_PAUSED_SOURCES=<code>,<code>`,
  `LIBRARY_DISABLED_SOURCES=<code>` (no daily run or backfill).
- **API keys**: an adapter whose `requiredEnv` is unset is skipped and shown
  as "Needs API key" with the variable's name: `COURTLISTENER_API_TOKEN`
  (the two CourtListener collectors; `COURTLISTENER_API_LIMITS`, default
  `5/minute,50/hour,125/day`, is the account's allowance they count
  against), `API_DATA_GOV_KEY` (GovInfo district court decisions and
  Regulations.gov) and `CONGRESS_GOV_API_KEY` (CRS reports).
- **Original files**: `LIBRARY_STORE_ORIGINALS=true` stores each fetched
  official file of a public domain source in S3 at
  `library/<source>/<external id>/<sha256>.<ext>` (`LIBRARY_S3_BUCKET`,
  default the documents bucket); the reader links to it through a
  five-minute presigned URL.
- **PDF extraction**: `LIBRARY_PDF_CONCURRENCY` (1),
  `LIBRARY_PDF_MEMORY_MB` (512, the worker thread's heap),
  `LIBRARY_PDF_TIMEOUT_SECONDS` (120), `LIBRARY_PDF_MAX_PAGES` (3000),
  `LIBRARY_PDF_MAX_CHARS` (5,000,000), `LIBRARY_PDF_FALLBACK=off` to never
  try `pdftotext`.
- **Shutdown**: on SIGTERM the worker aborts the library's runs, which stop
  fetching and record what they stored; the next run or chunk resumes.
- **Starting a source's history over**: `UPDATE library_backfill_state SET
  status = 'pending', cursor = NULL WHERE source_code = '<code>'` as the
  owner role; stored documents are kept and skipped by fingerprint.

## 10. How skill runs use it

Skills that research or cite law have three tools
(`src/services/skill-runner/tools/library.ts`; the list is in
`docs/ADDING_A_SKILL.md` section 7):

- `search_library` (query, groups, sources, dates, precedential only,
  court, country, offset): 10 results per call with a snippet, the official
  URL and the source's last refresh (STALE when overdue);
- `read_library_document` (document id, offset, max characters): the
  document's facts, its source's summary or headnote and up to 40,000
  characters of text per call;
- `lookup_library_citation` (one citation or case name): the document that
  is that authority, how it matched, and how many library documents cite it.

Every result names the official URL to cite and when its source was last
refreshed, and labels unpublished BIA and AAO decisions non-precedential.
The app writes each result to the run's verification log (`library` for a
read or an exact lookup, `library_search` for a search hit), and the matter
page lists the library documents a run used. The runtime notes
(`prompt.ts`) tell the model to prefer the library over web search for
anything it holds, to cite the official URL, to label non-precedential
decisions and to say when a source is stale. The tools read a database
table: nothing about the case leaves the app.

bench-memo, claim-evaluation and legal-argument-research also have the
EOIR statistics tools (`search_eoir_judges`, `eoir_judge_profile`,
`query_eoir_stats`; section 13), logged the same way with the release's
official URL.

## 11. Known limits

- No OCR: a scanned PDF without a text layer is stored with its metadata
  and link only (`textKind: "none"`); its title, citations and headnote are
  still searchable.
- Full-text search covers the first 200,000 characters of each document.
- "Cited by" counts come from the citations found in the library's own
  texts; there is no citator (later treatment is not tracked).
- Pacing is per worker process; with more than one worker machine, raise
  `LIBRARY_HOST_SPACING_MS`.
- EOIR's AG/BIA decisions page does not link volumes 1 to 7 of I&N Dec.;
  the BIA adapter collects every volume it links (8 to 30 today).
- A query that matches a large share of the library (a single common word)
  ranks every match before returning the first page; narrow it with a
  phrase or filters.
- `ctx.http` is GET only. Three sources would need a form POST to page
  their results: EOIR's FOIA reading room (the unpublished BIA collector
  partitions its searches by folder-name prefix instead, checked exact
  against the site's own paging), GovInfo's full-text search (district
  cases coded outside nature of suit 462, 463 and 465 are not found), and
  the Canadian IRB (not collected).
- EOIR posts unpublished BIA decisions as scanned images with no text
  layer, so `eoir_bia_unpublished_foia` holds their listing facts (decision
  date, base city, appeal type, filed by, pages) and the PDF link, not
  their text, until the library has OCR.
- USCIS's AAO non-precedent repository orders the rows inside a posting
  batch arbitrarily, so a topic and month with more than 100 decisions
  cannot always be listed completely through its pages (the run notes give
  the count reached); decisions posted after the collector starts come
  from the newest postings each day.
- BALCA's decision files are on www.oalj.dol.gov, whose robots.txt
  disallows all crawlers; the BALCA collector keeps the OALJ caselists'
  facts and links (no text) and does not reach BALCA's panel decisions.
- eCFR text comes from GovInfo's bulk eCFR XML: ecfr.gov's robots.txt
  disallows the full-text API (`/api/versioner/v1/full/`) and the
  point-in-time pages (`/on/`) for every crawler. Each CFR section keeps the
  dates of its versions since January 2017 (the versions API) and the
  current text; earlier versions' text is not collected.
- No collector can tell that a page disappeared from a source: the
  framework withdraws only what an adapter names (EOIR memoranda use
  Appendix O; USCIS archive notices and superseded stamps are read), so a
  deleted manual section or web page stays stored as current.
- A new edition of a document kept under one id (a form, a manual section)
  becomes a new version, not a new document, so it does not reach the
  legal-update feed; the monitor's own Forms Updates and manual change
  checks cover those.
- The same material can be held by two sources where two official pages
  list it: the AAO precedents (EOIR's AG/BIA volume pages and its AAO
  page), Supreme Court opinions of October Term 2018 (the Court's site and
  GovInfo's U.S. Reports), and opinions at each circuit's GovInfo boundary
  year (GovInfo and CourtListener).
- pdf.js drops the fi and fl ligatures of some PDFs (the Supreme Court's
  preliminary prints read "fnal", "offcer"), which hurts search on those
  words.

## 12. Sources and their status

Every registered collector, in registry order. "Live test" is `npm run library:smoke` from a development machine on 2026-10-15 (daily listing since three days before, the first backfill chunk, two documents fetched and checked; counts are refs listed). The worker's own IPs may be answered differently: rerun it there (README, first deploy checklist).

| Source | Group | First host | License | Live test | What it holds |
| --- | --- | --- | --- | --- | --- |
| `uscis_aao_non_precedent_decisions` | Administrative Appeals Office decisions | www.uscis.gov | public domain | ok (daily 173, backfill 46, 2 docs) | USCIS's AAO non-precedent repository (about 170,000 PDFs from 2005), walked by year, topic and month; a topic-month over 100 rows cannot always be listed whole (the run notes give the count reached). About 3 weeks of uscis.gov backfill. |
| `eoir_aao_precedent_decisions` | Administrative Appeals Office decisions | www.justice.gov | public domain | ok (daily 10, backfill 10, 2 docs) | The AAO entries on EOIR's DHS/AAO/INS decisions page (10 today); 9 are also on the AG/BIA volume pages, so they are held twice (legal updates deduplicated by Interim Decision number). |
| `uscis_aao_adopted_decisions` | Administrative Appeals Office decisions | www.uscis.gov | public domain | ok (daily 24, backfill 24, 2 docs) | Current and superseded adopted decisions (24); superseded ones are flagged withdrawn with USCIS's words. |
| `uscis_aao_practice_manual` | Administrative Appeals Office decisions | www.uscis.gov | public domain | ok (daily 9, backfill 9, 2 docs) | The AAO Practice Manual, front page, 7 chapters and table of changes. |
| `eoir_ocaho_published_decisions` | OCAHO and BALCA decisions | www.justice.gov | public domain | ok (daily 2625, backfill 15, 2 docs) | OCAHO's published decisions, 23 volume pages (about 2,625 decisions). |
| `dol_balca_caselists` | OCAHO and BALCA decisions | www.dol.gov | public domain | ok (daily 371, backfill 371, 2 docs) | The 371 BALCA decisions the OALJ caselists on dol.gov list, as records without text: the decision files are on www.oalj.dol.gov, whose robots.txt disallows all crawlers. |
| `dol_balca_en_banc_summaries` | OCAHO and BALCA decisions | www.dol.gov | public domain | ok (daily 17, backfill 17, 2 docs) | OALJ's topical digest of pre-PERM en banc decisions (17 topics). |
| `eoir_foia_released_ij_decisions` | Immigration judge decisions | www.justice.gov | public domain | ok (daily 11, backfill 11; the 1 identifiable immigration judge decision stored, the others skipped as Board decisions or scans) | Immigration judge decisions in EOIR's FOIA Library (1 identifiable today); Board decisions and scans with no text layer are skipped with a note each day. |
| `eoir_ag_bia_precedents` | Board of Immigration Appeals and Attorney General precedents | www.justice.gov | public domain | ok (daily 172, backfill 19, 2 docs) | I&N Dec. volumes 8 to 30 as EOIR's AG/BIA decisions page links them; volumes 1 to 7 are not linked there. |
| `eoir_bia_unpublished_foia` | Unpublished BIA decisions | foia.eoir.justice.gov | public domain | ok (daily 337, backfill 0, 2 docs) | EOIR's FOIA reading room (about 280,000 decisions, 2017 on). Every PDF sampled is a scan with no text layer: listing facts and the PDF link only until OCR exists. Results page only by form POST, read here with GET searches partitioned by folder-name prefix. About 4 to 10 days of backfill. |
| `dos_human_rights_reports` | Country conditions | www.state.gov | public domain | refused by the site (HTTP 403) | Country Reports on Human Rights Practices by country and year (www.state.gov from 2016, the 2009-2017 archive back to 1999). The parsers were checked only on Internet Archive copies, since the sites refuse the collector. |
| `dos_religious_freedom_reports` | Country conditions | www.state.gov | public domain | refused by the site (HTTP 403) | International Religious Freedom Reports by country, 2001 on. Same refusal and checks as the human rights reports. |
| `dos_trafficking_reports` | Country conditions | www.state.gov | public domain | refused by the site (HTTP 403) | Trafficking in Persons Report country narratives (per country where the State Department publishes them, earlier years as grouped narratives). Same refusal and checks. |
| `uscirf_reports` | Country conditions | www.uscirf.gov | public domain | refused by the site (HTTP 403) | USCIRF annual reports and country publications. The parsers were checked only on Internet Archive copies. |
| `uk_home_office_cpin` | Country conditions | www.gov.uk | link only | ok (daily 12, backfill 177, 2 docs) | link_only (the notes quote third-party material the Open Government Licence does not cover): metadata, excerpt and link, through the GOV.UK Content API. |
| `euaa_coi_reports` | Country conditions | www.euaa.europa.eu | link only | ok (daily 10, backfill 49, 2 docs) | link_only (EUAA's legal notice): metadata, excerpt and link; the PDF is not downloaded. |
| `ice_detention_standards` | Other agency manuals and guidance | www.ice.gov | public domain | ok (daily 173, backfill 173, 2 docs) | NDS 2026 and 2025, NDIDS, PBNDS 2011, NDS 2019, FRS 2020, the Temporary Housing Standards, and the archived PBNDS 2008 (flagged withdrawn). |
| `ice_policy_guidance` | Other agency manuals and guidance | www.ice.gov | public domain | ok (daily 51, backfill 99, 2 docs) | Three categories of the ICE FOIA Library; items listed as rescinded are flagged withdrawn. |
| `ice_sevp_guidance` | Other agency manuals and guidance | www.ice.gov | public domain | ok (daily 483, backfill 150, 2 docs) | SEVP policy guidance, STEM lists, archived COVID-19 guidance and broadcast messages from 2016. |
| `cbp_policies_directives` | Other agency manuals and guidance | www.cbp.gov | public domain | ok (daily 14, backfill 28, 2 docs) | Every entry of CBP's policies and directives table (about 807), not only immigration ones. |
| `dhs_headquarters_guidance` | Other agency manuals and guidance | www.dhs.gov | public domain | ok (daily 31, backfill 31, 2 docs) | dhs.gov's Headquarters Guidance Documents collection. |
| `dhs_management_directives` | Other agency manuals and guidance | www.dhs.gov | public domain | ok (daily 272, backfill 150, 2 docs) | DHS Management Directives and Instructions, every topic page. |
| `dhs_cis_ombudsman` | Other agency manuals and guidance | www.dhs.gov | public domain | ok (daily 193, backfill 120, 2 docs) | The CIS Ombudsman's annual reports, recommendations and other publications. |
| `uscis_asylum_officer_training` | Other agency manuals and guidance | www.uscis.gov | public domain | ok (daily 12, backfill 22, 2 docs) | RAIO and asylum lesson plans, the Credible Fear Procedures Manual and the AAPM, as the USCIS Reading Room and the Affirmative Asylum Process page link them; lesson plans linked from no page are not held. |
| `uscis_adjudicators_field_manual` | Other agency manuals and guidance | www.uscis.gov | public domain | ok (daily 19, backfill 19, 2 docs) | The 18 AFM chapters USCIS still hosts and its transition crosswalk; the rest of the retired AFM is not on uscis.gov. |
| `uscis_m274_handbook` | Other agency manuals and guidance | www.uscis.gov | public domain | ok (daily 60, backfill 60, 2 docs) | The Handbook for Employers (M-274), section by section. |
| `everify_user_manual` | Other agency manuals and guidance | www.e-verify.gov | public domain | ok (daily 63, backfill 63, 2 docs) | The E-Verify User Manual (M-775), section by section. |
| `dos_fam_consular` | Foreign Affairs Manual | fam.state.gov | public domain | ok (daily 377, backfill 80, 2 docs) | 9 FAM, 8 FAM and 7 FAM with 7 FAM's 18 appendices (377 pages); the public 9 FAM contents link no appendices. |
| `dos_visa_bulletin` | Visa Bulletin | travel.state.gov | public domain | refused by the site (HTTP 403) | Every Visa Bulletin since December 2001, its charts stored as rows. travel.state.gov answers with a Cloudflare challenge; the parsers were checked only on Internet Archive copies. |
| `uscis_aos_filing_charts` | Visa Bulletin | www.uscis.gov | public domain | ok (daily 4, backfill 50, 2 docs) | The chart USCIS designated for each month since October 2015 (132 months; January 2026 is linked to a non-public host and left out). |
| `dos_consular_post_nvc` | Other agency manuals and guidance | travel.state.gov | public domain | refused by the site (HTTP 403) | Consular post and National Visa Center instruction pages. Checked only on archived copies (travel.state.gov refuses the collector). |
| `dos_reciprocity_civil_documents` | Other agency manuals and guidance | travel.state.gov | public domain | refused by the site (HTTP 403) | Visa reciprocity and civil documents by country, fee tables as rows. Checked only on archived copies. |
| `dos_intercountry_adoption` | Other agency manuals and guidance | travel.state.gov | public domain | refused by the site (HTTP 403) | Intercountry adoption country pages (Hague status). Checked only on archived copies. |
| `dos_bridgeusa_j1` | Other agency manuals and guidance | j1visa.state.gov | public domain | ok (daily 281, backfill 100, 2 docs) | BridgeUSA pages and posts from the site's sitemaps (281); its PDFs are disallowed by its robots.txt. |
| `dos_press_releases_visas` | Other agency manuals and guidance | www.state.gov | public domain | refused by the site (HTTP 403) | State Department press releases on visas and immigration (keyword-selected). Checked only on archived copies. |
| `eoir_icpm` | EOIR practice manuals, policy memoranda, and forms | www.justice.gov | public domain | ok (daily 60, backfill 60, 2 docs) | Part II of the EOIR Policy Manual, section by section. |
| `eoir_bia_practice_manual` | EOIR practice manuals, policy memoranda, and forms | www.justice.gov | public domain | ok (daily 68, backfill 60, 2 docs) | Part III of the EOIR Policy Manual, section by section. |
| `eoir_policy_manual_general` | EOIR practice manuals, policy memoranda, and forms | www.justice.gov | public domain | ok (daily 55, backfill 55, 2 docs) | Parts I, VI (the Uniform Docketing System Manual) and VII (appendices, Table of Changes). |
| `eoir_ocaho_practice_manual` | EOIR practice manuals, policy memoranda, and forms | www.justice.gov | public domain | ok (daily 60, backfill 60, 2 docs) | Part IV of the EOIR Policy Manual (kept here; the copy built in admin-tribunals was dropped as a duplicate). |
| `eoir_policy_memoranda` | EOIR practice manuals, policy memoranda, and forms | www.justice.gov | public domain | ok (daily 103, backfill 40, 2 docs) | PMs and OPPMs from three EOIR lists (103); withdrawals from Appendix O. Some older memos are scans. |
| `eoir_forms` | EOIR practice manuals, policy memoranda, and forms | www.justice.gov | public domain | ok (daily 22, backfill 22, 2 docs) | The 20 EOIR forms with their instructions, the Forms and Fees page and the fee page. |
| `eoir_immigration_courts` | EOIR practice manuals, policy memoranda, and forms | www.justice.gov | public domain | ok (daily 73, backfill 73, 2 docs) | The 71 immigration court pages, the court directory and the administrative control list. |
| `eoir_case_data` | EOIR court and judge statistics | www.justice.gov | public domain | ok (daily 2, backfill 2, 2 docs) | The case data release's description (file list, counts, schema) and the code key. The statistics themselves are loaded by the eoir-stats-load job (section 13). |
| `govinfo_uscourts_appeals_immigration` | Federal circuit court opinions | www.govinfo.gov | public domain | ok (daily 15, backfill 44, 2 docs) | Courts of appeals opinions on GovInfo (from about 2004 to 2011 by circuit), immigration cases chosen from GovInfo's own metadata. No legal-update feed (the monitor already lists published opinions). |
| `courtlistener_appeals_immigration` | Federal circuit court opinions | www.courtlistener.com | public domain | needs COURTLISTENER_API_TOKEN; not run | Needs COURTLISTENER_API_TOKEN. CourtListener is Free Law Project's service, not a court: a firm decision is needed before enabling it (see the open issues). Text from the court's own file where CourtListener links one, else from CourtListener's copy. |
| `govinfo_uscourts_district_immigration` | Federal district court decisions | api.govinfo.gov | public domain | needs API_DATA_GOV_KEY; not run | Needs API_DATA_GOV_KEY. District decisions on GovInfo with nature of suit 462, 463 or 465. |
| `courtlistener_district_immigration` | Federal district court decisions | www.courtlistener.com | public domain | needs COURTLISTENER_API_TOKEN; not run | Needs COURTLISTENER_API_TOKEN; district decisions before 2004 (history only). Same third-party caveat as the appeals collector. |
| `scotus_opinions_of_the_court` | U.S. Supreme Court opinions | www.supremecourt.gov | public domain | ok (daily 74, backfill 1, 2 docs) | Every opinion of the Court from October Term 2018, cut out of the preliminary prints and bound volumes where the Court links them; only immigration opinions feed legal updates. |
| `govinfo_us_reports_immigration` | U.S. Supreme Court opinions | www.govinfo.gov | public domain | ok (daily 0, backfill 25 candidates in volume 586, of which 1 is an immigration case, Nielsen v. Preap; a 1952 chunk gave United States v. Spector) | Immigration cases in the bound U.S. Reports on GovInfo, chosen from GovInfo's subject data and the syllabus. |
| `federal_register_immigration` | Immigration regulations | www.federalregister.gov | public domain | ok (daily 8, backfill 99, 2 docs) | Immigration rules, proposed rules and notices from the Federal Register API (key fr:<document number>, the monitor's own). |
| `regulations_gov_immigration` | Immigration regulations | api.regulations.gov | public domain | needs API_DATA_GOV_KEY; not run | Needs API_DATA_GOV_KEY. Docket documents of the immigration agencies; its file downloads are refused to the collector's current User-Agent. |
| `dol_oflc_announcements` | Other agency manuals and guidance | www.dol.gov | public domain | ok (daily 677, backfill 861, 2 docs) | OFLC announcements, 2005 on (861). |
| `dol_oflc_faqs` | Other agency manuals and guidance | www.dol.gov | public domain | ok (daily 66, backfill 66, 2 docs) | OFLC FAQ round PDFs (66). |
| `dol_whd_immigration` | Other agency manuals and guidance | www.dol.gov | public domain | ok (daily 79, backfill 79, 2 docs) | Wage and Hour Division H-1B, H-2A, H-2B and related guidance (79). |
| `orr_uac_policy_guide` | Other agency manuals and guidance | acf.gov | public domain | refused by the site (HTTP 403) | ORR's Unaccompanied Alien Children Bureau Policy Guide and field guidance. acf.gov refuses the collector's current User-Agent (open issue). |
| `orr_urm_policy_guide` | Other agency manuals and guidance | acf.gov | public domain | refused by the site (HTTP 403) | ORR's Unaccompanied Refugee Minors policy guide. Same refusal. |
| `orr_refugee_policy_letters` | Other agency manuals and guidance | acf.gov | public domain | refused by the site (HTTP 403) | ORR policy letters, Dear Colleague letters and State Letters (189). Same refusal. |
| `doj_justice_manual_immigration` | Other agency manuals and guidance | www.justice.gov | public domain | ok (daily 10, backfill 10, 2 docs) | The Justice Manual's immigration chapters (4-7, 9-72, 9-73). |
| `doj_ier_technical_assistance_letters` | Other agency manuals and guidance | www.justice.gov | public domain | ok (daily 68, backfill 40, 2 docs) | IER technical assistance letters (68). |
| `cdc_technical_instructions` | Other agency manuals and guidance | www.cdc.gov | public domain | ok (daily 19, backfill 19, 2 docs) | CDC Technical Instructions for civil surgeons and panel physicians. |
| `ssa_poms_alien_eligibility` | Other agency manuals and guidance | secure.ssa.gov | public domain | ok (daily 126, backfill 126, 2 docs) | POMS SI 00502, RM 10211, RS 00204 and RS 02635 (126 sections). |
| `usda_fns_noncitizen_eligibility` | Other agency manuals and guidance | www.fna.usda.gov | public domain | refused by the site (HTTP 403) | USDA nutrition-program noncitizen eligibility guidance, found through the agency's sitemap. www.fna.usda.gov refuses the collector's current User-Agent (open issue). |
| `cms_medicaid_immigrant_eligibility` | Other agency manuals and guidance | www.medicaid.gov | public domain | ok (daily 3, backfill 4, 2 docs) | CMS letters on immigrant eligibility from medicaid.gov's federal policy guidance. |
| `omb_pra_supporting_statements` | Other agency manuals and guidance | www.reginfo.gov | public domain | ok (daily 38, backfill 120, 2 docs) | Supporting statements of immigration information collections (reginfo.gov); the backfill reads the 104 MB PRA inventory once. |
| `bls_occupational_outlook_handbook` | Other agency manuals and guidance | www.bls.gov | public domain | ok (daily 343, backfill 200, 2 docs) | Occupation profiles (343); the print view, which BLS's robots.txt disallows, is left out. |
| `onet_occupations` | Other agency manuals and guidance | www.onetonline.org | link only | ok (daily 1016, backfill 300, 2 docs) | link_only (CC BY 4.0): code, title, description and job zone, excerpt and link (1,016 occupations). |
| `gao_immigration_reports` | Oversight and research reports | www.gao.gov | public domain | ok (daily 2, backfill 2, 2 docs) | GAO's reports feed (newest 25), immigration reports only; gao.gov's robots.txt asks for 420 seconds between requests, which is honored. GAO's archive refuses automated clients. |
| `govinfo_gao_immigration_reports` | Oversight and research reports | www.govinfo.gov | public domain | ok (daily 0, backfill 18, 2 docs) | GAO reports 1989 to 2008 on GovInfo, chosen by title and GAO subject terms. |
| `crs_immigration_reports` | Oversight and research reports | api.congress.gov | public domain | needs CONGRESS_GOV_API_KEY; not run | Needs CONGRESS_GOV_API_KEY. CRS's record and summary only (congress.gov refuses automated clients the report files). |
| `dhs_oig_immigration_reports` | Oversight and research reports | www.oig.dhs.gov | public domain | ok (daily 168, backfill 50, 2 docs) | DHS OIG reports on CBP, ICE and USCIS, 2003 on. |
| `govinfo_ina_legislative_history` | INA legislative history | www.govinfo.gov | public domain | ok (daily 0, backfill 13, 2 docs) | Immigration public laws in the Statutes at Large, volumes 66 to 121 (1952 to 2007), and the committee reports the volumes name. |
| `untc_refugee_cat_treaties` | Treaties and international guidance | treaties.un.org | link only | ok (daily 3, backfill 3, 2 docs) | link_only (UN terms): the depositary records of the Refugee Convention, the 1967 Protocol and the CAT. |
| `unhcr_rsd_handbook` | Treaties and international guidance | www.unhcr.org | link only | partial (the handbooks page answered HTTP 403; the Handbook's own page was read on a second try) | link_only, metadata only (UNHCR's terms bar reuse): the Handbook's page record and link. www.unhcr.org refused the collector in this test, after serving it the day before. |
| `olrc_usc_title_8` | Immigration and Nationality Act and Title 8 | uscode.house.gov | public domain | ok (daily 376, backfill 376, 2 docs) | Every section of Title 8 with notes, INA section parallels from the source credits. |
| `ecfr_immigration_regulations` | Immigration regulations | www.ecfr.gov | public domain | ok (daily 4, backfill 400, 2 docs) | 2,027 sections of the immigration parts of CFR titles 6, 8, 19, 20, 22, 28, 29, 42 and 45: text from GovInfo's bulk eCFR XML (ecfr.gov's robots.txt bars its full-text API), version dates from the eCFR versions API. |
| `govinfo_constitution` | Constitution | www.govinfo.gov | public domain | ok (daily 52, backfill 52, 2 docs) | The Constitution, section by section, from GPO's H. Doc. 110-50 (2007 annotations). |
| `olrc_usc_title_18` | State and federal criminal codes | uscode.house.gov | public domain | ok (daily 1399, backfill 500, 2 docs) | Every section of Title 18. |
| `olrc_usc_title_21_controlled_substances` | State and federal criminal codes | uscode.house.gov | public domain | ok (daily 105, backfill 105, 2 docs) | 21 U.S.C. chapter 13, including the section 812 schedules. |
| `ecfr_21_cfr_1308` | State and federal criminal codes | www.ecfr.gov | public domain | ok (daily 28, backfill 28, 2 docs) | 21 CFR part 1308, the controlled substance schedules. |
| `uscis_forms` | USCIS forms, fee schedule, and poverty guidelines | www.uscis.gov | public domain | ok (daily 60, backfill 30, 2 docs) | Every form on USCIS's All Forms page (103) and each PDF its page attaches. |
| `uscis_form_updates` | USCIS forms, fee schedule, and poverty guidelines | www.uscis.gov | public domain | ok (daily 10, backfill 150, 2 docs) | Each Forms Updates entry, January 2020 on (439). |
| `uscis_g1055` | USCIS forms, fee schedule, and poverty guidelines | www.uscis.gov | public domain | ok (daily 134, backfill 134, 2 docs) | The G-1055 page, its fee schedule PDF and the 132 per-form fee entries (read through the page's own filter). |
| `uscis_i864p` | USCIS forms, fee schedule, and poverty guidelines | www.uscis.gov | public domain | ok (daily 1, backfill 1, 1 doc) | The I-864P poverty guidelines. |
| `uscis_tps` | Temporary Protected Status designations | www.uscis.gov | public domain | ok (daily 21, backfill 21, 2 docs) | The TPS overview and the 20 country pages USCIS links, each checked against the Federal Register's TPS notices. |
| `uscis_policy_manual` | USCIS Policy Manual | www.uscis.gov | public domain | ok (daily 663, backfill 90, 2 docs) | Every volume, part and chapter (663 pages). |
| `uscis_policy_manual_updates` | USCIS Policy Manual | www.uscis.gov | public domain | ok (daily 354, backfill 70, 2 docs) | Policy alerts and technical updates (354), 2013 on. |
| `uscis_policy_memoranda` | USCIS policy memoranda, alerts, and web guidance | www.uscis.gov | public domain | ok (daily 272, backfill 60, 2 docs) | Current and archived memoranda and other memo-folder files, each with whether it is still in force. |
| `uscis_news_alerts` | USCIS policy memoranda, alerts, and web guidance | www.uscis.gov | public domain | ok (daily 11, backfill 50, 2 docs) | The newsroom's All News list; only alerts feed legal updates. |
| `uscis_foia_reading_room` | USCIS policy memoranda, alerts, and web guidance | www.uscis.gov | public domain | ok (daily 0, backfill 22, 2 docs) | The Electronic Reading Room's released PDFs (about 2,061 entries, 1977 on). |
| `uscis_trig_exemptions` | USCIS policy memoranda, alerts, and web guidance | www.uscis.gov | public domain | ok (daily 46, backfill 46, 2 docs) | The TRIG pages and their exercise-of-authority PDFs. |
| `uscis_web_guidance` | USCIS policy memoranda, alerts, and web guidance | www.uscis.gov | public domain | ok (daily 5, backfill 100, 2 docs) | About 3,860 English uscis.gov pages in the immigration sections of the site map, archived pages flagged withdrawn; the TPS pages and the monthly filing charts are left to their own collectors. |
| `uscis_policy_documents` | USCIS policy memoranda, alerts, and web guidance | www.uscis.gov | public domain | ok (daily 0, backfill 80, 2 docs) | Legal documents, notices, fact sheets and Q&As from uscis.gov's document folders (574). |

The same day, `npm run library:db-check -- --live-source <code>:N` stored real documents of 24 of these sources in PGlite through the daily pipeline, read each back, found it by a word of its title, looked up its first citation (and its country, where it states one), and ran the daily run again without inserting anything: `eoir_ag_bia_precedents`, `eoir_aao_precedent_decisions`, `dol_balca_caselists`, `scotus_opinions_of_the_court`, `federal_register_immigration`, `olrc_usc_title_8`, `olrc_usc_title_18`, `ecfr_21_cfr_1308`, `govinfo_constitution`, `eoir_icpm`, `eoir_policy_memoranda`, `dos_fam_consular`, `doj_justice_manual_immigration`, `dhs_oig_immigration_reports`, `cbp_policies_directives`, `ice_policy_guidance`, `ssa_poms_alien_eligibility`, `cms_medicaid_immigrant_eligibility`, `dol_oflc_announcements`, `uk_home_office_cpin`, `euaa_coi_reports`, `untc_refugee_cat_treaties`, `uscis_tps`, `uscis_policy_manual`.

**CourtListener is a third-party service.** The two CourtListener collectors use Free Law Project's CourtListener API (an index of the federal courts' opinions, with the history before GovInfo). They take an opinion's text from the court's own file when CourtListener links one on the court's site, and otherwise from CourtListener's copy, cited by its courtlistener.com address. The firm decided the app must not depend on a third-party legal research service, so these collectors stay off (`needs_key`) until the firm decides to set `COURTLISTENER_API_TOKEN`; one middle course is to keep only documents whose text comes from the court's own file.

**Sites that refuse the collector's User-Agent.** acf.gov (ORR), www.fna.usda.gov and www.usda.gov (USDA) and downloads.regulations.gov answer the current User-Agent, which says the collector honors robots.txt, with HTTP 403 or an empty challenge; the other-agencies collector found that they let through the conventional crawler form `Mozilla/5.0 (compatible; MeritDeskAI-Library/1.0; ...)` without the words robot, bot or crawl. That form is still an honest identification, but changing how the collector identifies itself to get past a site's filter is the firm's decision, so `http/client.ts` is unchanged. The State Department's sites, USCIRF and hud.gov refuse every non-browser client tried. The 13 sources of `docs/LIBRARY_SOURCES.md` section 1 are kept up to date by import from the official site instead (section 2.6; `LIBRARY_MANUAL_SOURCES`), so their daily runs no longer fail; USCIRF is not among them and still fails until its site lets the collector through.

## 13. EOIR court and judge statistics

The catalog's EOIR statistics group is built from EOIR's own public case
data release, with no third-party service involved
(`src/services/library/adapters/eoir-statistics/`):

- **The release.** EOIR's FOIA library page
  (https://www.justice.gov/eoir/foia-library-0) links "EOIR Case Data", a
  ZIP64 file of about 4.5 GB on fileshare.eoir.justice.gov (tab-separated
  tables, a Readme, row counts and the schema), and the code key, a PDF
  data dictionary. EOIR keeps only the current release online.
- **The collector** `eoir_case_data` stores two documents: the release's
  description (file list, Readme, row counts, field list, read from the end
  of the archive by range requests) and the code key's text.
- **The load** is the pg-boss job `eoir-stats-load` (`jobs.ts`, daily at
  03:41 Central, one at a time across workers, no retries: the next day is
  the retry). It stops at once when the release (folder, ETag, size) is the
  current snapshot; otherwise it reads the lookups and streams four tables
  (`B_TblProceeding`, `tbl_Court_Appln`, `tbl_RepsAssigned`, `tblAppeal`;
  about 1.2 GB of 32 MB range requests, each checked by `If-Range`, length,
  size and CRC-32) through a pure aggregator into the migration 0008
  tables, as a new snapshot made current in one transaction; the previous
  one is pruned, and a failed load leaves the current one untouched.
  `npm run eoir-stats:load [-- --force]` runs it by hand;
  `EOIR_STATS_LOAD=paused` (or `eoir_case_data` in
  `LIBRARY_DISABLED_SOURCES`) stops it.
- **What is kept:** counts only, by judge, court, fiscal year, nationality,
  custody, representation, case type, decision, application and Board
  appeal, and processing-time distributions. No case or proceeding number,
  name, address or other record of a person is stored.
- **Definitions** (`model.ts`, stated with every result): a completion is a
  proceeding with a completion date; the outcome is the judge's decision
  code, else the other-completion code; the judge is the proceeding's
  `IJ_CODE`; represented means EOIR lists a representative for the
  respondent at the court level on the case at any time; processing time
  runs from the court's receipt to completion (percentiles from 30-day
  bins); granted and denied follow EOIR's own decision descriptions. The
  Board decision grouping (`BIA_DECISION_GROUPS` in `aggregate.ts`) is the
  app's own and should be reviewed by an attorney.
- **Reading:** `/library/eoir-statistics` (snapshot, judge search, judge
  profile by fiscal years, courts, definitions), and the skill tools
  `search_eoir_judges`, `eoir_judge_profile` and `query_eoir_stats`
  (bench-memo, claim-evaluation, legal-argument-research), logged to the
  verification log with the release's official URL. Every result gives the
  snapshot, filters and denominators, flags counts under 10, and says that
  rates describe historical outcomes and do not predict an individual case.
- **Checks:** `npm run eoir-stats:check` (PGlite: row-level security, the
  aggregator on fixtures in EOIR's real column layouts, the store's
  current, superseded, pruned and failed paths, and every query);
  `-- --live-prefix-mb N` also aggregates the first N MB of each live table.
- **Not yet done:** a full load has not run (only 16 MB and 50 MB prefixes
  of each table); its size (estimated 3 to 5 million aggregate rows, about
  0.5 GB with indexes) and time (estimated 15 to 40 minutes) are
  extrapolated.
