import type { OrthographyCheckOutput } from "@/services/skill-runner/skills/orthography-check";
import type { SkillViewProps } from "./types";
import { Badge, BulletList, Callout, Flags, Muted, ReportBody, Section, Table, yesNo, type Tone } from "./primitives";

type Output = OrthographyCheckOutput;
type Category = Output["fixed"][number]["category"];
type CorrectedCopy = Output["correctedCopy"];

const SOURCE_FORMAT_LABELS: Record<CorrectedCopy["sourceFormat"], string> = {
  txt: "Plain text file",
  pasted_text: "Text pasted into the case note",
  docx: "Word document",
  pdf: "PDF",
  scanned_or_image_pdf: "Scanned or image PDF",
};

const DELIVERED_FORMAT_LABELS: Record<CorrectedCopy["deliveredFormat"], string> = {
  docx: "Word document (.docx)",
  txt: "Plain text",
};

// SKILL.md: a pronoun switch in a declaration "can read as a factual
// inconsistency", so a flagged one is surfaced in red, other flags in amber.
function flaggedTone(category: Category): Tone {
  return category === "Pronoun_consistency_and_agreement" ? "red" : "amber";
}

export function OrthographyCheckView({ output, actions }: SkillViewProps<"orthography-check">) {
  const { correctedCopy } = output;
  const documentId = correctedCopy.generatedCorrectedCopyDocumentId;

  return (
    <ReportBody>
      <p className="font-medium">Orthography check: {output.documentName}</p>

      <Section title="Summary">
        <p>{output.summary}</p>
        <Muted className="text-xs">
          {output.fixed.length} fixed, {output.flaggedForYourDecision.length} flagged for your decision
        </Muted>
      </Section>

      <Section title="Fixed (applied to the corrected copy)">
        <Table
          rows={output.fixed}
          empty="No fixes were applied."
          columns={[
            { header: "#", cell: (row) => row.number },
            { header: "Location", cell: (row) => row.location },
            { header: "Category", cell: (row) => <Badge label={row.category} tone="neutral" /> },
            { header: "Original", cell: (row) => row.original },
            { header: "Corrected", cell: (row) => row.corrected },
          ]}
        />
      </Section>

      {output.flaggedForYourDecision.length > 0 ? (
        <Callout title="Flagged for your decision (NOT changed)" tone="amber">
          <Table
            rows={output.flaggedForYourDecision}
            columns={[
              { header: "#", cell: (row) => row.number },
              { header: "Location", cell: (row) => row.location },
              { header: "Category", cell: (row) => <Badge label={row.category} tone={flaggedTone(row.category)} /> },
              { header: "Text", cell: (row) => row.text },
              { header: "Why flagged", cell: (row) => row.whyFlagged },
              { header: "Options", cell: (row) => row.options },
            ]}
          />
        </Callout>
      ) : (
        <Section title="Flagged for your decision (NOT changed)">
          <Muted>Nothing was flagged.</Muted>
        </Section>
      )}

      <Section title="Name and term consistency">
        <Table
          rows={output.nameAndTermConsistency}
          empty="No name or term was spelled more than one way."
          columns={[
            { header: "Name or term", cell: (row) => row.nameOrTerm },
            {
              header: "Variants found",
              cell: (row) => (
                <BulletList items={row.variants.map((v, i) => <span key={i}>{`"${v.spelling}" (${v.count})`}</span>)} />
              ),
            },
            {
              header: "Standardized to",
              cell: (row) =>
                row.standardizedTo ? row.standardizedTo : <Badge label="not standardized, flagged" tone="amber" />,
            },
          ]}
        />
      </Section>

      {output.documentWideNotes && <Flags title="Document-wide notes" tone="amber" items={output.documentWideNotes} />}

      <Section title="Categories with no issues">
        {output.categoriesWithNoIssues.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {output.categoriesWithNoIssues.map((c, i) => (
              <li key={i} className="flex items-start gap-2">
                <Badge label={c.category} tone="green" />
                <span>{c.note}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Muted>Every category had at least one issue.</Muted>
        )}
      </Section>

      <Flags title="Not checked" tone="amber" items={output.notChecked} />

      <Section title="Corrected copy">
        {documentId ? (
          <button
            type="button"
            onClick={() => actions.downloadDocument(documentId)}
            className="w-fit rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
          >
            {correctedCopy.deliveredFormat === "docx" ? "Download corrected copy (.docx)" : "Download corrected copy (text)"}
          </button>
        ) : (
          <Callout title="No corrected copy was generated in this run">
            <p>{correctedCopy.note ?? "The report does not say why."}</p>
          </Callout>
        )}
        <ul className="mt-1 text-xs text-black/60 dark:text-white/60">
          <li>Source: {SOURCE_FORMAT_LABELS[correctedCopy.sourceFormat]}</li>
          <li>Delivered as: {DELIVERED_FORMAT_LABELS[correctedCopy.deliveredFormat]}</li>
          <li>Tracked changes: {yesNo(correctedCopy.trackedChanges)}</li>
        </ul>
        {documentId && correctedCopy.note && <p className="mt-1">{correctedCopy.note}</p>}
      </Section>
    </ReportBody>
  );
}
