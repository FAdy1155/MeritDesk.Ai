import Link from "next/link";
import type { Metadata } from "next";
import { PRODUCT_NAME } from "@/lib/billing/config";

export const metadata: Metadata = { title: `Pricing | ${PRODUCT_NAME}` };

const QUESTIONS = [
  ["What counts as a user?", "Every member of the firm in MeritDesk, whatever their role (owner, attorney, paralegal or read-only). The seat count follows firm membership: inviting a member adds a seat and removing one removes it, prorated by Stripe on the next invoice."],
  ["Does the free month need a card?", "No. The firm gets 30 days free when it is created. The owner can subscribe at any point during the free month; the card is charged when the free month ends, not before."],
  ["What happens when the free month ends?", "Without a subscription, the app and connector lock. Nothing is deleted: matters, documents and settings are kept, and subscribing unlocks everything again. The firm's owner receives reminder emails before the end."],
  ["How is billing handled?", "Monthly, by Stripe, to the firm. It renews automatically and a receipt comes by email after every payment. If a payment fails, the firm keeps full access for a 7-day grace period while Stripe retries and the owner updates the card."],
  ["Can we cancel?", "Yes. Cancel from the Billing page at any time. The firm keeps access until the end of the period it has paid for."],
  ["Where do we pay?", "Only on the MeritDesk website, through Stripe Checkout and Stripe's billing portal. Claude and ChatGPT never collect MeritDesk subscription payments."],
];

const included = [
  "Remote MCP connector for Claude and ChatGPT",
  "Official immigration-law library and EOIR statistics",
  "26 purpose-built immigration legal skills",
  "Firm-controlled access to matters, clients and legal updates",
  "Client and matter creation from supported AI assistants",
  "Secure document storage, malware scanning and processing",
  "Role-based permissions and a permanent audit log",
  "One firm subscription with seats that follow membership",
];

export default function PricingPage() {
  return (
    <div className="bg-[#fbfcfe]">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-14 px-6 py-14 sm:px-8 sm:py-20">
        <header className="mx-auto max-w-3xl text-center">
          <p className="text-[11px] font-bold uppercase tracking-[.2em] text-[#6683b0]">SIMPLE FIRM PRICING</p>
          <h1 className="mt-4 text-4xl font-semibold tracking-[-.045em] text-[#172b49] sm:text-5xl">One plan. Your whole practice.</h1>
          <p className="mt-5 text-base leading-8 text-[#65748a]">Bring MeritDesk into the AI assistant your team already uses. Start with a full 30-day trial—no card required.</p>
        </header>

        <section className="mx-auto grid w-full max-w-4xl overflow-hidden rounded-[26px] border border-[#dfe6ef] bg-white shadow-[0_28px_80px_-48px_rgba(23,42,70,.4)] md:grid-cols-[.85fr_1.15fr]">
          <div className="bg-[linear-gradient(145deg,#17345f,#2c5689)] p-7 text-white sm:p-9">
            <p className="text-[11px] font-bold uppercase tracking-[.18em] text-blue-100/75">MERITDESK.AI</p>
            <p className="mt-8 text-sm font-medium text-blue-100">After your free 30 days</p>
            <div className="mt-2 flex items-end gap-2"><span className="text-5xl font-semibold tracking-tight">$20</span><span className="pb-1 text-sm text-blue-100">/ user / month</span></div>
            <p className="mt-4 text-sm leading-6 text-blue-50/85">Billed monthly to your firm. Automatic renewal, with receipts by email. Cancel any time.</p>
            <Link href="/sign-up" className="mt-8 inline-flex w-full items-center justify-center rounded-xl bg-white px-5 py-3.5 text-sm font-semibold text-[#17345f] transition hover:bg-[#edf3fb]">Start your free month →</Link>
            <p className="mt-3 text-center text-[11px] text-blue-100/75">No credit card required to start.</p>
          </div>
          <div className="p-7 sm:p-9">
            <h2 className="text-lg font-semibold text-[#263b57]">Everything included</h2>
            <p className="mt-1 text-sm leading-6 text-[#8491a3]">One subscription for the firm. No separate MeritDesk charge for each feature.</p>
            <ul className="mt-6 space-y-3">
              {included.map(item => <li key={item} className="flex gap-3 text-sm leading-6 text-[#5f7189]"><span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#edf3fa] text-[11px] font-bold text-[#4773ad]">✓</span>{item}</li>)}
            </ul>
          </div>
        </section>

        <section className="mx-auto w-full max-w-4xl">
          <div className="text-center"><p className="text-[11px] font-bold uppercase tracking-[.2em] text-[#6683b0]">BILLING QUESTIONS</p><h2 className="mt-3 text-3xl font-semibold tracking-[-.04em] text-[#182943]">Good to know</h2></div>
          <div className="mt-8 divide-y divide-[#e7edf2] rounded-2xl border border-[#e7edf2] bg-white px-5 sm:px-7">
            {QUESTIONS.map(([q, a]) => <details key={q} className="group py-5"><summary className="flex cursor-pointer list-none items-center justify-between gap-5 text-left text-sm font-semibold text-[#2b415e]"><span>{q}</span><span className="text-xl font-normal text-[#8192a9] transition group-open:rotate-45">+</span></summary><p className="mt-3 max-w-3xl text-sm leading-7 text-[#748399]">{a}</p></details>)}
          </div>
        </section>

        <p className="mx-auto max-w-3xl text-center text-xs leading-6 text-[#96a1af]">Prices are in US dollars and exclude applicable taxes. Your Claude or ChatGPT subscription, if required by your provider, is separate. The <Link href="/terms" className="underline underline-offset-2">terms</Link> and <Link href="/privacy" className="underline underline-offset-2">privacy policy</Link> apply.</p>
      </div>
    </div>
  );
}
