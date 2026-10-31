import type { ReactNode } from "react";
import type { BriefDraftOutput } from "@/services/skill-runner/skills/brief-draft";
import type { SkillViewProps } from "./types";
import { Badge, BulletList, CitationsList, Flags, Muted, ReportBody, Section } from "./primitives";

const BRIEF_TYPE_LABELS: Record<BriefDraftOutput["brief"]["briefType"], string> = {
  merits_brief: "Merits brief (EOIR merits hearing)",
  NOID_rebuttal: "NOID rebuttal (USCIS Asylum Office)",
};

/** A flag list that still says "none" when empty, so every item stays visible. */
function FlagGroup({ title, items, tone = "red" }: { title: string; items: ReactNode[]; tone?: "red" | "amber" }) {
  if (items.length > 0) return <Flags title={title} items={items} tone={tone} />;
  return (
    <p className="text-xs">
      <strong>{title}:</strong> <Muted>None.</Muted>
    </p>
  );
}

export function BriefDraftView({ output, actions }: SkillViewProps<"brief-draft">) {
  const { brief, attorneyChecklist } = output;

  return (
    <ReportBody>
      <Section title="Brief">
        {brief.generatedBriefDocumentId ? (
          <button
            type="button"
            onClick={() => actions.downloadDocument(brief.generatedBriefDocumentId)}
            className="w-fit rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
          >
            Download draft brief (.docx)
          </button>
        ) : (
          <p>
            <Muted>No brief was generated in this run.</Muted>
          </p>
        )}
        {brief.notGeneratedReason && (
          <p className="mt-1 text-amber-800 dark:text-amber-300">
            <strong>Why not generated:</strong> {brief.notGeneratedReason}
          </p>
        )}
        <p className="mt-1 text-xs">
          <Muted>Draft for attorney review and cite-checking, not a filing.</Muted>
        </p>

        <ul className="mt-2 flex flex-col gap-1 text-xs">
          <li>Type: {BRIEF_TYPE_LABELS[brief.briefType]}</li>
          <li>Venue: {brief.venue}</li>
          <li>Controlling circuit: {brief.controllingCircuit}</li>
          <li className="flex flex-wrap items-center gap-1">
            Relief argued:{" "}
            {brief.reliefArgued.length > 0 ? (
              brief.reliefArgued.map((r) => <Badge key={r} label={r} tone="neutral" />)
            ) : (
              <Muted>none</Muted>
            )}
          </li>
          <li className="flex flex-wrap items-center gap-1">
            Protected grounds:{" "}
            {brief.protectedGrounds.length > 0 ? (
              brief.protectedGrounds.map((g) => <Badge key={g} label={g} tone="neutral" />)
            ) : (
              <Muted>none argued</Muted>
            )}
          </li>
          {brief.particularSocialGroupWording !== undefined && (
            <li>
              PSG wording used: <strong>&quot;{brief.particularSocialGroupWording}&quot;</strong>
            </li>
          )}
        </ul>

        <div className="mt-2">
          <strong>Record relied on</strong>
          {brief.recordRelied.length > 0 ? (
            <BulletList className="text-xs" items={brief.recordRelied} />
          ) : (
            <p className="text-xs">
              <Muted>None listed.</Muted>
            </p>
          )}
        </div>

        <div className="mt-2">
          <strong>Sections in order</strong>
          {brief.sectionsInOrder.length > 0 ? (
            <BulletList className="text-xs" items={brief.sectionsInOrder} />
          ) : (
            <p className="text-xs">
              <Muted>None listed.</Muted>
            </p>
          )}
        </div>

        {brief.noidConcernsAnswered !== undefined && (
          <div className="mt-2">
            <strong>NOID concerns answered</strong>
            {brief.noidConcernsAnswered.length > 0 ? (
              <BulletList className="text-xs" items={brief.noidConcernsAnswered} />
            ) : (
              <p className="text-xs">
                <Muted>None listed.</Muted>
              </p>
            )}
          </div>
        )}

        <div className="mt-3 flex flex-col gap-2">
          <FlagGroup title="Bars escalated to the attorney (not argued in the brief)" items={brief.barsEscalated} />
          <FlagGroup title="Missing factual predicates" items={brief.missingFactualPredicates} />
          <FlagGroup title="Unresolved consistency issues" items={brief.unresolvedConsistencyIssues} />
          <FlagGroup title="Other placeholders and open items" items={brief.otherPlaceholdersAndOpenItems} />
        </div>
      </Section>

      <Section title="Attorney checklist">
        <div className="flex flex-col gap-3">
          <FlagGroup title="[CITE] placeholders to fill" items={attorneyChecklist.citePlaceholdersToFill} />

          <div>
            <strong>Citations to Shepardize / verify</strong>
            <p className="text-xs">
              <Muted>
                Every citation in the draft is flagged for attorney verification. Unverified means this run did not
                confirm the authority against its text.
              </Muted>
            </p>
            <div className="mt-1">
              <CitationsList items={attorneyChecklist.citationsToShepardizeOrVerify} />
            </div>
          </div>

          <div>
            <strong>Factual assertions needing a record cite confirmed</strong>
            {attorneyChecklist.factualAssertionsNeedingRecordCiteConfirmed.length > 0 ? (
              <BulletList className="text-xs" items={attorneyChecklist.factualAssertionsNeedingRecordCiteConfirmed} />
            ) : (
              <p className="text-xs">
                <Muted>None.</Muted>
              </p>
            )}
          </div>

          <FlagGroup
            title="PSG-wording discrepancies across documents"
            items={attorneyChecklist.psgWordingDiscrepanciesAcrossDocuments}
          />
          <FlagGroup
            title="Circuit-specific issues to double-check"
            items={attorneyChecklist.circuitSpecificIssuesToDoubleCheck}
            tone="amber"
          />
        </div>
      </Section>
    </ReportBody>
  );
}
