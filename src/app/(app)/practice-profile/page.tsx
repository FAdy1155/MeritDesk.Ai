import Link from "next/link";
import { EDITOR_ROLES, PROFILE_CONFIRM_ROLES, getCurrentTenant, hasRole } from "@/lib/tenant";
import {
  getActiveProfileVersion,
  getDraftVersion,
  getPendingVersion,
  listProfileVersions,
  proposalFingerprint,
} from "@/lib/practice-profile/service";
import { readPracticeProfile } from "@/lib/practice-profile/schema";
import { diffPracticeProfiles, formatProfileDiffValue } from "@/lib/practice-profile/diff";
import { profileChangeRipple } from "@/lib/practice-profile/ripple";
import {
  describeEscalationWeakening,
  escalationBaseline,
  findEscalationWeakenings,
} from "@/lib/practice-profile/checks";
import { ConfirmVersionForm } from "./ConfirmVersionForm";

export default async function PracticeProfilePage() {
  const { tenant, membership } = await getCurrentTenant();
  // The actions check these too; this only hides controls the role cannot use.
  const canEdit = hasRole(membership, EDITOR_ROLES);
  const canConfirm = hasRole(membership, PROFILE_CONFIRM_ROLES);
  const [active, pending, draft, versions] = await Promise.all([
    getActiveProfileVersion(tenant.id),
    getPendingVersion(tenant.id),
    getDraftVersion(tenant.id),
    listProfileVersions(tenant.id),
  ]);

  const openVersion = draft ?? pending;

  // Current -> proposed for the pending version, computed against the
  // version it would replace now (what confirmVersion checks), with the
  // skills each change reaches and any weakened escalation rule.
  const activeProfile = active ? readPracticeProfile(active.profileJson) : null;
  const pendingProfile = pending ? readPracticeProfile(pending.profileJson) : null;
  const pendingReview =
    pending && pendingProfile
      ? {
          ripple: profileChangeRipple(
            active
              ? diffPracticeProfiles(
                  (activeProfile ?? active.profileJson) as Record<string, unknown>,
                  pendingProfile as Record<string, unknown>
                )
              : []
          ),
          weakenings: findEscalationWeakenings(escalationBaseline(activeProfile), pendingProfile.escalationRules).map(
            describeEscalationWeakening
          ),
          fingerprint: proposalFingerprint(pending.renderedMarkdown),
        }
      : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-7">
      <header className="flex flex-col justify-between gap-4 border-b border-[#e6ebf1] pb-6 sm:flex-row sm:items-end">
        <div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#7890b2]">WORKFLOW CONFIGURATION</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-[#1b2e49]">Practice profile</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[#7b899d]">Set the firm&apos;s working standards and context used by AI-assisted legal workflows. Review proposed changes before they become active.</p></div>
        {canEdit && (
          <Link
            href="/practice-profile/edit"
            className="inline-flex items-center justify-center rounded-xl bg-[#17345f] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#244a7c]"
          >
            {openVersion ? `Continue editing version ${openVersion.versionNumber}` : active ? "Edit profile" : "Run setup interview"}
          </Link>
        )}
      </div>

      {!active && (
        <div className="rounded-2xl border border-[#f0dfbd] bg-[#fff9ef] p-5 text-sm leading-6 text-[#8a642c]">
          No active practice profile yet. Every skill reads this profile before it runs, so set it up
          before running claim-evaluation or packet-review.
        </div>
      )}

      {active && (
        <section className="flex flex-col gap-3 rounded-2xl border border-[#e4eaf1] bg-white p-5 shadow-[0_8px_30px_-25px_rgba(22,43,72,.2)] sm:p-6">
          <h2 className="font-medium">Active: version {active.versionNumber}</h2>
          <p className="text-sm text-black/60 dark:text-white/60">
            Confirmed {active.confirmedAt ? new Date(active.confirmedAt).toLocaleString() : "(date not recorded)"}
          </p>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-3 text-xs dark:bg-white/5">
            {active.renderedMarkdown}
          </pre>
        </section>
      )}

      {pending && (
        <section className="flex flex-col gap-4 rounded-2xl border border-[#dce5f0] bg-[#f5f8fc] p-5 sm:p-6">
          <h2 className="font-medium">Pending confirmation: version {pending.versionNumber}</h2>
          {!pendingReview ? (
            <p className="text-sm">
              This version is stored in a format the app can no longer read. Open it in the editor and propose it again.
            </p>
          ) : (
            <>
              {!active ? (
                <p className="text-sm">Initial profile: no previous version to compare against.</p>
              ) : pendingReview.ripple.entries.length > 0 ? (
                <>
                  <ul className="flex flex-col gap-2 text-sm">
                    {pendingReview.ripple.entries.map((entry) => (
                      <li key={entry.path}>
                        <span className="font-medium">{entry.label}</span>: {formatProfileDiffValue(entry.before)} to{" "}
                        {formatProfileDiffValue(entry.after)}
                        <div className="text-xs text-black/60 dark:text-white/60">
                          {entry.skills.length > 0
                            ? `Read by: ${entry.skills.join(", ")}`
                            : "No skill reads this field by name; every skill run still receives the whole profile."}
                        </div>
                      </li>
                    ))}
                  </ul>
                  {pendingReview.ripple.skills.length > 0 && (
                    <p className="text-sm">
                      Skills whose output this version can affect: {pendingReview.ripple.skills.join(", ")}.
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm">No changes from the active version.</p>
              )}
              <details className="text-sm">
                <summary className="cursor-pointer">The profile skills will read once this version is confirmed</summary>
                <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-white/60 p-3 text-xs dark:bg-black/30">
                  {pending.renderedMarkdown}
                </pre>
              </details>
              {canConfirm ? (
                <ConfirmVersionForm
                  versionId={pending.id}
                  fingerprint={pendingReview.fingerprint}
                  weakenings={pendingReview.weakenings}
                />
              ) : (
                <p className="text-sm">An owner/admin or an attorney confirms this version before it becomes active.</p>
              )}
            </>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-2 font-medium">Version history</h2>
        <ul className="flex flex-col gap-2 text-sm text-[#64758c]">
          {versions.map((v) => (
            <li key={v.id}>
              v{v.versionNumber}: {v.status.replace(/_/g, " ")}
              {v.confirmedAt ? ` (confirmed ${new Date(v.confirmedAt).toLocaleDateString()})` : ""}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
