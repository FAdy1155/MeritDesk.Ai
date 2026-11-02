import Link from "next/link";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { PRODUCT_NAME } from "@/lib/billing/config";
import { connectorResourceUrl, resolveConnectorOrigin } from "@/services/connector/config";
import { CopyField } from "@/app/(app)/connect/CopyField";

export const metadata: Metadata = {
  title: `Connect Claude or ChatGPT | ${PRODUCT_NAME}`,
  description: "Step-by-step instructions for connecting MeritDesk.AI to Claude or ChatGPT with a secure remote MCP connection.",
};

const cardClass = "rounded-2xl border border-[#e4eaf1] bg-white p-6 sm:p-7";
const stepClass = "mt-4 list-decimal space-y-3 pl-5 text-sm leading-7 text-[#64758c] marker:font-semibold marker:text-[#5578a8]";

export default async function SetupGuidePage() {
  const { origin } = resolveConnectorOrigin(await headers());
  const serverUrl = origin ? connectorResourceUrl(origin) : null;

  return (
    <div className="bg-[#fbfcfe]">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-12 sm:px-8 sm:py-16">
        <header className="max-w-3xl">
          <p className="text-[11px] font-bold uppercase tracking-[.18em] text-[#6683b0]">GET CONNECTED</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-.045em] text-[#172b49] sm:text-5xl">Put MeritDesk inside your AI assistant.</h1>
          <p className="mt-5 text-base leading-8 text-[#65748a]">MeritDesk is a remote MCP connector. Add it once to Claude or ChatGPT, sign in with your MeritDesk account, and use the tools from a normal conversation. Nothing to install on your computer.</p>
        </header>

        <section className="rounded-2xl border border-[#dce5f0] bg-[linear-gradient(120deg,#f8fafd,#eef3fa)] p-5 sm:p-7">
          <p className="text-[10px] font-bold uppercase tracking-[.16em] text-[#7189aa]">YOUR MERITDESK SERVER ADDRESS</p>
          <h2 className="mt-2 text-lg font-semibold text-[#263b57]">Copy this into your assistant</h2>
          <div className="mt-4">{serverUrl ? <CopyField value={serverUrl} label="MeritDesk MCP server URL" /> : <p className="rounded-xl border border-red-200 bg-white p-4 text-sm text-red-700">The connector address is not configured. Please contact MeritDesk support.</p>}</div>
          <p className="mt-3 text-xs leading-5 text-[#7d8ba0]">Use OAuth authentication. Leave client ID and client secret blank unless MeritDesk support tells you otherwise.</p>
        </section>

        <section className={cardClass}>
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#f0f2f6] text-sm font-semibold text-[#33445e]">C</span>
            <div><p className="text-[10px] font-bold uppercase tracking-[.15em] text-[#8a98aa]">CLAUDE</p><h2 className="text-xl font-semibold text-[#293f5c]">Connect Claude</h2></div>
          </div>
          <p className="mt-3 text-sm leading-6 text-[#64758c]">Custom remote MCP connectors are available on Claude Pro, Max, Team and Enterprise plans. Claude Free does not currently support this custom connector workflow.</p>
          <ol className={stepClass}>
            <li>Open Claude on the web or desktop, then go to <strong>Settings → Connectors</strong>.</li>
            <li>Under Connectors, choose <strong>Add custom connector</strong>.</li>
            <li>Enter <strong>MeritDesk.AI</strong> as the name and paste the server address above, then choose Add.</li>
            <li>Choose Connect. Sign in to MeritDesk, select your firm and review the authorization request.</li>
            <li>Start a chat. Open <strong>Search and tools</strong>, enable MeritDesk and ask your first question.</li>
          </ol>
          <div className="mt-5 rounded-xl bg-[#f7f9fc] p-4 text-xs leading-6 text-[#748399]">
            <strong className="text-[#405a7b]">Claude Team or Enterprise:</strong> an organization Owner or Primary Owner may need to add MeritDesk under Settings → Connectors → Organization connectors first. Each member then connects with their own MeritDesk account.
          </div>
        </section>

        <section className={cardClass}>
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#eaf3ef] text-sm font-semibold text-[#39765e]">AI</span>
            <div><p className="text-[10px] font-bold uppercase tracking-[.15em] text-[#8a98aa]">CHATGPT</p><h2 className="text-xl font-semibold text-[#293f5c]">Connect ChatGPT</h2></div>
          </div>
          <p className="mt-3 text-sm leading-6 text-[#64758c]">For the full MeritDesk experience—including creating client and matter records and running skills—use ChatGPT Business, Enterprise or Edu. ChatGPT Pro currently supports custom MCP connections with read/fetch permissions only. It may use read-only matter tools when your firm and client connection allow them, but it cannot create records, queue skills or issue document download links.</p>
          <ol className={stepClass}>
            <li>Open ChatGPT on the web and go to <strong>Plugins</strong>.</li>
            <li>Select the <strong>+</strong> button, then choose <strong>Add custom MCP server</strong>.</li>
            <li>Name it <strong>MeritDesk.AI</strong>. Paste the server address above into the public HTTPS endpoint field.</li>
            <li>Choose OAuth authentication, review the risk warning and acknowledge it.</li>
            <li>Choose <strong>Create as a plugin</strong>. Complete the MeritDesk sign-in and review the tools ChatGPT discovers.</li>
            <li>Start a new conversation, select MeritDesk from the available plugins/apps or use <strong>@MeritDesk.AI</strong>, then ask it to perform a task. Confirm any action when ChatGPT asks.</li>
          </ol>
          <div className="mt-5 rounded-xl bg-[#fff8ed] p-4 text-xs leading-6 text-[#856a42]">
            <strong>Workspace permissions:</strong> ChatGPT Business, Enterprise and Edu workspaces may require an Admin or Owner to allow custom MCP connections and publish the plugin for members. If you cannot add a server, ask your workspace administrator.
          </div>
        </section>

        <section className={cardClass}>
          <p className="text-[10px] font-bold uppercase tracking-[.16em] text-[#91a0b4]">AFTER YOU CONNECT</p>
          <h2 className="mt-2 text-xl font-semibold text-[#293f5e]">Your first MeritDesk prompts</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {[
              "Search the immigration law library for the current authority on this issue and link each source to its official copy.",
              "List my firm's matters and show the case type, status and next hearing date.",
              "Create a client record for [name]. Ask me for missing details and confirm the exact information before saving.",
              "Show me the skills available for this matter and explain which one is appropriate for this task.",
            ].map((prompt) => <div key={prompt} className="rounded-xl bg-[#f7f9fc] p-4 text-sm leading-6 text-[#536780]">“{prompt}”</div>)}
          </div>
          <div className="mt-5 border-t border-[#e9edf2] pt-5">
            <h3 className="text-sm font-semibold text-[#304967]">If you only see legal-library tools</h3>
            <p className="mt-1 text-sm leading-6 text-[#748399]">Your firm&apos;s owner may still need to enable case-work access after reviewing the disclosure. MeritDesk also makes case-work tools available only to recognized AI clients. Ask your firm&apos;s owner to check the Firm & Permissions page if the tools do not appear.</p>
          </div>
        </section>

        <section className="rounded-2xl border border-[#e4eaf1] bg-white p-6 sm:p-7">
          <h2 className="text-lg font-semibold text-[#293f5e]">A note about documents and client privacy</h2>
          <p className="mt-2 text-sm leading-7 text-[#748399]">Create clients and matters from the assistant when case-work access is enabled. Upload original files through the secure MeritDesk matter portal; files are malware-scanned and processed before they can be used by eligible skills. When case-work tools are enabled, any client or matter information returned to the assistant becomes part of that AI provider&apos;s conversation and is subject to that provider&apos;s terms. Review your firm&apos;s disclosure before using real client data.</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link href="/sign-up" className="inline-flex items-center rounded-xl bg-[#17345f] px-5 py-3 text-sm font-semibold text-white hover:bg-[#244779]">Start your free month →</Link>
            <Link href="/pricing" className="inline-flex items-center rounded-xl border border-[#d8e0eb] px-5 py-3 text-sm font-semibold text-[#344966] hover:bg-[#f7f9fc]">View pricing</Link>
          </div>
        </section>
      </div>
    </div>
  );
}
