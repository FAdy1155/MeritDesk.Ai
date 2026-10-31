import Link from "next/link";
import type { Metadata } from "next";
import { PRODUCT_NAME } from "@/lib/billing/config";

export const metadata: Metadata = { title: `Pricing | ${PRODUCT_NAME}` };

const buttonClass = "rounded-md bg-black px-5 py-2.5 text-sm font-medium text-white dark:bg-white dark:text-black";

const QUESTIONS = [
  [
    "What counts as a user?",
    "Every member of the firm in the app, whatever their role (owner, attorney, paralegal, read-only). The seat count follows the members: inviting one adds a seat and removing one removes it, prorated by Stripe on the next invoice.",
  ],
  [
    "Does the free month need a card?",
    "No. The firm gets 30 days free when it is created. The owner can subscribe at any point during the free month; the card is then charged when the free month ends, not before.",
  ],
  [
    "What happens when the free month ends?",
    "Without a subscription, the app and the connector lock. Nothing is deleted: matters, documents and settings are kept, and subscribing unlocks everything at once. The firm's owner gets reminder emails before the end.",
  ],
  [
    "How is it billed?",
    "Monthly, by Stripe, to the firm. It renews automatically and a receipt comes by email after every payment. If a payment fails, the firm keeps full access for a 7 day grace period while Stripe retries and the owner updates the card.",
  ],
  [
    "Can we cancel?",
    "Yes, from the Billing page (Manage billing), at any time. The firm keeps access until the end of the period it has paid for.",
  ],
  [
    "Where do we pay?",
    "Only on this site, through Stripe Checkout and Stripe's billing portal. Claude never asks for payment; when a firm has no subscription, the connector points to the Billing page.",
  ],
] as const;

export default function PricingPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">
      <div className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold">Pricing</h1>
        <p className="text-lg text-black/70 dark:text-white/70">One plan. Every firm&apos;s first 30 days are free.</p>
      </div>

      <section className="flex flex-col gap-4 rounded-lg border border-black/10 p-6 dark:border-white/10" aria-labelledby="plan">
        <h2 id="plan" className="text-xl font-semibold">
          $20 per user per month
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-black/70 dark:text-white/70">
          <li>The connector for Claude (and ChatGPT) for every member</li>
          <li>Matters, clients and documents, with malware scanning and a permanent audit log</li>
          <li>26 immigration skills, run against the matter&apos;s documents and the firm&apos;s practice profile</li>
          <li>The legal library of official sources and the EOIR statistics, refreshed daily</li>
          <li>Seats that follow the firm&apos;s members, automatic renewal, receipts by email</li>
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/sign-up" className={buttonClass}>
            Start free month
          </Link>
          <span className="text-sm text-black/60 dark:text-white/60">No card needed for the free month.</span>
        </div>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="questions">
        <h2 id="questions" className="text-xl font-semibold">
          Questions
        </h2>
        <dl className="flex flex-col gap-4">
          {QUESTIONS.map(([q, a]) => (
            <div key={q} className="flex flex-col gap-1">
              <dt className="font-medium">{q}</dt>
              <dd className="text-sm text-black/70 dark:text-white/70">{a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <p className="text-sm text-black/60 dark:text-white/60">
        Prices are in US dollars and exclude any applicable taxes. The <Link href="/terms" className="underline">terms</Link>{" "}
        and <Link href="/privacy" className="underline">privacy policy</Link> apply.
      </p>
    </div>
  );
}
