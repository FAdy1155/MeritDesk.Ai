import type { DeclarationDraftConciseOutput } from "@/services/skill-runner/skills/declaration-draft-concise";
import type { SkillViewProps } from "./types";
import { Badge, Flags, Muted, ReportBody, Section, Table, yesNo } from "./primitives";

type DeclarationPart = DeclarationDraftConciseOutput["declaration"]["sectionsInOrder"][number];

const MAX_PAGES = 6;

const PART_LABELS: Record<DeclarationPart["section"], string> = {
  identity_and_protected_characteristic: "Identity and protected characteristic",
  concise_chronology: "Concise chronology",
  nexus: "Nexus",
  fear_of_return: "Fear of return",
  protection_and_relocation: "Protection and relocation",
  timeliness: "Timeliness",
};

function paragraphsIn(part: DeclarationPart): number {
  return Math.max(0, part.lastParagraph - part.firstParagraph + 1);
}

export function DeclarationDraftConciseView({ output, actions }: SkillViewProps<"declaration-draft-concise">) {
  const { declaration, signatureBlock, flagsForTheAttorney } = output;
  const parts = declaration.sectionsInOrder;

  // Item 1 makes fear of return the longest part; paragraph counts are the
  // report's only measure of that, so the note says so.
  const fearOfReturn = parts.find((p) => p.section === "fear_of_return");
  const longerThanFear = fearOfReturn
    ? parts.filter((p) => p.section !== "fear_of_return" && paragraphsIn(p) > paragraphsIn(fearOfReturn))
    : [];

  const pageBadge =
    declaration.pageCount === null ? (
      <Badge label="not rendered" tone="amber" />
    ) : declaration.pageCount > MAX_PAGES ? (
      <Badge label={`over ${MAX_PAGES} pages`} tone="red" />
    ) : (
      <Badge label={`within ${MAX_PAGES} pages`} tone="green" />
    );

  return (
    <ReportBody>
      <Section title="Declaration">
        <p>
          {declaration.declarantName} - {declaration.declarantRole}
        </p>
        <p className="text-xs">
          <Muted>
            Draft for attorney and client review, not a filing: the client must review, correct, and adopt it.
          </Muted>
        </p>
        <div className="mt-2">
          {declaration.generatedDocumentId ? (
            <button
              type="button"
              onClick={() => actions.downloadDocument(declaration.generatedDocumentId)}
              className="w-fit rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
            >
              Download declaration (.docx)
            </button>
          ) : (
            <Muted>
              No declaration was generated in this run
              {declaration.notGeneratedReason ? `: ${declaration.notGeneratedReason}` : "; see the flags below."}
            </Muted>
          )}
        </div>
        <p className="mt-2 flex flex-wrap items-center gap-2">
          <span>
            Pages: {declaration.pageCount === null ? "not rendered" : declaration.pageCount} - Paragraphs:{" "}
            {declaration.paragraphCount}
          </span>
          {pageBadge}
        </p>

        <div className="mt-2">
          <Table
            rows={parts}
            rowClassName={(row) => (row.section === "fear_of_return" ? "font-medium" : "")}
            empty="No parts reported."
            columns={[
              { header: "Part", cell: (row) => PART_LABELS[row.section] },
              { header: "Heading", cell: (row) => (row.heading ? row.heading : <Muted>none</Muted>) },
              {
                header: "Paragraphs",
                cell: (row) =>
                  row.firstParagraph === row.lastParagraph
                    ? `${row.firstParagraph}`
                    : `${row.firstParagraph}-${row.lastParagraph}`,
              },
              { header: "Count", cell: (row) => paragraphsIn(row) },
            ]}
          />
        </div>
        {declaration.generatedDocumentId && !fearOfReturn && (
          <p className="mt-1 text-xs text-red-800 dark:text-red-300">
            No fear-of-return part is reported; it is the center of this declaration.
          </p>
        )}
        {longerThanFear.length > 0 && (
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
            By paragraph count, fear of return is shorter than {longerThanFear.map((p) => PART_LABELS[p.section]).join(", ")};
            the skill makes it the longest part.
          </p>
        )}
      </Section>

      <Section title="Signature block">
        <ul className="flex flex-col gap-1">
          <li className="flex items-center gap-2">
            Signature block included:{" "}
            <Badge label={yesNo(signatureBlock.included)} tone={signatureBlock.included ? "green" : "red"} />
          </li>
          <li>
            Declarant language:{" "}
            {signatureBlock.declarantLanguage ?? <Muted>not stated in the report</Muted>}
          </li>
          <li className="flex items-center gap-2">
            Certification required by the declarant&apos;s language:{" "}
            <Badge
              label={yesNo(signatureBlock.certificationRequired)}
              tone={signatureBlock.certificationRequired === null ? "amber" : "neutral"}
            />
          </li>
          <li className="flex items-center gap-2">
            Interpreter or translation certification:{" "}
            {signatureBlock.certificationBlock ? (
              <Badge label={signatureBlock.certificationBlock} tone="neutral" />
            ) : signatureBlock.certificationRequired === true ? (
              <Badge label="required, none included" tone="red" />
            ) : signatureBlock.certificationRequired === null ? (
              <Badge label="none included, need unconfirmed" tone="amber" />
            ) : (
              <Muted>none needed</Muted>
            )}
          </li>
        </ul>
      </Section>

      {flagsForTheAttorney.length > 0 ? (
        <Flags title="Flags for the attorney" items={flagsForTheAttorney} />
      ) : (
        <Section title="Flags for the attorney">
          <Muted>None reported.</Muted>
        </Section>
      )}
    </ReportBody>
  );
}
