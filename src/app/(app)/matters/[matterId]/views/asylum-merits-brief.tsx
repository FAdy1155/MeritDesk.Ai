import type { AsylumMeritsBriefOutput } from "@/services/skill-runner/skills/asylum-merits-brief";
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
  toneClass,
  yesNo,
  type ChecklistItem,
  type Tone,
} from "./primitives";

type SelfReviewCheck = AsylumMeritsBriefOutput["selfReview"]["blocking"][number];

// The three tiers of references/self-review.md, in its order. A line still
// failing is colored by its tier; a passing line is green.
const SELF_REVIEW_TIERS = [
  { key: "blocking", title: "Blocking (fix before delivering)", openTone: "red" },
  { key: "shouldFix", title: "Should-fix", openTone: "amber" },
  { key: "surface", title: "Surface", openTone: "neutral" },
] as const satisfies readonly { key: keyof AsylumMeritsBriefOutput["selfReview"]; title: string; openTone: Tone }[];

function checkItems(checks: SelfReviewCheck[], openTone: Tone): ChecklistItem[] {
  return checks.map((c) => ({
    badge: c.passes ? "pass" : "open",
    badgeClassName: c.passes ? toneClass.green : toneClass[openTone],
    content: (
      <>
        {c.check}
        {c.note ? (
          <>
            {" - "}
            <Muted>{c.note}</Muted>
          </>
        ) : null}
      </>
    ),
  }));
}

function CheckBadge({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span className="flex items-center gap-1">
      {label}: <Badge label={yesNo(ok)} tone={ok ? "green" : "red"} />
    </span>
  );
}

export function AsylumMeritsBriefView({ output, actions }: SkillViewProps<"asylum-merits-brief">) {
  const { wordDocument: doc, selfReview, coverNote } = output;
  const { legalTheory } = coverNote;
  const openBlocking = selfReview.blocking.filter((c) => !c.passes);

  return (
    <ReportBody>
      <Callout title="Before filing" tone="neutral">
        <p>
          This brief is a draft, not a filing. The attorney verifies every fact and citation, and confirms each
          authority remains good law, before it is filed.
        </p>
      </Callout>

      <Section title="Word document">
        {doc.generatedBriefDocumentId ? (
          <button
            type="button"
            onClick={() => actions.downloadDocument(doc.generatedBriefDocumentId)}
            className="w-fit rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
          >
            Download merits brief (.docx)
          </button>
        ) : (
          <Muted>No brief was generated in this run; the file check notes below say why.</Muted>
        )}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <CheckBadge label="Opens and renders" ok={doc.opensAndRenders} />
          <CheckBadge label="All ten sections" ok={doc.allTenSectionsPresent} />
          <CheckBadge label="Cover page" ok={doc.coverPagePresent} />
          <CheckBadge label="Certificate of service" ok={doc.certificateOfServicePresent} />
        </div>
        <div className="mt-2">
          <p className="text-xs font-medium">Sections as printed</p>
          {doc.sectionHeadingsInOrder.length > 0 ? (
            <BulletList className="text-xs" items={doc.sectionHeadingsInOrder} />
          ) : (
            <p className="text-xs">
              <Muted>None reported.</Muted>
            </p>
          )}
        </div>
        <p className="mt-2">
          <strong>File check:</strong> {doc.fileCheckNotes}
        </p>
      </Section>

      <Flags
        title="Blocking self-review items still open"
        items={openBlocking.map((c, i) => (
          <span key={i}>
            {c.check}
            {c.note ? ` - ${c.note}` : ""}
          </span>
        ))}
      />

      <Section title="Self-review">
        <div className="flex flex-col gap-2">
          {SELF_REVIEW_TIERS.map((tier) => (
            <div key={tier.key}>
              <p className="mb-1 text-xs font-medium">{tier.title}</p>
              <ChecklistList items={checkItems(selfReview[tier.key], tier.openTone)} />
            </div>
          ))}
        </div>
      </Section>

      <Section title="Cover note">
        <div className="flex flex-col gap-3">
          <Section title="Legal theory">
            <p>{legalTheory.statement}</p>
            <p className="mt-1">
              <strong>Grounds argued:</strong>{" "}
              {legalTheory.groundsArgued.length > 0 ? legalTheory.groundsArgued.join("; ") : <Muted>none listed</Muted>}
            </p>
            <div className="mt-1">
              <strong>Particular social groups formulated:</strong>
              {legalTheory.particularSocialGroupsFormulated.length > 0 ? (
                <BulletList items={legalTheory.particularSocialGroupsFormulated} />
              ) : (
                <Muted> none argued</Muted>
              )}
            </div>
            <p className="mt-1">
              <strong>Nexus theory:</strong> {legalTheory.nexusTheory}
            </p>
          </Section>

          {coverNote.gapsList.length > 0 ? (
            <Callout title="Gaps list" tone="amber">
              <ChecklistList
                items={coverNote.gapsList.map((g) => ({ badge: g.kind, badgeClassName: toneClass.amber, content: g.gap }))}
              />
            </Callout>
          ) : (
            <Section title="Gaps list">
              <Muted>No gaps reported.</Muted>
            </Section>
          )}

          {/* SKILL.md marks every added citation NEEDS VERIFICATION, so the
              badge never reads "verified"; a fetch in this run is noted. */}
          <Section title="Citations added beyond the authority bank">
            <ChecklistList
              items={coverNote.citationsAddedBeyondAuthorityBank.map((c) => ({
                badge: "NEEDS VERIFICATION",
                badgeClassName: toneClass.amber,
                content: (
                  <>
                    {c.citation}
                    {" - "}
                    <Muted>
                      {c.proposition} ({c.verified ? `fetched in this run${c.url ? `: ${c.url}` : ""}` : "not fetched in this run"})
                    </Muted>
                  </>
                ),
              }))}
            />
          </Section>

          {coverNote.weaknesses.length > 0 ? (
            <Flags title="Weaknesses to weigh" items={coverNote.weaknesses} />
          ) : (
            <Section title="Weaknesses to weigh">
              <Muted>None reported.</Muted>
            </Section>
          )}
        </div>
      </Section>
    </ReportBody>
  );
}
