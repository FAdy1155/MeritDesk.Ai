import type { ReactNode } from "react";
import type { SkillViewProps } from "./types";
import { Badge, Flags, Muted, ReportBody, Section, Table } from "./primitives";

type Output = SkillViewProps<"country-conditions-research">["output"];
type Source = Output["sourcedEvidenceByClaim"][number]["sources"][number];

const gapRecommendation: Record<Output["gaps"][number]["recommendation"], string> = {
  expert_declaration: "Commission an expert declaration",
  more_targeted_research: "Run more targeted research",
};

// Same test as the skill module's escalation flags (SKILL.md hard rule 1):
// both dates are schema-validated ISO strings, and a year- or month-only date
// in the cutoff's own year or month cannot be confirmed within it.
function confirmedWithinCutoff(publicationDate: string, cutoffDate: string): boolean {
  if (publicationDate.length === cutoffDate.length) return publicationDate >= cutoffDate;
  return publicationDate > cutoffDate.slice(0, publicationDate.length);
}

function isRetrieved(source: Source): boolean {
  return source.retrievedAt.trim() !== "";
}

// The cutoff the report applied is the model's own reading of "today". The
// view has no run date, so it holds that cutoff to the latest day this run
// fetched a source: six years back, less a day of time-zone slack, the same
// floor the skill module's escalation flags take from the run date.
function retrievalFloor(sources: Source[]): { latestRetrieved: string; floor: string } | null {
  const days = sources.map((s) => s.retrievedAt.trim().slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (days.length === 0) return null;
  const latestRetrieved = days.reduce((a, b) => (b > a ? b : a));
  const [year, month, day] = latestRetrieved.split("-").map(Number);
  return { latestRetrieved, floor: new Date(Date.UTC(year - 6, month - 1, day - 1)).toISOString().slice(0, 10) };
}

/** A link only for http(s); the URL is model output, so anything else is shown as text. */
function sourceUrl(url: string): ReactNode {
  if (!/^https?:\/\//i.test(url)) return <span className="break-all">{url}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="break-all underline">
      {url}
    </a>
  );
}

export function CountryConditionsResearchView({ output }: SkillViewProps<"country-conditions-research">) {
  const { researchProfile, recencyCutoffApplied } = output;
  const reportedCutoff = recencyCutoffApplied.cutoffDate;
  // A source listed under two claims is one source: list each hard-rule problem once.
  const allSources = [
    ...new Map(
      output.sourcedEvidenceByClaim.flatMap((group) => group.sources).map((s) => [`${s.url}\n${s.title}`, s] as const)
    ).values(),
  ];
  const runCheck = retrievalFloor(allSources);
  const cutoffTooEarly = runCheck !== null && reportedCutoff < runCheck.floor;
  // Sources are held to the later of the report's cutoff and the run's floor.
  const cutoffDate = cutoffTooEarly ? runCheck.floor : reportedCutoff;
  const notRetrieved = allSources.filter((s) => !isRetrieved(s));
  const outsideCutoff = allSources.filter((s) => !confirmedWithinCutoff(s.publicationDate, cutoffDate));

  return (
    <ReportBody>
      <Section title="Research profile">
        <ul className="flex flex-col gap-0.5">
          <li>
            <strong>Country / region:</strong> {researchProfile.countryOrRegion}
          </li>
          <li className="flex flex-wrap items-center gap-1">
            <strong>Protected ground(s):</strong>
            {researchProfile.protectedGrounds.length > 0 ? (
              researchProfile.protectedGrounds.map((ground) => <Badge key={ground} label={ground} />)
            ) : (
              <Muted>none identified</Muted>
            )}
          </li>
          <li>
            <strong>Harm:</strong> {researchProfile.harm}
          </li>
          <li>
            <strong>Persecutor:</strong> {researchProfile.persecutor}
          </li>
          <li>
            <strong>State-protection issue:</strong> {researchProfile.stateProtectionIssue}
          </li>
          <li>
            <strong>Timeframe:</strong> {researchProfile.timeframe}
          </li>
        </ul>
      </Section>

      <Section title="Recency cutoff applied">
        <p>
          Cutoff the report applied: <strong>{reportedCutoff}</strong> (sources published before it are excluded).
        </p>
        {cutoffTooEarly ? (
          <p className="mt-1 flex flex-wrap items-center gap-1">
            <Badge label="earlier than six years" tone="red" />
            <span>
              This run retrieved sources on {runCheck.latestRetrieved}, so the cutoff can be no earlier than{" "}
              <strong>{runCheck.floor}</strong>. Sources below are checked against {runCheck.floor}.
            </span>
          </p>
        ) : runCheck === null ? (
          <p className="mt-1 text-xs">
            <Muted>No source here has a retrieval time, so the cutoff could not be checked against the run date.</Muted>
          </p>
        ) : null}
        {recencyCutoffApplied.firmRule ? (
          <p className="mt-1 text-xs">
            <Muted>Firm rule (stricter than 6 years): {recencyCutoffApplied.firmRule}</Muted>
          </p>
        ) : (
          <p className="mt-1 text-xs">
            <Muted>Six-year rule; no stricter firm rule noted.</Muted>
          </p>
        )}
      </Section>

      <Section title="Sourced evidence, grouped by the claim it supports">
        {output.sourcedEvidenceByClaim.length === 0 ? (
          <Muted>No sourced evidence reported.</Muted>
        ) : (
          <div className="flex flex-col gap-3">
            {output.sourcedEvidenceByClaim.map((group, gi) => (
              <div key={gi}>
                <p className="mb-1 font-medium">{group.claim}</p>
                <Table
                  rows={group.sources}
                  empty="No qualifying source listed for this claim."
                  rowClassName={(s) =>
                    !isRetrieved(s) || !confirmedWithinCutoff(s.publicationDate, cutoffDate)
                      ? "bg-red-50 dark:bg-red-950/40"
                      : ""
                  }
                  columns={[
                    { header: "Title", cell: (s) => s.title },
                    {
                      header: "Publisher",
                      cell: (s) =>
                        s.publisher === "DOS" || s.publisher === "HRW" ? (
                          <Badge label={s.publisher} tone="green" />
                        ) : (
                          s.publisher
                        ),
                    },
                    {
                      header: "Publication date",
                      cell: (s) => (
                        <span className="flex flex-col items-start gap-1">
                          <span className="whitespace-nowrap">{s.publicationDate}</span>
                          {!confirmedWithinCutoff(s.publicationDate, cutoffDate) && (
                            <Badge label="not confirmed within cutoff" tone="red" />
                          )}
                        </span>
                      ),
                    },
                    { header: "URL", cell: (s) => sourceUrl(s.url) },
                    {
                      header: "Retrieved",
                      cell: (s) =>
                        isRetrieved(s) ? (
                          <span className="whitespace-nowrap">{s.retrievedAt}</span>
                        ) : (
                          <span className="flex flex-col items-start gap-1">
                            <Badge label="unverified" tone="red" />
                            <Muted>not retrieved in this run</Muted>
                          </span>
                        ),
                    },
                    { header: "Relevant finding", cell: (s) => s.relevantFinding },
                    { header: "Claim corroborated", cell: (s) => s.claimCorroborated },
                  ]}
                />
              </div>
            ))}
          </div>
        )}
      </Section>

      {output.gaps.length > 0 ? (
        <Flags
          title="Gaps"
          items={output.gaps.map((g, i) => (
            <span key={i}>
              <strong>{g.claimOrElement}</strong>: {gapRecommendation[g.recommendation]}
            </span>
          ))}
        />
      ) : (
        <Section title="Gaps">
          <Muted>No gaps reported.</Muted>
        </Section>
      )}

      <Section title="Verification note">
        <p>{output.verificationNote}</p>
      </Section>

      <Flags
        title="Sources to confirm before use"
        items={[
          ...notRetrieved.map((s, i) => (
            <span key={`r${i}`}>
              Not retrieved in this run: {s.title} <Muted>({s.url})</Muted>
            </span>
          )),
          ...outsideCutoff.map((s, i) => (
            <span key={`c${i}`}>
              Dated {s.publicationDate}, not confirmed on or after {cutoffDate}: {s.title}
            </span>
          )),
        ]}
      />
    </ReportBody>
  );
}
