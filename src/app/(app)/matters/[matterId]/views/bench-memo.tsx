import type { SkillViewProps } from "./types";
import { Badge, BulletList, ChecklistList, Flags, Muted, ReportBody, Section, Table, toneClass } from "./primitives";

// The SKILL.md's target length: "Three to four pages."
const MAX_PAGES = 4;

export function BenchMemoView({ output, actions }: SkillViewProps<"bench-memo">) {
  const { benchMemo, gapList, citationTable, crossExposureList } = output;
  const { selfCheck } = benchMemo;
  const documentId = benchMemo.generatedBenchMemoDocumentId.trim();
  const verifiedCount = citationTable.filter((c) => c.verified).length;

  return (
    <ReportBody>
      <Section title="Bench memo">
        {documentId ? (
          <button
            type="button"
            onClick={() => actions.downloadDocument(documentId)}
            className="w-fit rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
          >
            Download bench memo (.docx)
          </button>
        ) : (
          <p>
            <Muted>
              No bench memo was generated in this run
              {benchMemo.notGeneratedReason ? `: ${benchMemo.notGeneratedReason}` : "."}
            </Muted>
          </p>
        )}
        <p className="mt-1 text-xs">
          {benchMemo.pageCount === null ? (
            <Muted>Page count unknown: the memo was not rendered.</Muted>
          ) : (
            <>
              <Muted>
                {benchMemo.pageCount} page{benchMemo.pageCount === 1 ? "" : "s"} (target: three to four)
              </Muted>{" "}
              {benchMemo.pageCount > MAX_PAGES && <Badge label="over four pages" tone="amber" />}
            </>
          )}
        </p>
        <p className="mt-1 text-xs">
          <Muted>
            {benchMemo.preparedDate
              ? `Prepared ${benchMemo.preparedDate}`
              : "Prepared date left bracketed: no run date or note gave one."}
          </Muted>
        </p>
        {benchMemo.sectionsInOrder.length > 0 ? (
          <BulletList className="mt-1 text-xs" items={benchMemo.sectionsInOrder} />
        ) : (
          <p className="mt-1 text-xs">
            <Muted>No sections reported.</Muted>
          </p>
        )}
      </Section>

      <Flags
        title="Tier One intake items missing (drafted with brackets; supply before the hearing)"
        tone="amber"
        items={benchMemo.tierOneMissing}
      />

      <Flags title="Self check: blocking" items={selfCheck.blocking} />

      <Section title="Self check before delivering">
        {selfCheck.blocking.length === 0 && (
          <p className="mb-1 text-xs">
            <Muted>No blocking items.</Muted>
          </p>
        )}
        <ChecklistList
          items={[
            ...selfCheck.shouldFix.map((item) => ({ badge: "should_fix", badgeClassName: toneClass.amber, content: item })),
            ...selfCheck.optional.map((item) => ({ badge: "optional", badgeClassName: toneClass.neutral, content: item })),
          ]}
        />
      </Section>

      <Section title="Gap list">
        <Table
          rows={gapList}
          empty="No bracketed gaps reported."
          columns={[
            { header: "Bracketed item", cell: (row) => row.bracketedItem },
            { header: "What would close it", cell: (row) => row.whatWouldCloseIt },
          ]}
        />
      </Section>

      <Section title="Citation table">
        {citationTable.length > 0 && (
          <p className="mb-1 text-xs">
            <Muted>
              {verifiedCount} of {citationTable.length} verified in this run. Reverify every authority the morning of
              the hearing.
            </Muted>
          </p>
        )}
        <Table
          rows={citationTable}
          empty="No authorities reported."
          columns={[
            {
              header: "Status",
              cell: (row) => (
                <Badge label={row.verified ? "verified" : "unverified"} tone={row.verified ? "green" : "amber"} />
              ),
            },
            { header: "Authority", cell: (row) => row.citation },
            { header: "Date verified", cell: (row) => row.dateVerified || <Muted>-</Muted> },
            { header: "Reverify", cell: (row) => row.reverifyNote },
            {
              header: "Confirmed at",
              cell: (row) => (row.url ? <span className="break-all">{row.url}</span> : <Muted>-</Muted>),
            },
          ]}
        />
      </Section>

      <Section title="Cross exposure list">
        {crossExposureList.length > 0 ? (
          <BulletList items={crossExposureList} />
        ) : (
          <p className="text-xs">
            <Muted>No cross exposures reported.</Muted>
          </p>
        )}
      </Section>
    </ReportBody>
  );
}
