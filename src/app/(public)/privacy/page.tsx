import type { Metadata } from "next";
import { PRODUCT_NAME } from "@/lib/billing/config";

export const metadata: Metadata = { title: `Privacy Policy (draft) | ${PRODUCT_NAME}` };

// DRAFT. A placeholder for the firm's attorneys to replace with the final
// policy. It names the data flows that matter for this product so the
// final text covers them: client data to Anthropic when case tools are used
// in Claude (and to OpenAI from ChatGPT), retention by those providers under
// their terms, the operator's own processors, and the firm's responsibility
// for confidentiality. Not legal advice and not final.

const sectionClass = "flex flex-col gap-2";
const bodyClass = "text-sm text-black/70 dark:text-white/70";

export default function PrivacyPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
        <span className="font-semibold">DRAFT.</span> This page is a placeholder for the operator&apos;s attorneys to finalize.
        It lists the data flows the final policy must describe; it is not the final policy.
      </div>

      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">Privacy Policy</h1>
        <p className={bodyClass}>Draft of [DATE]. Operated by [OPERATOR LEGAL NAME]. Contact: [PRIVACY EMAIL].</p>
      </div>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">1. What the app holds</h2>
        <p className={bodyClass}>
          Account data (name, email address, firm membership and role, through Clerk, the sign-in service); the
          firm&apos;s data (matters, client records, uploaded documents and their extracted text, skill run reports,
          practice profile, firm identity, audit log); billing data (the firm&apos;s Stripe customer and subscription
          ids, seat count and status; card details are held by Stripe, never by the app); and emails the app sent the
          firm&apos;s owners (kind and date only; addresses are read from Clerk when sending and not stored).
        </p>
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">2. Client data and the AI providers</h2>
        <p className={bodyClass}>
          [DRAFT] Client data flows to Anthropic in two ways. First, skill runs started in the app send the
          matter&apos;s documents and the firm&apos;s practice profile to Anthropic&apos;s API under the
          operator&apos;s agreement with Anthropic [state the retention terms once confirmed, e.g. zero data
          retention]. Second, when a member uses the connector&apos;s case-work tools in Claude, the data those tools
          return (matter details, party names, document names, skill run reports written from client documents, with
          A-numbers and dates of birth redacted where the app finds them) is placed in that member&apos;s Claude
          conversation, where Anthropic retains it under the terms of the member&apos;s own Claude account, which the
          operator does not control; the same applies to ChatGPT and OpenAI. The firm chooses whether to turn the
          case-work tools on, after reading the disclosure on the Firm page, and remains responsible for its duties of
          confidentiality to its clients.
        </p>
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">3. Processors</h2>
        <p className={bodyClass}>
          [DRAFT] Clerk (sign-in and firms), Neon (database), Amazon Web Services (document storage in S3, email through
          SES), Anthropic (the model, as above), Stripe (payments), Fly.io (hosting), Cloudflare (DNS and protection in
          front of the app). [List their roles and data locations in the final policy.]
        </p>
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">4. Retention and deletion</h2>
        <p className={bodyClass}>
          [DRAFT] The firm&apos;s data is kept while the firm has an account and for [PERIOD] after it ends, then
          deleted. The audit log is append-only and kept for the life of the firm. Data held by Anthropic or OpenAI
          through a member&apos;s own Claude or ChatGPT account is governed by that provider&apos;s retention, not
          this policy.
        </p>
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">5. Security</h2>
        <p className={bodyClass}>
          [DRAFT] Data is encrypted in transit and at rest; each firm&apos;s data is isolated by application checks and
          database row-level security; uploads are scanned for malware; access by the operator is limited to what
          running the service requires. [Incident response and breach notification: TO BE DRAFTED.]
        </p>
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">6. Emails</h2>
        <p className={bodyClass}>
          The app emails the firm&apos;s owners about the account only: the welcome, reminders about the free month,
          subscription confirmations, receipts, failed payments and renewals. It sends no marketing email.
        </p>
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">7. Your rights and contact</h2>
        <p className={bodyClass}>[DRAFT] Access, correction, export and deletion requests go to [PRIVACY EMAIL]. [Jurisdiction-specific rights: TO BE DRAFTED.]</p>
      </section>
    </div>
  );
}
