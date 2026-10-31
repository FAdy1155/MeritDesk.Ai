import type { ClosingStatementCoverageMark } from "@/services/skill-runner/skills/closing-statement";
import type { SkillViewProps } from "./types";
import { Badge, BulletList, CitationsList, Flags, Muted, ReportBody, Section, Table, humanize, toneClass } from "./primitives";

const COVERAGE_CLASS: Record<ClosingStatementCoverageMark, string> = {
  covered: toneClass.green,
  thin: toneClass.amber,
  absent: toneClass.red,
};

// Section 2's length guide for each format, shown next to the rendered page count.
const FORMAT_LENGTH = {
  long_numbered_format: "roughly four to seven pages",
  short_narrative_format: "roughly one and a half to two and a half pages",
} as const;

const AUTHORITY_SOURCE_LABELS = {
  house_default: "house default (INA section 208)",
  attorney_supplied: "supplied by the attorney",
} as const;

type ElementRow = { element: string; coverage?: ClosingStatementCoverageMark; whenMissing: string };

export function ClosingStatementView({ output, actions }: SkillViewProps<"closing-statement">) {
  const { formatChoice, closingStatement, elementCoverageCheck } = output;
  const { caption } = closingStatement;
  const documentId = closingStatement.generatedClosingStatementDocumentId;

  // Item 5's elements in the SKILL.md's order; the last two only "if applicable".
  const elementRows: ElementRow[] = [
    {
      element: "Past persecution or well-founded fear",
      coverage: elementCoverageCheck.pastPersecutionOrWellFoundedFear,
      whenMissing: "",
    },
    ...(elementCoverageCheck.nexusToEachGround.length > 0
      ? elementCoverageCheck.nexusToEachGround.map((row) => ({
          element: `Nexus: ${row.ground}`,
          coverage: row.coverage,
          whenMissing: "",
        }))
      : [{ element: "Nexus to a protected ground (none listed)", coverage: "absent" as const, whenMissing: "" }]),
    { element: "State protection", coverage: elementCoverageCheck.stateProtection, whenMissing: "" },
    { element: "Internal relocation", coverage: elementCoverageCheck.internalRelocation, whenMissing: "" },
    { element: "One-year deadline", coverage: elementCoverageCheck.oneYearDeadline, whenMissing: "not applicable" },
    { element: "Bars", coverage: elementCoverageCheck.bars, whenMissing: "not applicable" },
  ];

  // Section 8: an interview issue the letter does not answer is a blocker;
  // section 5: every element of eligibility must appear.
  const blockers = [
    ...output.issueCoverageCheck
      .filter((row) => !row.whereAnswered.trim())
      .map((row) => `Interview issue not answered in the letter: ${row.issue}`),
    ...elementRows.filter((row) => row.coverage === "absent").map((row) => `Element absent from the letter: ${row.element}`),
  ];

  const captionRows: { label: string; value: string | undefined; whenMissing?: string }[] = [
    { label: "Caption", value: humanize(caption.variant) },
    { label: "Applicant", value: caption.applicant },
    { label: "A number", value: caption.aNumber },
    { label: "Asylum office", value: caption.asylumOffice },
    { label: "Office address from", value: caption.officeAddressConfirmedFrom },
    { label: "Salutation", value: caption.salutation },
    { label: "Interview date", value: caption.interviewDate, whenMissing: "not given" },
    { label: "Date of submission", value: caption.submissionDate },
  ];

  return (
    <ReportBody>
      <Flags title="Blockers" items={blockers} />

      <Section title="Format choice">
        <p>
          <Badge label={formatChoice.format} tone="neutral" /> {formatChoice.reason}
        </p>
      </Section>

      <Section title="The closing statement">
        {documentId ? (
          <button
            type="button"
            onClick={() => actions.downloadDocument(documentId)}
            className="w-fit rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
          >
            Download closing statement (.docx)
          </button>
        ) : (
          <p>
            <Muted>No closing statement was generated in this run.</Muted>
          </p>
        )}
        {closingStatement.notGeneratedReason && (
          <p className="mt-1 text-amber-800 dark:text-amber-300">
            <strong>Why not generated:</strong> {closingStatement.notGeneratedReason}
          </p>
        )}
        <p className="mt-1 text-xs">
          <Muted>
            Attorney work product for review and signature by the responsible attorney; not ready to file until every
            fact, name, date and source is verified against the file.
          </Muted>
        </p>
        <p className="mt-1 text-xs">
          Pages: {closingStatement.pageCount}{" "}
          <Muted>({humanize(formatChoice.format)} runs {FORMAT_LENGTH[formatChoice.format]})</Muted>
        </p>

        <div className="mt-2">
          <strong>Caption</strong>
          <Table
            rows={captionRows}
            columns={[
              { header: "Field", cell: (row) => row.label },
              { header: "As printed", cell: (row) => row.value || <Muted>{row.whenMissing ?? "not given"}</Muted> },
            ]}
          />
        </div>

        <div className="mt-2">
          <strong>Sections in order</strong>
          {closingStatement.sectionsInOrder.length > 0 ? (
            <BulletList className="text-xs" items={closingStatement.sectionsInOrder} />
          ) : (
            <p className="text-xs">
              <Muted>No headings (the short narrative format has none).</Muted>
            </p>
          )}
        </div>

        <div className="mt-2">
          <strong>Derivative applicants named</strong>
          {closingStatement.derivativeApplicantsNamed.length > 0 ? (
            <BulletList className="text-xs" items={closingStatement.derivativeApplicantsNamed} />
          ) : (
            <p className="text-xs">
              <Muted>None named.</Muted>
            </p>
          )}
        </div>

        <div className="mt-2">
          <strong>Country conditions sources</strong>
          <Table
            rows={closingStatement.countryConditionsSources}
            empty="None cited."
            columns={[
              { header: "Source", cell: (row) => row.source },
              { header: "Date", cell: (row) => row.date },
              { header: "Record document", cell: (row) => row.recordDocument },
            ]}
          />
        </div>

        <div className="mt-2">
          <strong>Authorities cited</strong>
          <CitationsList
            items={closingStatement.authoritiesCited.map((a) => ({
              citation: a.citation,
              verified: a.verified,
              note: a.url ? `${AUTHORITY_SOURCE_LABELS[a.source]}; confirmed at ${a.url}` : AUTHORITY_SOURCE_LABELS[a.source],
            }))}
          />
        </div>
      </Section>

      <Section title="Gap list">
        <Table
          rows={output.gapList}
          empty="No gaps reported."
          columns={[
            { header: "Gap", cell: (row) => row.gap },
            { header: "What would close it", cell: (row) => row.whatWouldCloseIt },
            {
              header: "Placeholder in draft",
              cell: (row) => (row.placeholderInDraft ? <code>{row.placeholderInDraft}</code> : <Muted>none</Muted>),
            },
          ]}
        />
      </Section>

      <Section title="Issue coverage check">
        <Table
          rows={output.issueCoverageCheck}
          empty="No interview issues listed."
          columns={[
            { header: "Issue raised at interview", cell: (row) => row.issue },
            {
              header: "Where answered",
              cell: (row) =>
                row.whereAnswered.trim() ? row.whereAnswered : <Badge label="not answered: blocker" tone="red" />,
            },
          ]}
        />
      </Section>

      <Section title="Element coverage check">
        <Table
          rows={elementRows}
          columns={[
            { header: "Element", cell: (row) => row.element },
            {
              header: "Coverage",
              cell: (row) =>
                row.coverage ? (
                  <Badge label={row.coverage} className={COVERAGE_CLASS[row.coverage]} />
                ) : (
                  <Muted>{row.whenMissing}</Muted>
                ),
            },
          ]}
        />
      </Section>
    </ReportBody>
  );
}
