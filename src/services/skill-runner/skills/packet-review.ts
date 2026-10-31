import { z } from "zod";
import { defineSkill } from "./types";

// Mirrors skills-content/packet-review/SKILL.md "Report format", items 1-9.
export const packetReviewOutputSchema = z.object({
  packetSnapshot: z.object({
    respondent: z.string(),
    country: z.string(),
    relief: z.array(z.string()),
    venueOrCircuit: z.string(),
    documentsReviewed: z.array(z.string()),
    documentsNotProvided: z.array(z.string()),
  }),
  blockingIssues: z.array(z.string()),
  i589Findings: z.array(
    z.object({
      part: z.string(),
      issue: z.string(),
      location: z.string(),
      recommendedEdit: z.string(),
    })
  ),
  declarationFindings: z.object({
    elementCoverage: z.array(
      z.object({
        element: z.string(),
        coverage: z.enum(["covered", "thin", "missing"]),
      })
    ),
    nexusRead: z.string(),
    credibilityRisks: z.array(z.string()),
    strengtheningSuggestions: z.array(z.string()),
  }),
  nexusAndLegalAlignment: z.array(
    z.object({
      element: z.string(),
      alignment: z.enum(["aligned", "thin"]),
      notes: z.string(),
    })
  ),
  consistencyLog: z.array(
    z.object({
      discrepancy: z.string(),
      whereItAppears: z.string(),
    })
  ),
  caseLawToReview: z.array(
    z.object({
      citation: z.string(),
      why: z.string(),
      verified: z.boolean(),
    })
  ),
  escalationFlags: z.array(z.string()),
  prioritizedEditChecklist: z.array(
    z.object({
      priority: z.enum(["blocking", "strongly_recommended", "optional"]),
      item: z.string(),
    })
  ),
});
export type PacketReviewOutput = z.infer<typeof packetReviewOutputSchema>;

export const packetReview = defineSkill({
  name: "packet-review",
  label: "Run packet review",
  category: "asylum",
  kind: "review",
  description: "Reviews an assembled asylum packet (I-589, declaration, exhibits) before filing.",
  outputSchema: packetReviewOutputSchema,
  // Item 8 is the SKILL.md's escalation list. Item 2's blocking issues ("must
  // fix before filing") go to the attorney too, prefixed as i90-packet-review
  // and aos-packet-review prefix theirs.
  extractEscalationFlags: (output) => [
    ...new Set([...output.escalationFlags, ...output.blockingIssues.map((issue) => `BLOCKING: ${issue}`)]),
  ],
  // "Before anything": "Where earlier skills have run, pull their output:
  // claim-evaluation for the element scorecard, evidence-organizer for the
  // exhibit index, declaration-draft for the declaration and its [CLARIFY]
  // flags." read_prior_skill_reports returns those runs' reports on this
  // matter; the declaration itself is a matter document.
  tools: ["read_prior_skill_reports", "search_library", "lookup_library_citation", "read_library_document"],
  // The library tools (lookups and reads of cited authority) need a few requests beyond the default 12.
  maxIterations: 16,
  // "Before anything" also confirms the venue and the controlling circuit,
  // which the matter may not record.
  needsNote: true,
  notePlaceholder:
    "Case note for Run packet review (optional): the venue (Asylum Office or Immigration Court, and which one) and the controlling circuit if not on the matter, whether to weigh the earlier claim-evaluation, evidence-organizer and declaration-draft reports on this matter, and facts not in the uploaded packet.",
  applicableCaseTypes: ["asylum_affirmative", "asylum_defensive", "withholding_cat"],
});
