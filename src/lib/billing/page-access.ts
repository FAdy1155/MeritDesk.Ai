/**
 * Resolve tenant context and entitlement before a page reads firm data. Kept
 * dependency-free so this boundary can be tested without Clerk, Next.js, or a
 * database connection.
 */
export async function resolveTenantPageAccess<
  T extends { tenant: { id: string } },
  E extends { state: string }
>(
  resolveTenant: () => Promise<T>,
  readEntitlement: (tenantId: string) => Promise<E>
): Promise<(T & { entitlement: E }) | null> {
  const current = await resolveTenant();
  const entitlement = await readEntitlement(current.tenant.id);
  return entitlement.state === "locked" ? null : { ...current, entitlement };
}
