import { z } from "zod";
import { defineSkill } from "./types";

// Mirrors skills-content/declaration-draft/SKILL.md "Output format", items 1-3.
// Items 1-2 (the declaration and its signature and interpreter/translation
// certification blocks) are the Word document generate_document builds; the
// report carries its id and what the attorney needs to review it, never the
// declaration's text. The SKILL.md bundles no references, scripts or assets.

// The SKILL.md's section order for item 1: "identity/background ->
// chronology -> nexus -> fear -> protection/relocation -> timeliness (if
// relevant)", slashes as underscores.
const DECLARATION_PARTS = [
  "identity_background",
  "chronology",
  "nexus",
  "fear",
  "protection_relocation",
  "timeliness",
] as const;

export const declarationDraftOutputSchema = z.object({
  declaration: z.object({
    generatedDocumentId: z
      .string()
      .describe("document_id returned by generate_document for the final draft; empty if none could be generated"),
    notGeneratedReason: z
      .string()
      .optional()
      .describe("Why no Word document could be generated; only when generatedDocumentId is empty"),
    declarant: z
      .string()
      .describe("Whose declaration this is: the respondent, or a witness and their relationship to the respondent"),
    reliefInPlay: z
      .string()
      .describe(
        "The relief the narrative is organized to cover (asylum, withholding, CAT) and where that came from: a claim-evaluation result, the record, or the attorney's note"
      ),
    paragraphCount: z.number().int().min(0),
    sectionsInOrder: z.array(
      z.object({
        part: z.enum(DECLARATION_PARTS),
        paragraphs: z.string().describe('Paragraph numbers in the draft, e.g. "7-15"; empty if the draft has none for this part'),
      })
    ),
    factSources: z
      .array(z.string())
      .describe("Where the draft's facts came from: each record document by file name, and the attorney's note if used"),
    consistencyCheckedAgainst: z
      .array(z.string())
      .describe("The I-589, prior statements and intake in the record the draft was cross-checked against, by file name; empty if the record has none"),
  }),
  signatureBlock: z.object({
    included: z.boolean(),
    interpreterTranslationCertification: z
      .enum(["interpreter", "translation"])
      .optional()
      .describe(
        "The certification block the draft carries, where the declarant's language requires one: interpreter (read back through a competent interpreter) or translation (the declarant read it in a language they understand). Omit when none is included."
      ),
    declarantLanguage: z
      .string()
      .optional()
      .describe("The declarant's language as the record shows it; omit if the record does not say"),
  }),
  flagsForTheAttorney: z
    .array(z.string())
    .describe(
      "Every [CLARIFY] item in the draft, every consistency issue with the I-589, prior statements or intake, and every place corroboration should be lined up to match the narrative"
    ),
});
export type DeclarationDraftOutput = z.infer<typeof declarationDraftOutputSchema>;

export const declarationDraft = defineSkill({
  name: "declaration-draft",
  label: "Draft declaration",
  category: "asylum",
  kind: "build",
  description:
    "Drafts the respondent's or a witness's first-person, chronological declaration for an asylum, withholding or CAT case as a Word document, flagging every gap for the attorney.",
  outputSchema: declarationDraftOutputSchema,
  // The flags list is the SKILL.md's whole hand-off to the attorney (every
  // [CLARIFY] gap, consistency issue and corroboration need). A missing
  // document is added on top, so a run that produced no draft is never
  // mistaken for one that did.
  extractEscalationFlags: (output) => {
    const { declaration } = output;
    return [
      ...(declaration.generatedDocumentId.trim()
        ? []
        : [
            `No declaration document was generated in this run${
              declaration.notGeneratedReason ? `: ${declaration.notGeneratedReason}` : "."
            }`,
          ]),
      ...output.flagsForTheAttorney,
    ];
  },
  // read_prior_skill_reports: "Note which relief is in play (from
  // claim-evaluation if it's been run)"; that result exists only as the
  // earlier run's report on the matter.
  tools: ["read_prior_skill_reports", "generate_document", "render_and_qa_docx"],
  maxTokens: 128_000,
  // The drafting budget plus the read of the earlier reports.
  maxIterations: 18,
  needsNote: true,
  notePlaceholder:
    "Case note for Draft declaration (optional): whose declaration (the respondent, or a witness and their relationship), the relief in play if no claim evaluation has been run, the declarant's language, whether to revise a draft already on the matter, and any interview facts not in the uploaded documents.",
  applicableCaseTypes: ["asylum_affirmative", "asylum_defensive", "withholding_cat"],
});
