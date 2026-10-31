import { z } from "zod";
import { defineSkill } from "./types";

// One "Run-time verification" check: what the skill must confirm on
// uscis.gov before reporting on it, and never from memory. verified is true
// only when a uscis.gov page or PDF read in this run (fetch_uscis_page or
// web_fetch) confirmed it; otherwise the SKILL.md marks the item
// [ATTORNEY: VERIFY].
const liveCheckSchema = z.object({
  verified: z.boolean(),
  finding: z
    .string()
    .describe("What the uscis.gov page states; when not verified, [ATTORNEY: VERIFY] and why (fetch failed, page silent)"),
  url: z.string().optional().describe("The page that confirmed it, exactly as fetched"),
  checkedAt: z
    .string()
    .optional()
    .describe("When it was fetched, from the fetch_uscis_page result header or the web_fetch result"),
});
type LiveCheck = z.infer<typeof liveCheckSchema>;

// Report items 4-11 review the packet itself. The "Scope" paragraph says to
// "say so and stop" on an out-of-scope packet, so after that stop they were
// never reviewed and the report omits them rather than rate what nobody read.
const OMITTED_ONLY_OUT_OF_SCOPE =
  "Omitted only when thresholdDetermination.withinReviewScope is false (the review stopped at the scope); required otherwise";

// One section H filing-mechanics item, rated as report item 10 rates it.
const mechanicsItemSchema = z.object({
  status: z.enum(["clear", "fix"]),
  finding: z.string(),
});

// One section D proof item, rated as report item 6 rates it.
const proofSchema = z.object({
  rating: z.enum(["sufficient", "thin", "missing"]),
  finding: z.string(),
  whatWouldCureIt: z.string(),
});

// One section F exposure area, rated as report item 8 rates it.
const exposureSchema = z.object({
  status: z.enum(["not_triggered", "needs_confirmation", "escalate"]),
  notes: z.string(),
});

// Mirrors skills-content/i90-packet-review/SKILL.md "Report format", items
// 1-13, with the "What to review" sections (A-I) each item summarizes and
// the "Run-time verification" checks nested under item 10, the item that
// reports on edition, fee, channel and address. "Before anything" feeds the
// snapshot: unconfirmed case facts and missing packet components are both
// listed as not provided, and an out-of-scope packet (its "Scope" paragraph)
// is recorded in the threshold determination, where the review stops and
// items 4-11 are omitted.
export const i90PacketReviewOutputSchema = z.object({
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
      .describe(
        "False for name or biographic change, DHS or applicant data error, age 14 replacement, commuter, automatic conversion, or legacy AR-3, AR-103 or I-151 cards. The review then stops: say so in basis and omit reasonForFiling through authoritiesToReview"
      ),
    mayUseI90: z.boolean().nullable().describe("null when not determined, including after a scope stop"),
    basis: z.string(),
    thresholdTests: z
      .array(
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
      )
      .describe("Section A's tests; empty after a scope stop"),
  }),
  reasonForFiling: z
    .object({
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
    })
    .optional()
    .describe(OMITTED_ONLY_OUT_OF_SCOPE),
  formFindings: z
    .array(
      z.object({
        part: z.enum(["Part_1", "Part_2", "Part_3", "Part_4", "Part_5", "Part_6", "Part_7", "Part_8"]),
        issue: z.string(),
        location: z.string(),
        recommendedEdit: z.string(),
      })
    )
    .optional()
    .describe(OMITTED_ONLY_OUT_OF_SCOPE),
  identityAndStatusProof: z
    .object({
      identity: proofSchema,
      status: proofSchema.extend({
        coverLetterSaysStatusRestsOnSecondaryEvidence: z
          .boolean()
          .optional()
          .describe("Only when the card is unavailable and status is carried by secondary evidence"),
      }),
      ground: proofSchema.extend({
        mutilatedCard: z
          .object({
            originalSubmitted: z.boolean().nullable(),
            copyMadeForFileFirst: z.boolean().nullable(),
          })
          .optional()
          .describe("Only when the reason is a mutilated card"),
      }),
    })
    .optional()
    .describe(OMITTED_ONLY_OUT_OF_SCOPE),
  evidenceAssessment: z
    .object({
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
    })
    .optional()
    .describe(OMITTED_ONLY_OUT_OF_SCOPE),
  exposureScreen: z
    .object({
      abandonmentOfResidence: exposureSchema,
      criminalHistory: exposureSchema,
      removalOrRescission: exposureSchema,
      filingHold: z.object({
        holdUntilAttorneyClears: z.boolean(),
        note: z.string(),
      }),
    })
    .optional()
    .describe(OMITTED_ONLY_OUT_OF_SCOPE),
  consistencyLog: z
    .array(
      z.object({
        discrepancy: z.string(),
        whereItAppears: z.string(),
      })
    )
    .optional()
    .describe(OMITTED_ONLY_OUT_OF_SCOPE),
  filingMechanics: z
    .object({
      edition: mechanicsItemSchema,
      fee: mechanicsItemSchema,
      channel: mechanicsItemSchema,
      address: mechanicsItemSchema,
      assembly: mechanicsItemSchema,
      deliverability: mechanicsItemSchema,
      postFilingCalendarItems: mechanicsItemSchema,
      runTimeVerification: z.object({
        i90AndG28EditionDates: liveCheckSchema.describe("Current editions and whether older editions are still accepted"),
        filingFees: liveCheckSchema.describe("Online and paper fees, and whether biometrics is billed separately"),
        feeExemptReasons: liveCheckSchema.describe("Which reasons are fee exempt and on what conditions"),
        feeWaiverI912Availability: liveCheckSchema,
        directFilingAddress: liveCheckSchema.describe("USPS and courier addresses"),
        onlineFilingForSelectedReason: liveCheckSchema,
        automaticExtensionPeriod: liveCheckSchema.describe("The extension the receipt notice gives an expired card"),
        processingTimes: liveCheckSchema,
      }),
    })
    .optional()
    .describe(OMITTED_ONLY_OUT_OF_SCOPE),
  authoritiesToReview: z
    .array(
      z.object({
        citation: z.string(),
        why: z.string(),
        verified: z.boolean(),
        url: z.string().optional().describe("The page the authority was confirmed on, exactly as fetched"),
      })
    )
    .optional()
    .describe(OMITTED_ONLY_OUT_OF_SCOPE),
  escalationFlags: z.array(z.string()),
  prioritizedEditChecklist: z.array(
    z.object({
      priority: z.enum(["blocking", "strongly_recommended", "optional"]),
      item: z.string(),
    })
  ),
});
export type I90PacketReviewOutput = z.infer<typeof i90PacketReviewOutputSchema>;

type RunTimeCheckKey = keyof NonNullable<I90PacketReviewOutput["filingMechanics"]>["runTimeVerification"];

const RUN_TIME_CHECK_LABELS: Record<RunTimeCheckKey, string> = {
  i90AndG28EditionDates: "I-90 and G-28 edition dates",
  filingFees: "filing fees",
  feeExemptReasons: "fee exempt reasons",
  feeWaiverI912Availability: "Form I-912 availability",
  directFilingAddress: "direct filing address",
  onlineFilingForSelectedReason: "online filing for the selected reason",
  automaticExtensionPeriod: "automatic extension period",
  processingTimes: "processing times",
};

// Report items 4-11, the ones a scope stop omits, in report order.
const REVIEW_ITEMS: [keyof I90PacketReviewOutput, string][] = [
  ["reasonForFiling", "4 (reason for filing)"],
  ["formFindings", "5 (form findings)"],
  ["identityAndStatusProof", "6 (identity and status proof)"],
  ["evidenceAssessment", "7 (evidence assessment)"],
  ["exposureScreen", "8 (exposure screen)"],
  ["consistencyLog", "9 (consistency log)"],
  ["filingMechanics", "10 (filing mechanics)"],
  ["authoritiesToReview", "11 (authorities to review)"],
];

// Item 12 is the SKILL.md's escalation list. Also routed to the attorney:
// the blocking issues ("Nothing files until these clear"), a threshold or
// scope stop, any exposure area marked escalate or still needing
// confirmation (item 2 blocks on "unscreened abandonment or criminal
// exposure"; the guardrails send all three areas to the supervising
// attorney), a filing hold (section F: "should be filed at all until the
// attorney clears these"), and every fee, edition, address or extension
// check the run could not confirm on uscis.gov ("mark the item
// [ATTORNEY: VERIFY]"). After a scope stop items 4-11 were never due, so
// nothing is derived from them; within scope, a missing one is flagged.
function i90PacketReviewEscalationFlags(output: I90PacketReviewOutput): string[] {
  const { thresholdDetermination: threshold, exposureScreen: exposure, filingMechanics: mechanics } = output;
  const flags = [...output.escalationFlags, ...output.blockingIssues.map((issue) => `BLOCKING: ${issue}`)];

  if (!threshold.withinReviewScope) {
    flags.push(`Outside the I-90 review scope: ${threshold.basis}`);
    return [...new Set(flags)];
  }
  if (threshold.mayUseI90 !== true) {
    const verdict = threshold.mayUseI90 === false ? "Client may not use" : "Not confirmed the client may use";
    flags.push(`${verdict} Form I-90: ${threshold.basis}`);
  }
  for (const [key, label] of REVIEW_ITEMS) {
    if (output[key] === undefined) flags.push(`Report item ${label} is missing although the packet is within the review scope`);
  }
  if (exposure) {
    for (const [label, area] of [
      ["abandonment of residence", exposure.abandonmentOfResidence],
      ["criminal history", exposure.criminalHistory],
      ["removal or rescission", exposure.removalOrRescission],
    ] as const) {
      if (area.status === "escalate") flags.push(`Escalate, ${label}: ${area.notes}`);
      else if (area.status === "needs_confirmation") flags.push(`Unscreened, ${label}: ${area.notes}`);
    }
    if (exposure.filingHold.holdUntilAttorneyClears) {
      flags.push(`Hold filing until the attorney clears exposure: ${exposure.filingHold.note}`);
    }
  }
  if (mechanics) {
    for (const [key, check] of Object.entries(mechanics.runTimeVerification) as [RunTimeCheckKey, LiveCheck][]) {
      if (check.verified) continue;
      const finding = check.finding.replace(/^\s*\[ATTORNEY: VERIFY\]\s*/i, "");
      flags.push(`[ATTORNEY: VERIFY] ${RUN_TIME_CHECK_LABELS[key]}: ${finding}`);
    }
  }
  return [...new Set(flags)];
}

export const i90PacketReview = defineSkill({
  name: "i90-packet-review",
  label: "Run I-90 packet review",
  category: "uscis",
  kind: "review",
  description:
    "Reviews a Form I-90 green card renewal or replacement packet before filing and returns a QA report with blocking issues, exposure screen and a prioritized edit checklist.",
  outputSchema: i90PacketReviewOutputSchema,
  extractEscalationFlags: i90PacketReviewEscalationFlags,
  // "Run-time verification": fees, edition dates, the filing address, the
  // extension period and processing times are checked on uscis.gov, never
  // from memory. Report-only, so no generator. fetch_uscis_page reads the
  // HTML pages (form page, filing addresses) into the verification log, but
  // not everything the checks need: the I-90 page sends the fee to the fee
  // schedule page, whose HTML carries no per-form amount; the G-1055 fee
  // schedule document and the form instructions are PDFs, which it refuses;
  // and the text it returns has no links to follow. So web_search finds those
  // documents and web_fetch reads them, PDFs included, both limited to
  // uscis.gov, the only source the SKILL.md names (subdomains included).
  // Processing times are on egov.uscis.gov, which fetch_uscis_page reaches,
  // but the page is built by script, so its fetched text may not carry the
  // times, and that check can come back [ATTORNEY: VERIFY] on any run.
  tools: ["fetch_uscis_page", "search_library", "lookup_library_citation", "read_library_document"],
  serverTools: [
    { name: "web_search", allowedDomains: ["uscis.gov"] },
    { name: "web_fetch", allowedDomains: ["uscis.gov"] },
  ],
  // Eight live checks across several uscis.gov pages and PDFs (form page,
  // instructions, fee schedule, filing addresses, processing times), each a
  // tool round trip and some a search before the fetch, then the report:
  // more than the report-only default of 12.
  maxIterations: 20,
  needsNote: true,
  notePlaceholder:
    "Case note for Run I-90 packet review (optional): whether the client is inside the United States, travel history since becoming an LPR, any arrest, charge, citation or conviction, any removal, rescission or prior filing history, any filed or planned N-400, and what happened to the card, if not in the uploaded documents.",
  applicableCaseTypes: ["i90"],
});
