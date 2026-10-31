import { z } from "zod";
import { defineSkill } from "./types";

// Mirrors skills-content/vawa-packet-review/SKILL.md "SECTION 4. OUTPUT FORMAT",
// items 1-12, and the Section 3 workflow steps each item summarizes.
export const vawaPacketReviewOutputSchema = z.object({
  verdictAndDefectCounts: z.object({
    verdict: z.enum(["FILE", "FILE_AFTER_FIXES", "DO_NOT_FILE"]),
    blockerCount: z.number(),
    materialCount: z.number(),
    polishCount: z.number(),
  }),
  safetyConflictAndConfidentialityFlags: z.array(
    z.object({
      type: z.enum(["SAFETY", "CONFLICT", "1367"]),
      detail: z.string(),
    })
  ),
  inventoryAndPosture: z.object({
    abuserStatus: z.enum(["USC", "LPR", "US_national"]),
    marriageStatus: z.string(),
    clientLocation: z.enum(["united_states", "abroad"]),
    removalPosture: z.string().optional(),
    derivatives: z.array(z.object({ name: z.string(), ageAtFiling: z.string() })),
    i485AndI765Included: z.boolean(),
    intendedFilingSequence: z.string(),
    documentsReferencedButMissing: z.array(z.string()),
  }),
  elementByElementAudit: z.array(
    z.object({
      element: z.string(),
      authority: z.string(),
      rating: z.enum(["ESTABLISHED", "THIN", "NOT_ESTABLISHED"]),
      whereSupported: z.string(),
      whatIsMissingOrWeak: z.string(),
      defects: z.array(
        z.object({
          severity: z.enum(["BLOCKER", "MATERIAL", "POLISH"]),
          detail: z.string(),
          fix: z.string(),
        })
      ),
    })
  ),
  declarationStrengthScore: z.object({
    dimensionScores: z.array(
      z.object({
        dimension: z.string(),
        score: z.number().min(1).max(5),
        justification: z.string(),
      })
    ),
    overallVerdict: z.enum(["FILE_AS_IS", "REVISE_BEFORE_FILING", "REWRITE"]),
    redFlags: z.array(z.string()),
  }),
  crossDocumentReconciliation: z.array(
    z.object({
      fact: z.string(),
      i360: z.string(),
      i485: z.string(),
      i765: z.string(),
      declaration: z.string(),
      exhibits: z.string(),
      match: z.boolean(),
    })
  ),
  evidenceSufficiencyAudit: z.object({
    exhibitToElementMap: z.array(z.object({ exhibit: z.string(), supportsElements: z.array(z.string()) })),
    elementsSupportedByDeclarationOnly: z.array(z.string()),
    unsupportedExhibits: z.array(z.string()),
    contradictoryExhibits: z.array(z.string()),
    translationIssues: z.array(z.string()),
    legibilityIssues: z.array(z.string()),
    thirdPartyDeclarationIssues: z.array(z.string()),
    psychEvalIssues: z.string().optional(),
  }),
  formMechanicsAudit: z.array(
    z.object({
      form: z.enum(["I-360", "I-485", "I-765"]),
      issue: z.string(),
      severity: z.enum(["BLOCKER", "MATERIAL", "POLISH"]),
    })
  ),
  inadmissibilityAndGmcAudit: z.array(
    z.object({
      ground: z.string(),
      status: z.string(),
    })
  ),
  anticipatedRfeAndInterviewExposure: z.array(
    z.object({
      question: z.string(),
      whatAnswersIt: z.string(),
      whatDoesNot: z.string(),
    })
  ),
  prioritizedEditChecklist: z.array(
    z.object({
      priority: z.enum(["BLOCKER", "MATERIAL", "POLISH"]),
      fix: z.string(),
      location: z.string(),
      responsibleParty: z.string(),
    })
  ),
  authoritiesRelied: z.array(
    z.object({
      citation: z.string(),
      verified: z.boolean(),
    })
  ),
  escalationFlags: z.array(z.string()),
});
export type VawaPacketReviewOutput = z.infer<typeof vawaPacketReviewOutputSchema>;

export const vawaPacketReview = defineSkill({
  name: "vawa-packet-review",
  label: "Run VAWA packet review",
  category: "uscis",
  kind: "review",
  description: "Reviews a VAWA self-petition packet (I-360, I-485, I-765) before filing.",
  outputSchema: vawaPacketReviewOutputSchema,
  // As vawa-packet-build extracts the same report from its QA gate: item 2's
  // SAFETY, CONFLICT and 1367 flags first (Section 3 Step 1: "Put this
  // first"), a DO NOT FILE verdict, then item 12's escalation list.
  extractEscalationFlags: (output) => {
    const flags = output.safetyConflictAndConfidentialityFlags.map((f) => `${f.type} FLAG: ${f.detail}`);
    const verdict = output.verdictAndDefectCounts;
    if (verdict.verdict === "DO_NOT_FILE") flags.push(`Verdict DO NOT FILE (${verdict.blockerCount} blocker(s))`);
    flags.push(...output.escalationFlags);
    return [...new Set(flags.map((flag) => flag.trim()).filter(Boolean))];
  },
  // fetch_uscis_page covers the Visa Bulletin check for the LPR-abuser posture.
  tools: ["fetch_uscis_page", "search_library", "lookup_library_citation", "read_library_document"],
  // The library tools (lookups and reads of cited authority) need a few requests beyond the default 12.
  maxIterations: 16,
  // The verdict and the safety screen turn on what the packet may not show:
  // when the attorney means to file (derivatives' ages, the Visa Bulletin
  // posture) and whether the client is in danger now.
  needsNote: true,
  notePlaceholder:
    "Case note for Run VAWA packet review (optional): the intended filing date, any current safety concern (where the client lives now, whether the abuser may learn of the filing, a safe mailing address), and facts from client meetings that are not in the uploaded packet.",
  applicableCaseTypes: ["vawa"],
});
