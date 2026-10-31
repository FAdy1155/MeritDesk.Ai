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
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Practice Profile</h1>
        {canEdit && (
          <Link
            href="/practice-profile/edit"
            className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
          >
            {openVersion ? `Continue editing version ${openVersion.versionNumber}` : active ? "Edit profile" : "Run setup interview"}
          </Link>
        )}
      </div>

      {!active && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          No active practice profile yet. Every skill reads this profile before it runs, so set it up
          before running claim-evaluation or packet-review.
        </div>
      )}

      {active && (
        <section className="flex flex-col gap-2 rounded-lg border border-black/10 p-4 dark:border-white/10">
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
        <section className="flex flex-col gap-3 rounded-lg border border-blue-300 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950">
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
        <ul className="flex flex-col gap-1 text-sm text-black/70 dark:text-white/70">
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
