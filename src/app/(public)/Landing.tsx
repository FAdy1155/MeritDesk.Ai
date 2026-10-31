import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/billing/config";

// The public landing page, shown at "/" to visitors without a session
// (src/app/(app)/layout.tsx). What the product is, how the connector works
// in Claude, the four steps from signing up to subscribing, and the price.

const buttonClass = "rounded-md bg-black px-5 py-2.5 text-sm font-medium text-white dark:bg-white dark:text-black";
const secondaryButtonClass = "rounded-md border border-black/15 px-5 py-2.5 text-sm font-medium dark:border-white/20";
const cardClass = "flex flex-col gap-2 rounded-lg border border-black/10 p-4 dark:border-white/10";

const STEPS = [
  ["Sign up on MeritDesk.AI", "Create your account and your firm in a minute. You become the firm's owner and can invite your attorneys and paralegals."],
  ["Add the connector to Claude", "Paste the firm's connector address into Claude under Connectors and sign in. Each member connects with their own account; the Connect page walks through it for Claude and ChatGPT."],
  ["Use it free for 30 days", "Every firm's first 30 days are free, with everything on: matters, documents, the 26 skills and the legal library."],
  ["Subscribe here", "$20 per user per month, paid on this site. It renews automatically, seats follow your members, and receipts come by email."],
] as const;

export function Landing() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-14">
      <section className="flex flex-col gap-5">
        <h1 className="text-3xl font-semibold leading-tight sm:text-4xl">
          {PRODUCT_NAME} makes Claude smarter for immigration legal work.
        </h1>
        <p className="max-w-2xl text-lg text-black/70 dark:text-white/70">
          A connector that immigration attorneys and paralegals add to Claude, backed by a web app that holds your
          firm&apos;s matters and documents, 26 immigration skills, and a library of official immigration-law sources.
          Ask Claude about a matter, run a skill on it, or cite the law from the library, all from the chat.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/sign-up" className={buttonClass}>
            Start free month
          </Link>
          <Link href="/pricing" className={secondaryButtonClass}>
            See pricing
          </Link>
          <span className="text-sm text-black/60 dark:text-white/60">30 days free, then $20 per user per month.</span>
        </div>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="how-it-works">
        <h2 id="how-it-works" className="text-xl font-semibold">
          How it works
        </h2>
        <ol className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {STEPS.map(([title, text], i) => (
            <li key={title} className={cardClass}>
              <span className="text-sm font-medium text-black/60 dark:text-white/60">Step {i + 1}</span>
              <h3 className="font-semibold">{title}</h3>
              <p className="text-sm text-black/70 dark:text-white/70">{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="what-you-get">
        <h2 id="what-you-get" className="text-xl font-semibold">
          What your firm gets
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className={cardClass}>
            <h3 className="font-semibold">Matters and documents</h3>
            <p className="text-sm text-black/70 dark:text-white/70">
              Clients, matters and their documents, scanned for malware and read for text, with every action in an
              audit log the firm keeps.
            </p>
          </div>
          <div className={cardClass}>
            <h3 className="font-semibold">26 immigration skills</h3>
            <p className="text-sm text-black/70 dark:text-white/70">
              Claim evaluation, declaration and brief drafting, packet review and build, interview prep, bench memos
              and more, each run against the matter&apos;s documents and your firm&apos;s practice profile.
            </p>
          </div>
          <div className={cardClass}>
            <h3 className="font-semibold">The legal library</h3>
            <p className="text-sm text-black/70 dark:text-white/70">
              Official sources, collected from the government and court sites and refreshed daily: BIA and AG
              precedents, statutes and regulations, agency manuals, country conditions reports, EOIR statistics.
            </p>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="in-claude">
        <h2 id="in-claude" className="text-xl font-semibold">
          How the connector works in Claude
        </h2>
        <div className="flex flex-col gap-3 text-sm text-black/70 dark:text-white/70">
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
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-black/10 p-6 dark:border-white/10" aria-labelledby="pricing-summary">
        <h2 id="pricing-summary" className="text-xl font-semibold">
          30 days free, then $20 per user per month
        </h2>
        <p className="text-sm text-black/70 dark:text-white/70">
          Every firm starts with a free month, no card needed. After that, each member of the firm is one seat at $20
          a month, billed to the firm by Stripe, renewed automatically, with a receipt by email after every payment.
          Cancel at any time from the Billing page; the firm keeps access until the end of the period it paid for.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/sign-up" className={buttonClass}>
            Start free month
          </Link>
          <Link href="/pricing" className="text-sm underline">
            Pricing details
          </Link>
        </div>
      </section>
    </div>
  );
}
