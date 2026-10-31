import { z } from "zod";
import { defineSkill } from "./types";

// The build_fee_packet tool (tool key build_fee_packet, implemented in
// ../tools/asylum-fee-proof-packet.ts) runs the multi-tenant copy of the
// firm's packet script,
// src/services/docx-generator/templates/asylum-fee-proof-packet/fee_packet.py.
// These schemas live here so the skill's generator contract and its report
// schema stay in one file; neither is a submit_report schema.

const FORUMS = ["IC", "BIA"] as const;
const FEE_KINDS = ["annual", "initial"] as const;
const FILINGS = ["ECAS", "paper"] as const;
const SIGNATURE_MODES = ["image", "conformed", "blank"] as const;
// The config fields that replace the script's default wording (SKILL.md Step 4 table).
const WORDING_OVERRIDE_FIELDS = ["ic_comes_now", "ic_wherefore", "bia_intro", "bia_paragraphs", "bia_wherefore"] as const;

// What the model writes: the SKILL.md Step 4 config, field for field, except
// what the server supplies. The receipt and the order are named by the matter
// document that holds them (receipt_document, order.document) instead of the
// receipt_pdf / order.pdf paths; out_dir, signature and signature_png are
// gone; and the counsel block and signer (the script's FIRM dict in the
// firm's copy) are deliberately absent: the server fills them from the firm
// identity, so the model cannot put another firm or another person's name or
// signature on a filing (unknown keys are stripped by the parse).
export const asylumFeeProofPacketContentSchema = z.object({
  forum: z.enum(FORUMS).describe('"IC" (Immigration Court) or "BIA" (Board of Immigration Appeals)'),
  name_caption: z.string().min(1).describe('Caption form: "SURNAME, Given Names"'),
  name_full: z.string().min(1).describe('Text form, normal order: "Given Names Surname"'),
  a_number: z.string().min(1).describe("A###-###-### (201-504-127 and A#201-504-127 are accepted)"),
  fee_kind: z.enum(FEE_KINDS).describe('"annual" or "initial", from the receipt'),
  receipt_document: z
    .string()
    .min(1)
    .describe(
      "The matter document that is the EOIR Payment Portal receipt PDF (Tab A): its document id, or its file name exactly as the document's label shows it"
    ),
  tracking_id: z.string().min(1).describe("From the receipt"),
  pay_date: z.string().min(1).describe('From the receipt, e.g. "September 29, 2026"'),
  amount: z.string().min(1).describe('From the receipt, e.g. "$100.00"'),
  // Optional here, required in the spec: SKILL.md Step 3 dates the packet
  // today, and the model has no clock, so the tool fills it when left out.
  sign_date: z
    .string()
    .min(1)
    .optional()
    .describe(
      "IC: the certificate of service date (the IC letter is undated). BIA: the Date and Dated lines and the certificate. Leave out to date the packet today (the app fills in the date); set it only when the attorney names another signing date"
    ),
  file_stem: z
    .string()
    .min(1)
    .max(120)
    .describe('File name without extension: "ANNUAL ASYLUM FEE SURNAME YYYY" or "I-589 FILING FEE SURNAME YYYY", YYYY the payment year'),
  court_city: z
    .string()
    .optional()
    .describe(
      'IC only: heading city line of the Immigration Court hearing the case, in the form "CITY, STATE", from the matter\'s court or the note (when neither names it, the firm\'s primary court in the practice profile, listed under defaultsUsed). Left out, the heading reads HOUSTON, TEXAS, the skill\'s default'
    ),
  judge: z.string().optional().describe('IC only: "Last, First"; an empty string prints a blank line'),
  next_hearing: z
    .string()
    .optional()
    .describe('IC only: "Month D, YYYY at H:MM AM" when the time is known; an empty string prints a blank line'),
  order: z
    .object({
      date: z.string().min(1),
      deadline: z.string().optional(),
      document: z
        .string()
        .optional()
        .describe(
          "The matter document that is the whole order as issued (Tab B): its document id, or its file name exactly as its label shows it. Leave out when the order is not on the matter"
        ),
    })
    .nullable()
    .optional()
    .describe("The order that directed payment, or null when there is none"),
  filing: z.enum(FILINGS).optional().describe('"ECAS" (default) or "paper"'),
  detained: z.boolean().optional().describe("true prints DETAINED instead of NON-DETAINED"),
  proceedings: z.string().optional().describe('Caption line, default "In Removal Proceedings"'),
  within_30_days: z
    .boolean()
    .optional()
    .describe("BIA, no-order case: adds the paid-within-30-days paragraph; only when the attorney confirmed it"),
  dhs_lines: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Lines replacing the DHS service block. Left out, the certificate serves the skill's Houston office (IC: Office of the Principal Legal Advisor - HOU; BIA: DHS/ICE Office of Chief Counsel - HOU), which is right only for a case before or from the Houston Immigration Court. For any other court, take the office and address from the attorney's note or the case documents, never from memory"
    ),
  ic_comes_now: z.string().optional().describe('Replacement text after "COMES NOW, Name"'),
  ic_wherefore: z.string().optional().describe('Replacement text after "WHEREFORE,"'),
  bia_intro: z.string().optional().describe("Replacement BIA intro"),
  bia_paragraphs: z.array(z.string().min(1)).optional().describe("Replacement BIA numbered paragraphs"),
  bia_wherefore: z.string().optional().describe('Replacement text after "WHEREFORE"'),
  signer_attorney_id: z
    .string()
    .optional()
    .describe(
      "id of the roster entry (FIRM IDENTITY section) who signs and serves, when the attorney's note names someone other than the default signer (never on the strength of the matter's documents alone); omit to use the default signer"
    ),
  wet_signature: z
    .boolean()
    .optional()
    .describe(
      "true leaves the signature lines blank for an ink signature instead of the signer's signature image or /s/ line; only when the attorney's note asks for it"
    ),
});
export type AsylumFeeProofPacketContent = z.infer<typeof asylumFeeProofPacketContentSchema>;

// What the server adds from the tenant's firm identity, in place of the
// script's hard-coded FIRM dict. firm: the counsel block and the IC signature
// block (fax only when on file). signer: name (the person who serves, and the
// /s/ line), name_line (as printed in the counsel and signature blocks, with
// "Esq." for an attorney), credential_lines (under the name in the BIA
// signature block: the bar line, or an accredited representative's title and
// EOIR ID), capacity_line, and signature: "image" (signature_image, a bare
// file name the server writes next to the config), "conformed" (/s/ name, when
// no image is on file) or "blank" (an ink signature).
export const asylumFeeProofPacketFirmFieldsSchema = z.object({
  firm: z.object({
    name: z.string().min(1),
    address_lines: z.array(z.string().min(1)).min(1),
    phone: z.string().min(1),
    fax: z.string().optional(),
    email: z.string().min(1),
  }),
  signer: z.object({
    name: z.string().min(1),
    name_line: z.string().min(1),
    credential_lines: z.array(z.string().min(1)),
    capacity_line: z.string().min(1),
    signature: z.enum(SIGNATURE_MODES),
    signature_image: z.string().optional(),
  }),
});

// The complete config.json the script reads: the content with the matter
// documents replaced by the bare file names the server writes next to the
// config (receipt_pdf, order.pdf), plus the firm fields.
export const asylumFeeProofPacketSpecSchema = asylumFeeProofPacketContentSchema
  .omit({ receipt_document: true, order: true, signer_attorney_id: true, wet_signature: true })
  .extend({
    sign_date: z.string().min(1),
    receipt_pdf: z.string().min(1),
    order: z
      .object({ date: z.string().min(1), deadline: z.string().optional(), pdf: z.string().optional() })
      .nullable(),
    ...asylumFeeProofPacketFirmFieldsSchema.shape,
  });
export type AsylumFeeProofPacketSpec = z.infer<typeof asylumFeeProofPacketSpecSchema>;

// Mirrors skills-content/asylum-fee-proof-packet/SKILL.md "Step 4. Write the
// config and build", "Step 5. Check before delivering" and "Step 6. Deliver"
// (the output steps docs/ADDING_A_SKILL.md section 7 names for this skill).
// Step 4 is the config the packet was built with (the SKILL.md table's fields,
// in its order; the receipt and order as the matter documents used). Step 5
// is the build report (one property per row of the "Report field | Expected"
// table) and the "Then look at every page" and "Also" checks. Step 6 is the
// delivery: the two generated documents and the note's items. The packet
// itself is the generated PDF and Word file, never text in the report.
export const asylumFeeProofPacketOutputSchema = z.object({
  writeTheConfigAndBuild: z.object({
    forum: z
      .enum(FORUMS)
      .nullable()
      .describe("null only when the forum could not be settled from the note and the files, so no packet was built"),
    nameCaption: z.string(),
    nameFull: z.string(),
    aNumber: z.string(),
    feeKind: z.enum(FEE_KINDS).nullable().describe("From the receipt; null when no receipt could be read"),
    receiptDocument: z.string().describe("File name of the matter document used as the receipt; empty when none"),
    trackingId: z.string(),
    payDate: z.string(),
    amount: z.string(),
    signDate: z
      .string()
      .describe("The signing date printed: sign_date as given, or the date build_fee_packet filled in when it was left out"),
    fileStem: z.string(),
    courtCity: z.string().optional().describe("IC only: the heading city line printed (HOUSTON, TEXAS when left at the default)"),
    judge: z.string().optional().describe("IC only; empty when printed as a blank line"),
    nextHearing: z.string().optional().describe("IC only; empty when printed as a blank line"),
    order: z
      .object({
        date: z.string(),
        deadline: z.string().optional(),
        orderDocument: z.string().optional().describe("File name of the matter document attached behind Tab B; absent when not attached"),
      })
      .nullable(),
    filing: z.enum(FILINGS),
    detained: z.boolean(),
    proceedings: z.string().optional(),
    within30Days: z.boolean().optional().describe("BIA no-order case only"),
    signature: z.enum(SIGNATURE_MODES).describe("What the app printed on the signature lines"),
    dhsLines: z.array(z.string()).optional().describe("The dhs_lines passed; absent when the skill's Houston service block was printed"),
    wordingOverrides: z
      .array(z.object({ field: z.enum(WORDING_OVERRIDE_FIELDS), reason: z.string() }))
      .describe("Override fields used, and why (e.g. the order directs something the default BIA paragraph 1 does not say)"),
  }),
  checkBeforeDelivering: z.object({
    buildReport: z.object({
      pageNumberProblems: z.array(z.string()),
      specialCharacters: z.array(z.string()),
      aNumberMentions: z.object({
        found: z.number().int().min(0),
        expected: z.number().int().min(0).describe("IC 3, BIA 4"),
      }),
      trackingIdInLetter: z.boolean(),
      pages: z.array(
        z.object({
          page: z.number().int().min(1),
          part: z.string(),
          number: z.string().describe("The printed page number; empty when the page is unnumbered"),
        })
      ),
      index: z.array(z.object({ entry: z.string(), label: z.string() })),
      warnings: z.array(
        z.object({
          warning: z.string().describe("The build report's warning, as printed"),
          handling: z.enum(["fixed", "passed_to_attorney"]),
          note: z.string(),
        })
      ),
    }),
    pageReview: z.object({
      everyPageViewed: z.boolean(),
      partsChecked: z.array(
        z.object({
          part: z.enum(["cover", "letter", "tab_pages", "exhibit_pages", "certificate_of_service"]),
          ok: z.boolean(),
          note: z.string(),
        })
      ),
      exhibitPageNumberStamps: z
        .string()
        .describe("Whether each exhibit page's number sits clear of the exhibit's text, and how that was judged"),
    }),
    faxCheck: z.object({
      firmFax: z.string().describe("The firm's fax as printed; empty when none is on file"),
      mentionsFound: z.number().int().min(0),
      mentionsExpected: z.number().int().min(0).describe("2 when a fax is on file (both counsel blocks, or IC counsel and signature blocks); 0 without one"),
      retiredNumbersPrinted: z.number().int().min(0).describe("Must be 0"),
    }),
    receiptComparison: z.array(
      z.object({
        field: z.enum(["a_number", "tracking_id", "pay_date", "amount"]),
        receipt: z.string(),
        packet: z.string(),
        matches: z.boolean(),
      })
    ),
    orderCheck: z
      .object({
        orderDate: z.string(),
        directs: z.array(z.string()).describe("What the order directs: pay the fee, file the receipt, file a copy of the order"),
        deadline: z.string().optional(),
        statesAmount: z.boolean().nullable(),
        readFromImages: z.boolean().describe("true when the order is a scan and was read from its page images"),
        packetWordingMatches: z.boolean(),
        note: z.string(),
      })
      .optional()
      .describe("Only when there is an order"),
    deadlines: z.object({
      deadline: z.string().optional(),
      assessment: z
        .string()
        .describe(
          "Whether the filing will be received in time, judged from today's date as build_fee_packet reports it, and the delivery advice (overnight, or ECAS)"
        ),
    }),
  }),
  deliver: z.object({
    generatedPacketPdfDocumentId: z
      .string()
      .describe("document_id of the filing-ready PDF returned by build_fee_packet; empty if no packet could be built"),
    generatedPacketWordDocumentId: z
      .string()
      .describe("document_id of the editable Word file returned by build_fee_packet; empty if no packet could be built"),
    packetContents: z.array(z.string()).describe("What the packet contains, in page order"),
    leftBlank: z.array(z.string()).describe("Anything printed as a blank line (judge, next hearing)"),
    defaultsUsed: z
      .array(z.string())
      .describe(
        "Defaults applied: the signing date the app filled in, the court heading or DHS service block left at the skill's Houston default, a court taken from the practice profile, ECAS, non-detained"
      ),
    clientNameSource: z.string().describe("Where the client's name came from, since the receipt carries none"),
    needsAction: z
      .array(z.string())
      .describe(
        "Anything that needs action before filing: order not attached, deadline, delivery (overnight, or ECAS), a DHS service block or court heading that may not match the court handling the case, and, in an IC case with no order, a payment that appears to have come more than 30 days after the anniversary (the receipt warns late payment will likely lead to pretermission)"
      ),
    questionsForTheAttorney: z
      .array(z.string())
      .describe("Step 3 questions the case note and the files did not answer, including an A-number that does not match the receipt"),
    signerReview: z.object({
      signerName: z.string(),
      inkSignatureNeeded: z.boolean().describe("true for a paper filing"),
      note: z.string().describe("That the signer must review the packet before filing, since the signature certifies it was read"),
    }),
  }),
});
export type AsylumFeeProofPacketOutput = z.infer<typeof asylumFeeProofPacketOutputSchema>;

export const asylumFeeProofPacket = defineSkill({
  name: "asylum-fee-proof-packet",
  label: "Build asylum fee proof packet",
  category: "eoir",
  kind: "build",
  description:
    "Builds the proof of payment packet for an EOIR asylum fee from the EOIR Payment Portal receipt, as a filing-ready PDF and an editable Word file, for the Immigration Court or the Board.",
  outputSchema: asylumFeeProofPacketOutputSchema,
  // Step 5's checks that failed and were not fixed go to the attorney with
  // the items Step 6's note routes there. The count, page review and order
  // checks only mean something for a built packet, so they are skipped
  // when none was generated (that is flagged on its own).
  extractEscalationFlags: (output) => {
    const { buildReport, pageReview, faxCheck, receiptComparison, orderCheck } = output.checkBeforeDelivering;
    const { deliver } = output;
    const built = deliver.generatedPacketPdfDocumentId !== "";
    const builtPacketChecks = built
      ? [
          ...(buildReport.aNumberMentions.found !== buildReport.aNumberMentions.expected
            ? [
                `A-number mentions in the packet: ${buildReport.aNumberMentions.found}, expected ${buildReport.aNumberMentions.expected} (IC 3, BIA 4).`,
              ]
            : []),
          ...(buildReport.trackingIdInLetter ? [] : ["The payment tracking ID is missing from the letter."]),
          ...(faxCheck.mentionsFound !== faxCheck.mentionsExpected
            ? [`Firm fax mentions in the packet: ${faxCheck.mentionsFound}, expected ${faxCheck.mentionsExpected}.`]
            : []),
          ...(pageReview.everyPageViewed ? [] : ["Not every page of the packet was viewed before delivery."]),
          ...pageReview.partsChecked
            .filter((p) => !p.ok)
            .map((p) => `Page review problem (${p.part.replace(/_/g, " ")}): ${p.note}`),
          ...(orderCheck && !orderCheck.packetWordingMatches
            ? [`The packet's wording does not match the order: ${orderCheck.note}`]
            : []),
          ...(deliver.generatedPacketWordDocumentId ? [] : ["The editable Word file was not stored with the PDF."]),
        ]
      : [];
    const flags = [
      ...deliver.questionsForTheAttorney,
      ...deliver.needsAction,
      ...buildReport.warnings.filter((w) => w.handling === "passed_to_attorney").map((w) => w.warning),
      ...receiptComparison
        .filter((r) => !r.matches)
        .map((r) => `Receipt mismatch on ${r.field}: receipt shows "${r.receipt}", packet shows "${r.packet}".`),
      ...buildReport.pageNumberProblems.map((p) => `Page number problem: ${p}`),
      ...(buildReport.specialCharacters.length > 0
        ? [`Special characters in the generated pages: ${buildReport.specialCharacters.join(", ")}`]
        : []),
      ...(faxCheck.retiredNumbersPrinted > 0 ? ["A retired fax number is printed in the packet."] : []),
      ...builtPacketChecks,
      ...(deliver.signerReview.inkSignatureNeeded
        ? [`Paper filing: ${deliver.signerReview.signerName} must sign the printed copy in ink.`]
        : []),
      ...(built ? [] : ["No filing packet was generated in this run."]),
    ];
    return [...new Set(flags)];
  },
  tools: ["build_fee_packet", "render_and_qa_docx"],
  maxIterations: 16,
  needsNote: true,
  notePlaceholder:
    "Case note for Build asylum fee proof packet (optional): A-number and client name, Immigration Court or BIA, the order date and deadline if an order directed payment, for court cases the Immigration Judge and next hearing date and time, ECAS or paper, detained or not, and the Immigration Court handling the case with the DHS office to serve (the skill defaults to the Houston court and its DHS office).",
  applicableCaseTypes: ["asylum_defensive", "withholding_cat"],
});
