import { z } from "zod";
import { defineSkill } from "./types";

// Mirrors skills-content/direct-exam/SKILL.md "Deliverables", items 1-4.
// Items 1 and 2 are two Word files generate_document builds from one
// question set ("Version one, the counsel script" and "Version two, the
// client practice guide"); the report carries their ids and what the
// attorney checks before prepping the witness, never the questions' text.
// Both house layouts fit the generic spec: the header block as caption
// lines (show_title false), each lettered section a heading, each section's
// questions a numbered block whose start carries the numbering straight
// through the section breaks, the labeled ELEMENT / MUST ESTABLISH / IF
// SHORT / RECORD (and OBJECTION NOTE) lines, or the How to answer note, as
// line breaks inside the question's item, the pass the witness checklist
// as a bulleted block, and the guide's disclaimer box as a one-column table
// (bordered). The Intake Tier One items the run did not have (the skill
// would have asked for them before drafting) and what "Self check before
// delivering" left open sit with item 1, the master version both files are
// cut from. The SKILL.md bundles no references, scripts or assets.

// "Rate each element after drafting": FRAMED, TOUCHED, MISSING.
const ELEMENT_RATINGS = ["FRAMED", "TOUCHED", "MISSING"] as const;

const questionNumber = z.number().int().min(1);

export const directExamOutputSchema = z.object({
  counselScript: z.object({
    generatedCounselScriptDocumentId: z
      .string()
      .describe("document_id returned by generate_document for the final counsel script; empty if none could be generated"),
    notGeneratedReason: z
      .string()
      .optional()
      .describe("Why no counsel script could be generated; only when generatedCounselScriptDocumentId is empty"),
    pageCount: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("Pages in the final counsel script as rendered by render_and_qa_docx; null if it could not be rendered"),
    witness: z
      .string()
      .describe("Who testifies on this direct: the respondent, or a witness and their relationship to the respondent"),
    reliefSought: z
      .string()
      .describe(
        "The relief the element map was adapted to, and where that came from: the record, the attorney's note, or a claim-evaluation result pasted into the note or uploaded to the matter"
      ),
    controllingCircuit: z
      .string()
      .describe(
        "The circuit the element map was checked against, from the practice profile, the matter or the attorney's note; a bracketed placeholder if none of them names it"
      ),
    questionCount: z
      .number()
      .int()
      .min(0)
      .describe("Questions in the set, numbered from 1 straight through the section breaks"),
    sections: z
      .array(
        z.object({
          letter: z.string().describe("The section letter as printed"),
          heading: z.string().describe("The counsel script's heading for the section, as printed"),
          firstQuestion: questionNumber,
          lastQuestion: questionNumber,
        })
      )
      .describe("The lettered thematic sections, in order"),
    passTheWitnessChecklistIncluded: z.boolean(),
    benchMemoNumbersMatch: z
      .boolean()
      .nullable()
      .describe("Whether the question numbers match section 5 of a bench memo on the matter; null when the matter has no bench memo to cross check"),
    recordInconsistenciesSurfaced: z
      .array(
        z.object({
          inconsistency: z
            .string()
            .describe("Where the declaration conflicts with a prior sworn statement or a form answer, naming both records by file name and paragraph or page"),
          questionNumbers: z
            .array(questionNumber)
            .describe("The direct questions that put it on the record; empty if none does yet"),
        })
      )
      .describe("Every record inconsistency found; empty if the record has none"),
    bracketedGaps: z
      .array(
        z.object({
          questionNumber: questionNumber
            .nullable()
            .describe("The question the bracket sits under; null for one in a header block or section heading"),
          bracketedItem: z.string().describe("The bracketed gap as printed"),
          whatWouldCloseIt: z.string(),
        })
      )
      .describe("Every bracketed gap in either version, addressed to the attorney"),
    tierOneMissing: z
      .array(z.string())
      .describe(
        "Intake Tier One items that neither the matter's documents nor the attorney's note supplied, named as the skill lists them; the files carry a bracketed gap for each. Empty when Tier One is complete."
      ),
    selfCheck: z
      .object({
        blocking: z.array(z.string()),
        shouldFix: z.array(z.string()),
        optional: z.array(z.string()),
      })
      .describe(
        "Self check before delivering, across both versions and their shared numbering, by the skill's three tiers: what is still open in the final files, one finding per entry; empty lists when they pass"
      ),
  }),
  clientPracticeGuide: z.object({
    generatedClientPracticeGuideDocumentId: z
      .string()
      .describe("document_id returned by generate_document for the final client practice guide; empty if none could be generated"),
    notGeneratedReason: z
      .string()
      .optional()
      .describe("Why no practice guide could be generated; only when generatedClientPracticeGuideDocumentId is empty"),
    pageCount: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("Pages in the final practice guide as rendered by render_and_qa_docx; null if it could not be rendered"),
    questionCount: z
      .number()
      .int()
      .min(0)
      .describe("Questions in the guide; the same set and numbering as the counsel script, so the same count"),
    sectionHeadings: z
      .array(
        z.object({
          letter: z.string().describe("The section letter as printed; the same letters as the counsel script"),
          heading: z.string().describe("The guide's heading for the section, carrying its purpose in words the client understands, as printed"),
        })
      )
      .describe("The guide's lettered sections, in order"),
    disclaimerBox: z.object({
      included: z.boolean().describe("The disclaimer box is printed before the first question"),
      trueAnswerControlsLine: z
        .boolean()
        .describe("The box says that if the true answer differs from a note, the true answer always controls"),
    }),
    questionsWithoutHowToAnswerNote: z
      .array(questionNumber)
      .describe("Question numbers left with no How to answer note; empty when every question has one"),
    closingQuestionNumbers: z
      .array(questionNumber)
      .describe("The numbers of the close's questions, the last asking for anything else the client wants the Court to know"),
  }),
  elementCoverageMatrix: z
    .array(
      z.object({
        element: z.string().describe("The element as the element map names it, adapted to the relief sought"),
        questionNumbers: z.array(questionNumber).describe("The questions reaching it; empty when MISSING"),
        rating: z.enum(ELEMENT_RATINGS),
        recommendation: z
          .string()
          .optional()
          .describe("Required for TOUCHED and MISSING: what the attorney should add, ask or obtain to carry it; omit for FRAMED"),
      })
    )
    .min(1)
    .describe("Every element of the element map as adapted to the relief sought, in map order"),
  crossExposureList: z.array(
    z.object({
      opening: z.string().describe("Where the direct leaves an opening for cross"),
      closingQuestion: z.string().describe("The open form direct question that would close it"),
    })
  ),
});
export type DirectExamOutput = z.infer<typeof directExamOutputSchema>;

function listNumbers(numbers: readonly number[]): string {
  return numbers.join(", ");
}

/**
 * Everything the skill routes to the attorney or treats as blocking: a
 * version that was not generated, the two versions pointing at one file or
 * out of sync ("Question numbers out of sync between the two versions" is
 * Blocking, and Synchronization has them cross checked against the bench
 * memo), the disclaimer box or its true-answer line missing (Blocking),
 * questions left with no How to answer note ("None left bare"), the Tier
 * One items drafted around ("draft with brackets"), the self check's
 * Blocking tier, every MISSING element (and a MISSING or TOUCHED one with no
 * recommendation, which Deliverables item 3 and the Blocking tier forbid),
 * every record inconsistency not yet put to the witness ("Never resolve a
 * record inconsistency silently"), and every bracketed gap ("Bracket the
 * gap and address it to the attorney"). The structural checks are computed
 * here, not taken from the self check, so a report that misses one in its
 * own self check still raises it.
 */
function directExamEscalationFlags(output: DirectExamOutput): string[] {
  const { counselScript: script, clientPracticeGuide: guide, elementCoverageMatrix } = output;
  const scriptId = script.generatedCounselScriptDocumentId.trim();
  const guideId = guide.generatedClientPracticeGuideDocumentId.trim();
  const flags: string[] = [];

  if (!scriptId) {
    flags.push(`No counsel script was generated in this run${script.notGeneratedReason ? `: ${script.notGeneratedReason}` : "."}`);
  }
  if (!guideId) {
    flags.push(
      `No client practice guide was generated in this run${guide.notGeneratedReason ? `: ${guide.notGeneratedReason}` : "."}`
    );
  }
  if (scriptId && scriptId === guideId) {
    flags.push("The counsel script and the client practice guide name the same document; they must be two Word files.");
  }
  if (scriptId && guideId) {
    if (script.questionCount !== guide.questionCount) {
      flags.push(
        `Question numbers out of sync between the two versions: the counsel script has ${script.questionCount} questions, the client practice guide ${guide.questionCount}.`
      );
    }
    const scriptLetters = script.sections.map((s) => s.letter.trim()).join(",");
    const guideLetters = guide.sectionHeadings.map((s) => s.letter.trim()).join(",");
    if (scriptLetters !== guideLetters) {
      flags.push("Lettered sections out of sync between the counsel script and the client practice guide.");
    }
  }
  if (script.benchMemoNumbersMatch === false) {
    flags.push("Question numbers do not match section 5 of the bench memo on the matter.");
  }
  if (guideId && !guide.disclaimerBox.included) {
    flags.push("The client practice guide has no disclaimer box before the first question.");
  } else if (guideId && !guide.disclaimerBox.trueAnswerControlsLine) {
    flags.push("The disclaimer box is missing the line that the true answer always controls over any note.");
  }
  if (guideId && guide.questionsWithoutHowToAnswerNote.length > 0) {
    flags.push(`Questions with no How to answer note: ${listNumbers(guide.questionsWithoutHowToAnswerNote)}.`);
  }

  flags.push(...script.tierOneMissing.map((item) => `Tier One intake item missing, drafted with a bracket: ${item}`));
  flags.push(...script.selfCheck.blocking);

  for (const row of elementCoverageMatrix) {
    const recommendation = row.recommendation?.trim();
    if (row.rating === "MISSING") {
      flags.push(
        recommendation
          ? `Element MISSING: ${row.element}: ${recommendation}`
          : `Element MISSING with no note to the attorney: ${row.element}`
      );
    } else if (row.rating === "TOUCHED" && !recommendation) {
      flags.push(`Element TOUCHED with no recommendation: ${row.element}`);
    }
  }

  for (const row of script.recordInconsistenciesSurfaced) {
    if (row.questionNumbers.length === 0) {
      flags.push(`Record inconsistency not surfaced on direct: ${row.inconsistency}`);
    }
  }
  for (const gap of script.bracketedGaps) {
    const where = gap.questionNumber === null ? "" : ` (question ${gap.questionNumber})`;
    flags.push(`Bracketed gap${where}: ${gap.bracketedItem}. ${gap.whatWouldCloseIt}`);
  }

  return [...new Set(flags)];
}

export const directExam = defineSkill({
  name: "direct-exam",
  label: "Draft direct exam",
  category: "eoir",
  kind: "build",
  description:
    "Builds the direct examination question set for an EOIR individual merits hearing as two synchronized Word files, a counsel script and a client practice guide, with an element coverage matrix and a cross exposure list.",
  outputSchema: directExamOutputSchema,
  extractEscalationFlags: directExamEscalationFlags,
  // The SKILL.md delivers two Word files and cites no authority (its element
  // map and craft rules are self-contained, and the circuit comes from the
  // practice profile), so no web or fetch tool. read_prior_skill_reports:
  // "Before anything" pulls claim-evaluation's element scoring and
  // evidence-organizer's exhibit index (also a Tier One item), which exist
  // only as those runs' reports; the bench memo whose section 5 the numbers
  // must match is a generated Word file, so a matter document.
  tools: ["read_prior_skill_reports", "generate_document", "render_and_qa_docx"],
  // A full question set with four labeled lines under every question runs
  // long, and each version goes to generate_document in one turn.
  maxTokens: 128_000,
  // Two documents: draft, render, fix and render each, then submit, with
  // room for the 20-page render limit on a long counsel script.
  maxIterations: 24,
  // The Intake Tier One items the record rarely shows, and the Tier One
  // records to upload; without them the run drafts from the record with
  // brackets. The other skills' reports come from read_prior_skill_reports.
  needsNote: true,
  notePlaceholder:
    "Case note for Draft direct exam (optional): who is testifying (the respondent, or a witness and their relationship); the relief sought; the protected grounds and the particular social group formulation word for word; the cross attacks you expect; hearing date, court and judge; interpreter language and dialect; whether the judge takes direct in full or lets the declaration carry, and any time limit; which witnesses testify and in what order; and corroboration that could not be obtained and why. Upload the signed declaration, the applications as filed, and every prior sworn statement (credible or reasonable fear interview, asylum office interview and notes, airport or secondary inspection statement, any prior application).",
  // Any matter that can be in removal proceedings, as for the other EOIR
  // skills (eoir-motion-self-review): testimony before the judge can follow
  // from a VAWA or I-130 matter too. Affirmative asylum and I-90 matters are
  // not before EOIR.
  applicableCaseTypes: ["asylum_defensive", "withholding_cat", "cancellation", "vawa", "i130"],
});
