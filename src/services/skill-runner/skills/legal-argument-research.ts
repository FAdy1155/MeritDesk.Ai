import { z } from "zod";
import { defineSkill } from "./types";
import { LEGAL_AUTHORITY_FETCH_DOMAINS } from "../fetch-domains";

// The report is the whole deliverable: the SKILL.md is research and
// assessment ("not the drafted motion"; it hands off to brief-draft for
// that), so there is no generated document and no generator tool. Authority
// comes from the server-side web tools, whose every result the runner writes
// to the run's verification log (docs/ADDING_A_SKILL.md 2.4), so a citation
// the report gives without having retrieved it shows as such on the matter
// page. The one client tool, load_motion_references (tools/
// legal-argument-research.ts), returns the four reference files of
// eoir-motion-self-review and eoir-filing-compliance that
// references/eoir-motions.md sends the model to for motion elements and
// deadlines; a run's prompt carries only this skill's own references.

// Every authority the report cites, wherever it cites it (rule 2.1.6): the
// citation-integrity rule and the guardrails flag every citation for
// verification. A "[CITE: ...]" placeholder is a legitimate entry, never
// verified. references/eoir-motions.md says each of its entries must be
// verified against its link before it is relied on, and the files
// load_motion_references returns name their authorities as anchors to
// cite-check, so a citation known only from those files is not verified
// either. No min(1) on any citation list.
const citationSchema = z.object({
  citation: z
    .string()
    .describe("As the authority itself gives it, or a [CITE: ...] placeholder in the SKILL.md's form; never invented"),
  verified: z
    .boolean()
    .describe(
      "true only when this run read the authority's own text (retrieved, or a copy among the matter's documents) and confirmed the citation and what it is cited for; false for anything from memory, from references/eoir-motions.md or the files load_motion_references returns alone, or a placeholder"
    ),
  url: z.string().optional().describe("The page it was confirmed on, exactly as retrieved; omit if not retrieved in this run"),
});
export type LegalArgumentResearchCitation = z.infer<typeof citationSchema>;

// One row of item 3's per-source table ("citation (flagged for verification)
// | why it supports | how directly it fits the facts"), in column order, with
// the citation's verified / url and url's companion retrievedAt (the
// research-skill addition, rule 2.1.3) next to the citation they qualify.
const supportingAuthoritySchema = citationSchema.extend({
  retrievedAt: z
    .string()
    .optional()
    .describe("ISO time this run fetched the url, from the web_fetch result; omit if not fetched in this run"),
  whyItSupports: z
    .string()
    .describe("Its holding, paraphrased (brief attributed quotation only), and why it helps the argument"),
  howDirectlyItFitsTheFacts: z.string(),
});

// The dates the currency rule asks for are exact days; empty means the area
// could not be confirmed in this run, which the escalation flags pick up.
const ISO_DAY_OR_EMPTY = /^(\d{4}-\d{2}-\d{2})?$/;

/**
 * The currency rule says to verify volatile law "with web tools", so a date
 * with no page retrieved behind it (from memory or from the reference file)
 * is not a confirmation. The view applies the same test.
 */
function volatileAreaConfirmed(area: { confirmedThrough: string; urls: string[] }): boolean {
  return area.confirmedThrough !== "" && area.urls.length > 0;
}

// Mirrors skills-content/legal-argument-research/SKILL.md "Report format", items 1-7.
export const legalArgumentResearchOutputSchema = z.object({
  snapshot: z.object({
    // Workflow step 1, "Frame the issue": the legal question is stated first.
    legalQuestion: z.string(),
    // "Before anything": a motion (which type?) or a substantive argument / claim.
    argumentOrMotionType: z.object({
      kind: z.enum(["motion", "substantive_argument"]),
      type: z
        .string()
        .describe("For a motion, which motion (e.g. to terminate, sever, reopen); for an argument, the claim or theory"),
    }),
    // "Before anything": before the IJ, the BIA, detained/non-detained, stage of proceedings.
    posture: z.object({
      forum: z.string().describe("Before the Immigration Judge, the BIA, or another forum"),
      detained: z.boolean().nullable().describe("null when the matter, the documents and the note do not say"),
      stageOfProceedings: z.string(),
    }),
    // "Court/circuit"; the controlling circuit decides which authority binds,
    // so where it came from is part of the snapshot.
    courtOrCircuit: z.object({
      court: z.string(),
      controllingCircuit: z.string(),
      controllingCircuitSource: z
        .enum(["matter", "attorney_note", "practice_profile", "matter_documents", "not_confirmed"])
        .describe("Where the controlling circuit came from; not_confirmed when none of them establishes it"),
    }),
    standardOfReview: z.string(),
  }),
  governingStandard: z.object({
    whatMustBeShown: z
      .array(z.string())
      .describe("Each element or showing the motion or argument must make, in the order the standard states them"),
    // "Before anything": for a motion, the deadlines and limits that go with its standard.
    deadlinesAndLimits: z
      .array(z.string())
      .optional()
      .describe("Motions only: the time and number limits and filing prerequisites that apply, as the authority states them"),
    anchorAuthority: z.array(citationSchema),
  }),
  supportingAuthority: z
    .array(supportingAuthoritySchema)
    .describe("BIA and AG precedent, controlling circuit precedent, and statute or regulation; empty when none was found"),
  strengthAssessment: z.object({
    rating: z.string().describe("A clear rating in a few words, on the practice profile's scale if it defines one"),
    reasoning: z
      .string()
      .describe("How well the facts fit the standard, the standard of review, and the practice profile's risk posture"),
    keyWeaknesses: z.array(z.string()),
    // Workflow step 4: "the counterargument the government (DHS/ICE) will make and how it likely lands".
    governmentsLikelyCounter: z.array(
      z.object({
        counterargument: z.string(),
        howItLikelyLands: z.string(),
        authority: z
          .array(citationSchema)
          .describe("Authority DHS is likely to rely on for it; empty when none is identified"),
      })
    ),
    howTheCircuitCuts: z.string(),
  }),
  // Workflow step 5 names the four kinds of better approach, and says to say
  // so, and why, when the current approach is the right one.
  betterApproach: z.object({
    currentApproachIsSound: z.boolean(),
    currentApproachIsSoundBecause: z
      .string()
      .optional()
      .describe("Only when currentApproachIsSound is true: why the current approach is the right one"),
    alternatives: z
      .array(
        z.object({
          kind: z.enum([
            "alternative_motion_or_procedural_vehicle",
            "alternative_legal_theory_or_framing",
            "better_sequencing",
            "stronger_evidentiary_predicate",
          ]),
          recommendation: z.string(),
          whyStronger: z.string(),
          authority: z.array(citationSchema),
        })
      )
      .describe("Empty when the current approach is the right one and nothing would strengthen it"),
  }),
  verificationAndCurrencyNote: z.object({
    everythingToShepardize: z
      .array(citationSchema)
      .describe("Every authority the report cites, once each, including [CITE: ...] placeholders"),
    // The currency rule: the date through which each volatile area was confirmed.
    volatileAreasConfirmed: z
      .array(
        z.object({
          area: z.string(),
          currentStateOfTheLaw: z.string(),
          confirmedThrough: z
            .string()
            .regex(ISO_DAY_OR_EMPTY)
            .describe("YYYY-MM-DD through which this run confirmed it from retrieved sources; empty if it could not be confirmed"),
          urls: z
            .array(z.string())
            .describe(
              "The pages retrieved in this run that confirm it, exactly as retrieved; with none, the area counts as not confirmed whatever the date"
            ),
        })
      )
      .describe("Each volatile area the issue touches (the reference file names them); empty if none"),
    circuitSpecificIssuesToDoubleCheck: z.array(z.string()),
  }),
  escalationFlags: z
    .array(z.string())
    .describe("Criminal-bar questions and strategy calls for the attorney, per the practice profile's escalation rules"),
});
export type LegalArgumentResearchOutput = z.infer<typeof legalArgumentResearchOutputSchema>;

const CITE_PLACEHOLDER = /^\s*\[CITE:/i;

/** Every citation object in the report, in report order. */
function allCitations(output: LegalArgumentResearchOutput): LegalArgumentResearchCitation[] {
  return [
    ...output.governingStandard.anchorAuthority,
    ...output.supportingAuthority,
    ...output.strengthAssessment.governmentsLikelyCounter.flatMap((c) => c.authority),
    ...output.betterApproach.alternatives.flatMap((a) => a.authority),
    ...output.verificationAndCurrencyNote.everythingToShepardize,
  ];
}

export const legalArgumentResearch = defineSkill({
  name: "legal-argument-research",
  label: "Run legal argument research",
  category: "eoir",
  kind: "research",
  description:
    "Finds supporting authority for a legal argument or contemplated EOIR motion, assesses its strength against the government's likely counter, and recommends a stronger approach if one exists, with every citation flagged for verification.",
  outputSchema: legalArgumentResearchOutputSchema,
  // Item 7 (criminal bars and strategy calls), then what the SKILL.md's two
  // rules leave open: a controlling circuit not confirmed, a volatile area not
  // confirmed against current sources, the circuit-specific double-checks,
  // each placeholder, and each authority not verified in this run. A
  // citation counts as unverified if any of its entries says so. Verified
  // authority is counted rather than listed: retrieval confirms the text,
  // not that it is still good law, so it is Shepardized too.
  extractEscalationFlags: (output) => {
    const { snapshot, supportingAuthority, verificationAndCurrencyNote: note } = output;
    const citations = allCitations(output);
    const unverified = new Set(
      citations.filter((c) => !c.verified && !CITE_PLACEHOLDER.test(c.citation)).map((c) => c.citation.trim())
    );
    const placeholders = new Set(citations.filter((c) => CITE_PLACEHOLDER.test(c.citation)).map((c) => c.citation.trim()));
    const verified = new Set(
      citations
        .filter((c) => c.verified && !CITE_PLACEHOLDER.test(c.citation) && !unverified.has(c.citation.trim()))
        .map((c) => c.citation.trim())
    );
    return [
      ...new Set([
        ...output.escalationFlags,
        ...(snapshot.courtOrCircuit.controllingCircuitSource === "not_confirmed"
          ? ["Controlling circuit not confirmed; which authority binds depends on it"]
          : []),
        ...(supportingAuthority.length === 0 ? ["No supporting authority was found for the argument"] : []),
        ...note.volatileAreasConfirmed
          .filter((v) => !volatileAreaConfirmed(v))
          .map((v) =>
            v.confirmedThrough
              ? `Volatile area dated ${v.confirmedThrough} with no source retrieved in this run; confirm it before relying on it: ${v.area}`
              : `Volatile area not confirmed against current sources in this run: ${v.area}`
          ),
        ...note.circuitSpecificIssuesToDoubleCheck.map((issue) => `Circuit-specific issue to double-check: ${issue}`),
        ...[...placeholders].map((p) => `CITE placeholder to fill: ${p}`),
        ...[...unverified].map((c) => `Authority not verified in this run; confirm and Shepardize before relying on it: ${c}`),
        ...(verified.size > 0
          ? [
              `Shepardize the ${verified.size} ${verified.size === 1 ? "authority" : "authorities"} verified in this run before relying on ${verified.size === 1 ? "it" : "them"}`,
            ]
          : []),
      ]),
    ];
  },
  // references/eoir-motions.md: "use the element structure in the
  // motion-elements.md file of the eoir-motion-self-review Skill in this
  // plugin as a cross check", and the deadlines are in icpm-mechanics.md
  // (eoir-motion-self-review) and icpm-checklist.md / bia-checklist.md
  // (eoir-filing-compliance). The model sees it as load_motion_references.
  tools: ["load_motion_references_legal_argument_research", "search_library", "lookup_library_citation", "read_library_document", "search_eoir_judges", "eoir_judge_profile", "query_eoir_stats"],
  // Search stays open (2.4): the SKILL.md names no source restriction (a
  // research integration if one exists, otherwise the web). web_fetch opens
  // the legal-authority hosts in fetch-domains.ts only, since the run reads
  // the client's documents. The bundled reference's precedent links are
  // justice.gov PDFs, which web_fetch reads natively once a search has
  // surfaced them; fetch_uscis_page returns page text only, so it is not added.
  serverTools: ["web_search", { name: "web_fetch", allowedDomains: LEGAL_AUTHORITY_FETCH_DOMAINS }],
  maxIterations: 30,
  needsNote: true,
  notePlaceholder:
    "Case note for Run legal argument research (optional): the argument, claim or contemplated motion to research and the facts it turns on; the posture (before the IJ or the BIA, detained or not, stage of proceedings, next hearing or filing deadline); and the controlling circuit if it is not on the matter.",
  // Any matter that can be in removal proceedings, as for the other EOIR
  // skills (eoir-motion-self-review): its EOIR motions specialty applies to
  // VAWA and I-130 matters before the court as much as to protection cases.
  // Affirmative asylum and I-90 matters are not before EOIR.
  applicableCaseTypes: ["asylum_defensive", "withholding_cat", "cancellation", "vawa", "i130"],
});
