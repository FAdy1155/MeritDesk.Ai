import { z } from "zod";
import { defineSkill } from "./types";

// Mirrors skills-content/claim-evaluation/SKILL.md "Output format", items 1-5.
export const claimEvaluationOutputSchema = z.object({
  caseSnapshot: z.object({
    respondent: z.string(),
    country: z.string(),
    reliefEvaluated: z.array(z.enum(["asylum", "withholding", "cat"])),
    postureApplied: z.enum(["aggressive", "standard", "conservative"]),
    keyDates: z.object({
      entryDate: z.string().optional(),
      ntaDate: z.string().optional(),
      oneYearClockDate: z.string().optional(),
      nextHearingDate: z.string().optional(),
    }),
  }),
  elementScorecard: z.array(
    z.object({
      element: z.string(),
      rating: z.enum(["GREEN", "YELLOW", "RED"]),
      basis: z.string(),
      whatWouldStrengthen: z.string(),
      authorityAnchor: z.string(),
    })
  ),
  barsAndEscalationFlags: z.array(
    z.object({
      flag: z.string(),
      detail: z.string(),
    })
  ),
  readsOfTheRecord: z.array(z.string()),
  optionsForAttorney: z.array(
    z.object({
      relief: z.string(),
      framing: z.string(),
    })
  ),
});
export type ClaimEvaluationOutput = z.infer<typeof claimEvaluationOutputSchema>;

export const claimEvaluation = defineSkill({
  name: "claim-evaluation",
  label: "Run claim evaluation",
  category: "asylum",
  kind: "review",
  description: "Scores an asylum, withholding or CAT claim element by element as GREEN, YELLOW or RED.",
  outputSchema: claimEvaluationOutputSchema,
  extractEscalationFlags: (output) => output.barsAndEscalationFlags.map((f) => f.flag),
  tools: ["search_library", "lookup_library_citation", "read_library_document", "search_eoir_judges", "eoir_judge_profile", "query_eoir_stats"],
  // The library tools (lookups and reads of cited authority) and the EOIR
  // statistics tools need a few requests beyond the default 12.
  maxIterations: 18,
  // "Before anything": "Confirm which relief is being evaluated." The claim
  // is often first read from an intake that is not uploaded.
  needsNote: true,
  notePlaceholder:
    "Case note for Run claim evaluation (optional): which relief to evaluate (asylum, withholding, CAT, or all three), key dates not on the matter (entry, NTA), and the intake notes or interview facts, pasted here if they are not uploaded.",
  applicableCaseTypes: ["asylum_affirmative", "asylum_defensive", "withholding_cat"],
});
