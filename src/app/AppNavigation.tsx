"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string; icon: string };

const ITEMS: NavItem[] = [
  { href: "/", label: "Overview", icon: "⌂" },
  { href: "/connect", label: "Connect assistant", icon: "⌘" },
  { href: "/firm", label: "Firm & permissions", icon: "⚙" },
  { href: "/practice-profile", label: "Practice profile", icon: "◎" },
  { href: "/billing", label: "Billing", icon: "$" },
];

export function AppNavigation({ variant }: { variant: "sidebar" | "mobile"; unreviewedLegalUpdates?: number }) {
  const pathname = usePathname();
  const active = (href: string) => pathname === href || pathname.startsWith(href + "/");

  if (variant === "mobile") {
    return (
      <nav aria-label="Account navigation" className="flex gap-1 overflow-x-auto border-b border-[#e8edf4] bg-white px-3 py-2 md:hidden">
        {ITEMS.map(item => (
          <Link key={item.href} href={item.href} aria-current={active(item.href) ? "page" : undefined}
            className={"shrink-0 rounded-lg px-3 py-2 text-xs font-medium transition " + (active(item.href) ? "bg-[#edf3fc] text-[#244d83]" : "text-[#64748b] hover:bg-[#f5f7fb] hover:text-[#233a5c]")}>
            {item.label}
          </Link>
        ))}
      </nav>
    );
  }

  return (
    <aside className="hidden w-[248px] shrink-0 flex-col border-r border-[#e8edf4] bg-white px-4 py-6 md:flex">
      <Link href="/" className="mb-9 flex items-center gap-3 px-2">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#18345b] text-lg font-bold text-white shadow-sm">M</span>
        <span className="leading-tight">
          <span className="block text-[15px] font-bold tracking-tight text-[#172b49]">MeritDesk<span className="text-[#4775bd]">.AI</span></span>
          <span className="mt-1 block text-[10px] font-medium uppercase tracking-[.16em] text-[#9aa7b9]">AI connector</span>
        </span>
      </Link>
      <div className="flex flex-1 flex-col gap-2">
        <p className="mb-2 px-3 text-[10px] font-bold tracking-[.16em] text-[#9aa7b9]">ACCOUNT & CONNECTION</p>
        {ITEMS.map(item => (
          <Link key={item.href} href={item.href} aria-current={active(item.href) ? "page" : undefined}
            className={"group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-colors " + (active(item.href) ? "bg-[#edf3fc] text-[#244d83]" : "text-[#64748b] hover:bg-[#f5f7fb] hover:text-[#233a5c]")}>
            <span aria-hidden="true" className={"flex h-6 w-6 items-center justify-center rounded-lg text-[16px] " + (active(item.href) ? "bg-white text-[#315f9d] shadow-sm" : "text-[#94a3b8] group-hover:text-[#49698f]")}>{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        ))}
      </div>
      <div className="mt-8 rounded-2xl border border-[#e7edf5] bg-[#f8fafd] p-4">
        <p className="text-xs font-semibold text-[#344b6d]">Your work happens in AI.</p>
        <p className="mt-1.5 text-[11px] leading-5 text-[#8290a4]">Use Claude or ChatGPT for research and casework. This portal manages your connection and firm controls.</p>
        <Link href="/connect" className="mt-3 inline-flex text-xs font-semibold text-[#3769a8] hover:text-[#244d83]">Open connection guide →</Link>
      </div>
    </aside>
  );
}
