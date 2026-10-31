import type { ReactNode } from "react";
import type { SkillViewProps } from "./types";
import { Badge, BulletList, Callout, Flags, Muted, ReportBody, Section, Table } from "./primitives";

type Output = SkillViewProps<"eoir-motion-self-review">["output"];
type ReviewComment = Output["blocking"][number];

const MISSING = "text-amber-800 dark:text-amber-300";

/** One comment as a list item: location, problem, fix (the SKILL.md's three parts). */
function commentItems(comments: ReviewComment[]): ReactNode[] {
  return comments.map((c, i) => (
    <span key={i}>
      <strong>{c.location}</strong>
      <span className="block">{c.problem}</span>
      <span className="block text-xs">
        <strong>Fix:</strong> {c.fix}
      </span>
    </span>
  ));
}

/** A value the report may leave out, shown as missing in amber when absent. */
function OrMissing({ value, missing }: { value: string | undefined; missing: string }) {
  return value ? <>{value}</> : <span className={MISSING}>[{missing}]</span>;
}

function TierSection({ title, comments }: { title: string; comments: ReviewComment[] }) {
  return (
    <Section title={`${title} (${comments.length})`}>
      {comments.length > 0 ? <BulletList className="space-y-1" items={commentItems(comments)} /> : <Muted>None.</Muted>}
    </Section>
  );
}

export function EoirMotionSelfReviewView({ output }: SkillViewProps<"eoir-motion-self-review">) {
  const { preFilingReview: header, notReviewed, filingPosture: posture, verdict } = output;
  const hasBlindSpots = notReviewed.missing.length > 0 || notReviewed.checksNotRun.length > 0;

  return (
    <ReportBody>
      <Section title="Pre-filing review">
        <p>
          <strong>{header.motionType}</strong>
        </p>
        <ul className="mt-1 text-xs text-black/60 dark:text-white/60">
          <li>
            Respondent: <OrMissing value={header.respondentName} missing="not given in the draft" />
          </li>
          <li>
            A-number: <OrMissing value={header.aNumber} missing="not given in the draft" />
          </li>
        </ul>
      </Section>

      <Section title="Reviewed">
        {output.reviewed.length > 0 ? <BulletList items={output.reviewed} /> : <Muted>Nothing listed.</Muted>}
      </Section>

      {hasBlindSpots ? (
        <Callout title="Not reviewed" tone="amber">
          {notReviewed.missing.length > 0 && (
            <>
              <p className="text-xs font-medium">Missing</p>
              <BulletList items={notReviewed.missing} />
            </>
          )}
          {notReviewed.checksNotRun.length > 0 && (
            <>
              <p className="mt-1 text-xs font-medium">Checks that could not be run</p>
              <BulletList items={notReviewed.checksNotRun} />
            </>
          )}
        </Callout>
      ) : (
        <Section title="Not reviewed">
          <Muted>Nothing was missing; every check was run.</Muted>
        </Section>
      )}

      <Section title="Filing posture">
        <p>
          <OrMissing value={posture.filingDate} missing="filing date not given" /> to{" "}
          <OrMissing value={posture.hearingDate} missing="hearing date not given" /> ={" "}
          {posture.days === null ? <span className={MISSING}>[N]</span> : posture.days} days.{" "}
          {posture.clears === null ? (
            <Badge label="undetermined" tone="amber" />
          ) : posture.clears ? (
            <Badge label="clears" tone="green" />
          ) : (
            <Badge label="does not clear" tone="red" />
          )}
        </p>
        <p className="mt-1">
          <Muted>Deadline applied:</Muted> {posture.deadline}
        </p>
      </Section>

      {output.blocking.length > 0 ? (
        <Flags title={`BLOCKING (${output.blocking.length})`} items={commentItems(output.blocking)} />
      ) : (
        <Section title="BLOCKING (0)">
          <Muted>None.</Muted>
        </Section>
      )}

      <TierSection title="SHOULD-FIX" comments={output.shouldFix} />

      <TierSection title="OPTIONAL" comments={output.optional} />

      {output.verify.length > 0 ? (
        <Callout title={`VERIFY (${output.verify.length})`} tone="amber">
          <Table
            rows={output.verify}
            columns={[
              {
                header: "What to check",
                cell: (row) => (
                  <>
                    {row.citation && (
                      <span className="mb-0.5 flex items-start gap-2">
                        <Badge label="unverified" tone="amber" />
                        <strong>{row.citation}</strong>
                      </span>
                    )}
                    {row.whatToCheck}
                  </>
                ),
              },
              { header: "Where", cell: (row) => row.where },
            ]}
          />
        </Callout>
      ) : (
        <Section title="VERIFY (0)">
          <Muted>Nothing left to verify.</Muted>
        </Section>
      )}

      <Callout title="VERDICT" tone={verdict.survivesReviewAsFiled ? "neutral" : "red"}>
        <p>
          {verdict.survivesReviewAsFiled ? (
            <Badge label="survives review as filed" tone="green" />
          ) : (
            <Badge label="would not survive review as filed" tone="red" />
          )}
        </p>
        {verdict.fixFirst && (
          <p className="mt-1">
            <strong>Fix first:</strong> {verdict.fixFirst}
          </p>
        )}
        <p className="mt-1">{verdict.statement}</p>
      </Callout>
    </ReportBody>
  );
}
