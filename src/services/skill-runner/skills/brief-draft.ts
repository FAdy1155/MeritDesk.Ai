import { z } from "zod";
import { defineSkill } from "./types";

// Mirrors skills-content/brief-draft/SKILL.md "Output format": the brief in
// house style, plus a closing **attorney checklist** with its five named
// parts, in the SKILL.md's order. The brief itself is the Word document
// generate_document builds; the report carries its id and what the attorney
// needs to review it (each sub-field names the SKILL.md heading it comes
// from, or the runner instruction it serves), never the brief's text. The SKILL.md bundles no references,
// scripts or assets.

export const briefDraftOutputSchema = z.object({
  brief: z.object({
    generatedBriefDocumentId: z
      .string()
      .describe("document_id returned by generate_document for the final draft; empty if none could be generated"),
    notGeneratedReason: z
      .string()
      .optional()
      .describe("Why no Word document could be generated; only when generatedBriefDocumentId is empty"),
    // Description and "Structure": a merits brief, or a NOID rebuttal
    // reorganized around the Asylum Officer's concerns.
    briefType: z.enum(["merits_brief", "NOID_rebuttal"]),
    // "Before anything": venue and controlling circuit confirmed first.
    venue: z.string().describe("The Immigration Court or Asylum Office the brief is for, as the matter or record shows it"),
    controllingCircuit: z
      .string()
      .describe("The circuit whose precedent controls, and where that came from (matter, record or practice profile); \"not confirmed\" if none of them establishes it"),
    recordRelied: z
      .array(z.string())
      .describe(
        "The declaration, record exhibits, exhibit index and element analysis the draft argues from, by file name, and the attorney's note if used"
      ),
    // "Relief argued": all three, separately, in this order unless instructed otherwise.
    reliefArgued: z
      .array(z.enum(["Asylum", "Withholding_of_Removal", "CAT"]))
      .describe("Each form of relief the brief argues in its own section, in the brief's order"),
    // "Structure": the brief's headings as drafted.
    sectionsInOrder: z.array(z.string()).describe("The brief's headings in order, as they appear in the draft"),
    noidConcernsAnswered: z
      .array(z.string())
      .optional()
      .describe("NOID rebuttal only: each concern the Asylum Officer raised, in the NOID's order, as the brief answers it"),
    // "Argument section A: Asylum": the ground(s) analyzed, and the PSG wording.
    protectedGrounds: z
      .array(z.enum(["race", "religion", "nationality", "political_opinion", "particular_social_group"]))
      .describe("The protected grounds the brief argues; empty when only CAT is argued"),
    particularSocialGroupWording: z
      .string()
      .optional()
      .describe("The exact PSG wording the brief uses, character for character; only when a particular social group is argued"),
    // "Bars & discretion" and "Guardrails": a criminal bar is never argued
    // either way; it is escalated to the attorney / crim-imm counsel.
    barsEscalated: z
      .array(z.string())
      .describe(
        "Each bar issue the record raises that the brief does not resolve, escalated to the attorney or crim-imm counsel per the profile; empty if none"
      ),
    // "Analysis discipline": a missing factual predicate is flagged, not assumed.
    missingFactualPredicates: z
      .array(z.string())
      .describe("Each argument whose factual predicate is missing from the record, as flagged in the draft; empty if none"),
    // "Consistency check (before finishing)".
    unresolvedConsistencyIssues: z
      .array(z.string())
      .describe(
        "What the consistency check found that the draft could not resolve from the record (contradictions between record documents, chronology problems); PSG wording discrepancies go in the attorney checklist; empty if none"
      ),
    // The report's open-items field: the [CITE] list above is only for
    // authority, so the draft's other placeholders and this run's limits
    // (documents not reviewed, profile or firm identity not set up) go here.
    otherPlaceholdersAndOpenItems: z
      .array(z.string())
      .describe(
        "Every bracketed placeholder in the draft other than [CITE: ...] ones (caption, firm or signer details, [CONFIRM: ...] items), as written there, and every limit on this run (documents not reviewed, no confirmed practice profile, firm identity setup incomplete); empty if none"
      ),
  }),
  attorneyChecklist: z.object({
    citePlaceholdersToFill: z
      .array(z.string())
      .describe("Every [CITE: ...] placeholder exactly as it appears in the brief, with the section it is in"),
    citationsToShepardizeOrVerify: z
      .array(
        z.object({
          citation: z.string(),
          verified: z
            .boolean()
            .describe(
              "True only when this run confirmed the authority against its own text (a copy among the matter's documents); false for anything cited from knowledge"
            ),
        })
      )
      .describe("Every citation in the brief (statutes, regulations, cases), each to be Shepardized or verified by the attorney"),
    factualAssertionsNeedingRecordCiteConfirmed: z
      .array(z.string())
      .describe("Each factual assertion as the brief states it, with the record cite (tab or file name) the draft gives it, or \"no record cite\""),
    psgWordingDiscrepanciesAcrossDocuments: z
      .array(z.string())
      .describe("Each place the I-589, declaration or other record documents word the PSG differently from the brief, quoting each wording; empty if none"),
    circuitSpecificIssuesToDoubleCheck: z.array(z.string()),
  }),
});
export type BriefDraftOutput = z.infer<typeof briefDraftOutputSchema>;

export const briefDraft = defineSkill({
  name: "brief-draft",
  label: "Draft brief or NOID rebuttal",
  category: "asylum",
  kind: "build",
  description:
    "Drafts the legal brief for an asylum, withholding and CAT case at an EOIR merits hearing, or a rebuttal to an Asylum Office NOID, as a Word document for attorney review and cite-checking, with a closing attorney checklist.",
  outputSchema: briefDraftOutputSchema,
  // Everything the SKILL.md hands to the attorney: a missing document, every
  // bar it refuses to resolve, every missing predicate and unresolved
  // inconsistency, every other placeholder or limit on the run, and each
  // checklist item that must be cleared before filing. Citations and record cites are counted rather than listed (the
  // report lists each one), because the SKILL.md flags every citation for
  // verification, verified or not.
  extractEscalationFlags: (output) => {
    const { brief, attorneyChecklist } = output;
    const citations = attorneyChecklist.citationsToShepardizeOrVerify;
    const unverified = citations.filter((c) => !c.verified).length;
    const assertions = attorneyChecklist.factualAssertionsNeedingRecordCiteConfirmed.length;
    return [
      ...(brief.generatedBriefDocumentId.trim()
        ? []
        : [`No brief document was generated in this run${brief.notGeneratedReason ? `: ${brief.notGeneratedReason}` : "."}`]),
      ...brief.barsEscalated.map((b) => `Bar issue escalated to the attorney: ${b}`),
      ...brief.missingFactualPredicates.map((m) => `Missing factual predicate: ${m}`),
      ...brief.unresolvedConsistencyIssues.map((c) => `Unresolved consistency issue: ${c}`),
      ...brief.otherPlaceholdersAndOpenItems.map((o) => `Open item: ${o}`),
      ...attorneyChecklist.psgWordingDiscrepanciesAcrossDocuments.map((d) => `PSG wording discrepancy: ${d}`),
      ...attorneyChecklist.citePlaceholdersToFill.map((p) => `CITE placeholder to fill: ${p}`),
      ...attorneyChecklist.circuitSpecificIssuesToDoubleCheck.map((c) => `Circuit-specific issue to double-check: ${c}`),
      ...(citations.length > 0
        ? [`${citations.length} citation(s) to Shepardize or verify before filing (${unverified} not verified in this run)`]
        : []),
      ...(assertions > 0 ? [`${assertions} factual assertion(s) need their record cite confirmed`] : []),
    ];
  },
  // read_prior_skill_reports: "Pull the element analysis from claim-evaluation
  // if it exists, and the exhibit index from evidence-organizer if it exists,
  // so the argument cites the record accurately"; legal-argument-research
  // hands its research to this skill. Those exist only as the earlier runs'
  // reports on the matter.
  tools: ["read_prior_skill_reports", "generate_document", "render_and_qa_docx", "search_library", "lookup_library_citation", "read_library_document"],
  maxTokens: 128_000,
  // The drafting budget (draft, render, fix, render, submit) plus the read
  // of the earlier reports.
  maxIterations: 18,
  needsNote: true,
  notePlaceholder:
    "Case note for Draft brief or NOID rebuttal (optional): merits brief or NOID rebuttal; the hearing date and case number if not on the matter; which relief to argue if not all three; your resolved position on any criminal or other bar; and the PSG wording to use.",
  applicableCaseTypes: ["asylum_affirmative", "asylum_defensive", "withholding_cat"],
});
