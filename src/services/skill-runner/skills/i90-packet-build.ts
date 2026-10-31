import { z } from "zod";
import { defineSkill } from "./types";

// ---------------------------------------------------------------- form fill tool contract

// The fill_uscis_form_pdf tool (tool key fill_uscis_form_pdf_i90, implemented
// in ../tools/i90-packet-build.ts) fills the official fillable PDFs of Form
// I-90 and Form G-28 (SECTION 7 items 5 and 6) with
// src/services/docx-generator/templates/i90-packet-build/fill_uscis_form.py.
// These schemas live here so the skill's generator contract and its report
// schema stay in one file; neither is a submit_report schema.

export const I90_PACKET_FORMS = ["I-90", "G-28"] as const;
export type I90PacketForm = (typeof I90_PACKET_FORMS)[number];

// Values the server fills from the run's firm identity (the FIRM IDENTITY
// section) into fields that hold the firm's or the representative's details:
// the G-28's attorney or representative blocks and the I-90 Part 7 preparer
// block. The model names the value and never types it, so it cannot put
// another firm's or another person's details on a form (docs/ADDING_A_SKILL.md
// 2.8). The *_is_* values are for checkboxes: checked when true.
export const I90_FORM_FIRM_VALUES = [
  "firm_name",
  "firm_street_number_and_name",
  "firm_unit_number",
  "firm_unit_is_apt",
  "firm_unit_is_ste",
  "firm_unit_is_flr",
  "firm_city",
  "firm_state",
  "firm_zip_code",
  "firm_phone",
  "firm_phone_digits",
  "firm_fax",
  "firm_fax_digits",
  "firm_email",
  "signer_full_name",
  "signer_family_name",
  "signer_given_name",
  "signer_middle_name",
  "signer_licensing_authority",
  "signer_bar_number",
  "signer_eoir_id",
  "signer_email",
  "signer_is_attorney",
  "signer_is_accredited_representative",
] as const;
export type I90FormFirmValue = (typeof I90_FORM_FIRM_VALUES)[number];

// One field to fill: by its full name as action inspect listed it, with
// exactly one of value, checked, state or firm_value (checked in the tool).
export const i90FormFieldEntrySchema = z.object({
  name: z.string().min(1).max(300).describe("The field's full name, exactly as action inspect listed it"),
  value: z
    .string()
    .max(2_000)
    .optional()
    .describe("Text and choice fields: the answer exactly as in the answer table, plain ASCII; None or N/A for a truthful negative"),
  checked: z.boolean().optional().describe("Checkboxes with one on-state: true checks it, false clears it"),
  state: z
    .string()
    .max(100)
    .optional()
    .describe("Radio groups and checkboxes with several on-states: the state to select, as inspect listed it; Off clears it"),
  firm_value: z
    .enum(I90_FORM_FIRM_VALUES)
    .optional()
    .describe("Instead of value or checked, for a field that holds the firm's or the representative's details: the app fills it from the firm identity"),
});

// What the model sends: the tool's input_schema. No firm or signer details:
// those reach the form only through firm_value (unknown keys are stripped by
// the parse).
export const i90FormFillInputSchema = z.object({
  action: z
    .enum(["inspect", "fill"])
    .describe("inspect lists the blank form's fillable fields; fill fills them and saves the filled PDF to the matter"),
  form: z.enum(I90_PACKET_FORMS),
  blank_form_url: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Usually left out: the app then takes the fillable PDF the form's own uscis.gov page links (https://www.uscis.gov/i-90 or https://www.uscis.gov/g-28). Give it only to name another https page on uscis.gov that links the form's PDF, or a PDF link a failed call listed"
    ),
  blank_form_document: z
    .string()
    .max(300)
    .optional()
    .describe("Instead of the uscis.gov form: a blank fillable form the attorney uploaded to the matter, by its document id or its file name exactly as its label shows it"),
  fields: z
    .array(i90FormFieldEntrySchema)
    .max(800)
    .optional()
    .describe("fill only: every field to fill, one entry each"),
  file_name: z
    .string()
    .max(120)
    .optional()
    .describe('fill only: file name for the matter\'s documents list, e.g. "Form I-90 - SURNAME - DRAFT.pdf"'),
  signer_attorney_id: z
    .string()
    .max(100)
    .optional()
    .describe(
      "fill only: id of the roster entry (FIRM IDENTITY section) the firm_value signer_* fields describe, when the attorney's note names someone other than the default signer (never on the strength of the matter's documents alone); omit to use the default signer"
    ),
});
export type I90FormFillInput = z.infer<typeof i90FormFillInputSchema>;

// The spec.json fill_uscis_form.py reads: the model's entries with every
// firm_value replaced by the value or checkbox state the server resolved.
export const i90FormFillSpecSchema = z.object({
  fields: z
    .array(
      z.object({
        name: z.string().min(1),
        value: z.string().optional(),
        checked: z.boolean().optional(),
        state: z.string().optional(),
      })
    )
    .min(1),
});
export type I90FormFillSpec = z.infer<typeof i90FormFillSpecSchema>;

// ---------------------------------------------------------------- report schema

// SECTION 1's six routing gates, in its order.
export const I90_ROUTING_GATES = [
  "two_year_card_conditional_resident",
  "pending_or_imminent_naturalization",
  "client_is_outside_the_united_states",
  "abandonment_exposure",
  "removal_posture_and_criminal_history",
  "identity_and_status_proof",
] as const;

// SECTION 1's "Client posture" items, in its order.
export const I90_CLIENT_POSTURE_ITEMS = [
  "full_legal_name_as_on_card_and_every_other_name_used",
  "a_number_uscis_online_account_number_and_date_of_birth",
  "class_of_admission_code_and_date_of_admission_or_adjustment",
  "card_issue_date_expiration_date_and_card_type",
  "mailing_and_physical_address_time_at_each_and_mail_reliability",
  "current_location",
  "travel_history_since_becoming_an_lpr",
  "criminal_history_arrests_and_citations",
  "removal_deportation_exclusion_or_rescission_history",
  "prior_i90_n400_i751_or_i829_and_outcome",
  "n400_filed_imminent_or_contemplated",
  "urgent_need_for_proof_of_status",
  "ability_to_pay_the_fee",
] as const;

// SECTION 4's reasons for filing (its table's Reason column), in its order.
export const I90_REASONS_FOR_FILING = [
  "card_expired_or_expires_within_six_months",
  "card_lost",
  "card_stolen",
  "card_destroyed",
  "card_mutilated",
  "card_issued_but_never_received",
] as const;

// SECTION 5's cross-check: what must be identical across the card, the form,
// the G-28, the cover letter and every enclosure.
export const I90_CROSS_CHECK_ELEMENTS = [
  "a_number",
  "name_spelling",
  "date_of_birth",
  "class_of_admission",
  "date_of_admission",
] as const;

// One SECTION 2 run-time check. verified is true only when a page fetched
// with fetch_uscis_page in this run confirmed it; otherwise the SKILL.md marks
// the item [ATTORNEY: VERIFY] and never answers from memory.
const runTimeCheckSchema = z.object({
  verified: z.boolean(),
  whatWasConfirmed: z
    .string()
    .describe("What the uscis.gov page states; when not verified, [ATTORNEY: VERIFY] and why (fetch failed, page silent)"),
  source: z.string().optional().describe("The page that confirmed it, exactly as fetched"),
  date: z.string().optional().describe("When it was fetched, from the fetch_uscis_page result header"),
});

// A filled form (items 5 and 6): the fill_uscis_form_pdf document plus what
// the attorney needs to check it against the answer table.
const filledFormFields = {
  notGeneratedReason: z
    .string()
    .optional()
    .describe("Why no filled form was generated (build stopped at a gate, no fillable blank form could be obtained); only when the id is empty"),
  formEdition: z
    .string()
    .describe(
      "The edition printed on the blank form that was filled, and whether this run confirmed on uscis.gov that it is the current one; when no form was filled, say so"
    ),
  blankFormSource: z
    .string()
    .describe("The uscis.gov URL or the matter document the blank form came from; when no form was filled, say so"),
};

// The QA gate's report. SECTION 8 says to run i90-packet-review over the
// build's own output and append its report; the run loads that skill's
// instructions with the load_qa_gate_skill tool (../tools/i90-packet-build.ts).
// This mirrors skills-content/i90-packet-review/SKILL.md "Report format",
// items 1-13: the same shape as i90PacketReviewOutputSchema in
// ./i90-packet-review.ts (kept in step with it; skill modules import only
// zod and ./types), except that items 4-11 stay required here. The review
// makes them optional for a run that stops at its scope; the QA gate runs
// only over a packet this build produced, which is in scope.
const qaLiveCheckSchema = z.object({
  verified: z.boolean(),
  finding: z
    .string()
    .describe("What the uscis.gov page states; when not verified, [ATTORNEY: VERIFY] and why (fetch failed, page silent)"),
  url: z.string().optional().describe("The page that confirmed it, exactly as fetched"),
  checkedAt: z.string().optional().describe("When it was fetched, from the fetch_uscis_page result header"),
});
const qaMechanicsItemSchema = z.object({
  status: z.enum(["clear", "fix"]),
  finding: z.string(),
});
const qaProofSchema = z.object({
  rating: z.enum(["sufficient", "thin", "missing"]),
  finding: z.string(),
  whatWouldCureIt: z.string(),
});
const qaExposureSchema = z.object({
  status: z.enum(["not_triggered", "needs_confirmation", "escalate"]),
  notes: z.string(),
});
const i90PacketReviewReportSchema = z.object({
  packetSnapshot: z.object({
    client: z.string().describe("Full name as printed on the card, and every other name used"),
    aNumber: z.string(),
    cardType: z.enum(["ten_year", "two_year_conditional", "not_provided"]),
    cardIssueDate: z.string(),
    cardExpirationDate: z.string(),
    reasonForFiling: z.string().describe("The Part 2 reason as checked on the form"),
    filingChannel: z.enum(["online", "paper", "not_provided"]),
    fee: z.string().describe("Amount and payment form, or Form I-912"),
    feeBasis: z.string().describe("Full fee, the claimed fee exemption and its stated basis, or the fee waiver basis"),
    documentsReviewed: z.array(z.string()),
    documentsNotProvided: z.array(z.string()),
    caseFactsNotProvided: z
      .array(z.string())
      .describe("Basics from \"Before anything\" the packet does not confirm (e.g. travel history, criminal or removal history)"),
  }),
  blockingIssues: z.array(z.string()),
  thresholdDetermination: z.object({
    withinReviewScope: z
      .boolean()
      .describe("False for name or biographic change, DHS or applicant data error, age 14 replacement, commuter, automatic conversion, or legacy AR-3, AR-103 or I-151 cards; the review then stops"),
    mayUseI90: z.boolean().nullable(),
    basis: z.string(),
    thresholdTests: z.array(
      z.object({
        test: z.enum([
          "conditional_resident",
          "pending_or_imminent_naturalization",
          "client_abroad",
          "timing_on_expiring_card",
        ]),
        concernPresent: z.boolean().nullable().describe("null when the packet does not show it"),
        finding: z.string(),
      })
    ),
  }),
  reasonForFiling: z.object({
    selectedReason: z.string().describe("Quoted from Part 2; every box when more than one is checked, or none selected"),
    exactlyOneReasonSelected: z.boolean(),
    correct: z.boolean().nullable(),
    supported: z.boolean().nullable(),
    consistentAcrossPacket: z.boolean().nullable().describe("Part 2 against the cover letter, the Part 8 explanation and the enclosures"),
    assessment: z.string(),
    feeConsequence: z.object({
      selectedReasonFeeExempt: z.boolean().nullable(),
      exemptionClaimed: z.boolean(),
      claimedExemptionSupported: z.boolean().nullable().describe("null when no exemption is claimed"),
      explanation: z.string(),
    }),
  }),
  formFindings: z.array(
    z.object({
      part: z.enum(["Part_1", "Part_2", "Part_3", "Part_4", "Part_5", "Part_6", "Part_7", "Part_8"]),
      issue: z.string(),
      location: z.string(),
      recommendedEdit: z.string(),
    })
  ),
  identityAndStatusProof: z.object({
    identity: qaProofSchema,
    status: qaProofSchema.extend({
      coverLetterSaysStatusRestsOnSecondaryEvidence: z
        .boolean()
        .optional()
        .describe("Only when the card is unavailable and status is carried by secondary evidence"),
    }),
    ground: qaProofSchema.extend({
      mutilatedCard: z
        .object({
          originalSubmitted: z.boolean().nullable(),
          copyMadeForFileFirst: z.boolean().nullable(),
        })
        .optional()
        .describe("Only when the reason is a mutilated card"),
    }),
  }),
  evidenceAssessment: z.object({
    coverageByReason: z.array(
      z.object({
        reason: z.string(),
        evidenceItem: z.string(),
        rating: z.enum(["strong", "thin", "missing"]),
        notes: z.string(),
      })
    ),
    obtainItems: z.array(z.string()).describe("Each as [OBTAIN: ...]"),
    confirmWithClientItems: z.array(z.string()).describe("Each as [CONFIRM WITH CLIENT IF TRUE: ...]"),
  }),
  exposureScreen: z.object({
    abandonmentOfResidence: qaExposureSchema,
    criminalHistory: qaExposureSchema,
    removalOrRescission: qaExposureSchema,
    filingHold: z.object({
      holdUntilAttorneyClears: z.boolean(),
      note: z.string(),
    }),
  }),
  consistencyLog: z.array(
    z.object({
      discrepancy: z.string(),
      whereItAppears: z.string(),
    })
  ),
  filingMechanics: z.object({
    edition: qaMechanicsItemSchema,
    fee: qaMechanicsItemSchema,
    channel: qaMechanicsItemSchema,
    address: qaMechanicsItemSchema,
    assembly: qaMechanicsItemSchema,
    deliverability: qaMechanicsItemSchema,
    postFilingCalendarItems: qaMechanicsItemSchema,
    runTimeVerification: z.object({
      i90AndG28EditionDates: qaLiveCheckSchema.describe("Current editions and whether older editions are still accepted"),
      filingFees: qaLiveCheckSchema.describe("Online and paper fees, and whether biometrics is billed separately"),
      feeExemptReasons: qaLiveCheckSchema.describe("Which reasons are fee exempt and on what conditions"),
      feeWaiverI912Availability: qaLiveCheckSchema,
      directFilingAddress: qaLiveCheckSchema.describe("USPS and courier addresses"),
      onlineFilingForSelectedReason: qaLiveCheckSchema,
      automaticExtensionPeriod: qaLiveCheckSchema.describe("The extension the receipt notice gives an expired card"),
      processingTimes: qaLiveCheckSchema,
    }),
  }),
  authoritiesToReview: z.array(
    z.object({
      citation: z.string(),
      why: z.string(),
      verified: z.boolean(),
      url: z.string().optional().describe("The page the authority was confirmed on, exactly as fetched"),
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

// Mirrors skills-content/i90-packet-build/SKILL.md "SECTION 7. DELIVERABLES",
// items 1-12, then the report SECTION 8 ("QA GATE") says to append and what it
// says to do with its blocking items. Item 1 carries SECTION 1, which the
// skill says to post at the top of the output (inventory, client posture, the
// six routing gates, and the scope stop). Item 4 carries SECTION 5's
// cross-check, which it says to list rather than reconcile. Items 5 and 6 are
// the PDFs fill_uscis_form_pdf fills, items 7 and 11 the Word documents
// generate_document builds; the report carries their ids and what the
// attorney needs to check them, never their text.
export const i90PacketBuildOutputSchema = z.object({
  caseSnapshotAndRoutingDetermination: z.object({
    client: z.string().describe("Full legal name exactly as on the card"),
    aNumber: z.string(),
    cardType: z.enum(["ten_year", "two_year", "unknown"]),
    cardIssueDate: z.string(),
    cardExpirationDate: z.string(),
    reasonForFiling: z
      .enum(I90_REASONS_FOR_FILING)
      .nullable()
      .describe("The one Part 2 reason (SECTION 4); null when the build stopped before a reason was fixed"),
    reasonForFilingExplanation: z
      .string()
      .describe("Why this reason fits the facts, and, when the facts fit more than one, why this one was chosen"),
    filingChannel: z.enum(["online", "paper"]).nullable().describe("SECTION 6; null when the build stopped before a channel was chosen"),
    filingChannelBasis: z.string(),
    fee: z.string().describe("The amount for the channel, or the fee exemption or Form I-912, as verified in this run or marked [ATTORNEY: VERIFY]"),
    feeBasis: z.string().describe("Why the full fee, the exemption, or the waiver applies"),
    routingGates: z
      .array(
        z.object({
          gate: z.enum(I90_ROUTING_GATES),
          concernPresent: z
            .boolean()
            .nullable()
            .describe(
              "true when the gate is triggered (two year card; N-400 filed or imminent; client abroad; abandonment indicators; any arrest, charge, conviction, order, pending proceeding or rescission; no card and no secondary proof of status), false when the material rules it out, null when the material does not resolve it (then it is on the question list)"
            ),
          result: z.string().describe("How the gate was resolved, from what in the material"),
          whatTurnsOnIt: z.string().describe("What the result means for the build and the filing"),
        })
      )
      .length(I90_ROUTING_GATES.length)
      .describe("One row per gate, all six, in the order of the gate enum"),
    routingDetermination: z.object({
      withinScope: z
        .boolean()
        .describe(
          "false for a name or biographic change, a DHS or applicant data error, the age 14 replacement, a commuter status change, automatic conversion, a legacy AR-3, AR-103 or I-151 card, or removal of conditions (Form I-751 or I-829); the build then stops"
        ),
      buildProceeded: z.boolean().describe("false when the build stopped at the scope or at a routing gate"),
      determination: z.string().describe("The routing determination, and where the build stopped and why when it did"),
    }),
    materialInventory: z.object({
      provided: z.array(
        z.object({
          document: z.string().describe("As labeled in the matter, or the case note"),
          whatItShows: z.string(),
        })
      ),
      neededNotProvided: z
        .array(z.string())
        .describe("What a complete packet for this posture needs and was not provided"),
    }),
    clientPosture: z
      .array(
        z.object({
          item: z.enum(I90_CLIENT_POSTURE_ITEMS),
          known: z.boolean().describe("false when the material does not state it: flagged unknown"),
          statement: z.string().describe("What the material states, or what is unknown and must be asked"),
        })
      )
      .length(I90_CLIENT_POSTURE_ITEMS.length)
      .describe("One row per SECTION 1 client posture item, all of them, in the order of the item enum"),
  }),
  clientAndAttorneyQuestionList: z
    .array(z.string())
    .describe("Everything that must be answered before filing, each marked for the client or the attorney"),
  runTimeVerificationLog: z.object({
    formEditionDates: runTimeCheckSchema.describe("Current edition of Form I-90 and of Form G-28, and whether older editions are still accepted"),
    filingFees: runTimeCheckSchema.describe("The online and the paper filing fee, and whether a biometric services fee is charged separately"),
    feeExemptReasons: runTimeCheckSchema.describe("Which reasons for filing are fee exempt, and the exact conditions"),
    feeWaiverI912: runTimeCheckSchema.describe("Whether Form I-912 fee waivers are available for the I-90, and the current income and hardship criteria"),
    directFilingAddress: runTimeCheckSchema.describe("The direct filing address for a paper I-90, USPS and courier or express"),
    onlineFilingForReason: runTimeCheckSchema.describe(
      "Whether online filing is available for this reason, and whether the attorney can represent the client through a USCIS online account"
    ),
    automaticExtensionPeriod: runTimeCheckSchema.describe(
      "The automatic extension the I-90 receipt notice gives an expired card, and the exact language the notice uses"
    ),
    processingTimes: runTimeCheckSchema.describe("Current I-90 processing times at the adjudicating office"),
    aditOrI551StampProcess: runTimeCheckSchema.describe(
      "Whether the ADIT or I-551 stamp appointment process for interim proof of status has changed"
    ),
  }),
  formI90AnswerTable: z.object({
    rows: z.array(
      z.object({
        partAndItemNumber: z.string(),
        question: z.string(),
        answer: z
          .string()
          .describe("As it goes on the form; None or N/A for a truthful negative; a bracketed flag where the record has no supporting fact"),
        sourceOfTheAnswer: z.string(),
        flag: z.string().optional(),
      })
    ),
    crossCheckVariances: z
      .array(
        z.object({
          element: z.enum(I90_CROSS_CHECK_ELEMENTS),
          variance: z.string(),
          whereItAppears: z.string().describe("Each document and place where a version of it appears"),
        })
      )
      .describe("Every variance across the card, the form, the G-28, the cover letter and every enclosure; listed, never reconciled"),
  }),
  filledFormI90Pdf: z.object({
    generatedI90PdfDocumentId: z
      .string()
      .describe("document_id fill_uscis_form_pdf returned for the final filled I-90; empty if none was generated"),
    ...filledFormFields,
    agreesWithAnswerTable: z
      .boolean()
      .nullable()
      .describe("true when every filled field matches its answer table row; null when no filled I-90 was generated"),
    signatureAndDateLeftForSignature: z
      .boolean()
      .nullable()
      .describe(
        "true when the applicant's signature and signature date are left blank for the client to sign; null when no filled I-90 was generated"
      ),
    fieldsLeftBlank: z
      .array(z.string())
      .describe("Fields deliberately left blank (a flagged gap, a part that does not apply), by part and item number, with why"),
  }),
  formG28: z.object({
    generatedG28PdfDocumentId: z
      .string()
      .describe("document_id fill_uscis_form_pdf returned for the final filled G-28; empty if none was generated"),
    ...filledFormFields,
    representative: z
      .string()
      .describe("Who the G-28 names for the office (the roster entry the app filled) and in what capacity"),
    client: z.string().describe("The client as the G-28 names them"),
    matchesI90Part7: z
      .boolean()
      .nullable()
      .describe("Whether the preparer information in I-90 Part 7 matches the G-28; null when either form was not filled"),
    openItems: z
      .array(z.string())
      .describe("What remains before it can be filed: signatures, the client's consent, details to confirm"),
  }),
  coverLetter: z.object({
    generatedCoverLetterDocumentId: z
      .string()
      .describe("document_id returned by generate_document for the final cover letter; empty if none was generated"),
    notGeneratedReason: z.string().optional().describe("Why no cover letter was generated; only when the id is empty"),
    reasonAndGround: z.string().describe("The letter's one sentence giving the reason for filing and the ground"),
    feeOrFeeExemptionBasis: z.string().describe("The fee, or the fee exemption basis with its reason, as the letter states it"),
    statesStatusRestsOnSecondaryEvidence: z
      .boolean()
      .optional()
      .describe("Only when the card is unavailable: whether the letter says explicitly that status is shown by secondary evidence (SECTION 4)"),
    enclosureList: z.array(z.string()).describe("The numbered enclosure list exactly as the letter prints it, in order"),
    enclosuresMatchTabs: z
      .boolean()
      .nullable()
      .describe("true when the enclosure list matches the evidence index tabs exactly; null when no cover letter was generated"),
  }),
  evidenceIndex: z.array(
    z.object({
      tabNumber: z.string(),
      document: z.string(),
      whatItProves: z.string(),
      originalOrCopy: z.enum(["original", "copy"]),
      translationStatus: z
        .string()
        .describe("Certified English translation with the translator certification attached, not needed (English), or missing"),
    })
  ),
  evidenceRequestList: z.array(
    z.object({
      item: z.string(),
      whoGetsIt: z.string(),
      whyThePacketIsWeakerWithoutIt: z.string(),
    })
  ),
  feeAndFilingChecklist: z.object({
    amount: z.string(),
    paymentMethod: z.string(),
    payee: z.string(),
    channel: z.string(),
    addressMatchedToMailingMethod: z.string().describe("The verified direct filing address for the mailing method, or why none applies (online)"),
    editionDateConfirmed: z.string(),
    everySignatureConfirmed: z.string().describe("Each signature the packet needs and its state"),
    tracking: z.string(),
    fileCopy: z.string(),
  }),
  clientInstructionSheet: z.object({
    generatedInstructionSheetDocumentId: z
      .string()
      .describe("document_id returned by generate_document for the final client instruction sheet; empty if none was generated"),
    notGeneratedReason: z.string().optional().describe("Why no instruction sheet was generated; only when the id is empty"),
    covers: z
      .object({
        whatWasFiledAndWhy: z.boolean(),
        keepReceiptNoticeWithExpiredCard: z.boolean(),
        ascBiometricsAppointmentMandatory: z.boolean(),
        reportAddressChangesAndHow: z.boolean(),
        aditStampForUrgentProofOfStatus: z.boolean(),
        noTravelWithoutSpeakingToTheOffice: z.boolean(),
        expectedProcessingTime: z.boolean(),
      })
      .nullable()
      .describe("Which of the SECTION 7 item 11 points the sheet covers; null when no instruction sheet was generated"),
  }),
  calendarItems: z.array(
    z.object({
      item: z.string(),
      when: z.string().describe("A date, or the event it runs from (filing, the receipt notice) when the date is not yet known"),
    })
  ),
  // SECTION 8 runs the gate "When the packet is assembled"; a build stopped at
  // the scope or a routing gate assembles none, so there is nothing to review.
  qaGateReport: i90PacketReviewReportSchema
    .optional()
    .describe(
      "The i90-packet-review report over this packet as built (SECTION 8), its Report format items 1-13; omitted only when the build stopped at the scope or a routing gate (routingDetermination.buildProceeded false), since no packet was assembled for the gate to review"
    ),
  qaGateResolution: z
    .object({
      resolvedBlockingItems: z
        .array(z.string())
        .describe("Blocking items the QA gate returned that this run fixed (by rebuilding a document), and how"),
      openBlockingItems: z.array(z.string()).describe("Blocking items still open, flagged for the attorney"),
      filingReady: z.boolean().describe("true only when no blocking item is open"),
    })
    .describe("When the build stopped before the QA gate: both lists empty and filingReady false"),
});
export type I90PacketBuildOutput = z.infer<typeof i90PacketBuildOutputSchema>;

const ROUTING_GATE_LABELS: Record<(typeof I90_ROUTING_GATES)[number], string> = {
  two_year_card_conditional_resident: "two year card, conditional resident",
  pending_or_imminent_naturalization: "pending or imminent naturalization",
  client_is_outside_the_united_states: "client is outside the United States",
  abandonment_exposure: "abandonment exposure",
  removal_posture_and_criminal_history: "removal posture and criminal history",
  identity_and_status_proof: "identity and status proof",
};

const RUN_TIME_CHECK_LABELS: Record<keyof I90PacketBuildOutput["runTimeVerificationLog"], string> = {
  formEditionDates: "I-90 and G-28 edition dates",
  filingFees: "filing fees",
  feeExemptReasons: "fee exempt reasons",
  feeWaiverI912: "Form I-912 fee waiver",
  directFilingAddress: "direct filing address",
  onlineFilingForReason: "online filing for the reason",
  automaticExtensionPeriod: "automatic extension period",
  processingTimes: "processing times",
  aditOrI551StampProcess: "ADIT or I-551 stamp process",
};

/** A run-time check's finding without the [ATTORNEY: VERIFY] tag the flag adds itself. */
function withoutVerifyTag(text: string): string {
  return text.replace(/^\s*\[ATTORNEY: VERIFY\]\s*/i, "");
}

// What the SKILL.md routes to the supervising attorney: a scope or gate stop
// ("Say so and stop", "Never build past a routing gate"), every gate that is
// triggered or unresolved (SECTION 1 and the guardrails: conditional
// residence, abandonment, criminal history and removal posture "go to the
// supervising attorney before anything is filed"), every SECTION 2 check not
// confirmed on uscis.gov ([ATTORNEY: VERIFY]), every SECTION 5 cross-check
// variance, a deliverable that could not be generated, and the QA gate's
// blocking items, escalations, scope or threshold stops and exposure holds
// (SECTION 8: "Resolve or flag every blocking item"), or its absence from a
// build that proceeded. The QA gate's own uscis.gov checks repeat SECTION
// 2's, which are already flagged above.
function i90PacketBuildEscalationFlags(output: I90PacketBuildOutput): string[] {
  const snapshot = output.caseSnapshotAndRoutingDetermination;
  const routing = snapshot.routingDetermination;
  const qa = output.qaGateReport;
  const flags: string[] = [];

  if (!routing.withinScope) flags.push(`Outside the I-90 build scope: ${routing.determination}`);
  else if (!routing.buildProceeded) flags.push(`Build stopped: ${routing.determination}`);
  for (const gate of snapshot.routingGates) {
    if (gate.concernPresent === false) continue;
    const label = ROUTING_GATE_LABELS[gate.gate];
    flags.push(
      gate.concernPresent === null
        ? `Routing gate unresolved (${label}): ${gate.result}`
        : `Routing gate triggered (${label}): ${gate.result}. ${gate.whatTurnsOnIt}`
    );
  }
  for (const [key, check] of Object.entries(output.runTimeVerificationLog) as [
    keyof typeof RUN_TIME_CHECK_LABELS,
    z.infer<typeof runTimeCheckSchema>,
  ][]) {
    if (!check.verified) flags.push(`[ATTORNEY: VERIFY] ${RUN_TIME_CHECK_LABELS[key]}: ${withoutVerifyTag(check.whatWasConfirmed)}`);
  }
  for (const variance of output.formI90AnswerTable.crossCheckVariances) {
    flags.push(`Cross-check variance, ${variance.element.replace(/_/g, " ")}: ${variance.variance} (${variance.whereItAppears})`);
  }

  if (routing.buildProceeded) {
    const documents: [string, string, string | undefined][] = [
      ["filled Form I-90", output.filledFormI90Pdf.generatedI90PdfDocumentId, output.filledFormI90Pdf.notGeneratedReason],
      ["filled Form G-28", output.formG28.generatedG28PdfDocumentId, output.formG28.notGeneratedReason],
      ["cover letter", output.coverLetter.generatedCoverLetterDocumentId, output.coverLetter.notGeneratedReason],
      [
        "client instruction sheet",
        output.clientInstructionSheet.generatedInstructionSheetDocumentId,
        output.clientInstructionSheet.notGeneratedReason,
      ],
    ];
    for (const [label, id, reason] of documents) {
      if (!id) flags.push(`No ${label} was generated${reason ? `: ${reason}` : ""}`);
    }
  }

  flags.push(...output.qaGateResolution.openBlockingItems.map((item) => `Open blocking item: ${item}`));
  if (!output.qaGateResolution.filingReady && routing.buildProceeded) {
    flags.push("The packet is not filing ready: see the QA gate report");
  }
  // A stopped build has no packet and no QA report; a built one must have both.
  if (qa) {
    flags.push(...qa.escalationFlags.map((flag) => `QA gate: ${flag}`));
    flags.push(...qa.blockingIssues.map((issue) => `QA gate BLOCKING: ${issue}`));
    if (!qa.thresholdDetermination.withinReviewScope) {
      flags.push(`QA gate: outside the I-90 review scope: ${qa.thresholdDetermination.basis}`);
    } else if (qa.thresholdDetermination.mayUseI90 !== true) {
      const verdict = qa.thresholdDetermination.mayUseI90 === false ? "client may not use" : "not confirmed the client may use";
      flags.push(`QA gate: ${verdict} Form I-90: ${qa.thresholdDetermination.basis}`);
    }
    const exposure = qa.exposureScreen;
    for (const [label, area] of [
      ["abandonment of residence", exposure.abandonmentOfResidence],
      ["criminal history", exposure.criminalHistory],
      ["removal or rescission", exposure.removalOrRescission],
    ] as const) {
      if (area.status === "escalate") flags.push(`QA gate: escalate, ${label}: ${area.notes}`);
    }
    if (exposure.filingHold.holdUntilAttorneyClears) {
      flags.push(`QA gate: hold filing until the attorney clears exposure: ${exposure.filingHold.note}`);
    }
  } else if (routing.buildProceeded) {
    flags.push("QA gate (i90-packet-review) was not run: run it on this matter before the packet is filed");
  }

  return [...new Set(flags.map((flag) => flag.trim()).filter(Boolean))];
}

export const i90PacketBuild = defineSkill({
  name: "i90-packet-build",
  label: "Build I-90 packet",
  category: "uscis",
  kind: "build",
  description:
    "Builds a filing-ready Form I-90 green card renewal or replacement packet: routing gates, answer table, filled I-90 and G-28 PDFs, cover letter, evidence index, fee and filing checklist and client instruction sheet, checked by the i90-packet-review QA gate.",
  outputSchema: i90PacketBuildOutputSchema,
  extractEscalationFlags: i90PacketBuildEscalationFlags,
  // fetch_uscis_page: SECTION 2's run-time verification on uscis.gov (its
  // text has no links). fill_uscis_form_pdf_i90: items 5 and 6, the filled
  // I-90 and G-28 (../tools/i90-packet-build.ts), from the blank PDFs it finds
  // on the forms' uscis.gov pages itself and malware-scans before use.
  // generate_document + render_and_qa_docx: item 7, the cover letter, and
  // item 11, the client instruction sheet (render_and_qa_docx also shows the
  // filled forms' pages). load_qa_gate_skill_i90_packet_review: SECTION 8.
  // No web search: every source this skill names is uscis.gov.
  tools: [
    "fetch_uscis_page",
    "fill_uscis_form_pdf_i90",
    "generate_document",
    "render_and_qa_docx",
    "load_qa_gate_skill_i90_packet_review",
    "search_library",
    "lookup_library_citation",
    "read_library_document",
  ],
  // The documents are short, but the final report carries the whole I-90
  // answer table and the full i90-packet-review report, and a fill passes a
  // value for every field of the form in one turn.
  maxTokens: 128_000,
  // Nine uscis.gov checks across several pages, two forms inspected and
  // filled, two documents drafted, every deliverable rendered and fixed, the
  // QA gate, then fixes and the report.
  maxIterations: 30,
  needsNote: true,
  notePlaceholder:
    "Case note for Build I-90 packet (optional): what happened to the card and when, whether the client is in the United States, travel since becoming an LPR, any arrest, citation, conviction, removal or prior filing history, any N-400 filed or planned, any urgent need for proof of status, ability to pay the fee, the client's language and interpreter, and the office's filing channel and mailing method, if not in the uploaded documents. The blank I-90 and G-28 are taken from uscis.gov and malware-scanned before use; upload the current blank fillable PDFs to the matter only if that fails.",
  applicableCaseTypes: ["i90"],
});
