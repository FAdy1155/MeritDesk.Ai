import type { ReactNode } from "react";
import type {
  LegalArgumentResearchCitation,
  LegalArgumentResearchOutput,
} from "@/services/skill-runner/skills/legal-argument-research";
import type { SkillViewProps } from "./types";
import { Badge, BulletList, CitationsList, Flags, Muted, ReportBody, Section, Table, yesNo, type CitationItem } from "./primitives";

type Snapshot = LegalArgumentResearchOutput["snapshot"];
type SupportingAuthority = LegalArgumentResearchOutput["supportingAuthority"][number];
type Alternative = LegalArgumentResearchOutput["betterApproach"]["alternatives"][number];
type VolatileArea = LegalArgumentResearchOutput["verificationAndCurrencyNote"]["volatileAreasConfirmed"][number];

const kindLabel: Record<Snapshot["argumentOrMotionType"]["kind"], string> = {
  motion: "motion",
  substantive_argument: "substantive argument",
};

const circuitSourceLabel: Record<Snapshot["courtOrCircuit"]["controllingCircuitSource"], string> = {
  matter: "from the matter",
  attorney_note: "from the attorney note",
  practice_profile: "from the practice profile",
  matter_documents: "from the matter documents",
  not_confirmed: "not confirmed",
};

const alternativeKindLabel: Record<Alternative["kind"], string> = {
  alternative_motion_or_procedural_vehicle: "alternative motion or procedural vehicle",
  alternative_legal_theory_or_framing: "alternative legal theory or framing",
  better_sequencing: "better sequencing",
  stronger_evidentiary_predicate: "stronger evidentiary predicate",
};

// Same test as the skill module's escalation flags: the SKILL.md's
// placeholder form for authority the run could not confirm.
function isPlaceholder(citation: string): boolean {
  return /^\s*\[CITE:/i.test(citation);
}

/** A link only for http(s); the URL is model output, so anything else is shown as text. */
function SourceUrl({ url }: { url: string }) {
  if (!/^https?:\/\//i.test(url)) return <span className="break-all">{url}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="break-all underline">
      {url}
    </a>
  );
}

function citationNote(c: LegalArgumentResearchCitation): ReactNode {
  if (isPlaceholder(c.citation)) return "placeholder for the attorney to fill";
  if (c.url) return <SourceUrl url={c.url} />;
  return c.verified ? "no URL given" : "not retrieved in this run";
}

function toCitationItems(citations: LegalArgumentResearchCitation[]): CitationItem[] {
  return citations.map((c) => ({ citation: c.citation, verified: c.verified, note: citationNote(c) }));
}

/** The verified / unverified marker CitationsList uses, for citations shown in a table. */
function VerifiedBadge({ citation }: { citation: LegalArgumentResearchCitation }) {
  if (isPlaceholder(citation.citation)) return <Badge label="placeholder" tone="red" />;
  return <Badge label={citation.verified ? "verified" : "unverified"} tone={citation.verified ? "green" : "amber"} />;
}

/** A labeled list that still says "None." when empty, so every field stays visible. */
function LabeledList({ label, items }: { label: string; items: ReactNode[] }) {
  return (
    <div className="mt-2">
      <p className="text-xs font-medium">{label}</p>
      {items.length > 0 ? <BulletList items={items} /> : <Muted className="text-xs">None.</Muted>}
    </div>
  );
}

function AuthorityList({ label, citations }: { label: string; citations: LegalArgumentResearchCitation[] }) {
  return (
    <div className="mt-2">
      <p className="text-xs font-medium">{label}</p>
      <CitationsList items={toCitationItems(citations)} />
    </div>
  );
}

// Same test as the skill module's escalation flags: the currency rule says to
// verify "with web tools", so a date with no page retrieved behind it is not
// a confirmation.
function isVolatileAreaConfirmed(area: VolatileArea): boolean {
  return area.confirmedThrough !== "" && area.urls.length > 0;
}

function VolatileConfirmed({ area }: { area: VolatileArea }) {
  if (!area.confirmedThrough) return <Badge label="not confirmed in this run" tone="red" />;
  if (!isVolatileAreaConfirmed(area)) {
    return (
      <span className="flex flex-col items-start gap-1">
        <span className="whitespace-nowrap">{area.confirmedThrough}</span>
        <Badge label="no source retrieved: not confirmed" tone="red" />
      </span>
    );
  }
  return <span className="whitespace-nowrap">{area.confirmedThrough}</span>;
}

export function LegalArgumentResearchView({ output }: SkillViewProps<"legal-argument-research">) {
  const {
    snapshot,
    governingStandard,
    supportingAuthority,
    strengthAssessment,
    betterApproach,
    verificationAndCurrencyNote: note,
  } = output;
  const { argumentOrMotionType, posture, courtOrCircuit } = snapshot;

  // Each citation the report gives without having verified it in this run,
  // once, wherever it appears (the skill module's escalation flags list the
  // same set).
  const allCitations: LegalArgumentResearchCitation[] = [
    ...governingStandard.anchorAuthority,
    ...supportingAuthority,
    ...strengthAssessment.governmentsLikelyCounter.flatMap((c) => c.authority),
    ...betterApproach.alternatives.flatMap((a) => a.authority),
    ...note.everythingToShepardize,
  ];
  const toConfirm = [
    ...new Set(allCitations.filter((c) => !c.verified && !isPlaceholder(c.citation)).map((c) => c.citation.trim())),
  ];
  const placeholders = [...new Set(allCitations.filter((c) => isPlaceholder(c.citation)).map((c) => c.citation.trim()))];

  return (
    <ReportBody>
      <Section title="Snapshot">
        <ul className="flex flex-col gap-0.5">
          <li>
            <strong>Legal question:</strong> {snapshot.legalQuestion}
          </li>
          <li className="flex flex-wrap items-center gap-1">
            <strong>Argument / motion type:</strong>
            <Badge label={kindLabel[argumentOrMotionType.kind]} tone="neutral" />
            <span>{argumentOrMotionType.type}</span>
          </li>
          <li>
            <strong>Posture:</strong> {posture.forum}; detained: {yesNo(posture.detained)}; stage:{" "}
            {posture.stageOfProceedings}
          </li>
          <li>
            <strong>Court:</strong> {courtOrCircuit.court}
          </li>
          <li className="flex flex-wrap items-center gap-1">
            <strong>Controlling circuit:</strong>
            <span>{courtOrCircuit.controllingCircuit}</span>
            <Badge
              label={circuitSourceLabel[courtOrCircuit.controllingCircuitSource]}
              tone={courtOrCircuit.controllingCircuitSource === "not_confirmed" ? "red" : "neutral"}
            />
          </li>
          <li>
            <strong>Standard of review:</strong> {snapshot.standardOfReview}
          </li>
        </ul>
      </Section>

      <Section title="Governing standard">
        <LabeledList label="What must be shown" items={governingStandard.whatMustBeShown} />
        {governingStandard.deadlinesAndLimits ? (
          <LabeledList label="Deadlines and limits" items={governingStandard.deadlinesAndLimits} />
        ) : (
          <div className="mt-2">
            <p className="text-xs font-medium">Deadlines and limits</p>
            <Muted className="text-xs">Not reported (not a motion).</Muted>
          </div>
        )}
        <AuthorityList label="Anchor authority" citations={governingStandard.anchorAuthority} />
      </Section>

      <Section title="Supporting authority">
        <Table<SupportingAuthority>
          rows={supportingAuthority}
          empty="No supporting authority reported."
          rowClassName={(a) => (a.verified ? "" : "bg-amber-50 dark:bg-amber-950/40")}
          columns={[
            {
              header: "Citation",
              cell: (a) => (
                <span className="flex flex-col items-start gap-1">
                  <span>{a.citation}</span>
                  <VerifiedBadge citation={a} />
                </span>
              ),
            },
            { header: "Why it supports", cell: (a) => a.whyItSupports },
            { header: "How directly it fits the facts", cell: (a) => a.howDirectlyItFitsTheFacts },
            { header: "URL", cell: (a) => (a.url ? <SourceUrl url={a.url} /> : <Muted>none given</Muted>) },
            {
              header: "Retrieved",
              cell: (a) =>
                a.retrievedAt ? (
                  <span className="whitespace-nowrap">{a.retrievedAt}</span>
                ) : (
                  <Muted>not retrieved in this run</Muted>
                ),
            },
          ]}
        />
      </Section>

      <Section title="Strength assessment">
        <p className="flex flex-wrap items-center gap-1">
          <strong>Rating:</strong>
          <Badge label={strengthAssessment.rating} />
        </p>
        <p className="mt-1">{strengthAssessment.reasoning}</p>
        <LabeledList label="Key weaknesses" items={strengthAssessment.keyWeaknesses} />
        <div className="mt-2">
          <p className="text-xs font-medium">{"The government's likely counter (DHS/ICE)"}</p>
          {strengthAssessment.governmentsLikelyCounter.length === 0 ? (
            <Muted className="text-xs">None reported.</Muted>
          ) : (
            <ol className="flex list-inside list-decimal flex-col gap-2">
              {strengthAssessment.governmentsLikelyCounter.map((c, i) => (
                <li key={i}>
                  <span>{c.counterargument}</span>
                  <p className="mt-0.5 text-xs">
                    <strong>How it likely lands:</strong> {c.howItLikelyLands}
                  </p>
                  <AuthorityList label="Authority DHS is likely to rely on" citations={c.authority} />
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="mt-2">
          <p className="text-xs font-medium">How the circuit cuts</p>
          <p>{strengthAssessment.howTheCircuitCuts}</p>
        </div>
      </Section>

      <Section title="Better approach">
        <p className="flex flex-wrap items-center gap-1">
          {betterApproach.currentApproachIsSound ? (
            <Badge label="current approach is sound" tone="green" />
          ) : (
            <Badge label="a better approach is recommended" tone="amber" />
          )}
        </p>
        {betterApproach.currentApproachIsSound && (
          <p className="mt-1">
            {betterApproach.currentApproachIsSoundBecause ?? <Muted>No reason given.</Muted>}
          </p>
        )}
        {!betterApproach.currentApproachIsSound && betterApproach.currentApproachIsSoundBecause && (
          <p className="mt-1">
            <Muted>{betterApproach.currentApproachIsSoundBecause}</Muted>
          </p>
        )}
        <div className="mt-2">
          <p className="text-xs font-medium">Alternatives</p>
          {betterApproach.alternatives.length === 0 ? (
            <Muted className="text-xs">None.</Muted>
          ) : (
            <ol className="flex list-inside list-decimal flex-col gap-2">
              {betterApproach.alternatives.map((a, i) => (
                <li key={i}>
                  <Badge label={alternativeKindLabel[a.kind]} tone="neutral" /> <span>{a.recommendation}</span>
                  <p className="mt-0.5 text-xs">
                    <strong>Why it is stronger:</strong> {a.whyStronger}
                  </p>
                  <AuthorityList label="Authority" citations={a.authority} />
                </li>
              ))}
            </ol>
          )}
        </div>
      </Section>

      <Section title="Verification & currency note">
        <AuthorityList label="Everything to Shepardize" citations={note.everythingToShepardize} />
        <div className="mt-2">
          <p className="text-xs font-medium">Volatile areas: current state of the law and date confirmed through</p>
          <Table<VolatileArea>
            rows={note.volatileAreasConfirmed}
            empty="No volatile area reported for this issue."
            rowClassName={(v) => (isVolatileAreaConfirmed(v) ? "" : "bg-red-50 dark:bg-red-950/40")}
            columns={[
              { header: "Area", cell: (v) => v.area },
              { header: "Current state of the law", cell: (v) => v.currentStateOfTheLaw },
              { header: "Confirmed through", cell: (v) => <VolatileConfirmed area={v} /> },
              {
                header: "Sources",
                cell: (v) =>
                  v.urls.length > 0 ? (
                    <ul className="flex flex-col gap-0.5">
                      {v.urls.map((url, i) => (
                        <li key={i}>
                          <SourceUrl url={url} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Muted>none retrieved</Muted>
                  ),
              },
            ]}
          />
        </div>
        <LabeledList label="Circuit-specific issues to double-check" items={note.circuitSpecificIssuesToDoubleCheck} />
        <div className="mt-2 flex flex-col gap-2">
          <Flags
            title="Not verified in this run: confirm before relying on them"
            tone="amber"
            items={toConfirm.map((c, i) => (
              <span key={i}>{c}</span>
            ))}
          />
          <Flags
            title="CITE placeholders to fill"
            tone="amber"
            items={placeholders.map((p, i) => (
              <span key={i}>{p}</span>
            ))}
          />
        </div>
      </Section>

      {output.escalationFlags.length > 0 ? (
        <Flags title="Escalation flags" items={output.escalationFlags} />
      ) : (
        <Section title="Escalation flags">
          <Muted>None reported.</Muted>
        </Section>
      )}
    </ReportBody>
  );
}
