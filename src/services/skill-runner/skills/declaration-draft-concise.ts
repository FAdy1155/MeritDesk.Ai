import { z } from "zod";
import { defineSkill } from "./types";

// The page cap is the skill's first hard constraint ("Six pages maximum").
const MAX_PAGES = 6;

// The order item 1 fixes for the declaration's parts ("identity and protected
// characteristic, concise chronology, nexus, fear of return (longest
// section), protection and relocation, timeliness if relevant").
const DECLARATION_CONCISE_SECTIONS = [
  "identity_and_protected_characteristic",
  "concise_chronology",
  "nexus",
  "fear_of_return",
  "protection_and_relocation",
  "timeliness",
] as const;

// Mirrors skills-content/declaration-draft-concise/SKILL.md "Output format",
// items 1-3. Items 1-2 (the declaration and its signature and certification
// blocks) are the Word document generate_document builds; the report carries
// its id, the page count render_and_qa_docx showed (the 6-page cap), and the
// flags for the attorney, never the declaration's text.
export const declarationDraftConciseOutputSchema = z.object({
  declaration: z.object({
    generatedDocumentId: z
      .string()
      .describe("document_id returned by generate_document for the final draft; empty if none could be generated"),
    notGeneratedReason: z
      .string()
      .optional()
      .describe("Only when generatedDocumentId is empty: why no document could be generated"),
    declarantName: z.string(),
    declarantRole: z.enum(["respondent", "witness"]),
    pageCount: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe(
        "Pages in the final draft as render_and_qa_docx reported them; null if it could not be rendered. The 6-page maximum is in house format: when PRACTICE_PROFILE.md does not state the declaration's format, say in flagsForTheAttorney which format this count is in"
      ),
    paragraphCount: z.number().int().min(0),
    sectionsInOrder: z.array(
      z.object({
        section: z.enum(DECLARATION_CONCISE_SECTIONS),
        heading: z.string().optional().describe("The heading printed above this part, if the declaration uses headings"),
        firstParagraph: z.number().int().min(1),
        lastParagraph: z.number().int().min(1),
      })
    ),
  }),
  signatureBlock: z.object({
    included: z.boolean(),
    declarantLanguage: z
      .string()
      .optional()
      .describe("The declarant's language as the record shows it; omit if the record does not say"),
    // Item 2 makes the certification conditional ("where the client's language
    // requires it"), so the report records whether that condition holds;
    // otherwise a required block that is missing looks like one not needed.
    certificationRequired: z
      .boolean()
      .nullable()
      .describe(
        "Whether the declarant's language requires an interpreter or translation certification block; null if the record does not show enough to tell"
      ),
    certificationBlock: z
      .enum(["interpreter", "translation"])
      .optional()
      .describe(
        "The certification block the draft carries: interpreter (read back through a competent interpreter) or translation (the declarant read it in a language they understand). Omit when none is included."
      ),
  }),
  flagsForTheAttorney: z
    .array(z.string())
    .describe(
      "Every [CLARIFY] item left in the draft (with its paragraph number), every consistency issue with an I-589, prior statement or intake in the record (naming both sources; not corrected in the draft), every place corroboration should match the narrative, every strong fact cut to stay within 6 pages (so the attorney can decide whether to restore it), and any other open item the attorney must act on"
    ),
});
export type DeclarationDraftConciseOutput = z.infer<typeof declarationDraftConciseOutputSchema>;

/**
 * The flags for the attorney (item 3), preceded by what the report itself
 * shows breaks the skill's hard requirements: no document, the 6-page cap
 * exceeded or unconfirmed (the draft was not rendered), no fear-of-return
 * section (the spine of the declaration), no signature block, or a
 * certification block that the declarant's language requires (or may
 * require) and the draft lacks (item 2).
 */
function declarationDraftConciseFlags(output: DeclarationDraftConciseOutput): string[] {
  const { declaration, signatureBlock, flagsForTheAttorney } = output;
  const flags: string[] = [];

  if (!declaration.generatedDocumentId) {
    flags.push(
      `No declaration was generated in this run${declaration.notGeneratedReason ? `: ${declaration.notGeneratedReason}` : "."}`
    );
  } else {
    if (declaration.pageCount === null) {
      flags.push(`The draft was not rendered, so the ${MAX_PAGES}-page maximum is unconfirmed.`);
    } else if (declaration.pageCount > MAX_PAGES) {
      flags.push(`The draft is ${declaration.pageCount} pages; the maximum is ${MAX_PAGES}.`);
    }
    if (!declaration.sectionsInOrder.some((s) => s.section === "fear_of_return")) {
      flags.push("The draft has no fear-of-return section, the part this declaration is built around.");
    }
    if (!signatureBlock.included) {
      flags.push("The draft has no signature block.");
    }
    if (!signatureBlock.certificationBlock) {
      if (signatureBlock.certificationRequired === true) {
        const language = signatureBlock.declarantLanguage ? ` (${signatureBlock.declarantLanguage})` : "";
        flags.push(
          `The declarant's language${language} requires an interpreter or translation certification block, and the draft has none.`
        );
      } else if (signatureBlock.certificationRequired === null) {
        flags.push(
          "The draft has no interpreter or translation certification block, and the report could not tell whether the declarant's language requires one; confirm the declarant's language."
        );
      }
    }
  }

  return [...flags, ...flagsForTheAttorney];
}

export const declarationDraftConcise = defineSkill({
  name: "declaration-draft-concise",
  label: "Draft concise declaration",
  category: "asylum",
  kind: "build",
  description:
    "Drafts a short first-person declaration of 6 pages or fewer, centered on the fear of return, as a Word document from the client's own account, flagging every gap.",
  outputSchema: declarationDraftConciseOutputSchema,
  extractEscalationFlags: declarationDraftConciseFlags,
  // read_prior_skill_reports: "Note which relief is in play (from
  // claim-evaluation if it has been run)"; that result exists only as the
  // earlier run's report on the matter.
  tools: ["read_prior_skill_reports", "generate_document", "render_and_qa_docx"],
  maxTokens: 128_000,
  // The drafting budget plus the read of the earlier reports.
  maxIterations: 18,
  needsNote: true,
  notePlaceholder:
    "Case note for Draft concise declaration (optional): interview notes or facts not in the uploaded documents, the relief in play, whether the declarant is the respondent or a witness, the declarant's language, and any one-year deadline facts.",
  applicableCaseTypes: ["asylum_affirmative", "asylum_defensive", "withholding_cat"],
});
