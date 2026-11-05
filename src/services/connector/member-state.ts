export type CurrentMemberState = {
  banned: boolean;
  locked: boolean;
  memberships: { orgId: string; role: string }[];
};

/** Reads live account status and only the consent-selected organization membership. */
export async function fetchCurrentMemberState(
  userId: string,
  orgId: string,
  readUser: (userId: string) => Promise<{ banned: boolean; locked: boolean }>,
  readMembership: (orgId: string, userId: string) => Promise<{ orgId: string; role: string } | null>
): Promise<CurrentMemberState> {
  const [user, membership] = await Promise.all([readUser(userId), readMembership(orgId, userId)]);
  return {
    banned: user.banned,
    locked: user.locked,
    memberships: membership?.orgId === orgId ? [{ orgId, role: membership.role }] : [],
  };
}
