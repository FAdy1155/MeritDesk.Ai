import Link from "next/link";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { PRODUCT_NAME, formatDay } from "@/lib/billing/config";
import { getEntitlement, lockedReasonText, type Entitlement } from "@/lib/billing/entitlement";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { BILLING_ROLES, NoActiveTenantError, TenantResolutionError, getCurrentTenant, hasRole } from "@/lib/tenant";
import { countUnreviewedLegalUpdates } from "@/services/monitoring/service";
import { CreateFirmForm } from "./(app)/onboarding/CreateFirmForm";
import { RepairTenantButton } from "./(app)/onboarding/RepairTenantButton";

// The signed-in app's frame: the header with the firm's name and the
// navigation, the user's organization switcher and account menu, and the
// three states a signed-in user can be in before the pages render:
//
// - no firm chosen (a new user, or a member of none): the create-firm
//   form (src/lib/tenants/create-firm.ts), which starts the free month
//   when the person has not had one;
// - a firm that is not set up in the database yet (the org-sync webhook
//   has not arrived): a button that writes the rows now;
// - a firm whose free month or subscription has ended, or that never had
//   a free month: the lock screen, with Subscribe for the owner/admin.
//   Pages under src/app/(app) pass enforceLock; the Billing page
//   (src/app/billing) does not, so a locked firm can still subscribe there.
//   While locked, nothing else works: every Server Action under
//   src/app/(app) starts with getCurrentEntitledTenant (src/lib/tenant.ts).
//
// The free month's last week and a failed payment's grace period show a
// banner above every page (src/lib/billing/entitlement.ts).

const NAV_LINKS = [
  ["/", "Dashboard"],
  ["/matters", "Matters"],
  ["/clients", "Clients"],
  ["/practice-profile", "Practice Profile"],
  ["/firm", "Firm"],
  ["/updates", "Legal updates"],
  ["/library", "Library"],
  ["/connect", "Connect"],
  ["/billing", "Billing"],
] as const;

type ShellState =
  | { kind: "ready"; tenantId: string; firmName: string; canBill: boolean; entitlement: Entitlement; unreviewedLegalUpdates: number }
  | { kind: "no_org" }
  | { kind: "no_tenant"; reason: "no_tenant" | "no_membership" }
  | { kind: "error" };

async function resolveShellState(): Promise<ShellState> {
  try {
    const { tenant, membership } = await getCurrentTenant();
    const [entitlement, unreviewedLegalUpdates] = await Promise.all([
      getEntitlement(tenant.id),
      // .catch: the nav badge is optional, and the layout keeps working on a
      // database where migration 0005 (legal_updates) has not run yet.
      countUnreviewedLegalUpdates(tenant.id).catch(() => 0),
    ]);
    return { kind: "ready", tenantId: tenant.id, firmName: tenant.name, canBill: hasRole(membership, BILLING_ROLES), entitlement, unreviewedLegalUpdates };
  } catch (err) {
    if (err instanceof NoActiveTenantError) return { kind: "no_org" };
    if (err instanceof TenantResolutionError) return { kind: "no_tenant", reason: err.reason };
    // The details (which can quote query values or ids) go to the log; the page shows a generic sentence.
    console.error(`[app] the firm could not be resolved for this request: ${describeErrorForLog(err)}`);
    return { kind: "error" };
  }
}

export async function AppShell({ children, enforceLock }: { children: React.ReactNode; enforceLock: boolean }) {
  const state = await resolveShellState();
  const ready = state.kind === "ready";

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-black/10 px-6 py-3 dark:border-white/10">
        <div className="flex items-center gap-6">
          <span className="font-semibold">
            {PRODUCT_NAME}
            {ready && <span className="ml-2 font-normal text-black/60 dark:text-white/60">{state.firmName}</span>}
          </span>
          {ready && (
            <nav className="flex flex-wrap items-center gap-4 text-sm text-black/70 dark:text-white/70">
              {NAV_LINKS.map(([href, label]) => (
                <Link key={href} href={href} className="hover:text-black dark:hover:text-white">
                  {label}
                  {href === "/updates" && state.unreviewedLegalUpdates > 0 && (
                    <span
                      className="ml-1 rounded-full bg-amber-500 px-1.5 py-0.5 text-xs font-medium text-white"
                      aria-label={`${state.unreviewedLegalUpdates} unreviewed legal updates`}
                    >
                      {state.unreviewedLegalUpdates}
                    </span>
                  )}
                </Link>
              ))}
            </nav>
          )}
        </div>
        <div className="flex items-center gap-4">
          <OrganizationSwitcher hidePersonal afterCreateOrganizationUrl="/connect" afterSelectOrganizationUrl="/" />
          <UserButton />
        </div>
      </header>
      {ready && <EntitlementBanner entitlement={state.entitlement} canBill={state.canBill} />}
      <main className="flex flex-1 flex-col p-6">
        {state.kind === "no_org" && <CreateFirmPanel />}
        {state.kind === "no_tenant" && <RepairTenantPanel reason={state.reason} />}
        {state.kind === "error" && (
          <div className="mx-auto max-w-md rounded-lg border border-red-300 bg-red-50 p-6 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
            The app could not load your firm just now. Reload the page; if it keeps failing, ask the platform&apos;s
            operator (the details are in the server log).
          </div>
        )}
        {ready &&
          (enforceLock && state.entitlement.state === "locked" ? (
            <LockScreen firmName={state.firmName} entitlement={state.entitlement} canBill={state.canBill} />
          ) : (
            children
          ))}
      </main>
    </div>
  );
}

function CreateFirmPanel() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold">Create your firm</h1>
      <p className="text-sm text-black/70 dark:text-white/70">
        A firm is the account your colleagues join and the connector in Claude acts for. You become its owner. The
        first 30 days are free (once per person); after that it is $20 per user per month, and you subscribe on this
        site whenever you are ready.
      </p>
      <CreateFirmForm />
      <p className="text-xs text-black/60 dark:text-white/60">
        Invited to a firm that already exists? Accept the invitation from the email your firm sent, then choose the
        firm in the menu above.
      </p>
    </div>
  );
}

function RepairTenantPanel({ reason }: { reason: "no_tenant" | "no_membership" }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold">One more step</h1>
      <p className="text-sm text-black/70 dark:text-white/70">
        {reason === "no_tenant"
          ? "This firm exists at the sign-in service but is not set up in the app yet (its sync has not arrived). Set it up now."
          : "The sign-in service does not list you as a member of this firm any more. If you were just added again, set it up now; otherwise reload the page and choose another firm."}
      </p>
      <RepairTenantButton />
    </div>
  );
}

function EntitlementBanner({ entitlement, canBill }: { entitlement: Entitlement; canBill: boolean }) {
  let text: string | null = null;
  if (entitlement.state === "trialing" && entitlement.trialDaysLeft <= 7 && entitlement.trialEndsAt) {
    const days = entitlement.trialDaysLeft;
    text = `Your free month ends on ${formatDay(entitlement.trialEndsAt)} (${days === 1 ? "1 day" : `${days} days`} left). ${
      canBill ? "Subscribe on the Billing page to keep access." : "Ask your firm's owner to subscribe on the Billing page."
    }`;
  } else if (entitlement.state === "past_due" && entitlement.graceEndsAt) {
    text = `A payment failed. Full access continues until ${formatDay(entitlement.graceEndsAt)}; ${
      canBill ? "update the card under Manage billing on the Billing page." : "ask your firm's owner to update the card on the Billing page."
    }`;
  }
  if (!text) return null;
  return (
    <div className="border-b border-amber-300 bg-amber-50 px-6 py-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
      {text}{" "}
      <Link href="/billing" className="underline">
        Billing
      </Link>
    </div>
  );
}

function LockScreen({ firmName, entitlement, canBill }: { firmName: string; entitlement: Entitlement; canBill: boolean }) {
  const title =
    entitlement.reason === "trial_ended"
      ? "Your free month has ended"
      : entitlement.reason === "no_trial"
        ? "Subscribe to start"
        : "The subscription has ended";
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 rounded-lg border border-black/10 p-6 dark:border-white/10">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-black/70 dark:text-white/70">
        {PRODUCT_NAME} is locked for {firmName}: {lockedReasonText(entitlement)}. The connector in Claude is locked too.
        Nothing is deleted: matters, documents and settings are kept, and subscribing unlocks everything at once.
      </p>
      <p className="text-sm text-black/70 dark:text-white/70">
        $20 per user per month, renewed automatically, receipts by email
        {entitlement.reason === "no_trial" ? "; the card is charged when you subscribe" : ""}.
      </p>
      {canBill ? (
        <Link
          href="/billing"
          className="w-fit rounded-md bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
        >
          Subscribe
        </Link>
      ) : (
        <p className="text-sm font-medium">Ask your firm&apos;s owner to subscribe on the Billing page.</p>
      )}
    </div>
  );
}
