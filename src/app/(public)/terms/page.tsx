import type { Metadata } from "next";
import { PRODUCT_NAME } from "@/lib/billing/config";

export const metadata: Metadata = { title: `Terms of Service (draft) | ${PRODUCT_NAME}` };

// DRAFT. A placeholder for the firm's attorneys to replace with the final
// terms. It names the points that matter for this product (the free month
// and the subscription, what the connector sends to Anthropic and OpenAI,
// the firm's responsibility for client confidentiality) so nothing is
// forgotten; it is not legal advice and not final.

const sectionClass = "flex flex-col gap-2";
const bodyClass = "text-sm text-black/70 dark:text-white/70";

export default function TermsPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
        <span className="font-semibold">DRAFT.</span> This page is a placeholder for the operator&apos;s attorneys to finalize.
        It lists the points the final terms should cover; it is not the final agreement.
      </div>

      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">Terms of Service</h1>
        <p className={bodyClass}>Draft of [DATE]. Operated by [OPERATOR LEGAL NAME], [ADDRESS]. Contact: [SUPPORT EMAIL].</p>
      </div>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">1. The service</h2>
        <p className={bodyClass}>
          {PRODUCT_NAME} is a web application and a connector for Claude (Anthropic) and ChatGPT (OpenAI) for immigration
          legal work: matters and documents, skills that produce draft work product, and a library of official sources.
          It is a tool for licensed attorneys and the staff they supervise. It does not give legal advice, and every
          output is a draft for an attorney&apos;s review.
        </p>
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">2. Accounts and firms</h2>
        <p className={bodyClass}>
          A firm is created by its owner, who invites members and assigns their roles. The firm is responsible for its
          members&apos; use of the service and for keeping its members&apos; access current (removing those who leave).
        </p>
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">3. Free month, subscription and payment</h2>
        <p className={bodyClass}>
          [DRAFT] Each firm&apos;s first 30 days are free. After that, use of the service requires a subscription of $20
          per user per month, billed monthly in advance to the firm by Stripe, where a user is each member of the
          firm. Seats follow the firm&apos;s members and changes are prorated. The subscription renews automatically
          until canceled; cancellation takes effect at the end of the paid period. When the free month ends without a
          subscription, or a subscription ends or goes unpaid after a 7 day grace period, the firm&apos;s access to the
          app and the connector is locked until it subscribes. Fees exclude taxes. [Refund policy: TO BE DECIDED.]
        </p>
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">4. Client data and the connector</h2>
        <p className={bodyClass}>
          [DRAFT] When a member uses the connector&apos;s case-work tools in Claude or ChatGPT, the data those tools
          return (matter details, party names, document names, skill run reports written from client documents) is
          placed in that member&apos;s Claude or ChatGPT conversation, where it is held by Anthropic or OpenAI under
          the terms and retention of the member&apos;s account with them, not under these terms. Skill runs started in
          the app send the matter&apos;s documents to Anthropic&apos;s API under the operator&apos;s agreement with
          Anthropic [state the retention terms, e.g. zero data retention, once confirmed]. The firm decides whether to
          turn the case-work tools on, after reading the disclosure on the Firm page, and remains responsible for its
          duties of confidentiality to its clients, including any client consent its rules require.
        </p>
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">5. Acceptable use</h2>
        <p className={bodyClass}>
          [DRAFT] Use the service only for lawful immigration legal work; do not upload malware, attempt to access
          another firm&apos;s data, or resell the service. The operator may suspend access for abuse.
        </p>
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">6. Warranties, liability and termination</h2>
        <p className={bodyClass}>
          [DRAFT] The service is provided as is; outputs may contain errors and must be reviewed by an attorney.
          [Limitation of liability, indemnity, governing law and venue: TO BE DRAFTED.] Either party may end the
          subscription as described in section 3; the operator may terminate for breach. On termination the firm may
          export its data for [PERIOD], after which it is deleted.
        </p>
      </section>
    </div>
  );
}
