import { z } from "zod";
import { defineSkill } from "./types";

// The elements SKILL.md "Output" item 2 lists, in its order. Each row of the
// element coverage table is one of these, and the table has all of them.
export const ASYLUM_INTERVIEW_PREP_COVERAGE_ELEMENTS = [
  "statutory_bars",
  "firm_resettlement_including_any_unpursued_right_to_citizenship",
  "date_and_manner_of_entry",
  "one-year_deadline",
  "protected_ground",
  "past_persecution",
  "nexus",
  "state_unwilling_or_unable_to_protect",
  "internal_relocation",
  "well-founded_fear",
  "torture_and_acquiescence",
  "credibility_and_application_accuracy",
  "derivative_eligibility",
] as const;

// The QA gate's report. SKILL.md "Then run the QA gate" says to hand the
// output to asylum-interview-prep-review and include its report; the run
// loads that skill's instructions with the load_qa_gate_skill tool (tools/
// asylum-interview-prep-build.ts). This mirrors
// skills-content/asylum-interview-prep-review/SKILL.md "Report format",
// items 1-10, plus its closing line (the most exposed point). Each finding
// carries what that section asks for: "the exact location with the question
// quoted, the problem in one sentence, and a concrete fix".
const qaGateFindingSchema = z.object({
  rules: z
    .array(z.string())
    .describe("The review rules the finding violates (e.g. A3, D1); one finding cites every rule it breaks"),
  location: z.string().describe("The part heading and sub-block label in the question set"),
  quotedQuestion: z
    .string()
    .optional()
    .describe("The question, quoted exactly; omitted only when the finding is about something missing"),
  problem: z.string().describe("The problem in one sentence"),
  fix: z
    .string()
    .describe(
      "A concrete fix, or, where a fix would mean inventing a fact or researching outside the record, one line naming what the attorney must supply"
    ),
});

const qaGateCoverageRowSchema = z.object({
  item: z.string(),
  coveredIn: z
    .array(z.string())
    .describe("The part(s) of the question set that cover it, as headed there; empty when none does"),
});

const qaGateReportSchema = z.object({
  draftSnapshot: z.object({
    draftType: z.enum(["client", "template"]),
    country: z.string(),
    claimType: z.string(),
    venue: z.string(),
    documentsReviewed: z.array(z.string()),
    notProvided: z.array(z.string()),
  }),
  coverageTables: z.object({
    required: z.array(qaGateCoverageRowSchema).describe("Section C1, every item"),
    recommended: z.array(qaGateCoverageRowSchema).describe("Section C2, every item"),
  }),
  blocking: z.array(qaGateFindingSchema),
  shouldFix: z.array(qaGateFindingSchema),
  unverified: z.array(
    z.object({
      check: z.string(),
      whatIsNeeded: z.string(),
      requiredCheck: z
        .boolean()
        .describe("true for a required check (a section C1 item, or one whose failure would be BLOCKING)"),
    })
  ),
  optional: z.array(qaGateFindingSchema),
  escalationFlags: z.array(z.string()),
  verdict: z.object({
    result: z.enum(["PASS", "FAIL", "CANNOT_CERTIFY"]),
    whatWouldConvert: z
      .string()
      .optional()
      .describe("For CANNOT_CERTIFY: what would convert it"),
    recommendedGaps: z
      .array(z.string())
      .describe("The recommended (section C2) gaps, stated separately from the verdict"),
  }),
  officerQuestionsNotPreparedFor: z.array(z.string()),
  prioritizedEditChecklist: z.array(
    z.object({
      priority: z.enum(["BLOCKING", "SHOULD-FIX", "OPTIONAL"]),
      item: z.string(),
    })
  ),
  mostExposedPoint: z
    .string()
    .describe("The point in the claim most exposed as the draft frames it, or \"not assessed, no record provided\""),
});

// Mirrors skills-content/asylum-interview-prep-build/SKILL.md "Output",
// items 1-5, then the report "Then run the QA gate" tells the build to
// include (qaGateReport, above). Item 1, the question set itself, is the Word
// document generate_document builds; the report carries its id and what the
// attorney needs to review it (the two things SKILL.md "Before anything" says
// to confirm before drafting, the parts as built, and the interpreter flag
// its Before the Interview step requires), never the questions.
// SKILL.md also has a stop path ("If the case is defensive, say so and
// stop"), so what only exists once a question set is drafted (its title, the
// interpreter flag) or generated (the QA gate's report) is optional, and
// extractEscalationFlags flags it when it is missing although it should not be.
export const asylumInterviewPrepBuildOutputSchema = z.object({
  completeQuestionSet: z.object({
    generatedQuestionSetDocumentId: z
      .string()
      .describe("document_id returned by generate_document for the final question set; empty if none was generated"),
    notGeneratedReason: z
      .string()
      .optional()
      .describe("Why no question set was generated (for example, the case is defensive); only when the id is empty"),
    title: z
      .string()
      .optional()
      .describe(
        "The title as printed: the instrument, the claim type, and the client's name; omitted only when the run stopped before drafting (e.g. the case is defensive)"
      ),
    venue: z.object({
      affirmativeAsylumOfficeInterview: z
        .boolean()
        .nullable()
        .describe("true for a USCIS Asylum Office affirmative interview, false for an EOIR defensive case, null if the file does not show which"),
      basis: z.string().describe("What in the matter or its documents shows the venue"),
    }),
    recordProvided: z.object({
      documents: z.array(z.string()).describe("The documents the question set was built from, by file name"),
      i589Provided: z.boolean(),
      limitations: z
        .array(z.string())
        .describe("What could not be built properly from what was provided (e.g. Application Review without the I-589); empty if nothing"),
    }),
    parts: z
      .array(
        z.object({
          heading: z.string().describe("As printed: \"Before the Interview\" or \"Part N: Title\""),
          subBlocks: z
            .array(z.string())
            .describe("The labels of its sub-groupings, in order (incident names, numbered persecutors, family members); empty if none"),
          questionCount: z.number().int().min(0),
          added: z.boolean().describe("true when the part is labeled [ADDED]"),
        })
      )
      .describe("Every part as built, in order; empty when the run stopped before drafting"),
    interpreterRequirement: z
      .object({
        statedInOrientation: z
          .string()
          .describe("What Before the Interview tells the client about who supplies the interpreter and who may serve as one"),
        verified: z
          .boolean()
          .describe("true only if the current requirement was confirmed in this run on a page fetched with fetch_uscis_page"),
        url: z.string().optional().describe("The page it was confirmed on, exactly as fetched"),
        attorneyFlag: z
          .string()
          .describe("The flag for the attorney to confirm the current interpreter requirement before the interview"),
      })
      .optional()
      .describe(
        "The Before the Interview interpreter rule and its attorney flag; omitted only when the run stopped before drafting (e.g. the case is defensive)"
      ),
  }),
  elementCoverageTable: z
    .array(
      z.object({
        element: z.enum(ASYLUM_INTERVIEW_PREP_COVERAGE_ELEMENTS),
        reached: z.boolean(),
        whereReached: z
          .array(z.string())
          .describe("The part(s) and sub-blocks that reach it, as headed in the question set; empty when not reached"),
        flag: z
          .string()
          .optional()
          .describe("Why it is not reached (or does not apply) and what is needed; present whenever reached is false"),
      })
    )
    .length(ASYLUM_INTERVIEW_PREP_COVERAGE_ELEMENTS.length)
    .describe(
      "One row per element, all of them, in the order of the element enum; when the run stopped before drafting, every row is reached false with the reason as its flag"
    ),
  recordGaps: z.object({
    recordGapFlags: z
      .array(z.string())
      .describe("Every question carrying [RECORD GAP - confirm with client before use], quoted, with its part"),
    thinRecordPoints: z
      .array(z.string())
      .describe("Every point where the record is thin enough that the officer will press and the client is not ready"),
  }),
  consistencyLog: z.array(
    z.object({
      discrepancy: z.string(),
      whereItAppears: z
        .array(z.string())
        .describe("Each document and place where a version of it appears; reported, never resolved"),
    })
  ),
  escalationFlags: z
    .array(z.string())
    .describe("Anything touching the security block, criminal history, or the bars, routed to the attorney per the profile"),
  qaGateReport: qaGateReportSchema
    .optional()
    .describe(
      "The asylum-interview-prep-review report on the generated question set; omitted only when no question set was generated (generatedQuestionSetDocumentId is empty), since there is then nothing for the gate to review"
    ),
});
export type AsylumInterviewPrepBuildOutput = z.infer<typeof asylumInterviewPrepBuildOutputSchema>;

export const asylumInterviewPrepBuild = defineSkill({
  name: "asylum-interview-prep-build",
  label: "Build asylum interview prep",
  category: "asylum",
  kind: "build",
  description:
    "Builds the client-adapted USCIS Asylum Office interview question set as a Word document, with the element coverage table, record gaps, consistency log, escalation flags and the asylum-interview-prep-review QA report.",
  outputSchema: asylumInterviewPrepBuildOutputSchema,
  // Item 5 plus what the SKILL.md routes to the attorney elsewhere: a venue
  // it cannot build for ("say so and stop"), the interpreter requirement it
  // says to flag, and the QA gate's escalations, blocking findings and any
  // verdict short of PASS. A generated question set without the interpreter
  // flag or the QA gate's report is flagged too, since neither may be skipped
  // once there is a document.
  extractEscalationFlags: (output) => {
    const { completeQuestionSet: questionSet, qaGateReport: qaGate } = output;
    const generated = questionSet.generatedQuestionSetDocumentId.trim() !== "";
    const flags: string[] = [...output.escalationFlags];
    if (questionSet.venue.affirmativeAsylumOfficeInterview !== true) {
      flags.push(
        `${questionSet.venue.affirmativeAsylumOfficeInterview === false ? "Not" : "Not confirmed as"} a USCIS Asylum Office affirmative interview: ${questionSet.venue.basis}`
      );
    }
    if (!generated) {
      flags.push(`No question set was generated${questionSet.notGeneratedReason ? `: ${questionSet.notGeneratedReason}` : ""}`);
    }
    if (questionSet.interpreterRequirement) {
      flags.push(questionSet.interpreterRequirement.attorneyFlag);
    } else if (generated) {
      flags.push("Interpreter requirement not reported: confirm the current requirement before the interview");
    }
    if (qaGate) {
      flags.push(...qaGate.escalationFlags);
      flags.push(...qaGate.blocking.map((finding) => `QA gate BLOCKING (${finding.location}): ${finding.problem}`));
      if (qaGate.verdict.result !== "PASS") {
        const verdict = qaGate.verdict.result.replace(/_/g, " ");
        flags.push(`QA gate verdict ${verdict}${qaGate.verdict.whatWouldConvert ? `: ${qaGate.verdict.whatWouldConvert}` : ""}`);
      }
    } else if (generated) {
      flags.push("QA gate (asylum-interview-prep-review) was not run: run it on this matter before the question set is used");
    }
    return [...new Set(flags.map((flag) => flag.trim()).filter(Boolean))];
  },
  // load_qa_gate_skill_asylum_interview_prep is the QA gate step (see
  // tools/asylum-interview-prep-build.ts); fetch_uscis_page confirms the
  // current interpreter requirement for the Before the Interview section.
  // read_prior_skill_reports: "Where earlier skills have run, pull their
  // output": claim-evaluation's element scorecard (which elements need the
  // heaviest questioning), declaration-draft's [CLARIFY] flags and
  // evidence-organizer's corroboration map, kept only as those runs'
  // reports; the declaration itself is a matter document.
  tools: [
    "read_prior_skill_reports",
    "fetch_uscis_page",
    "generate_document",
    "render_and_qa_docx",
    "load_qa_gate_skill_asylum_interview_prep",
  ],
  maxTokens: 128_000,
  // The build (verification, draft, render, fix), the QA gate and its fixes,
  // plus the read of the earlier reports.
  maxIterations: 22,
  needsNote: true,
  notePlaceholder:
    "Case note for Build asylum interview prep (optional): the interview date and Asylum Office, the client's interview language and interpreter, the spouse and derivatives on the application, any prior statements (visa interview, CBP, credible fear interview), and facts from client meetings that are not in the uploaded I-589 or declarations.",
  applicableCaseTypes: ["asylum_affirmative"],
});
