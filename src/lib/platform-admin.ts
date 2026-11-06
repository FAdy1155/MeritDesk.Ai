/**
 * Platform operators: Clerk user ids listed in LIBRARY_IMPORT_ADMINS.
 * They may import into the shared library and use /platform (firm list,
 * suspension). Not a firm role: any firm's owner_admin can be granted in
 * Clerk, so operator access lives in the deployment's environment.
 * Unset or empty, nobody is an operator.
 */

export function platformOperatorIds(): Set<string> {
  return new Set(
    (process.env.LIBRARY_IMPORT_ADMINS ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

export function isPlatformOperator(userId: string | null | undefined): boolean {
  return Boolean(userId) && platformOperatorIds().has(userId!);
}
