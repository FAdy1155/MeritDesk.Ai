import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/billing/config";

const STEPS = [
  ["Sign up on MeritDesk.AI", "Create your account and your firm in a minute. You become the firm's owner and can invite your attorneys and paralegals."],
  ["Add the connector to Claude", "Paste the firm's connector address into Claude under Connectors and sign in. Each member connects with their own account; the Connect page walks through it for Claude and ChatGPT."],
  ["Use it free for 30 days", "Every firm's first 30 days are free, with everything on: matters, documents, the 26 skills and the legal library."],
  ["Subscribe here", "$20 per user per month, paid on this site. It renews automatically, seats follow your members, and receipts come by email."],
] as const;

const FEATURES = [
  {
    number: "01",
    title: "Matters and documents",
    description: "Clients, matters and their documents, scanned for malware and read for text, with every action in an audit log the firm keeps.",
    icon: "folder",
  },
  {
    number: "02",
    title: "26 immigration skills",
    description: "Claim evaluation, declaration and brief drafting, packet review and build, interview prep, bench memos and more, each run against the matter's documents and your firm's practice profile.",
    icon: "spark",
  },
  {
    number: "03",
    title: "The legal library",
    description: "Official sources, collected from the government and court sites and refreshed daily: BIA and AG precedents, statutes and regulations, agency manuals, country conditions reports, EOIR statistics.",
    icon: "book",
  },
] as const;

function ArrowIcon({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-4 w-4">
      {diagonal ? (
        <path d="M5 15 15 5M6 5h9v9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M3.5 10h12m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function FeatureIcon({ type }: { type: (typeof FEATURES)[number]["icon"] }) {
  const paths = {
    folder: <><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H8l2 2h5.5A1.5 1.5 0 0 1 17 8.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z" /><path d="M3.5 9h13" /></>,
    spark: <><path d="m10 2 1.8 5.2L17 9l-5.2 1.8L10 16l-1.8-5.2L3 9l5.2-1.8z" /><path d="m16.5 13 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></>,
    book: <><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H17v15H6.5A2.5 2.5 0 0 0 4 19.5z" /><path d="M4 4.5v15M7.5 6H14M7.5 9H14" /></>,
  };
  return (
    <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#eaf0ff] text-[#315fbd]">
      <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        {paths[type]}
      </svg>
    </span>
  );
}

function ProductPreview() {
  return (
    <div className="relative mx-auto w-full max-w-[590px] lg:ml-auto">
      <div aria-hidden="true" className="absolute -inset-8 rounded-[3rem] bg-[radial-gradient(ellipse_at_center,rgba(92,135,220,0.19),transparent_68%)] blur-2xl" />
      <div className="relative overflow-hidden rounded-[1.6rem] border border-[#dce3ef] bg-white shadow-[0_32px_90px_-38px_rgba(24,45,83,0.42)]">
        <div className="flex items-center justify-between border-b border-[#edf0f5] bg-[#fbfcfe] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#142849] text-xs font-bold text-white">M</div>
            <div>
              <p className="text-[12px] font-semibold tracking-tight text-[#182b49]">MeritDesk.AI</p>
              <p className="text-[10px] text-[#8290a5]">Firm workspace</p>
            </div>
          </div>
          <span className="rounded-full border border-[#dce8df] bg-[#f1f8f3] px-2.5 py-1 text-[10px] font-medium text-[#477455]">Workspace preview</span>
        </div>
        <div className="grid grid-cols-[128px_1fr] sm:grid-cols-[150px_1fr]">
          <aside className="min-h-[330px] border-r border-[#edf0f5] bg-[#f8fafd] p-3 sm:p-4">
            <p className="mb-3 px-2 text-[9px] font-semibold uppercase tracking-[0.16em] text-[#9aa6b8]">Workspace</p>
            <div className="space-y-1 text-[10px]">
              <div className="flex items-center gap-2 rounded-lg bg-[#e9effb] px-2.5 py-2 font-semibold text-[#315b9d]">
                <span className="h-1.5 w-1.5 rounded-sm bg-[#4777c8]" /> Matters
              </div>
              <div className="flex items-center gap-2 px-2.5 py-2 text-[#718097]"><span className="h-1.5 w-1.5 rounded-sm bg-[#c0cad8]" /> Documents</div>
              <div className="flex items-center gap-2 px-2.5 py-2 text-[#718097]"><span className="h-1.5 w-1.5 rounded-sm bg-[#c0cad8]" /> Skills</div>
              <div className="flex items-center gap-2 px-2.5 py-2 text-[#718097]"><span className="h-1.5 w-1.5 rounded-sm bg-[#c0cad8]" /> Legal library</div>
            </div>
            <div className="mt-8 rounded-xl border border-[#e7ebf2] bg-white p-3">
              <div className="mb-2 h-1.5 w-12 rounded-full bg-[#dbe4f2]" />
              <p className="text-[9px] font-semibold text-[#52627a]">Firm workspace</p>
              <p className="mt-1 text-[9px] leading-relaxed text-[#9aa5b5]">Your team, matters and documents in one place.</p>
            </div>
          </aside>
          <div className="p-4 sm:p-5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[9px] font-medium uppercase tracking-[0.16em] text-[#8a98ac]">Matter workspace</p>
                <h3 className="mt-1 text-[17px] font-semibold tracking-tight text-[#172a48] sm:text-[20px]">Work, connected.</h3>
                <p className="mt-1 text-[10px] text-[#8794a8]">A clear view of the work behind every case.</p>
              </div>
              <div className="rounded-lg border border-[#e5eaf1] px-2.5 py-1.5 text-[9px] font-medium text-[#60718b]">Overview</div>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-[#e7ebf2] p-3">
                <p className="text-[9px] text-[#8794a8]">Matters</p>
                <div className="mt-2 h-1.5 w-16 rounded-full bg-[#dce6f7]" />
                <div className="mt-2 h-1.5 w-10 rounded-full bg-[#eef1f6]" />
              </div>
              <div className="rounded-xl border border-[#e7ebf2] p-3">
                <p className="text-[9px] text-[#8794a8]">Documents</p>
                <div className="mt-2 h-1.5 w-14 rounded-full bg-[#dce6f7]" />
                <div className="mt-2 h-1.5 w-9 rounded-full bg-[#eef1f6]" />
              </div>
            </div>
            <div className="mt-3 rounded-xl border border-[#e7ebf2] p-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-semibold text-[#31435f]">Work with your legal tools</p>
                <span className="rounded-md bg-[#f0f4fb] px-2 py-1 text-[8px] font-medium text-[#5274ad]">Connected workflow</span>
              </div>
              <div className="mt-3 space-y-2">
                <div className="flex items-center gap-2 rounded-lg bg-[#f8fafd] px-2.5 py-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#e8eefb] text-[9px] font-bold text-[#456db0]">AI</span>
                  <div className="flex-1"><div className="h-1.5 w-28 max-w-full rounded-full bg-[#d9e1ee]" /><div className="mt-1.5 h-1 w-20 max-w-full rounded-full bg-[#edf0f5]" /></div>
                </div>
                <div className="flex items-center gap-2 rounded-lg bg-[#f8fafd] px-2.5 py-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#e9f3ef] text-[9px] font-bold text-[#4d826b]">26</span>
                  <div className="flex-1"><div className="h-1.5 w-24 max-w-full rounded-full bg-[#d9e1ee]" /><div className="mt-1.5 h-1 w-16 max-w-full rounded-full bg-[#edf0f5]" /></div>
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {["Matters", "Documents", "26 skills", "Legal library"].map((item) => (
                <span key={item} className="rounded-full border border-[#e6ebf2] px-2.5 py-1 text-[8px] text-[#75849a]">{item}</span>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="absolute -bottom-5 -left-3 hidden rounded-2xl border border-[#e2e8f1] bg-white px-4 py-3 shadow-[0_14px_35px_-20px_rgba(24,45,83,0.4)] sm:block">
        <p className="text-[9px] font-medium uppercase tracking-[0.13em] text-[#8996a9]">Built for legal work</p>
        <p className="mt-1 text-xs font-semibold text-[#243957]">Your firm. Your workflow.</p>
      </div>
    </div>
  );
}

export function Landing() {
  return (
    <div className="overflow-hidden bg-[#fbfcfe] text-[#182943]">
      <section className="relative isolate">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_78%_28%,rgba(211,226,250,0.62),transparent_38%),linear-gradient(180deg,#fbfcfe_0%,#f7f9fc_100%)]" />
        <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 pb-24 pt-16 sm:px-8 sm:pt-20 lg:grid-cols-[0.92fr_1.08fr] lg:gap-10 lg:px-10 lg:pb-32 lg:pt-24">
          <div className="relative z-10 max-w-2xl">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[#dce6f4] bg-white/80 px-3.5 py-2 text-[11px] font-semibold tracking-wide text-[#496b9e] shadow-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-[#5b83c6]" />
              AI-powered immigration legal work
            </div>
            <h1 className="text-[2.65rem] font-semibold leading-[1.08] tracking-[-0.055em] text-[#142641] sm:text-6xl lg:text-[4.15rem]">
              Immigration legal work, organized around your firm.
            </h1>
            <p className="mt-7 max-w-xl text-base leading-8 text-[#65748a] sm:text-lg">
              MeritDesk.AI gives immigration law firms one place to organize clients, matters and documents, work with 26 purpose-built immigration skills, and search a library of official legal sources. Connect Claude or ChatGPT to bring those firm resources into your AI conversations—with firm-controlled access and an audit trail for case-work activity.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link href="/sign-up" className="group inline-flex items-center gap-3 rounded-xl bg-[#17345f] px-6 py-3.5 text-sm font-semibold text-white shadow-[0_12px_25px_-12px_rgba(23,52,95,0.7)] transition hover:-translate-y-0.5 hover:bg-[#214779]">
                Start free month <ArrowIcon />
              </Link>
              <Link href="/pricing" className="inline-flex items-center gap-2 rounded-xl border border-[#d8e0eb] bg-white px-6 py-3.5 text-sm font-semibold text-[#344966] transition hover:border-[#aebed4] hover:bg-[#f7f9fc]">
                See pricing <ArrowIcon diagonal />
              </Link>
            </div>
            <p className="mt-4 text-xs font-medium tracking-wide text-[#8996a8]">30 days free, then $20 per user per month.</p>
            <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[#e7ebf1] pt-6 text-[11px] font-medium text-[#77869b]">
              <span>Matters and documents</span><span className="hidden h-1 w-1 rounded-full bg-[#b5c0ce] sm:block" />
              <span>26 immigration skills</span><span className="hidden h-1 w-1 rounded-full bg-[#b5c0ce] sm:block" />
              <span>Official legal sources</span>
            </div>
          </div>
          <ProductPreview />
        </div>
      </section>

      <section className="border-y border-[#e9edf3] bg-white">
        <div className="mx-auto max-w-7xl px-6 py-20 sm:px-8 lg:px-10 lg:py-24">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#6683b0]">A connected practice</p>
            <h2 id="what-you-get" className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-[#182943] sm:text-4xl">What your firm gets</h2>
            <p className="mt-4 text-sm leading-7 text-[#77859a]">The tools and legal resources your team needs, brought together in one workflow.</p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {FEATURES.map((feature) => (
              <article key={feature.number} className="group rounded-2xl border border-[#e7ebf1] bg-[#fcfdff] p-7 transition duration-300 hover:-translate-y-1 hover:border-[#cbd8ea] hover:shadow-[0_20px_45px_-32px_rgba(30,57,96,0.35)]">
                <div className="flex items-center justify-between">
                  <FeatureIcon type={feature.icon} />
                  <span className="text-xs font-semibold tracking-[0.14em] text-[#a6b1c0]">{feature.number}</span>
                </div>
                <h3 className="mt-7 text-lg font-semibold tracking-tight text-[#203550]">{feature.title}</h3>
                <p className="mt-3 text-sm leading-7 text-[#758399]">{feature.description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-[#f5f7fb]">
        <div className="mx-auto max-w-7xl px-6 py-20 sm:px-8 lg:px-10 lg:py-24">
          <div className="grid gap-12 lg:grid-cols-[0.75fr_1.25fr] lg:gap-20">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#6683b0]">Getting started</p>
              <h2 id="how-it-works" className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-[#182943] sm:text-4xl">How it works</h2>
              <p className="mt-5 max-w-sm text-sm leading-7 text-[#77859a]">From setting up your firm to working with your legal tools, getting started is straightforward.</p>
              <Link href="/sign-up" className="mt-8 inline-flex items-center gap-2 text-sm font-semibold text-[#315d9c] transition hover:gap-3">
                Get started <ArrowIcon />
              </Link>
            </div>
            <ol className="grid gap-3 sm:grid-cols-2">
              {STEPS.map(([title, description], index) => (
                <li key={title} className="rounded-2xl border border-[#e3e9f1] bg-white p-6">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#edf2fa] text-xs font-bold text-[#466a9f]">0{index + 1}</span>
                  <h3 className="mt-5 text-base font-semibold text-[#243852]">{title}</h3>
                  <p className="mt-2 text-sm leading-7 text-[#78869a]">{description}</p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section className="border-y border-[#e9edf3] bg-white">
        <div className="mx-auto max-w-7xl px-6 py-20 sm:px-8 lg:px-10 lg:py-24">
          <div className="mx-auto max-w-3xl">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#6683b0]">Designed around your workflow</p>
            <h2 id="in-claude" className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-[#182943] sm:text-4xl">How the connector works in Claude</h2>
            <div className="mt-9 space-y-6 text-[15px] leading-8 text-[#68788e]">
              <p>
                {PRODUCT_NAME} is a remote connector (an MCP server). In Claude, open Settings, then Connectors, choose Add
                custom connector and paste the firm&apos;s connector address from the app&apos;s Connect page. Claude sends
                you to sign in to {PRODUCT_NAME}, you choose your firm, and the connector&apos;s tools appear in your chats.
                Team and Enterprise plans add it once for everyone under Organization settings. ChatGPT connects the same
                way as a custom MCP server.
              </p>
              <p>
                The library tools are on for every member from the start. The case-work tools (matters, documents,
                skill runs) are off until the firm&apos;s owner turns them on from the Firm page, after reading a
                disclosure: when they are on, what Claude reads about a matter goes into your Claude conversation under
                Anthropic&apos;s terms. Every case-work call is recorded in the firm&apos;s audit log.
              </p>
              <p>
                Subscription and payment happen only on this site. Claude never asks for a card: when a firm&apos;s free
                month ends without a subscription, the connector simply points the owner to the Billing page.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-[#132b4d]">
        <div className="mx-auto flex max-w-7xl flex-col gap-10 px-6 py-16 sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:px-10 lg:py-20">
          <div className="max-w-2xl">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#a9c1e4]">Simple, transparent pricing</p>
            <h2 id="pricing-summary" className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">30 days free, then $20 per user per month</h2>
            <p className="mt-5 text-sm leading-7 text-[#c2cfe0]">
              Every firm starts with a free month, no card needed. After that, each member of the firm is one seat at $20
              a month, billed to the firm by Stripe, renewed automatically, with a receipt by email after every payment.
              Cancel at any time from the Billing page; the firm keeps access until the end of the period it paid for.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-start gap-4 sm:flex-row sm:items-center">
            <Link href="/sign-up" className="inline-flex items-center gap-3 rounded-xl bg-white px-6 py-3.5 text-sm font-semibold text-[#18365f] transition hover:-translate-y-0.5 hover:bg-[#edf3fb]">
              Start free month <ArrowIcon />
            </Link>
            <Link href="/pricing" className="inline-flex items-center gap-2 text-sm font-semibold text-white/85 transition hover:text-white">
              Pricing details <ArrowIcon diagonal />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
