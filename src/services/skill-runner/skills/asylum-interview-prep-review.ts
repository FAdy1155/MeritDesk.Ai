import { z } from "zod";
import { defineSkill } from "./types";

// One finding under BLOCKING, SHOULD-FIX or OPTIONAL, in the shape the
// SKILL.md's "Report format" closes with: "the exact location with the
// question quoted, the problem in one sentence, and a concrete fix, subject
// to the fix rule", plus the rules it violates ("One defect, one finding,
// citing both rules it violates").
const findingSchema = z.object({
  location: z.string().describe("The part and sub-grouping of the draft, as titled there"),
  quotedQuestion: z
    .string()
    .optional()
    .describe("The question exactly as drafted; omitted when the finding is something the draft leaves out"),
  problem: z.string().describe("One sentence"),
  fix: z
    .string()
    .describe(
      "The concrete fix. Where a fix would require inventing a fact or research outside the record, one line saying so and naming what the attorney must supply"
    ),
  rulesViolated: z.array(z.string()).describe("The SKILL.md rule ids this finding violates, e.g. A3, C1, D1"),
});

// One row of a section C coverage table: the item, and the part that covers it.
const coverageRowSchema = z.object({
  item: z.string(),
  coveringPart: z
    .string()
    .describe("The part of the draft that covers the item, as titled there, with any limit on that coverage; empty if no part covers it"),
});

// Mirrors skills-content/asylum-interview-prep-review/SKILL.md "Report format",
// items 1-10, then the closing line ("Close with the point in the claim most
// exposed ..."). Two snapshot fields come from the rules the report items
// summarize: twoVersionFormat is the fourth of "Establish four things first"
// (the other three are clientOrTemplate, documentsReviewed / notProvided and
// venue), and recordGapFlags is D19's "Report the count and confirm the
// flags are collected in a list at the end".
export const asylumInterviewPrepReviewOutputSchema = z.object({
  draftSnapshot: z.object({
    clientOrTemplate: z
      .enum(["client", "template"])
      .nullable()
      .describe("client: adapted to a specific client; template: a generic reusable template; null if not told and the draft does not show it"),
    clientName: z.string().optional().describe("For a client-adapted draft, the client's name as the draft gives it"),
    country: z.string(),
    claimType: z.string(),
    venue: z.string(),
    documentsReviewed: z.array(z.string()),
    notProvided: z.array(z.string()),
    twoVersionFormat: z
      .boolean()
      .nullable()
      .describe("Whether the firm uses a counsel version plus a separate client practice guide; null if not told"),
    recordGapFlags: z.object({
      count: z.number().int().min(0),
      collectedInListAtEnd: z.boolean().nullable().describe("null when the draft carries no record-gap flags"),
    }),
  }),
  twoCoverageTables: z.object({
    required: z.array(coverageRowSchema).describe("Section C1, one row per item in its order"),
    recommended: z.array(coverageRowSchema).describe("Section C2, one row per item in its order"),
  }),
  blocking: z.array(findingSchema),
  shouldFix: z.array(findingSchema),
  unverified: z.array(
    z.object({
      check: z.string(),
      whatIsNeeded: z.string(),
    })
  ),
  optional: z.array(findingSchema),
  escalationFlags: z.array(z.string()),
  verdict: z.object({
    result: z.enum(["PASS", "FAIL", "CANNOT_CERTIFY"]),
    whatWouldConvertIt: z.string().optional().describe("CANNOT_CERTIFY only: what would convert the verdict"),
    recommendedGaps: z
      .array(z.string())
      .describe("The recommended (section C2) gaps, stated separately from the verdict as departures from the house standard"),
  }),
  officerQuestionsThisDraftDoesNotPrepareTheClientFor: z.array(z.string()),
  prioritizedEditChecklist: z.array(
    z.object({
      priority: z.enum(["BLOCKING", "SHOULD-FIX", "OPTIONAL"]),
      item: z.string(),
    })
  ),
  mostExposedPointInTheClaim: z
    .string()
    .describe('Only with the client record; otherwise exactly "not assessed, no record provided"'),
});
export type AsylumInterviewPrepReviewOutput = z.infer<typeof asylumInterviewPrepReviewOutputSchema>;

export const asylumInterviewPrepReview = defineSkill({
  name: "asylum-interview-prep-review",
  label: "Run asylum interview prep review",
  category: "asylum",
  kind: "review",
  description:
    "Audits a drafted USCIS Asylum Office interview question set before it reaches the client and returns a severity-tiered defect report with a fix for every item.",
  outputSchema: asylumInterviewPrepReviewOutputSchema,
  // Item 7 is the SKILL.md's escalation list (security block, criminal
  // history, bars). BLOCKING findings ("cannot go to the client as written")
  // and a CANNOT CERTIFY verdict also stop the draft, so they are flagged too.
  extractEscalationFlags: (output) => [
    ...output.escalationFlags,
    ...output.blocking.map((f) => `BLOCKING (${f.location}): ${f.problem}`),
    ...(output.verdict.result === "CANNOT_CERTIFY"
      ? [`CANNOT CERTIFY: ${output.verdict.whatWouldConvertIt ?? "a required check could not be performed"}`]
      : []),
  ],
  // Report-only and record-bound: the SKILL.md forbids research outside the
  // record (the fix rule, D18), so no fetch or web tools, and it delivers no
  // document, so no generator. render_and_qa_docx: this skill generates
  // nothing; it renders a Word draft already on the matter, by the
  // document_id the inventory prints, so the heading-style and numbering
  // rules can be checked on the pages instead of landing under UNVERIFIED
  // from the draft's extracted text. A PDF of the draft
  // already reaches the model as pages. The key reserves matter image slots
  // (run.ts).
  tools: ["render_and_qa_docx"],
  needsNote: true,
  notePlaceholder:
    "Case note for Run asylum interview prep review (optional): which uploaded file is the draft question set; whether it is a generic reusable template or adapted to this client; whether this is an affirmative Asylum Office case; and whether the firm uses the two-version format (a counsel version plus a separate client practice guide).",
  applicableCaseTypes: ["asylum_affirmative"],
});
