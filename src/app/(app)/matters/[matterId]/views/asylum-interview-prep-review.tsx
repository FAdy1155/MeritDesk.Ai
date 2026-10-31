import type { ReactNode } from "react";
import type { SkillViewProps } from "./types";
import {
  Badge,
  BulletList,
  Callout,
  ChecklistList,
  Flags,
  Muted,
  ReportBody,
  Section,
  Table,
  toneClass,
  yesNo,
} from "./primitives";

type Output = SkillViewProps<"asylum-interview-prep-review">["output"];
type Finding = Output["blocking"][number];
type CoverageRow = Output["twoCoverageTables"]["required"][number];

const verdictClass: Record<Output["verdict"]["result"], string> = {
  PASS: toneClass.green,
  FAIL: toneClass.red,
  CANNOT_CERTIFY: toneClass.amber,
};

const priorityClass: Record<Output["prioritizedEditChecklist"][number]["priority"], string> = {
  BLOCKING: toneClass.red,
  "SHOULD-FIX": toneClass.amber,
  OPTIONAL: toneClass.neutral,
};

const draftTypeLabel = {
  client: "Adapted to a specific client",
  template: "Generic reusable template",
} as const;

/** One finding as list items: location and rules, the quoted question, the problem, the fix. */
function findingItems(findings: Finding[]): ReactNode[] {
  return findings.map((f, i) => (
    <span key={i}>
      <strong>{f.location}</strong>
      {f.rulesViolated.length > 0 && <Muted> [{f.rulesViolated.join(", ")}]</Muted>}
      {f.quotedQuestion && <span className="block text-xs italic">{`"${f.quotedQuestion}"`}</span>}
      <span className="block">{f.problem}</span>
      <span className="block text-xs">
        <Muted>Fix: {f.fix}</Muted>
      </span>
    </span>
  ));
}

function CoverageTable({ rows, gapClassName }: { rows: CoverageRow[]; gapClassName: string }) {
  return (
    <Table
      rows={rows}
      rowClassName={(row) => (row.coveringPart.trim() ? "" : gapClassName)}
      columns={[
        { header: "Item", cell: (row) => row.item },
        {
          header: "Covered in",
          cell: (row) => (row.coveringPart.trim() ? row.coveringPart : <strong>not covered</strong>),
        },
      ]}
    />
  );
}

export function AsylumInterviewPrepReviewView({ output }: SkillViewProps<"asylum-interview-prep-review">) {
  const { draftSnapshot: snapshot, twoCoverageTables: coverage, verdict } = output;
  const { recordGapFlags } = snapshot;

  return (
    <ReportBody>
      <Section title="Draft snapshot">
        <p>
          {snapshot.clientOrTemplate ? draftTypeLabel[snapshot.clientOrTemplate] : "Draft type not established"}
          {snapshot.clientName ? ` - ${snapshot.clientName}` : ""}
        </p>
        <p>
          {snapshot.country} - {snapshot.claimType} - {snapshot.venue}
        </p>
        <ul className="mt-1 text-xs text-black/60 dark:text-white/60">
          <li>Two-version format (counsel version plus client practice guide): {yesNo(snapshot.twoVersionFormat)}</li>
          <li>
            Record-gap flags: {recordGapFlags.count}
            {recordGapFlags.collectedInListAtEnd !== null &&
              `, collected in a list at the end: ${yesNo(recordGapFlags.collectedInListAtEnd)}`}
          </li>
          <li>Documents reviewed: {snapshot.documentsReviewed.join(", ") || "none"}</li>
        </ul>
        {snapshot.notProvided.length > 0 && (
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
            Not provided: {snapshot.notProvided.join(", ")}
          </p>
        )}
      </Section>

      <Section title="Coverage tables">
        <p className="mb-1 text-xs">
          <Muted>Required (C1); any item missing is blocking.</Muted>
        </p>
        <CoverageTable rows={coverage.required} gapClassName="bg-red-50 dark:bg-red-950" />
        <p className="mb-1 mt-2 text-xs">
          <Muted>Recommended (C2); any item missing is should-fix.</Muted>
        </p>
        <CoverageTable rows={coverage.recommended} gapClassName="bg-amber-50 dark:bg-amber-950" />
      </Section>

      {output.blocking.length > 0 ? (
        <Flags title={`BLOCKING (${output.blocking.length})`} items={findingItems(output.blocking)} />
      ) : (
        <Section title="BLOCKING">
          <Muted>No blocking findings.</Muted>
        </Section>
      )}

      <Section title={`SHOULD-FIX (${output.shouldFix.length})`}>
        {output.shouldFix.length > 0 ? (
          <BulletList className="space-y-1" items={findingItems(output.shouldFix)} />
        ) : (
          <Muted>None.</Muted>
        )}
      </Section>

      {output.unverified.length > 0 ? (
        <Flags
          title={`UNVERIFIED (${output.unverified.length}): checks not performed`}
          tone="amber"
          items={output.unverified.map((u, i) => (
            <span key={i}>
              <strong>{u.check}</strong> - needs: {u.whatIsNeeded}
            </span>
          ))}
        />
      ) : (
        <Section title="UNVERIFIED">
          <Muted>Every check was performed.</Muted>
        </Section>
      )}

      <Section title={`OPTIONAL (${output.optional.length})`}>
        {output.optional.length > 0 ? (
          <BulletList className="space-y-1" items={findingItems(output.optional)} />
        ) : (
          <Muted>None.</Muted>
        )}
      </Section>

      {output.escalationFlags.length > 0 ? (
        <Flags title="Escalation flags" items={output.escalationFlags} />
      ) : (
        <Section title="Escalation flags">
          <Muted>None.</Muted>
        </Section>
      )}

      <Callout title="Verdict" tone="neutral">
        <p>
          <Badge label={verdict.result} className={verdictClass[verdict.result]} />
          {verdict.whatWouldConvertIt && <span> What would convert it: {verdict.whatWouldConvertIt}</span>}
        </p>
        <p className="mt-2 text-xs font-medium">Recommended gaps (departures from the house standard, not defects in it)</p>
        {verdict.recommendedGaps.length > 0 ? (
          <BulletList className="text-xs" items={verdict.recommendedGaps} />
        ) : (
          <p className="text-xs">
            <Muted>None.</Muted>
          </p>
        )}
      </Callout>

      <Section title="Officer questions this draft does not prepare the client for">
        {output.officerQuestionsThisDraftDoesNotPrepareTheClientFor.length > 0 ? (
          <BulletList items={output.officerQuestionsThisDraftDoesNotPrepareTheClientFor} />
        ) : (
          <Muted>None found.</Muted>
        )}
      </Section>

      <Section title="Prioritized edit checklist">
        <ChecklistList
          items={output.prioritizedEditChecklist.map((item) => ({
            badge: item.priority,
            badgeClassName: priorityClass[item.priority],
            content: item.item,
          }))}
        />
      </Section>

      <Section title="Point in the claim most exposed">
        <p>{output.mostExposedPointInTheClaim}</p>
      </Section>
    </ReportBody>
  );
}
