"use client";

import { useState, useTransition } from "react";
import { MEMBER_APP_ROLES, type MemberAppRole, type MembershipRole } from "@/lib/roles";
import type { FirmMemberView } from "@/lib/tenants/members";
import { setMemberRoleAction } from "./member-actions";
import { sectionClass } from "./FirmIdentityForm";

// The firm's members with their app role. Owner/admins (Clerk's Admins)
// are shown with a badge and no control: their role is Clerk's, managed in
// the organization settings. For every other member an owner/admin picks
// attorney, paralegal or read-only here (src/app/(app)/firm/member-actions.ts).

const ROLE_LABELS: Record<MembershipRole, string> = {
  owner_admin: "Owner/admin",
  attorney: "Attorney",
  paralegal: "Paralegal",
  read_only: "Read-only",
};

const ROLE_HELP: Record<MemberAppRole, string> = {
  attorney: "runs skills, confirms the practice profile, edits the firm identity and reviews legal updates",
  paralegal: "runs skills and manages matters, clients and documents",
  read_only: "opens pages and downloads documents, nothing else",
};

const selectClass =
  "rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm disabled:opacity-50 dark:border-white/20";

export function MembersList({
  members,
  canManage,
  currentUserId,
}: {
  /** Null when Clerk's membership list could not be read. */
  members: FirmMemberView[] | null;
  canManage: boolean;
  currentUserId: string;
}) {
  return (
    <section className={sectionClass} aria-labelledby="members-heading">
      <h2 id="members-heading" className="font-semibold">
        Members
      </h2>
      <p className="text-sm text-black/70 dark:text-white/70">
        People are invited to the firm, removed from it and made owner/admins in the organization settings (the
        firm menu at the top, Manage organization): an owner/admin is an Admin there, everyone else a Member. A
        member&apos;s role in the app is set here; a new member starts as read-only. Each member is one seat.
      </p>
      <ul className="text-xs text-black/60 dark:text-white/60">
        {MEMBER_APP_ROLES.map((role) => (
          <li key={role}>
            <span className="font-medium">{ROLE_LABELS[role]}:</span> {ROLE_HELP[role]}.
          </li>
        ))}
      </ul>
      {members === null ? (
        <p className="text-sm text-red-600">
          The members list could not be read from the sign-in service just now. Reload the page; if it keeps
          failing, ask the platform&apos;s operator.
        </p>
      ) : members.length === 0 ? (
        <p className="text-sm text-black/60 dark:text-white/60">No members are listed.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {members.map((member) => (
            <MemberRow key={member.userId} member={member} canManage={canManage} isCurrentUser={member.userId === currentUserId} />
          ))}
        </ul>
      )}
      {!canManage && (
        <p className="text-xs text-black/60 dark:text-white/60">Only an owner/admin can change a member&apos;s role.</p>
      )}
    </section>
  );
}

function MemberRow({ member, canManage, isCurrentUser }: { member: FirmMemberView; canManage: boolean; isCurrentUser: boolean }) {
  const [role, setRole] = useState<MembershipRole>(member.role);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function change(next: string) {
    setError(null);
    startTransition(async () => {
      const result = await setMemberRoleAction({ userId: member.userId, role: next });
      if (result.ok) setRole(result.member.role);
      else setError(result.error);
    });
  }

  const roleSelectId = `member-role-${member.userId}`;
  return (
    <li className="flex flex-col gap-1 rounded-md border border-black/10 p-3 dark:border-white/10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="font-medium">
            {member.name ?? member.identifier}
            {isCurrentUser && <span className="ml-1 font-normal text-black/60 dark:text-white/60">(you)</span>}
          </span>
          {member.name && <span className="text-xs text-black/60 dark:text-white/60">{member.identifier}</span>}
        </div>
        <div className="flex items-center gap-2 text-sm">
          {member.clerkAdmin ? (
            <>
              <span className="rounded-full bg-black/10 px-2 py-0.5 text-xs font-medium dark:bg-white/15">Owner/admin</span>
              <span className="text-xs text-black/60 dark:text-white/60">Admin at the sign-in service</span>
            </>
          ) : canManage ? (
            <>
              <label htmlFor={roleSelectId} className="sr-only">
                Role of {member.name ?? member.identifier}
              </label>
              <select id={roleSelectId} className={selectClass} value={role} disabled={isPending} onChange={(e) => change(e.target.value)}>
                {MEMBER_APP_ROLES.map((option) => (
                  <option key={option} value={option}>
                    {ROLE_LABELS[option]}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <span>{ROLE_LABELS[role]}</span>
          )}
        </div>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </li>
  );
}
