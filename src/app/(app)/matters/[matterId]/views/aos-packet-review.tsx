import type { SkillViewProps } from "./types";
import {
  Badge,
  BulletList,
  ChecklistList,
  CitationsList,
  Flags,
  Muted,
  ReportBody,
  Section,
  Table,
  coverageColor,
  priorityColor,
  statusColor,
  yesNo,
} from "./primitives";

export function AosPacketReviewView({ output }: SkillViewProps<"aos-packet-review">) {
  const { packetSnapshot, i864Sufficiency, bonaFideMarriageAssessment } = output;
  return (
    <ReportBody>
      <Section title="Packet snapshot">
        <p>
          {packetSnapshot.petitioner} & {packetSnapshot.beneficiary} - married {packetSnapshot.marriageDate}
          {packetSnapshot.conditionalAtApproval ? " (conditional at approval)" : ""} - {packetSnapshot.filingType}
        </p>
        <p className="text-xs">
          <Muted>Manner of entry: {packetSnapshot.mannerOfEntry}</Muted>
        </p>
        {packetSnapshot.documentsReviewed.length > 0 && (
          <p className="text-xs">
            <Muted>Reviewed: {packetSnapshot.documentsReviewed.join(", ")}</Muted>
          </p>
        )}
        {packetSnapshot.documentsNotProvided.length > 0 && (
          <p className="text-xs">
            <Muted>Not provided: {packetSnapshot.documentsNotProvided.join(", ")}</Muted>
          </p>
        )}
      </Section>

      <Flags title="Blocking issues" items={output.blockingIssues} />

      <Section title="Form findings">
        <Table
          rows={output.formFindings}
          columns={[
            { header: "Form", cell: (row) => row.form },
            { header: "Issue", cell: (row) => row.issue },
            { header: "Location", cell: (row) => row.location },
            { header: "Recommended edit", cell: (row) => row.recommendedEdit },
          ]}
        />
      </Section>

      <Section title="Adjustment eligibility & bars">
        <Table
          rows={output.adjustmentEligibilityAndBars}
          columns={[
            { header: "Basis", cell: (row) => row.basis },
            { header: "Status", cell: (row) => <Badge label={row.status} className={statusColor[row.status]} /> },
            { header: "Notes", cell: (row) => row.notes },
          ]}
        />
      </Section>

      <Section title="Inadmissibility screen">
        <Table
          rows={output.inadmissibilityScreen}
          columns={[
            { header: "Ground", cell: (row) => row.ground },
            { header: "Status", cell: (row) => <Badge label={row.status} className={statusColor[row.status]} /> },
            { header: "Notes", cell: (row) => row.notes },
          ]}
        />
      </Section>

      <Section title="I-864 sufficiency">
        <p>
          Household size {i864Sufficiency.householdSize} - income meets threshold:{" "}
          {yesNo(i864Sufficiency.incomeMeetsThreshold)} - evidence complete: {yesNo(i864Sufficiency.evidenceComplete)}
        </p>
        <p className="text-xs">
          <Muted>{i864Sufficiency.jointSponsorOrHouseholdMemberStatus}</Muted>
        </p>
      </Section>

      <Section title="Bona fide marriage assessment">
        <Table
          rows={bonaFideMarriageAssessment.coverageByCategory}
          columns={[
            { header: "Category", cell: (row) => row.category },
            { header: "Rating", cell: (row) => <Badge label={row.rating} className={coverageColor[row.rating]} /> },
            { header: "Notes", cell: (row) => row.notes },
          ]}
        />
        <p className="mt-2">{bonaFideMarriageAssessment.timelineRead}</p>
        {bonaFideMarriageAssessment.strengtheningSteps.length > 0 && (
          <BulletList className="mt-1" items={bonaFideMarriageAssessment.strengtheningSteps} />
        )}
      </Section>

      <Section title="Consistency log">
        <BulletList
          items={output.consistencyLog.map((c, i) => (
            <span key={i}>
              {c.discrepancy} - <Muted>{c.whereItAppears}</Muted>
            </span>
          ))}
        />
      </Section>

      <Section title="Authorities to review">
        <CitationsList
          items={output.authoritiesToReview.map((a) => ({ citation: a.citation, verified: a.verified, note: a.why }))}
        />
      </Section>

      <Flags title="Escalation flags" items={output.escalationFlags} />

      <Section title="Prioritized edit checklist">
        <ChecklistList
          items={output.prioritizedEditChecklist.map((item) => ({
            badge: item.priority,
            badgeClassName: priorityColor[item.priority],
            content: item.item,
          }))}
        />
      </Section>
    </ReportBody>
  );
}
