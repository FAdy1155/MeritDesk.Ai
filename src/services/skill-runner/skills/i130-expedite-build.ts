import { z } from "zod";
import { defineSkill } from "./types";

// The generate_docx tool (tool key generate_docx_i130 in tools.ts) runs the
// multi-tenant copy of the firm's letter script,
// src/services/docx-generator/templates/i130-expedite/make_expedite_letter.py.
// These schemas live here so the skill's generator contract and its report
// schema stay in one file; neither is a submit_report schema.

// What the model writes: the letter's content, and optionally which roster
// entry signs. This is the tool's input_schema. Letterhead and signer details
// are deliberately absent: the server fills them from the firm identity, so
// the model cannot put another firm's letterhead or another person's name or
// signature on a letter (unknown keys are stripped by the parse).
export const i130ExpediteLetterContentSchema = z.object({
  letter_date: z.string(),
  body_alignment: z.enum(["justify", "left"]).optional(),
  recipient: z.array(z.string()),
  re_heading: z.string(),
  re_lines: z.array(z.string()),
  salutation: z.string().optional(),
  body: z.array(z.string()),
  exhibits: z.array(z.string()).optional(),
  body_after_exhibits: z.array(z.string()).optional(),
  closing: z.string().optional(),
  enclosures: z.array(z.string()).optional(),
  signer_attorney_id: z
    .string()
    .optional()
    .describe(
      "id of the roster entry (FIRM IDENTITY section) who signs, when the attorney's note names someone other than the default signer (never on the strength of the matter's documents alone); omit to use the default signer"
    ),
  wet_signature: z
    .boolean()
    .optional()
    .describe(
      "true leaves blank space for a handwritten signature instead of the signer's signature image or /s/ line; only when the attorney's note asks for a wet signature"
    ),
});
export type I130ExpediteLetterContent = z.infer<typeof i130ExpediteLetterContentSchema>;

// What the server adds from the tenant's firm identity: the letterhead and
// the signature block. signer.signature: "image" (signature_image, a bare
// file name the server writes next to the spec), "conformed" ("/s/ name"
// when no image is on file), or "blank" (space for a wet signature).
export const i130ExpediteLetterFirmFieldsSchema = z.object({
  firm: z.object({
    name: z.string().min(1),
    address_lines: z.array(z.string().min(1)).min(1),
    licensure_line: z.string().optional(),
    phone: z.string().min(1),
    fax: z.string().optional(),
    email: z.string().min(1),
    website: z.string().optional(),
  }),
  signer: z.object({
    name: z.string().min(1),
    title: z.string().optional(),
    signature: z.enum(["image", "conformed", "blank"]),
    signature_image: z.string().optional(),
  }),
});

// The complete spec.json the script reads: the content plus the firm fields.
export const i130ExpediteLetterSpecSchema = i130ExpediteLetterContentSchema
  .omit({ signer_attorney_id: true, wet_signature: true })
  .extend(i130ExpediteLetterFirmFieldsSchema.shape);
export type I130ExpediteLetterSpec = z.infer<typeof i130ExpediteLetterSpecSchema>;

// Mirrors skills-content/i130-expedite-build/SKILL.md "SECTION 7. DELIVERABLES",
// items 1-10 (item 5, the letter itself, is the generated document's id).
export const i130ExpediteBuildOutputSchema = z.object({
  caseSnapshot: z.object({
    petitionerName: z.string(),
    beneficiaryName: z.string(),
    receiptNumber: z.string(),
    officeHoldingCase: z.string(),
    screenResults: z.object({
      isReceipted: z.boolean(),
      withinPostedProcessingTime: z.boolean().nullable(),
      urgencyFlowsFromDelay: z.boolean(),
      inRemovalOrDetainedOrFinalOrder: z.boolean(),
    }),
  }),
  attorneyQuestionList: z.array(z.string()),
  groundDetermination: z.object({
    primaryGround: z.string(),
    secondaryGround: z.string().optional(),
    operativeFacts: z.array(z.object({ fact: z.string(), sourceDocument: z.string() })),
    whatApprovalUnlocks: z.string(),
    honestWeakness: z.string(),
  }),
  verificationLog: z.array(
    z.object({
      item: z.string(),
      confirmed: z.boolean(),
      sourceUrl: z.string().optional(),
      dateConfirmed: z.string().optional(),
    })
  ),
  generatedLetterDocumentId: z
    .string()
    .describe("The document_id returned by generate_docx for the final letter"),
  exhibitIndex: z.array(
    z.object({
      exhibitLetter: z.string(),
      document: z.string(),
      provesWhat: z.string(),
      supportsSentence: z.string(),
      originalOrCopy: z.enum(["original", "copy"]),
      translationStatus: z.string(),
    })
  ),
  evidenceGapList: z.array(
    z.object({
      missingDocument: z.string(),
      whoObtains: z.string(),
      howLong: z.string(),
      weakerWithout: z.string(),
    })
  ),
  submissionPlan: z.object({
    channel: z.string(),
    why: z.string(),
    filingChecklist: z.array(z.string()),
  }),
  calendarItems: z.array(z.object({ date: z.string().optional(), description: z.string() })),
  qaReport: z.object({
    blocking: z.array(z.string()),
    serious: z.array(z.string()),
    polish: z.array(z.string()),
  }),
});
export type I130ExpediteBuildOutput = z.infer<typeof i130ExpediteBuildOutputSchema>;

export const i130ExpediteBuild = defineSkill({
  name: "i130-expedite-build",
  label: "Build I-130 expedite request",
  category: "uscis",
  kind: "build",
  description:
    "Builds an I-130 expedite request letter with the exhibit index, gap list and filing checklist.",
  outputSchema: i130ExpediteBuildOutputSchema,
  extractEscalationFlags: (output) => output.qaReport.blocking,
  // fetch_uscis_page: SECTION 3's live checks on uscis.gov, the I-130's
  // current posted processing time among them, which USCIS posts on
  // egov.uscis.gov (on the tool's allow list). That page is built by
  // script, so its fetched text may not carry the times; the check then
  // comes back unconfirmed in the verification log item.
  tools: ["fetch_uscis_page", "generate_docx_i130", "render_and_qa_docx", "search_library", "lookup_library_citation", "read_library_document"],
  // A drafting skill (docs/ADDING_A_SKILL.md 2.5): the live checks, then
  // draft, render, fix, render and submit.
  maxIterations: 16,
  needsNote: true,
  notePlaceholder:
    "Case note for I-130 expedite build (optional): the I-797C receipt details, what's urgent, and in your own words why. Everything else comes from uploaded documents.",
  applicableCaseTypes: ["i130"],
});
