
import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { formatDay } from "@/lib/billing/config";
import { getEntitlement } from "@/lib/billing/entitlement";
import { getConnectorSettings } from "@/lib/connector/settings";
import { getCurrentTenant } from "@/lib/tenant";

export default async function DashboardPage() {
  const { userId } = await auth();

  // The public landing page is rendered by the app layout for signed-out visitors.
  // Do not execute dashboard tenant or billing queries without an authenticated user.
  if (!userId) return null;

  const { tenant } = await getCurrentTenant();
  const [entitlement, connector] = await Promise.all([
    getEntitlement(tenant.id),
    getConnectorSettings(tenant.id),
  ]);

  const billingStatus = entitlement.state === "trialing"
    ? "Free month ends " + (entitlement.trialEndsAt ? formatDay(entitlement.trialEndsAt) : "soon") + " · " + entitlement.trialDaysLeft + " days left"
    : entitlement.state === "active"
      ? "Subscription active"
      : entitlement.state === "past_due"
        ? "Payment needs attention"
        : "Subscription required";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      <section className="overflow-hidden rounded-3xl bg-[linear-gradient(115deg,#18345b_0%,#244b7b_58%,#416b9e_100%)] px-6 py-9 text-white shadow-[0_20px_55px_-35px_rgba(24,52,91,.65)] sm:px-9 sm:py-11">
        <p className="text-[11px] font-bold uppercase tracking-[.18em] text-blue-100/75">MERITDESK.AI · CONNECTOR CONTROL PANEL</p>
        <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">Your legal work happens in Claude or ChatGPT.</h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-blue-50/90">This portal is where {tenant.name} manages its connection, permissions and subscription. Once connected, use your AI assistant to search immigration law and work with the tools your firm has enabled.</p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link href="/connect" className="inline-flex items-center rounded-xl bg-white px-5 py-3 text-sm font-semibold text-[#1b3b65] transition hover:bg-blue-50">Connect Claude or ChatGPT <span className="ml-2">→</span></Link>
          <Link href="/firm" className="inline-flex items-center rounded-xl border border-white/30 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10">Manage firm permissions</Link>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <article className="rounded-2xl border border-[#e6ebf2] bg-white p-5">
          <p className="text-[10px] font-bold uppercase tracking-[.15em] text-[#91a0b4]">01 · CONNECTOR</p>
          <h2 className="mt-2 text-base font-semibold text-[#293f5e]">Connect your assistant</h2>
          <p className="mt-2 text-sm leading-6 text-[#8290a4]">Add the MeritDesk MCP address to Claude or ChatGPT, authorize your account, then start asking questions.</p>
          <Link href="/connect" className="mt-4 inline-flex text-xs font-semibold text-[#426da5]">Open step-by-step guide →</Link>
        </article>
        <article className="rounded-2xl border border-[#e6ebf2] bg-white p-5">
          <p className="text-[10px] font-bold uppercase tracking-[.15em] text-[#91a0b4]">02 · FIRM ACCESS</p>
          <h2 className="mt-2 text-base font-semibold text-[#293f5e]">Case-work tools</h2>
          <p className="mt-2 text-sm leading-6 text-[#8290a4]">{connector.caseWorkActive ? "Enabled for this firm. Member roles and the platform&apos;s client allow-list still determine which tools are available." : "Currently off. An owner/admin can review the disclosure and enable firm matter and skill tools."}</p>
          <Link href="/firm" className="mt-4 inline-flex text-xs font-semibold text-[#426da5]">Review firm controls →</Link>
        </article>
        <article className="rounded-2xl border border-[#e6ebf2] bg-white p-5">
          <p className="text-[10px] font-bold uppercase tracking-[.15em] text-[#91a0b4]">03 · SUBSCRIPTION</p>
          <h2 className="mt-2 text-base font-semibold text-[#293f5e]">Account status</h2>
          <p className="mt-2 text-sm leading-6 text-[#8290a4]">{billingStatus}. The legal library and connector access follow your firm&apos;s entitlement.</p>
          <Link href="/billing" className="mt-4 inline-flex text-xs font-semibold text-[#426da5]">Manage billing →</Link>
        </article>
      </section>

      <section className="rounded-2xl border border-[#e6ebf2] bg-white p-6 sm:p-7">
        <p className="text-[10px] font-bold uppercase tracking-[.16em] text-[#91a0b4]">GET STARTED</p>
        <h2 className="mt-2 text-lg font-semibold text-[#293f5e]">Three steps, then work in your assistant.</h2>
        <ol className="mt-5 grid gap-4 md:grid-cols-3">
          <li className="rounded-xl bg-[#f7f9fc] p-4"><span className="text-xs font-semibold text-[#385a86]">1. Connect</span><p className="mt-1 text-xs leading-5 text-[#8492a5]">Follow the Claude or ChatGPT guide and sign in with your own MeritDesk account.</p></li>
          <li className="rounded-xl bg-[#f7f9fc] p-4"><span className="text-xs font-semibold text-[#385a86]">2. Configure</span><p className="mt-1 text-xs leading-5 text-[#8492a5]">An owner reviews case-work access, firm identity, attorney details and practice profile.</p></li>
          <li className="rounded-xl bg-[#f7f9fc] p-4"><span className="text-xs font-semibold text-[#385a86]">3. Ask</span><p className="mt-1 text-xs leading-5 text-[#8492a5]">Use the example prompts on the Connect page to begin researching and using available skills.</p></li>
        </ol>
      </section>
    </div>
  );
}
