import { z } from "zod";
import { defineSkill } from "./types";

// The generate_docx tool (tool key generate_docx_eoir_pleadings, implemented
// in ../tools/eoir-written-pleadings.ts) runs the multi-tenant copy of the
// generator embedded in skills-content/eoir-written-pleadings/SKILL.md
// ("Generator script (save as make_pleadings.py)"),
// src/services/docx-generator/templates/eoir-written-pleadings/make_pleadings.py.
// These schemas live here so the skill's generator contract and its report
// schema stay in one file; only eoirWrittenPleadingsOutputSchema is a
// submit_report schema.

export const EOIR_PLEADINGS_PRONOUNS = ["he", "she"] as const;
const SIGNATURE_MODES = ["image", "conformed", "blank"] as const;

// "The A number is written with hyphens (A216-842-561)."
const A_NUMBER = /^A\d{2,3}-\d{3}-\d{3}$/;
// "SURNAME in capitals followed by a comma and the given names": no
// lowercase letter before the comma.
const NAME_CAPTION = /^[^,a-z]+, \S[^,]*$/;
// An INA section as the script prints it after "INA" and the section mark:
// digits, an optional letter, then parenthesized subsections (237(a)(1)(B),
// 240A(b), 212(h)). The script prints "INA" and the section mark itself, so a
// value that already carries them would print them twice.
const INA_SECTION = /^\d{3}[A-Z]?(\([A-Za-z0-9]+\))*$/;
// Step 4's dates, "Month D, YYYY" ("written out, e.g. September 10, 2026").
const WRITTEN_DATE_SOURCE =
  "(January|February|March|April|May|June|July|August|September|October|November|December) ([1-9]|[12][0-9]|3[01]), [0-9]{4}";
const WRITTEN_DATE = new RegExp(`^${WRITTEN_DATE_SOURCE}$`);
// A date the record does not give (the NTA's filing date before the docket
// is checked, an illegible service date) is printed as a bracketed
// placeholder such as "[CONFIRM: date filed]" for the attorney to fill,
// never guessed.
const PLACEHOLDER_SOURCE = "\\[[^\\[\\]]+\\]";
const DATE_OR_PLACEHOLDER = new RegExp(`^(${WRITTEN_DATE_SOURCE}|${PLACEHOLDER_SOURCE})$`);
// Step 1: "use ... 'Not yet scheduled'" when the attorney says no hearing has issued.
const NEXT_HEARING = new RegExp(`^(${WRITTEN_DATE_SOURCE}|Not yet scheduled|${PLACEHOLDER_SOURCE})$`);

// What the model writes: the Step 4 config, key for key, except what the
// server supplies. The counsel block, the signature block and the name in the
// certificate of service (the script's FIRM dict in the firm's copy) are
// deliberately absent: the server fills them from the firm identity, so the
// model cannot put another firm or another person's name or signature on a
// pleading (unknown keys are stripped by the parse). sign_date may be left
// out; the server then dates the packet today (Step 3's default).
export const eoirWrittenPleadingsConfigSchema = z.object({
  name_caption: z
    .string()
    .regex(NAME_CAPTION)
    .describe('"SURNAME, Given Names": surname in capitals, a comma, given names in title case'),
  name_full: z.string().min(1).describe('"Given Names Surname", exactly as the NTA prints the name'),
  a_number: z.string().regex(A_NUMBER).describe('With hyphens, e.g. "A123-456-789"'),
  pronoun: z.enum(EOIR_PLEADINGS_PRONOUNS).describe("Drives the Other relief line and the Certificate of Interpretation"),
  judge: z.string().min(1).describe('"Last, First" as on the docket, or "Not yet assigned"'),
  next_hearing: z
    .string()
    .regex(NEXT_HEARING)
    .describe('"Month D, YYYY" as on the docket, "Not yet scheduled", or a bracketed placeholder'),
  nta_date: z
    .string()
    .regex(DATE_OR_PLACEHOLDER)
    .describe('Date the NTA was signed, "Month D, YYYY" (or a bracketed placeholder)'),
  service_method: z.string().min(1).describe('From the NTA certificate of service, e.g. "regular mail"'),
  nta_served_date: z.string().regex(DATE_OR_PLACEHOLDER).describe('"Month D, YYYY" (or a bracketed placeholder)'),
  service_phrase: z
    .string()
    .min(1)
    .optional()
    .describe('Replaces the service wording in paragraph 1; leave out to print "served on Respondent by [method] on [date]"'),
  nta_filed_date: z
    .string()
    .regex(DATE_OR_PLACEHOLDER)
    .describe('Date the NTA was filed with the Court, "Month D, YYYY" (or a bracketed placeholder)'),
  admit: z.array(z.number().int().min(1)).describe("Numbers of the allegations admitted"),
  deny: z.array(z.number().int().min(1)).describe("Numbers of the allegations denied"),
  charges: z
    .array(
      z.object({
        section: z
          .string()
          .regex(INA_SECTION)
          .describe('The INA section charged, without "INA" or the section mark, e.g. "237(a)(1)(B)"'),
        concede: z.boolean(),
      })
    )
    .min(1),
  country_designated: z
    .string()
    .min(1)
    .nullable()
    .describe('The country named for removal; null checks "declines to designate"'),
  relief: z
    .object({
      termination: z.boolean(),
      asylum: z.boolean(),
      withholding: z.boolean(),
      cat: z.boolean(),
      adjustment: z.boolean(),
      cancellation: z.boolean(),
      waiver: z.boolean(),
      voluntary_departure: z.boolean(),
      other: z.boolean(),
      none: z.boolean(),
    })
    .describe("Representation 6's boxes; true checks the box"),
  cancellation_section: z
    .string()
    .regex(INA_SECTION)
    .optional()
    .describe('Required when relief.cancellation is true, e.g. "240A(b)"'),
  waiver_section: z
    .string()
    .regex(INA_SECTION)
    .optional()
    .describe('Required when relief.waiver is true, e.g. "212(h)"'),
  hours: z.number().positive().describe("Hours estimate for representation 9"),
  language: z.string().min(1).describe('Interpreter language; "English" checks the no-interpreter box instead'),
  // No placeholder here: the script prints this date's year on the pleading
  // declaration's date line.
  sign_date: z
    .string()
    .regex(WRITTEN_DATE)
    .optional()
    .describe('Written out, "Month D, YYYY"; leave out to date the packet today (the app fills in the date)'),
  signer_attorney_id: z
    .string()
    .optional()
    .describe(
      "id of the roster entry (FIRM IDENTITY section) who signs and serves, when the attorney's note names someone other than the default signer (never on the strength of the matter's documents alone); omit to use the default signer"
    ),
  // The firm's script leaves the pleadings' signature line bare for an ink
  // signature, and a run cannot put Step 3's question round to the attorney,
  // so the signer's signature goes on the pleadings only when the note asks.
  apply_signature: z
    .boolean()
    .optional()
    .describe(
      "true puts the signer's signature image (or a /s/ line when none is on file) on the pleadings' signature line; only when the attorney's note asks for the pleadings to be signed. Leave out to keep the firm's bare line for an ink signature"
    ),
});
export type EoirWrittenPleadingsConfig = z.infer<typeof eoirWrittenPleadingsConfigSchema>;

// What the server adds from the tenant's firm identity, in place of the
// script's hard-coded FIRM dict. firm: the counsel block on the cover and the
// firm lines of the signature block (the fax line only when one is on file).
// signer: name (the person who serves, in the certificate of service, and the
// /s/ line), name_line (first line of the counsel block and the signature
// block, with "Esq." for an attorney), credential_lines (under name_line in
// the signature block: the bar line, or an accredited representative's title
// and EOIR ID), and signature: "blank" (the firm's bare signature line, for an
// ink signature: the default), or, when the model passes apply_signature,
// "image" (signature_image, a bare file name the server writes next to the
// config) or "conformed" ("/s/ name" when no image is on file).
export const eoirWrittenPleadingsFirmFieldsSchema = z.object({
  firm: z.object({
    name: z.string().min(1),
    address_lines: z.array(z.string().min(1)).min(1),
    phone: z.string().min(1),
    fax: z.string().min(1).optional(),
    email: z.string().min(1),
  }),
  signer: z.object({
    name: z.string().min(1),
    name_line: z.string().min(1),
    credential_lines: z.array(z.string().min(1)).min(1),
    signature: z.enum(SIGNATURE_MODES),
    signature_image: z.string().optional(),
  }),
});

// The complete config.json the script reads: the content with sign_date
// settled, plus the firm fields.
export const eoirWrittenPleadingsSpecSchema = eoirWrittenPleadingsConfigSchema
  .omit({ sign_date: true, signer_attorney_id: true, apply_signature: true })
  .extend({ sign_date: z.string().regex(WRITTEN_DATE), ...eoirWrittenPleadingsFirmFieldsSchema.shape });
export type EoirWrittenPleadingsSpec = z.infer<typeof eoirWrittenPleadingsSpecSchema>;

// One "Confirm:" item of Step 5, checked on the rendered pages.
const step5CheckSchema = z.object({
  passes: z.boolean().nullable().describe("true if the final packet passes; null only when no packet was rendered"),
  note: z.string().describe("What the pages showed, and what was fixed or is still wrong; empty if it passed as generated"),
});

// The Step 4 config of the final packet, key for key, as the report records
// it (what the server filled in is not part of it).
const reportConfigSchema = z.object({
  nameCaption: z.string(),
  nameFull: z.string(),
  aNumber: z.string(),
  pronoun: z.enum(EOIR_PLEADINGS_PRONOUNS),
  judge: z.string(),
  nextHearing: z.string(),
  ntaDate: z.string(),
  serviceMethod: z.string(),
  ntaServedDate: z.string(),
  servicePhrase: z.string().optional(),
  ntaFiledDate: z.string(),
  admit: z.array(z.number().int().min(1)),
  deny: z.array(z.number().int().min(1)),
  charges: z.array(z.object({ section: z.string(), concede: z.boolean() })),
  countryDesignated: z.string().nullable().describe("null when the packet declines to designate"),
  relief: z.object({
    termination: z.boolean(),
    asylum: z.boolean(),
    withholding: z.boolean(),
    cat: z.boolean(),
    adjustment: z.boolean(),
    cancellation: z.boolean(),
    waiver: z.boolean(),
    voluntaryDeparture: z.boolean(),
    other: z.boolean(),
    none: z.boolean(),
  }),
  cancellationSection: z.string().optional(),
  waiverSection: z.string().optional(),
  hours: z.number(),
  language: z.string(),
  signDate: z.string().describe("The date printed on the packet, including one the app filled in"),
});

// Mirrors skills-content/eoir-written-pleadings/SKILL.md "Step 4. Build the
// config and run the generator", "Step 5. Verify before delivering" and
// "Step 6. Deliver with a short cover note" (the output steps
// docs/ADDING_A_SKILL.md section 7 names for this skill). Step 4 is the config
// the packet was built with and the generated document's id, never the
// packet's text. Step 5 is its "Confirm:" list, one check per item, in order.
// Step 6 is the cover note's four items, in order, plus the questions Steps 1
// to 3 would have put to the attorney: a run cannot pause for the one question
// round, so they are asked in the report.
export const eoirWrittenPleadingsOutputSchema = z.object({
  buildTheConfigAndRunTheGenerator: z.object({
    config: reportConfigSchema.nullable().describe("The config of the final packet; null only when no config could be written"),
    generatedPleadingsDocumentId: z
      .string()
      .describe("document_id returned by generate_docx for the final packet; empty if none was generated"),
    notGeneratedReason: z.string().optional().describe("Only when no packet was generated: why"),
  }),
  verifyBeforeDelivering: z.object({
    everyPageViewed: z.boolean().describe("true only if every page of the final packet was rendered and looked at in this run"),
    pageCount: z.number().int().min(0).describe("Pages in the final packet as rendered; 0 when none was generated"),
    sevenPages: step5CheckSchema,
    captionOnCoverPleadingsAndIndex: step5CheckSchema,
    nameAndANumberIdenticalEverywhere: step5CheckSchema.describe(
      "Cover, both captions, COMES NOW, index caption, certificate of service header, pleading declaration"
    ),
    checkedBoxesMatchTheChoices: step5CheckSchema,
    allegationsAndChargeSentencesReadCorrectly: step5CheckSchema,
    paragraph1DatesMatchTheNta: step5CheckSchema,
    interpreterLanguageIsRight: step5CheckSchema,
    nothingSpillsOntoAnEighthPage: step5CheckSchema,
  }),
  deliverWithAShortCoverNote: z.object({
    pleadingPostureUsed: z.object({
      summary: z.string().describe("Allegations admitted and denied, charges conceded or denied, country of removal, relief, interpreter"),
      entryRecord: z
        .string()
        .describe("The I-94 or other entry record the allegations were checked against, by file name, or that there was none and the pleadings rest on the NTA alone"),
      defaultsNotConfirmed: z
        .array(z.string())
        .describe("Each Step 3 choice set to its default because neither the attorney's note nor the file answered it, with the value used"),
    }),
    recordDidNotLineUp: z.array(
      z.object({
        item: z.string().describe("What did not line up (name spelling, date, address, second nationality, hearing date not on the docket, contradicted allegation, NTA defect)"),
        ntaShows: z.string(),
        recordShows: z.string(),
        source: z.string().describe("The document the NTA was compared with, by file name, or the attorney's note"),
        blocksDrafting: z
          .boolean()
          .describe("true when Step 2 requires the attorney to decide which allegations to deny or whether to contest the charge, and the note does not decide it"),
      })
    ),
    stillNeedsToBeFilled: z.array(z.string()),
    tabAAndTabBAssemblyReminder: z.object({
      tabA: z.string(),
      tabB: z.string(),
    }),
    questionsForTheAttorney: z
      .array(z.string())
      .describe("Questions from Steps 1 to 3 that the attorney's note and the files did not answer"),
  }),
});
export type EoirWrittenPleadingsOutput = z.infer<typeof eoirWrittenPleadingsOutputSchema>;

type Step5Key = Exclude<keyof EoirWrittenPleadingsOutput["verifyBeforeDelivering"], "everyPageViewed" | "pageCount">;

// Step 5's "Confirm:" items, in SKILL.md order.
const STEP5_CHECKS: readonly (readonly [Step5Key, string])[] = [
  ["sevenPages", "seven pages"],
  ["captionOnCoverPleadingsAndIndex", "the caption appears on the cover, the pleadings page and the index page"],
  ["nameAndANumberIdenticalEverywhere", "name and A number identical everywhere"],
  ["checkedBoxesMatchTheChoices", "the checked boxes match the attorney's choices"],
  ["allegationsAndChargeSentencesReadCorrectly", "the allegations sentence and the charge sentence read correctly"],
  ["paragraph1DatesMatchTheNta", "paragraph 1 dates match the NTA"],
  ["interpreterLanguageIsRight", "the interpreter language is right"],
  ["nothingSpillsOntoAnEighthPage", "nothing spills onto an eighth page"],
];

/**
 * Everything the skill routes to the attorney: a packet that was not
 * generated and why; everything in the record that did not line up with the
 * NTA, marking what Step 2 says must be decided before drafting; every Step 5
 * check the final packet failed or that was not confirmed; the questions Steps
 * 1 to 3 would ask; the defaults used without the attorney's confirmation;
 * and what still needs to be filled before filing (Step 6).
 */
function eoirWrittenPleadingsEscalationFlags(output: EoirWrittenPleadingsOutput): string[] {
  const {
    buildTheConfigAndRunTheGenerator: build,
    verifyBeforeDelivering: verify,
    deliverWithAShortCoverNote: note,
  } = output;
  const generated = build.generatedPleadingsDocumentId.trim() !== "";
  const flags: string[] = [];

  if (!generated) {
    flags.push(`No pleadings packet was generated${build.notGeneratedReason ? `: ${build.notGeneratedReason}` : "."}`);
  }
  for (const row of note.recordDidNotLineUp) {
    flags.push(
      `${row.blocksDrafting ? "Attorney decision needed before drafting" : "Record did not line up"}: ${row.item} ` +
        `(NTA: ${row.ntaShows}; ${row.source}: ${row.recordShows})`
    );
  }
  if (generated) {
    if (!verify.everyPageViewed) flags.push("Not every page of the final packet was looked at before delivery (Step 5).");
    for (const [key, label] of STEP5_CHECKS) {
      const check = verify[key];
      if (check.passes !== true) {
        flags.push(`Step 5 check ${check.passes === false ? "failed" : "not confirmed"}: ${label}${check.note ? ` - ${check.note}` : ""}`);
      }
    }
  }
  flags.push(...note.questionsForTheAttorney);
  flags.push(...note.pleadingPostureUsed.defaultsNotConfirmed.map((d) => `Default used without the attorney's confirmation: ${d}`));
  flags.push(...note.stillNeedsToBeFilled.map((item) => `Still to be filled before filing: ${item}`));
  return [...new Set(flags)];
}

export const eoirWrittenPleadings = defineSkill({
  name: "eoir-written-pleadings",
  label: "Draft written pleadings",
  category: "eoir",
  kind: "build",
  description:
    "Drafts Respondent's Written Pleadings for the Houston Immigration Court from the Notice to Appear and the I-94 or other entry record, as one Word packet: cover, pleadings, index, certificate of service, pleading declaration and certificate of interpretation.",
  outputSchema: eoirWrittenPleadingsOutputSchema,
  extractEscalationFlags: eoirWrittenPleadingsEscalationFlags,
  // No fetch_uscis_page: the only live check the SKILL.md names is the EOIR
  // Automated Case Information lookup (acis.eoir.justice.gov), an A-number
  // query that tool cannot reach and that would send the A-number out. The
  // case note carries the docket details instead ("or ask the attorney").
  // maxTokens stays at the default: the generator takes the short Step 4
  // config, never the packet's text.
  tools: ["generate_docx_eoir_pleadings", "render_and_qa_docx"],
  maxIterations: 16,
  needsNote: true,
  notePlaceholder:
    "Case note for Draft written pleadings (optional): from ACIS, the date the NTA was filed, the Immigration Judge and the next hearing (or that none has issued); whether there is an I-94; any allegation to deny or charge to contest; a country of removal to designate; relief beyond the standard set (adjustment, or cancellation or waiver with the INA section); the interpreter language, hours estimate and signature date if not the defaults; and the signing attorney if not the default signer, and whether the pleadings should carry their signature (otherwise the signature line is left blank for ink).",
  // Any matter that can be in removal proceedings, as for the other EOIR
  // skills (eoir-motion-self-review): a VAWA or I-130 matter can be before
  // the court on an NTA too, and the case note lists adjustment and
  // cancellation among the relief to plead. Affirmative asylum and I-90
  // matters are not before EOIR.
  applicableCaseTypes: ["asylum_defensive", "withholding_cat", "cancellation", "vawa", "i130"],
});
