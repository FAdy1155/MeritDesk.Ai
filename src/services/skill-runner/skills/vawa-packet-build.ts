import { z } from "zod";
import { defineSkill } from "./types";
import { LEGAL_AUTHORITY_FETCH_DOMAINS } from "../fetch-domains";

// Shared shapes. The ratings and severity tiers are the SKILL.md's own labels
// (Section 4 Step 1, and vawa-packet-review's Section 3 tiers).
const elementRatingSchema = z.enum(["ESTABLISHED", "THIN", "NOT_ESTABLISHED"]);
const severitySchema = z.enum(["BLOCKER", "MATERIAL", "POLISH"]);

// Hard Rule 3: only Section 3 authority or authority retrieved and read in
// this run; everything else is [VERIFY CITE] (verified false).
const authoritySchema = z.object({
  citation: z.string(),
  verified: z
    .boolean()
    .describe(
      "true only for authority retrieved and read in this run, or taken from SKILL.md Section 3 outside the Section 3.12 \"Cite to verify\" column; false means [VERIFY CITE]"
    ),
  url: z.string().optional().describe("The page the authority was read on in this run, exactly as retrieved"),
});

// Items 10-12: SKILL.md Section 6, "an answer table and a filled PDF" per
// form. The answer table is the source of truth; the PDF is filled from it
// with fill_pdf_form, from a blank the attorney uploaded to the matter or the
// current one the tool downloads from the form's uscis.gov page (6.1).
const formAnswerTableAndPdfSchema = z.object({
  editionUsed: z
    .string()
    .describe("The form edition the answers and the PDF follow, as printed on the form (Section 6.1); empty if no form was built"),
  editionVerified: z.boolean().describe("true only if the edition was confirmed current on uscis.gov in this run"),
  answerTable: z.array(
    z.object({
      item: z.string().describe("Part and item number as printed on the form"),
      question: z.string(),
      answer: z
        .string()
        .describe("The answer as written on the form; \"None\" or \"N/A\" for a truthful negative; a [CLARIFY WITH CLIENT: ...] flag where the record has no supporting fact"),
      source: z.string().describe("The document or client statement the answer comes from"),
    })
  ),
  blankFormDocument: z
    .string()
    .optional()
    .describe(
      "The blank form the PDF was filled from, as fill_pdf_form reported its source: the matter document's file name, or the uscis.gov PDF URL; omitted when no PDF was filled"
    ),
  generatedFilledPdfDocumentId: z
    .string()
    .describe("document_id returned by fill_pdf_form for the final filled PDF; empty when the PDF fill is pending"),
  pdfFillNote: z
    .string()
    .describe("Which fields were left blank and marked for follow-up, or, with no PDF, that the fill is pending the current blank form and why"),
});

// Item 17's first report: the vawa-packet-review QA gate, loaded with
// load_vawa_packet_review_skill. Mirrors
// skills-content/vawa-packet-review/SKILL.md "SECTION 4. OUTPUT FORMAT",
// items 1-12, the same shape as vawaPacketReviewOutputSchema in
// ./vawa-packet-review.ts (kept in step with it; skill modules import only
// zod and ./types), with two differences: url on each authority, because
// this skill has web tools, and "unknown" for the abuser's status and the
// client's location, because this run's own Section 1 states each posture
// item "or flag[s] it as unknown" and the review describes the same packet.
const vawaPacketReviewReportSchema = z.object({
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
    abuserStatus: z
      .enum(["USC", "LPR", "US_national", "unknown"])
      .describe("unknown when the record does not show it (as in packetSnapshot.abuserStatus); never assumed"),
    marriageStatus: z.string(),
    clientLocation: z
      .enum(["united_states", "abroad", "unknown"])
      .describe("unknown when the record does not show it; never assumed"),
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
      rating: elementRatingSchema,
      whereSupported: z.string(),
      whatIsMissingOrWeak: z.string(),
      defects: z.array(
        z.object({
          severity: severitySchema,
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
      severity: severitySchema,
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
      priority: severitySchema,
      fix: z.string(),
      location: z.string(),
      responsibleParty: z.string(),
    })
  ),
  authoritiesRelied: z.array(authoritySchema),
  escalationFlags: z.array(z.string()),
});

// Item 17's second report: orthography-check over the cover letter and the
// declaration (Section 4 Step 10), loaded with load_orthography_check_skill.
// Mirrors skills-content/orthography-check/SKILL.md "Report structure". Its
// corrected copy is the regenerated document the report items 5 and 13 name.
const orthographyCheckReportSchema = z.object({
  document: z.string().describe("Which document was checked: the cover letter or the declaration"),
  summary: z.string(),
  fixed: z.array(
    z.object({
      location: z.string(),
      category: z.string(),
      original: z.string(),
      corrected: z.string(),
    })
  ),
  flaggedForYourDecision: z.array(
    z.object({
      location: z.string(),
      category: z.string(),
      text: z.string(),
      whyFlagged: z.string(),
      options: z.string(),
    })
  ),
  nameAndTermConsistency: z.array(
    z.object({
      nameOrTerm: z.string(),
      variants: z.array(z.object({ variant: z.string(), count: z.number().int().min(0) })),
      standardizedTo: z.string(),
    })
  ),
  documentWideNotes: z.array(z.string()),
});

// Mirrors skills-content/vawa-packet-build/SKILL.md "SECTION 7. OUTPUT",
// items 1-18. The drafted documents (items 5, 6, 13 and 14) are Word files
// built with generate_document and the filled forms (items 10-12) are PDFs
// built with fill_pdf_form; the report carries their ids and what the
// attorney needs to review them, never their text. Items 1 and 2 also carry
// Section 1 (intake, posture, the four build-changing determinations, the
// client and attorney question list), item 4 the Section 4 Step 1 issues, and
// item 7 the three Step 3 tables.
export const vawaPacketBuildOutputSchema = z.object({
  safetyConflictAnd1367Flags: z.array(
    z.object({
      type: z.enum(["SAFETY", "CONFLICT", "1367"]),
      detail: z.string(),
    })
  ),
  packetSnapshot: z.object({
    client: z.string(),
    scope: z
      .enum([
        "abused_spouse",
        "intended_spouse",
        "spouse_whose_child_was_abused",
        "abused_child_out_of_scope",
        "abused_parent_out_of_scope",
      ])
      .describe("SKILL.md scope paragraph; an abused child or abused parent self-petition is out of scope, and the build stops there"),
    scopeNote: z.string(),
    abuserStatus: z.enum(["USC", "LPR", "US_national", "unknown"]),
    postureDeterminations: z.object({
      marriagePosture: z.enum([
        "intact",
        "separated",
        "divorced_before_filing",
        "divorced_after_filing",
        "abuser_deceased",
        "intended_spouse",
        "unknown",
      ]),
      dateAndPlaceOfMarriage: z.string(),
      clientPriorMarriages: z.array(
        z.object({
          marriage: z.string(),
          terminationDate: z.string(),
          waitingOrRevocablePeriod: z
            .string()
            .describe("What the decree shows on any waiting or revocable period (Section 3.4), or that no decree was provided"),
        })
      ),
      residenceWithAbuserDuringMarriage: z.object({
        resided: z.boolean().nullable(),
        addressesAndDates: z.array(z.string()),
      }),
      clientLocation: z.enum(["inside_united_states", "abroad", "unknown"]),
      immigrationStatusAndEntryHistory: z.string(),
      removalPosture: z.enum(["never_in_proceedings", "in_proceedings", "prior_order", "detained", "unknown"]),
      marriageDuringRemovalProceedings: z.boolean().nullable(),
      criminalOrArrestHistory: z.string(),
      priorImmigrationFilings: z.string().describe("Including any I-130 filed by the abuser or anyone else"),
      derivativeChildren: z.array(
        z.object({
          name: z.string(),
          dateOfBirth: z.string(),
          maritalStatus: z.string(),
          ageAtIntendedFilingDate: z.string(),
          location: z.string(),
          withinOneYearOf21: z.boolean().nullable(),
        })
      ),
      recordsThatExist: z.object({
        protectiveOrder: z.boolean().nullable(),
        policeReport: z.boolean().nullable(),
        shelterRecord: z.boolean().nullable(),
        medicalRecord: z.boolean().nullable(),
        psychologicalEvaluation: z.boolean().nullable(),
      }),
      formsRequested: z.string().describe("Which forms the attorney wants built, or that the attorney has not said"),
      safeMailingAddressOnFile: z.boolean().nullable(),
    }),
    buildChangingDeterminations: z.object({
      canI485BeFiled: z.object({ answer: z.boolean().nullable(), whatTurnsOnIt: z.string() }),
      marriageTerminatedBeforeFiling: z.object({ answer: z.boolean().nullable(), whatTurnsOnIt: z.string() }),
      intendedSpouseCase: z.object({ answer: z.boolean().nullable(), whatTurnsOnIt: z.string() }),
      gmcBarInRecord: z.object({ answer: z.boolean().nullable(), whatTurnsOnIt: z.string() }),
    }),
    formsBuilt: z.array(z.enum(["I-360", "I-485", "I-765"])),
    materialsReceived: z.array(z.string()).describe("Exactly what was provided, by document"),
    materialsNotProvided: z
      .array(z.string())
      .describe("What a complete packet for this posture needs and was not provided"),
    clientAndAttorneyQuestionList: z.array(z.string()),
  }),
  runTimeVerificationNote: z.array(
    z.object({
      item: z.string().describe("One Section 2 item, e.g. the I-485 edition date or the VAWA I-360 courier filing address"),
      verified: z.boolean().describe("false marks the item [ATTORNEY: VERIFY]"),
      finding: z.string().describe("What the page showed, or why it could not be verified"),
      url: z.string().optional().describe("The page it was verified on, exactly as fetched"),
      dateVerified: z.string().optional(),
    })
  ),
  elementScorecard: z.object({
    elements: z.array(
      z.object({
        number: z.number().int().min(1).max(8),
        element: z.string(),
        rating: elementRatingSchema,
        supportingFactsAndDocuments: z.array(z.string()),
        gapsNeedingClientInput: z.array(z.string()),
      })
    ),
    issuesSurfaced: z
      .array(z.string())
      .describe("Any bar, 204(c) or 204(g) issue, divorce-exception requirement, visa availability problem, or age-out risk"),
  }),
  declaration: z.object({
    generatedDeclarationDocumentId: z
      .string()
      .describe("document_id returned by generate_document for the final declaration; empty if none could be generated"),
    notGeneratedReason: z.string().optional(),
    declarant: z.string(),
    sectionsInOrder: z.array(z.string()).describe("The bold section headings as printed"),
    paragraphCount: z.number().int().min(0),
    interpreterCertificationIncluded: z.boolean(),
    clarifyWithClientFlags: z
      .array(z.string())
      .describe("Every [CLARIFY WITH CLIENT] and [CONFIRM WITH CLIENT IF TRUE] flag, as collected at the end of the declaration"),
  }),
  thirdPartyAffidavitTemplatesAndAffiantList: z.object({
    generatedAffidavitTemplateDocumentIds: z
      .array(z.string())
      .describe("document_ids returned by generate_document for the affidavit templates and marriage-witness letters"),
    affiants: z.array(
      z.object({
        affiant: z.string().describe("Name, or the role in the record when no name is given"),
        relationshipToParties: z.string(),
        howTheyKnow: z.string().describe("What the person personally saw or heard, and when"),
        canAttestTo: z.string(),
        elementsSupported: z.array(z.string()),
        format: z.enum(["affidavit", "marriage_witness_letter"]),
      })
    ),
  }),
  residenceTableAbuseIncidentTableAndElementToEvidenceMatrix: z.object({
    residenceTable: z.object({
      marriageDate: z.string(),
      separationDate: z.string(),
      rows: z.array(
        z.object({
          address: z.string(),
          moveInDate: z.string(),
          moveOutDate: z.string(),
          nameOnLeaseOrDeed: z.string(),
          whoElseLivedThere: z.string(),
          corroboratingDocument: z.string(),
          duringMarriage: z.boolean().nullable(),
        })
      ),
    }),
    abuseIncidentTable: z.array(
      z.object({
        approximateDate: z.string(),
        location: z.string(),
        conduct: z.string(),
        physicalOrNonPhysical: z.enum(["physical", "non_physical"]),
        controlTactic: z.string(),
        fearOrThreatLink: z.string(),
        severityOrRepetition: z.string(),
        corroboratingDocument: z.string().describe("The document, or \"none\""),
      })
    ),
    elementToEvidenceMatrix: z.object({
      documents: z.array(z.string()).describe("One column per document, in order"),
      rows: z.array(
        z.object({
          element: z.string(),
          supportedBy: z.array(z.string()).describe("The documents (from documents) that support this element"),
          declarationOnly: z.boolean().describe("true when nothing but the declaration supports the element"),
        })
      ),
    }),
  }),
  enclosureListAndEvidenceRequestList: z.object({
    enclosureList: z.array(
      z.object({
        document: z.string().describe("A document that exists and was provided"),
        elementsProved: z.array(z.string()),
      })
    ),
    evidenceRequestList: z.array(
      z.object({
        document: z.string(),
        owner: z.string().describe("Who obtains it"),
        source: z.string().describe("From where"),
        method: z.string().describe("Records request, subpoena, provider letter, certified copy order"),
        safeToObtain: z.boolean().nullable().describe("Under 8 U.S.C. 1367; null if it cannot be judged"),
        safetyNote: z.string(),
        explainAbsenceInDeclaration: z
          .boolean()
          .describe("true when it cannot be obtained safely or at all, so the declaration must explain why"),
      })
    ),
  }),
  translationAndCertificationChecklist: z.array(
    z.object({
      document: z.string(),
      language: z.string(),
      fullEnglishTranslationProvided: z.boolean(),
      translatorCertificationProvided: z.boolean(),
      actionNeeded: z.string(),
    })
  ),
  formI360AnswerTableAndFilledPdf: formAnswerTableAndPdfSchema.extend({
    classificationBox: z
      .string()
      .describe("The Part 2 box selected and why it matches the abuser's status (Section 6.3)"),
  }),
  formI485AnswerTableAndFilledPdf: formAnswerTableAndPdfSchema.extend({
    canBeFiledNow: z.boolean(),
    whyNotYet: z
      .string()
      .optional()
      .describe("Why the I-485 cannot be filed yet and what has to happen first; only when canBeFiledNow is false"),
  }),
  formI765AnswerTableAndFilledPdf: formAnswerTableAndPdfSchema.extend({
    categoryCode: z.enum(["(c)(09)", "(c)(31)"]).nullable().describe("Item 27 eligibility category; null when no I-765 is built"),
    categoryReason: z.string().describe("Why that code fits the actual posture and filing sequence"),
  }),
  coverLetter: z.object({
    generatedCoverLetterDocumentId: z
      .string()
      .describe("document_id returned by generate_document for the final cover letter; empty if none could be generated"),
    notGeneratedReason: z.string().optional(),
    mailingMethod: z.string().describe("Courier or USPS, as the office will mail it, or that the attorney has not said"),
    filingAddressUsed: z.string(),
    elementWalkthrough: z.array(
      z.object({
        element: z.string(),
        documents: z.array(z.string()),
        declarationParagraphs: z.string(),
      })
    ),
    statutoryExceptionPleaded: z
      .boolean()
      .nullable()
      .describe("The divorce or death exception pleaded as its own section; null when the marriage did not end before filing"),
    expediteRequest: z.string().optional(),
    authoritiesCited: z.array(authoritySchema),
  }),
  legalSupportMemo: z
    .object({
      generatedLegalMemoDocumentId: z
        .string()
        .describe("document_id returned by generate_document for the memo; empty if it could not be generated"),
      issues: z.array(z.string()),
      authorities: z.array(authoritySchema),
    })
    .optional(),
  crossDocumentReconciliationTable: z.array(
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
  filingChecklist: z.array(
    z.object({
      item: z.string(),
      ready: z.boolean(),
      note: z.string(),
    })
  ),
  // Step 10 says not to skip either gate, but a run can end before it: the
  // out-of-scope stop, or the runner's wrap-up at its iteration or context
  // limit. The review report is then omitted (rule 2.1.7) rather than filled
  // with a verdict no review reached, and the not-run gate is escalated.
  vawaPacketReviewAndOrthographyCheckReports: z.object({
    vawaPacketReviewReport: vawaPacketReviewReportSchema
      .optional()
      .describe(
        "The vawa-packet-review report on the assembled packet; omitted only when the gate did not run in this run (the case stopped as out of scope, or the run ended first), with the reason in qaGateNotes"
      ),
    vawaPacketReviewSkillLoaded: z
      .boolean()
      .describe("true only if load_vawa_packet_review_skill returned the skill's instructions in this run and the review ran under them"),
    orthographyCheckReports: z
      .array(orthographyCheckReportSchema)
      .describe("One report per document checked (the cover letter and the declaration); empty when the pass did not run, with the reason in qaGateNotes"),
    orthographyCheckSkillLoaded: z
      .boolean()
      .describe("true only if load_orthography_check_skill returned the skill's instructions in this run and the pass ran under them"),
    qaGateNotes: z
      .array(z.string())
      .describe("How each QA gate ran, and anything that kept it from running as that skill (e.g. the skill could not be loaded, or the run ended before Step 10)"),
  }),
  masterActionChecklist: z.array(
    z.object({
      item: z.string(),
      blocking: z.boolean(),
      owner: z.string(),
    })
  ),
});
export type VawaPacketBuildOutput = z.infer<typeof vawaPacketBuildOutputSchema>;

export const vawaPacketBuild = defineSkill({
  name: "vawa-packet-build",
  label: "Build VAWA packet",
  category: "uscis",
  kind: "build",
  description:
    "Builds a VAWA self-petition packet from the client's material: the declaration, form answer tables and filled I-360, I-485 and I-765, evidence tables, affidavit templates, cover letter and filing checklist, checked by the vawa-packet-review QA gate.",
  outputSchema: vawaPacketBuildOutputSchema,
  // What the SKILL.md routes to the supervising attorney: the item 1 flags
  // (a SAFETY FLAG opens the output), an out-of-scope case ("say so and
  // stop"), the Section 1 client and attorney question list, Section 2 items
  // left [ATTORNEY: VERIFY], the Step 1 issues (bars, 204(c) / 204(g),
  // divorce exception, visa availability, age-out), Section 3.6's
  // litigation-risk residence posture, Section 3.9's children within a year
  // of 21, Section 3.10's EOIR-posture flag, an I-485 that cannot be filed
  // yet, a declaration, cover letter or form PDF that was not built, a QA
  // gate that did not run as the firm's skill, the review's escalations and
  // a DO NOT FILE verdict, a built form whose edition was not confirmed
  // current in the run (Section 2: "A superseded edition gets rejected"),
  // every [VERIFY CITE] authority in the cover letter or memo (Hard Rule 3),
  // a built memo (Step 9: "flag every citation for verification"), and the
  // blocking master action checklist items. After an out-of-scope stop the
  // documents, forms and QA gates were never due, so their absence is not
  // flagged.
  extractEscalationFlags: (output) => {
    const flags: string[] = output.safetyConflictAnd1367Flags.map((f) => `${f.type} FLAG: ${f.detail}`);
    const snapshot = output.packetSnapshot;
    const posture = snapshot.postureDeterminations;
    const inScope = snapshot.scope !== "abused_child_out_of_scope" && snapshot.scope !== "abused_parent_out_of_scope";
    if (!inScope) {
      flags.push(`Out of scope for this skill (${snapshot.scope.replace(/_/g, " ")}): ${snapshot.scopeNote}`);
    }
    flags.push(...snapshot.clientAndAttorneyQuestionList.map((q) => `Client and attorney question: ${q}`));
    for (const check of output.runTimeVerificationNote) {
      if (!check.verified) flags.push(`ATTORNEY: VERIFY ${check.item}: ${check.finding}`);
    }
    flags.push(...output.elementScorecard.issuesSurfaced.map((issue) => `Triage issue: ${issue}`));
    if (posture.residenceWithAbuserDuringMarriage.resided === false) {
      flags.push(
        "No residence with the abuser during the marriage is shown (element 6): if the only shared residence falls outside the marriage, this is a litigation-risk posture (SKILL.md Section 3.6)"
      );
    }
    for (const child of posture.derivativeChildren) {
      if (child.withinOneYearOf21) {
        flags.push(`Age-out risk: ${child.name} (age at intended filing date: ${child.ageAtIntendedFilingDate}) is within a year of 21`);
      }
    }
    if (posture.removalPosture === "in_proceedings" || posture.removalPosture === "detained") {
      flags.push(
        `Removal posture ${posture.removalPosture.replace(/_/g, " ")}: [ATTORNEY: confirm current EOIR posture on continuances, administrative closure, and DHS's position on dismissal in this jurisdiction, and confirm jurisdiction over the I-485.]`
      );
    }
    if (inScope) {
      const i485 = output.formI485AnswerTableAndFilledPdf;
      if (!i485.canBeFiledNow) flags.push(`I-485 cannot be filed yet${i485.whyNotYet ? `: ${i485.whyNotYet}` : ""}`);
      if (!output.declaration.generatedDeclarationDocumentId) {
        flags.push(`No declaration was generated${output.declaration.notGeneratedReason ? `: ${output.declaration.notGeneratedReason}` : ""}`);
      }
      if (!output.coverLetter.generatedCoverLetterDocumentId) {
        flags.push(`No cover letter was generated${output.coverLetter.notGeneratedReason ? `: ${output.coverLetter.notGeneratedReason}` : ""}`);
      }
      const forms = [
        ["I-360", output.formI360AnswerTableAndFilledPdf],
        ["I-485", i485],
        ["I-765", output.formI765AnswerTableAndFilledPdf],
      ] as const;
      for (const [form, item] of forms) {
        if (!snapshot.formsBuilt.includes(form)) continue;
        if (!item.generatedFilledPdfDocumentId) flags.push(`Form ${form} PDF fill pending: ${item.pdfFillNote}`);
        if (!item.editionVerified) {
          flags.push(
            `[ATTORNEY: VERIFY] Form ${form} edition ${item.editionUsed || "(none recorded)"} was not confirmed current on uscis.gov in this run; a superseded edition gets rejected (SKILL.md Section 2)`
          );
        }
      }
    }
    // Hard Rule 3: authority neither in Section 3 nor retrieved in the run is
    // [VERIFY CITE]; the cover letter goes to USCIS with the packet.
    const memo = output.legalSupportMemo;
    const unverified = [...output.coverLetter.authoritiesCited, ...(memo?.authorities ?? [])].filter((a) => !a.verified);
    if (unverified.length > 0) {
      flags.push(
        `[VERIFY CITE] ${unverified.length} citation(s) not from SKILL.md Section 3 or retrieved in this run: ${[...new Set(unverified.map((a) => a.citation))].join("; ")}. Confirm each before filing`
      );
    }
    if (memo) {
      if (!memo.generatedLegalMemoDocumentId) flags.push("The legal support memo was planned but not generated");
      if (memo.authorities.length > 0) {
        flags.push(
          `Legal support memo: verify all ${memo.authorities.length} of its citations before relying on it, verified in this run or not (SKILL.md Section 4 Step 9)`
        );
      }
    }
    const qa = output.vawaPacketReviewAndOrthographyCheckReports;
    const qaNotes = qa.qaGateNotes.length > 0 ? ` (QA gate notes: ${qa.qaGateNotes.join("; ")})` : "";
    const review = qa.vawaPacketReviewReport;
    if (review) {
      if (!qa.vawaPacketReviewSkillLoaded) {
        flags.push(`vawa-packet-review could not be loaded; the review in this report is the build's own check: run vawa-packet-review on this matter before filing${qaNotes}`);
      }
      flags.push(...review.escalationFlags);
      if (review.verdictAndDefectCounts.verdict === "DO_NOT_FILE") {
        flags.push(`vawa-packet-review verdict DO NOT FILE (${review.verdictAndDefectCounts.blockerCount} blocker(s))`);
      }
    } else if (inScope) {
      flags.push(`vawa-packet-review QA gate was not run (SKILL.md Section 4 Step 10): run it on this matter before filing${qaNotes}`);
    }
    if (qa.orthographyCheckReports.length > 0) {
      if (!qa.orthographyCheckSkillLoaded) {
        flags.push(`orthography-check could not be loaded; the pass in this report is the build's own check: run orthography-check on the cover letter and declaration before filing${qaNotes}`);
      }
    } else if (inScope) {
      flags.push(`orthography-check was not run over the cover letter and declaration (SKILL.md Section 4 Step 10)${qaNotes}`);
    }
    flags.push(...output.masterActionChecklist.filter((a) => a.blocking).map((a) => `${a.item} (owner: ${a.owner})`));
    return [...new Set(flags.map((flag) => flag.trim()).filter(Boolean))];
  },
  // fetch_uscis_page: the Section 2 run-time verification (uscis.gov form
  // pages, VAWA filing addresses, fees, Policy Manual Volume 3 Part D, and
  // the Visa Bulletin on travel.state.gov). generate_document and
  // render_and_qa_docx: the declaration, affidavit templates, cover letter
  // and legal memo. list_pdf_form_fields_vawa and fill_pdf_form_vawa (the
  // model sees list_pdf_form_fields and fill_pdf_form): Section 6, the
  // filled I-360, I-485 and I-765, from a blank the attorney uploaded or the
  // current form downloaded from uscis.gov and scanned with ClamAV (6.1), with
  // the preparer and firm details filled from the firm identity
  // (render_and_qa_docx shows the filled pages). The two
  // load_qa_gate_skill_* keys are Section 4 Step 10's QA gates
  // (tools/vawa-packet-build.ts).
  tools: [
    "fetch_uscis_page",
    "generate_document",
    "render_and_qa_docx",
    "list_pdf_form_fields_vawa",
    "fill_pdf_form_vawa",
    "load_qa_gate_skill_vawa_packet_review",
    "load_qa_gate_skill_orthography_check",
    "search_library",
    "lookup_library_citation",
    "read_library_document",
  ],
  // Hard Rule 3 and Sections 3.4 and 3.12 require retrieving and reading
  // authority before relying on it (statute subclauses, the eCFR, the Federal
  // Register, the Foreign Affairs Manual), and Section 2 asks whether any
  // litigation has set aside PA-2025-33; none of that is on fetch_uscis_page's
  // three hosts. The SKILL.md does not restrict those sources, so search
  // stays open; web_fetch opens the legal-authority hosts in fetch-domains.ts
  // only (the eCFR, govinfo, the Federal Register, fam.state.gov and the
  // courts among them), since the run reads the client's whole file.
  // Fetched pages are capped below the 30000-token default and to five per
  // turn: this run also carries the matter's documents (the blank forms
  // among them), three field listings, rendered pages and two QA skill
  // texts, and the Step 10 gates come last. 20000 rather than bench-memo's
  // 10000, because a statute or regulation page here has to reach the cited
  // subparagraph (Section 3.4: "Retrieve the exact subclause"), not just a
  // caption.
  serverTools: [
    "web_search",
    { name: "web_fetch", maxUses: 5, maxContentTokens: 20_000, allowedDomains: LEGAL_AUTHORITY_FETCH_DOMAINS },
  ],
  // A six-to-ten page declaration, the cover letter and memo each go to
  // generate_document in one turn, and a form fill can carry hundreds of values.
  maxTokens: 128_000,
  // Verification and research, four drafted documents with render and fix
  // passes, three forms listed, filled and checked, two QA gates, then fixes.
  maxIterations: 40,
  needsNote: true,
  notePlaceholder:
    "Case note for Build VAWA packet (optional): which forms to build (I-360 alone, or with I-485 and I-765), the mailing method (courier or USPS), the client's safe mailing address, the intended filing date, any current safety concern, and interview facts not in the uploaded documents. To have specific blank I-360, I-485 or I-765 PDFs filled, upload them to the matter; otherwise the current editions are taken from uscis.gov.",
  applicableCaseTypes: ["vawa"],
});
