
import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/billing/config";

const navLink =
  "text-sm font-medium text-[#687568] transition-colors hover:text-[#29483b]";

const primaryButton =
  "inline-flex items-center justify-center rounded-lg bg-[#29483b] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-[#365a49]";

export function PublicShell({
  children,
  signedIn,
}: {
  children: React.ReactNode;
  signedIn: boolean;
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-[#f8f6f0] text-[#252b24]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-[#29483b] focus:px-4 focus:py-3 focus:text-white"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-50 border-b border-[#e7e3d8] bg-[#fbfaf5]/95 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-6 py-4 sm:px-8 lg:px-10">
          <Link
            href="/"
            className="group flex shrink-0 items-center gap-3"
            aria-label={`${PRODUCT_NAME} home`}
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#29483b] font-serif text-lg font-semibold text-[#f8f6f0] shadow-sm transition group-hover:bg-[#365a49]">
              M
            </span>
            <span className="text-base font-semibold tracking-[-0.04em] text-[#294034]">
              {PRODUCT_NAME}
            </span>
          </Link>

          <nav
            aria-label="Main navigation"
            className="hidden items-center gap-7 md:flex"
          >
            <Link href="/#features" className={navLink}>
              Product
            </Link>
            <Link href="/#how-it-works" className={navLink}>
              How it works
            </Link>
            <Link href="/setup" className={navLink}>
              Connect
            </Link>
            <Link href="/#security" className={navLink}>
              Firm control
            </Link>
            <Link href="/pricing" className={navLink}>
              Pricing
            </Link>
          </nav>

          <div className="flex shrink-0 items-center gap-3">
            {signedIn ? (
              <Link href="/connect" className={primaryButton}>
                <span className="hidden sm:inline">Connector setup</span>
                <span className="sm:hidden">Open app</span>
              </Link>
            ) : (
              <>
                <Link
                  href="/sign-in"
                  className="hidden text-sm font-medium text-[#687568] transition hover:text-[#29483b] sm:inline"
                >
                  Sign in
                </Link>
                <Link href="/sign-up" className={primaryButton}>
                  Get started
                </Link>
              </>
            )}
          </div>
        </div>

        <nav
          aria-label="Mobile navigation"
          className="flex items-center justify-center gap-6 border-t border-[#e7e3d8] px-4 py-2.5 md:hidden"
        >
          <Link href="/#features" className="text-xs font-medium text-[#687568]">
            Product
          </Link>
          <Link href="/setup" className="text-xs font-medium text-[#687568]">
            Connect
          </Link>
          <Link href="/pricing" className="text-xs font-medium text-[#687568]">
            Pricing
          </Link>
          <Link href="/#how-it-works" className="text-xs font-medium text-[#687568]">
            How it works
          </Link>
        </nav>
      </header>

      <main id="main-content" className="flex flex-1 flex-col">
        {children}
      </main>

      <footer className="border-t border-[#e4e0d5] bg-[#eeeee5]">
        <div className="mx-auto w-full max-w-7xl px-6 py-10 sm:px-8 lg:px-10">
          <div className="grid gap-9 sm:grid-cols-[1fr_auto] sm:items-start">
            <div className="max-w-sm">
              <Link href="/" className="inline-flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#29483b] font-serif text-sm font-semibold text-white">
                  M
                </span>
                <span className="text-sm font-semibold tracking-tight text-[#294034]">
                  {PRODUCT_NAME}
                </span>
              </Link>
              <p className="mt-4 text-xs leading-6 text-[#77776c]">
                Immigration-law research and firm tools, connected to the AI
                assistants your team already uses.
              </p>
            </div>

            <nav
              aria-label="Footer navigation"
              className="flex flex-wrap gap-x-7 gap-y-4 text-xs font-medium text-[#687568]"
            >
              <Link href="/setup" className="transition hover:text-[#29483b]">
                Connect
              </Link>
              <Link href="/pricing" className="transition hover:text-[#29483b]">
                Pricing
              </Link>
              <Link href="/sign-up" className="transition hover:text-[#29483b]">
                Get started
              </Link>
              <Link href="/terms" className="transition hover:text-[#29483b]">
                Terms
              </Link>
              <Link href="/privacy" className="transition hover:text-[#29483b]">
                Privacy
              </Link>
            </nav>
          </div>

          <div className="mt-9 border-t border-[#dedacd] pt-5">
            <p className="text-[11px] text-[#929083]">
              © {new Date().getFullYear()} {PRODUCT_NAME}. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
