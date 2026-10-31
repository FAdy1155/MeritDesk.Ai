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
  toneClass,
  yesNo,
} from "./primitives";

type Output = SkillViewProps<"evidence-organizer">["output"];
type Venue = NonNullable<Output["filingChecklist"]["venue"]>;

/**
 * A matter file the run could not read keeps its NOT REVIEWED or EXCLUDED
 * label in the Document column; its elements are unknown, not "background
 * or clutter". Same test as wasNotReviewed in the skill module, copied here
 * so that module (and zod) stays out of the client bundle.
 */
function wasNotReviewed(row: { document: string }): boolean {
  return /\bnot reviewed\b/i.test(row.document) || /\bEXCLUDED\b/.test(row.document);
}

const venueLabel: Record<Venue, string> = {
  EOIR_defensive: "EOIR (defensive): Immigration Court Practice Manual",
  USCIS_Asylum_Office_affirmative: "USCIS Asylum Office (affirmative): Asylum Office practice",
};

/** Yes / no / unknown badge for a check that may not be determinable. */
function CheckBadge({ value }: { value: boolean | null }) {
  return <Badge label={yesNo(value)} tone={value === null ? "neutral" : value ? "green" : "red"} />;
}

function reasonablyAvailableBadge(value: boolean | null) {
  if (value === null) return <Badge label="not shown in the record" tone="neutral" />;
  return value ? (
    <Badge label="reasonably available: obtain" tone="amber" />
  ) : (
    <Badge label="not reasonably available: document on the record" tone="neutral" />
  );
}

export function EvidenceOrganizerView({ output, actions }: SkillViewProps<"evidence-organizer">) {
  const { countryConditionsStatus: conditions, filingChecklist, indexOfDocuments } = output;
  const notReviewedCount = output.exhibitIndex.filter(wasNotReviewed).length;

  return (
    <ReportBody>
      <Section title="Index of Documents (Word)">
        {indexOfDocuments.generatedIndexOfDocumentsDocumentId ? (
          <>
            <button
              type="button"
              onClick={() => actions.downloadDocument(indexOfDocuments.generatedIndexOfDocumentsDocumentId)}
              className="w-fit rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
            >
              Download Index of Documents (.docx)
            </button>
            {indexOfDocuments.pageCount !== null ? <Muted>{indexOfDocuments.pageCount} page(s)</Muted> : null}
          </>
        ) : (
          <Muted>
            No Index of Documents was generated in this run
            {indexOfDocuments.notGeneratedReason ? `: ${indexOfDocuments.notGeneratedReason}` : "."}
          </Muted>
        )}
      </Section>
      <Section title="Exhibit index">
        <Table
          rows={output.exhibitIndex}
          empty="No documents indexed."
          rowClassName={(row) =>
            wasNotReviewed(row)
              ? "bg-amber-50 dark:bg-amber-950/40"
              : row.elementsSupported.length === 0
                ? "bg-red-50 dark:bg-red-950/40"
                : ""
          }
          columns={[
            { header: "Tab", cell: (row) => row.tab },
            { header: "Document", cell: (row) => row.document },
            { header: "Date", cell: (row) => row.date },
            {
              header: "Element(s) supported",
              cell: (row) =>
                wasNotReviewed(row) ? (
                  <span className="flex flex-wrap items-center gap-1">
                    <Badge label="not reviewed: elements unknown" tone="amber" />
                    {row.elementsSupported.length > 0 ? row.elementsSupported.join(", ") : null}
                  </span>
                ) : row.elementsSupported.length > 0 ? (
                  row.elementsSupported.join(", ")
                ) : (
                  <Badge label="none: background or clutter" tone="red" />
                ),
            },
            { header: "Language / translation status", cell: (row) => row.languageTranslationStatus },
          ]}
        />
      </Section>

      <Section title="Element-to-evidence matrix">
        <Table
          rows={output.elementToEvidenceMatrix}
          empty="No elements mapped."
          rowClassName={(row) => (row.supportingExhibits.length === 0 ? "bg-red-50 dark:bg-red-950/40" : "")}
          columns={[
            { header: "Element", cell: (row) => row.element },
            {
              header: "Exhibits",
              cell: (row) =>
                row.supportingExhibits.length > 0 ? (
                  row.supportingExhibits.join(", ")
                ) : (
                  <Badge label="no supporting exhibit" tone="red" />
                ),
            },
            {
              header: "Count",
              cell: (row) => (
                <Badge
                  label={String(row.supportingExhibits.length)}
                  tone={row.supportingExhibits.length === 0 ? "red" : "neutral"}
                />
              ),
            },
          ]}
        />
        {notReviewedCount > 0 ? (
          <Muted className="mt-2 block text-xs">
            {notReviewedCount} document{notReviewedCount === 1 ? " was" : "s were"} not reviewed in this run and{" "}
            {notReviewedCount === 1 ? "is" : "are"} not mapped here; an element shown with no exhibit may be supported by{" "}
            {notReviewedCount === 1 ? "it" : "one of them"}.
          </Muted>
        ) : null}
      </Section>

      <Section title="Corroboration gaps">
        <Table
          rows={output.corroborationGaps}
          empty="No corroboration gaps reported."
          columns={[
            { header: "Missing item", cell: (row) => row.missingItem },
            { header: "Reasonably available?", cell: (row) => reasonablyAvailableBadge(row.reasonablyAvailable) },
            { header: "Action", cell: (row) => row.action },
          ]}
        />
      </Section>

      <Section title="Country-conditions status">
        <Table
          rows={conditions.sourcesPresent}
          empty="No country-conditions sources in the record."
          rowClassName={(row) => (row.withinRecencyRule === false ? "bg-red-50 dark:bg-red-950/40" : "")}
          columns={[
            { header: "Tab", cell: (row) => row.tab },
            { header: "Source", cell: (row) => row.source },
            { header: "Date", cell: (row) => row.date },
            { header: "Within firm tiers", cell: (row) => <CheckBadge value={row.withinFirmTiers} /> },
            { header: "Within recency rule", cell: (row) => <CheckBadge value={row.withinRecencyRule} /> },
          ]}
        />
        <p className="mt-2">
          <strong>Currency:</strong> {conditions.currency}
        </p>
        <div className="mt-2">
          <strong>Recommended additions:</strong>
          {conditions.recommendedAdditions.length > 0 ? (
            <BulletList items={conditions.recommendedAdditions} />
          ) : (
            <Muted> None.</Muted>
          )}
        </div>
        <div className="mt-2">
          {conditions.expertDeclaration.length > 0 ? (
            <Flags title="Expert declaration expected" tone="amber" items={conditions.expertDeclaration} />
          ) : (
            <p>
              <strong>Expert declaration:</strong> <Muted>none expected by the practice profile.</Muted>
            </p>
          )}
        </div>
      </Section>

      {output.translationCertificationToDo.length > 0 ? (
        <Flags title="Translation/certification to-do" items={output.translationCertificationToDo} />
      ) : (
        <Section title="Translation/certification to-do">
          <Muted>Nothing outstanding.</Muted>
        </Section>
      )}

      <Section title="Filing checklist">
        <p className="flex flex-wrap items-center gap-1">
          <strong>Venue:</strong>
          {filingChecklist.venue ? (
            venueLabel[filingChecklist.venue]
          ) : (
            <Badge label="not confirmed" tone="red" />
          )}
          {filingChecklist.courtOrOffice ? <Muted>- {filingChecklist.courtOrOffice}</Muted> : null}
        </p>
        <div className="mt-2">
          <ChecklistList
            items={filingChecklist.items.map((item) => ({
              badge: item.confirmAgainstIcpmOrCourtLop ? "confirm against ICPM / court LOP" : "checklist",
              badgeClassName: item.confirmAgainstIcpmOrCourtLop ? toneClass.amber : toneClass.neutral,
              content: (
                <span className="flex flex-col gap-1">
                  <span>{item.item}</span>
                  {item.deadline ? (
                    <span>
                      <strong>Deadline:</strong> {item.deadline}
                    </span>
                  ) : null}
                  {item.citedTo.length > 0 ? (
                    <CitationsList
                      items={item.citedTo.map((c) => ({
                        citation: c.citation,
                        verified: c.verified,
                        note: c.url,
                      }))}
                    />
                  ) : (
                    <Muted className="text-xs">No authority cited.</Muted>
                  )}
                </span>
              ),
            }))}
          />
        </div>
        <div className="mt-2">
          <strong>ECAS electronic submission steps:</strong>
          {filingChecklist.ecasElectronicSubmissionSteps ? (
            filingChecklist.ecasElectronicSubmissionSteps.length > 0 ? (
              <BulletList items={filingChecklist.ecasElectronicSubmissionSteps} />
            ) : (
              <Muted> None listed.</Muted>
            )
          ) : (
            <Muted> Not included; ECAS e-filing is not enabled in the practice profile, so the paper filing checklist applies.</Muted>
          )}
        </div>
      </Section>
    </ReportBody>
  );
}
