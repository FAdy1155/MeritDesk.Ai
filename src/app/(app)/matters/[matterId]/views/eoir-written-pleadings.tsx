import type { EoirWrittenPleadingsOutput } from "@/services/skill-runner/skills/eoir-written-pleadings";
import type { SkillViewProps } from "./types";
import {
  Badge,
  BulletList,
  Callout,
  ChecklistList,
  Flags,
  Muted,
  ReportBody,
  Section,
  Table,
  toneClass,
  yesNo,
  type ChecklistItem,
} from "./primitives";

type Build = EoirWrittenPleadingsOutput["buildTheConfigAndRunTheGenerator"];
type Config = NonNullable<Build["config"]>;
type Verify = EoirWrittenPleadingsOutput["verifyBeforeDelivering"];
type Step5Key = Exclude<keyof Verify, "everyPageViewed" | "pageCount">;
type Step5Check = Verify[Step5Key];

// Step 5's "Confirm:" items, in SKILL.md order.
const STEP5_CHECKS: { key: Step5Key; label: string }[] = [
  { key: "sevenPages", label: "Seven pages" },
  { key: "captionOnCoverPleadingsAndIndex", label: "Caption on the cover, the pleadings page and the index page" },
  {
    key: "nameAndANumberIdenticalEverywhere",
    label:
      "Name and A number identical everywhere (cover, both captions, COMES NOW, index caption, certificate of service header, pleading declaration)",
  },
  { key: "checkedBoxesMatchTheChoices", label: "Checked boxes match the attorney's choices" },
  { key: "allegationsAndChargeSentencesReadCorrectly", label: "Allegations sentence and charge sentence read correctly" },
  { key: "paragraph1DatesMatchTheNta", label: "Paragraph 1 dates match the NTA" },
  { key: "interpreterLanguageIsRight", label: "Interpreter language is right" },
  { key: "nothingSpillsOntoAnEighthPage", label: "Nothing spills onto an eighth page" },
];

// Representation 6's boxes, in the order the packet prints them.
const RELIEF_BOXES: { key: keyof Config["relief"]; label: (config: Config) => string }[] = [
  { key: "termination", label: () => "Termination of Proceedings" },
  { key: "asylum", label: () => "Asylum" },
  { key: "withholding", label: () => "Withholding of Removal (Restriction on Removal)" },
  { key: "cat", label: () => "Protection under the Convention Against Torture" },
  { key: "adjustment", label: () => "Adjustment of Status" },
  {
    key: "cancellation",
    label: (c) => `Cancellation of Removal (INA ${c.cancellationSection ?? "section not given"})`,
  },
  { key: "waiver", label: (c) => `Waiver of Inadmissibility (INA ${c.waiverSection ?? "section not given"})` },
  { key: "voluntaryDeparture", label: () => "Voluntary Departure" },
  { key: "other", label: () => "Other (reserves the right to apply for any relief within the Court's timeframe)" },
  { key: "none", label: () => "None" },
];

function checkItem(check: Step5Check, label: string): ChecklistItem {
  const badge = check.passes === null ? "not checked" : check.passes ? "pass" : "fail";
  const tone = check.passes === null ? toneClass.amber : check.passes ? toneClass.green : toneClass.red;
  return {
    badge,
    badgeClassName: tone,
    content: (
      <>
        {label}
        {check.note ? (
          <>
            {" - "}
            <Muted>{check.note}</Muted>
          </>
        ) : null}
      </>
    ),
  };
}

function numbers(list: number[]): string {
  return list.length > 0 ? list.join(", ") : "none";
}

function configRows(c: Config): { label: string; value: string }[] {
  return [
    { label: "Caption name", value: c.nameCaption },
    { label: "Full name", value: c.nameFull },
    { label: "A number", value: c.aNumber },
    { label: "Pronoun", value: c.pronoun },
    { label: "Immigration Judge", value: c.judge },
    { label: "Next hearing", value: c.nextHearing },
    { label: "NTA dated", value: c.ntaDate },
    { label: "NTA served", value: `${c.serviceMethod} on ${c.ntaServedDate}` },
    { label: "Paragraph 1 service wording", value: c.servicePhrase ?? "default (served on Respondent by [method] on [date])" },
    { label: "NTA filed with the Court", value: c.ntaFiledDate },
    { label: "Allegations admitted", value: numbers(c.admit) },
    { label: "Allegations denied", value: numbers(c.deny) },
    {
      label: "Charges",
      value:
        c.charges.length > 0
          ? c.charges.map((ch) => `INA ${ch.section} ${ch.concede ? "conceded" : "denied"}`).join("; ")
          : "none",
    },
    { label: "Country of removal", value: c.countryDesignated ?? "Declines to designate" },
    { label: "Cancellation section", value: c.cancellationSection ?? "not given" },
    { label: "Waiver section", value: c.waiverSection ?? "not given" },
    { label: "Hours estimate", value: String(c.hours) },
    {
      label: "Interpreter",
      value: c.language.trim().toLowerCase() === "english" ? "English (no interpreter requested)" : c.language,
    },
    { label: "Signature date", value: c.signDate },
  ];
}

function NoneReported() {
  return (
    <p className="text-xs">
      <Muted>None reported.</Muted>
    </p>
  );
}

export function EoirWrittenPleadingsView({ output, actions }: SkillViewProps<"eoir-written-pleadings">) {
  const {
    buildTheConfigAndRunTheGenerator: build,
    verifyBeforeDelivering: verify,
    deliverWithAShortCoverNote: note,
  } = output;
  const { config } = build;
  const generated = build.generatedPleadingsDocumentId.trim() !== "";
  const blocking = note.recordDidNotLineUp.filter((row) => row.blocksDrafting);
  const failedChecks = generated ? STEP5_CHECKS.filter((c) => verify[c.key].passes === false) : [];

  return (
    <ReportBody>
      <Callout title="Before filing" tone="neutral">
        <p>
          This packet is a draft, not a filing. The attorney checks every name, date, allegation and charge against the
          NTA and the entry record before it is signed, served and filed.
        </p>
      </Callout>

      <Flags
        title="Attorney decision needed before drafting"
        items={blocking.map((row, i) => (
          <span key={i}>
            {row.item}: NTA shows {row.ntaShows}; {row.source} shows {row.recordShows}
          </span>
        ))}
      />
      <Flags
        title="Step 5 checks the packet failed"
        items={failedChecks.map((c, i) => (
          <span key={i}>
            {c.label}
            {verify[c.key].note ? ` - ${verify[c.key].note}` : ""}
          </span>
        ))}
      />

      <Section title="Step 4. Build the config and run the generator">
        {generated ? (
          <button
            type="button"
            onClick={() => actions.downloadDocument(build.generatedPleadingsDocumentId)}
            className="w-fit rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
          >
            Download written pleadings (.docx)
          </button>
        ) : (
          <p>
            <Muted>No pleadings packet was generated in this run.</Muted>
          </p>
        )}
        {build.notGeneratedReason ? (
          <p className="mt-1">
            <strong>Why not generated:</strong> {build.notGeneratedReason}
          </p>
        ) : null}

        {config ? (
          <div className="mt-2 flex flex-col gap-2">
            <Table
              rows={configRows(config)}
              columns={[
                { header: "Config", cell: (row) => row.label },
                { header: "Value", cell: (row) => row.value },
              ]}
            />
            <div>
              <p className="mb-1 text-xs font-medium">Relief boxes (representation 6)</p>
              <ChecklistList
                items={RELIEF_BOXES.map((box) => ({
                  badge: config.relief[box.key] ? "checked" : "not checked",
                  badgeClassName: config.relief[box.key] ? toneClass.green : toneClass.neutral,
                  content: box.label(config),
                }))}
              />
            </div>
          </div>
        ) : (
          <p className="mt-1 text-xs">
            <Muted>No config could be written.</Muted>
          </p>
        )}
      </Section>

      <Section title="Step 5. Verify before delivering">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span className="flex items-center gap-1">
            Every page viewed: <Badge label={yesNo(verify.everyPageViewed)} tone={verify.everyPageViewed ? "green" : "red"} />
          </span>
          <span className="flex items-center gap-1">
            Pages rendered:{" "}
            <Badge label={String(verify.pageCount)} tone={verify.pageCount === 7 ? "green" : generated ? "red" : "neutral"} />
          </span>
        </div>
        <div className="mt-2">
          <ChecklistList items={STEP5_CHECKS.map((c) => checkItem(verify[c.key], c.label))} />
        </div>
      </Section>

      <Section title="Step 6. Deliver with a short cover note">
        <div className="flex flex-col gap-3">
          <Section title="Pleading posture used">
            <p>{note.pleadingPostureUsed.summary}</p>
            <p className="mt-1">
              <strong>Entry record:</strong> {note.pleadingPostureUsed.entryRecord}
            </p>
            <div className="mt-1">
              {note.pleadingPostureUsed.defaultsNotConfirmed.length > 0 ? (
                <Flags
                  title="Defaults used without the attorney's confirmation"
                  tone="amber"
                  items={note.pleadingPostureUsed.defaultsNotConfirmed}
                />
              ) : (
                <p className="text-xs">
                  <Muted>Every pleading choice was answered by the note or the file.</Muted>
                </p>
              )}
            </div>
          </Section>

          <Section title="What in the record did not line up">
            <Table
              rows={note.recordDidNotLineUp}
              empty="Nothing reported; the record lined up with the NTA."
              rowClassName={(row) => (row.blocksDrafting ? "bg-red-50 dark:bg-red-950" : "")}
              columns={[
                { header: "Item", cell: (row) => row.item },
                { header: "NTA shows", cell: (row) => row.ntaShows },
                { header: "Record shows", cell: (row) => row.recordShows },
                { header: "Source", cell: (row) => row.source },
                {
                  header: "Blocks drafting",
                  cell: (row) => <Badge label={yesNo(row.blocksDrafting)} tone={row.blocksDrafting ? "red" : "neutral"} />,
                },
              ]}
            />
          </Section>

          {note.stillNeedsToBeFilled.length > 0 ? (
            <Flags title="What still needs to be filled" tone="amber" items={note.stillNeedsToBeFilled} />
          ) : (
            <Section title="What still needs to be filled">
              <NoneReported />
            </Section>
          )}

          <Section title="Tab A and Tab B assembly reminder">
            <BulletList
              items={[
                <span key="a">
                  <strong>Tab A:</strong> {note.tabAAndTabBAssemblyReminder.tabA}
                </span>,
                <span key="b">
                  <strong>Tab B:</strong> {note.tabAAndTabBAssemblyReminder.tabB}
                </span>,
              ]}
            />
          </Section>

          {note.questionsForTheAttorney.length > 0 ? (
            <Flags title="Questions for the attorney" tone="amber" items={note.questionsForTheAttorney} />
          ) : (
            <Section title="Questions for the attorney">
              <NoneReported />
            </Section>
          )}
        </div>
      </Section>
    </ReportBody>
  );
}
