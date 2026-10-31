import { z } from "zod";
import { defineSkill } from "./types";
import { LEGAL_AUTHORITY_FETCH_DOMAINS } from "../fetch-domains";

// One comment under BLOCKING, SHOULD-FIX or OPTIONAL. The SKILL.md: "For
// each comment give three things and nothing else": Location, Problem, Fix.
const reviewCommentSchema = z.object({
  location: z.string().describe("Page, section, or line, as precisely as the draft allows"),
  problem: z.string().describe("One sentence: what is wrong"),
  fix: z
    .string()
    .describe(
      "The specific edit: the drafted language where the fix is language; the document and the tab it should become where it is a document to attach; the fact needed and where it goes where only the attorney has it"
    ),
});

// Mirrors skills-content/eoir-motion-self-review/SKILL.md "7. Write the
// report", its report template in order: the "Pre-filing review: [motion
// type], [Respondent name], [A-number]" heading, the Reviewed / Not reviewed
// / Filing posture lines, then BLOCKING, SHOULD-FIX, OPTIONAL, VERIFY and
// VERDICT. The work-product header is presentation (the UI prints it). The
// skill reviews a draft and produces no document, so there is no document id.
export const eoirMotionSelfReviewOutputSchema = z.object({
  preFilingReview: z.object({
    motionType: z
      .string()
      .describe("The motion type and the relief it actually requests, e.g. motion to terminate without prejudice"),
    respondentName: z
      .string()
      .optional()
      .describe("As rendered on the motion cover; omitted when the draft does not give it (that absence is a finding)"),
    aNumber: z
      .string()
      .optional()
      .describe("As written on the motion cover; omitted when the draft does not give it (that absence is a finding)"),
  }),
  reviewed: z.array(z.string()).describe("What the review was given, one document or packet component per entry"),
  notReviewed: z.object({
    missing: z.array(z.string()).describe("What was missing, e.g. the exhibits, the proposed order, a tab cited in the body"),
    checksNotRun: z
      .array(z.string())
      .describe("Each check that could not be run, with the missing item it depends on; never silently skipped"),
  }),
  filingPosture: z.object({
    filingDate: z
      .string()
      .optional()
      .describe(
        "The filing date (the intended one, for a draft); omitted when neither the draft, the case note nor the matter gives it, and the missing input then goes to VERIFY"
      ),
    hearingDate: z
      .string()
      .optional()
      .describe("The next hearing date; omitted when not given, and the missing input then goes to VERIFY"),
    days: z.number().int().nullable().describe("Days from the filing date to the hearing date; null when either is missing"),
    deadline: z
      .string()
      .describe(
        "The deadline that applies to this motion type, court and detention status: the figure applied and its source, or the motion's own statutory clock with its arithmetic. When an input is missing, the deadline under each plausible answer"
      ),
    clears: z
      .boolean()
      .nullable()
      .describe("Clears (true) or does not clear (false) the deadline; null when a missing input leaves it undetermined"),
  }),
  blocking: z.array(reviewCommentSchema),
  shouldFix: z.array(reviewCommentSchema),
  optional: z.array(reviewCommentSchema),
  verify: z.array(
    z.object({
      whatToCheck: z.string(),
      where: z.string().describe("The source or place to check it: the document, the page, or the attorney"),
      citation: z
        .string()
        .optional()
        .describe("Only for a citation to check: the authority exactly as the draft cites it, never completed or corrected"),
    })
  ),
  verdict: z.object({
    survivesReviewAsFiled: z.boolean().describe("Would this survive a demanding supervisor's review as filed"),
    fixFirst: z
      .string()
      .optional()
      .describe("The single most important thing to fix first; omitted only when the review found nothing to fix"),
    statement: z.string().describe("The verdict itself, two or three sentences"),
  }),
});
export type EoirMotionSelfReviewOutput = z.infer<typeof eoirMotionSelfReviewOutputSchema>;

export const eoirMotionSelfReview = defineSkill({
  name: "eoir-motion-self-review",
  label: "Run motion self-review",
  category: "eoir",
  kind: "review",
  description:
    "Pre-filing QA review of a draft EOIR motion, returning a severity-tiered defect report with a concrete fix for every item.",
  outputSchema: eoirMotionSelfReviewOutputSchema,
  // BLOCKING is "cannot be filed as-is". Timeliness gates everything else
  // ("every substantive comment is conditional on curing that first"), so a
  // filing that does not clear its deadline, or whose timeliness the draft
  // leaves undetermined, is flagged on its own, as is a NO verdict with the
  // thing to fix first.
  extractEscalationFlags: (output) => {
    const { filingPosture: posture, verdict } = output;
    const arithmetic =
      `${posture.filingDate ?? "[filing date]"} to ${posture.hearingDate ?? "[hearing date]"} = ` +
      `${posture.days ?? "[N]"} days`;
    const flags = output.blocking.map((c) => `BLOCKING (${c.location}): ${c.problem}`);
    if (posture.clears === false) flags.push(`Filing does not clear its deadline (${arithmetic}): ${posture.deadline}`);
    if (posture.clears === null) flags.push(`Timeliness could not be determined (${arithmetic}): ${posture.deadline}`);
    if (!verdict.survivesReviewAsFiled) {
      flags.push(`Would not survive review as filed${verdict.fixFirst ? `. Fix first: ${verdict.fixFirst}` : "."}`);
    }
    return flags;
  },
  // fetch_ecfr_section (tools/eoir-filing-compliance.ts): Step 3 names the
  // governing regulation to the subsection, and Step 4 reads the text around
  // every quoted regulation for an exception the quote stops short of.
  // references/motion-elements.md rests each motion on 8 CFR sections
  // (1003.18(d), 1003.23(b), 1003.2(c), 1003.29, 1003.20(b), 1003.1(l) and
  // (m)). The eCFR's web pages send automated clients to a "Request Access"
  // page, and a fetch that lands on it still comes back as a successful one;
  // the tool reads the current section through the eCFR's API. Statute text
  // stays with web_fetch.
  // fetch_uscis_page: references/icpm-mechanics.md says to confirm the
  // deadline figures against the current Practice Manual, whose chapters are
  // HTML pages on justice.gov, as are the EOIR volume pages that list the
  // "Recent updates" in references/motion-elements.md. The decisions those
  // entries link to are PDF downloads, which this tool refuses; web_fetch
  // below reads them.
  // render_and_qa_docx: this skill generates nothing; it renders a Word
  // draft already on the matter, by the document_id the inventory prints
  // (prompt.ts inventoryLine), for Step 5's page checks (pagination, the
  // caption on every page, index page ranges), which a Word draft's
  // extracted text cannot show. A PDF of the draft already reaches the model
  // as pages. The key reserves matter image slots (run.ts).
  tools: ["fetch_ecfr_section", "fetch_uscis_page", "render_and_qa_docx", "search_library", "lookup_library_citation", "read_library_document"],
  // Step 4 reads past the quoted sentence to what the tribunal actually did
  // and pulls up the text around every quotation; for an authority not in
  // the tabs that means retrieving it, never recalling it. web_fetch also
  // reads the decision PDFs behind the motion-elements.md "Recent updates".
  // Search stays open (the SKILL.md names no sources); web_fetch opens the
  // legal-authority hosts in fetch-domains.ts only, since the run reads the
  // matter's documents. Default page size, because the outcome of a
  // decision is usually at its end.
  serverTools: ["web_search", { name: "web_fetch", allowedDomains: LEGAL_AUTHORITY_FETCH_DOMAINS }],
  maxIterations: 20,
  needsNote: true,
  notePlaceholder:
    "Case note for Run motion self-review (optional): which uploaded file is the draft motion and which are its exhibits; the intended filing date and the next hearing date; detained or non-detained; the assigned Immigration Judge; whether DHS opposes; for a motion to reopen, reconsider or rescind, the date of the order and any earlier motion of the same type.",
  // Any matter in removal proceedings: the SKILL.md's own examples include
  // termination so USCIS can adjudicate pending adjustment applications,
  // which in this app is usually an i130 matter. Affirmative asylum and
  // I-90 matters are not before EOIR.
  applicableCaseTypes: ["asylum_defensive", "withholding_cat", "cancellation", "vawa", "i130"],
});
