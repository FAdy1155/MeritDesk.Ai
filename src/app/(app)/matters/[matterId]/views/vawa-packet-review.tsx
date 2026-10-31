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
  coverageColor,
  humanize,
  severityColor,
  verdictColor,
  yesNo,
} from "./primitives";

export function VawaPacketReviewView({ output }: SkillViewProps<"vawa-packet-review">) {
  const { verdictAndDefectCounts: verdict, inventoryAndPosture: inventory, evidenceSufficiencyAudit: evidence } = output;
  const evidenceNotes: [string, string[], string][] = [
    ["Supported only by the declaration", evidence.elementsSupportedByDeclarationOnly, "text-amber-800 dark:text-amber-300"],
    ["Translation issues", evidence.translationIssues, "text-red-800 dark:text-red-300"],
    ["Contradictory exhibits", evidence.contradictoryExhibits, "text-red-800 dark:text-red-300"],
    ["Exhibits supporting nothing", evidence.unsupportedExhibits, "text-black/60 dark:text-white/60"],
    ["Legibility issues", evidence.legibilityIssues, "text-black/60 dark:text-white/60"],
    ["Third-party declaration issues", evidence.thirdPartyDeclarationIssues, "text-black/60 dark:text-white/60"],
  ];

  return (
    <ReportBody>
      <Callout title="Verdict" tone="neutral">
        <p>
          <Badge label={verdict.verdict} className={verdictColor[verdict.verdict]} /> {verdict.blockerCount} blocker(s),{" "}
          {verdict.materialCount} material, {verdict.polishCount} polish
        </p>
      </Callout>

      <Flags
        title="Safety, conflict & 1367 flags"
        items={output.safetyConflictAndConfidentialityFlags.map((f, i) => (
          <span key={i}>
            <strong>{f.type}</strong>: {f.detail}
          </span>
        ))}
      />

      <Section title="Inventory & posture">
        <p>
          Abuser: {humanize(inventory.abuserStatus)} - {inventory.marriageStatus} - client{" "}
          {humanize(inventory.clientLocation)}
        </p>
        <ul className="mt-1 text-xs text-black/60 dark:text-white/60">
          {inventory.removalPosture && <li>Removal posture: {inventory.removalPosture}</li>}
          <li>I-485 and I-765 included: {yesNo(inventory.i485AndI765Included)}</li>
          <li>Intended filing sequence: {inventory.intendedFilingSequence}</li>
          {inventory.derivatives.length > 0 && (
            <li>
              Derivatives: {inventory.derivatives.map((d) => `${d.name} (${d.ageAtFiling} at filing)`).join(", ")}
            </li>
          )}
          {inventory.documentsReferencedButMissing.length > 0 && (
            <li>Referenced but missing: {inventory.documentsReferencedButMissing.join(", ")}</li>
          )}
        </ul>
      </Section>

      <Section title="Element-by-element audit">
        <div className="flex flex-col gap-2">
          {output.elementByElementAudit.map((row, i) => (
            <div key={i} className="rounded-md border border-black/10 p-2 dark:border-white/10">
              <p>
                <strong>{row.element}</strong> <Badge label={row.rating} className={coverageColor[row.rating]} />
              </p>
              <p className="text-xs">
                <Muted>Authority: {row.authority}</Muted>
              </p>
              <p className="text-xs">
                <Muted>Supported at: {row.whereSupported}</Muted>
              </p>
              <p className="text-xs">
                <Muted>{row.whatIsMissingOrWeak}</Muted>
              </p>
              {row.defects.length > 0 && (
                <div className="mt-1">
                  <ChecklistList
                    items={row.defects.map((d) => ({
                      badge: d.severity,
                      badgeClassName: severityColor[d.severity],
                      content: (
                        <>
                          {d.detail} - <Muted>{d.fix}</Muted>
                        </>
                      ),
                    }))}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Declaration strength score">
        <Table
          rows={output.declarationStrengthScore.dimensionScores}
          columns={[
            { header: "Dimension", cell: (row) => row.dimension },
            { header: "Score", cell: (row) => `${row.score}/5` },
            { header: "Justification", cell: (row) => row.justification },
          ]}
        />
        <p className="mt-2">
          <strong>Overall verdict:</strong>{" "}
          <Badge
            label={output.declarationStrengthScore.overallVerdict}
            className={verdictColor[output.declarationStrengthScore.overallVerdict]}
          />
        </p>
        {output.declarationStrengthScore.redFlags.length > 0 && (
          <BulletList className="mt-1 text-amber-800 dark:text-amber-300" items={output.declarationStrengthScore.redFlags} />
        )}
      </Section>

      <Section title="Cross-document reconciliation">
        <Table
          rows={output.crossDocumentReconciliation}
          rowClassName={(row) => (row.match ? "" : "bg-red-50 dark:bg-red-950")}
          columns={[
            { header: "Fact", cell: (row) => row.fact },
            { header: "I-360", cell: (row) => row.i360 },
            { header: "I-485", cell: (row) => row.i485 },
            { header: "I-765", cell: (row) => row.i765 },
            { header: "Declaration", cell: (row) => row.declaration },
            { header: "Exhibits", cell: (row) => row.exhibits },
            { header: "Match?", cell: (row) => (row.match ? "yes" : "NO") },
          ]}
        />
      </Section>

      <Section title="Evidence sufficiency audit">
        <Table
          rows={evidence.exhibitToElementMap}
          columns={[
            { header: "Exhibit", cell: (row) => row.exhibit },
            { header: "Supports", cell: (row) => row.supportsElements.join(", ") || "nothing" },
          ]}
        />
        {evidenceNotes
          .filter(([, items]) => items.length > 0)
          .map(([label, items, className]) => (
            <p key={label} className={`mt-1 text-xs ${className}`}>
              {label}: {items.join(", ")}
            </p>
          ))}
        {evidence.psychEvalIssues && (
          <p className="mt-1 text-xs">
            <Muted>Psychological evaluation: {evidence.psychEvalIssues}</Muted>
          </p>
        )}
      </Section>

      <Section title="Form mechanics audit">
        <ChecklistList
          items={output.formMechanicsAudit.map((row) => ({
            badge: row.severity,
            badgeClassName: severityColor[row.severity],
            content: `${row.form}: ${row.issue}`,
          }))}
        />
      </Section>

      <Section title="Inadmissibility & GMC audit">
        <Table
          rows={output.inadmissibilityAndGmcAudit}
          columns={[
            { header: "Ground", cell: (row) => row.ground },
            { header: "Status", cell: (row) => row.status },
          ]}
        />
      </Section>

      <Section title="Anticipated RFE & interview exposure">
        <BulletList
          items={output.anticipatedRfeAndInterviewExposure.map((row, i) => (
            <span key={i}>
              <strong>{row.question}</strong> - answered by: {row.whatAnswersIt || "nothing yet"}
              {row.whatDoesNot && <span className="text-amber-800 dark:text-amber-300"> ({row.whatDoesNot})</span>}
            </span>
          ))}
        />
      </Section>

      <Section title="Prioritized edit checklist">
        <ChecklistList
          items={output.prioritizedEditChecklist.map((item) => ({
            badge: item.priority,
            badgeClassName: severityColor[item.priority],
            content: (
              <>
                {item.fix} - <Muted>{item.location} ({item.responsibleParty})</Muted>
              </>
            ),
          }))}
        />
      </Section>

      <Section title="Authorities relied on">
        <CitationsList items={output.authoritiesRelied} />
      </Section>

      <Flags title="Escalation flags" items={output.escalationFlags} />
    </ReportBody>
  );
}
