import type { DeclarationDraftOutput } from "@/services/skill-runner/skills/declaration-draft";
import type { SkillViewProps } from "./types";
import { Badge, BulletList, Flags, Muted, ReportBody, Section, Table, yesNo } from "./primitives";

type DeclarationPart = DeclarationDraftOutput["declaration"]["sectionsInOrder"][number]["part"];

// The SKILL.md's "What the declaration must cover" titles, for the section order table.
const PART_LABELS: Record<DeclarationPart, string> = {
  identity_background: "Identity and background",
  chronology: "Chronology of harm",
  nexus: "Nexus in the client's own words",
  fear: "Fear of return",
  protection_relocation: "Government protection / relocation",
  timeliness: "Timeliness facts",
};

const CERTIFICATION_LABELS = {
  interpreter: "Interpreter certification (read back through a competent interpreter)",
  translation: "Translation certification (read by the declarant in a language they understand)",
} as const;

export function DeclarationDraftView({ output, actions }: SkillViewProps<"declaration-draft">) {
  const { declaration, signatureBlock } = output;

  return (
    <ReportBody>
      <Section title="The declaration">
        {declaration.generatedDocumentId ? (
          <button
            type="button"
            onClick={() => actions.downloadDocument(declaration.generatedDocumentId)}
            className="w-fit rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
          >
            Download draft declaration (.docx)
          </button>
        ) : (
          <p>
            <Muted>No declaration was generated in this run.</Muted>
          </p>
        )}
        {declaration.notGeneratedReason && (
          <p className="mt-1 text-amber-800 dark:text-amber-300">
            <strong>Why not generated:</strong> {declaration.notGeneratedReason}
          </p>
        )}
        <p className="mt-1 text-xs">
          <Muted>
            Draft for attorney and client review, not a filing: the client must review, correct and adopt it before it
            is signed.
          </Muted>
        </p>
        <ul className="mt-2 text-xs">
          <li>Declarant: {declaration.declarant}</li>
          <li>Relief in play: {declaration.reliefInPlay}</li>
          <li>Numbered paragraphs: {declaration.paragraphCount}</li>
        </ul>

        <div className="mt-2">
          <strong>Sections in order</strong>
          <Table
            rows={declaration.sectionsInOrder}
            columns={[
              { header: "Part", cell: (row) => PART_LABELS[row.part] },
              {
                header: "Paragraphs",
                cell: (row) => (row.paragraphs ? row.paragraphs : <Badge label="none in draft" tone="amber" />),
              },
            ]}
          />
        </div>

        <div className="mt-2">
          <strong>Facts drawn from</strong>
          {declaration.factSources.length > 0 ? (
            <BulletList className="text-xs" items={declaration.factSources} />
          ) : (
            <p className="text-xs">
              <Muted>No sources listed.</Muted>
            </p>
          )}
        </div>

        <div className="mt-2">
          <strong>Consistency checked against</strong>
          {declaration.consistencyCheckedAgainst.length > 0 ? (
            <BulletList className="text-xs" items={declaration.consistencyCheckedAgainst} />
          ) : (
            <p className="text-xs">
              <Muted>No I-589, prior statement or intake in the record to cross-check against.</Muted>
            </p>
          )}
        </div>
      </Section>

      <Section title="Signature block">
        <ul className="text-xs">
          <li>
            Signature block included:{" "}
            <Badge label={yesNo(signatureBlock.included)} tone={signatureBlock.included ? "green" : "red"} />
          </li>
          <li>
            Interpreter/translation certification:{" "}
            {signatureBlock.interpreterTranslationCertification
              ? CERTIFICATION_LABELS[signatureBlock.interpreterTranslationCertification]
              : "none included"}
          </li>
          <li>Declarant&apos;s language: {signatureBlock.declarantLanguage ?? "not shown in the record"}</li>
        </ul>
      </Section>

      {output.flagsForTheAttorney.length > 0 ? (
        <Flags title="Flags for the attorney" items={output.flagsForTheAttorney} />
      ) : (
        <Section title="Flags for the attorney">
          <Muted>None reported.</Muted>
        </Section>
      )}
    </ReportBody>
  );
}
