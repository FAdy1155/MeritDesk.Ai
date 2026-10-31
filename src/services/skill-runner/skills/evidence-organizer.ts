import { z } from "zod";
import { defineSkill } from "./types";

// The SKILL.md's "Output format" is a work-product report whose item 1 is
// the exhibit index itself, and step 3 produces "an Index of Documents /
// table of contents keyed to tabs" for the filing-ready packet, with step
// 7's filing checklist. The report keeps every item as structured data (the
// view and the escalation flags read them); the Index of Documents and the
// filing checklist are also built as a Word document with generate_document
// (rule 2.1.9), named by indexOfDocuments.generatedIndexOfDocumentsDocumentId.
// The skill organizes the record it is given; it does not research country
// conditions (country-conditions-research does, and hands its sources to this
// skill). Its web tools serve only "Before anything": checking the deadline,
// cover-page and service rules against the current manual and the court's
// LOP (see tools).

// Step 2's elements ("the same elements as claim-evaluation"), named in the
// descriptions below so every item of the report uses one vocabulary.
const STEP_2_ELEMENTS =
  "protected ground, PSG prongs, nexus, persecution/harm, state action, internal relocation, credibility, timeliness";

// One row of item 1's table, in column order. Step 1's inventory (what it
// is, source, date, language, original / copy / needs authentication) is
// carried by these columns: source and original-or-copy in Document.
const exhibitIndexRowSchema = z.object({
  tab: z.string().describe("The tab in the firm's house-style tabbing from the practice profile, e.g. Tab A"),
  document: z
    .string()
    .describe(
      "What it is in one line, its source, and whether the record copy is an original, a copy, or needs authentication. Only what the document itself shows; a matter file the run could not read keeps its NOT REVIEWED or EXCLUDED label, in capitals, with the reason given"
    ),
  date: z.string().describe('The date the document bears, as it appears on it; "undated" if it bears none'),
  elementsSupported: z
    .array(z.string())
    .describe(
      `The elements it supports, from step 2 (${STEP_2_ELEMENTS}); empty when it supports none, which flags it as background or clutter. Also empty for a file marked NOT REVIEWED or EXCLUDED: its elements are unknown, not none`
    ),
  languageTranslationStatus: z
    .string()
    .describe(
      "Its language, and for a foreign-language document whether a full certified English translation with the translator's certificate of competence is in the record"
    ),
});

// What a filing-checklist requirement is cited to. The guardrails require
// deadlines, page limits and service rules to be cited to "the current ICPM
// / court LOP" for attorney confirmation, never asserted from memory; a
// section confirmed on the live source in this run (fetch_uscis_page or
// web_fetch, on justice.gov or uscis.gov) is verified, and its url lets the
// matter page match it against the run's verification log.
const filingAuthoritySchema = z.object({
  citation: z
    .string()
    .describe(
      'The ICPM section, court LOP, Asylum Office source or regulation the requirement rests on; "the current ICPM / court LOP" when no section was confirmed in this run'
    ),
  verified: z
    .boolean()
    .describe("true only when this run fetched the page that states the requirement; a search result alone is not verification"),
  url: z.string().optional().describe("The page it was confirmed on, exactly as fetched; omitted when not fetched"),
});

// One entry of item 6: a step 7 requirement, its deadline when it has one,
// what it is cited to, and the "confirm against ICPM / court LOP" flag.
const filingChecklistItemSchema = z.object({
  item: z
    .string()
    .describe(
      "One mechanical requirement and where the record stands on it: cover page, index of documents, pagination per house style, proof of service on the DHS/ICE Office of the Principal Legal Advisor, the filing deadline for the venue, or another requirement of the filing source of truth"
    ),
  deadline: z
    .string()
    .optional()
    .describe(
      "For a requirement with a deadline: the rule as the cited source states it and, when the hearing or interview date is known, the date it yields. Never a fixed number of days from memory; omitted when the requirement has no deadline"
    ),
  citedTo: z.array(filingAuthoritySchema),
  confirmAgainstIcpmOrCourtLop: z
    .boolean()
    .describe(
      'true for every deadline, page limit, cover-page and service requirement: flagged "confirm against ICPM / court LOP" (for an Asylum Office submission, against current Asylum Office practice) for the attorney'
    ),
});

// Mirrors skills-content/evidence-organizer/SKILL.md "Output format", items 1-6.
// Item 6 also carries the venue the SKILL.md says to confirm before anything
// ("the cover sheet, filing mechanics, and deadlines differ"), the court or
// office whose LOP the deadlines are confirmed against, and step 7's ECAS
// submission steps ("if that integration is enabled").
export const evidenceOrganizerOutputSchema = z.object({
  exhibitIndex: z
    .array(exhibitIndexRowSchema)
    .describe("Every document provided, keyed to its tab (step 3's Index of Documents)"),
  elementToEvidenceMatrix: z
    .array(
      z.object({
        element: z.string().describe(`An element from step 2 (${STEP_2_ELEMENTS}) that applies to this claim`),
        supportingExhibits: z
          .array(z.string())
          .describe("Tabs of the exhibits that support it, as in the exhibit index; empty when none does"),
      })
    )
    .describe("One row per applicable element, including any that no exhibit supports"),
  corroborationGaps: z.array(
    z.object({
      missingItem: z
        .string()
        .describe(
          "An item of the firm's expected corroboration set (practice profile) the record lacks, or an exhibit the documents describe that the record does not contain (expected but not received)"
        ),
      reasonablyAvailable: z
        .boolean()
        .nullable()
        .describe(
          "true: it appears reasonably available (obtain it); false: it should be documented on the record as not reasonably available; null when the record does not show which"
        ),
      action: z.string(),
    })
  ),
  countryConditionsStatus: z.object({
    sourcesPresent: z.array(
      z.object({
        tab: z.string(),
        source: z.string().describe("Title and publisher, as the document states them"),
        date: z.string().describe("Publication date, as the document states it"),
        withinFirmTiers: z
          .boolean()
          .nullable()
          .describe("Whether the publisher is in the practice profile's accepted source tiers; null when the profile sets none"),
        withinRecencyRule: z
          .boolean()
          .nullable()
          .describe("Whether it is within the firm's recency rule; null when the document shows no date"),
      })
    ),
    currency: z
      .string()
      .describe(
        "The recency rule applied (from the practice profile) and its cutoff date, whether core reports (DOS Country Reports, UNHCR, HRW, Amnesty) anchor the packet, and anything stale or thin"
      ),
    recommendedAdditions: z
      .array(z.string())
      .describe(
        "Sources to add, named by publisher and report series; never an edition, date, title or URL not seen in the record or in a country-conditions-research report read in this run. Empty if none"
      ),
    expertDeclaration: z
      .array(z.string())
      .describe("Each issue on which the practice profile expects an expert declaration the record lacks; empty if none"),
  }),
  translationCertificationToDo: z
    .array(z.string())
    .describe(
      "One entry per document still needing a full certified English translation or the translator's certificate of competence: its tab, the document, its language, and what is missing. Empty if none"
    ),
  filingChecklist: z.object({
    venue: z
      .enum(["EOIR_defensive", "USCIS_Asylum_Office_affirmative"])
      .nullable()
      .describe("null when neither the matter, the documents nor the case note establishes it"),
    courtOrOffice: z
      .string()
      .optional()
      .describe("The immigration court or asylum office, when the matter, the documents or the case note names it"),
    items: z.array(filingChecklistItemSchema),
    ecasElectronicSubmissionSteps: z
      .array(z.string())
      .optional()
      .describe("Only when the practice profile shows ECAS electronic filing enabled; omitted otherwise (paper filing checklist)"),
  }),
  // Step 3's Index of Documents as the Word document that goes in the packet:
  // the exhibit index (item 1) in the firm's house-style tabbing, then the
  // filing checklist (item 6). Not a SKILL.md item of its own, so it comes
  // after them; the text stays in the Word file (rule 2.1.9).
  indexOfDocuments: z.object({
    generatedIndexOfDocumentsDocumentId: z
      .string()
      .describe(
        "document_id returned by generate_document for the final Index of Documents (item 1 keyed to tabs, then item 6's filing checklist); empty if none could be generated"
      ),
    notGeneratedReason: z
      .string()
      .optional()
      .describe("Why no Word document could be generated; only when generatedIndexOfDocumentsDocumentId is empty"),
    pageCount: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("Pages in the final document as rendered by render_and_qa_docx; null if it could not be rendered"),
  }),
});
export type EvidenceOrganizerOutput = z.infer<typeof evidenceOrganizerOutputSchema>;

// A matter file this run could not read (prompt.ts lists it as NOT REVIEWED
// or EXCLUDED, and the Document column keeps that label) has no elements
// because nobody read it. Calling it "background or clutter" would
// characterize a document the run never saw, which the guardrails forbid,
// so those rows are told apart by their label. The view keeps its own copy
// of this test so this module (and zod) stays out of the client bundle.
function wasNotReviewed(row: { document: string }): boolean {
  return /\bnot reviewed\b/i.test(row.document) || /\bEXCLUDED\b/.test(row.document);
}

function reasonablyAvailableLabel(value: boolean | null): string {
  if (value === null) return "availability not shown in the record";
  return value ? "reasonably available: obtain it" : "not reasonably available: document that on the record";
}

export const evidenceOrganizer = defineSkill({
  name: "evidence-organizer",
  label: "Build evidence index",
  category: "asylum",
  kind: "build",
  description:
    "Organizes an asylum or EOIR evidentiary record into a tabbed exhibit index with an element-to-evidence matrix, corroboration gaps, a country-conditions currency check, a translation and certification to-do list, and a filing checklist, with the Index of Documents and the checklist as a Word document.",
  outputSchema: evidenceOrganizerOutputSchema,
  // The output has no flags item, so the flags are what the SKILL.md tells
  // the attorney to act on, most urgent first: a missing Word Index of
  // Documents (so a run that produced none is never mistaken for one that
  // did), an unconfirmed venue, every
  // deadline and service rule flagged "confirm against ICPM / court LOP",
  // documents still needing translation or certification, the corroboration
  // gaps (REAL ID Act), files the run could not read (to map by hand),
  // elements no exhibit supports, reviewed exhibits that support no element
  // ("flag it"), and stale or missing country conditions and any expected
  // expert declaration ("flag where an expert declaration is expected").
  extractEscalationFlags: (output) => {
    const { filingChecklist, countryConditionsStatus: conditions, indexOfDocuments } = output;
    const notReviewed = output.exhibitIndex.filter(wasNotReviewed);
    return [
      ...new Set([
        ...(indexOfDocuments.generatedIndexOfDocumentsDocumentId.trim()
          ? []
          : [
              `No Index of Documents was generated in this run${
                indexOfDocuments.notGeneratedReason ? `: ${indexOfDocuments.notGeneratedReason}` : "."
              }`,
            ]),
        ...(filingChecklist.venue === null
          ? [
              "Venue not confirmed (EOIR defensive or USCIS Asylum Office affirmative): the cover sheet, filing mechanics and deadlines depend on it",
            ]
          : []),
        ...filingChecklist.items
          .filter((i) => i.confirmAgainstIcpmOrCourtLop)
          .map((i) => `Confirm against ICPM / court LOP: ${i.item}${i.deadline ? ` (deadline: ${i.deadline})` : ""}`),
        ...output.translationCertificationToDo.map((t) => `Translation or certification still needed: ${t}`),
        ...output.corroborationGaps.map(
          (g) => `Corroboration gap: ${g.missingItem} (${reasonablyAvailableLabel(g.reasonablyAvailable)}): ${g.action}`
        ),
        ...notReviewed.map((r) => `${r.tab} was not reviewed in this run (${r.document}): map it to elements by hand`),
        ...output.elementToEvidenceMatrix
          .filter((e) => e.supportingExhibits.length === 0)
          .map(
            (e) =>
              `No exhibit supports: ${e.element}${notReviewed.length > 0 ? " (among the documents reviewed in this run)" : ""}`
          ),
        ...output.exhibitIndex
          .filter((r) => r.elementsSupported.length === 0 && !wasNotReviewed(r))
          .map((r) => `${r.tab} (${r.document}) supports no element: background or clutter`),
        ...(conditions.sourcesPresent.length === 0 ? ["No country-conditions sources in the record"] : []),
        ...conditions.sourcesPresent
          .filter((s) => s.withinRecencyRule === false)
          .map((s) => `Stale country-conditions source: ${s.tab}, ${s.source}, dated ${s.date}`),
        ...conditions.expertDeclaration.map((e) => `Expert declaration expected: ${e}`),
      ]),
    ];
  },
  // "Before anything" requires deadline, cover-page and service rules to be
  // verified against the current manual and the specific court's local
  // operating procedures (Asylum Office practice for an affirmative filing).
  // fetch_uscis_page reads a manual chapter whose URL is known, in pages
  // with offset. It cannot search, and it refuses PDFs, which is how court
  // standing orders and Asylum Office procedure documents are often posted:
  // web_search below finds them and web_fetch reads them, PDFs included.
  // generate_document and render_and_qa_docx: step 3's Index of Documents
  // and step 7's filing checklist as the packet's Word document.
  // read_prior_skill_reports: country-conditions-research hands its sources
  // to this skill ("Hand the raw material to evidence-organizer next"), and
  // step 2 maps to claim-evaluation's elements; both exist only as those
  // runs' reports on the matter.
  tools: ["read_prior_skill_reports", "fetch_uscis_page", "generate_document", "render_and_qa_docx", "search_library", "lookup_library_citation", "read_library_document"],
  // Limited to the filing sources of truth the SKILL.md names: the ICPM and
  // the court's pages on justice.gov (EOIR), Asylum Office practice on
  // uscis.gov. ecfr.gov is left out (its pages send automated clients to an
  // access page; see eoir-filing-compliance). Fewer fetches per turn than
  // the default: every fetched PDF is resent with each later request of a
  // run that already carries the whole record, and with web_fetch the
  // matter's attachments get the smaller budget (run.ts).
  serverTools: [
    { name: "web_search", allowedDomains: ["justice.gov/eoir", "uscis.gov"] },
    { name: "web_fetch", maxUses: 5, allowedDomains: ["justice.gov", "uscis.gov"] },
  ],
  // The default maxTokens: an index and a checklist, not a long draft. More
  // requests than a report-only skill: the manual and LOP checks are round
  // trips of their own, then the document is drafted, rendered and fixed.
  maxIterations: 20,
  needsNote: true,
  notePlaceholder:
    "Case note for Build evidence index (optional): the venue (Immigration Court or Asylum Office) and which court or office, the next hearing or interview date and type, any filing deadline the court has set, and any exhibits you expect that are not uploaded yet.",
  applicableCaseTypes: ["asylum_affirmative", "asylum_defensive", "withholding_cat"],
});
