// Types shared by the legal-update monitor (the platform version of the
// eoir-weekly-update skill). Pure: no server-only, no database, so the
// parsers and diffing that use them can be exercised from a plain tsx script.

/** Every official source the monitor checks (src/services/monitoring/sources.ts). */
export type LegalUpdateSourceKey =
  | "eoir_ag_bia_precedent"
  | "eoir_policy_memoranda"
  | "eoir_icpm"
  | "eoir_bia_practice_manual"
  | "eoir_policy_manual_changes"
  | "eoir_notices"
  | "eoir_federal_register"
  | "federal_register"
  | "uscis_policy_manual_updates"
  | "uscis_forms_updates"
  | "ca1"
  | "ca2"
  | "ca3"
  | "ca4"
  | "ca5"
  | "ca6"
  | "ca7"
  | "ca8"
  | "ca9"
  | "ca10"
  | "ca11";

/**
 * The Type line of the skill's entry format, plus the two USCIS listings the
 * platform adds and the kinds of document the library's daily collection
 * feeds in (src/services/library/legal-updates.ts).
 */
export type LegalUpdateItemType =
  | "BIA precedent"
  | "AG precedent"
  | "AAO precedent"
  | "Policy memorandum"
  | "Practice Manual"
  | "EOIR notice"
  | "Federal Register"
  | "Court of appeals published opinion"
  | "USCIS form update"
  | "USCIS Policy Manual update"
  | "Supreme Court opinion"
  | "USCIS policy memorandum"
  | "USCIS policy alert"
  | "TPS designation"
  | "Visa Bulletin"
  | "EOIR form";

/**
 * One item exactly as a source's listing gives it, before anything is
 * stored. Every text field comes from the listing itself; a parser never
 * fills one from anywhere else.
 */
export type ParsedItem = {
  /** Stable identifier within the source ("ID 4259", "PM 26-07", an FR document number, docket plus opinion file). */
  externalId: string;
  /** The same document as another source lists it ("fr:2026-01868", "intdec:4259"), when there is one. */
  crossSourceKey?: string | null;
  itemType: LegalUpdateItemType;
  title: string;
  citation?: string | null;
  /** https, on the source's document host list. */
  officialUrl: string;
  /** The PDF to read before summarizing, when the listing alone is not enough. */
  documentUrl?: string | null;
  /** The date exactly as the source states it. */
  publishedDateText?: string | null;
  /** That date as YYYY-MM-DD, when it parses. */
  publishedOn?: string | null;
  /** The listing's own text for the item, whitespace normalized. */
  excerpt: string;
  /** Circuit number ("5") for a court of appeals opinion. */
  circuit?: string | null;
  /** Other facts the listing states (origin, case type, agencies). */
  listingFacts?: Record<string, string>;
  /** The listing page the item was read from (set by the collector). */
  listedOnUrl?: string;
};

/** What a parser read from one listing page. */
export type ListingParse = {
  items: ParsedItem[];
  /** Rows the parser read (table rows, list entries, feed items), kept or not. */
  rowsSeen: number;
  /**
   * False when the page's markup no longer matches the parser (its list,
   * table or feed is not there): the collector reports the check as failed
   * instead of mistaking it for a quiet week.
   */
  recognized: boolean;
  /** What was read and left out, and why (shown with the source's check). */
  notes: string[];
  /** The listing's visible text, hashed per check to tell an unchanged page from a quiet one. */
  indexText: string;
};

/** One passage the API cited from a fetched PDF (citations feature): the text is the document's own. */
export type DocumentQuote = {
  label: string;
  text: string;
  startPage: number | null;
  endPage: number | null;
};

/** Why one skill is listed as affected. */
export type AffectedSkillBasis = { skill: string; basis: string };

/** legal_updates.analysis: everything the summary step decided, and on what basis. */
export type LegalUpdateAnalysis = {
  /** Passages of the source text the summary rests on, each checked against it. */
  verifiedPassages: string[];
  /** Passages the model offered that were not found in the source text (dropped). */
  rejectedPassages: string[];
  affectedSkillBases: AffectedSkillBasis[];
  /** Where the item may change the firm's reference text (routing.md target files), heading copied from the file. */
  checkAgainstFirmText: { file: string; heading: string; note: string }[];
  /** Open questions for the attorney (the skill's "Needs a decision"). */
  needsDecision: string[];
  /** The model's keep or screen decision under sources.md, with its reason. */
  scope: { decision: "keep" | "screen_out"; reason: string };
  /** The document read for this item, if any. */
  document: { url: string; sha256: string; bytes: number; retrievedAt: string } | null;
  /** Models that served the summary requests (more than one when the refusal fallback ran). */
  modelsServed: string[];
};
