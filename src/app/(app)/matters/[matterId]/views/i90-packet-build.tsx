import type { ReactNode } from "react";
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
  priorityColor,
  statusColor,
  toneClass,
  yesNo,
} from "./primitives";

type Output = SkillViewProps<"i90-packet-build">["output"];
type Snapshot = Output["caseSnapshotAndRoutingDetermination"];
type RoutingGate = Snapshot["routingGates"][number];
type PostureItem = Snapshot["clientPosture"][number]["item"];
type VerificationLog = Output["runTimeVerificationLog"];
type FeeChecklist = Output["feeAndFilingChecklist"];
type SheetCovers = NonNullable<Output["clientInstructionSheet"]["covers"]>;
// Absent when the build stopped before a packet was assembled.
type QaReport = NonNullable<Output["qaGateReport"]>;
type QaProof = QaReport["identityAndStatusProof"]["identity"];
type QaMechanics = QaReport["filingMechanics"];
type QaLiveChecks = QaMechanics["runTimeVerification"];
type QaThresholdTest = QaReport["thresholdDetermination"]["thresholdTests"][number]["test"];

const cardTypeLabel: Record<Snapshot["cardType"], string> = {
  ten_year: "Ten year card",
  two_year: "Two year card",
  unknown: "Card type unknown",
};

const gateLabel: Record<RoutingGate["gate"], string> = {
  two_year_card_conditional_resident: "Two year card, conditional resident",
  pending_or_imminent_naturalization: "Pending or imminent naturalization",
  client_is_outside_the_united_states: "Client is outside the United States",
  abandonment_exposure: "Abandonment exposure",
  removal_posture_and_criminal_history: "Removal posture and criminal history",
  identity_and_status_proof: "Identity and status proof",
};

const postureLabel: Record<PostureItem, string> = {
  full_legal_name_as_on_card_and_every_other_name_used: "Full legal name as on the card, and every other name used",
  a_number_uscis_online_account_number_and_date_of_birth: "A-number, USCIS online account number, date of birth",
  class_of_admission_code_and_date_of_admission_or_adjustment: "Class of admission code, date of admission or adjustment",
  card_issue_date_expiration_date_and_card_type: "Card issue and expiration dates, card type",
  mailing_and_physical_address_time_at_each_and_mail_reliability: "Mailing and physical address, time at each, mail reliability",
  current_location: "Current location",
  travel_history_since_becoming_an_lpr: "Travel history since becoming an LPR",
  criminal_history_arrests_and_citations: "Criminal history, arrests and citations",
  removal_deportation_exclusion_or_rescission_history: "Removal, deportation, exclusion or rescission history",
  prior_i90_n400_i751_or_i829_and_outcome: "Prior I-90, N-400, I-751 or I-829, and outcome",
  n400_filed_imminent_or_contemplated: "N-400 filed, imminent or contemplated",
  urgent_need_for_proof_of_status: "Urgent need for proof of status",
  ability_to_pay_the_fee: "Ability to pay the fee",
};

// SECTION 2's checks in its order.
const verificationRows: [keyof VerificationLog, string][] = [
  ["formEditionDates", "I-90 and G-28 edition dates, older editions accepted"],
  ["filingFees", "Online and paper fees, separate biometric fee"],
  ["feeExemptReasons", "Fee exempt reasons and conditions"],
  ["feeWaiverI912", "Form I-912 fee waiver and criteria"],
  ["directFilingAddress", "Direct filing address (USPS and courier)"],
  ["onlineFilingForReason", "Online filing for this reason, attorney representation online"],
  ["automaticExtensionPeriod", "Automatic extension on the receipt notice, and its language"],
  ["processingTimes", "Processing times"],
  ["aditOrI551StampProcess", "ADIT or I-551 stamp appointment process"],
];

// SECTION 7 item 10 in its order.
const checklistRows: [keyof FeeChecklist, string][] = [
  ["amount", "Amount"],
  ["paymentMethod", "Payment method"],
  ["payee", "Payee"],
  ["channel", "Channel"],
  ["addressMatchedToMailingMethod", "Address matched to mailing method"],
  ["editionDateConfirmed", "Edition date confirmed"],
  ["everySignatureConfirmed", "Every signature confirmed"],
  ["tracking", "Tracking"],
  ["fileCopy", "File copy"],
];

// SECTION 7 item 11's points in its order.
const sheetRows: [keyof SheetCovers, string][] = [
  ["whatWasFiledAndWhy", "What was filed and why"],
  ["keepReceiptNoticeWithExpiredCard", "Keep the receipt notice with the expired card, never separate them"],
  ["ascBiometricsAppointmentMandatory", "The ASC biometrics appointment is mandatory"],
  ["reportAddressChangesAndHow", "Report any address change to USCIS, and how"],
  ["aditStampForUrgentProofOfStatus", "ADIT stamp for urgent proof of status"],
  ["noTravelWithoutSpeakingToTheOffice", "No travel outside the United States without speaking to the office"],
  ["expectedProcessingTime", "Expected processing time"],
];

const qaThresholdLabel: Record<QaThresholdTest, string> = {
  conditional_resident: "Conditional resident",
  pending_or_imminent_naturalization: "Pending or imminent naturalization",
  client_abroad: "Client abroad",
  timing_on_expiring_card: "Timing on an expiring card",
};

const qaProofClass: Record<QaProof["rating"], string> = {
  sufficient: toneClass.green,
  thin: toneClass.amber,
  missing: toneClass.red,
};

const qaMechanicsClass: Record<QaMechanics["edition"]["status"], string> = {
  clear: toneClass.green,
  fix: toneClass.amber,
};

const qaMechanicsRows: [Exclude<keyof QaMechanics, "runTimeVerification">, string][] = [
  ["edition", "Edition"],
  ["fee", "Fee"],
  ["channel", "Channel"],
  ["address", "Address"],
  ["assembly", "Assembly"],
  ["deliverability", "Deliverability"],
  ["postFilingCalendarItems", "Post-filing calendar items"],
];

const qaLiveCheckRows: [keyof QaLiveChecks, string][] = [
  ["i90AndG28EditionDates", "I-90 and G-28 edition dates, older editions accepted"],
  ["filingFees", "Online and paper fees, biometrics billed separately"],
  ["feeExemptReasons", "Fee exempt reasons and conditions"],
  ["feeWaiverI912Availability", "Form I-912 available for the I-90"],
  ["directFilingAddress", "Direct filing address (USPS and courier)"],
  ["onlineFilingForSelectedReason", "Online filing for the selected reason"],
  ["automaticExtensionPeriod", "Automatic extension period on the receipt notice"],
  ["processingTimes", "Processing times"],
];

/** Links only http(s) URLs; anything else is shown as text. */
function sourceUrl(url: string): ReactNode {
  if (!/^https?:\/\//i.test(url)) return <span className="break-all">{url}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="break-all underline">
      {url}
    </a>
  );
}

function NoneOr({ items, children }: { items: unknown[]; children: ReactNode }) {
  return items.length > 0 ? <>{children}</> : <Muted>None.</Muted>;
}

/** A triggered / clear / unresolved concern as a badge. */
function concernBadge(present: boolean | null, labels: { yes: string; no: string; unknown: string }): ReactNode {
  if (present === null) return <Badge label={labels.unknown} tone="amber" />;
  return present ? <Badge label={labels.yes} tone="red" /> : <Badge label={labels.no} tone="green" />;
}

/** null shows as unknown, or as notApplicableLabel where null means the document was not generated. */
function YesNoBadge({
  value,
  good = true,
  notApplicableLabel,
}: {
  value: boolean | null;
  good?: boolean;
  notApplicableLabel?: string;
}) {
  if (value === null) {
    return notApplicableLabel ? <Badge label={notApplicableLabel} tone="neutral" /> : <Badge label="unknown" tone="amber" />;
  }
  return <Badge label={yesNo(value)} tone={value === good ? "green" : "red"} />;
}

/** Download button for a generated document; hidden when the run generated none. */
function DownloadOrReason({
  documentId,
  label,
  reason,
  onDownload,
}: {
  documentId: string;
  label: string;
  reason?: string;
  onDownload: (documentId: string) => void;
}) {
  if (documentId) {
    return (
      <button
        type="button"
        onClick={() => onDownload(documentId)}
        className="w-fit rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
      >
        {label}
      </button>
    );
  }
  return (
    <p className="text-amber-800 dark:text-amber-300">
      Not generated in this run{reason ? `: ${reason}` : "."}
    </p>
  );
}

function QaProofRow({ title, proof, extra }: { title: string; proof: QaProof; extra?: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Badge label={proof.rating} className={qaProofClass[proof.rating]} />
      <span>
        <strong>{title}</strong>: {proof.finding}
        <span className="block text-xs">
          <Muted>What would cure it: {proof.whatWouldCureIt}</Muted>
        </span>
        {extra}
      </span>
    </li>
  );
}

/** SECTION 8: the i90-packet-review report over this packet, items 1-13. */
function QaGateReportView({ report }: { report: QaReport }) {
  const {
    packetSnapshot: snapshot,
    thresholdDetermination: threshold,
    reasonForFiling: reason,
    identityAndStatusProof: proof,
    evidenceAssessment: evidence,
    exposureScreen: exposure,
    filingMechanics: mechanics,
  } = report;
  const { feeConsequence } = reason;
  const { mutilatedCard } = proof.ground;
  const exposureRows = [
    { area: "Abandonment of residence", ...exposure.abandonmentOfResidence },
    { area: "Criminal history", ...exposure.criminalHistory },
    { area: "Removal or rescission", ...exposure.removalOrRescission },
  ];
  const holdFiling = exposure.filingHold.holdUntilAttorneyClears;

  return (
    <div className="flex flex-col gap-3">
      <Section title="Packet snapshot">
        <p>
          {snapshot.client} - A-number {snapshot.aNumber}
        </p>
        <ul className="mt-1 text-xs text-black/60 dark:text-white/60">
          <li>
            {humanize(snapshot.cardType)} - issued {snapshot.cardIssueDate}, expires {snapshot.cardExpirationDate}
          </li>
          <li>Reason for filing (Part 2): {snapshot.reasonForFiling}</li>
          <li>
            Filing channel: {humanize(snapshot.filingChannel)} - fee: {snapshot.fee} - basis: {snapshot.feeBasis}
          </li>
          <li>Documents reviewed: {snapshot.documentsReviewed.join(", ") || "none"}</li>
          <li>Documents not provided: {snapshot.documentsNotProvided.join(", ") || "none"}</li>
          <li>Case facts not provided: {snapshot.caseFactsNotProvided.join(", ") || "none"}</li>
        </ul>
      </Section>

      {report.blockingIssues.length > 0 ? (
        <Flags title={`Blocking issues (${report.blockingIssues.length})`} items={report.blockingIssues} />
      ) : (
        <Section title="Blocking issues">
          <Muted>None found.</Muted>
        </Section>
      )}

      <Section title="Threshold determination">
        <p className="mb-1 text-xs">
          {threshold.withinReviewScope ? (
            <Muted>Within the review&apos;s scope (renewal and replacement).</Muted>
          ) : (
            <span className="font-medium text-red-800 dark:text-red-300">
              Outside the review&apos;s scope; the review stopped here.
            </span>
          )}
        </p>
        <p>
          May use Form I-90: <YesNoBadge value={threshold.mayUseI90} /> {threshold.basis}
        </p>
        <div className="mt-2">
          <Table
            rows={threshold.thresholdTests}
            columns={[
              { header: "Test", cell: (row) => qaThresholdLabel[row.test] },
              {
                header: "Result",
                cell: (row) =>
                  concernBadge(row.concernPresent, { yes: "concern present", no: "no concern", unknown: "not determined" }),
              },
              { header: "Finding", cell: (row) => row.finding },
            ]}
          />
        </div>
      </Section>

      <Section title="Reason for filing">
        <p>
          <strong>{reason.selectedReason}</strong>
        </p>
        <ul className="mt-1 text-xs text-black/60 dark:text-white/60">
          <li>Exactly one reason selected: {yesNo(reason.exactlyOneReasonSelected)}</li>
          <li>
            Correct: {yesNo(reason.correct)} - supported: {yesNo(reason.supported)} - consistent across the packet:{" "}
            {yesNo(reason.consistentAcrossPacket)}
          </li>
          <li>Selected reason fee exempt: {yesNo(feeConsequence.selectedReasonFeeExempt)}</li>
          <li>
            Exemption claimed: {yesNo(feeConsequence.exemptionClaimed)} - claimed exemption supported:{" "}
            {yesNo(feeConsequence.claimedExemptionSupported)}
          </li>
        </ul>
        <p className="mt-1">{reason.assessment}</p>
        <p className="mt-1">
          <Muted>Fee consequence:</Muted> {feeConsequence.explanation}
        </p>
      </Section>

      <Section title="Form findings">
        <Table
          rows={report.formFindings}
          columns={[
            { header: "Part", cell: (row) => humanize(row.part) },
            { header: "Issue", cell: (row) => row.issue },
            { header: "Location", cell: (row) => row.location },
            { header: "Recommended edit", cell: (row) => row.recommendedEdit },
          ]}
        />
      </Section>

      <Section title="Identity and status proof">
        <ul className="flex flex-col gap-2">
          <QaProofRow title="Identity" proof={proof.identity} />
          <QaProofRow
            title="Status"
            proof={proof.status}
            extra={
              proof.status.coverLetterSaysStatusRestsOnSecondaryEvidence !== undefined && (
                <span className="block text-xs">
                  <Muted>
                    Cover letter says status rests on secondary evidence:{" "}
                    {yesNo(proof.status.coverLetterSaysStatusRestsOnSecondaryEvidence)}
                  </Muted>
                </span>
              )
            }
          />
          <QaProofRow
            title="Ground"
            proof={proof.ground}
            extra={
              mutilatedCard && (
                <span className="block text-xs">
                  <Muted>
                    Mutilated card: original submitted {yesNo(mutilatedCard.originalSubmitted)}, copy made for the file
                    first {yesNo(mutilatedCard.copyMadeForFileFirst)}
                  </Muted>
                </span>
              )
            }
          />
        </ul>
      </Section>

      <Section title="Evidence assessment">
        <Table
          rows={evidence.coverageByReason}
          columns={[
            { header: "Reason", cell: (row) => row.reason },
            { header: "Evidence", cell: (row) => row.evidenceItem },
            { header: "Coverage", cell: (row) => <Badge label={row.rating} className={coverageColor[row.rating]} /> },
            { header: "Notes", cell: (row) => row.notes },
          ]}
        />
        <p className="mt-2 text-xs font-medium">To obtain</p>
        <NoneOr items={evidence.obtainItems}>
          <BulletList className="text-xs" items={evidence.obtainItems} />
        </NoneOr>
        <p className="mt-2 text-xs font-medium">Confirm with client if true</p>
        <NoneOr items={evidence.confirmWithClientItems}>
          <BulletList className="text-xs" items={evidence.confirmWithClientItems} />
        </NoneOr>
      </Section>

      <Section title="Exposure screen">
        <Table
          rows={exposureRows}
          columns={[
            { header: "Area", cell: (row) => row.area },
            { header: "Status", cell: (row) => <Badge label={row.status} className={statusColor[row.status]} /> },
            { header: "Notes", cell: (row) => row.notes },
          ]}
        />
        <p className="mt-2">
          <Badge label={holdFiling ? "hold filing" : "no hold"} tone={holdFiling ? "red" : "green"} />{" "}
          {exposure.filingHold.note}
        </p>
      </Section>

      <Section title="Consistency log">
        <NoneOr items={report.consistencyLog}>
          <BulletList
            items={report.consistencyLog.map((c, i) => (
              <span key={i}>
                {c.discrepancy} - <Muted>{c.whereItAppears}</Muted>
              </span>
            ))}
          />
        </NoneOr>
      </Section>

      <Section title="Filing mechanics">
        <Table
          rows={qaMechanicsRows}
          columns={[
            { header: "Item", cell: ([, label]) => label },
            {
              header: "Status",
              cell: ([key]) => <Badge label={mechanics[key].status} className={qaMechanicsClass[mechanics[key].status]} />,
            },
            { header: "Finding", cell: ([key]) => mechanics[key].finding },
          ]}
        />
        <p className="mb-1 mt-3 text-xs font-medium">Run-time verification on uscis.gov</p>
        <Table
          rows={qaLiveCheckRows}
          rowClassName={([key]) => (mechanics.runTimeVerification[key].verified ? "" : "bg-amber-50 dark:bg-amber-950")}
          columns={[
            { header: "Check", cell: ([, label]) => label },
            {
              header: "Result",
              cell: ([key]) =>
                mechanics.runTimeVerification[key].verified ? (
                  <Badge label="verified" tone="green" />
                ) : (
                  <Badge label="ATTORNEY: VERIFY" tone="amber" />
                ),
            },
            { header: "Finding", cell: ([key]) => mechanics.runTimeVerification[key].finding },
            {
              header: "Source",
              cell: ([key]) => {
                const check = mechanics.runTimeVerification[key];
                if (!check.url && !check.checkedAt) return <Muted>none</Muted>;
                return (
                  <>
                    {check.url && sourceUrl(check.url)}
                    {check.checkedAt && (
                      <span className="block">
                        <Muted>checked {check.checkedAt}</Muted>
                      </span>
                    )}
                  </>
                );
              },
            },
          ]}
        />
      </Section>

      <Section title="Authorities to review">
        <CitationsList
          items={report.authoritiesToReview.map((a) => ({
            citation: a.citation,
            verified: a.verified,
            note: a.url ? (
              <>
                {a.why} ({sourceUrl(a.url)})
              </>
            ) : (
              a.why
            ),
          }))}
        />
      </Section>

      {report.escalationFlags.length > 0 ? (
        <Flags title="Escalation flags" items={report.escalationFlags} />
      ) : (
        <Section title="Escalation flags">
          <Muted>None.</Muted>
        </Section>
      )}

      <Section title="Prioritized edit checklist">
        <ChecklistList
          items={report.prioritizedEditChecklist.map((item) => ({
            badge: item.priority,
            badgeClassName: priorityColor[item.priority],
            content: item.item,
          }))}
        />
      </Section>
    </div>
  );
}

export function I90PacketBuildView({ output, actions }: SkillViewProps<"i90-packet-build">) {
  const {
    caseSnapshotAndRoutingDetermination: snapshot,
    runTimeVerificationLog: verification,
    formI90AnswerTable: answerTable,
    filledFormI90Pdf: i90,
    formG28: g28,
    coverLetter,
    clientInstructionSheet: sheet,
    qaGateResolution: resolution,
  } = output;
  const routing = snapshot.routingDetermination;
  const stopped = !routing.withinScope || !routing.buildProceeded;
  // null when no instruction sheet was generated.
  const sheetCovers = sheet.covers;
  const unverifiedChecks = verificationRows.filter(([key]) => !verification[key].verified).length;

  return (
    <ReportBody>
      <Section title="Case snapshot and routing determination">
        <p>
          {snapshot.client} - A-number {snapshot.aNumber}
        </p>
        <ul className="mt-1 text-xs text-black/60 dark:text-white/60">
          <li>
            {cardTypeLabel[snapshot.cardType]} - issued {snapshot.cardIssueDate}, expires {snapshot.cardExpirationDate}
          </li>
          <li>
            Reason for filing (Part 2):{" "}
            {snapshot.reasonForFiling ? humanize(snapshot.reasonForFiling) : "not fixed (the build stopped first)"} -{" "}
            {snapshot.reasonForFilingExplanation}
          </li>
          <li>
            Filing channel: {snapshot.filingChannel ?? "not chosen"} - {snapshot.filingChannelBasis}
          </li>
          <li>
            Fee: {snapshot.fee} - basis: {snapshot.feeBasis}
          </li>
        </ul>
        <div className="mt-2">
          <Callout
            title={
              !routing.withinScope
                ? "Outside the I-90 build scope: the build stopped"
                : routing.buildProceeded
                  ? "Routing determination"
                  : "The build stopped at a routing gate"
            }
            tone={stopped ? "red" : "neutral"}
          >
            <p>{routing.determination}</p>
            <p className="mt-1 text-xs">
              <Muted>
                Within scope: {yesNo(routing.withinScope)} - build proceeded: {yesNo(routing.buildProceeded)}
              </Muted>
            </p>
          </Callout>
        </div>
        <p className="mb-1 mt-3 text-xs font-medium">Routing gates</p>
        <Table
          rows={snapshot.routingGates}
          rowClassName={(row) => (row.concernPresent === false ? "" : "bg-amber-50 dark:bg-amber-950")}
          columns={[
            { header: "Gate", cell: (row) => gateLabel[row.gate] },
            {
              header: "Result",
              cell: (row) => concernBadge(row.concernPresent, { yes: "triggered", no: "clear", unknown: "unresolved" }),
            },
            { header: "Finding", cell: (row) => row.result },
            { header: "What turns on it", cell: (row) => row.whatTurnsOnIt },
          ]}
        />
        <p className="mb-1 mt-3 text-xs font-medium">Material provided</p>
        <Table
          rows={snapshot.materialInventory.provided}
          columns={[
            { header: "Document", cell: (row) => row.document },
            { header: "What it shows", cell: (row) => row.whatItShows },
          ]}
        />
        <div className="mt-2">
          {snapshot.materialInventory.neededNotProvided.length > 0 ? (
            <Flags
              title="Needed for a complete packet, not provided"
              tone="amber"
              items={snapshot.materialInventory.neededNotProvided}
            />
          ) : (
            <p className="text-xs">
              <Muted>Nothing a complete packet needs is missing from the material.</Muted>
            </p>
          )}
        </div>
        <p className="mb-1 mt-3 text-xs font-medium">Client posture</p>
        <Table
          rows={snapshot.clientPosture}
          rowClassName={(row) => (row.known ? "" : "bg-amber-50 dark:bg-amber-950")}
          columns={[
            { header: "Item", cell: (row) => postureLabel[row.item] },
            {
              header: "",
              cell: (row) => <Badge label={row.known ? "stated" : "unknown"} tone={row.known ? "green" : "amber"} />,
            },
            { header: "Statement", cell: (row) => row.statement },
          ]}
        />
      </Section>

      {output.clientAndAttorneyQuestionList.length > 0 ? (
        <Flags title="Client and attorney question list" tone="amber" items={output.clientAndAttorneyQuestionList} />
      ) : (
        <Section title="Client and attorney question list">
          <Muted>None.</Muted>
        </Section>
      )}

      <Section
        title={
          <>
            Run-time verification log
            {unverifiedChecks > 0 && (
              <span className="text-amber-800 dark:text-amber-300"> ({unverifiedChecks} not verified in this run)</span>
            )}
          </>
        }
      >
        <Table
          rows={verificationRows}
          rowClassName={([key]) => (verification[key].verified ? "" : "bg-amber-50 dark:bg-amber-950")}
          columns={[
            { header: "Item", cell: ([, label]) => label },
            {
              header: "Result",
              cell: ([key]) =>
                verification[key].verified ? (
                  <Badge label="verified" tone="green" />
                ) : (
                  <Badge label="ATTORNEY: VERIFY" tone="amber" />
                ),
            },
            { header: "What was confirmed", cell: ([key]) => verification[key].whatWasConfirmed },
            {
              header: "Source and date",
              cell: ([key]) => {
                const check = verification[key];
                if (!check.source && !check.date) return <Muted>none</Muted>;
                return (
                  <>
                    {check.source && sourceUrl(check.source)}
                    {check.date && (
                      <span className="block">
                        <Muted>{check.date}</Muted>
                      </span>
                    )}
                  </>
                );
              },
            },
          ]}
        />
      </Section>

      <Section title="Form I-90 answer table">
        <Table
          rows={answerTable.rows}
          rowClassName={(row) => (row.flag ? "bg-amber-50 dark:bg-amber-950" : "")}
          columns={[
            { header: "Part and item", cell: (row) => row.partAndItemNumber },
            { header: "Question", cell: (row) => row.question },
            { header: "Answer", cell: (row) => row.answer },
            { header: "Source", cell: (row) => row.sourceOfTheAnswer },
            { header: "Flag", cell: (row) => row.flag ?? <Muted>-</Muted> },
          ]}
        />
        <div className="mt-2">
          {answerTable.crossCheckVariances.length > 0 ? (
            <Flags
              title="Cross-check variances (listed, not reconciled)"
              items={answerTable.crossCheckVariances.map((v, i) => (
                <span key={i}>
                  <strong>{humanize(v.element)}</strong>: {v.variance} <Muted>({v.whereItAppears})</Muted>
                </span>
              ))}
            />
          ) : (
            <p className="text-xs">
              <Muted>Cross-check: no variance in A-number, name, date of birth, class of admission or date of admission.</Muted>
            </p>
          )}
        </div>
      </Section>

      <Section title="Filled Form I-90 PDF">
        <DownloadOrReason
          documentId={i90.generatedI90PdfDocumentId}
          label="Download filled Form I-90 (.pdf)"
          reason={i90.notGeneratedReason}
          onDownload={actions.downloadDocument}
        />
        <ul className="mt-2 text-xs text-black/60 dark:text-white/60">
          <li>Edition: {i90.formEdition}</li>
          <li>Blank form: {sourceUrl(i90.blankFormSource)}</li>
          <li>
            Agrees with the answer table:{" "}
            <YesNoBadge value={i90.agreesWithAnswerTable} notApplicableLabel="not applicable, no form filled" />
          </li>
          <li>
            Signature and date left for the client to sign:{" "}
            <YesNoBadge value={i90.signatureAndDateLeftForSignature} notApplicableLabel="not applicable, no form filled" />
          </li>
        </ul>
        <p className="mt-2 text-xs font-medium">Fields left blank</p>
        <NoneOr items={i90.fieldsLeftBlank}>
          <BulletList className="text-xs" items={i90.fieldsLeftBlank} />
        </NoneOr>
      </Section>

      <Section title="Form G-28">
        <DownloadOrReason
          documentId={g28.generatedG28PdfDocumentId}
          label="Download filled Form G-28 (.pdf)"
          reason={g28.notGeneratedReason}
          onDownload={actions.downloadDocument}
        />
        <ul className="mt-2 text-xs text-black/60 dark:text-white/60">
          <li>Edition: {g28.formEdition}</li>
          <li>Blank form: {sourceUrl(g28.blankFormSource)}</li>
          <li>Representative: {g28.representative}</li>
          <li>Client: {g28.client}</li>
          <li>
            Matches I-90 Part 7 (preparer):{" "}
            <YesNoBadge value={g28.matchesI90Part7} notApplicableLabel="not applicable, a form was not filled" />
          </li>
        </ul>
        {g28.openItems.length > 0 ? (
          <div className="mt-2">
            <Flags title="Open before filing" tone="amber" items={g28.openItems} />
          </div>
        ) : (
          <p className="mt-2 text-xs">
            <Muted>No open items.</Muted>
          </p>
        )}
      </Section>

      <Section title="Cover letter">
        <DownloadOrReason
          documentId={coverLetter.generatedCoverLetterDocumentId}
          label="Download cover letter (.docx)"
          reason={coverLetter.notGeneratedReason}
          onDownload={actions.downloadDocument}
        />
        <p className="mt-2">{coverLetter.reasonAndGround}</p>
        <p className="mt-1">
          <Muted>Fee:</Muted> {coverLetter.feeOrFeeExemptionBasis}
        </p>
        {coverLetter.statesStatusRestsOnSecondaryEvidence !== undefined && (
          <p className="mt-1 text-xs">
            States that status rests on secondary evidence:{" "}
            <YesNoBadge value={coverLetter.statesStatusRestsOnSecondaryEvidence} />
          </p>
        )}
        <p className="mt-2 text-xs font-medium">
          Enclosures{" "}
          {coverLetter.enclosuresMatchTabs === null ? (
            <Badge label="no letter to check" tone="neutral" />
          ) : (
            <Badge
              label={coverLetter.enclosuresMatchTabs ? "match the tabs" : "do not match the tabs"}
              tone={coverLetter.enclosuresMatchTabs ? "green" : "red"}
            />
          )}
        </p>
        <NoneOr items={coverLetter.enclosureList}>
          <BulletList className="text-xs" items={coverLetter.enclosureList} />
        </NoneOr>
      </Section>

      <Section title="Evidence index">
        <Table
          rows={output.evidenceIndex}
          columns={[
            { header: "Tab", cell: (row) => row.tabNumber },
            { header: "Document", cell: (row) => row.document },
            { header: "What it proves", cell: (row) => row.whatItProves },
            { header: "Original or copy", cell: (row) => row.originalOrCopy },
            { header: "Translation", cell: (row) => row.translationStatus },
          ]}
        />
      </Section>

      <Section title="Evidence request list">
        <Table
          rows={output.evidenceRequestList}
          columns={[
            { header: "Item", cell: (row) => row.item },
            { header: "Who gets it", cell: (row) => row.whoGetsIt },
            { header: "Why the packet is weaker without it", cell: (row) => row.whyThePacketIsWeakerWithoutIt },
          ]}
        />
      </Section>

      <Section title="Fee and filing checklist">
        <Table
          rows={checklistRows}
          columns={[
            { header: "Item", cell: ([, label]) => label },
            { header: "Entry", cell: ([key]) => output.feeAndFilingChecklist[key] },
          ]}
        />
      </Section>

      <Section title="Client instruction sheet">
        <DownloadOrReason
          documentId={sheet.generatedInstructionSheetDocumentId}
          label="Download client instruction sheet (.docx)"
          reason={sheet.notGeneratedReason}
          onDownload={actions.downloadDocument}
        />
        <div className="mt-2">
          {sheetCovers ? (
            <ChecklistList
              items={sheetRows.map(([key, label]) => ({
                badge: sheetCovers[key] ? "covered" : "missing",
                badgeClassName: sheetCovers[key] ? toneClass.green : toneClass.red,
                content: label,
              }))}
            />
          ) : (
            <p className="text-xs">
              <Muted>No instruction sheet was generated, so there is nothing to check against item 11.</Muted>
            </p>
          )}
        </div>
      </Section>

      <Section title="Calendar items">
        <Table
          rows={output.calendarItems}
          columns={[
            { header: "Item", cell: (row) => row.item },
            { header: "When", cell: (row) => row.when },
          ]}
        />
      </Section>

      <Section title="QA gate: i90-packet-review">
        <Callout title="Filing readiness" tone={resolution.filingReady ? "neutral" : "red"}>
          <p>
            <Badge
              label={resolution.filingReady ? "filing ready" : "not filing ready"}
              tone={resolution.filingReady ? "green" : "red"}
            />
          </p>
          <p className="mt-2 text-xs font-medium">Blocking items still open</p>
          <NoneOr items={resolution.openBlockingItems}>
            <BulletList className="text-xs" items={resolution.openBlockingItems} />
          </NoneOr>
          <p className="mt-2 text-xs font-medium">Blocking items resolved in this run</p>
          <NoneOr items={resolution.resolvedBlockingItems}>
            <BulletList className="text-xs" items={resolution.resolvedBlockingItems} />
          </NoneOr>
        </Callout>
        <div className="mt-3">
          {output.qaGateReport ? (
            <QaGateReportView report={output.qaGateReport} />
          ) : routing.buildProceeded ? (
            <Callout title="No QA gate report" tone="red">
              <p>The build proceeded but the run returned no i90-packet-review report. Run it on this matter before the packet is filed.</p>
            </Callout>
          ) : (
            <p className="text-xs">
              <Muted>Not run: the build stopped before a packet was assembled, so there was nothing for the gate to review.</Muted>
            </p>
          )}
        </div>
      </Section>
    </ReportBody>
  );
}
