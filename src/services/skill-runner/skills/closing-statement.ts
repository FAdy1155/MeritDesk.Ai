import { z } from "zod";
import { defineSkill } from "./types";

// Mirrors skills-content/closing-statement/SKILL.md "8. Deliverables", items 1-5.
// Item 2 (the closing statement itself) is the Word document generate_document
// builds on the firm letterhead; the report carries its id and what the
// attorney needs to run section 9's self review against it (caption, section
// order, derivatives, country conditions sources, authorities), never the
// letter's text. The SKILL.md bundles no references, scripts or assets.
//
// The submission date: the runner does not state today's date (a run date
// line in the matter context is a pending shared change), and section 7
// forbids inventing a date, so submissionDate comes from the attorney's note
// or that line once it exists, and is otherwise a bracketed gap.

// Section 2's two formats, "Long numbered format" and "Short narrative format".
const LETTER_FORMATS = ["long_numbered_format", "short_narrative_format"] as const;

// Section 3: the full caption (the default) or the "Short-letter caption variant".
const CAPTION_VARIANTS = ["full_caption", "short_letter_caption_variant"] as const;

// Item 5: "Mark each as covered, thin, or absent."
const coverageMark = z.enum(["covered", "thin", "absent"]);
export type ClosingStatementCoverageMark = z.infer<typeof coverageMark>;

export const closingStatementOutputSchema = z.object({
  formatChoice: z.object({
    format: z.enum(LETTER_FORMATS),
    reason: z.string().describe("The one-line reason for the format, from section 2's criteria"),
  }),
  closingStatement: z.object({
    generatedClosingStatementDocumentId: z
      .string()
      .describe("document_id returned by generate_document for the final letter; empty if none could be generated"),
    notGeneratedReason: z
      .string()
      .optional()
      .describe(
        "Why no letter was generated, e.g. the record has no declaration or I-589 to build it from; only when generatedClosingStatementDocumentId is empty"
      ),
    pageCount: z.number().int().min(0).describe("Pages in the final letter as rendered; 0 if none was generated"),
    caption: z.object({
      variant: z.enum(CAPTION_VARIANTS),
      applicant: z.string().describe("Applicant name as printed in the RE block"),
      aNumber: z.string().describe("A number as printed, or the bracketed placeholder left in the draft"),
      asylumOffice: z.string().describe("Asylum office the letter is addressed to, as printed"),
      officeAddressConfirmedFrom: z
        .string()
        .describe(
          "Where the office address in the letter came from: the Houston Asylum Office address in section 3, a record document (by file name), or a uscis.gov page fetched in this run (its URL); say so if it is unconfirmed or not printed"
        ),
      salutation: z.string().describe("The salutation line as printed, e.g. with the officer's name and badge number"),
      interviewDate: z.string().optional().describe("Interview date as printed, if the interview has occurred"),
      submissionDate: z
        .string()
        .describe(
          "Date of submission as written out in the letter (Month D, YYYY), taken only from the attorney's note or a run date stated in the matter context; never from memory. When neither gives it, the bracketed placeholder printed in the letter instead (e.g. [DATE OF SUBMISSION]), which the gap list also names"
        ),
    }),
    sectionsInOrder: z
      .array(z.string())
      .describe("Long format: every heading exactly as printed, in order, lettered subsections included. Short format: empty."),
    derivativeApplicantsNamed: z.array(z.string()).describe("Every derivative applicant the letter names; empty if none"),
    countryConditionsSources: z.array(
      z.object({
        source: z.string().describe("The source as the letter names it"),
        date: z.string().describe("Its date as the letter gives it"),
        recordDocument: z.string().describe("The matter document it was taken from, by file name"),
      })
    ),
    authoritiesCited: z.array(
      z.object({
        citation: z.string(),
        verified: z
          .boolean()
          .describe(
            "true only if this run confirmed the authority's text on a page fetched with fetch_uscis_page; false for anything not confirmed that way, including INA section 208 cited as the house default and authority the attorney supplied"
          ),
        url: z.string().optional().describe("The page it was confirmed on, exactly as fetched; omit if not fetched in this run"),
        source: z
          .enum(["house_default", "attorney_supplied"])
          .describe("house_default: INA section 208 as section 6 prescribes. attorney_supplied: authority the attorney gave in the note or the record."),
      })
    ),
  }),
  gapList: z.array(
    z.object({
      gap: z.string().describe("A place where the record did not support what the letter needed"),
      whatWouldCloseIt: z.string(),
      placeholderInDraft: z
        .string()
        .optional()
        .describe("The bracketed placeholder left in the draft for this gap, exactly as printed, if any"),
    })
  ),
  issueCoverageCheck: z.array(
    z.object({
      issue: z.string().describe("An issue the officer raised at interview, in the officer's own terms"),
      whereAnswered: z
        .string()
        .describe("Where in the letter it is answered, e.g. a lettered subsection; empty if the letter does not answer it, which is a blocker"),
    })
  ),
  elementCoverageCheck: z.object({
    pastPersecutionOrWellFoundedFear: coverageMark,
    nexusToEachGround: z.array(z.object({ ground: z.string(), coverage: coverageMark })),
    stateProtection: coverageMark,
    internalRelocation: coverageMark,
    oneYearDeadline: coverageMark.optional().describe("Only if the one-year deadline is in issue"),
    bars: coverageMark.optional().describe("Only if a bar is in issue"),
  }),
});
export type ClosingStatementOutput = z.infer<typeof closingStatementOutputSchema>;

/** Item 5's elements marked "absent", by name, in the SKILL.md's order. */
function absentElements(check: ClosingStatementOutput["elementCoverageCheck"]): string[] {
  const absent: string[] = [];
  if (check.pastPersecutionOrWellFoundedFear === "absent") absent.push("past persecution or well-founded fear");
  if (check.nexusToEachGround.length === 0) absent.push("nexus to a protected ground (none listed)");
  for (const row of check.nexusToEachGround) {
    if (row.coverage === "absent") absent.push(`nexus to ${row.ground}`);
  }
  if (check.stateProtection === "absent") absent.push("state protection");
  if (check.internalRelocation === "absent") absent.push("internal relocation");
  if (check.oneYearDeadline === "absent") absent.push("one-year deadline");
  if (check.bars === "absent") absent.push("bars");
  return absent;
}

export const closingStatement = defineSkill({
  name: "closing-statement",
  label: "Draft closing statement",
  category: "asylum",
  kind: "build",
  description:
    "Drafts the post-interview attorney closing statement to the USCIS Asylum Office as a Word letter, with a gap list and issue and element coverage checks.",
  outputSchema: closingStatementOutputSchema,
  // Section 8 makes an unanswered interview issue a blocker, section 5 says
  // every element must appear, and sections 1, 3 and 6 route everything the
  // record could not support (no interview notes, the officer's name,
  // authority not supplied) to the attorney through the gap list.
  extractEscalationFlags: (output) => [
    ...(output.closingStatement.generatedClosingStatementDocumentId
      ? []
      : [`No closing statement was generated${output.closingStatement.notGeneratedReason ? `: ${output.closingStatement.notGeneratedReason}` : ""}`]),
    ...output.issueCoverageCheck
      .filter((row) => !row.whereAnswered.trim())
      .map((row) => `Blocker: interview issue not answered in the letter: ${row.issue}`),
    ...absentElements(output.elementCoverageCheck).map((element) => `Element absent from the letter: ${element}`),
    ...output.gapList.map((g) => g.gap),
  ],
  // fetch_uscis_page: section 3 says to confirm the address of any asylum
  // office other than Houston rather than assume it.
  // read_prior_skill_reports: the letter is built from the record (the
  // declaration, exhibits and country conditions materials); what
  // claim-evaluation, evidence-organizer and country-conditions-research
  // already filed on this matter exists only as those runs' reports.
  tools: ["read_prior_skill_reports", "fetch_uscis_page", "generate_document", "render_and_qa_docx", "search_library", "lookup_library_citation", "read_library_document"],
  maxTokens: 128_000,
  // Drafting, plus the address check and the read of the earlier reports.
  maxIterations: 20,
  needsNote: true,
  notePlaceholder:
    "Case note for Draft closing statement (optional): your interview notes (what the officer questioned, where the client struggled, anything adverse in the file), the officer's name and badge number, the interview date, the date of submission, the grounds argued, any derivatives, whether withholding or CAT is argued in the alternative, and any case authority to cite.",
  applicableCaseTypes: ["asylum_affirmative"],
});
