import type { SkillViewProps } from "./types";
import { Badge, Callout, CitationsList, Flags, Muted, ReportBody, Section, Table, type Tone } from "./primitives";

type Output = SkillViewProps<"eoir-filing-compliance">["output"];
type Citation = Output["passedChecks"][number]["cites"][number];
type Defect = Output["failures"][number];

const VERDICT_TONE: Record<Output["verdict"]["label"], Tone> = {
  READY_TO_FILE: "green",
  FILE_AFTER_FIXES: "amber",
  DO_NOT_FILE_YET: "red",
};

function Cites({ items }: { items: Citation[] }) {
  if (items.length === 0) return <Muted>No cite given</Muted>;
  return <CitationsList items={items.map((c) => ({ citation: c.citation, verified: c.verified, note: c.url }))} />;
}

// Failures and Fixes share the template's "same format".
function DefectTable({ rows }: { rows: Defect[] }) {
  return (
    <Table
      rows={rows}
      empty="None found."
      columns={[
        { header: "#", cell: (_row, i) => i + 1 },
        { header: "What is wrong", cell: (row) => row.whatIsWrong },
        { header: "Where in the packet", cell: (row) => row.whereInThePacket },
        { header: "Cite", cell: (row) => <Cites items={row.cites} /> },
        { header: "Exact fix", cell: (row) => row.exactFix },
      ]}
    />
  );
}

export function EoirFilingComplianceView({ output }: SkillViewProps<"eoir-filing-compliance">) {
  const { liveManualVerification, verdict, deadlineCheck } = output;

  return (
    <ReportBody>
      <Section title={`Filing Compliance Report: ${output.filingTitle}`}>
        <p>
          <strong>Venue:</strong> {output.venue} | <strong>Filing type:</strong> {output.filingType} |{" "}
          <strong>Manual:</strong> <Badge label={output.manual} tone="neutral" />
        </p>
        <p className="mt-1">
          <strong>Checked:</strong> {output.checked} | <strong>Live-manual verification:</strong>{" "}
          <Badge label={liveManualVerification.status} tone={liveManualVerification.status === "done" ? "green" : "amber"} />
        </p>
        <div className="mt-2">
          <Table
            rows={liveManualVerification.volatileItems}
            empty="No fee or deadline item applies to this filing."
            columns={[
              { header: "Item", cell: (row) => row.item },
              {
                header: "Live source",
                cell: (row) => (
                  <Badge label={row.verified ? "verified" : "unverified"} tone={row.verified ? "green" : "amber"} />
                ),
              },
              { header: "URL", cell: (row) => <span className="break-all">{row.url}</span> },
              { header: "Result", cell: (row) => row.result },
            ]}
          />
        </div>
      </Section>

      <Section title="Verdict">
        <p>
          <Badge label={verdict.label} tone={VERDICT_TONE[verdict.label]} /> {verdict.why}
        </p>
      </Section>

      {output.failures.length > 0 ? (
        <Callout title="Failures (will cause rejection, exclusion, or denial)">
          <DefectTable rows={output.failures} />
        </Callout>
      ) : (
        <Section title="Failures (will cause rejection, exclusion, or denial)">
          <Muted>None found.</Muted>
        </Section>
      )}

      <Section title="Fixes (curable defects and risks)">
        <DefectTable rows={output.fixes} />
      </Section>

      {output.couldNotVerify && output.couldNotVerify.length > 0 ? (
        <Flags
          title="Could not verify"
          tone="amber"
          items={output.couldNotVerify.map((c, i) => (
            <span key={i}>
              {c.whatCouldNotBeChecked} <Muted>Confirm: {c.whatTheAttorneyShouldConfirm}</Muted>
            </span>
          ))}
        />
      ) : (
        <Section title="Could not verify">
          <Muted>Nothing reported as unverifiable from the documents provided.</Muted>
        </Section>
      )}

      <Section title="Deadline check">
        {deadlineCheck.deadlines.length === 0 ? (
          <p>
            <Muted>{deadlineCheck.noDeadlineStatement ?? "No deadline applies."}</Muted>
          </p>
        ) : (
          <>
            <Table
              rows={deadlineCheck.deadlines}
              rowClassName={(row) => (row.cuttingItClose ? "bg-amber-50 dark:bg-amber-950" : "")}
              columns={[
                { header: "Governing deadline", cell: (row) => row.governingDeadline },
                { header: "Day count", cell: (row) => row.dayCount },
                {
                  header: "Margin",
                  cell: (row) => (
                    <>
                      {row.margin}{" "}
                      {row.cuttingItClose === true && <Badge label="cutting it close" tone="red" />}
                      {row.cuttingItClose === null && <Badge label="margin unknown" tone="amber" />}
                    </>
                  ),
                },
                {
                  header: "Manual and regulation conflict",
                  cell: (row) =>
                    row.manualRegulationConflict ? (
                      <span className="text-amber-800 dark:text-amber-300">{row.manualRegulationConflict}</span>
                    ) : (
                      <Muted>None noted</Muted>
                    ),
                },
                { header: "Cite", cell: (row) => <Cites items={row.cites} /> },
              ]}
            />
            {deadlineCheck.noDeadlineStatement && (
              <p className="mt-1">
                <Muted>{deadlineCheck.noDeadlineStatement}</Muted>
              </p>
            )}
          </>
        )}
      </Section>

      <Section title="Passed checks">
        <Table
          rows={output.passedChecks}
          columns={[
            { header: "Category", cell: (row) => row.category },
            { header: "Cite", cell: (row) => <Cites items={row.cites} /> },
          ]}
        />
      </Section>
    </ReportBody>
  );
}
