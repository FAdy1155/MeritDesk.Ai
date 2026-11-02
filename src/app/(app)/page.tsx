import Link from "next/link";
import { PRODUCT_NAME, formatDay } from "@/lib/billing/config";
import { getEntitlement } from "@/lib/billing/entitlement";
import { getCurrentTenant } from "@/lib/tenant";

const quickLinks = [
  { href: "/matters", eyebrow: "CASE MANAGEMENT", title: "Manage matters", description: "Open a case, review its documents and follow the work in progress.", icon: "▤", action: "View matters" },
  { href: "/clients", eyebrow: "CLIENT RECORDS", title: "Manage clients", description: "Keep client details organized and connect people to their matters.", icon: "♙", action: "View clients" },
  { href: "/library", eyebrow: "LEGAL RESEARCH", title: "Explore the legal library", description: "Search official immigration decisions, statutes, regulations and guidance.", icon: "▧", action: "Open library" },
  { href: "/connect", eyebrow: "AI WORKFLOW", title: "Connect your AI assistant", description: "Follow the steps to use your firm's tools in Claude or ChatGPT.", icon: "⌘", action: "Set up connection" },
];

export default async function DashboardPage() {
  const { tenant } = await getCurrentTenant();
  const entitlement = await getEntitlement(tenant.id);
  const standing = entitlement.state === "trialing"
    ? "Free month ends " + (entitlement.trialEndsAt ? formatDay(entitlement.trialEndsAt) : "soon") + " · " + entitlement.trialDaysLeft + " days remaining"
    : entitlement.state === "active" ? "Your subscription is active"
    : entitlement.state === "past_due" ? "Payment needs attention · Review billing"
    : "Subscription required · Review billing";
  const statusTone = entitlement.state === "active" ? "bg-emerald-50 text-emerald-700" : entitlement.state === "past_due" || entitlement.state === "locked" ? "bg-amber-50 text-amber-800" : "bg-blue-50 text-blue-700";

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-8">
      <section className="flex flex-col justify-between gap-5 rounded-3xl bg-[linear-gradient(115deg,#18345b_0%,#244b7b_58%,#416b9e_100%)] px-6 py-8 text-white shadow-[0_20px_55px_-35px_rgba(24,52,91,.65)] sm:px-9 sm:py-10 lg:flex-row lg:items-end">
        <div className="max-w-2xl"><p className="text-[11px] font-bold uppercase tracking-[.18em] text-blue-100/75">YOUR PRACTICE AT A GLANCE</p><h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Welcome to your workspace.</h1><p className="mt-3 max-w-xl text-sm leading-7 text-blue-50/85">{tenant.name} is your firm&apos;s home for immigration matters, client records, legal research and AI-assisted workflows.</p></div>
        <div className="flex flex-wrap items-center gap-3"><Link href="/matters" className="inline-flex items-center rounded-xl bg-white px-4 py-3 text-sm font-semibold text-[#1b3b65] transition hover:bg-blue-50">Open matters <span className="ml-2">→</span></Link><Link href="/connect" className="inline-flex items-center rounded-xl border border-white/30 px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/10">Connect AI tools</Link></div>
      </section>
      <section className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold tracking-tight text-[#243a59]">Workspace overview</h2><p className="mt-1 text-sm text-[#8794a7]">The key areas of {PRODUCT_NAME}, all in one place.</p></div><Link href="/billing" className={"rounded-full px-3.5 py-2 text-xs font-semibold " + statusTone}>{standing} <span aria-hidden="true">↗</span></Link></section>
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {quickLinks.map((item) => <Link key={item.href} href={item.href} className="group flex min-h-[220px] flex-col rounded-2xl border border-[#e6ebf2] bg-white p-5 shadow-[0_5px_20px_-18px_rgba(25,49,82,.25)] transition duration-200 hover:-translate-y-1 hover:border-[#cbd9eb] hover:shadow-[0_18px_35px_-25px_rgba(25,49,82,.35)]"><div className="flex items-center justify-between"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#edf3fc] text-xl text-[#416b9e]">{item.icon}</span><span className="text-[#a6b2c2] transition group-hover:translate-x-1 group-hover:text-[#416b9e]">↗</span></div><p className="mt-5 text-[9px] font-bold tracking-[.15em] text-[#9aa7b9]">{item.eyebrow}</p><h3 className="mt-1.5 text-[15px] font-semibold text-[#293f5e]">{item.title}</h3><p className="mt-2 flex-1 text-xs leading-6 text-[#8290a4]">{item.description}</p><span className="mt-4 text-xs font-semibold text-[#426da5]">{item.action} →</span></Link>)}
      </section>
      <section className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
        <div className="rounded-2xl border border-[#e6ebf2] bg-white p-6 sm:p-7"><p className="text-[10px] font-bold tracking-[.16em] text-[#91a0b4]">GETTING STARTED</p><h2 className="mt-2 text-lg font-semibold text-[#293f5e]">Make this workspace yours</h2><p className="mt-2 max-w-xl text-sm leading-6 text-[#8290a4]">Complete these setup steps to prepare your firm&apos;s workspace and make the tools useful to your team.</p><div className="mt-5 grid gap-3 sm:grid-cols-2"><Link href="/firm" className="rounded-xl bg-[#f7f9fc] p-4 transition hover:bg-[#eef3fa]"><span className="text-xs font-semibold text-[#385a86]">01 · Firm details</span><p className="mt-1 text-xs leading-5 text-[#8492a5]">Add firm identity, attorneys and team access.</p></Link><Link href="/practice-profile" className="rounded-xl bg-[#f7f9fc] p-4 transition hover:bg-[#eef3fa]"><span className="text-xs font-semibold text-[#385a86]">02 · Practice profile</span><p className="mt-1 text-xs leading-5 text-[#8492a5]">Set the context used by your legal workflows.</p></Link></div></div>
        <div className="rounded-2xl border border-[#e6ebf2] bg-white p-6 sm:p-7"><p className="text-[10px] font-bold tracking-[.16em] text-[#91a0b4]">YOUR SUBSCRIPTION</p><h2 className="mt-2 text-lg font-semibold text-[#293f5e]">Account status</h2><p className="mt-3 text-sm leading-6 text-[#8290a4]">{standing}</p><Link href="/billing" className="mt-5 inline-flex text-xs font-semibold text-[#426da5] hover:text-[#244d83]">View billing details →</Link></div>
      </section>
    </div>
  );
}
