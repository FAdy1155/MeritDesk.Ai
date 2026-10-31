import { z } from "zod";
import { defineSkill } from "./types";

// One line of skills-content/asylum-merits-brief/references/self-review.md,
// as checked against the final draft. Step 5 says to fix what the checklist
// catches and flag the rest in the cover note, so each line records whether
// the final draft passes and what was fixed or is still open.
const selfReviewCheckSchema = z.object({
  check: z.string().describe("The checklist line, as references/self-review.md words it"),
  passes: z.boolean().describe("true if the final draft passes this line"),
  note: z
    .string()
    .describe("What was fixed to pass it, or what still fails and what the attorney must do; empty if it passed as drafted"),
});

// Mirrors skills-content/asylum-merits-brief/SKILL.md "Step 4: Produce the
// Word document" and "Step 5: Self-review and cover note". Step 4's brief is
// the Word document generate_document builds; the report carries its id and
// the Step 4 file check, never the brief's text. Step 5 is the checklist in
// references/self-review.md, tier by tier ("Blocking (fix before
// delivering)", "Should-fix", "Surface"), then the cover note's four items
// in SKILL.md order.
export const asylumMeritsBriefOutputSchema = z.object({
  wordDocument: z.object({
    generatedBriefDocumentId: z
      .string()
      .describe("document_id returned by generate_document for the final brief; empty if none could be generated"),
    opensAndRenders: z.boolean().describe("true only if the final document was rendered and its pages checked in this run"),
    sectionHeadingsInOrder: z
      .array(z.string())
      .describe("The COMES NOW opening (as \"COMES NOW opening\") and every heading after the cover page, as the final document prints them, in order"),
    allTenSectionsPresent: z.boolean().describe("The COMES NOW opening and Sections I to IX are all present, in order"),
    coverPagePresent: z.boolean(),
    certificateOfServicePresent: z.boolean(),
    fileCheckNotes: z
      .string()
      .describe("What the check of the finished file showed (page count, anything missing or out of place); if no document was generated, why"),
  }),
  selfReview: z.object({
    blocking: z.array(selfReviewCheckSchema).describe("Every line under \"Blocking (fix before delivering)\", in order"),
    shouldFix: z.array(selfReviewCheckSchema).describe("Every line under \"Should-fix\", in order"),
    surface: z.array(selfReviewCheckSchema).describe("Every line under \"Surface\", in order"),
  }),
  coverNote: z.object({
    legalTheory: z.object({
      statement: z.string().describe("The legal theory in three or four sentences"),
      groundsArgued: z.array(z.string()),
      particularSocialGroupsFormulated: z
        .array(z.string())
        .describe("Each particular social group exactly as the brief states it; empty if none is argued"),
      nexusTheory: z.string(),
    }),
    gapsList: z.array(
      z.object({
        gap: z.string().describe("What the record lacks, and what it would support"),
        kind: z.enum(["fact", "document", "corroboration"]),
      })
    ),
    citationsAddedBeyondAuthorityBank: z
      .array(
        z.object({
          citation: z.string(),
          verified: z.boolean().describe("true only if confirmed against its source in this run"),
          proposition: z.string().describe("What the brief cites it for, and in which section"),
          url: z.string().optional().describe("The page it was confirmed on, exactly as fetched; omit if not fetched in this run"),
        })
      )
      .describe("Every citation in the brief that is not in references/authority-bank.md; each stays NEEDS VERIFICATION for the attorney, even if confirmed in this run"),
    weaknesses: z.array(z.string()),
  }),
});
export type AsylumMeritsBriefOutput = z.infer<typeof asylumMeritsBriefOutputSchema>;

/**
 * Everything the skill routes to the supervising attorney: a brief that was
 * not generated or failed its Step 4 file check, every self-review line still
 * failing ("flag the rest in the cover note"), every citation added beyond the
 * authority bank (each marked NEEDS VERIFICATION), every weakness to weigh,
 * and every gap in the record ("it flags every gap for the attorney").
 */
function asylumMeritsBriefEscalationFlags(output: AsylumMeritsBriefOutput): string[] {
  const { wordDocument: doc, selfReview, coverNote } = output;
  const flags: string[] = [];

  if (!doc.generatedBriefDocumentId) {
    flags.push(`No brief was generated: ${doc.fileCheckNotes}`);
  } else {
    const failed = [
      doc.opensAndRenders ? null : "the file was not rendered and checked",
      doc.allTenSectionsPresent ? null : "not all ten sections are present",
      doc.coverPagePresent ? null : "no cover page",
      doc.certificateOfServicePresent ? null : "no certificate of service",
    ].filter((item): item is string => item !== null);
    if (failed.length > 0) flags.push(`Brief file check failed (${failed.join("; ")}): ${doc.fileCheckNotes}`);
  }

  const tiers = [
    ["blocking", selfReview.blocking],
    ["should-fix", selfReview.shouldFix],
    ["surface", selfReview.surface],
  ] as const;
  for (const [tier, checks] of tiers) {
    for (const check of checks) {
      if (!check.passes) flags.push(`Self-review (${tier}) still failing: ${check.check}${check.note ? ` - ${check.note}` : ""}`);
    }
  }

  // SKILL.md Step 3 and the blocking self-review line mark every added
  // citation NEEDS VERIFICATION; a fetch in this run is noted, never a release.
  for (const c of coverNote.citationsAddedBeyondAuthorityBank) {
    const fetched = c.verified ? ` (fetched in this run${c.url ? `: ${c.url}` : ""})` : "";
    flags.push(`Citation added beyond the authority bank, NEEDS VERIFICATION${fetched}: ${c.citation} - ${c.proposition}`);
  }
  for (const weakness of coverNote.weaknesses) flags.push(`Weakness to weigh: ${weakness}`);
  for (const g of coverNote.gapsList) flags.push(`Gap in the record (${g.kind}): ${g.gap}`);
  return flags;
}

export const asylumMeritsBrief = defineSkill({
  name: "asylum-merits-brief",
  label: "Draft asylum merits brief",
  category: "eoir",
  kind: "build",
  description:
    "Drafts the EOIR merits brief for asylum, withholding of removal and CAT protection (Houston Immigration Court, Fifth Circuit law) as a Word document from the client's own materials, with a cover note flagging every gap.",
  outputSchema: asylumMeritsBriefOutputSchema,
  extractEscalationFlags: asylumMeritsBriefEscalationFlags,
  // fetch_uscis_page: references/authority-bank.md says to verify each
  // "Recent updates" entry against its link before relying on it. The BIA
  // entries are listed on justice.gov, which the tool reaches; the court of
  // appeals entries link to uscourts.gov, which it does not, so those stay
  // with the attorney.
  // read_prior_skill_reports: Step 1 reads "everything the attorney
  // provided", country reports included; what claim-evaluation,
  // evidence-organizer and country-conditions-research already filed on
  // this matter (the element analysis, the exhibit tabs the brief cites,
  // retrieved sources) exists only as those runs' reports.
  tools: ["read_prior_skill_reports", "fetch_uscis_page", "generate_document", "render_and_qa_docx", "search_library", "lookup_library_citation", "read_library_document"],
  maxTokens: 128_000,
  // Drafting with authority checks, plus the read of the earlier reports.
  maxIterations: 22,
  needsNote: true,
  notePlaceholder:
    "Case note for Draft asylum merits brief (optional): the Immigration Judge, next hearing date and time, detained or non-detained, the signing attorney if not the default signer, and any facts or instructions not in the uploaded documents.",
  applicableCaseTypes: ["asylum_defensive", "withholding_cat"],
});
