import type { ReactNode } from "react";
import type { VawaPacketBuildOutput } from "@/services/skill-runner/skills/vawa-packet-build";
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

type FormItem =
  | VawaPacketBuildOutput["formI360AnswerTableAndFilledPdf"]
  | VawaPacketBuildOutput["formI485AnswerTableAndFilledPdf"]
  | VawaPacketBuildOutput["formI765AnswerTableAndFilledPdf"];
type Authority = VawaPacketBuildOutput["coverLetter"]["authoritiesCited"][number];
type ReviewReport = NonNullable<VawaPacketBuildOutput["vawaPacketReviewAndOrthographyCheckReports"]["vawaPacketReviewReport"]>;
type OrthographyReport = VawaPacketBuildOutput["vawaPacketReviewAndOrthographyCheckReports"]["orthographyCheckReports"][number];

const BUTTON_CLASS = "w-fit rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black";

const SCOPE_TONE: Record<VawaPacketBuildOutput["packetSnapshot"]["scope"], string> = {
  abused_spouse: toneClass.green,
  intended_spouse: toneClass.green,
  spouse_whose_child_was_abused: toneClass.green,
  abused_child_out_of_scope: toneClass.red,
  abused_parent_out_of_scope: toneClass.red,
};

function ListOrNone({ items }: { items: ReactNode[] }) {
  return items.length > 0 ? <BulletList items={items} /> : <Muted>None.</Muted>;
}

function DownloadButton({
  documentId,
  label,
  missing,
  onDownload,
}: {
  documentId: string;
  label: string;
  missing: ReactNode;
  onDownload: (documentId: string) => void;
}) {
  return documentId ? (
    <button type="button" onClick={() => onDownload(documentId)} className={BUTTON_CLASS}>
      {label}
    </button>
  ) : (
    <Muted>{missing}</Muted>
  );
}

/** Label / value rows for a fixed set of facts. */
function FactTable({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <Table
      rows={rows}
      columns={[
        { header: "Item", cell: (row) => row[0] },
        { header: "Value", cell: (row) => row[1] },
      ]}
    />
  );
}

type BadgeTone = keyof typeof toneClass;

/** yes / no / unknown (null: the skill could not determine it). */
function YesNoBadge({ value, yesTone = "green", noTone = "red" }: { value: boolean | null; yesTone?: BadgeTone; noTone?: BadgeTone }) {
  if (value === null) return <Badge label="unknown" tone="amber" />;
  return <Badge label={yesNo(value)} tone={value ? yesTone : noTone} />;
}

function citationItems(authorities: Authority[]) {
  return authorities.map((a) => ({
    citation: a.citation,
    verified: a.verified,
    note: a.verified ? (a.url ? a.url : undefined) : `VERIFY CITE${a.url ? ` (${a.url})` : ""}`,
  }));
}

function FormSection({
  title,
  form,
  extra,
  pdfLabel,
  onDownload,
}: {
  title: string;
  form: FormItem;
  extra: [string, ReactNode][];
  pdfLabel: string;
  onDownload: (documentId: string) => void;
}) {
  return (
    <Section title={title}>
      <div className="flex flex-col gap-2">
        <FactTable
          rows={[
            [
              "Edition used",
              <span key="edition">
                {form.editionUsed || <Muted>none</Muted>}{" "}
                <Badge label={form.editionVerified ? "verified this run" : "ATTORNEY: VERIFY"} tone={form.editionVerified ? "green" : "amber"} />
              </span>,
            ],
            ...extra,
            ["Blank form used", form.blankFormDocument ?? <Muted>none</Muted>],
            ["PDF fill note", form.pdfFillNote],
          ]}
        />
        <DownloadButton
          documentId={form.generatedFilledPdfDocumentId}
          label={pdfLabel}
          missing="No filled PDF in this run: the PDF fill is pending (see the note above)."
          onDownload={onDownload}
        />
        <Table
          rows={form.answerTable}
          empty="No answer table."
          rowClassName={(row) => (/\[CLARIFY WITH CLIENT/i.test(row.answer) ? "bg-amber-50 dark:bg-amber-950" : "")}
          columns={[
            { header: "Item", cell: (row) => row.item },
            { header: "Question", cell: (row) => row.question },
            { header: "Answer", cell: (row) => row.answer },
            { header: "Source", cell: (row) => <Muted>{row.source}</Muted> },
          ]}
        />
      </div>
    </Section>
  );
}

function ReviewReportView({ report }: { report: ReviewReport }) {
  const counts = report.verdictAndDefectCounts;
  const evidence = report.evidenceSufficiencyAudit;
  const inventory = report.inventoryAndPosture;
  const score = report.declarationStrengthScore;
  return (
    <div className="flex flex-col gap-3">
      <Section title="1. Verdict and defect counts">
        <p>
          <Badge label={counts.verdict} /> <Muted>Blocker {counts.blockerCount} - Material {counts.materialCount} - Polish {counts.polishCount}</Muted>
        </p>
      </Section>

      <Section title="2. Safety, conflict, and 1367 flags">
        {report.safetyConflictAndConfidentialityFlags.length > 0 ? (
          <Flags
            title="Review flags"
            items={report.safetyConflictAndConfidentialityFlags.map((f, i) => (
              <span key={i}>
                <strong>{f.type}:</strong> {f.detail}
              </span>
            ))}
          />
        ) : (
          <Muted>None.</Muted>
        )}
      </Section>

      <Section title="3. Inventory and posture">
        <FactTable
          rows={[
            [
              "Abuser's status",
              inventory.abuserStatus === "unknown" ? <Badge key="as" label="unknown" tone="amber" /> : humanize(inventory.abuserStatus),
            ],
            ["Marriage status", inventory.marriageStatus],
            [
              "Client location",
              inventory.clientLocation === "unknown" ? <Badge key="cl" label="unknown" tone="amber" /> : humanize(inventory.clientLocation),
            ],
            ["Removal posture", inventory.removalPosture ?? <Muted>not stated</Muted>],
            [
              "Derivatives",
              <ListOrNone
                key="derivatives"
                items={inventory.derivatives.map((d, i) => (
                  <span key={i}>
                    {d.name} (age at filing: {d.ageAtFiling})
                  </span>
                ))}
              />,
            ],
            ["I-485 and I-765 included", yesNo(inventory.i485AndI765Included)],
            ["Intended filing sequence", inventory.intendedFilingSequence],
            ["Referenced but missing", <ListOrNone key="missing" items={inventory.documentsReferencedButMissing} />],
          ]}
        />
      </Section>

      <Section title="4. Element-by-element audit">
        <Table
          rows={report.elementByElementAudit}
          columns={[
            { header: "Element", cell: (row) => row.element },
            { header: "Authority", cell: (row) => <Muted>{row.authority}</Muted> },
            { header: "Rating", cell: (row) => <Badge label={row.rating} /> },
            { header: "Where supported", cell: (row) => row.whereSupported },
            { header: "Missing or weak", cell: (row) => row.whatIsMissingOrWeak },
            {
              header: "Defects",
              cell: (row) => (
                <ChecklistList
                  items={row.defects.map((d) => ({
                    badge: d.severity,
                    content: (
                      <>
                        {d.detail} <Muted>Fix: {d.fix}</Muted>
                      </>
                    ),
                  }))}
                />
              ),
            },
          ]}
        />
      </Section>

      <Section title="5. Declaration strength score and verdict">
        <p className="mb-1">
          Overall verdict: <Badge label={score.overallVerdict} />
        </p>
        <Table
          rows={score.dimensionScores}
          columns={[
            { header: "Dimension", cell: (row) => row.dimension },
            { header: "Score", cell: (row) => `${row.score} / 5` },
            { header: "Justification", cell: (row) => row.justification },
          ]}
        />
        <Flags title="Red flags" tone="amber" items={score.redFlags} />
      </Section>

      <Section title="6. Cross-document reconciliation table">
        <ReconciliationTable rows={report.crossDocumentReconciliation} />
      </Section>

      <Section title="7. Evidence sufficiency audit">
        <div className="flex flex-col gap-2">
          <Table
            rows={evidence.exhibitToElementMap}
            columns={[
              { header: "Exhibit", cell: (row) => row.exhibit },
              { header: "Supports", cell: (row) => row.supportsElements.join(", ") || <Muted>nothing</Muted> },
            ]}
          />
          <Flags title="Elements supported by the declaration only" items={evidence.elementsSupportedByDeclarationOnly} />
          <FactTable
            rows={[
              ["Exhibits that support nothing", <ListOrNone key="u" items={evidence.unsupportedExhibits} />],
              ["Exhibits that contradict the declaration", <ListOrNone key="c" items={evidence.contradictoryExhibits} />],
              ["Translation issues", <ListOrNone key="t" items={evidence.translationIssues} />],
              ["Legibility issues", <ListOrNone key="l" items={evidence.legibilityIssues} />],
              ["Third-party declaration issues", <ListOrNone key="d" items={evidence.thirdPartyDeclarationIssues} />],
              ["Psychological evaluation", evidence.psychEvalIssues ?? <Muted>not addressed</Muted>],
            ]}
          />
        </div>
      </Section>

      <Section title="8. Form mechanics audit">
        <ChecklistList
          items={report.formMechanicsAudit.map((row) => ({
            badge: row.severity,
            content: (
              <>
                <strong>{row.form}:</strong> {row.issue}
              </>
            ),
          }))}
        />
      </Section>

      <Section title="9. Inadmissibility and GMC audit">
        <Table
          rows={report.inadmissibilityAndGmcAudit}
          columns={[
            { header: "Ground", cell: (row) => row.ground },
            { header: "Status", cell: (row) => row.status },
          ]}
        />
      </Section>

      <Section title="10. Anticipated RFE and interview exposure">
        <Table
          rows={report.anticipatedRfeAndInterviewExposure}
          columns={[
            { header: "Question", cell: (row) => row.question },
            { header: "What answers it", cell: (row) => row.whatAnswersIt },
            { header: "What does not", cell: (row) => row.whatDoesNot },
          ]}
        />
      </Section>

      <Section title="11. Prioritized edit checklist">
        <ChecklistList
          items={report.prioritizedEditChecklist.map((row) => ({
            badge: row.priority,
            content: (
              <>
                {row.fix} <Muted>({row.location}; {row.responsibleParty})</Muted>
              </>
            ),
          }))}
        />
      </Section>

      <Section title="12. Authority relied on">
        <CitationsList items={citationItems(report.authoritiesRelied)} />
      </Section>

      <Flags title="Review escalation flags" items={report.escalationFlags} />
    </div>
  );
}

function ReconciliationTable({ rows }: { rows: VawaPacketBuildOutput["crossDocumentReconciliationTable"] }) {
  return (
    <Table
      rows={rows}
      rowClassName={(row) => (row.match ? "" : "bg-red-50 dark:bg-red-950")}
      columns={[
        { header: "Fact", cell: (row) => row.fact },
        { header: "I-360", cell: (row) => row.i360 },
        { header: "I-485", cell: (row) => row.i485 },
        { header: "I-765", cell: (row) => row.i765 },
        { header: "Declaration", cell: (row) => row.declaration },
        { header: "Exhibits", cell: (row) => row.exhibits },
        { header: "Match?", cell: (row) => <Badge label={row.match ? "match" : "mismatch"} tone={row.match ? "green" : "red"} /> },
      ]}
    />
  );
}

function OrthographyReportView({ report }: { report: OrthographyReport }) {
  return (
    <Section title={`Orthography check: ${report.document}`}>
      <div className="flex flex-col gap-2">
        <p>{report.summary}</p>
        <Section title="Fixed (applied to the corrected copy)">
          <Table
            rows={report.fixed}
            columns={[
              { header: "#", cell: (_row, i) => i + 1 },
              { header: "Location", cell: (row) => row.location },
              { header: "Category", cell: (row) => row.category },
              { header: "Original", cell: (row) => row.original },
              { header: "Corrected", cell: (row) => row.corrected },
            ]}
          />
        </Section>
        <Section title="Flagged for your decision (NOT changed)">
          <Table
            rows={report.flaggedForYourDecision}
            rowClassName={() => "bg-amber-50 dark:bg-amber-950"}
            columns={[
              { header: "#", cell: (_row, i) => i + 1 },
              { header: "Location", cell: (row) => row.location },
              { header: "Category", cell: (row) => row.category },
              { header: "Text", cell: (row) => row.text },
              { header: "Why flagged", cell: (row) => row.whyFlagged },
              { header: "Options", cell: (row) => row.options },
            ]}
          />
        </Section>
        <Section title="Name and term consistency">
          <Table
            rows={report.nameAndTermConsistency}
            columns={[
              { header: "Name or term", cell: (row) => row.nameOrTerm },
              { header: "Variants found", cell: (row) => row.variants.map((v) => `${v.variant} (${v.count})`).join(", ") },
              { header: "Standardized to", cell: (row) => row.standardizedTo },
            ]}
          />
        </Section>
        <Section title="Document-wide notes">
          <ListOrNone items={report.documentWideNotes} />
        </Section>
      </div>
    </Section>
  );
}

export function VawaPacketBuildView({ output, actions }: SkillViewProps<"vawa-packet-build">) {
  const snapshot = output.packetSnapshot;
  const posture = snapshot.postureDeterminations;
  const build = snapshot.buildChangingDeterminations;
  const tables = output.residenceTableAbuseIncidentTableAndElementToEvidenceMatrix;
  const evidence = output.enclosureListAndEvidenceRequestList;
  const affidavits = output.thirdPartyAffidavitTemplatesAndAffiantList;
  const qa = output.vawaPacketReviewAndOrthographyCheckReports;
  const matrix = tables.elementToEvidenceMatrix;
  const actionItems = [...output.masterActionChecklist].sort((a, b) => Number(b.blocking) - Number(a.blocking));

  return (
    <ReportBody>
      <Section title="1. Safety, conflict, and 1367 flags">
        {output.safetyConflictAnd1367Flags.length > 0 ? (
          <Flags
            title="Resolve before packet assembly"
            items={[...output.safetyConflictAnd1367Flags]
              .sort((a, b) => Number(b.type === "SAFETY") - Number(a.type === "SAFETY"))
              .map((f, i) => (
                <span key={i}>
                  <strong>{f.type === "1367" ? "1367" : `${f.type} FLAG`}:</strong> {f.detail}
                </span>
              ))}
          />
        ) : (
          <Muted>None.</Muted>
        )}
      </Section>

      <Section title="2. Packet snapshot">
        <div className="flex flex-col gap-2">
          <p>
            <strong>{snapshot.client}</strong> - {"abuser's status: "}
            <Badge label={snapshot.abuserStatus} tone={snapshot.abuserStatus === "unknown" ? "amber" : "neutral"} />{" "}
            <Badge label={snapshot.scope} className={SCOPE_TONE[snapshot.scope]} />
          </p>
          <p className="text-black/70 dark:text-white/70">{snapshot.scopeNote}</p>

          <Flags title="Client and attorney question list" tone="amber" items={snapshot.clientAndAttorneyQuestionList} />

          <Section title="Posture determinations">
            <FactTable
              rows={[
                ["Marriage posture", <Badge key="mp" label={posture.marriagePosture} tone={posture.marriagePosture === "unknown" ? "amber" : "neutral"} />],
                ["Date and place of marriage", posture.dateAndPlaceOfMarriage],
                [
                  "Resided with the abuser during the marriage",
                  <span key="res">
                    <YesNoBadge value={posture.residenceWithAbuserDuringMarriage.resided} />
                    <ListOrNone items={posture.residenceWithAbuserDuringMarriage.addressesAndDates} />
                  </span>,
                ],
                ["Client location", humanize(posture.clientLocation)],
                ["Immigration status and entry history", posture.immigrationStatusAndEntryHistory],
                ["Removal posture", humanize(posture.removalPosture)],
                ["Married during removal proceedings (204(g))", <YesNoBadge key="g" value={posture.marriageDuringRemovalProceedings} yesTone="red" noTone="green" />],
                ["Criminal or arrest history", posture.criminalOrArrestHistory],
                ["Prior immigration filings", posture.priorImmigrationFilings],
                ["Forms requested", posture.formsRequested],
                ["Safe mailing address on file", <YesNoBadge key="safe" value={posture.safeMailingAddressOnFile} />],
              ]}
            />
          </Section>

          <Section title="Client's prior marriages">
            <Table
              rows={posture.clientPriorMarriages}
              columns={[
                { header: "Marriage", cell: (row) => row.marriage },
                { header: "Termination date", cell: (row) => row.terminationDate },
                { header: "Waiting or revocable period", cell: (row) => row.waitingOrRevocablePeriod },
              ]}
            />
          </Section>

          <Section title="Derivative children">
            <Table
              rows={posture.derivativeChildren}
              rowClassName={(row) => (row.withinOneYearOf21 ? "bg-amber-50 dark:bg-amber-950" : "")}
              columns={[
                { header: "Name", cell: (row) => row.name },
                { header: "Date of birth", cell: (row) => row.dateOfBirth },
                { header: "Marital status", cell: (row) => row.maritalStatus },
                { header: "Age at intended filing", cell: (row) => row.ageAtIntendedFilingDate },
                { header: "Location", cell: (row) => row.location },
                { header: "Within a year of 21", cell: (row) => <YesNoBadge value={row.withinOneYearOf21} yesTone="red" noTone="green" /> },
              ]}
            />
          </Section>

          <Section title="Records that exist">
            <FactTable
              rows={[
                ["Protective order", <YesNoBadge key="po" value={posture.recordsThatExist.protectiveOrder} noTone="neutral" />],
                ["Police report", <YesNoBadge key="pr" value={posture.recordsThatExist.policeReport} noTone="neutral" />],
                ["Shelter record", <YesNoBadge key="sr" value={posture.recordsThatExist.shelterRecord} noTone="neutral" />],
                ["Medical record", <YesNoBadge key="mr" value={posture.recordsThatExist.medicalRecord} noTone="neutral" />],
                ["Psychological evaluation", <YesNoBadge key="pe" value={posture.recordsThatExist.psychologicalEvaluation} noTone="neutral" />],
              ]}
            />
          </Section>

          <Section title="Four build-changing determinations">
            <Table
              rows={[
                ["Can an I-485 be filed at all?", build.canI485BeFiled] as const,
                ["Was the marriage terminated before filing?", build.marriageTerminatedBeforeFiling] as const,
                ["Is this an intended spouse case?", build.intendedSpouseCase] as const,
                ["Is there a good moral character bar in the record?", build.gmcBarInRecord] as const,
              ]}
              columns={[
                { header: "Determination", cell: (row) => row[0] },
                { header: "Answer", cell: (row) => <YesNoBadge value={row[1].answer} yesTone="neutral" noTone="neutral" /> },
                { header: "What turns on it", cell: (row) => row[1].whatTurnsOnIt },
              ]}
            />
          </Section>

          <FactTable
            rows={[
              ["Forms built", snapshot.formsBuilt.length > 0 ? snapshot.formsBuilt.join(", ") : <Muted>none</Muted>],
              ["Materials received", <ListOrNone key="r" items={snapshot.materialsReceived} />],
              ["Needed and not provided", <ListOrNone key="n" items={snapshot.materialsNotProvided} />],
            ]}
          />
        </div>
      </Section>

      <Section title="3. Run-time verification note">
        <Table
          rows={output.runTimeVerificationNote}
          rowClassName={(row) => (row.verified ? "" : "bg-amber-50 dark:bg-amber-950")}
          columns={[
            { header: "Item", cell: (row) => row.item },
            {
              header: "Status",
              cell: (row) => <Badge label={row.verified ? "verified" : "ATTORNEY: VERIFY"} tone={row.verified ? "green" : "amber"} />,
            },
            { header: "Finding", cell: (row) => row.finding },
            {
              header: "Source",
              cell: (row) => (
                <Muted>
                  {row.url ?? "no page"}
                  {row.dateVerified ? ` (${row.dateVerified})` : ""}
                </Muted>
              ),
            },
          ]}
        />
      </Section>

      <Section title="4. Element scorecard">
        <Table
          rows={output.elementScorecard.elements}
          columns={[
            { header: "#", cell: (row) => row.number },
            { header: "Element", cell: (row) => row.element },
            { header: "Rating", cell: (row) => <Badge label={row.rating} /> },
            { header: "Supporting facts and documents", cell: (row) => <ListOrNone items={row.supportingFactsAndDocuments} /> },
            { header: "Gaps needing client input", cell: (row) => <ListOrNone items={row.gapsNeedingClientInput} /> },
          ]}
        />
        <div className="mt-2">
          <Flags title="Issues surfaced at triage" tone="amber" items={output.elementScorecard.issuesSurfaced} />
        </div>
      </Section>

      <Section title="5. The declaration">
        <div className="flex flex-col gap-2">
          <DownloadButton
            documentId={output.declaration.generatedDeclarationDocumentId}
            label="Download declaration (.docx)"
            missing={`No declaration was generated in this run${output.declaration.notGeneratedReason ? `: ${output.declaration.notGeneratedReason}` : "."}`}
            onDownload={actions.downloadDocument}
          />
          {output.declaration.generatedDeclarationDocumentId && output.declaration.notGeneratedReason ? (
            <Muted>{output.declaration.notGeneratedReason}</Muted>
          ) : null}
          <FactTable
            rows={[
              ["Declarant", output.declaration.declarant],
              ["Numbered paragraphs", output.declaration.paragraphCount],
              ["Interpreter certification included", yesNo(output.declaration.interpreterCertificationIncluded)],
              ["Sections, in order", <ListOrNone key="s" items={output.declaration.sectionsInOrder} />],
            ]}
          />
          <Flags title="CLARIFY WITH CLIENT flags (one client call)" tone="amber" items={output.declaration.clarifyWithClientFlags} />
        </div>
      </Section>

      <Section title="6. Third-party affidavit templates and who should provide one">
        <div className="flex flex-col gap-2">
          {affidavits.generatedAffidavitTemplateDocumentIds.filter(Boolean).length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {affidavits.generatedAffidavitTemplateDocumentIds.filter(Boolean).map((id, i) => (
                <button key={id} type="button" onClick={() => actions.downloadDocument(id)} className={BUTTON_CLASS}>
                  Download affidavit template {i + 1} (.docx)
                </button>
              ))}
            </div>
          ) : (
            <Muted>No affidavit templates were generated in this run.</Muted>
          )}
          <Table
            rows={affidavits.affiants}
            columns={[
              { header: "Affiant", cell: (row) => row.affiant },
              { header: "Relationship", cell: (row) => row.relationshipToParties },
              { header: "How they know", cell: (row) => row.howTheyKnow },
              { header: "Can attest to", cell: (row) => row.canAttestTo },
              { header: "Elements", cell: (row) => row.elementsSupported.join(", ") },
              { header: "Format", cell: (row) => humanize(row.format) },
            ]}
          />
        </div>
      </Section>

      <Section title="7. Residence table, abuse incident table, and element-to-evidence matrix">
        <div className="flex flex-col gap-3">
          <Section title="Residence table">
            <p className="mb-1 text-xs">
              Marriage: <strong>{tables.residenceTable.marriageDate}</strong> - Separation: <strong>{tables.residenceTable.separationDate}</strong>
            </p>
            <Table
              rows={tables.residenceTable.rows}
              rowClassName={(row) => (row.duringMarriage === false ? "bg-amber-50 dark:bg-amber-950" : "")}
              columns={[
                { header: "Address", cell: (row) => row.address },
                { header: "Moved in", cell: (row) => row.moveInDate },
                { header: "Moved out", cell: (row) => row.moveOutDate },
                { header: "Name on lease or deed", cell: (row) => row.nameOnLeaseOrDeed },
                { header: "Who else lived there", cell: (row) => row.whoElseLivedThere },
                { header: "Corroborating document", cell: (row) => row.corroboratingDocument },
                { header: "During the marriage", cell: (row) => <YesNoBadge value={row.duringMarriage} noTone="amber" /> },
              ]}
            />
          </Section>

          <Section title="Abuse incident table">
            <Table
              rows={tables.abuseIncidentTable}
              columns={[
                { header: "Approx. date", cell: (row) => row.approximateDate },
                { header: "Location", cell: (row) => row.location },
                { header: "Conduct", cell: (row) => row.conduct },
                {
                  header: "Type",
                  cell: (row) => <Badge label={row.physicalOrNonPhysical} tone={row.physicalOrNonPhysical === "physical" ? "red" : "neutral"} />,
                },
                { header: "Control tactic", cell: (row) => row.controlTactic },
                { header: "Fear or threat link", cell: (row) => row.fearOrThreatLink },
                { header: "Severity or repetition", cell: (row) => row.severityOrRepetition },
                { header: "Corroboration", cell: (row) => row.corroboratingDocument },
              ]}
            />
          </Section>

          <Section title="Element-to-evidence matrix">
            <Table
              rows={matrix.rows}
              rowClassName={(row) => (row.declarationOnly ? "bg-red-50 dark:bg-red-950" : "")}
              columns={[
                {
                  header: "Element",
                  cell: (row) => (row.declarationOnly ? <strong>{row.element} (declaration only)</strong> : row.element),
                },
                ...matrix.documents.map((doc) => ({
                  header: doc,
                  cell: (row: (typeof matrix.rows)[number]) => (row.supportedBy.includes(doc) ? "X" : ""),
                })),
                {
                  header: "Other support listed",
                  cell: (row: (typeof matrix.rows)[number]) => row.supportedBy.filter((d) => !matrix.documents.includes(d)).join(", "),
                },
              ]}
            />
          </Section>
        </div>
      </Section>

      <Section title="8. Enclosure list and evidence request list">
        <div className="flex flex-col gap-3">
          <Section title="Enclosure list (documents that exist)">
            <Table
              rows={evidence.enclosureList}
              columns={[
                { header: "#", cell: (_row, i) => i + 1 },
                { header: "Document", cell: (row) => row.document },
                { header: "Proves", cell: (row) => row.elementsProved.join(", ") },
              ]}
            />
          </Section>
          <Section title="Evidence request list (documents to obtain)">
            <Table
              rows={evidence.evidenceRequestList}
              rowClassName={(row) => (row.safeToObtain === false ? "bg-red-50 dark:bg-red-950" : "")}
              columns={[
                { header: "Document", cell: (row) => row.document },
                { header: "Owner", cell: (row) => row.owner },
                { header: "Source", cell: (row) => row.source },
                { header: "Method", cell: (row) => row.method },
                { header: "Safe to obtain (1367)", cell: (row) => <YesNoBadge value={row.safeToObtain} /> },
                { header: "Safety note", cell: (row) => row.safetyNote },
                {
                  header: "Explain absence in declaration",
                  cell: (row) => <Badge label={yesNo(row.explainAbsenceInDeclaration)} tone={row.explainAbsenceInDeclaration ? "amber" : "neutral"} />,
                },
              ]}
            />
          </Section>
        </div>
      </Section>

      <Section title="9. Translation and certification checklist">
        <Table
          rows={output.translationAndCertificationChecklist}
          rowClassName={(row) => (row.fullEnglishTranslationProvided && row.translatorCertificationProvided ? "" : "bg-amber-50 dark:bg-amber-950")}
          columns={[
            { header: "Document", cell: (row) => row.document },
            { header: "Language", cell: (row) => row.language },
            { header: "Full translation", cell: (row) => <YesNoBadge value={row.fullEnglishTranslationProvided} /> },
            { header: "Translator certification", cell: (row) => <YesNoBadge value={row.translatorCertificationProvided} /> },
            { header: "Action needed", cell: (row) => row.actionNeeded },
          ]}
        />
      </Section>

      <FormSection
        title="10. Form I-360 answer table and filled PDF"
        form={output.formI360AnswerTableAndFilledPdf}
        extra={[["Part 2 classification box", output.formI360AnswerTableAndFilledPdf.classificationBox]]}
        pdfLabel="Download filled I-360 (.pdf)"
        onDownload={actions.downloadDocument}
      />

      <FormSection
        title="11. Form I-485 answer table and filled PDF"
        form={output.formI485AnswerTableAndFilledPdf}
        extra={[
          ["Can be filed now", <YesNoBadge key="file" value={output.formI485AnswerTableAndFilledPdf.canBeFiledNow} noTone="amber" />],
          ["Why not yet", output.formI485AnswerTableAndFilledPdf.whyNotYet ?? <Muted>not applicable</Muted>],
        ]}
        pdfLabel="Download filled I-485 (.pdf)"
        onDownload={actions.downloadDocument}
      />

      <FormSection
        title="12. Form I-765 answer table and filled PDF"
        form={output.formI765AnswerTableAndFilledPdf}
        extra={[
          ["Item 27 category", output.formI765AnswerTableAndFilledPdf.categoryCode ?? <Muted>no I-765 built</Muted>],
          ["Why that category", output.formI765AnswerTableAndFilledPdf.categoryReason],
        ]}
        pdfLabel="Download filled I-765 (.pdf)"
        onDownload={actions.downloadDocument}
      />

      <Section title="13. Cover letter">
        <div className="flex flex-col gap-2">
          <DownloadButton
            documentId={output.coverLetter.generatedCoverLetterDocumentId}
            label="Download cover letter (.docx)"
            missing={`No cover letter was generated in this run${output.coverLetter.notGeneratedReason ? `: ${output.coverLetter.notGeneratedReason}` : "."}`}
            onDownload={actions.downloadDocument}
          />
          {output.coverLetter.generatedCoverLetterDocumentId && output.coverLetter.notGeneratedReason ? (
            <Muted>{output.coverLetter.notGeneratedReason}</Muted>
          ) : null}
          <FactTable
            rows={[
              ["Mailing method", output.coverLetter.mailingMethod],
              ["Filing address used", output.coverLetter.filingAddressUsed],
              [
                "Divorce or death exception pleaded",
                output.coverLetter.statutoryExceptionPleaded === null ? (
                  <Muted>not applicable</Muted>
                ) : (
                  <YesNoBadge value={output.coverLetter.statutoryExceptionPleaded} />
                ),
              ],
              ["Expedite request", output.coverLetter.expediteRequest ?? <Muted>none</Muted>],
            ]}
          />
          <Section title="Element walkthrough">
            <Table
              rows={output.coverLetter.elementWalkthrough}
              columns={[
                { header: "Element", cell: (row) => row.element },
                { header: "Documents", cell: (row) => row.documents.join(", ") },
                { header: "Declaration paragraphs", cell: (row) => row.declarationParagraphs },
              ]}
            />
          </Section>
          <Section title="Authorities cited">
            <CitationsList items={citationItems(output.coverLetter.authoritiesCited)} />
          </Section>
        </div>
      </Section>

      <Section title="14. Legal support memo">
        {output.legalSupportMemo ? (
          <div className="flex flex-col gap-2">
            <DownloadButton
              documentId={output.legalSupportMemo.generatedLegalMemoDocumentId}
              label="Download legal support memo (.docx)"
              missing="The memo could not be generated in this run."
              onDownload={actions.downloadDocument}
            />
            <Section title="Issues">
              <ListOrNone items={output.legalSupportMemo.issues} />
            </Section>
            <Section title="Authorities">
              <CitationsList items={citationItems(output.legalSupportMemo.authorities)} />
            </Section>
          </div>
        ) : (
          <Muted>No legal support memo was built.</Muted>
        )}
      </Section>

      <Section title="15. Cross-document reconciliation table">
        <ReconciliationTable rows={output.crossDocumentReconciliationTable} />
      </Section>

      <Section title="16. Filing checklist">
        <ChecklistList
          items={output.filingChecklist.map((row) => ({
            badge: row.ready ? "ready" : "pending",
            badgeClassName: row.ready ? toneClass.green : toneClass.amber,
            content: (
              <>
                {row.item} <Muted>{row.note}</Muted>
              </>
            ),
          }))}
        />
      </Section>

      <Section title="17. The vawa-packet-review report and the orthography-check report">
        <div className="flex flex-col gap-3">
          <Callout title="How the QA gates ran" tone="neutral">
            <ListOrNone items={qa.qaGateNotes} />
          </Callout>
          <Section title="vawa-packet-review">
            <div className="flex flex-col gap-2">
              {qa.vawaPacketReviewReport ? (
                <>
                  <p>
                    <Badge
                      label={qa.vawaPacketReviewSkillLoaded ? "run as the firm's skill" : "skill not loaded: build's own check"}
                      tone={qa.vawaPacketReviewSkillLoaded ? "green" : "amber"}
                    />
                  </p>
                  <ReviewReportView report={qa.vawaPacketReviewReport} />
                </>
              ) : (
                <Muted>The vawa-packet-review QA gate was not run in this run (see the notes above).</Muted>
              )}
            </div>
          </Section>
          {qa.orthographyCheckReports.length > 0 ? (
            <>
              <p>
                <Badge
                  label={qa.orthographyCheckSkillLoaded ? "orthography-check run as the firm's skill" : "orthography-check not loaded: build's own check"}
                  tone={qa.orthographyCheckSkillLoaded ? "green" : "amber"}
                />
              </p>
              {qa.orthographyCheckReports.map((report, i) => (
                <OrthographyReportView key={i} report={report} />
              ))}
            </>
          ) : (
            <Muted>The orthography-check pass was not run in this run (see the notes above).</Muted>
          )}
        </div>
      </Section>

      <Section title="18. Master action checklist">
        <ChecklistList
          items={actionItems.map((row) => ({
            badge: row.blocking ? "blocking" : "to do",
            badgeClassName: row.blocking ? toneClass.red : toneClass.neutral,
            content: (
              <>
                {row.item} <Muted>(owner: {row.owner})</Muted>
              </>
            ),
          }))}
        />
      </Section>
    </ReportBody>
  );
}
