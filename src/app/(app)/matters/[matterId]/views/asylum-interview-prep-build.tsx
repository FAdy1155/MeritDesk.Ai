import type { SkillViewProps } from "./types";
import {
  Badge,
  BulletList,
  Callout,
  ChecklistList,
  CitationsList,
  Flags,
  Muted,
  ReportBody,
  Section,
  Table,
  humanize,
  toneClass,
  yesNo,
} from "./primitives";

type Output = SkillViewProps<"asylum-interview-prep-build">["output"];
type QaGateReport = NonNullable<Output["qaGateReport"]>;
type QaFinding = QaGateReport["blocking"][number];
type QaCoverageRow = QaGateReport["coverageTables"]["required"][number];

// The review skill's own tiers and verdicts (asylum-interview-prep-review
// "Report format"); the shared color maps do not carry these labels.
const QA_PRIORITY_COLOR: Record<QaGateReport["prioritizedEditChecklist"][number]["priority"], string> = {
  BLOCKING: toneClass.red,
  "SHOULD-FIX": toneClass.amber,
  OPTIONAL: toneClass.neutral,
};
const QA_VERDICT_COLOR: Record<QaGateReport["verdict"]["result"], string> = {
  PASS: toneClass.green,
  FAIL: toneClass.red,
  CANNOT_CERTIFY: toneClass.amber,
};

function None() {
  return <p className="text-xs text-black/50 dark:text-white/50">None.</p>;
}

function QaFindingsTable({ rows }: { rows: QaFinding[] }) {
  return (
    <Table
      rows={rows}
      columns={[
        { header: "Rule", cell: (row) => (row.rules.length > 0 ? row.rules.join(", ") : <Muted>-</Muted>) },
        { header: "Location", cell: (row) => row.location },
        { header: "Question", cell: (row) => (row.quotedQuestion ? `"${row.quotedQuestion}"` : <Muted>(missing)</Muted>) },
        { header: "Problem", cell: (row) => row.problem },
        { header: "Fix", cell: (row) => row.fix },
      ]}
    />
  );
}

function QaCoverageTable({ rows }: { rows: QaCoverageRow[] }) {
  return (
    <Table
      rows={rows}
      rowClassName={(row) => (row.coveredIn.length === 0 ? "text-red-800 dark:text-red-300" : "")}
      columns={[
        { header: "Item", cell: (row) => row.item },
        {
          header: "Covered in",
          cell: (row) => (row.coveredIn.length > 0 ? row.coveredIn.join("; ") : <Badge label="not covered" tone="red" />),
        },
      ]}
    />
  );
}

export function AsylumInterviewPrepBuildView({ output, actions }: SkillViewProps<"asylum-interview-prep-build">) {
  const { completeQuestionSet: questionSet, recordGaps, qaGateReport: qaGate } = output;
  const { venue, recordProvided, interpreterRequirement } = questionSet;
  const venueLabel =
    venue.affirmativeAsylumOfficeInterview === null
      ? "venue not confirmed"
      : venue.affirmativeAsylumOfficeInterview
        ? "Asylum Office affirmative"
        : "not affirmative";
  const venueTone =
    venue.affirmativeAsylumOfficeInterview === null ? "amber" : venue.affirmativeAsylumOfficeInterview ? "green" : "red";

  return (
    <ReportBody>
      <Section title="The complete question set">
        {questionSet.generatedQuestionSetDocumentId ? (
          <button
            type="button"
            onClick={() => actions.downloadDocument(questionSet.generatedQuestionSetDocumentId)}
            className="w-fit rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
          >
            Download interview question set (.docx)
          </button>
        ) : (
          <Muted>
            No question set was generated in this run
            {questionSet.notGeneratedReason ? `: ${questionSet.notGeneratedReason}` : "."}
          </Muted>
        )}
        {questionSet.generatedQuestionSetDocumentId && questionSet.notGeneratedReason && (
          <p className="mt-1 text-xs">
            <Muted>{questionSet.notGeneratedReason}</Muted>
          </p>
        )}
        {questionSet.title && (
          <p className="mt-2">
            <strong>{questionSet.title}</strong>
          </p>
        )}
        <p className="mt-1">
          <Badge label={venueLabel} tone={venueTone} /> {venue.basis}
        </p>

        <div className="mt-2">
          <strong>What the client gave us</strong> <Muted>(I-589 provided: {yesNo(recordProvided.i589Provided)})</Muted>
          {recordProvided.documents.length > 0 ? (
            <BulletList className="text-xs" items={recordProvided.documents} />
          ) : (
            <None />
          )}
        </div>
        <Flags title="Limits of what was provided" tone="amber" items={recordProvided.limitations} />

        <div className="mt-2">
          <strong>Interpreter requirement (Before the Interview)</strong>
          {interpreterRequirement ? (
            <>
              <p>{interpreterRequirement.statedInOrientation}</p>
              <CitationsList
                items={[
                  {
                    citation: interpreterRequirement.url ?? "No USCIS page confirmed in this run",
                    verified: interpreterRequirement.verified,
                    note: interpreterRequirement.verified ? "confirmed in this run" : "confirm before relying on it",
                  },
                ]}
              />
            </>
          ) : (
            <p className="text-xs">
              <Muted>Not reported: no Before the Interview section was drafted in this run.</Muted>
            </p>
          )}
        </div>
        {interpreterRequirement && (
          <Flags title="Confirm before the interview" tone="amber" items={[interpreterRequirement.attorneyFlag]} />
        )}

        <div className="mt-2">
          <strong>Parts as built</strong>
          <Table
            rows={questionSet.parts}
            columns={[
              {
                header: "Part",
                cell: (row) => (
                  <span>
                    {row.heading} {row.added && <Badge label="ADDED" tone="amber" />}
                  </span>
                ),
              },
              {
                header: "Sub-blocks",
                cell: (row) => (row.subBlocks.length > 0 ? row.subBlocks.join("; ") : <Muted>-</Muted>),
              },
              { header: "Questions", cell: (row) => row.questionCount },
            ]}
          />
        </div>
      </Section>

      <Section title="Element coverage table">
        <Table
          rows={output.elementCoverageTable}
          columns={[
            { header: "Element", cell: (row) => humanize(row.element) },
            {
              header: "Reached",
              cell: (row) => <Badge label={row.reached ? "reached" : "not reached"} tone={row.reached ? "green" : "red"} />,
            },
            {
              header: "Where",
              cell: (row) => (row.whereReached.length > 0 ? row.whereReached.join("; ") : <Muted>-</Muted>),
            },
            { header: "Flag", cell: (row) => row.flag ?? <Muted>-</Muted> },
          ]}
        />
      </Section>

      <Section title="Record gaps">
        {recordGaps.recordGapFlags.length > 0 ? (
          <Flags title="[RECORD GAP] flags: confirm with client before use" tone="amber" items={recordGaps.recordGapFlags} />
        ) : (
          <p className="text-xs">
            <Muted>No [RECORD GAP] flags.</Muted>
          </p>
        )}
        <div className="mt-2">
          <strong>Where the record is thin</strong>
          {recordGaps.thinRecordPoints.length > 0 ? <BulletList items={recordGaps.thinRecordPoints} /> : <None />}
        </div>
      </Section>

      <Section title="Consistency log">
        <Table
          rows={output.consistencyLog}
          columns={[
            { header: "Discrepancy", cell: (row) => row.discrepancy },
            { header: "Where it appears", cell: (row) => <BulletList items={row.whereItAppears} /> },
          ]}
        />
      </Section>

      {output.escalationFlags.length > 0 ? (
        <Flags title="Escalation flags" items={output.escalationFlags} />
      ) : (
        <Section title="Escalation flags">
          <None />
        </Section>
      )}

      {qaGate ? (
        <QaGateSection qaGate={qaGate} />
      ) : (
        <Section title="QA gate: asylum-interview-prep-review report">
          <p className="text-xs">
            <Muted>
              {questionSet.generatedQuestionSetDocumentId
                ? "Not run in this run. Run asylum-interview-prep-review on this matter before the question set is used."
                : "Not run: no question set was generated, so there was nothing to review."}
            </Muted>
          </p>
        </Section>
      )}
    </ReportBody>
  );
}

/** The QA gate's report: asylum-interview-prep-review "Report format", items 1-10, then the most exposed point. */
function QaGateSection({ qaGate }: { qaGate: QaGateReport }) {
  return (
    <Callout
      tone="neutral"
      title={
        <span>
          QA gate: asylum-interview-prep-review report{" "}
          <Badge label={qaGate.verdict.result} className={QA_VERDICT_COLOR[qaGate.verdict.result]} />
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        <Section title="Draft snapshot">
          <p>
            {humanize(qaGate.draftSnapshot.draftType)} draft - {qaGate.draftSnapshot.country} -{" "}
            {qaGate.draftSnapshot.claimType} - {qaGate.draftSnapshot.venue}
          </p>
          <p className="text-xs">
            <Muted>
              Reviewed: {qaGate.draftSnapshot.documentsReviewed.length > 0 ? qaGate.draftSnapshot.documentsReviewed.join(", ") : "none"}
            </Muted>
          </p>
          <p className="text-xs">
            <Muted>
              Not provided: {qaGate.draftSnapshot.notProvided.length > 0 ? qaGate.draftSnapshot.notProvided.join(", ") : "none"}
            </Muted>
          </p>
        </Section>

        <Section title="Coverage tables">
          <p className="text-xs font-medium">Required (C1)</p>
          <QaCoverageTable rows={qaGate.coverageTables.required} />
          <p className="mt-2 text-xs font-medium">Recommended (C2)</p>
          <QaCoverageTable rows={qaGate.coverageTables.recommended} />
        </Section>

        {qaGate.blocking.length > 0 ? (
          <Callout title="BLOCKING">
            <QaFindingsTable rows={qaGate.blocking} />
          </Callout>
        ) : (
          <Section title="BLOCKING">
            <None />
          </Section>
        )}

        <Section title="SHOULD-FIX">
          <QaFindingsTable rows={qaGate.shouldFix} />
        </Section>

        <Section title="UNVERIFIED">
          <Table
            rows={qaGate.unverified}
            columns={[
              { header: "Check", cell: (row) => row.check },
              { header: "What is needed", cell: (row) => row.whatIsNeeded },
              {
                header: "Required",
                cell: (row) => <Badge label={row.requiredCheck ? "required" : "recommended"} tone={row.requiredCheck ? "amber" : "neutral"} />,
              },
            ]}
          />
        </Section>

        <Section title="OPTIONAL">
          <QaFindingsTable rows={qaGate.optional} />
        </Section>

        {qaGate.escalationFlags.length > 0 ? (
          <Flags title="Escalation flags (QA gate)" items={qaGate.escalationFlags} />
        ) : (
          <Section title="Escalation flags (QA gate)">
            <None />
          </Section>
        )}

        <Section title="Verdict">
          <p>
            <Badge label={qaGate.verdict.result} className={QA_VERDICT_COLOR[qaGate.verdict.result]} />
            {qaGate.verdict.whatWouldConvert ? <span> {qaGate.verdict.whatWouldConvert}</span> : null}
          </p>
          <div className="mt-1">
            <strong>Recommended gaps</strong> <Muted>(departures from the house standard, not part of the verdict)</Muted>
            {qaGate.verdict.recommendedGaps.length > 0 ? <BulletList items={qaGate.verdict.recommendedGaps} /> : <None />}
          </div>
        </Section>

        <Section title="Officer questions this draft does not prepare the client for">
          {qaGate.officerQuestionsNotPreparedFor.length > 0 ? (
            <BulletList items={qaGate.officerQuestionsNotPreparedFor} />
          ) : (
            <None />
          )}
        </Section>

        <Section title="Prioritized edit checklist">
          <ChecklistList
            items={qaGate.prioritizedEditChecklist.map((item) => ({
              badge: item.priority,
              badgeClassName: QA_PRIORITY_COLOR[item.priority],
              content: item.item,
            }))}
          />
        </Section>

        <Section title="Most exposed point">
          <p>{qaGate.mostExposedPoint}</p>
        </Section>
      </div>
    </Callout>
  );
}
