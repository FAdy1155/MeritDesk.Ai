import { z } from "zod";
import { defineSkill } from "./types";

// Mirrors skills-content/aos-packet-review/SKILL.md "Report format", items 1-11.
export const aosPacketReviewOutputSchema = z.object({
  packetSnapshot: z.object({
    petitioner: z.string(),
    beneficiary: z.string(),
    marriageDate: z.string(),
    conditionalAtApproval: z.boolean(),
    mannerOfEntry: z.string(),
    filingType: z.enum(["concurrent", "standalone"]),
    documentsReviewed: z.array(z.string()),
    documentsNotProvided: z.array(z.string()),
  }),
  blockingIssues: z.array(z.string()),
  formFindings: z.array(
    z.object({
      form: z.enum(["I-130", "I-130A", "I-485", "I-864", "I-864A"]),
      issue: z.string(),
      location: z.string(),
      recommendedEdit: z.string(),
    })
  ),
  adjustmentEligibilityAndBars: z.array(
    z.object({
      basis: z.string(),
      status: z.enum(["clear", "needs_confirmation", "problem"]),
      notes: z.string(),
    })
  ),
  inadmissibilityScreen: z.array(
    z.object({
      ground: z.string(),
      status: z.enum(["not_triggered", "triggered_waiver_contemplated", "escalate"]),
      notes: z.string(),
    })
  ),
  i864Sufficiency: z.object({
    householdSize: z.number(),
    incomeMeetsThreshold: z.boolean(),
    evidenceComplete: z.boolean(),
    jointSponsorOrHouseholdMemberStatus: z.string(),
  }),
  bonaFideMarriageAssessment: z.object({
    coverageByCategory: z.array(
      z.object({
        category: z.string(),
        rating: z.enum(["strong", "thin", "missing"]),
        notes: z.string(),
      })
    ),
    timelineRead: z.string(),
    strengtheningSteps: z.array(z.string()),
  }),
  consistencyLog: z.array(
    z.object({
      discrepancy: z.string(),
      whereItAppears: z.string(),
    })
  ),
  authoritiesToReview: z.array(
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
export type AosPacketReviewOutput = z.infer<typeof aosPacketReviewOutputSchema>;

export const aosPacketReview = defineSkill({
  name: "aos-packet-review",
  label: "Run AOS packet review",
  category: "uscis",
  kind: "review",
  description:
    "Reviews a marriage-based adjustment of status packet (I-130, I-130A, I-485, I-864, I-693, I-765, I-131) before filing.",
  outputSchema: aosPacketReviewOutputSchema,
  // Item 10 is the SKILL.md's escalation list. Item 2's blocking issues go to
  // the attorney too, prefixed as i90-packet-review prefixes its own.
  extractEscalationFlags: (output) => [
    ...new Set([...output.escalationFlags, ...output.blockingIssues.map((issue) => `BLOCKING: ${issue}`)]),
  ],
  tools: ["search_library", "lookup_library_citation", "read_library_document"],
  // The library tools (lookups and reads of cited authority) need a few requests beyond the default 12.
  maxIterations: 16,
  // "Before anything" confirms the basics a packet often does not show: the
  // immigration history behind the manner of entry and the bars, any criminal
  // history (escalated, never resolved), and whether the marriage will be
  // under two years old at approval (conditional residence).
  needsNote: true,
  notePlaceholder:
    "Case note for Run AOS packet review (optional): the beneficiary's prior immigration history (entries, statuses, overstays, prior petitions or removals) and any arrest, charge or conviction, if not in the packet, and whether the marriage will be under two years old when the I-485 is approved.",
  applicableCaseTypes: ["i130"],
});
