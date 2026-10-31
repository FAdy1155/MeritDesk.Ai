import "server-only";
import { clerkClient } from "@clerk/nextjs/server";

// Display names for the users who requested skill runs. skill_runs stores
// only the requester's Clerk user id (requested_by); the name lives in
// Clerk. The matter page refreshes every 2 seconds while a run is queued or
// running, so names are kept in this process for a while instead of calling
// Clerk's Backend API on every render.

const NAME_TTL_MS = 10 * 60 * 1000;
const MAX_CACHED = 1000;
const MAX_LOOKUP = 100;

const cache = new Map<string, { label: string; expiresAt: number }>();

function labelFor(user: {
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  primaryEmailAddress: { emailAddress: string } | null;
}): string | null {
  const name = user.fullName ?? [user.firstName, user.lastName].filter(Boolean).join(" ");
  return name.trim() || user.primaryEmailAddress?.emailAddress || null;
}

/** Shown when Clerk has no name for the id (a deleted user) or could not be reached. */
function fallbackLabel(userId: string): string {
  return `Firm member (${userId.slice(-6)})`;
}

/**
 * Maps each user id to a name for display: the Clerk user's full name,
 * else their primary email, else a short fallback. The current user is
 * marked "(you)". Never throws: if Clerk cannot be reached, the page shows
 * the fallbacks and logs the error.
 */
export async function getRequesterLabels(userIds: string[], currentUserId: string): Promise<Record<string, string>> {
  const now = Date.now();
  const unique = [...new Set(userIds)].filter((id) => id.startsWith("user_"));
  const labels: Record<string, string> = {};
  const missing: string[] = [];
  for (const id of unique) {
    const hit = cache.get(id);
    if (hit && hit.expiresAt > now) labels[id] = hit.label;
    else missing.push(id);
  }

  if (missing.length > 0) {
    try {
      const client = await clerkClient();
      const batch = missing.slice(0, MAX_LOOKUP);
      const { data } = await client.users.getUserList({ userId: batch, limit: batch.length });
      if (cache.size + data.length > MAX_CACHED) cache.clear();
      for (const user of data) {
        const label = labelFor(user);
        if (!label) continue;
        labels[user.id] = label;
        cache.set(user.id, { label, expiresAt: now + NAME_TTL_MS });
      }
    } catch (err) {
      console.error("getRequesterLabels: could not look up requester names in Clerk:", err);
    }
  }

  for (const id of new Set(userIds)) {
    labels[id] ??= fallbackLabel(id);
    if (id === currentUserId) labels[id] = `${labels[id]} (you)`;
  }
  return labels;
}
