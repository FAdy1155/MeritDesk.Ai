import { z } from "zod";
import { defineSkill } from "./types";

// Mirrors skills-content/orthography-check/SKILL.md "Report structure": the
// template's title line ("# Orthography Check: [document name]") and its
// sections Summary, Fixed, Flagged for your decision, Name and term
// consistency and Document-wide notes, in that order; then the line under
// the template ("If a category has no issues, say so briefly rather than
// omitting it") and, with the same aim ("so the author knows it was actually
// checked"), the parts of the source that were not checked; then the
// Workflow's other deliverable (steps 4-5), the corrected copy. The corrected copy is a file the tools produce (rule
// 2.1.9): make_corrected_copy edits the author's Word or text file in place,
// as references/file-handling.md requires, and generate_document builds a new
// Word file from a PDF or scanned source. The report carries its id, never
// the corrected text.

// The SKILL.md's "Five categories, in this order" (the bold titles under
// "What to check"), spaces as underscores.
const ORTHOGRAPHY_CATEGORIES = [
  "Spelling_and_typos",
  "Diacritics_and_accents_on_names",
  "Consistent_spelling_of_names_and_terms",
  "Singular/plural_(number)_agreement",
  "Pronoun_consistency_and_agreement",
] as const;

const categorySchema = z.enum(ORTHOGRAPHY_CATEGORIES);

const locationSchema = z
  .string()
  .describe("Where a human finds it fast: paragraph number, a short heading name, or a quoted snippet of the surrounding words");

export const orthographyCheckOutputSchema = z.object({
  documentName: z
    .string()
    .describe("The [document name] of the report title: the checked document's file name, or a short description of text pasted into the case note"),
  summary: z.string().describe("One or two sentences: how many issues, how many fixed vs. flagged, overall readiness"),
  fixed: z
    .array(
      z.object({
        number: z.number().int().min(1),
        location: locationSchema,
        category: categorySchema,
        original: z.string(),
        corrected: z.string(),
      })
    )
    .describe("Fixed (applied to the corrected copy): only certain, cosmetic fixes, each one actually made in the corrected copy"),
  flaggedForYourDecision: z
    .array(
      z.object({
        number: z.number().int().min(1),
        location: locationSchema,
        category: categorySchema,
        text: z.string(),
        whyFlagged: z.string(),
        options: z.string(),
      })
    )
    .describe("Flagged for your decision (NOT changed): left as the author wrote them in the corrected copy, including [sic] candidates inside direct quotations"),
  nameAndTermConsistency: z
    .array(
      z.object({
        nameOrTerm: z.string(),
        variants: z.array(z.object({ spelling: z.string(), count: z.number().int().min(0) })),
        standardizedTo: z
          .string()
          .optional()
          .describe("The spelling the variants were aligned to; omit when they were flagged for the author instead (they may be two people)"),
      })
    )
    .describe("Every name or term found with variants: the variants, the count of each, and which one was standardized to"),
  documentWideNotes: z
    .array(z.string())
    .optional()
    .describe("Observations that apply across the whole document, such as a name that is probably accented but never written that way; omit when there are none"),
  categoriesWithNoIssues: z
    .array(z.object({ category: categorySchema, note: z.string() }))
    .describe("Each of the five categories that had no issues, said briefly, so the author knows it was actually checked"),
  notChecked: z
    .array(z.string())
    .describe(
      "Each part of the source that was not checked, so the author does not take it as clean: what make_corrected_copy lists as not in the text you were given (text boxes, footnotes, endnotes, comments, other headers), pages or documents the run's inventory marks NOT REVIEWED, unreadable passages. Empty when the whole document was checked"
    ),
  correctedCopy: z.object({
    generatedCorrectedCopyDocumentId: z
      .string()
      .describe("document_id of the final corrected copy, from make_corrected_copy or generate_document; empty if none could be generated"),
    sourceFormat: z
      .enum(["txt", "pasted_text", "docx", "pdf", "scanned_or_image_pdf"])
      .describe("txt: a plain-text file; pasted_text: text in the case note; scanned_or_image_pdf: a PDF without a usable text layer, or an image"),
    deliveredFormat: z
      .enum(["docx", "txt"])
      .describe("docx: a Word file; txt: a plain-text file (in the source's own extension for a text upload)"),
    trackedChanges: z.boolean().describe("true when the Word copy carries each fix as a tracked change the author can accept or reject"),
    note: z
      .string()
      .optional()
      .describe(
        "Why no copy could be generated (required when the id is empty), or what the author must know about the copy: that the source was a PDF and the copy is a new file, or that OCR may have introduced some of the flagged typos. Parts not checked go in notChecked"
      ),
  }),
});
export type OrthographyCheckOutput = z.infer<typeof orthographyCheckOutputSchema>;

/** "Singular/plural_(number)_agreement" -> "Singular/plural (number) agreement". */
function categoryLabel(category: OrthographyCheckOutput["fixed"][number]["category"]): string {
  return category.replace(/_/g, " ");
}

export const orthographyCheck = defineSkill({
  name: "orthography-check",
  label: "Run orthography check",
  category: "general",
  kind: "review",
  description:
    "Proofreads a document for spelling, accents on names, consistent spelling of names and terms, singular/plural agreement and pronoun consistency, and returns a report of fixes and flagged items plus a corrected copy.",
  outputSchema: orthographyCheckOutputSchema,
  // What the SKILL.md leaves for the human: every flagged item ("flag it and
  // let the human decide"), every standardized name or term ("the category
  // most likely to need the author's confirmation"; unstandardized variants
  // are already flagged items) and every document-wide note ("needing one
  // confirmation from the author"). First come the limits of the run: a
  // missing corrected copy, or the copy's note (a PDF rebuilt as a new file,
  // OCR that may explain some typos: "warn the user", file-handling.md), and
  // every part not checked, so a run that delivered no copy or skipped
  // footnotes is never mistaken for a complete one.
  extractEscalationFlags: (output) => [
    ...(output.correctedCopy.generatedCorrectedCopyDocumentId.trim()
      ? output.correctedCopy.note?.trim()
        ? [`Corrected copy: ${output.correctedCopy.note}`]
        : []
      : [`No corrected copy was generated in this run${output.correctedCopy.note ? `: ${output.correctedCopy.note}` : "."}`]),
    ...output.notChecked.map((n) => `Not checked: ${n}`),
    ...output.flaggedForYourDecision.map(
      (f) => `Flagged ${f.number} (${categoryLabel(f.category)}, ${f.location}): ${f.text} - ${f.whyFlagged}`
    ),
    ...output.nameAndTermConsistency
      .filter((n) => n.standardizedTo)
      .map(
        (n) =>
          `Confirm "${n.nameOrTerm}" standardized to "${n.standardizedTo}" (variants: ${n.variants
            .map((v) => `"${v.spelling}" x${v.count}`)
            .join(", ")})`
      ),
    ...(output.documentWideNotes ?? []),
  ],
  tools: ["make_corrected_copy_orthography", "generate_document", "render_and_qa_docx"],
  // A PDF's corrected copy is the whole document passed to generate_document in one turn.
  maxTokens: 128_000,
  maxIterations: 16,
  needsNote: true,
  notePlaceholder:
    "Case note for Run orthography check (optional): which document to proofread (its file name) if the matter has several, whether the corrected Word copy should carry tracked changes, or text pasted here to proofread instead of an uploaded document.",
});
