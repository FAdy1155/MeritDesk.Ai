import type { ReactNode } from "react";
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
  humanize,
  toneClass,
  yesNo,
} from "./primitives";

const BUTTON_CLASS = "w-fit rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black";

function ListOrNone({ items }: { items: ReactNode[] }) {
  return items.length > 0 ? <BulletList items={items} /> : <Muted>None.</Muted>;
}

function OkBadge({ ok, okLabel = "ok", problemLabel = "problem" }: { ok: boolean; okLabel?: string; problemLabel?: string }) {
  return <Badge label={ok ? okLabel : problemLabel} tone={ok ? "green" : "red"} />;
}

export function AsylumFeeProofPacketView({ output, actions }: SkillViewProps<"asylum-fee-proof-packet">) {
  const config = output.writeTheConfigAndBuild;
  const { buildReport, pageReview, faxCheck, receiptComparison, orderCheck, deadlines } = output.checkBeforeDelivering;
  const deliver = output.deliver;

  const configRows: [string, ReactNode][] = [
    ["Forum", config.forum ? (config.forum === "IC" ? "Immigration Court (IC)" : "Board of Immigration Appeals (BIA)") : <Muted>not settled</Muted>],
    ["Caption name", config.nameCaption],
    ["Full name", config.nameFull],
    ["A-number", config.aNumber],
    ["Fee", config.feeKind ? (config.feeKind === "annual" ? "Annual Asylum Fee" : "I-589 initial filing fee") : <Muted>not read</Muted>],
    ["Receipt (Tab A)", config.receiptDocument || <Muted>none</Muted>],
    ["Tracking ID", config.trackingId],
    ["Payment date", config.payDate],
    ["Amount", config.amount],
    ["Signing date", config.signDate],
    ["File name", config.fileStem],
  ];
  if (config.courtCity !== undefined) configRows.push(["Court city", config.courtCity]);
  if (config.judge !== undefined) configRows.push(["Immigration Judge", config.judge || <Muted>blank line</Muted>]);
  if (config.nextHearing !== undefined) configRows.push(["Next hearing", config.nextHearing || <Muted>blank line</Muted>]);
  configRows.push([
    "Order",
    config.order ? (
      <>
        Dated {config.order.date}
        {config.order.deadline ? `, deadline ${config.order.deadline}` : ""}
        {" - "}
        {config.order.orderDocument ? (
          `attached behind Tab B: ${config.order.orderDocument}`
        ) : (
          <span className="text-red-800 dark:text-red-300">not attached</span>
        )}
      </>
    ) : (
      "none"
    ),
  ]);
  configRows.push(["Filing", config.filing === "ECAS" ? "ECAS" : "paper"]);
  configRows.push(["Custody", config.detained ? "DETAINED" : "NON-DETAINED"]);
  if (config.proceedings !== undefined) configRows.push(["Proceedings", config.proceedings]);
  if (config.within30Days !== undefined) configRows.push(["Paid within 30 days of the anniversary", yesNo(config.within30Days)]);
  configRows.push(["Signature", humanize(config.signature)]);
  if (config.dhsLines !== undefined) {
    configRows.push(["DHS service block", config.dhsLines.length > 0 ? config.dhsLines.join(" / ") : <Muted>none</Muted>]);
  }

  const reportRows: { field: string; expected: string; result: ReactNode }[] = [
    {
      field: "page_number_problems",
      expected: "empty",
      result:
        buildReport.pageNumberProblems.length === 0 ? <OkBadge ok /> : <BulletList items={buildReport.pageNumberProblems} />,
    },
    {
      field: "special_characters",
      expected: "empty",
      result:
        buildReport.specialCharacters.length === 0 ? (
          <OkBadge ok />
        ) : (
          <span className="text-red-800 dark:text-red-300">{buildReport.specialCharacters.join(", ")}</span>
        ),
    },
    {
      field: "a_number_mentions",
      expected: `${buildReport.aNumberMentions.expected} (IC 3, BIA 4)`,
      result: (
        <>
          <OkBadge ok={buildReport.aNumberMentions.found === buildReport.aNumberMentions.expected} />{" "}
          {buildReport.aNumberMentions.found}
        </>
      ),
    },
    {
      field: "tracking_id_in_letter",
      expected: "true",
      result: <OkBadge ok={buildReport.trackingIdInLetter} okLabel="true" problemLabel="false" />,
    },
    { field: "pages", expected: "numbers only where the format numbers them", result: `${buildReport.pages.length} page(s), below` },
    { field: "index", expected: "the page labels printed in the index", result: `${buildReport.index.length} entr(ies), below` },
    { field: "warnings", expected: "each one read, fixed or passed on", result: `${buildReport.warnings.length}, below` },
  ];

  return (
    <ReportBody>
      <Section title="Step 4. Write the config and build">
        <Table
          rows={configRows}
          columns={[
            { header: "Field", cell: (row) => row[0] },
            { header: "Value", cell: (row) => row[1] },
          ]}
        />
        <div className="mt-2">
          <strong>Wording overrides</strong>
          {config.wordingOverrides.length > 0 ? (
            <BulletList
              items={config.wordingOverrides.map((o, i) => (
                <span key={i}>
                  <code>{o.field}</code>: {o.reason}
                </span>
              ))}
            />
          ) : (
            <p>
              <Muted>None; the default wording was used.</Muted>
            </p>
          )}
        </div>
      </Section>

      <Section title="Step 5. Check before delivering">
        <div className="flex flex-col gap-3">
          <div>
            <strong>Build report</strong>
            <Table
              rows={reportRows}
              columns={[
                { header: "Report field", cell: (row) => <code>{row.field}</code> },
                { header: "Expected", cell: (row) => row.expected },
                { header: "Result", cell: (row) => row.result },
              ]}
            />
          </div>

          <div>
            <strong>Pages</strong>
            <Table
              rows={buildReport.pages}
              columns={[
                { header: "Page", cell: (row) => row.page },
                { header: "Part", cell: (row) => row.part },
                { header: "Printed number", cell: (row) => row.number || <Muted>unnumbered</Muted> },
              ]}
            />
          </div>

          <div>
            <strong>Index</strong>
            <Table
              rows={buildReport.index}
              columns={[
                { header: "Entry", cell: (row) => row.entry },
                { header: "Pages", cell: (row) => row.label },
              ]}
            />
          </div>

          <div>
            <strong>Warnings</strong>
            <ChecklistList
              items={buildReport.warnings.map((w) => ({
                badge: w.handling,
                badgeClassName: w.handling === "fixed" ? toneClass.green : toneClass.amber,
                content: (
                  <>
                    {w.warning} <Muted>{w.note}</Muted>
                  </>
                ),
              }))}
            />
          </div>

          <div>
            <strong>Page review</strong>
            <p>
              Every page viewed: <OkBadge ok={pageReview.everyPageViewed} okLabel="yes" problemLabel="no" />
            </p>
            <Table
              rows={pageReview.partsChecked}
              columns={[
                { header: "Part", cell: (row) => humanize(row.part) },
                { header: "Result", cell: (row) => <OkBadge ok={row.ok} /> },
                { header: "Note", cell: (row) => row.note },
              ]}
            />
            <p className="mt-1">
              <Muted>Exhibit page number stamps:</Muted> {pageReview.exhibitPageNumberStamps}
            </p>
          </div>

          <div>
            <strong>Fax check</strong>
            <ul className="text-xs">
              <li>Firm fax: {faxCheck.firmFax || <Muted>none on file</Muted>}</li>
              <li>
                Mentions: {faxCheck.mentionsFound} of {faxCheck.mentionsExpected} expected{" "}
                <OkBadge ok={faxCheck.mentionsFound === faxCheck.mentionsExpected} />
              </li>
              <li>
                Retired numbers printed: {faxCheck.retiredNumbersPrinted}{" "}
                <OkBadge ok={faxCheck.retiredNumbersPrinted === 0} />
              </li>
            </ul>
          </div>

          <div>
            <strong>Receipt comparison</strong>
            <Table
              rows={receiptComparison}
              columns={[
                { header: "Field", cell: (row) => humanize(row.field) },
                { header: "Receipt", cell: (row) => row.receipt },
                { header: "Packet", cell: (row) => row.packet },
                { header: "Match", cell: (row) => <OkBadge ok={row.matches} okLabel="matches" problemLabel="mismatch" /> },
              ]}
            />
          </div>

          {orderCheck ? (
            <div>
              <strong>Order check</strong>
              <ul className="text-xs">
                <li>Order date: {orderCheck.orderDate}</li>
                {orderCheck.deadline && <li>Deadline: {orderCheck.deadline}</li>}
                <li>States the amount: {yesNo(orderCheck.statesAmount)}</li>
                <li>Read from page images (scan): {yesNo(orderCheck.readFromImages)}</li>
                <li>
                  Packet wording matches the order:{" "}
                  <OkBadge ok={orderCheck.packetWordingMatches} okLabel="yes" problemLabel="no" />
                </li>
              </ul>
              <div className="mt-1">
                <Muted>The order directs:</Muted>
                <ListOrNone items={orderCheck.directs} />
              </div>
              <p className="mt-1">{orderCheck.note}</p>
            </div>
          ) : (
            <p>
              <strong>Order check</strong> <Muted>No order in this case.</Muted>
            </p>
          )}

          <div>
            <strong>Deadlines</strong>
            {deadlines.deadline && <p>Deadline: {deadlines.deadline}</p>}
            <p>{deadlines.assessment}</p>
          </div>
        </div>
      </Section>

      <Section title="Step 6. Deliver">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {deliver.generatedPacketPdfDocumentId ? (
              <button
                type="button"
                onClick={() => actions.downloadDocument(deliver.generatedPacketPdfDocumentId)}
                className={BUTTON_CLASS}
              >
                Download filing packet (.pdf)
              </button>
            ) : (
              <Muted>No filing PDF was generated in this run; see the items below for why.</Muted>
            )}
            {deliver.generatedPacketWordDocumentId ? (
              <button
                type="button"
                onClick={() => actions.downloadDocument(deliver.generatedPacketWordDocumentId)}
                className={BUTTON_CLASS}
              >
                Download editable packet (.docx)
              </button>
            ) : (
              <Muted>No Word file was generated in this run.</Muted>
            )}
          </div>
          {deliver.generatedPacketWordDocumentId && (
            <p className="text-xs">
              <Muted>
                The Word file is the whole packet. Its page numbers and index are fixed at build time: an edit that adds or
                removes a page needs a rebuild.
              </Muted>
            </p>
          )}

          <Flags title="Needs action before filing" items={deliver.needsAction} />
          <Flags title="Questions for the attorney" tone="amber" items={deliver.questionsForTheAttorney} />

          <div>
            <strong>Packet contents</strong>
            <ListOrNone items={deliver.packetContents} />
          </div>
          <div>
            <strong>Left blank</strong>
            <ListOrNone items={deliver.leftBlank} />
          </div>
          <div>
            <strong>Defaults used</strong>
            <ListOrNone items={deliver.defaultsUsed} />
          </div>
          <p>
            <strong>Client name source:</strong> {deliver.clientNameSource}
          </p>

          <Callout title="Signer review" tone={deliver.signerReview.inkSignatureNeeded ? "red" : "neutral"}>
            <p>
              Signer: <strong>{deliver.signerReview.signerName}</strong>
            </p>
            <p>
              Ink signature needed:{" "}
              <Badge
                label={yesNo(deliver.signerReview.inkSignatureNeeded)}
                tone={deliver.signerReview.inkSignatureNeeded ? "red" : "neutral"}
              />
            </p>
            <p className="mt-1">{deliver.signerReview.note}</p>
          </Callout>
        </div>
      </Section>
    </ReportBody>
  );
}
