
import Link from "next/link";
import { DEFAULT_TRIAL_DAYS, PRODUCT_NAME, SEAT_PRICE_CENTS } from "@/lib/billing/config";

const price = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
}).format(SEAT_PRICE_CENTS / 100);

const capabilities = [
  {
    number: "01",
    title: "Research immigration law",
    description:
      "Search immigration-law sources, explore decisions and regulations, and retrieve official material your AI assistant can reference.",
    examples: [
      "Find relevant BIA decisions",
      "Research statutes and regulations",
      "Explore agency guidance",
    ],
  },
  {
    number: "02",
    title: "Bring matters into the conversation",
    description:
      "When your firm enables case-work access, your assistant can work with permitted matter details and available documents.",
    examples: [
      "Review matter information",
      "Find available evidence files",
      "Understand case developments",
    ],
  },
  {
    number: "03",
    title: "Use purpose-built legal skills",
    description:
      "Access immigration-focused tools for research, review, drafting and case preparation, directly through your AI assistant.",
    examples: [
      "Review a case for potential issues",
      "Identify missing evidence",
      "Prepare structured draft reports",
    ],
  },
  {
    number: "04",
    title: "Keep your firm in control",
    description:
      "Your firm decides who can access case-work tools. Individual members connect using their own sign-in.",
    examples: [
      "Individual member authentication",
      "Firm-managed permissions",
      "Controlled access to case-work tools",
    ],
  },
];

const steps = [
  {
    number: "01",
    title: "Create your firm account",
    description:
      "Set up your firm and invite the people who need access to MeritDesk.",
  },
  {
    number: "02",
    title: "Connect your AI assistant",
    description:
      "Follow the connection instructions to add MeritDesk to Claude or ChatGPT.",
  },
  {
    number: "03",
    title: "Configure firm permissions",
    description:
      "Review the available permissions and enable case-work access when your firm is ready.",
  },
  {
    number: "04",
    title: "Get to work",
    description:
      "Ask your assistant to research legal sources, work with permitted matter context and use available skills.",
  },
];

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      className="h-4 w-4 transition-transform group-hover:translate-x-1"
    >
      {diagonal ? (
        <path
          d="M5 15 15 5M6 5h9v9"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M3.5 10h12m-5-5 5 5-5 5"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8a7048]">
      {children}
    </p>
  );
}

function AssistantPreview() {
  return (
    <div className="relative mx-auto w-full max-w-[570px] lg:ml-auto">
      <div
        aria-hidden="true"
        className="absolute -inset-8 -z-10 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(164,155,113,0.2),transparent_68%)] blur-2xl"
      />

      <div className="overflow-hidden rounded-[22px] border border-[#ded9cc] bg-[#fffdf8] shadow-[0_35px_90px_-45px_rgba(34,48,37,0.35)]">
        <div className="flex items-center justify-between border-b border-[#eae5d9] px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#29483b] text-sm font-semibold text-white">
              M
            </div>
            <div>
              <p className="text-sm font-semibold text-[#25382d]">
                MeritDesk.AI
              </p>
              <p className="text-[11px] text-[#8b8b7e]">
                Your legal research connector
              </p>
            </div>
          </div>
          <span className="rounded-full border border-[#d8e3d8] bg-[#f0f5ed] px-3 py-1 text-[10px] font-semibold text-[#49664c]">
            MCP CONNECTED
          </span>
        </div>

        <div className="space-y-5 p-5 sm:p-7">
          <div className="ml-auto max-w-[90%] rounded-2xl rounded-tr-sm bg-[#edf0e8] px-4 py-4 text-sm leading-7 text-[#465447]">
            Research the current law on this immigration issue. Find relevant
            decisions and official agency guidance.
          </div>

          <div className="max-w-[96%] rounded-2xl rounded-tl-sm border border-[#e8e3d8] bg-white p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#66866b]" />
              <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#858477]">
                MeritDesk tools
              </p>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {["Legal research", "Source retrieval", "Matter context"].map(
                (item) => (
                  <span
                    key={item}
                    className="rounded-lg bg-[#f4f2eb] px-3 py-2 text-[10px] font-medium text-[#65705f]"
                  >
                    {item}
                  </span>
                ),
              )}
            </div>

            <p className="mt-5 text-sm leading-7 text-[#60665b]">
              Your assistant can use the connected tools to retrieve relevant
              material and prepare a structured response with source links.
            </p>

            <div className="mt-4 space-y-2">
              <div className="rounded-xl border border-[#eae6dc] p-3">
                <p className="text-xs font-semibold text-[#33483a]">
                  Relevant legal authority
                </p>
                <p className="mt-1 text-[11px] leading-5 text-[#929084]">
                  Relevant source information and official references.
                </p>
              </div>
              <div className="rounded-xl border border-[#eae6dc] p-3">
                <p className="text-xs font-semibold text-[#33483a]">
                  Research summary
                </p>
                <p className="mt-1 text-[11px] leading-5 text-[#929084]">
                  A structured response prepared for further review.
                </p>
              </div>
            </div>
          </div>

          <p className="text-center text-[10px] text-[#aaa696]">
            Illustrative interface · Not a real legal result or client matter
          </p>
        </div>
      </div>
    </div>
  );
}

export function Landing() {
  return (
    <div className="overflow-hidden bg-[#f8f6f0] text-[#252b24]">
      {/* HERO */}
      <section className="relative isolate">
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_78%_25%,rgba(202,195,164,0.24),transparent_42%),linear-gradient(180deg,#fbfaf5_0%,#f5f3eb_100%)]"
        />

        <div className="mx-auto grid max-w-7xl items-center gap-16 px-6 pb-24 pt-16 sm:px-8 sm:pt-24 lg:grid-cols-[0.95fr_1.05fr] lg:gap-14 lg:px-10 lg:pb-32">
          <div className="relative z-10 max-w-2xl">
            <div className="mb-8 inline-flex items-center gap-2.5 rounded-full border border-[#ddd9ca] bg-white/70 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-[#5e735f]">
              <span className="h-2 w-2 rounded-full bg-[#66866b]" />
              Immigration law, connected to AI
            </div>

            <h1 className="font-serif text-[3.2rem] font-medium leading-[1.04] tracking-[-0.045em] text-[#243a2e] sm:text-6xl lg:text-[4.65rem]">
              Your immigration practice.
              <span className="block italic text-[#8a7048]">
                Connected to AI.
              </span>
            </h1>

            <p className="mt-7 max-w-xl text-base leading-8 text-[#6d7065] sm:text-lg">
              Bring immigration-law research, permitted firm matter context
              and purpose-built legal tools into the AI assistants you already
              use. One connector. Your firm remains in control.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                href="/sign-up"
                className="group inline-flex items-center gap-3 rounded-lg bg-[#29483b] px-6 py-4 text-sm font-semibold text-white shadow-[0_12px_25px_-14px_rgba(41,72,59,0.7)] transition hover:-translate-y-0.5 hover:bg-[#365a49]"
              >
                Start your free trial
                <Arrow />
              </Link>
              <Link
                href="/setup"
                className="group inline-flex items-center gap-3 rounded-lg border border-[#d9d6c9] bg-white/70 px-6 py-4 text-sm font-semibold text-[#455747] transition hover:border-[#a9b39e] hover:bg-white"
              >
                See how it works
                <Arrow diagonal />
              </Link>
            </div>

            <p className="mt-5 text-xs tracking-wide text-[#898a7d]">
              {DEFAULT_TRIAL_DAYS} days free, then {price} per user/month.
            </p>

            <div className="mt-11 flex flex-wrap items-center gap-x-7 gap-y-4 border-t border-[#e2dfd4] pt-7">
              <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#999788]">
                Works with
              </span>
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#e2dfd4] bg-white text-sm font-semibold text-[#354b3d]">
                  C
                </span>
                <span className="text-sm font-semibold text-[#455447]">
                  Claude
                </span>
              </div>
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#e2dfd4] bg-white text-xs font-semibold text-[#354b3d]">
                  AI
                </span>
                <span className="text-sm font-semibold text-[#455447]">
                  ChatGPT
                </span>
              </div>
            </div>
          </div>

          <AssistantPreview />
        </div>
      </section>

      {/* CAPABILITIES */}
      <section id="features" className="border-y border-[#e7e3d8] bg-[#fffdf8]">
        <div className="mx-auto max-w-7xl px-6 py-20 sm:px-8 lg:px-10 lg:py-28">
          <div className="mx-auto mb-14 max-w-2xl text-center">
            <Eyebrow>One connector. Practical capabilities.</Eyebrow>
            <h2 className="mt-5 font-serif text-3xl font-medium leading-tight tracking-tight text-[#293e31] sm:text-5xl">
              Everything closer to the conversation.
            </h2>
            <p className="mt-5 text-sm leading-7 text-[#77776c] sm:text-base">
              Give your AI assistant access to useful legal research and
              approved firm tools, without creating another daily workspace.
            </p>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            {capabilities.map((item) => (
              <article
                key={item.number}
                className="group rounded-xl border border-[#e8e4d9] bg-[#fbfaf5] p-7 transition duration-300 hover:-translate-y-1 hover:border-[#c7cbb9] hover:shadow-[0_22px_50px_-38px_rgba(41,72,59,0.4)] sm:p-9"
              >
                <div className="flex items-center justify-between">
                  <span className="font-serif text-2xl italic text-[#a38b5e]">
                    {item.number}
                  </span>
                  <span className="h-px w-12 bg-[#d9d5c8] transition-all group-hover:w-20 group-hover:bg-[#8a9a80]" />
                </div>
                <h3 className="mt-7 text-xl font-semibold tracking-tight text-[#304637]">
                  {item.title}
                </h3>
                <p className="mt-3 text-sm leading-7 text-[#77776c]">
                  {item.description}
                </p>
                <ul className="mt-6 space-y-3 border-t border-[#e9e5da] pt-5">
                  {item.examples.map((example) => (
                    <li
                      key={example}
                      className="flex items-start gap-3 text-xs leading-6 text-[#626b5e]"
                    >
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#9a865d]" />
                      {example}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how-it-works" className="bg-[#eeeee5]">
        <div className="mx-auto max-w-7xl px-6 py-20 sm:px-8 lg:px-10 lg:py-28">
          <div className="grid gap-14 lg:grid-cols-[0.75fr_1.25fr] lg:gap-24">
            <div className="max-w-md">
              <Eyebrow>A simpler way to work</Eyebrow>
              <h2 className="mt-5 font-serif text-4xl font-medium leading-tight tracking-tight text-[#293e31] sm:text-5xl">
                Your AI assistant. Your tools. Your firm.
              </h2>
              <p className="mt-6 text-sm leading-8 text-[#737568]">
                MeritDesk connects your legal research and approved firm
                resources to your AI assistant. Your team can work in the
                conversation instead of learning another complicated system.
              </p>
              <Link
                href="/setup"
                className="group mt-8 inline-flex items-center gap-3 text-sm font-semibold text-[#405c48] transition hover:text-[#8a7048]"
              >
                Explore the connection guide
                <Arrow />
              </Link>
            </div>

            <ol className="grid gap-3 sm:grid-cols-2">
              {steps.map((step) => (
                <li
                  key={step.number}
                  className="rounded-xl border border-[#dedfd2] bg-[#faf9f3] p-7 sm:p-8"
                >
                  <span className="font-serif text-2xl italic text-[#a38b5e]">
                    {step.number}
                  </span>
                  <h3 className="mt-6 text-base font-semibold text-[#344b39]">
                    {step.title}
                  </h3>
                  <p className="mt-3 text-sm leading-7 text-[#77776c]">
                    {step.description}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* FIRM CONTROL */}
      <section id="security" className="bg-[#29483b] text-[#f8f6f0]">
        <div className="mx-auto grid max-w-7xl items-center gap-12 px-6 py-20 sm:px-8 lg:grid-cols-2 lg:px-10 lg:py-24">
          <div>
            <Eyebrow>Designed around firm control</Eyebrow>
            <h2 className="mt-5 max-w-xl font-serif text-4xl font-medium leading-tight tracking-tight sm:text-5xl">
              Your firm&apos;s access decisions stay with your firm.
            </h2>
          </div>
          <div>
            <p className="text-sm leading-8 text-[#d2d9cf] sm:text-base">
              Different firms have different needs. MeritDesk provides
              firm-managed permissions so owners can decide whether case-work
              access is enabled and which members can use the available tools.
            </p>
            <Link
              href="/sign-up"
              className="group mt-8 inline-flex items-center gap-3 rounded-lg bg-[#f5f1e6] px-6 py-4 text-sm font-semibold text-[#29483b] transition hover:-translate-y-0.5 hover:bg-white"
            >
              Set up your firm
              <Arrow />
            </Link>
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section id="pricing" className="bg-[#f8f6f0]">
        <div className="mx-auto max-w-7xl px-6 py-20 sm:px-8 lg:px-10 lg:py-28">
          <div className="mx-auto max-w-3xl rounded-2xl border border-[#ded9ca] bg-[#fffdf8] px-7 py-12 text-center shadow-[0_25px_70px_-55px_rgba(41,72,59,0.35)] sm:px-14 sm:py-16">
            <Eyebrow>Simple, transparent pricing</Eyebrow>
            <h2 className="mt-5 font-serif text-4xl font-medium tracking-tight text-[#293e31] sm:text-5xl">
              Start with room to explore.
            </h2>
            <p className="mx-auto mt-5 max-w-lg text-sm leading-7 text-[#77776c]">
              Try MeritDesk with your firm, connect your assistant and
              discover how the tools fit your workflow.
            </p>

            <div className="mt-9">
              <span className="font-serif text-6xl font-medium tracking-tight text-[#29483b]">
                {price}
              </span>
              <span className="ml-2 text-sm text-[#858577]">
                per user / month
              </span>
            </div>

            <p className="mt-3 text-sm font-medium text-[#8a7048]">
              {DEFAULT_TRIAL_DAYS}-day free trial
            </p>

            <Link
              href="/sign-up"
              className="group mt-9 inline-flex items-center gap-3 rounded-lg bg-[#29483b] px-7 py-4 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-[#365a49]"
            >
              Get started with MeritDesk
              <Arrow />
            </Link>

            <p className="mt-5 text-xs text-[#999789]">
              Review plan details before subscribing.
            </p>
            <Link
              href="/pricing"
              className="mt-4 inline-block text-xs font-semibold text-[#536c56] underline decoration-[#b8b9a9] underline-offset-4 hover:text-[#8a7048]"
            >
              View full pricing details
            </Link>
          </div>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="border-t border-[#e5e0d4] bg-[#eeeee5]">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-8 px-6 py-14 sm:px-8 md:flex-row md:items-center lg:px-10">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.17em] text-[#8a7048]">
              {PRODUCT_NAME}
            </p>
            <h2 className="mt-3 font-serif text-3xl font-medium text-[#293e31] sm:text-4xl">
              Make your AI assistant work smarter.
            </h2>
          </div>
          <Link
            href="/sign-up"
            className="group inline-flex shrink-0 items-center gap-3 rounded-lg bg-[#29483b] px-6 py-4 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-[#365a49]"
          >
            Create your firm account
            <Arrow />
          </Link>
        </div>
      </section>
    </div>
  );
}
