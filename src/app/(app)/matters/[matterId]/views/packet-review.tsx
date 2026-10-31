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
} from "./primitives";

export function PacketReviewView({ output }: SkillViewProps<"packet-review">) {
  const { packetSnapshot, declarationFindings } = output;
  return (
    <ReportBody>
      <Section title="Packet snapshot">
        <p>
          {packetSnapshot.respondent} - {packetSnapshot.country} - relief: {packetSnapshot.relief.join(", ")} -{" "}
          {packetSnapshot.venueOrCircuit}
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

      <Section title="I-589 findings">
        <Table
          rows={output.i589Findings}
          columns={[
            { header: "Part", cell: (row) => row.part },
            { header: "Issue", cell: (row) => row.issue },
            { header: "Location", cell: (row) => row.location },
            { header: "Recommended edit", cell: (row) => row.recommendedEdit },
          ]}
        />
      </Section>

      <Section title="Declaration findings">
        <Table
          rows={declarationFindings.elementCoverage}
          columns={[
            { header: "Element", cell: (row) => row.element },
            { header: "Coverage", cell: (row) => <Badge label={row.coverage} className={coverageColor[row.coverage]} /> },
          ]}
        />
        <p className="mt-2">
          <strong>Nexus read:</strong> {declarationFindings.nexusRead}
        </p>
        {declarationFindings.credibilityRisks.length > 0 && (
          <div className="mt-2">
            <strong>Credibility risks:</strong>
            <BulletList items={declarationFindings.credibilityRisks} />
          </div>
        )}
        {declarationFindings.strengtheningSuggestions.length > 0 && (
          <div className="mt-2">
            <strong>Strengthening suggestions:</strong>
            <BulletList items={declarationFindings.strengtheningSuggestions} />
          </div>
        )}
      </Section>

      <Section title="Nexus & legal alignment">
        <Table
          rows={output.nexusAndLegalAlignment}
          columns={[
            { header: "Element", cell: (row) => row.element },
            { header: "Alignment", cell: (row) => <Badge label={row.alignment} className={coverageColor[row.alignment]} /> },
            { header: "Notes", cell: (row) => row.notes },
          ]}
        />
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

      <Section title="Case law to review">
        <CitationsList items={output.caseLawToReview.map((c) => ({ citation: c.citation, verified: c.verified, note: c.why }))} />
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
