import Link from "next/link";
import { headers } from "next/headers";
import { PRODUCT_NAME, formatDay } from "@/lib/billing/config";
import { getEntitlement } from "@/lib/billing/entitlement";
import { getConnectorSettings } from "@/lib/connector/settings";
import { CONNECTOR_SETTINGS_ROLES, getCurrentTenant, hasRole } from "@/lib/tenant";
import { connectorResourceUrl, resolveConnectorOrigin } from "@/services/connector/config";
import { CopyField } from "./CopyField";

const sectionClass = "rounded-2xl border border-[#e4eaf1] bg-white p-5 shadow-[0_8px_30px_-25px_rgba(22,43,72,.2)] sm:p-7";
const stepsClass = "mt-4 list-decimal space-y-3 pl-5 text-sm leading-7 text-[#64758c] marker:font-semibold marker:text-[#5578a8]";

export default async function ConnectPage() {
  const { tenant, membership } = await getCurrentTenant();
  const [entitlement, settings] = await Promise.all([getEntitlement(tenant.id), getConnectorSettings(tenant.id)]);
  const { origin } = resolveConnectorOrigin(await headers());
  const serverUrl = origin ? connectorResourceUrl(origin) : null;
  const canManageConnector = hasRole(membership, CONNECTOR_SETTINGS_ROLES);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-7">
      <header className="border-b border-[#e6ebf1] pb-6">
        <p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#7890b2]">AI WORKFLOW</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[#1b2e49]">Connect your AI assistant</h1>
        <p className="mt-2 max-w-2xl text-sm leading-7 text-[#7b899d]">{PRODUCT_NAME} works with Claude and ChatGPT through a secure MCP connector. Each member of {tenant.name} connects with their own sign-in. The legal library is available to everyone; the firm&apos;s matters, documents and skills are available when the owner enables case-work access.</p>
      </header>

      <section className="overflow-hidden rounded-2xl border border-[#dce5f0] bg-[linear-gradient(120deg,#f8fafd,#eef3fa)] p-5 sm:p-7" aria-labelledby="connector-address">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-[#7189aa]">STEP 01 · START HERE</p><h2 id="connector-address" className="mt-2 text-lg font-semibold text-[#263b57]">Your firm&apos;s connector address</h2></div><span className="rounded-full border border-[#dce8df] bg-white px-3 py-1 text-[10px] font-medium text-[#477455]">Secure sign-in</span></div>
        <div className="mt-5">{serverUrl ? <CopyField value={serverUrl} label="Connector address" /> : <p className="rounded-xl border border-red-200 bg-white p-4 text-sm text-red-700">Not available yet: the server&apos;s public address (CONNECTOR_PUBLIC_ORIGIN) is not configured. Ask the platform's operator.</p>}</div>
        <p className="mt-3 text-xs leading-5 text-[#7d8ba0]">Copy this address into the custom connector setup in Claude or ChatGPT. Leave OAuth client ID and client secret fields empty; sign-in is handled by {PRODUCT_NAME}.</p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className={sectionClass} aria-labelledby="claude-personal">
          <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#f0f2f6] text-sm font-semibold text-[#33445e]">C</span><div><p className="text-[10px] font-bold uppercase tracking-[.15em] text-[#8a98aa]">PERSONAL PLANS</p><h2 id="claude-personal" className="text-base font-semibold text-[#293f5c]">Claude Free, Pro or Max</h2></div></div>
          <ol className={stepsClass}><li>Open Claude at claude.ai or in the desktop app, then go to Settings → Connectors.</li><li>Choose Add custom connector, name it {PRODUCT_NAME}, and paste the address above.</li><li>Choose Connect. Sign in to {PRODUCT_NAME}, select {tenant.name} on the consent screen and allow access.</li><li>In a chat, open the + menu → Connectors and turn {PRODUCT_NAME} on. Ask Claude to search the library, list matters or run a skill.</li></ol>
        </section>
        <section className={sectionClass} aria-labelledby="claude-team">
          <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#f0f2f6] text-sm font-semibold text-[#33445e]">C</span><div><p className="text-[10px] font-bold uppercase tracking-[.15em] text-[#8a98aa]">TEAM WORKSPACES</p><h2 id="claude-team" className="text-base font-semibold text-[#293f5c]">Claude Team or Enterprise</h2></div></div>
          <ol className={stepsClass}><li>A Claude organization Owner adds the connector once: Organization settings → Connectors → Add → Custom → Web.</li><li>Each member connects under Customize → Connectors, signs in to {PRODUCT_NAME}, selects {tenant.name} and allows access.</li><li>In a chat, turn the connector on from the + menu under Connectors.</li></ol>
        </section>
        <section className={sectionClass} aria-labelledby="chatgpt">
          <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#eaf3ef] text-sm font-semibold text-[#39765e]">AI</span><div><p className="text-[10px] font-bold uppercase tracking-[.15em] text-[#8a98aa]">CUSTOM MCP CONNECTOR</p><h2 id="chatgpt" className="text-base font-semibold text-[#293f5c]">ChatGPT</h2></div></div>
          <ol className={stepsClass}><li>Open ChatGPT settings and find the connector or custom MCP server option. A Business or Enterprise workspace admin may first need to allow custom MCP servers.</li><li>Add a custom server, paste the address above and choose OAuth authentication.</li><li>Review the permissions, continue, then sign in to {PRODUCT_NAME}, select {tenant.name} and allow access.</li><li>In a chat, select the connector from the tools menu or with @. Deep research can use its search and fetch tools.</li></ol>
        </section>
        <section className={sectionClass} aria-labelledby="what-next">
          <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#edf2fa] text-sm font-semibold text-[#41699f]">✓</span><div><p className="text-[10px] font-bold uppercase tracking-[.15em] text-[#8a98aa]">AFTER CONNECTING</p><h2 id="what-next" className="text-base font-semibold text-[#293f5c]">A few things to know</h2></div></div>
          <ul className="mt-4 space-y-3 text-sm leading-6 text-[#64758c]">
            <li className="flex gap-2"><span className="text-[#5c7fae]">•</span><span>{entitlement.state === "trialing" ? tenant.name + "'s free month runs until " + (entitlement.trialEndsAt ? formatDay(entitlement.trialEndsAt) : "its last day") + ". Everything is on during it." : entitlement.state === "active" ? tenant.name + " is subscribed; the subscription renews automatically and receipts come by email." : tenant.name + "'s free month has ended; subscribing on the Billing page unlocks the app and connector."}</span></li>
            <li className="flex gap-2"><span className="text-[#5c7fae]">•</span><span>After the free month it is $20 per user per month. Billing happens on this site, never inside Claude or ChatGPT. Manage it on the <Link href="/billing" className="font-semibold text-[#416da5] hover:underline">Billing page</Link>.</span></li>
            <li className="flex gap-2"><span className="text-[#5c7fae]">•</span><span>Case-work tools are currently <strong className="font-semibold text-[#344b66]">{settings.caseWorkActive ? "on" : "off"}</strong> for {tenant.name}. {canManageConnector ? "You can change this on the Firm page after reading the disclosure." : "The firm&apos;s owner controls this setting on the Firm page."} The legal library tools are always on.</span></li>
            <li className="flex gap-2"><span className="text-[#5c7fae]">•</span><span>A new Claude or ChatGPT client may initially see library tools only until the platform recognizes it. The <Link href="/firm" className="font-semibold text-[#416da5] hover:underline">Firm page</Link> explains this and lists unrecognized clients.</span></li>
            <li className="flex gap-2"><span className="text-[#5c7fae]">•</span><span>Before using real matters, add your letterhead and attorneys on the Firm page, complete the practice profile and invite your staff.</span></li>
          </ul>
        </section>
      </div>
      <aside className="rounded-2xl border border-[#e4eaf1] bg-white p-5 sm:p-6"><h2 className="text-sm font-semibold text-[#30445f]">Understand case-work access</h2><p className="mt-2 text-sm leading-6 text-[#7b899d]">When case-work tools are enabled, information returned from a matter becomes part of the conversation in your AI provider and is subject to that provider's terms. Your firm controls whether these tools are enabled. Review the disclosure on the <Link href="/firm" className="font-semibold text-[#416da5] hover:underline">Firm settings page</Link> before turning them on. Every case-work connector call is recorded in the firm&apos;s audit log.</p></aside>
    </div>
  );
}
