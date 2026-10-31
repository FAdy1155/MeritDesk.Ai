import type { SkillViewProps } from "./types";
import { Badge, BulletList, Callout, Flags, Muted, ReportBody, Section, Table, yesNo } from "./primitives";

export function I130ExpediteBuildView({ output, actions }: SkillViewProps<"i130-expedite-build">) {
  const { caseSnapshot, groundDetermination, qaReport } = output;
  const { screenResults } = caseSnapshot;
  const hasQaFindings = qaReport.blocking.length > 0 || qaReport.serious.length > 0 || qaReport.polish.length > 0;

  return (
    <ReportBody>
      <Section title="Case snapshot">
        <p>
          Petitioner: {caseSnapshot.petitionerName} - Beneficiary: {caseSnapshot.beneficiaryName}
        </p>
        <p>
          Receipt {caseSnapshot.receiptNumber} - {caseSnapshot.officeHoldingCase}
        </p>
        <ul className="mt-1 text-xs text-black/60 dark:text-white/60">
          <li>Receipted: {yesNo(screenResults.isReceipted)}</li>
          <li>Within posted processing time: {yesNo(screenResults.withinPostedProcessingTime)}</li>
          <li>Urgency flows from delay: {yesNo(screenResults.urgencyFlowsFromDelay)}</li>
          <li>In removal / detained / final order: {yesNo(screenResults.inRemovalOrDetainedOrFinalOrder)}</li>
        </ul>
      </Section>

      <Flags title="Attorney question list" tone="amber" items={output.attorneyQuestionList} />

      <Section title="Ground determination">
        <p>
          <strong>{groundDetermination.primaryGround}</strong>
          {groundDetermination.secondaryGround ? ` + ${groundDetermination.secondaryGround}` : ""}
        </p>
        {groundDetermination.operativeFacts.length > 0 && (
          <BulletList
            className="mt-1"
            items={groundDetermination.operativeFacts.map((f, i) => (
              <span key={i}>
                {f.fact} <Muted>({f.sourceDocument})</Muted>
              </span>
            ))}
          />
        )}
        <p className="mt-1 text-black/70 dark:text-white/70">{groundDetermination.whatApprovalUnlocks}</p>
        <p className="mt-1 text-amber-800 dark:text-amber-300">
          <strong>Honest weakness:</strong> {groundDetermination.honestWeakness}
        </p>
      </Section>

      <section>
        {output.generatedLetterDocumentId ? (
          <button
            type="button"
            onClick={() => actions.downloadDocument(output.generatedLetterDocumentId)}
            className="w-fit rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
          >
            Download expedite letter (.docx)
          </button>
        ) : (
          <Muted>No letter was generated in this run; see the QA report for why.</Muted>
        )}
      </section>

      <Section title="Verification log">
        <ul className="flex flex-col gap-1 text-xs">
          {output.verificationLog.map((v, i) => (
            <li key={i}>
              <Badge label={v.confirmed ? "confirmed" : "unconfirmed"} tone={v.confirmed ? "green" : "amber"} /> {v.item}
              {v.sourceUrl && <Muted> ({v.sourceUrl})</Muted>}
              {v.dateConfirmed && <Muted> {v.dateConfirmed}</Muted>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Exhibit index">
        <Table
          rows={output.exhibitIndex}
          columns={[
            { header: "Ex.", cell: (row) => row.exhibitLetter },
            { header: "Document", cell: (row) => row.document },
            { header: "Proves", cell: (row) => row.provesWhat },
            { header: "Supports", cell: (row) => row.supportsSentence },
            { header: "Orig./copy", cell: (row) => row.originalOrCopy },
            { header: "Translation", cell: (row) => row.translationStatus },
          ]}
        />
      </Section>

      {output.evidenceGapList.length > 0 && (
        <Section title="Evidence gap list">
          <BulletList
            items={output.evidenceGapList.map((g, i) => (
              <span key={i}>
                {g.missingDocument} - {g.whoObtains}, {g.howLong}. <Muted>{g.weakerWithout}</Muted>
              </span>
            ))}
          />
        </Section>
      )}

      <Section title="Submission plan">
        <p>
          <strong>{output.submissionPlan.channel}</strong> - {output.submissionPlan.why}
        </p>
        <BulletList className="mt-1 text-xs" items={output.submissionPlan.filingChecklist} />
      </Section>

      <Section title="Calendar items">
        <BulletList items={output.calendarItems.map((c) => (c.date ? `${c.date}: ${c.description}` : c.description))} />
      </Section>

      {hasQaFindings && (
        <Callout title="QA report">
          {qaReport.blocking.length > 0 && (
            <div>
              <strong>Blocking:</strong>
              <BulletList items={qaReport.blocking} />
            </div>
          )}
          {qaReport.serious.length > 0 && (
            <div className="mt-1">
              <strong>Serious:</strong>
              <BulletList items={qaReport.serious} />
            </div>
          )}
          {qaReport.polish.length > 0 && (
            <div className="mt-1">
              <strong>Polish:</strong>
              <BulletList items={qaReport.polish} />
            </div>
          )}
        </Callout>
      )}
    </ReportBody>
  );
}
