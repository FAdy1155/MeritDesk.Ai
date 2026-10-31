import Link from "next/link";
import { startOrGetDraftAction } from "../actions";
import { ProfileEditor } from "./ProfileEditor";
import { readPracticeProfile } from "@/lib/practice-profile/schema";
import { getActiveProfileVersion } from "@/lib/practice-profile/service";
import { EDITOR_ROLES, getCurrentTenant, hasRole } from "@/lib/tenant";

export default async function EditPracticeProfilePage() {
  // startOrGetDraftAction refuses read-only members (it creates a draft);
  // say so here instead of failing the render.
  const { tenant, membership } = await getCurrentTenant();
  if (!hasRole(membership, EDITOR_ROLES)) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-6 text-xl font-semibold">Practice profile setup</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Your role in this firm is read-only, so you can view the practice profile but not edit it.
        </p>
      </div>
    );
  }
  const [draft, active] = await Promise.all([startOrGetDraftAction(), getActiveProfileVersion(tenant.id)]);
  const profile = readPracticeProfile(draft.profileJson);
  // The active version is the "current" side of the editor's current ->
  // proposed review; null for a firm's first version.
  const baseline = active ? readPracticeProfile(active.profileJson) : null;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-2 text-xl font-semibold">Practice profile setup</h1>
      <p className="mb-6 text-sm text-black/60 dark:text-white/60">
        Version {draft.versionNumber}. Leave a field empty until the firm has a real answer: an empty field reaches
        the skills as &quot;Not set by the firm&quot; and each skill applies its own default. Never guess the firm&apos;s
        practices.
      </p>
      {profile ? (
        <ProfileEditor
          versionId={draft.id}
          versionNumber={draft.versionNumber}
          isPending={draft.status === "pending_confirmation"}
          initialProfile={profile}
          baselineProfile={baseline}
          hasActiveVersion={Boolean(active)}
        />
      ) : (
        <p className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          Version {draft.versionNumber} is stored in a format this editor cannot read. Nothing has been changed.{" "}
          <Link href="/practice-profile" className="underline">
            Back to the practice profile
          </Link>
        </p>
      )}
    </div>
  );
}
