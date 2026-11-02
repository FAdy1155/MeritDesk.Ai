"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string; icon: string };
type NavGroup = { label: string; links: NavItem[] };
const GROUPS: NavGroup[] = [
  { label: "WORKSPACE", links: [
    { href: "/", label: "Overview", icon: "⌂" },
    { href: "/matters", label: "Matters", icon: "▤" },
    { href: "/clients", label: "Clients", icon: "♙" },
    { href: "/updates", label: "Legal updates", icon: "◷" },
  ]},
  { label: "RESOURCES", links: [
    { href: "/library", label: "Legal library", icon: "§" },
    { href: "/practice-profile", label: "Practice profile", icon: "◎" },
  ]},
  { label: "ADMINISTRATION", links: [
    { href: "/firm", label: "Firm settings", icon: "⚙" },
    { href: "/connect", label: "AI connections", icon: "⌘" },
    { href: "/billing", label: "Billing", icon: "$" },
  ]},
];

export function AppNavigation({ variant, unreviewedLegalUpdates = 0 }: { variant: "sidebar" | "mobile"; unreviewedLegalUpdates?: number }) {
  const pathname = usePathname();
  const active = (href: string) => href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
  if (variant === "mobile") {
    return <nav aria-label="Mobile workspace navigation" className="flex gap-1 overflow-x-auto border-b border-[#e8edf4] bg-white px-3 py-2 md:hidden">
      {GROUPS.flatMap(group => group.links).map(item => <Link key={item.href} href={item.href} aria-current={active(item.href) ? "page" : undefined} className={"shrink-0 rounded-lg px-3 py-2 text-xs font-medium transition " + (active(item.href) ? "bg-[#edf3fc] text-[#244d83]" : "text-[#64748b] hover:bg-[#f5f7fb] hover:text-[#233a5c]")}>{item.label}{item.href === "/updates" && unreviewedLegalUpdates > 0 ? " · " + unreviewedLegalUpdates : ""}</Link>)}
    </nav>;
  }
  return <aside className="hidden w-[248px] shrink-0 flex-col border-r border-[#e8edf4] bg-white px-4 py-6 md:flex">
    <Link href="/" className="mb-9 flex items-center gap-3 px-2"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#18345b] text-lg font-bold text-white shadow-sm">M</span><span className="leading-tight"><span className="block text-[15px] font-bold tracking-tight text-[#172b49]">MeritDesk<span className="text-[#4775bd]">.AI</span></span><span className="mt-1 block text-[10px] font-medium uppercase tracking-[.16em] text-[#9aa7b9]">Legal workspace</span></span></Link>
    <div className="flex flex-1 flex-col gap-7">
      {GROUPS.map(group => <section key={group.label}><h2 className="mb-2 px-3 text-[10px] font-bold tracking-[.16em] text-[#9aa7b9]">{group.label}</h2><div className="space-y-1">{group.links.map(item => <Link key={item.href} href={item.href} aria-current={active(item.href) ? "page" : undefined} className={"group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-colors " + (active(item.href) ? "bg-[#edf3fc] text-[#244d83]" : "text-[#64748b] hover:bg-[#f5f7fb] hover:text-[#233a5c]")}><span aria-hidden="true" className={"flex h-6 w-6 items-center justify-center rounded-lg text-[16px] " + (active(item.href) ? "bg-white text-[#315f9d] shadow-sm" : "text-[#94a3b8] group-hover:text-[#49698f]")}>{item.icon}</span><span className="flex-1">{item.label}</span>{item.href === "/updates" && unreviewedLegalUpdates > 0 && <span className="rounded-full bg-[#e9a23b] px-2 py-0.5 text-[10px] font-bold text-white">{unreviewedLegalUpdates}</span>}</Link>)}</div></section>)}
    </div>
    <div className="mt-8 rounded-2xl border border-[#e7edf5] bg-[#f8fafd] p-4"><p className="text-xs font-semibold text-[#344b6d]">Your practice, organized.</p><p className="mt-1.5 text-[11px] leading-5 text-[#8290a4]">Manage matters, documents and legal research in one secure workspace.</p><Link href="/connect" className="mt-3 inline-flex text-xs font-semibold text-[#3769a8] hover:text-[#244d83]">Set up AI connection →</Link></div>
  </aside>;
}
