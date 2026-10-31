import { z } from "zod";
import type { ListingParse, ParsedItem } from "../types";
import { parseStatedDate } from "./dates";

// The Federal Register's public API (https://www.federalregister.gov/api/v1),
// queried for documents from EOIR, USCIS, ICE, DHS and the State Department
// published since the last check. DHS and State publish far more than
// immigration documents (Coast Guard safety zones, export controls,
// exhibition notices), so isImmigrationFederalRegisterDocument keeps only
// what concerns immigration; the summary step then applies sources.md
// section 5's keep and skip rules.

export const FEDERAL_REGISTER_AGENCIES = [
  "executive-office-for-immigration-review",
  "u-s-citizenship-and-immigration-services",
  "u-s-immigration-and-customs-enforcement",
  "homeland-security-department",
  "state-department",
] as const;

const FIELDS = [
  "document_number",
  "title",
  "type",
  "abstract",
  "action",
  "dates",
  "publication_date",
  "html_url",
  "pdf_url",
  "agencies",
  "cfr_references",
] as const;

export const FEDERAL_REGISTER_PAGE_SIZE = 100;

/** The API query for documents published on or after `sinceIso` (YYYY-MM-DD), newest first. */
export function federalRegisterQueryUrl(sinceIso: string, page = 1): string {
  const params = new URLSearchParams();
  params.set("per_page", String(FEDERAL_REGISTER_PAGE_SIZE));
  params.set("page", String(page));
  params.set("order", "newest");
  params.set("conditions[publication_date][gte]", sinceIso);
  for (const agency of FEDERAL_REGISTER_AGENCIES) params.append("conditions[agencies][]", agency);
  for (const field of FIELDS) params.append("fields[]", field);
  return `https://www.federalregister.gov/api/v1/documents.json?${params.toString()}`;
}

const documentSchema = z.object({
  document_number: z.string(),
  title: z.string(),
  type: z.string().nullish(),
  abstract: z.string().nullish(),
  action: z.string().nullish(),
  dates: z.string().nullish(),
  publication_date: z.string().nullish(),
  html_url: z.string().nullish(),
  pdf_url: z.string().nullish(),
  agencies: z
    .array(z.object({ name: z.string().nullish(), raw_name: z.string().nullish(), slug: z.string().nullish() }))
    .nullish(),
  cfr_references: z.array(z.object({ title: z.union([z.number(), z.string()]).nullish(), part: z.string().nullish() })).nullish(),
});

const responseSchema = z.object({
  count: z.number().nullish(),
  total_pages: z.number().nullish(),
  next_page_url: z.string().nullish(),
  results: z.array(documentSchema).nullish(),
});

export type FederalRegisterDocument = z.infer<typeof documentSchema>;

/** The API's JSON; throws when its shape is not the documented one. */
export function parseFederalRegisterResponse(json: unknown): {
  documents: FederalRegisterDocument[];
  totalPages: number;
  hasNextPage: boolean;
} {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Unexpected Federal Register API response: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return {
    documents: parsed.data.results ?? [],
    totalPages: parsed.data.total_pages ?? 1,
    hasNextPage: Boolean(parsed.data.next_page_url),
  };
}

const PAPERWORK =
  /Agency Information Collection Activities|Information Collection|Paperwork Reduction Act|Submission for OMB Review|Collection of Information Under Review/i;
const IMMIGRATION_AGENCY_SLUGS = new Set([
  "executive-office-for-immigration-review",
  "u-s-citizenship-and-immigration-services",
  "u-s-immigration-and-customs-enforcement",
]);
const IMMIGRATION_TERMS =
  /\bimmigra\w*|\basylum\b|\baliens?\b|\bnaturaliz\w*|\bcitizenship\b|\bvisas?\b|\bnonimmigrants?\b|\bparole\b|\bremoval\b|\bdeportation\b|Temporary Protected Status/i;

/**
 * Whether a document concerns immigration: anything from EOIR, USCIS or ICE
 * or amending Title 8 of the CFR, and DHS or State Department documents
 * whose title, action or summary is about immigration. Form renewals under
 * the Paperwork Reduction Act are left out (they change no rule), as the
 * skill's sources leave them out.
 */
export function isImmigrationFederalRegisterDocument(doc: FederalRegisterDocument): { keep: boolean; reason: string } {
  if (PAPERWORK.test(doc.title)) return { keep: false, reason: "paperwork (information collection) notice" };
  const slugs = (doc.agencies ?? []).map((a) => a.slug ?? "").filter(Boolean);
  if (slugs.some((s) => IMMIGRATION_AGENCY_SLUGS.has(s))) return { keep: true, reason: "immigration agency" };
  if ((doc.cfr_references ?? []).some((c) => String(c.title ?? "") === "8")) return { keep: true, reason: "amends 8 CFR" };
  const text = [doc.title, doc.action ?? "", doc.abstract ?? ""].join(" ");
  if (IMMIGRATION_TERMS.test(text)) return { keep: true, reason: "immigration subject" };
  return { keep: false, reason: "not an immigration document" };
}

/** One kept document as an item: the API's own title, action, summary and DATES text. */
export function federalRegisterItem(doc: FederalRegisterDocument): ParsedItem | null {
  const officialUrl = doc.pdf_url || doc.html_url;
  if (!officialUrl) return null;
  const agencies = (doc.agencies ?? []).map((a) => a.name ?? a.raw_name ?? "").filter(Boolean);
  const excerpt = [
    doc.action ? `ACTION: ${doc.action}` : "",
    doc.abstract ? `SUMMARY: ${doc.abstract}` : "",
    doc.dates ? `DATES: ${doc.dates}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    externalId: doc.document_number,
    crossSourceKey: `fr:${doc.document_number}`,
    itemType: "Federal Register",
    title: doc.title.replace(/\s+/g, " ").trim(),
    citation: `${doc.type ? `${doc.type}, ` : ""}FR Doc. ${doc.document_number}`,
    officialUrl,
    documentUrl: null,
    publishedDateText: doc.publication_date ?? null,
    publishedOn: parseStatedDate(doc.publication_date),
    excerpt: excerpt || doc.title,
    listingFacts: {
      ...(agencies.length ? { agencies: agencies.join("; ") } : {}),
      ...(doc.html_url ? { federalRegisterPage: doc.html_url } : {}),
      ...(doc.type ? { documentType: doc.type } : {}),
    },
  };
}

/** One API page as a listing: kept documents become items; the rest are counted in the notes. */
export function parseFederalRegisterPage(json: unknown): ListingParse & { hasNextPage: boolean } {
  const { documents, hasNextPage } = parseFederalRegisterResponse(json);
  const items: ParsedItem[] = [];
  const left: Record<string, number> = {};
  for (const doc of documents) {
    const verdict = isImmigrationFederalRegisterDocument(doc);
    const item = verdict.keep ? federalRegisterItem(doc) : null;
    if (item) items.push(item);
    else left[verdict.reason] = (left[verdict.reason] ?? 0) + 1;
  }
  const notes = Object.entries(left).map(([reason, n]) => `${n} document(s) left out: ${reason}.`);
  return {
    items,
    rowsSeen: documents.length,
    // The response matched the API schema, so an empty page is a quiet period.
    recognized: true,
    notes,
    indexText: documents.map((d) => `${d.document_number} ${d.title}`).join("\n"),
    hasNextPage,
  };
}
