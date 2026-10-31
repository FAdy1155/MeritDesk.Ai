import Link from "next/link";
import { PRODUCT_NAME, formatDay } from "@/lib/billing/config";
import { getEntitlement } from "@/lib/billing/entitlement";
import { getCurrentTenant } from "@/lib/tenant";

const cardClass = "flex flex-col gap-1 rounded-lg border border-black/10 p-4 dark:border-white/10";

export default async function DashboardPage() {
  const { tenant } = await getCurrentTenant();
  const entitlement = await getEntitlement(tenant.id);
  const standing =
    entitlement.state === "trialing"
      ? `Free month until ${entitlement.trialEndsAt ? formatDay(entitlement.trialEndsAt) : "its last day"} (${entitlement.trialDaysLeft === 1 ? "1 day" : `${entitlement.trialDaysLeft} days`} left).`
      : entitlement.state === "active"
        ? "Subscribed."
        : entitlement.state === "past_due"
          ? "A payment failed; see the Billing page."
          : "Locked; see the Billing page.";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          {tenant.name}: {standing}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Link href="/connect" className={cardClass}>
          <span className="font-semibold">Add {PRODUCT_NAME} to Claude</span>
          <span className="text-sm text-black/60 dark:text-white/60">The connector address and the steps for Claude and ChatGPT.</span>
        </Link>
        <Link href="/firm" className={cardClass}>
          <span className="font-semibold">Firm</span>
          <span className="text-sm text-black/60 dark:text-white/60">Letterhead, attorneys, signatures, and the connector&apos;s case-work switch.</span>
        </Link>
        <Link href="/billing" className={cardClass}>
          <span className="font-semibold">Billing</span>
          <span className="text-sm text-black/60 dark:text-white/60">The free month, the subscription, seats and receipts.</span>
        </Link>
      </div>
    </div>
  );
}
