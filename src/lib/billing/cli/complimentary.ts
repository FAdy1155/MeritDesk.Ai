import "../../../load-env";
import os from "node:os";
import { eq } from "drizzle-orm";
import { withServiceContext } from "@/db/client";
import { tenants } from "@/db/schema";
import { setComplimentary } from "@/lib/billing/complimentary";
import { computeEntitlement } from "@/lib/billing/entitlement";
import { readTenantBilling } from "@/lib/billing/store";

// npm run billing:comp -- <tenant id> [on|off]
//
// Gives a firm complimentary access (entitled without a subscription, no
// billing emails) or takes it away; with no on/off, prints the firm's
// standing. The operator's own firm is the intended use (README "Trial,
// billing and emails"). Runs against DATABASE_URL in service context, as
// the worker does, and writes billing.complimentary_set to the firm's audit
// log with the operating system user who ran it.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const [tenantId, mode] = process.argv.slice(2);
  if (!tenantId || !UUID_RE.test(tenantId) || (mode !== undefined && mode !== "on" && mode !== "off")) {
    console.error("Usage: npm run billing:comp -- <tenant id> [on|off]");
    console.error("The tenant id is the uuid in the tenants table (SELECT id, name FROM tenants).");
    process.exit(2);
  }
  const operator = os.userInfo().username;
  const now = new Date();

  const result = await withServiceContext(async (tx) => {
    const [tenant] = await tx.select({ id: tenants.id, name: tenants.name, deletedAt: tenants.deletedAt }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) return null;
    if (mode === undefined) {
      const row = await readTenantBilling(tx, tenantId);
      return { tenant, row, changed: false };
    }
    const { row, changed } = await setComplimentary(tx, { tenantId, complimentary: mode === "on", operator, now });
    return { tenant, row, changed };
  });
  if (!result) {
    console.error(`No tenant has the id ${tenantId}.`);
    process.exit(1);
  }
  const { tenant, row, changed } = result;
  if (tenant.deletedAt) console.warn(`Note: this firm's organization was deleted on ${tenant.deletedAt.toISOString()}.`);
  if (!row) {
    console.log(`${tenant.name}: no billing row yet (it is created when the firm is first read).`);
    return;
  }
  const entitlement = computeEntitlement(row, now);
  console.log(
    `${tenant.name} (${tenant.id}): complimentary ${row.complimentary ? "on" : "off"}${changed ? ` (changed by ${operator}, audited)` : ""}; ` +
      `entitlement ${entitlement.state} (${entitlement.reason}); subscription ${row.subscriptionStatus ?? "none"}` +
      `${row.complimentary && row.subscriptionStatus ? "; the Stripe subscription still bills: cancel it in the portal or the dashboard if the firm should not pay" : ""}`
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
