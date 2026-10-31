import { z } from "zod";
import { defineSkill } from "./types";
import { RESEARCH_FETCH_DOMAINS } from "../fetch-domains";

// packet-build is the orchestrator skill: its build order runs the other
// asylum skills in sequence (claim-evaluation, declaration-draft,
// country-conditions-research, the I-589 per references/i589-guide.md,
// evidence-organizer, brief-draft if requested, then packet-review as the QA
// gate) and stitches their output into one packet. In this app the companion
// skills' instructions come from the load_companion_skill tool (tools/
// packet-build.ts), the drafted documents from generate_document, the filled
// I-589 from list_pdf_form_fields + fill_pdf_form (the guide's "fill it with
// the pdf skill"), the country-conditions sources from the server-side web
// tools, and the current I-589 edition and filing rules from
// fetch_uscis_page. The report carries the documents' ids and the structured
// items around them, never the documents' text.

// The Part labels references/i589-guide.md "Output of this step" item 1 uses.
export const I589_ANSWER_TABLE_PARTS = ["A.I", "A.II", "A.III", "B", "C", "D", "E"] as const;

// The relief forms SKILL.md step 1 names, exact labels (spaces -> underscores).
const RELIEF = z.enum(["asylum", "withholding_of_removal", "protection_under_the_Convention_Against_Torture"]);

// The I-589 Part B basis boxes references/i589-guide.md lists, less the
// Convention Against Torture (a form of relief above, not a protected ground).
const PROTECTED_GROUND = z.enum([
  "race",
  "religion",
  "nationality",
  "political_opinion",
  "membership_in_a_particular_social_group",
]);

// The venues SKILL.md "Before anything" item 1 distinguishes.
const VENUE = z.enum(["USCIS_Asylum_Office_affirmative", "EOIR_defensive"]);

// Blocking -> Strongly recommended -> Optional: the tiers of the
// packet-review report (SKILL.md item 8) and of the master action checklist
// (item 9), which is ordered "blocking first" on the same tiers.
const PRIORITY = z.enum(["blocking", "strongly_recommended", "optional"]);

// The six-year cutoff (step 3) is an exact day, and a publication date is
// as precise as the source states it; ISO form lets the cutoff be checked.
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TO_DAY_MONTH_OR_YEAR = /^\d{4}(-\d{2}(-\d{2})?)?$/;

// Every authority in the report (rule 2.1.6). The integrity rule allows
// only well-established anchors and [CITE] placeholders, all flagged for
// attorney verification; verified is true only for one confirmed in this run.
const authoritySchema = z.object({
  citation: z
    .string()
    .describe("The authority as cited, or the [CITE: ...] placeholder the attorney must fill; never an invented case or holding"),
  verified: z
    .boolean()
    .describe("true only when this run confirmed it on a page it fetched (give that url) or quoted it from a bundled reference"),
  url: z.string().optional().describe("The page it was confirmed on, exactly as fetched; omitted when not fetched"),
});

const documentIdDescription = (what: string, tool: string) =>
  `document_id ${tool} returned for the final ${what}; empty if none could be generated`;

// The packet-review report (item 8). SKILL.md step 7 runs packet-review over
// the assembled packet and says to "hand the attorney that report together
// with the packet", so this mirrors skills-content/packet-review/SKILL.md
// "Report format", items 1-9: the same contract as packetReviewOutputSchema
// in ./packet-review.ts, restated here because a skill module imports only
// zod and ./types. caseLawToReview adds url (rule 2.1.6, a skill with web tools).
const packetReviewReportSchema = z.object({
  packetSnapshot: z.object({
    respondent: z.string(),
    country: z.string(),
    relief: z.array(z.string()),
    venueOrCircuit: z.string(),
    documentsReviewed: z
      .array(z.string())
      .describe("The packet as assembled in this run (the generated documents by file name, the I-589 answer table, the filled I-589) and the matter documents it draws on"),
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
    strengtheningSuggestions: z
      .array(z.string())
      .describe("Fact-honest suggestions, with any [CONFIRM WITH CLIENT IF TRUE: ...] questions; never a fact to add because it would help"),
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
      url: z.string().optional().describe("The page it was confirmed on, exactly as fetched; omitted when not fetched"),
    })
  ),
  escalationFlags: z.array(z.string()),
  prioritizedEditChecklist: z.array(
    z.object({
      priority: PRIORITY,
      item: z.string(),
    })
  ),
});

// Mirrors skills-content/packet-build/SKILL.md "Output format", items 1-9.
// Item 5 follows references/i589-guide.md "Output of this step" items 1-3;
// item 2's scorecard has the columns of claim-evaluation's "Element
// scorecard" (the step 1 skill it names).
export const packetBuildOutputSchema = z.object({
  packetSnapshot: z.object({
    client: z.string(),
    country: z.string(),
    reliefSought: z.array(RELIEF),
    venue: z.object({
      forum: VENUE.nullable().describe("null when neither the matter, the documents nor the case note makes it clear"),
      courtOrOffice: z
        .string()
        .optional()
        .describe("The immigration court or asylum office, when the matter, the documents or the case note names it"),
      basis: z.string().describe("What shows the venue, or what the attorney must confirm"),
    }),
    controllingCircuit: z.object({
      circuit: z.string().nullable().describe("e.g. \"Fifth Circuit\"; null when it could not be confirmed"),
      basis: z.string(),
    }),
    materialsReceived: z
      .array(z.string())
      .describe("The exact list of materials provided (by file name, plus the case note), including any NOT REVIEWED or EXCLUDED with its label"),
    materialsNotProvided: z
      .array(z.string())
      .describe("Needed components that were not provided (e.g. prior statements, identity documents, the current blank I-589); their contents are never assumed"),
  }),
  caseTheory: z.object({
    protectedGround: z.array(
      z.object({
        ground: PROTECTED_GROUND,
        articulation: z
          .string()
          .describe("How the record supports it, in the theory's terms (for a particular social group, the formulation)"),
      })
    ),
    relief: z.array(RELIEF),
    elementScorecard: z.array(
      z.object({
        element: z.string(),
        rating: z.enum(["GREEN", "YELLOW", "RED"]),
        basis: z.string(),
        whatWouldStrengthenIt: z.string(),
        authorityAnchor: z.array(authoritySchema),
      })
    ),
    gapsNeedingClientInput: z
      .array(z.string())
      .describe("Each gap as the question to ask the client, never a suggested answer"),
    barsAndEscalationFlags: z
      .array(z.object({ flag: z.string(), detail: z.string() }))
      .describe("Step 1: criminal history, bars, and one-year-deadline problems, escalated per the profile; empty if none"),
  }),
  respondentDeclaration: z.object({
    generatedDeclarationDocumentId: z.string().describe(documentIdDescription("declaration", "generate_document")),
    notGeneratedReason: z.string().optional().describe("Why no declaration was generated; only when the id is empty"),
    sectionsInOrder: z.array(z.string()),
    paragraphCount: z.number().int().min(0),
    clarifyFlags: z
      .array(z.string())
      .describe("Every [CLARIFY] / [CONFIRM WITH CLIENT IF TRUE] flag in the declaration, quoted, in the order they appear"),
  }),
  countryConditionsMemo: z.object({
    recencyCutoff: z
      .string()
      .regex(ISO_DAY)
      .describe(
        "YYYY-MM-DD: today minus six years, or the practice profile's stricter cutoff. Take today's date from this run (a date given in the request, or a web_fetch result's retrieved_at), never from memory"
      ),
    sources: z.array(
      z.object({
        source: z.string().describe("Title and publisher, as the page states them"),
        date: z
          .string()
          .regex(ISO_DATE_TO_DAY_MONTH_OR_YEAR)
          .describe("Publication date: YYYY-MM-DD, or YYYY-MM or YYYY when the source states no more"),
        link: z.string().describe("Exactly as retrieved; never constructed"),
        claimSupported: z.string().describe("The declaration's claim, or the element, this source corroborates"),
        retrievedAt: z
          .string()
          .describe("ISO time this run fetched the link, from the web_fetch result; empty if not fetched in this run"),
      })
    ),
  }),
  formI589: z.object({
    answerTable: z
      .array(
        z.object({
          part: z.enum(I589_ANSWER_TABLE_PARTS),
          field: z.string().describe("The form item, as numbered and labeled on the form"),
          draftedAnswer: z
            .string()
            .describe("From the record only: None or N/A for a truthful negative, a bracketed [CLARIFY WITH CLIENT: ...] flag where no fact supports an answer"),
          sourceInRecord: z.string().describe("The document(s) the answer comes from, by file name; \"none\" for a flagged gap"),
          flag: z.string().optional().describe("Any flag on this answer; omitted when none"),
        })
      )
      .describe("Every field, Part A.I through Part E, in form order"),
    filledPdf: z.object({
      generatedI589PdfDocumentId: z
        .string()
        .describe("document_id fill_pdf_form returned for the final filled I-589; empty when the fill is pending the current blank form"),
      pendingNote: z
        .string()
        .optional()
        .describe("Only when the id is empty: the clear note that the PDF fill is pending the current blank form, and what the attorney must provide"),
      blankFormUsed: z
        .string()
        .optional()
        .describe("The blank fillable I-589 the fill used: the attorney's upload by file name, or the uscis.gov address it was downloaded from"),
      formEdition: z.object({
        editionOnForm: z.string().optional().describe("The edition date printed on the blank form used"),
        currentEditionPerUscis: z
          .string()
          .optional()
          .describe("The current edition as the official USCIS I-589 page states it"),
        verified: z
          .boolean()
          .describe("true only when this run fetched the USCIS I-589 page and the form's edition matches it"),
        url: z.string().optional().describe("The USCIS page the edition was confirmed on, exactly as fetched"),
      }),
      fieldsLeftBlankForFollowUp: z
        .array(z.string())
        .describe("Each form item left blank because its answer is a flagged gap, for the attorney to complete with the client"),
    }),
    flaggedGaps: z.array(z.string()).describe("Every flagged gap in the answer table"),
    crossDocumentDiscrepancies: z
      .array(
        z.object({
          discrepancy: z.string().describe("Names, dates, sequence, places or numbers that differ"),
          whereItAppears: z
            .array(z.string())
            .describe("Each document and place a version of it appears; surfaced, never silently reconciled"),
        })
      )
      .describe("The consistency pass: the I-589 answers against the declaration and any prior statement"),
  }),
  exhibitIndexAndChecklists: z.object({
    exhibitIndex: z.object({
      generatedExhibitIndexDocumentId: z
        .string()
        .describe(documentIdDescription("exhibit index, in the firm's tabbing and house style", "generate_document")),
      notGeneratedReason: z.string().optional().describe("Why no exhibit index was generated; only when the id is empty"),
      exhibits: z.array(
        z.object({
          tab: z.string(),
          document: z.string().describe("The document as indexed, with its file name on the matter"),
          elementsSupported: z
            .array(z.string())
            .describe("The elements it supports; empty when it supports none (background, or clutter to reconsider)"),
        })
      ),
    }),
    corroborationGapList: z.array(
      z.object({
        gap: z.string(),
        availability: z.enum(["reasonably_available", "not_reasonably_available"]),
        action: z
          .string()
          .describe("Reasonably available: who obtains it and how. Not reasonably available: how that is documented for the record"),
      })
    ),
    translationAndCertificationChecklist: z
      .array(
        z.object({
          document: z.string(),
          language: z.string(),
          complete: z
            .boolean()
            .describe("true when a full certified English translation with the translator's certification is in the record"),
          whatIsNeeded: z.string(),
        })
      )
      .describe("Every foreign-language document (certified English translations under 8 CFR 1003.33)"),
    filingChecklist: z.object({
      venue: z.string().describe("The venue this checklist is for, or that it could not be confirmed"),
      items: z
        .array(
          z.object({
            requirement: z
              .string()
              .describe("Cover page, index, pagination, proof of service, or another mechanical requirement of the venue"),
            status: z.string().describe("Where the packet stands on it"),
            authority: z.array(authoritySchema),
          })
        )
        .describe("Every requirement except the deadline"),
      deadline: z.object({
        rule: z
          .string()
          .describe("The filing deadline as the cited source states it; never a number of days from memory"),
        date: z.string().optional().describe("The date it yields, when the hearing or interview date is known"),
        authority: z
          .array(authoritySchema)
          .describe("The current practice manual and the court's local operating procedures it is confirmed against"),
      }),
    }),
  }),
  legalBrief: z
    .object({
      requestedBy: z.enum(["attorney", "practice_profile"]),
      documentType: z.string().describe("e.g. pre-hearing brief, or Asylum Office statement"),
      generatedBriefDocumentId: z.string().describe(documentIdDescription("brief", "generate_document")),
      notGeneratedReason: z.string().optional().describe("Why no brief was generated; only when the id is empty"),
      authorities: z.array(authoritySchema).describe("Every authority and [CITE] placeholder in the brief"),
      attorneyChecklist: z
        .array(z.string())
        .describe("The brief's closing attorney checklist: placeholders to fill, citations to verify, record cites to confirm, PSG wording and circuit issues"),
    })
    .optional()
    .describe("Only when the attorney asked for it or the practice profile calls for a pre-hearing brief or an Asylum Office statement"),
  packetReviewReport: packetReviewReportSchema,
  masterActionChecklist: z
    .array(
      z.object({
        priority: PRIORITY,
        item: z.string(),
      })
    )
    .describe("Everything the attorney must resolve before filing, blocking first"),
});
export type PacketBuildOutput = z.infer<typeof packetBuildOutputSchema>;

/**
 * True only when a source's publication date is confirmed on or after the
 * cutoff (step 3: "excluding anything more than six years old"). Both are
 * schema-validated ISO strings, so they compare as text; a year- or
 * month-only date in the cutoff's own year or month cannot be confirmed.
 */
function confirmedWithinCutoff(publicationDate: string, cutoffDate: string): boolean {
  if (publicationDate.length === cutoffDate.length) return publicationDate >= cutoffDate;
  return publicationDate > cutoffDate.slice(0, publicationDate.length);
}

/**
 * The earliest cutoff step 3 allows at `now`: the UTC date six years back,
 * less one day, because the model may have taken "today" in the firm's time
 * zone or before the run crossed midnight UTC. Feb 29 falls back to Feb 28.
 * Same as sixYearCutoffFloor in ./country-conditions-research.ts, repeated
 * because a skill module imports only zod and ./types.
 */
function sixYearCutoffFloor(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear() - 6, now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10);
}

export const packetBuild = defineSkill({
  name: "packet-build",
  label: "Build asylum packet",
  category: "asylum",
  kind: "build",
  description:
    "Turns the client's raw material into a filing-ready asylum packet draft: the declaration, country-conditions support, the I-589 answer table and filled I-589 PDF, the exhibit index and filing checklist, an optional brief, and the packet-review QA report.",
  outputSchema: packetBuildOutputSchema,
  // Everything the SKILL.md routes to the attorney or treats as blocking: an
  // unconfirmed venue or circuit ("they change the whole build"), step 1's
  // bars and one-year problems, a deliverable that could not be produced
  // (including the I-589 fill pending the current blank form), an edition
  // not confirmed current, sources that break step 3's retrieval or
  // recency rule, a filing deadline not confirmed against the current
  // manual, the QA gate's escalations and blocking issues, the master
  // checklist's blocking tier, and the citations still to verify.
  extractEscalationFlags: (output) => {
    const {
      packetSnapshot: snapshot,
      caseTheory,
      respondentDeclaration: declaration,
      countryConditionsMemo: memo,
      formI589,
      exhibitIndexAndChecklists: evidence,
      legalBrief,
      packetReviewReport: review,
    } = output;
    const flags: string[] = [];
    const notGenerated = (what: string, reason: string | undefined) =>
      `No ${what} was generated${reason ? `: ${reason}` : ""}`;

    if (snapshot.venue.forum === null) {
      flags.push(`Venue not confirmed (USCIS Asylum Office affirmative or EOIR defensive): ${snapshot.venue.basis}`);
    }
    if (snapshot.controllingCircuit.circuit === null) {
      flags.push(`Controlling circuit not confirmed: ${snapshot.controllingCircuit.basis}`);
    }
    flags.push(...caseTheory.barsAndEscalationFlags.map((f) => `${f.flag}: ${f.detail}`));

    if (!declaration.generatedDeclarationDocumentId) {
      flags.push(notGenerated("declaration", declaration.notGeneratedReason));
    }
    if (!formI589.filledPdf.generatedI589PdfDocumentId) {
      flags.push(
        `I-589 PDF not filled${formI589.filledPdf.pendingNote ? `: ${formI589.filledPdf.pendingNote}` : ": pending the current blank form"}`
      );
    }
    if (!formI589.filledPdf.formEdition.verified) {
      flags.push("I-589 edition not confirmed current on uscis.gov in this run: confirm the edition before filing");
    }
    if (!evidence.exhibitIndex.generatedExhibitIndexDocumentId) {
      flags.push(notGenerated("exhibit index", evidence.exhibitIndex.notGeneratedReason));
    }
    if (legalBrief && !legalBrief.generatedBriefDocumentId) {
      flags.push(notGenerated(`${legalBrief.documentType} (requested)`, legalBrief.notGeneratedReason));
    }

    // The reported cutoff is the model's own reading of "today", so it is
    // held to the run date: the runner calls this once, when the run
    // completes. A cutoff earlier than six years before then is flagged and
    // sources are checked against the later of the two. A stricter firm rule
    // is not checked here: the practice profile does not reach this function.
    const floor = sixYearCutoffFloor(new Date());
    const cutoff = memo.recencyCutoff < floor ? floor : memo.recencyCutoff;
    if (memo.recencyCutoff < floor) {
      flags.push(
        `Reported country-conditions recency cutoff ${memo.recencyCutoff} is earlier than six years before this run (${floor}); sources are checked against ${floor}`
      );
    }
    for (const source of memo.sources) {
      if (!source.retrievedAt.trim()) {
        flags.push(`Country-conditions source not retrieved in this run; open and date it before use: ${source.source} (${source.link})`);
      }
      if (!confirmedWithinCutoff(source.date, cutoff)) {
        flags.push(`Country-conditions source not confirmed within the ${cutoff} cutoff: ${source.source}, dated ${source.date}`);
      }
    }

    const { deadline } = evidence.filingChecklist;
    if (deadline.authority.length === 0 || deadline.authority.some((a) => !a.verified)) {
      flags.push(`Filing deadline to confirm against the current manual and the court's local operating procedures: ${deadline.rule}`);
    }

    flags.push(...review.escalationFlags);
    flags.push(...review.blockingIssues.map((issue) => `Packet review BLOCKING: ${issue}`));
    flags.push(...output.masterActionChecklist.filter((i) => i.priority === "blocking").map((i) => i.item));

    const unverified = [
      ...caseTheory.elementScorecard.flatMap((row) => row.authorityAnchor),
      ...evidence.filingChecklist.items.flatMap((item) => item.authority),
      ...deadline.authority,
      ...(legalBrief?.authorities ?? []),
      ...review.caseLawToReview,
    ].filter((a) => !a.verified).length;
    if (unverified > 0) {
      flags.push(
        `${unverified} citation${unverified === 1 ? " is" : "s are"} unverified: confirm and Shepardize each, and fill every [CITE] placeholder, before filing`
      );
    }

    return [...new Set(flags.map((flag) => flag.trim()).filter(Boolean))];
  },
  // fetch_uscis_page: the current I-589 edition (references/i589-guide.md
  // Step 1) and the venue's filing rules on the live practice manual
  // (step 5). generate_document + render_and_qa_docx: the declaration, the
  // exhibit index and the brief. list_pdf_form_fields_packet_build +
  // fill_pdf_form_packet_build: the filled I-589, from the attorney's
  // uploaded blank or else the current one on uscis.gov (tools/
  // packet-build.ts; the model sees list_pdf_form_fields and fill_pdf_form).
  // load_companion_skill_packet_build: the companion skills the build order
  // says to invoke when available. read_prior_skill_reports: what those
  // skills already filed on this matter in their own runs (an element
  // scorecard, an exhibit index, retrieved sources), for the build steps to
  // start from instead of re-deriving; a companion's Word draft is a matter
  // document.
  tools: [
    "fetch_uscis_page",
    "generate_document",
    "render_and_qa_docx",
    "list_pdf_form_fields_packet_build",
    "fill_pdf_form_packet_build",
    "load_companion_skill_packet_build",
    "read_prior_skill_reports",
    "search_library",
    "lookup_library_citation",
    "read_library_document",
  ],
  // Step 3 must report only real, retrieved sources. DOS and HRW are its
  // priority, not its limit, and the firm's accepted source tiers come from
  // the practice profile, so search stays open (2.4). web_fetch opens the
  // country-conditions and legal-authority hosts in fetch-domains.ts only,
  // since the run reads the whole asylum file. Fetched pages are
  // capped below the default: this run also carries the matter's documents,
  // the companion skills, the I-589 field list and rendered pages.
  serverTools: ["web_search", { name: "web_fetch", maxContentTokens: 20_000, allowedDomains: RESEARCH_FETCH_DOMAINS }],
  // The declaration (and a brief) go to generate_document whole, in one
  // turn, and the final report carries a full I-589 answer table.
  maxTokens: 128_000,
  // Companion skills, edition and manual checks, research, the field list,
  // three or four documents each drafted, rendered and fixed, the QA gate.
  maxIterations: 40,
  needsNote: true,
  notePlaceholder:
    "Case note for Build asylum packet (optional): the venue (USCIS Asylum Office or Immigration Court) and which office or court, the controlling circuit, the next interview or hearing date, whether to draft a brief or Asylum Office statement, who prepared the I-589 if not the default signer, and facts from client meetings that are not in the uploaded documents. If you have the blank fillable I-589 PDF you intend to file, upload it and it is the one filled; otherwise the current one is downloaded from the USCIS I-589 page.",
  applicableCaseTypes: ["asylum_affirmative", "asylum_defensive", "withholding_cat"],
});
