import type { SkillViewProps } from "./types";
import type { Tone } from "./primitives";
import { Badge, ChecklistList, Flags, Muted, ReportBody, Section, Table, toneClass, yesNo } from "./primitives";

type Output = SkillViewProps<"direct-exam">["output"];
type ElementRating = Output["elementCoverageMatrix"][number]["rating"];

// The SKILL.md's ratings ("Rate each element after drafting"); the shared
// color maps have no entry for these labels.
const RATING_TONE: Record<ElementRating, Tone> = { FRAMED: "green", TOUCHED: "amber", MISSING: "red" };

// "A two question close"; a longer one is in the self check's Optional tier.
const MAX_CLOSE_QUESTIONS = 2;

function numbers(list: readonly number[]): string {
  return list.join(", ");
}

function DownloadButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-fit rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
    >
      {label}
    </button>
  );
}

function pageLine(pageCount: number | null) {
  return pageCount === null ? (
    <Muted>Page count unknown: the file was not rendered.</Muted>
  ) : (
    <Muted>
      {pageCount} page{pageCount === 1 ? "" : "s"}
    </Muted>
  );
}

export function DirectExamView({ output, actions }: SkillViewProps<"direct-exam">) {
  const { counselScript: script, clientPracticeGuide: guide, elementCoverageMatrix, crossExposureList } = output;
  const { selfCheck } = script;
  const scriptId = script.generatedCounselScriptDocumentId.trim();
  const guideId = guide.generatedClientPracticeGuideDocumentId.trim();

  // The same structural checks the skill module raises as escalation flags
  // (the views may not import it): both files present, distinct, and on one
  // numbering, and the guide's disclaimer box complete.
  const countsDiffer = Boolean(scriptId && guideId) && script.questionCount !== guide.questionCount;
  const lettersDiffer =
    Boolean(scriptId && guideId) &&
    script.sections.map((s) => s.letter.trim()).join(",") !== guide.sectionHeadings.map((s) => s.letter.trim()).join(",");
  const structural: string[] = [
    ...(scriptId && scriptId === guideId
      ? ["The counsel script and the client practice guide name the same document; they must be two Word files."]
      : []),
    ...(countsDiffer
      ? [
          `Question numbers out of sync: the counsel script has ${script.questionCount} questions, the client practice guide ${guide.questionCount}.`,
        ]
      : []),
    ...(lettersDiffer ? ["Lettered sections out of sync between the two versions."] : []),
    ...(script.benchMemoNumbersMatch === false
      ? ["Question numbers do not match section 5 of the bench memo on the matter."]
      : []),
    ...(guideId && !guide.disclaimerBox.included
      ? ["The client practice guide has no disclaimer box before the first question."]
      : guideId && !guide.disclaimerBox.trueAnswerControlsLine
        ? ["The disclaimer box is missing the line that the true answer always controls over any note."]
        : []),
    ...(guideId && guide.questionsWithoutHowToAnswerNote.length > 0
      ? [`Questions with no How to answer note: ${numbers(guide.questionsWithoutHowToAnswerNote)}.`]
      : []),
  ];
  const blocking = [...structural, ...selfCheck.blocking];

  const unsurfaced = script.recordInconsistenciesSurfaced.filter((row) => row.questionNumbers.length === 0).length;
  const missingCount = elementCoverageMatrix.filter((row) => row.rating === "MISSING").length;
  const touchedCount = elementCoverageMatrix.filter((row) => row.rating === "TOUCHED").length;

  return (
    <ReportBody>
      <Section title="Counsel script">
        {scriptId ? (
          <DownloadButton
            label="Download counsel script (.docx)"
            onClick={() => actions.downloadDocument(scriptId)}
          />
        ) : (
          <p>
            <Muted>No counsel script was generated in this run.</Muted>
          </p>
        )}
        {script.notGeneratedReason && (
          <p className="mt-1 text-amber-800 dark:text-amber-300">
            <strong>Why not generated:</strong> {script.notGeneratedReason}
          </p>
        )}
        <p className="mt-1 text-xs">{pageLine(script.pageCount)}</p>
        <ul className="mt-2 text-xs">
          <li>Witness: {script.witness}</li>
          <li>Relief sought: {script.reliefSought}</li>
          <li>Element map checked against: {script.controllingCircuit}</li>
          <li>
            Questions: {script.questionCount}
            {countsDiffer && (
              <>
                {" "}
                <Badge label="out of sync with the guide" tone="red" />
              </>
            )}
          </li>
          <li>
            Pass the witness checklist: {yesNo(script.passTheWitnessChecklistIncluded)}
            {!script.passTheWitnessChecklistIncluded && (
              <>
                {" "}
                <Badge label="missing" tone="neutral" />
              </>
            )}
          </li>
          <li>
            Numbers checked against bench memo section 5:{" "}
            {script.benchMemoNumbersMatch === null ? (
              <Muted>no bench memo on the matter</Muted>
            ) : script.benchMemoNumbersMatch ? (
              <Badge label="match" tone="green" />
            ) : (
              <Badge label="do not match" tone="red" />
            )}
          </li>
        </ul>

        <div className="mt-2">
          <strong>Lettered sections</strong>
          <Table
            rows={script.sections}
            empty="No sections reported."
            columns={[
              { header: "Section", cell: (row) => row.letter },
              {
                header: "Questions",
                cell: (row) =>
                  row.firstQuestion === row.lastQuestion ? row.firstQuestion : `${row.firstQuestion}-${row.lastQuestion}`,
              },
              { header: "Heading", cell: (row) => row.heading },
            ]}
          />
        </div>

        <div className="mt-2">
          <strong>Record inconsistencies</strong>
          {unsurfaced > 0 && (
            <p className="text-xs">
              <Muted>
                {unsurfaced} not yet put to the witness on direct. Each needs a direct question; none is resolved
                silently.
              </Muted>
            </p>
          )}
          <Table
            rows={script.recordInconsistenciesSurfaced}
            empty="No record inconsistencies reported."
            columns={[
              { header: "Inconsistency", cell: (row) => row.inconsistency },
              {
                header: "Surfaced at",
                cell: (row) =>
                  row.questionNumbers.length > 0 ? (
                    `Q ${numbers(row.questionNumbers)}`
                  ) : (
                    <Badge label="not surfaced" tone="red" />
                  ),
              },
            ]}
          />
        </div>

        <div className="mt-2">
          <strong>Bracketed gaps</strong>
          <Table
            rows={script.bracketedGaps}
            empty="No bracketed gaps reported."
            columns={[
              {
                header: "Question",
                cell: (row) => (row.questionNumber === null ? <Muted>header</Muted> : row.questionNumber),
              },
              { header: "Bracketed item", cell: (row) => row.bracketedItem },
              { header: "What would close it", cell: (row) => row.whatWouldCloseIt },
            ]}
          />
        </div>
      </Section>

      <Flags
        title="Tier One intake items missing (drafted with brackets; supply before prepping the witness)"
        tone="amber"
        items={script.tierOneMissing}
      />

      <Flags title="Blocking" items={blocking} />

      <Section title="Self check before delivering">
        {blocking.length === 0 && (
          <p className="mb-1 text-xs">
            <Muted>No blocking items.</Muted>
          </p>
        )}
        <ChecklistList
          items={[
            ...selfCheck.shouldFix.map((item) => ({ badge: "should_fix", badgeClassName: toneClass.amber, content: item })),
            ...selfCheck.optional.map((item) => ({ badge: "optional", badgeClassName: toneClass.neutral, content: item })),
          ]}
        />
      </Section>

      <Section title="Client practice guide">
        {guideId ? (
          <DownloadButton
            label="Download client practice guide (.docx)"
            onClick={() => actions.downloadDocument(guideId)}
          />
        ) : (
          <p>
            <Muted>No client practice guide was generated in this run.</Muted>
          </p>
        )}
        {guide.notGeneratedReason && (
          <p className="mt-1 text-amber-800 dark:text-amber-300">
            <strong>Why not generated:</strong> {guide.notGeneratedReason}
          </p>
        )}
        <p className="mt-1 text-xs">{pageLine(guide.pageCount)}</p>
        <p className="mt-1 text-xs">
          <Muted>
            Practice material, not a script: the witness answers from their own memory and in their own words, and the
            true answer always controls over any note.
          </Muted>
        </p>
        <ul className="mt-2 text-xs">
          <li>
            Questions: {guide.questionCount}
            {countsDiffer && (
              <>
                {" "}
                <Badge label="out of sync with the counsel script" tone="red" />
              </>
            )}
          </li>
          <li>
            Disclaimer box before the first question:{" "}
            <Badge label={yesNo(guide.disclaimerBox.included)} tone={guide.disclaimerBox.included ? "green" : "red"} />
          </li>
          <li>
            Disclaimer says the true answer controls:{" "}
            <Badge
              label={yesNo(guide.disclaimerBox.trueAnswerControlsLine)}
              tone={guide.disclaimerBox.trueAnswerControlsLine ? "green" : "red"}
            />
          </li>
          <li>
            Questions with no How to answer note:{" "}
            {guide.questionsWithoutHowToAnswerNote.length > 0 ? (
              <Badge label={numbers(guide.questionsWithoutHowToAnswerNote)} tone="red" />
            ) : (
              <Muted>none</Muted>
            )}
          </li>
          <li>
            Close:{" "}
            {guide.closingQuestionNumbers.length > 0 ? `Q ${numbers(guide.closingQuestionNumbers)}` : <Muted>none reported</Muted>}
            {guide.closingQuestionNumbers.length > MAX_CLOSE_QUESTIONS && (
              <>
                {" "}
                <Badge label="runs past two questions" tone="neutral" />
              </>
            )}
          </li>
        </ul>

        <div className="mt-2">
          <strong>Lettered sections</strong>
          {lettersDiffer && (
            <p className="text-xs">
              <Badge label="letters differ from the counsel script" tone="red" />
            </p>
          )}
          <Table
            rows={guide.sectionHeadings}
            empty="No sections reported."
            columns={[
              { header: "Section", cell: (row) => row.letter },
              { header: "Heading for the client", cell: (row) => row.heading },
            ]}
          />
        </div>
      </Section>

      <Section title="Element coverage matrix">
        {elementCoverageMatrix.length > 0 && (
          <p className="mb-1 text-xs">
            <Muted>
              {elementCoverageMatrix.length - missingCount - touchedCount} framed, {touchedCount} touched, {missingCount}{" "}
              missing.
            </Muted>
          </p>
        )}
        <Table
          rows={elementCoverageMatrix}
          empty="No elements reported."
          rowClassName={(row) => (row.rating === "MISSING" ? "bg-red-50 dark:bg-red-950" : "")}
          columns={[
            { header: "Element", cell: (row) => row.element },
            {
              header: "Questions",
              cell: (row) => (row.questionNumbers.length > 0 ? numbers(row.questionNumbers) : <Muted>none</Muted>),
            },
            { header: "Rating", cell: (row) => <Badge label={row.rating} tone={RATING_TONE[row.rating]} /> },
            {
              header: "Recommendation",
              cell: (row) =>
                row.recommendation?.trim() ? (
                  row.recommendation
                ) : row.rating === "FRAMED" ? (
                  <Muted>-</Muted>
                ) : (
                  <Badge label="no recommendation" tone="red" />
                ),
            },
          ]}
        />
      </Section>

      <Section title="Cross exposure list">
        {crossExposureList.length > 0 ? (
          <Table
            rows={crossExposureList}
            columns={[
              { header: "Opening the direct leaves", cell: (row) => row.opening },
              { header: "Direct question that would close it", cell: (row) => row.closingQuestion },
            ]}
          />
        ) : (
          <p className="text-xs">
            <Muted>No cross exposures reported.</Muted>
          </p>
        )}
      </Section>
    </ReportBody>
  );
}
