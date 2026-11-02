import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/billing/config";

const buttonClass = "inline-flex items-center justify-center rounded-xl bg-[#17345f] px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-[#214779]";

export function PublicShell({ children, signedIn }: { children: React.ReactNode; signedIn: boolean }) {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-[#fbfcfe] text-[#182943]">
      <header className="sticky top-0 z-50 border-b border-[#e8edf4] bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-4 sm:px-8 lg:px-10">
          <Link href="/" className="group flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#17345f] text-sm font-bold tracking-tight text-white shadow-sm">M</span>
            <span className="text-[15px] font-semibold tracking-[-0.03em] text-[#192d49]">{PRODUCT_NAME}</span>
          </Link>
          <nav aria-label="Main navigation" className="flex items-center gap-3 sm:gap-6">
            <div className="hidden items-center gap-6 md:flex">
              <Link href="/#features" className="text-sm font-medium text-[#697991] transition hover:text-[#1b3458]">Product</Link>
              <Link href="/#how-it-works" className="text-sm font-medium text-[#697991] transition hover:text-[#1b3458]">How it works</Link>
              <Link href="/#security" className="text-sm font-medium text-[#697991] transition hover:text-[#1b3458]">Security</Link>
              <Link href="/pricing" className="text-sm font-medium text-[#697991] transition hover:text-[#1b3458]">Pricing</Link>
            </div>
            <Link href="/pricing" className="text-sm font-medium text-[#697991] transition hover:text-[#1b3458] md:hidden">Pricing</Link>
            {signedIn ? (
              <Link href="/" className={buttonClass}>
                Open the app
              </Link>
            ) : (
              <>
                <Link href="/sign-in" className="hidden text-sm font-medium text-[#697991] transition hover:text-[#1b3458] sm:inline">
                  Sign in
                </Link>
                <Link href="/sign-up" className={buttonClass}>
                  <span className="hidden sm:inline">Start free month</span>
                  <span className="sm:hidden">Get started</span>
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
      <footer className="border-t border-[#e8edf4] bg-white">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-6 py-7 text-xs text-[#8793a4] sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
          <span>{PRODUCT_NAME}. 30 days free, then $20 per user per month.</span>
          <nav aria-label="Footer navigation" className="flex items-center gap-6">
            <Link href="/pricing" className="transition hover:text-[#243c5e]">Pricing</Link>
            <Link href="/terms" className="transition hover:text-[#243c5e]">Terms</Link>
            <Link href="/privacy" className="transition hover:text-[#243c5e]">Privacy</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
