import assert from "node:assert/strict";
import test from "node:test";
import { resolveTenantPageAccess } from "@/lib/billing/page-access";

const current = {
  tenant: { id: "00000000-0000-4000-8000-000000000099", name: "Test firm" },
  membership: { role: "read_only" },
  userId: "user_page_access_test",
};

test("tenant page access returns no page context for a locked firm", async () => {
  let entitlementTenantId = "";
  const result = await resolveTenantPageAccess(
    async () => current,
    async (tenantId) => {
      entitlementTenantId = tenantId;
      return { state: "locked" };
    }
  );
  assert.equal(entitlementTenantId, current.tenant.id);
  assert.equal(result, null);
});

test("tenant page access preserves tenant context during active and grace states", async () => {
  for (const state of ["active", "trialing", "past_due"] as const) {
    const result = await resolveTenantPageAccess(async () => current, async () => ({ state }));
    assert.equal(result?.tenant, current.tenant);
    assert.equal(result?.entitlement.state, state);
  }
});
