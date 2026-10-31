import type { ReactNode } from "react";
import type { SkillViewActions, SkillViewProps } from "./types";
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
  ratingColor,
} from "./primitives";

type Output = SkillViewProps<"packet-build">["output"];
type Authority = Output["caseTheory"]["elementScorecard"][number]["authorityAnchor"][number];
type Priority = Output["masterActionChecklist"][number]["priority"];
type AnswerRow = Output["formI589"]["answerTable"][number];

const PRIORITY_ORDER: Record<Priority, number> = { blocking: 0, strongly_recommended: 1, optional: 2 };
const I589_PART_TITLES: Record<AnswerRow["part"], string> = {
  "A.I": "Part A.I - Information About You",
  "A.II": "Part A.II - Information About Your Spouse and Children",
  "A.III": "Part A.III - Information About Your Background",
  B: "Part B - Information About Your Application",
  C: "Part C - Additional Information About Your Application",
  D: "Part D - Your Signature",
  E: "Part E - Declaration of Person Preparing Form",
};
const VENUE_LABELS: Record<NonNullable<Output["packetSnapshot"]["venue"]["forum"]>, string> = {
  USCIS_Asylum_Office_affirmative: "USCIS Asylum Office (affirmative)",
  EOIR_defensive: "EOIR Immigration Court (defensive)",
};

/** Blocking first, then strongly recommended, then optional; stable within a tier. */
function byPriority<T extends { priority: Priority }>(items: T[]): T[] {
  return [...items].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
}

function SourceUrl({ url }: { url: string }) {
  if (!/^https?:\/\//i.test(url)) return <span className="break-all">{url}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="break-all underline">
      {url}
    </a>
  );
}

function authorityItems(authorities: Authority[]) {
  return authorities.map((a) => ({
    citation: a.citation,
    verified: a.verified,
    note: a.url ? <SourceUrl url={a.url} /> : undefined,
  }));
}

function None() {
  return <p className="text-xs text-black/50 dark:text-white/50">None.</p>;
}

function Download({
  documentId,
  label,
  missing,
  actions,
}: {
  documentId: string;
  label: string;
  missing: ReactNode;
  actions: SkillViewActions;
}) {
  const id = documentId.trim();
  return id ? (
    <button
      type="button"
      onClick={() => actions.downloadDocument(id)}
      className="w-fit rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
    >
      {label}
    </button>
  ) : (
    <p>
      <Muted>{missing}</Muted>
    </p>
  );
}

export function PacketBuildView({ output, actions }: SkillViewProps<"packet-build">) {
  const {
    packetSnapshot: snapshot,
    caseTheory,
    respondentDeclaration: declaration,
    countryConditionsMemo: memo,
    formI589,
    exhibitIndexAndChecklists: evidence,
    legalBrief,
    packetReviewReport: review,
  } = output;
  const { filledPdf } = formI589;
  const { formEdition } = filledPdf;
  const { filingChecklist } = evidence;
  const blockingCount = output.masterActionChecklist.filter((i) => i.priority === "blocking").length;
  const answerParts = (Object.keys(I589_PART_TITLES) as AnswerRow["part"][]).map((part) => ({
    part,
    rows: formI589.answerTable.filter((row) => row.part === part),
  }));

  return (
    <ReportBody>
      {blockingCount > 0 && (
        <Callout title="Not ready to file">
          <p>
            {blockingCount} blocking item{blockingCount === 1 ? "" : "s"} in the master action checklist (at the end of
            this report) must be resolved first.
          </p>
        </Callout>
      )}

      <Section title="1. Packet snapshot">
        <p>
          <strong>{snapshot.client}</strong> - {snapshot.country}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-1">
          <Muted>Relief sought:</Muted>
          {snapshot.reliefSought.length > 0 ? (
            snapshot.reliefSought.map((r) => <Badge key={r} label={r} tone="neutral" />)
          ) : (
            <Muted>none stated</Muted>
          )}
        </p>
        <p className="mt-1">
          <Badge
            label={snapshot.venue.forum ? VENUE_LABELS[snapshot.venue.forum] : "venue not confirmed"}
            tone={snapshot.venue.forum ? "green" : "amber"}
          />{" "}
          {snapshot.venue.courtOrOffice && <strong>{snapshot.venue.courtOrOffice}. </strong>}
          {snapshot.venue.basis}
        </p>
        <p className="mt-1">
          <Badge
            label={snapshot.controllingCircuit.circuit ?? "circuit not confirmed"}
            tone={snapshot.controllingCircuit.circuit ? "green" : "amber"}
          />{" "}
          {snapshot.controllingCircuit.basis}
        </p>
        <div className="mt-2">
          <strong>Materials received</strong>
          {snapshot.materialsReceived.length > 0 ? (
            <BulletList className="text-xs" items={snapshot.materialsReceived} />
          ) : (
            <None />
          )}
        </div>
        <Flags title="Not provided" tone="amber" items={snapshot.materialsNotProvided} />
      </Section>

      <Section title="2. Case theory">
        <Table
          rows={caseTheory.protectedGround}
          empty="No protected ground identified."
          columns={[
            { header: "Protected ground", cell: (row) => <Badge label={row.ground} tone="neutral" /> },
            { header: "Articulation", cell: (row) => row.articulation },
          ]}
        />
        <p className="mt-2 flex flex-wrap items-center gap-1">
          <Muted>Relief:</Muted>
          {caseTheory.relief.length > 0 ? (
            caseTheory.relief.map((r) => <Badge key={r} label={r} tone="neutral" />)
          ) : (
            <Muted>none</Muted>
          )}
        </p>
        <div className="mt-2">
          <strong>Element scorecard</strong>
          <Table
            rows={caseTheory.elementScorecard}
            columns={[
              { header: "Element", cell: (row) => row.element },
              { header: "Rating", cell: (row) => <Badge label={row.rating} className={ratingColor[row.rating]} /> },
              { header: "Basis", cell: (row) => row.basis },
              { header: "What would strengthen it", cell: (row) => row.whatWouldStrengthenIt },
              {
                header: "Authority anchor",
                cell: (row) =>
                  row.authorityAnchor.length > 0 ? (
                    <CitationsList items={authorityItems(row.authorityAnchor)} />
                  ) : (
                    <Muted>none</Muted>
                  ),
              },
            ]}
          />
        </div>
        <div className="mt-2 flex flex-col gap-2">
          <Flags
            title="Bars and escalation flags"
            items={caseTheory.barsAndEscalationFlags.map((f, i) => (
              <span key={i}>
                <strong>{f.flag}:</strong> {f.detail}
              </span>
            ))}
          />
          <Flags title="Gaps that still need client input" tone="amber" items={caseTheory.gapsNeedingClientInput} />
        </div>
      </Section>

      <Section title="3. The respondent declaration">
        <Download
          documentId={declaration.generatedDeclarationDocumentId}
          label="Download declaration (.docx)"
          missing={`No declaration was generated in this run${declaration.notGeneratedReason ? `: ${declaration.notGeneratedReason}` : "."}`}
          actions={actions}
        />
        {declaration.generatedDeclarationDocumentId.trim() && declaration.notGeneratedReason && (
          <p className="mt-1 text-xs">
            <Muted>{declaration.notGeneratedReason}</Muted>
          </p>
        )}
        <p className="mt-2">
          <Muted>{declaration.paragraphCount} numbered paragraph(s). Sections in order:</Muted>
        </p>
        {declaration.sectionsInOrder.length > 0 ? (
          <BulletList className="text-xs" items={declaration.sectionsInOrder} />
        ) : (
          <None />
        )}
        <div className="mt-2">
          <Flags title="[CLARIFY] flags" tone="amber" items={declaration.clarifyFlags} />
          {declaration.clarifyFlags.length === 0 && <Muted>No [CLARIFY] flags.</Muted>}
        </div>
      </Section>

      <Section title="4. Country-conditions memo">
        <p className="text-xs">
          <Muted>Recency cutoff applied: {memo.recencyCutoff} (nothing published before it).</Muted>
        </p>
        <Table
          rows={memo.sources}
          empty="No sources were retrieved."
          columns={[
            { header: "Source", cell: (s) => s.source },
            { header: "Date", cell: (s) => s.date },
            { header: "Link", cell: (s) => <SourceUrl url={s.link} /> },
            { header: "Claim supported", cell: (s) => s.claimSupported },
            {
              header: "Retrieved",
              cell: (s) => (s.retrievedAt.trim() ? s.retrievedAt : <Badge label="not retrieved in this run" tone="red" />),
            },
          ]}
        />
      </Section>

      <Section title="5. Form I-589">
        <div className="flex flex-col gap-1">
          <Download
            documentId={filledPdf.generatedI589PdfDocumentId}
            label="Download filled I-589 (.pdf, still fillable)"
            missing={`The I-589 PDF was not filled in this run${filledPdf.pendingNote ? `: ${filledPdf.pendingNote}` : "; the fill is pending the current blank form."}`}
            actions={actions}
          />
          {filledPdf.generatedI589PdfDocumentId.trim() && filledPdf.pendingNote && (
            <p className="text-xs">
              <Muted>{filledPdf.pendingNote}</Muted>
            </p>
          )}
          <p className="text-xs">
            <Muted>
              Blank form used: {filledPdf.blankFormUsed ?? "none"}. A filled PDF is a draft: check it against the answer
              table and the current official edition before filing.
            </Muted>
          </p>
          <p className="flex flex-wrap items-center gap-1">
            <Badge label={formEdition.verified ? "edition verified" : "edition unverified"} tone={formEdition.verified ? "green" : "amber"} />
            <span>
              Edition on the form: {formEdition.editionOnForm ?? <Muted>not stated</Muted>}; current per USCIS:{" "}
              {formEdition.currentEditionPerUscis ?? <Muted>not confirmed</Muted>}
            </span>
            {formEdition.url && (
              <Muted>
                (<SourceUrl url={formEdition.url} />)
              </Muted>
            )}
          </p>
        </div>

        <div className="mt-2 flex flex-col gap-2">
          <strong>Answer table</strong>
          {answerParts.map(({ part, rows }) => (
            <div key={part}>
              <p className="text-xs font-medium">{I589_PART_TITLES[part]}</p>
              <Table
                rows={rows}
                empty="No answers drafted for this part."
                rowClassName={(row) => (row.flag ? "bg-amber-50 dark:bg-amber-950" : "")}
                columns={[
                  { header: "Field", cell: (row) => row.field },
                  { header: "Drafted answer", cell: (row) => row.draftedAnswer },
                  { header: "Source in the record", cell: (row) => row.sourceInRecord },
                  { header: "Flag", cell: (row) => (row.flag ? row.flag : <Muted>-</Muted>) },
                ]}
              />
            </div>
          ))}
        </div>

        <div className="mt-2 flex flex-col gap-2">
          <Flags title="PDF fields left blank for follow-up" tone="amber" items={filledPdf.fieldsLeftBlankForFollowUp} />
          <Flags title="Flagged gaps" tone="amber" items={formI589.flaggedGaps} />
          <div>
            <strong>Cross-document discrepancies</strong>
            <Table
              rows={formI589.crossDocumentDiscrepancies}
              rowClassName={() => "text-red-800 dark:text-red-300"}
              columns={[
                { header: "Discrepancy", cell: (row) => row.discrepancy },
                { header: "Where it appears", cell: (row) => row.whereItAppears.join("; ") },
              ]}
            />
          </div>
        </div>
      </Section>

      <Section title="6. Exhibit index, gaps, translations and filing checklist">
        <Download
          documentId={evidence.exhibitIndex.generatedExhibitIndexDocumentId}
          label="Download exhibit index (.docx)"
          missing={`No exhibit index was generated in this run${evidence.exhibitIndex.notGeneratedReason ? `: ${evidence.exhibitIndex.notGeneratedReason}` : "."}`}
          actions={actions}
        />
        {evidence.exhibitIndex.generatedExhibitIndexDocumentId.trim() && evidence.exhibitIndex.notGeneratedReason && (
          <p className="mt-1 text-xs">
            <Muted>{evidence.exhibitIndex.notGeneratedReason}</Muted>
          </p>
        )}
        <div className="mt-2">
          <strong>Exhibit index</strong>
          <Table
            rows={evidence.exhibitIndex.exhibits}
            rowClassName={(row) => (row.elementsSupported.length === 0 ? "text-black/50 dark:text-white/50" : "")}
            columns={[
              { header: "Tab", cell: (row) => row.tab },
              { header: "Document", cell: (row) => row.document },
              {
                header: "Element(s) supported",
                cell: (row) =>
                  row.elementsSupported.length > 0 ? row.elementsSupported.join("; ") : <Badge label="supports no element" tone="amber" />,
              },
            ]}
          />
        </div>
        <div className="mt-2">
          <strong>Corroboration gap list</strong>
          <Table
            rows={evidence.corroborationGapList}
            columns={[
              { header: "Gap", cell: (row) => row.gap },
              {
                header: "Availability",
                cell: (row) => (
                  <Badge label={row.availability} tone={row.availability === "reasonably_available" ? "amber" : "neutral"} />
                ),
              },
              { header: "Action", cell: (row) => row.action },
            ]}
          />
        </div>
        <div className="mt-2">
          <strong>Translation and certification checklist</strong>
          <Table
            rows={evidence.translationAndCertificationChecklist}
            empty="No foreign-language documents."
            columns={[
              { header: "Document", cell: (row) => row.document },
              { header: "Language", cell: (row) => row.language },
              {
                header: "Certified translation",
                cell: (row) => <Badge label={row.complete ? "complete" : "needed"} tone={row.complete ? "green" : "red"} />,
              },
              { header: "What is needed", cell: (row) => row.whatIsNeeded },
            ]}
          />
        </div>
        <div className="mt-2">
          <strong>Filing checklist</strong> <Muted>({filingChecklist.venue})</Muted>
          <Table
            rows={filingChecklist.items}
            columns={[
              { header: "Requirement", cell: (row) => row.requirement },
              { header: "Status", cell: (row) => row.status },
              {
                header: "Authority",
                cell: (row) =>
                  row.authority.length > 0 ? <CitationsList items={authorityItems(row.authority)} /> : <Muted>none cited</Muted>,
              },
            ]}
          />
          <div className="mt-2 rounded-md border border-amber-300 p-2 dark:border-amber-900">
            <p>
              <strong>Deadline:</strong> {filingChecklist.deadline.rule}
              {filingChecklist.deadline.date && (
                <>
                  {" "}
                  <Badge label={filingChecklist.deadline.date} tone="amber" />
                </>
              )}
            </p>
            <p className="mt-1 text-xs">
              <Muted>Confirm against the current practice manual and the court&apos;s local operating procedures:</Muted>
            </p>
            {filingChecklist.deadline.authority.length > 0 ? (
              <CitationsList items={authorityItems(filingChecklist.deadline.authority)} />
            ) : (
              <Badge label="no authority cited: unverified" tone="red" />
            )}
          </div>
        </div>
      </Section>

      <Section title="7. Legal brief">
        {legalBrief ? (
          <>
            <p className="mb-1">
              <strong>{legalBrief.documentType}</strong> <Muted>(requested by: {humanize(legalBrief.requestedBy)})</Muted>
            </p>
            <Download
              documentId={legalBrief.generatedBriefDocumentId}
              label="Download brief (.docx)"
              missing={`No brief was generated in this run${legalBrief.notGeneratedReason ? `: ${legalBrief.notGeneratedReason}` : "."}`}
              actions={actions}
            />
            {legalBrief.generatedBriefDocumentId.trim() && legalBrief.notGeneratedReason && (
              <p className="mt-1 text-xs">
                <Muted>{legalBrief.notGeneratedReason}</Muted>
              </p>
            )}
            <div className="mt-2">
              <strong>Authorities and [CITE] placeholders</strong>
              <CitationsList items={authorityItems(legalBrief.authorities)} />
            </div>
            <div className="mt-2">
              <Flags title="Attorney checklist for the brief" tone="amber" items={legalBrief.attorneyChecklist} />
              {legalBrief.attorneyChecklist.length === 0 && <Muted>No checklist items.</Muted>}
            </div>
          </>
        ) : (
          <Muted>Not requested, and the practice profile does not call for one.</Muted>
        )}
      </Section>

      <Section title="8. Packet-review report">
        <div className="flex flex-col gap-2">
          <Flags title="Blocking issues" items={review.blockingIssues} />
          {review.blockingIssues.length === 0 && <Muted>No blocking issues.</Muted>}
          <div>
            <strong>Prioritized edit checklist</strong>
            <ChecklistList
              items={byPriority(review.prioritizedEditChecklist).map((item) => ({
                badge: item.priority,
                badgeClassName: priorityColor[item.priority],
                content: item.item,
              }))}
            />
          </div>
          <div>
            <strong>Case law to review</strong>
            <CitationsList
              items={review.caseLawToReview.map((c) => ({
                citation: c.citation,
                verified: c.verified,
                note: (
                  <>
                    {c.why}
                    {c.url && (
                      <>
                        {" "}
                        (<SourceUrl url={c.url} />)
                      </>
                    )}
                  </>
                ),
              }))}
            />
          </div>
          <Flags title="Escalation flags" items={review.escalationFlags} />

          <div className="mt-1 border-t border-black/10 pt-2 dark:border-white/10">
            <strong>Packet reviewed</strong>
            <p>
              {review.packetSnapshot.respondent} - {review.packetSnapshot.country} - relief:{" "}
              {review.packetSnapshot.relief.join(", ") || "none stated"} - {review.packetSnapshot.venueOrCircuit}
            </p>
            {review.packetSnapshot.documentsReviewed.length > 0 ? (
              <p className="text-xs">
                <Muted>Reviewed: {review.packetSnapshot.documentsReviewed.join(", ")}</Muted>
              </p>
            ) : (
              <None />
            )}
            {review.packetSnapshot.documentsNotProvided.length > 0 && (
              <p className="text-xs">
                <Muted>Not provided: {review.packetSnapshot.documentsNotProvided.join(", ")}</Muted>
              </p>
            )}
          </div>
          <div>
            <strong>I-589 findings</strong>
            <Table
              rows={review.i589Findings}
              columns={[
                { header: "Part", cell: (row) => row.part },
                { header: "Issue", cell: (row) => row.issue },
                { header: "Location", cell: (row) => row.location },
                { header: "Recommended edit", cell: (row) => row.recommendedEdit },
              ]}
            />
          </div>
          <div>
            <strong>Declaration findings</strong>
            <Table
              rows={review.declarationFindings.elementCoverage}
              columns={[
                { header: "Element", cell: (row) => row.element },
                { header: "Coverage", cell: (row) => <Badge label={row.coverage} className={coverageColor[row.coverage]} /> },
              ]}
            />
            <p className="mt-1">
              <strong>Nexus read:</strong> {review.declarationFindings.nexusRead}
            </p>
            <div className="mt-1">
              <Muted>Credibility risks:</Muted>
              {review.declarationFindings.credibilityRisks.length > 0 ? (
                <BulletList items={review.declarationFindings.credibilityRisks} />
              ) : (
                <None />
              )}
            </div>
            <div className="mt-1">
              <Muted>Fact-honest strengthening suggestions:</Muted>
              {review.declarationFindings.strengtheningSuggestions.length > 0 ? (
                <BulletList items={review.declarationFindings.strengtheningSuggestions} />
              ) : (
                <None />
              )}
            </div>
          </div>
          <div>
            <strong>Nexus and legal alignment</strong>
            <Table
              rows={review.nexusAndLegalAlignment}
              columns={[
                { header: "Element", cell: (row) => row.element },
                { header: "Alignment", cell: (row) => <Badge label={row.alignment} className={coverageColor[row.alignment]} /> },
                { header: "Notes", cell: (row) => row.notes },
              ]}
            />
          </div>
          <div>
            <strong>Consistency log</strong>
            <Table
              rows={review.consistencyLog}
              columns={[
                { header: "Discrepancy", cell: (row) => row.discrepancy },
                { header: "Where it appears", cell: (row) => row.whereItAppears },
              ]}
            />
          </div>
        </div>
      </Section>

      <Section title="9. Master action checklist">
        <ChecklistList
          items={byPriority(output.masterActionChecklist).map((item) => ({
            badge: item.priority,
            badgeClassName: priorityColor[item.priority],
            content: item.item,
          }))}
        />
      </Section>
    </ReportBody>
  );
}
