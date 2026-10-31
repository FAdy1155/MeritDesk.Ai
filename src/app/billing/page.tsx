import Link from "next/link";
import { PRODUCT_NAME, formatDay, formatUsd } from "@/lib/billing/config";
import { lockedReasonText, type Entitlement } from "@/lib/billing/entitlement";
import { billingErrorText } from "@/lib/billing/errors";
import { getBillingOverview } from "@/lib/billing/service";
import { BILLING_ROLES, getCurrentTenant, hasRole } from "@/lib/tenant";
import { openBillingPortalAction, startCheckoutAction } from "./actions";

// The firm's billing (README "Trial, billing and emails"): where the free
// month stands or what the subscription is, the seats (one per member) and
// the monthly amount, and for the owner/admin the two buttons: Subscribe
// (Stripe Checkout) and Manage billing (Stripe's Customer Portal: card,
// invoices, cancellation). Subscription and payment happen only here,
// never inside Claude. Reachable while the firm is locked (./layout.tsx).
// An action's refusal arrives as ?error=<code> and is shown as fixed text
// (src/lib/billing/errors.ts), never as text from the URL.

const buttonClass = "rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black";
const secondaryButtonClass = "rounded-md border border-black/15 px-4 py-2 text-sm font-medium dark:border-white/20";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function statusLines(entitlement: Entitlement, memberCount: number, monthlyCents: number): { title: string; detail: string } {
  const sub = entitlement.subscription;
  switch (entitlement.state) {
    case "trialing":
      return {
        title: `Free month, ${entitlement.trialDaysLeft === 1 ? "1 day" : `${entitlement.trialDaysLeft} days`} left`,
        detail: `It ends on ${entitlement.trialEndsAt ? formatDay(entitlement.trialEndsAt) : "its last day"}. Subscribe before then to keep the app and the connector working; the first charge is when the free month ends.`,
      };
    case "active":
      if (entitlement.reason === "complimentary") {
        return { title: "Complimentary access", detail: `${PRODUCT_NAME} is open to this firm without a subscription, by arrangement with the platform's operator.` };
      }
      return {
        title: sub?.cancelAtPeriodEnd ? "Subscription ending" : "Subscribed",
        detail: sub?.cancelAtPeriodEnd
          ? `The subscription is set to end on ${sub.currentPeriodEnd ? formatDay(sub.currentPeriodEnd) : "the end of the period"}. Renew it under Manage billing to keep access.`
          : sub?.currentPeriodEnd
            ? `${entitlement.reason === "subscription_trialing" ? "The first charge" : "The next charge"} is on ${formatDay(sub.currentPeriodEnd)}: ${formatUsd(monthlyCents)} for ${memberCount} ${memberCount === 1 ? "user" : "users"}. A receipt comes by email after each payment.`
            : "The subscription renews monthly; a receipt comes by email after each payment.",
      };
    case "past_due":
      return {
        title: "Payment failed",
        detail: `Stripe could not charge the card on file. Full access continues until ${entitlement.graceEndsAt ? formatDay(entitlement.graceEndsAt) : "the grace period ends"}; update the card under Manage billing. Stripe retries the payment on its own.`,
      };
    case "locked":
      if (entitlement.reason === "no_trial") {
        return {
          title: "No free month: subscribe to start",
          detail: `The free month is given once per person, and this firm's creator already had one with another firm, so ${PRODUCT_NAME} is locked until the firm subscribes. Subscribe charges the card now, ${formatUsd(monthlyCents)} for ${memberCount} ${memberCount === 1 ? "user" : "users"}, and unlocks the app and the connector at once.`,
        };
      }
      return {
        title: "Locked",
        detail: `${PRODUCT_NAME} is locked because ${lockedReasonText(entitlement)}. Nothing is deleted; subscribing unlocks the app and the connector at once.`,
      };
  }
}

export default async function BillingPage({ searchParams }: PageProps<"/billing">) {
  const { tenant, membership } = await getCurrentTenant();
  const canBill = hasRole(membership, BILLING_ROLES);
  const overview = await getBillingOverview(tenant.id);
  const params = await searchParams;
  const checkout = first(params.checkout);
  const error = billingErrorText(first(params.error));
  const { entitlement, memberCount, monthlyCents, seatPriceCents } = overview;
  const status = statusLines(entitlement, memberCount, monthlyCents);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Billing</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          {PRODUCT_NAME} is free for a firm&apos;s first 30 days (once per person), then {formatUsd(seatPriceCents)} per user per
          month. The subscription renews automatically, and a receipt comes by email after every payment. Payment is
          handled by Stripe on this site, never inside Claude.
        </p>
      </div>

      {checkout === "success" && (
        <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-100">
          Thank you. Stripe confirmed the subscription; this page shows it as soon as Stripe&apos;s confirmation reaches
          the app, usually within a minute. A confirmation email is on its way.
        </div>
      )}
      {checkout === "canceled" && (
        <div className="rounded-lg border border-black/10 p-4 text-sm dark:border-white/10">Checkout was canceled. Nothing was charged.</div>
      )}
      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          {error}
        </div>
      )}

      <section className="flex flex-col gap-3 rounded-lg border border-black/10 p-4 dark:border-white/10" aria-labelledby="billing-status">
        <h2 id="billing-status" className="font-semibold">
          {status.title}
        </h2>
        <p className="text-sm text-black/70 dark:text-white/70">{status.detail}</p>
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-black/60 dark:text-white/60">Members (seats)</dt>
            <dd>{memberCount}</dd>
          </div>
          <div>
            <dt className="text-black/60 dark:text-white/60">Monthly amount</dt>
            <dd>
              {formatUsd(monthlyCents)} ({memberCount} x {formatUsd(seatPriceCents)})
            </dd>
          </div>
          {entitlement.subscription?.status && (
            <div>
              <dt className="text-black/60 dark:text-white/60">Stripe status</dt>
              <dd>{entitlement.subscription.status.replace(/_/g, " ")}</dd>
            </div>
          )}
          <div>
            <dt className="text-black/60 dark:text-white/60">Free month {entitlement.trialEndsAt ? "ends" : ""}</dt>
            <dd>{entitlement.trialEndsAt ? formatDay(entitlement.trialEndsAt) : "none (already used by the firm's creator)"}</dd>
          </div>
        </dl>
        <p className="text-xs text-black/60 dark:text-white/60">
          Seats follow the firm&apos;s members: inviting a member adds a seat and removing one removes it, prorated by
          Stripe on the next invoice. Members are invited and removed in the organization settings (the firm menu at the
          top); their roles are set on the Firm page.
        </p>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-black/10 p-4 dark:border-white/10" aria-labelledby="billing-actions">
        <h2 id="billing-actions" className="font-semibold">
          Subscribe and manage
        </h2>
        {!overview.stripeConfigured ? (
          <p className="text-sm text-red-600">Billing is not configured on this server yet (Stripe). Ask the platform&apos;s operator.</p>
        ) : canBill ? (
          <div className="flex flex-wrap gap-3">
            {overview.canSubscribe && (
              <form action={startCheckoutAction}>
                <button type="submit" className={buttonClass}>
                  {overview.chargesNow ? "Subscribe (charges now)" : "Subscribe"}
                </button>
              </form>
            )}
            {overview.hasCustomer && (
              <form action={openBillingPortalAction}>
                <button type="submit" className={secondaryButtonClass}>
                  Manage billing
                </button>
              </form>
            )}
          </div>
        ) : (
          <p className="text-sm text-black/70 dark:text-white/70">
            Only the firm&apos;s owner can subscribe or change billing. Ask your firm&apos;s owner.
          </p>
        )}
        <p className="text-xs text-black/60 dark:text-white/60">
          Subscribe opens Stripe Checkout for {memberCount} {memberCount === 1 ? "seat" : "seats"}
          {entitlement.state === "trialing" && !overview.chargesNow
            ? "; the card is charged when the free month ends"
            : overview.canSubscribe
              ? "; the card is charged right away"
              : ""}
          . Manage billing opens Stripe&apos;s portal to change the card, download invoices, or cancel at the end of the
          period; seats cannot be changed there, they follow the firm&apos;s members.
        </p>
      </section>

      <p className="text-sm text-black/60 dark:text-white/60">
        The <Link href="/pricing" className="underline">pricing page</Link> has the details; the{" "}
        <Link href="/terms" className="underline">terms</Link> and <Link href="/privacy" className="underline">privacy</Link>{" "}
        pages apply.
      </p>
    </div>
  );
}
