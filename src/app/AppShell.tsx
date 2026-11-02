import Link from "next/link";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { PRODUCT_NAME, formatDay } from "@/lib/billing/config";
import { getEntitlement, lockedReasonText, type Entitlement } from "@/lib/billing/entitlement";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { BILLING_ROLES, NoActiveTenantError, TenantResolutionError, getCurrentTenant, hasRole } from "@/lib/tenant";
import { countUnreviewedLegalUpdates } from "@/services/monitoring/service";
import { CreateFirmForm } from "./(app)/onboarding/CreateFirmForm";
import { RepairTenantButton } from "./(app)/onboarding/RepairTenantButton";
import { AppNavigation } from "./AppNavigation";

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
      countUnreviewedLegalUpdates(tenant.id).catch(() => 0),
    ]);
    return { kind: "ready", tenantId: tenant.id, firmName: tenant.name, canBill: hasRole(membership, BILLING_ROLES), entitlement, unreviewedLegalUpdates };
  } catch (err) {
    if (err instanceof NoActiveTenantError) return { kind: "no_org" };
    if (err instanceof TenantResolutionError) return { kind: "no_tenant", reason: err.reason };
    console.error("[app] the firm could not be resolved for this request: " + describeErrorForLog(err));
    return { kind: "error" };
  }
}

export async function AppShell({ children, enforceLock }: { children: React.ReactNode; enforceLock: boolean }) {
  const state = await resolveShellState();
  const ready = state.kind === "ready";
  return (
    <div className="min-h-screen flex-1 bg-[#f5f7fb] text-[#24344d]">
      {ready ? (
        <div className="flex min-h-screen">
          <AppNavigation variant="sidebar" unreviewedLegalUpdates={state.unreviewedLegalUpdates} />
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-30 flex min-h-[68px] items-center justify-between gap-4 border-b border-[#e8edf4] bg-white/95 px-4 backdrop-blur-xl sm:px-7">
              <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[.15em] text-[#9aa7b9]">Account & connector</p><p className="truncate text-sm font-semibold text-[#243a5b]">{state.firmName}</p></div>
              <div className="flex shrink-0 items-center gap-3"><OrganizationSwitcher hidePersonal afterCreateOrganizationUrl="/connect" afterSelectOrganizationUrl="/" /><span className="h-7 w-px bg-[#e8edf4]" /><UserButton /></div>
            </header>
            <AppNavigation variant="mobile" unreviewedLegalUpdates={state.unreviewedLegalUpdates} />
            <EntitlementBanner entitlement={state.entitlement} canBill={state.canBill} />
            <main className="w-full flex-1 px-4 py-7 sm:px-7 sm:py-9 lg:px-10">
              <div className="mx-auto w-full max-w-[1440px]">
                {enforceLock && state.entitlement.state === "locked" ? <LockScreen firmName={state.firmName} entitlement={state.entitlement} canBill={state.canBill} /> : children}
              </div>
            </main>
            <footer className="border-t border-[#e8edf4] bg-white px-7 py-4 text-[11px] text-[#9aa7b9]">© {new Date().getFullYear()} {PRODUCT_NAME} <span className="mx-2">·</span> Your legal work happens in Claude or ChatGPT</footer>
          </div>
        </div>
      ) : (
        <main className="flex min-h-screen items-center justify-center px-5 py-12">
          {state.kind === "no_org" && <CreateFirmPanel />}
          {state.kind === "no_tenant" && <RepairTenantPanel reason={state.reason} />}
          {state.kind === "error" && <div className="max-w-md rounded-2xl border border-red-200 bg-white p-7 text-sm text-red-800 shadow-sm">The app could not load your firm just now. Reload the page; if it keeps failing, ask the platform&apos;s operator (the details are in the server log).</div>}
        </main>
      )}
    </div>
  );
}

function CreateFirmPanel() {
  return <div className="w-full max-w-lg rounded-3xl border border-[#e5ebf3] bg-white p-8 shadow-[0_20px_60px_-35px_rgba(25,49,82,.25)] sm:p-10">
    <div className="mb-7 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#18345b] text-xl font-bold text-white">M</div>
    <p className="text-xs font-bold uppercase tracking-[.16em] text-[#6685b3]">Welcome to MeritDesk.AI</p>
    <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[#1d304d]">Set up your firm workspace</h1>
    <p className="mt-3 text-sm leading-7 text-[#738198]">Create the shared workspace for your attorneys and staff. Organize immigration matters, manage documents, and connect your AI tools.</p>
    <div className="my-6 rounded-xl bg-[#f5f8fc] p-4 text-sm leading-6 text-[#65758d]">Your first 30 days are free. After that, it is $20 per user per month. You can invite your team and configure the workspace after setup.</div>
    <CreateFirmForm />
    <p className="mt-5 text-xs leading-5 text-[#98a3b3]">Already invited to a firm? Accept the invitation from your email, then select that firm from the organization menu.</p>
  </div>;
}
function RepairTenantPanel({ reason }: { reason: "no_tenant" | "no_membership" }) {
  return <div className="w-full max-w-lg rounded-3xl border border-[#e5ebf3] bg-white p-8 shadow-sm"><p className="text-xs font-bold uppercase tracking-[.16em] text-[#6685b3]">Workspace setup</p><h1 className="mt-3 text-2xl font-semibold text-[#1d304d]">One more step</h1><p className="mt-3 text-sm leading-7 text-[#738198]">{reason === "no_tenant" ? "This firm exists at the sign-in service but has not been set up in the workspace yet. Complete the setup now." : "Your account is no longer listed as a member of this firm. If you were just added again, complete setup; otherwise choose another firm."}</p><div className="mt-6"><RepairTenantButton /></div></div>;
}
function EntitlementBanner({ entitlement, canBill }: { entitlement: Entitlement; canBill: boolean }) {
  let text: string | null = null;
  if (entitlement.state === "trialing" && entitlement.trialDaysLeft <= 7 && entitlement.trialEndsAt) {
    const days = entitlement.trialDaysLeft;
    text = "Your free month ends on " + formatDay(entitlement.trialEndsAt) + " (" + (days === 1 ? "1 day" : days + " days") + " left). " + (canBill ? "Subscribe on the Billing page to keep access." : "Ask your firm's owner to subscribe on the Billing page.");
  } else if (entitlement.state === "past_due" && entitlement.graceEndsAt) {
    text = "A payment failed. Full access continues until " + formatDay(entitlement.graceEndsAt) + "; " + (canBill ? "update the card under Manage billing on the Billing page." : "ask your firm's owner to update the card on the Billing page.");
  }
  if (!text) return null;
  return <div className="border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-900">{text} <Link href="/billing" className="ml-1 font-semibold underline underline-offset-2">Review billing</Link></div>;
}
function LockScreen({ firmName, entitlement, canBill }: { firmName: string; entitlement: Entitlement; canBill: boolean }) {
  const title = entitlement.reason === "trial_ended" ? "Your free month has ended" : entitlement.reason === "no_trial" ? "Choose a plan to get started" : "Your subscription has ended";
  return <div className="mx-auto max-w-2xl rounded-3xl border border-[#e4eaf2] bg-white p-8 shadow-sm sm:p-10"><div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#fff4e5] text-xl text-[#bd7b22]">!</div><p className="text-xs font-bold uppercase tracking-[.16em] text-[#9a7b50]">Subscription required</p><h1 className="mt-3 text-3xl font-semibold tracking-tight text-[#1d304d]">{title}</h1><p className="mt-3 text-sm leading-7 text-[#738198]">{PRODUCT_NAME} is currently locked for {firmName}: {lockedReasonText(entitlement)}. Your matters, documents and settings are retained. Subscribe to restore access to the workspace and connector.</p><p className="mt-4 text-sm text-[#64748b]">$20 per user per month, renewed automatically, with receipts by email{entitlement.reason === "no_trial" ? ". Your card is charged when you subscribe." : "."}</p>{canBill ? <Link href="/billing" className="mt-7 inline-flex rounded-xl bg-[#18345b] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#244a7c]">View billing and subscribe →</Link> : <p className="mt-6 text-sm font-medium text-[#43536b]">Ask your firm&apos;s owner to subscribe on the Billing page.</p>}</div>;
}
