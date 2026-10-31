import { z } from "zod";
import { extractCitations, normalizeCitation, type FoundCitation } from "./citations";
import { countryKey } from "./country";
import { redactUrl } from "./http/fetch";
import { cleanText, excerpt, oneLine, sha256Hex } from "./text";
import {
  LIBRARY_DOC_TYPES,
  type DocumentRef,
  type LibraryDocType,
  type LibraryDocumentInput,
  type LibrarySourceAdapter,
  type LibraryTextKind,
  type PrecedentialStatus,
} from "./types";

// Checks and normalizes what an adapter returns before anything is stored
// (the pipeline) or printed (the probe): the fields are well formed, the
// official URL is https on the adapter's own hosts, dates are real dates,
// the text is cleaned (./text.ts) and, for a link_only source, cut to a
// short excerpt whatever the adapter returned. Citations are normalized for
// lookup (./citations.ts). Pure: no database, no network.

/** The longest excerpt a link_only source keeps (its terms do not allow the full text). */
export const LINK_ONLY_EXCERPT_CHARS = 1_500;
/** Citations found in a document's text kept for "cites" lookups. */
export const MAX_CITED_CITATIONS = 400;
/** The part of the text citations are looked for in. */
const CITATION_SCAN_CHARS = 1_000_000;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "not a real calendar date");

const inputSchema = z.object({
  externalId: z.string().trim().min(1).max(512),
  docType: z.enum(LIBRARY_DOC_TYPES),
  title: z.string().trim().min(1).max(2_000),
  citations: z.array(z.string().trim().min(1).max(500)).max(50),
  court: z.string().trim().max(300).nullish(),
  agency: z.string().trim().max(300).nullish(),
  decisionDate: isoDate.nullish(),
  publishedDate: isoDate.nullish(),
  effectiveDate: isoDate.nullish(),
  editionDate: isoDate.nullish(),
  documentYear: z.number().int().min(1700).max(2200).nullish(),
  precedentialStatus: z.enum(["precedential", "non_precedential", "not_applicable", "unknown"]),
  officialUrl: z.string().url().max(2_000),
  originalUrl: z.string().url().max(2_000).nullish(),
  text: z.string(),
  textKind: z.enum(["full", "excerpt", "none"]).optional(),
});

export class LibraryDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryDocumentError";
  }
}

export type PreparedDocument = {
  externalId: string;
  docType: LibraryDocType;
  title: string;
  citations: string[];
  court: string | null;
  agency: string | null;
  decisionDate: string | null;
  publishedDate: string | null;
  effectiveDate: string | null;
  editionDate: string | null;
  documentYear: number | null;
  precedentialStatus: PrecedentialStatus;
  officialUrl: string;
  originalUrl: string | null;
  text: string;
  textKind: LibraryTextKind;
  textSha256: string;
  metadata: Record<string, unknown>;
  fetchInfo: Record<string, unknown>;
  listingFingerprint: string | null;
  selfCitations: FoundCitation[];
  citedCitations: FoundCitation[];
  original: { bytes: Buffer; contentType: string; extension: string; sha256: string } | null;
  withdrawn: { reason: string } | null;
  supersededBy: { externalId: string; note?: string } | null;
};

function hostAllowed(raw: string, hosts: readonly string[]): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && hosts.includes(url.hostname.toLowerCase()) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** JSON-safe copy (drops undefined, functions and Buffers; dates become ISO strings). */
function jsonSafe(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, v) => (Buffer.isBuffer(v) || v instanceof Uint8Array || typeof v === "function" ? undefined : v))
    ) as Record<string, unknown>;
  } catch {
    throw new LibraryDocumentError("metadata is not JSON-serializable");
  }
}

function yearOf(date: string | null | undefined): number | null {
  return date ? Number(date.slice(0, 4)) : null;
}

function cleanMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) out[key] = typeof value === "string" ? cleanText(value) : value;
  return out;
}

/**
 * The document as it will be stored. Throws LibraryDocumentError naming the
 * first problem; the run records it as that document's failure.
 */
export function prepareDocument(adapter: LibrarySourceAdapter, input: LibraryDocumentInput, ref: DocumentRef | null): PreparedDocument {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new LibraryDocumentError(`${input.externalId || "(no externalId)"}: ${issue.path.join(".") || "document"} ${issue.message}`);
  }
  const d = parsed.data;
  if (!hostAllowed(d.officialUrl, adapter.hosts)) {
    throw new LibraryDocumentError(`${d.externalId}: officialUrl ${redactUrl(d.officialUrl)} is not https on the adapter's hosts`);
  }
  if (d.originalUrl && !hostAllowed(d.originalUrl, adapter.hosts)) {
    throw new LibraryDocumentError(`${d.externalId}: originalUrl is not https on the adapter's hosts`);
  }

  const linkOnly = adapter.license === "link_only";
  let text = cleanText(d.text);
  let textKind: LibraryTextKind = d.textKind ?? (text ? "full" : "none");
  if (linkOnly) {
    // The source's terms do not allow keeping the whole text: an excerpt at most.
    text = excerpt(text, LINK_ONLY_EXCERPT_CHARS);
    textKind = text ? "excerpt" : "none";
  }
  if (textKind === "none") text = "";

  const metadata = cleanMetadata(jsonSafe(input.metadata));
  // A decision or publication date after the day the document was read is
  // a typo at the source (an OCAHO listing gives "03/06/2028"): it is not
  // stored as a date. The source's own text stays in metadata.statedDates,
  // and the date set aside is named here.
  const latest = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const setAside: Record<string, string> = {};
  for (const key of ["decisionDate", "publishedDate"] as const) {
    const value = d[key];
    if (value && value > latest) {
      setAside[key] = value;
      d[key] = null;
    }
  }
  if (Object.keys(setAside).length) metadata.datesSetAside = { ...setAside, reason: "later than the day the document was read" };
  if (linkOnly && typeof metadata.summary === "string") metadata.summary = excerpt(metadata.summary, LINK_ONLY_EXCERPT_CHARS);
  // search.ts filters by country on metadata.countryKeys: derived here from
  // the country a document states when its adapter did not set the keys.
  if (!Array.isArray(metadata.countryKeys) && typeof metadata.country === "string") {
    const key = countryKey(metadata.country);
    if (key) metadata.countryKeys = [key];
  }

  const citations = [...new Set(d.citations.map((c) => oneLine(c)).filter(Boolean))];
  const selfCitations: FoundCitation[] = [];
  const selfKeys = new Set<string>();
  for (const raw of citations) {
    const found = normalizeCitation(raw);
    if (found && !selfKeys.has(found.normalized)) {
      selfKeys.add(found.normalized);
      selfCitations.push({ ...found, raw });
    }
  }
  const citedCitations = extractCitations(text.slice(0, CITATION_SCAN_CHARS), MAX_CITED_CITATIONS + selfCitations.length)
    .filter((c) => !selfKeys.has(c.normalized))
    .slice(0, MAX_CITED_CITATIONS);

  const response = input.fetch?.response;
  const fetchInfo: Record<string, unknown> = response
    ? {
        requestedUrl: redactUrl(response.requestedUrl),
        finalUrl: redactUrl(response.url),
        redirects: response.redirects.map(redactUrl),
        etag: response.etag,
        lastModified: response.lastModified,
        contentType: response.contentType,
        bytes: response.body.length,
        sha256: response.sha256,
        retrievedAt: response.retrievedAt.toISOString(),
        ...(input.fetch?.extraction ? { extraction: jsonSafe(input.fetch.extraction) } : {}),
      }
    : { retrievedAt: new Date().toISOString() };

  const original =
    input.original && !linkOnly
      ? { ...input.original, sha256: sha256Hex(input.original.bytes) }
      : null;

  return {
    externalId: d.externalId,
    docType: d.docType,
    title: oneLine(d.title),
    citations,
    court: d.court ? oneLine(d.court) : null,
    agency: d.agency ? oneLine(d.agency) : null,
    decisionDate: d.decisionDate ?? null,
    publishedDate: d.publishedDate ?? null,
    effectiveDate: d.effectiveDate ?? null,
    editionDate: d.editionDate ?? null,
    documentYear: d.documentYear ?? yearOf(d.decisionDate ?? d.publishedDate ?? d.effectiveDate ?? d.editionDate),
    precedentialStatus: d.precedentialStatus,
    officialUrl: d.officialUrl,
    originalUrl: d.originalUrl ? redactUrl(d.originalUrl) : null,
    text,
    textKind,
    textSha256: sha256Hex(text),
    metadata,
    fetchInfo,
    listingFingerprint: ref?.fingerprint ?? null,
    selfCitations,
    citedCitations,
    original,
    withdrawn: input.withdrawn ?? null,
    supersededBy: input.supersededBy ?? null,
  };
}
