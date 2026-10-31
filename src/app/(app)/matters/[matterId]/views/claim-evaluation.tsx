import type { SkillViewProps } from "./types";
import { Badge, BulletList, Flags, Muted, ReportBody, Section, Table, ratingColor } from "./primitives";

export function ClaimEvaluationView({ output }: SkillViewProps<"claim-evaluation">) {
  const { caseSnapshot } = output;
  const keyDates = [
    ["Entry", caseSnapshot.keyDates.entryDate],
    ["NTA", caseSnapshot.keyDates.ntaDate],
    ["One-year clock", caseSnapshot.keyDates.oneYearClockDate],
    ["Next hearing", caseSnapshot.keyDates.nextHearingDate],
  ].filter(([, date]) => Boolean(date));

  return (
    <ReportBody>
      <Section title="Case snapshot">
        <p>
          {caseSnapshot.respondent} - {caseSnapshot.country} - relief: {caseSnapshot.reliefEvaluated.join(", ")} -
          posture: {caseSnapshot.postureApplied}
        </p>
        {keyDates.length > 0 && (
          <p className="text-xs">
            <Muted>{keyDates.map(([label, date]) => `${label}: ${date}`).join(" | ")}</Muted>
          </p>
        )}
      </Section>

      <Section title="Element scorecard">
        <Table
          rows={output.elementScorecard}
          columns={[
            { header: "Element", cell: (row) => row.element },
            { header: "Rating", cell: (row) => <Badge label={row.rating} className={ratingColor[row.rating]} /> },
            { header: "Basis", cell: (row) => row.basis },
            { header: "Would strengthen", cell: (row) => row.whatWouldStrengthen },
            { header: "Authority", cell: (row) => row.authorityAnchor },
          ]}
        />
      </Section>

      <Flags
        title="Bars & escalation flags"
        items={output.barsAndEscalationFlags.map((f, i) => (
          <span key={i}>
            <strong>{f.flag}</strong>: {f.detail}
          </span>
        ))}
      />

      <Section title="Reads of the record">
        <BulletList items={output.readsOfTheRecord} />
      </Section>

      <Section title="Options for the attorney">
        <BulletList
          items={output.optionsForAttorney.map((o, i) => (
            <span key={i}>
              <strong>{o.relief}</strong>: {o.framing}
            </span>
          ))}
        />
      </Section>
    </ReportBody>
  );
}
