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

type Output = SkillViewProps<"i90-packet-review">["output"];
type Reason = NonNullable<Output["reasonForFiling"]>;
type ProofItems = NonNullable<Output["identityAndStatusProof"]>;
type Proof = ProofItems["identity"];
type Evidence = NonNullable<Output["evidenceAssessment"]>;
type Exposure = NonNullable<Output["exposureScreen"]>;
type Mechanics = NonNullable<Output["filingMechanics"]>;
type LiveChecks = Mechanics["runTimeVerification"];
type ThresholdTest = Output["thresholdDetermination"]["thresholdTests"][number]["test"];

const cardTypeLabel: Record<Output["packetSnapshot"]["cardType"], string> = {
  ten_year: "Ten year card",
  two_year_conditional: "Two year conditional card",
  not_provided: "Card type not provided",
};

const thresholdTestLabel: Record<ThresholdTest, string> = {
  conditional_resident: "Conditional resident",
  pending_or_imminent_naturalization: "Pending or imminent naturalization",
  client_abroad: "Client abroad",
  timing_on_expiring_card: "Timing on an expiring card",
};

const proofClass: Record<Proof["rating"], string> = {
  sufficient: toneClass.green,
  thin: toneClass.amber,
  missing: toneClass.red,
};

const mechanicsClass: Record<Mechanics["edition"]["status"], string> = {
  clear: toneClass.green,
  fix: toneClass.amber,
};

// Section H items in the order report item 10 lists them.
const mechanicsRows: [Exclude<keyof Mechanics, "runTimeVerification">, string][] = [
  ["edition", "Edition"],
  ["fee", "Fee"],
  ["channel", "Channel"],
  ["address", "Address"],
  ["assembly", "Assembly"],
  ["deliverability", "Deliverability"],
  ["postFilingCalendarItems", "Post-filing calendar items"],
];

// The "Run-time verification" checks in the SKILL.md's order.
const liveCheckRows: [keyof LiveChecks, string][] = [
  ["i90AndG28EditionDates", "I-90 and G-28 edition dates, older editions accepted"],
  ["filingFees", "Online and paper fees, biometrics billed separately"],
  ["feeExemptReasons", "Fee exempt reasons and conditions"],
  ["feeWaiverI912Availability", "Form I-912 available for the I-90"],
  ["directFilingAddress", "Direct filing address (USPS and courier)"],
  ["onlineFilingForSelectedReason", "Online filing for the selected reason"],
  ["automaticExtensionPeriod", "Automatic extension period on the receipt notice"],
  ["processingTimes", "Processing times"],
];

/** A true / false / undetermined concern as a badge. */
function concernBadge(present: boolean | null): ReactNode {
  if (present === null) return <Badge label="not determined" tone="amber" />;
  return present ? <Badge label="concern present" tone="red" /> : <Badge label="no concern" tone="green" />;
}

/** Links only http(s) URLs; anything else is shown as text. */
function sourceUrl(url: string): ReactNode {
  if (!/^https?:\/\//i.test(url)) return <span className="break-all">{url}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="break-all underline">
      {url}
    </a>
  );
}

function ProofRow({ title, proof, extra }: { title: string; proof: Proof; extra?: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Badge label={proof.rating} className={proofClass[proof.rating]} />
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

function NoneOr({ items, children }: { items: unknown[]; children: ReactNode }) {
  return items.length > 0 ? <>{children}</> : <Muted>None.</Muted>;
}

/**
 * Report items 4-11 are omitted after a scope stop ("say so and stop"); an
 * omission inside scope is a defect the escalation flags also carry.
 */
function ReviewItem<T>({
  title,
  value,
  outOfScope,
  children,
}: {
  title: string;
  value: T | undefined;
  outOfScope: boolean;
  children: (value: T) => ReactNode;
}) {
  if (value !== undefined) return <>{children(value)}</>;
  return (
    <Section title={title}>
      {outOfScope ? (
        <Muted>Not reviewed: outside this review&apos;s scope.</Muted>
      ) : (
        <p className="text-amber-800 dark:text-amber-300">Missing from this report, although the packet is within scope.</p>
      )}
    </Section>
  );
}

function ReasonSection({ reason }: { reason: Reason }) {
  const { feeConsequence } = reason;
  return (
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
      </ul>
      <p className="mt-1">{reason.assessment}</p>
      <p className="mt-2 text-xs font-medium">Fee consequence</p>
      <ul className="text-xs text-black/60 dark:text-white/60">
        <li>Selected reason fee exempt: {yesNo(feeConsequence.selectedReasonFeeExempt)}</li>
        <li>
          Exemption claimed: {yesNo(feeConsequence.exemptionClaimed)}
          {feeConsequence.exemptionClaimed &&
            ` - claimed exemption supported: ${yesNo(feeConsequence.claimedExemptionSupported)}`}
        </li>
      </ul>
      <p className="mt-1">{feeConsequence.explanation}</p>
    </Section>
  );
}

function ProofSection({ proof }: { proof: ProofItems }) {
  const { mutilatedCard } = proof.ground;
  return (
    <Section title="Identity and status proof">
      <ul className="flex flex-col gap-2">
        <ProofRow title="Identity" proof={proof.identity} />
        <ProofRow
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
        <ProofRow
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
  );
}

function EvidenceSection({ evidence }: { evidence: Evidence }) {
  return (
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
      <div className="mt-2">
        {evidence.confirmWithClientItems.length > 0 ? (
          <Flags title="Confirm with client if true" tone="amber" items={evidence.confirmWithClientItems} />
        ) : (
          <>
            <p className="text-xs font-medium">Confirm with client if true</p>
            <Muted>None.</Muted>
          </>
        )}
      </div>
    </Section>
  );
}

function ExposureSection({ exposure }: { exposure: Exposure }) {
  const exposureRows = [
    { area: "Abandonment of residence", ...exposure.abandonmentOfResidence },
    { area: "Criminal history", ...exposure.criminalHistory },
    { area: "Removal or rescission", ...exposure.removalOrRescission },
  ];
  const holdFiling = exposure.filingHold.holdUntilAttorneyClears;
  return (
    <Section title="Exposure screen">
      <Table
        rows={exposureRows}
        columns={[
          { header: "Area", cell: (row) => row.area },
          { header: "Status", cell: (row) => <Badge label={row.status} className={statusColor[row.status]} /> },
          { header: "Notes", cell: (row) => row.notes },
        ]}
      />
      <div className="mt-2">
        <Callout title="Filing until the attorney clears exposure" tone={holdFiling ? "red" : "neutral"}>
          <p>
            <Badge label={holdFiling ? "hold" : "no hold"} tone={holdFiling ? "red" : "green"} />{" "}
            {exposure.filingHold.note}
          </p>
        </Callout>
      </div>
    </Section>
  );
}

function MechanicsSection({ mechanics }: { mechanics: Mechanics }) {
  const unverifiedChecks = liveCheckRows.filter(([key]) => !mechanics.runTimeVerification[key].verified).length;
  return (
    <Section title="Filing mechanics">
      <Table
        rows={mechanicsRows}
        columns={[
          { header: "Item", cell: ([, label]) => label },
          {
            header: "Status",
            cell: ([key]) => <Badge label={mechanics[key].status} className={mechanicsClass[mechanics[key].status]} />,
          },
          { header: "Finding", cell: ([key]) => mechanics[key].finding },
        ]}
      />
      <p className="mb-1 mt-3 text-xs font-medium">
        Run-time verification on uscis.gov
        {unverifiedChecks > 0 && (
          <span className="text-amber-800 dark:text-amber-300"> ({unverifiedChecks} not verified in this run)</span>
        )}
      </p>
      <Table
        rows={liveCheckRows}
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
  );
}

export function I90PacketReviewView({ output }: SkillViewProps<"i90-packet-review">) {
  const { packetSnapshot: snapshot, thresholdDetermination: threshold } = output;
  const outOfScope = !threshold.withinReviewScope;

  return (
    <ReportBody>
      <Section title="Packet snapshot">
        <p>
          {snapshot.client} - A-number {snapshot.aNumber}
        </p>
        <ul className="mt-1 text-xs text-black/60 dark:text-white/60">
          <li>
            {cardTypeLabel[snapshot.cardType]} - issued {snapshot.cardIssueDate}, expires {snapshot.cardExpirationDate}
          </li>
          <li>Reason for filing (Part 2): {snapshot.reasonForFiling}</li>
          <li>
            Filing channel: {humanize(snapshot.filingChannel)} - fee: {snapshot.fee} - basis: {snapshot.feeBasis}
          </li>
          <li>Documents reviewed: {snapshot.documentsReviewed.join(", ") || "none"}</li>
        </ul>
        {snapshot.documentsNotProvided.length > 0 && (
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
            Documents not provided: {snapshot.documentsNotProvided.join(", ")}
          </p>
        )}
        {snapshot.caseFactsNotProvided.length > 0 && (
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
            Case facts not provided: {snapshot.caseFactsNotProvided.join(", ")}
          </p>
        )}
      </Section>

      {output.blockingIssues.length > 0 ? (
        <Flags title={`Blocking issues (${output.blockingIssues.length})`} items={output.blockingIssues} />
      ) : (
        <Section title="Blocking issues">
          <Muted>None found.</Muted>
        </Section>
      )}

      <Section title="Threshold determination">
        {threshold.withinReviewScope ? (
          <p className="mb-1 text-xs">
            <Muted>Within this review&apos;s scope (renewal and replacement).</Muted>
          </p>
        ) : (
          <p className="mb-1 font-medium text-red-800 dark:text-red-300">
            Outside this review&apos;s scope (renewal and replacement only); the review stopped here.
          </p>
        )}
        <p>
          May use Form I-90:{" "}
          <Badge
            label={yesNo(threshold.mayUseI90)}
            tone={threshold.mayUseI90 === null ? "amber" : threshold.mayUseI90 ? "green" : "red"}
          />{" "}
          {threshold.basis}
        </p>
        <div className="mt-2">
          <Table
            rows={threshold.thresholdTests}
            empty={outOfScope ? "Not run: the review stopped at the scope." : "None."}
            columns={[
              { header: "Test", cell: (row) => thresholdTestLabel[row.test] },
              { header: "Result", cell: (row) => concernBadge(row.concernPresent) },
              { header: "Finding", cell: (row) => row.finding },
            ]}
          />
        </div>
      </Section>

      <ReviewItem title="Reason for filing" value={output.reasonForFiling} outOfScope={outOfScope}>
        {(reason) => <ReasonSection reason={reason} />}
      </ReviewItem>

      <ReviewItem title="Form findings" value={output.formFindings} outOfScope={outOfScope}>
        {(findings) => (
          <Section title="Form findings">
            <Table
              rows={findings}
              columns={[
                { header: "Part", cell: (row) => humanize(row.part) },
                { header: "Issue", cell: (row) => row.issue },
                { header: "Location", cell: (row) => row.location },
                { header: "Recommended edit", cell: (row) => row.recommendedEdit },
              ]}
            />
          </Section>
        )}
      </ReviewItem>

      <ReviewItem title="Identity and status proof" value={output.identityAndStatusProof} outOfScope={outOfScope}>
        {(proof) => <ProofSection proof={proof} />}
      </ReviewItem>

      <ReviewItem title="Evidence assessment" value={output.evidenceAssessment} outOfScope={outOfScope}>
        {(evidence) => <EvidenceSection evidence={evidence} />}
      </ReviewItem>

      <ReviewItem title="Exposure screen" value={output.exposureScreen} outOfScope={outOfScope}>
        {(exposure) => <ExposureSection exposure={exposure} />}
      </ReviewItem>

      <ReviewItem title="Consistency log" value={output.consistencyLog} outOfScope={outOfScope}>
        {(log) => (
          <Section title="Consistency log">
            <NoneOr items={log}>
              <BulletList
                items={log.map((c, i) => (
                  <span key={i}>
                    {c.discrepancy} - <Muted>{c.whereItAppears}</Muted>
                  </span>
                ))}
              />
            </NoneOr>
          </Section>
        )}
      </ReviewItem>

      <ReviewItem title="Filing mechanics" value={output.filingMechanics} outOfScope={outOfScope}>
        {(mechanics) => <MechanicsSection mechanics={mechanics} />}
      </ReviewItem>

      <ReviewItem title="Authorities to review" value={output.authoritiesToReview} outOfScope={outOfScope}>
        {(authorities) => (
          <Section title="Authorities to review">
            <CitationsList
              items={authorities.map((a) => ({
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
        )}
      </ReviewItem>

      {output.escalationFlags.length > 0 ? (
        <Flags title="Escalation flags" items={output.escalationFlags} />
      ) : (
        <Section title="Escalation flags">
          <Muted>None.</Muted>
        </Section>
      )}

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
