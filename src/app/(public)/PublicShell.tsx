import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/billing/config";

// The frame of the public pages (the landing page at "/", /pricing, /terms,
// /privacy; src/proxy.ts makes exactly those public): a header with the
// product name, the pricing link and the sign-in and sign-up buttons, and
// a footer with the legal pages. Signed-in visitors get a link into the app
// instead of the sign-in buttons.

const buttonClass = "rounded-md bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black";

export function PublicShell({ children, signedIn }: { children: React.ReactNode; signedIn: boolean }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-black/10 px-6 py-3 dark:border-white/10">
        <Link href="/" className="font-semibold">
          {PRODUCT_NAME}
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/pricing" className="text-black/70 hover:text-black dark:text-white/70 dark:hover:text-white">
            Pricing
          </Link>
          {signedIn ? (
            <Link href="/" className={buttonClass}>
              Open the app
            </Link>
          ) : (
            <>
              <Link href="/sign-in" className="text-black/70 hover:text-black dark:text-white/70 dark:hover:text-white">
                Sign in
              </Link>
              <Link href="/sign-up" className={buttonClass}>
                Start free month
              </Link>
            </>
          )}
        </nav>
      </header>
      <main className="flex flex-1 flex-col px-6 py-10">{children}</main>
      <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-black/10 px-6 py-4 text-xs text-black/60 dark:border-white/10 dark:text-white/60">
        <span>{PRODUCT_NAME}. 30 days free, then $20 per user per month.</span>
        <nav className="flex items-center gap-4">
          <Link href="/pricing" className="hover:underline">
            Pricing
          </Link>
          <Link href="/terms" className="hover:underline">
            Terms
          </Link>
          <Link href="/privacy" className="hover:underline">
            Privacy
          </Link>
        </nav>
      </footer>
    </div>
  );
}
