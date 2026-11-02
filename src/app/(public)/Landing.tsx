import Link from "next/link";

const capabilities = [
  {
    number: "01",
    title: "Research immigration law",
    description: "Search official decisions, statutes, regulations, agency manuals and guidance. Retrieve source text and give your assistant official links to cite.",
    examples: ["Find BIA decisions on particular hardship factors", "Check the current text of an INA section", "Research USCIS policy and agency guidance"],
  },
  {
    number: "02",
    title: "Work with firm matters",
    description: "When your firm enables case-work access, your assistant can inspect matter details, parties, document lists, legal updates and prior skill runs.",
    examples: ["Summarize the status of a matter", "Review which evidence files are available", "Find legal updates the team has not reviewed"],
  },
  {
    number: "03",
    title: "Run purpose-built legal skills",
    description: "Choose from 26 immigration-focused skills for review, drafting, research and case preparation. Runs happen in the background and return a report.",
    examples: ["Review a case for issues and missing evidence", "Prepare a draft using the matter context", "Check the report and escalation flags"],
  },
  {
    number: "04",
    title: "Keep the firm in control",
    description: "Every member connects with their own sign-in. Firm owners control case-work access, roles and document-download permissions.",
    examples: ["Individual OAuth sign-in", "Role-based access to tools", "Audited case-work activity"],
  },
];

const prompts = [
  "Find the controlling BIA and circuit authority on this issue, and link every source to its official copy.",
  "List the matters my firm is handling and identify any upcoming hearing dates.",
  "Show me the skills available for this matter and explain which one fits the task.",
  "Run the selected case-review skill on this matter. First explain what it will do and ask me to confirm.",
];

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-4 w-4">
      {diagonal
        ? <path d="M5 15 15 5M6 5h9v9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        : <path d="M3.5 10h12m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

function AssistantPreview() {
  return (
    <div className="relative mx-auto w-full max-w-[620px] lg:ml-auto">
      <div aria-hidden="true" className="absolute -inset-10 -z-10 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(83,126,190,.2),transparent_68%)] blur-2xl" />
      <div className="overflow-hidden rounded-[24px] border border-[#dfe6ef] bg-white shadow-[0_35px_100px_-42px_rgba(23,42,70,.42)]">
        <div className="flex items-center justify-between border-b border-[#e9edf2] bg-[#fbfcfe] px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#17345f] text-sm font-semibold text-white">M</span>
            <div><p className="text-sm font-semibold tracking-tight text-[#1b2e49]">MeritDesk.AI connector</p><p className="text-[11px] text-[#8491a3]">Illustrative assistant workflow</p></div>
          </div>
          <span className="rounded-full border border-[#dce8df] bg-[#f2f8f3] px-3 py-1 text-[10px] font-medium text-[#477455]">Remote MCP</span>
        </div>
        <div className="space-y-5 p-5 sm:p-7">
          <div className="ml-auto max-w-[88%] rounded-2xl rounded-tr-md bg-[#edf3fb] px-4 py-3.5 text-sm leading-6 text-[#2e496c]">
            Research the current law on this immigration issue. Find relevant BIA decisions and official agency guidance.
          </div>
          <div className="max-w-[94%] rounded-2xl rounded-tl-md border border-[#e8edf2] bg-white px-4 py-4">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.13em] text-[#8795a8]"><span className="h-1.5 w-1.5 rounded-full bg-[#5b83c6]" />MeritDesk tools used</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {["search_library", "fetch", "lookup_library_citation"].map(x => <code key={x} className="rounded-lg bg-[#f4f6f9] px-2.5 py-1.5 text-[10px] text-[#536b8b]">{x}</code>)}
            </div>
            <p className="mt-4 text-sm leading-6 text-[#52647b]">The assistant searches MeritDesk&apos;s collected immigration-law sources, reads relevant material and prepares an answer with links to the official sources.</p>
            <div className="mt-4 space-y-2">
              <div className="rounded-xl border border-[#e8edf2] p-3"><p className="text-xs font-semibold text-[#304967]">Relevant decision · BIA</p><p className="mt-1 text-[11px] leading-5 text-[#7b899c]">Source title and citation appear here, linked to the official decision.</p></div>
              <div className="rounded-xl border border-[#e8edf2] p-3"><p className="text-xs font-semibold text-[#304967]">Agency authority · USCIS</p><p className="mt-1 text-[11px] leading-5 text-[#7b899c]">Relevant policy section appears with its official source link.</p></div>
            </div>
          </div>
          <p className="text-center text-[10px] text-[#9aa5b3]">Illustrative interaction · Not a real legal result or client matter</p>
        </div>
      </div>
    </div>
  );
}

function AssistantMark({ label }: { label: string }) {
  return <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#e4eaf1] bg-white text-sm font-semibold text-[#314a6b] shadow-sm">{label}</span>;
}

export function Landing() {
  return (
    <div className="overflow-hidden bg-[#fbfcfd] text-[#192b43]">
      <section className="relative isolate">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_78%_30%,rgba(220,231,246,.78),transparent_42%),linear-gradient(180deg,#fcfdff_0%,#f7f9fc_100%)]" />
        <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 pb-24 pt-16 sm:px-8 sm:pt-20 lg:grid-cols-[.92fr_1.08fr] lg:gap-12 lg:px-10 lg:pb-32 lg:pt-24">
          <div className="relative z-10 max-w-2xl">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[#dce5f0] bg-white/90 px-3.5 py-2 text-[11px] font-semibold tracking-wide text-[#496b9e] shadow-sm"><span className="h-1.5 w-1.5 rounded-full bg-[#5b83c6]" />Immigration law, inside your AI assistant</div>
            <h1 className="text-[2.8rem] font-semibold leading-[1.04] tracking-[-.055em] text-[#142641] sm:text-6xl lg:text-[4.25rem]">Your immigration law toolkit. Right inside Claude and ChatGPT.</h1>
            <p className="mt-7 max-w-xl text-base leading-8 text-[#65748a] sm:text-lg">Research official immigration-law sources, bring your firm&apos;s matter context into the conversation, and run purpose-built legal skills—all through one secure MeritDesk connector.</p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link href="/sign-up" className="group inline-flex items-center gap-3 rounded-xl bg-[#17345f] px-6 py-3.5 text-sm font-semibold text-white shadow-[0_12px_25px_-12px_rgba(23,52,95,.65)] transition hover:-translate-y-0.5 hover:bg-[#214779]">Start your 30-day free trial <Arrow /></Link>
              <Link href="/setup" className="inline-flex items-center gap-2 rounded-xl border border-[#d8e0eb] bg-white px-6 py-3.5 text-sm font-semibold text-[#344966] transition hover:border-[#aebed4] hover:bg-[#f7f9fc]">See how to connect <Arrow diagonal /></Link>
            </div>
            <p className="mt-4 text-xs font-medium tracking-wide text-[#8996a8]">No credit card for the first 30 days. $20 per user/month after trial.</p>
            <div className="mt-10 flex flex-wrap items-center gap-4 border-t border-[#e7ebf1] pt-6">
              <span className="text-[11px] font-medium text-[#77869b]">Works with</span>
              <div className="flex items-center gap-2"><AssistantMark label="C" /><span className="text-sm font-semibold text-[#344966]">Claude</span></div>
              <div className="flex items-center gap-2"><AssistantMark label="AI" /><span className="text-sm font-semibold text-[#344966]">ChatGPT</span></div>
              <span className="text-[10px] text-[#9aa5b3]">via secure custom MCP connection</span>
            </div>
          </div>
          <AssistantPreview />
        </div>
      </section>

      <section id="features" className="border-y border-[#e9edf3] bg-white">
        <div className="mx-auto max-w-7xl px-6 py-20 sm:px-8 lg:px-10 lg:py-24">
          <div className="mx-auto mb-12 max-w-2xl text-center"><p className="text-[11px] font-bold uppercase tracking-[.2em] text-[#6683b0]">What your assistant can do</p><h2 className="mt-4 text-3xl font-semibold tracking-[-.04em] text-[#182943] sm:text-4xl">A focused legal toolkit, available in the conversation.</h2><p className="mt-4 text-sm leading-7 text-[#77859a]">MeritDesk connects your AI assistant to legal sources and, when your firm enables it, approved case-work tools.</p></div>
          <div className="grid gap-4 md:grid-cols-2">
            {capabilities.map(f => <article key={f.number} className="rounded-2xl border border-[#e7ebf1] bg-[#fcfdff] p-7 transition duration-300 hover:-translate-y-1 hover:border-[#cbd8ea] hover:shadow-[0_20px_45px_-32px_rgba(30,57,96,.3)]"><div className="flex items-center justify-between"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#edf2fa] text-lg text-[#42689f]">{f.number}</span><span className="text-[10px] font-semibold uppercase tracking-[.14em] text-[#a6b1c0]">MeritDesk toolset</span></div><h3 className="mt-6 text-lg font-semibold tracking-tight text-[#203550]">{f.title}</h3><p className="mt-3 text-sm leading-7 text-[#758399]">{f.description}</p><ul className="mt-5 space-y-2 border-t border-[#e9edf2] pt-4">{f.examples.map(x => <li key={x} className="flex gap-2 text-xs leading-5 text-[#63758d]"><span className="text-[#5277ad]">↗</span>{x}</li>)}</ul></article>)}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="bg-[#f5f7fa]">
        <div className="mx-auto max-w-7xl px-6 py-20 sm:px-8 lg:px-10 lg:py-24">
          <div className="grid gap-12 lg:grid-cols-[.72fr_1.28fr] lg:gap-20">
            <div><p className="text-[11px] font-bold uppercase tracking-[.2em] text-[#6683b0]">Connect once. Work in your AI.</p><h2 className="mt-4 text-3xl font-semibold tracking-[-.04em] text-[#182943] sm:text-4xl">No new workspace to learn.</h2><p className="mt-5 max-w-sm text-sm leading-7 text-[#77859a]">MeritDesk is a secure connector—not another place where your team has to conduct its daily work.</p><Link href="/connect" className="mt-8 inline-flex items-center gap-2 text-sm font-semibold text-[#315d9c] transition hover:gap-3">Read the connection guide <Arrow /></Link></div>
            <ol className="grid gap-3 sm:grid-cols-2">
              {[
                ["Create your firm account", "Set up your firm and invite the people who should have access."],
                ["Add MeritDesk to Claude or ChatGPT", "Use the custom MCP connector instructions. Each member signs in individually."],
                ["Choose your firm permissions", "An owner reviews the disclosure and enables case-work access when ready."],
                ["Ask your assistant", "Search official sources, inspect permitted matter context and run the available skills."],
              ].map(([title, description], i) => <li key={title} className="rounded-2xl border border-[#e3e9f1] bg-white p-6"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#edf2fa] text-xs font-bold text-[#466a9f]">0{i+1}</span><h3 className="mt-5 text-base font-semibold text-[#243852]">{title}</h3><p className="mt-2 text-sm leading-7 text-[#78869a]">{description}</p></li>)}
            </ol>
          </div>
        </div>
      </section>

      <section className="border-y border-[#e9edf3] bg-white">
        <div className="mx-auto max-w-7xl px-6 py-20 sm:px-8 lg:px-10 lg:py-24">
          <div className="mx-auto max-w-3xl text-center"><p className="text-[11px] font-bold uppercase tracking-[.2em] text-[#6683b0]">Try a real prompt</p><h2 className="mt-4 text-3xl font-semibold tracking-[-.04em] text-[#182943] sm:text-4xl">Start with a question. Let your assistant use the tools.</h2><p className="mt-4 text-sm leading-7 text-[#77859a]">These examples show the kind of work you can ask your connected assistant to do. Actual results depend on the available sources, firm settings and your permissions.</p></div>
          <div className="mx-auto mt-10 grid max-w-4xl gap-3 sm:grid-cols-2">{prompts.map((prompt, i) => <div key={prompt} className="flex gap-3 rounded-2xl border border-[#e7ebf1] bg-[#fcfdff] p-5"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#edf2fa] text-[10px] font-bold text-[#466a9f]">0{i+1}</span><p className="text-sm leading-6 text-[#536780]">“{prompt}”</p></div>)}</div>
        </div>
      </section>

      <section id="security" className="bg-[#f5f7fa]">
        <div className="mx-auto grid max-w-7xl gap-12 px-6 py-20 sm:px-8 lg:grid-cols-2 lg:items-center lg:px-10 lg:py-24">
          <div><p className="text-[11px] font-bold uppercase tracking-[.2em] text-[#6683b0]">Access stays in your firm&apos;s hands</p><h2 className="mt-4 text-3xl font-semibold tracking-[-.04em] text-[#182943] sm:text-4xl">Your team. Your permissions. Your decision.</h2><p className="mt-5 text-sm leading-7 text-[#77859a]">Every member signs in individually. Firm owners decide whether case-work tools are enabled, and access follows each member&apos;s role. Connector calls involving firm casework are recorded in the firm&apos;s audit log.</p><p className="mt-4 text-sm leading-7 text-[#77859a]">When case-work tools are enabled, information returned from a matter—including client and case details or skill reports—becomes part of the conversation with your AI provider and is subject to that provider&apos;s terms. Review the firm disclosure before enabling access.</p><Link href="/privacy" className="mt-7 inline-flex items-center gap-2 text-sm font-semibold text-[#315d9c]">Read the privacy policy <Arrow diagonal /></Link></div>
          <div className="rounded-2xl border border-[#e4eaf1] bg-white p-6 sm:p-8"><p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#8797ad]">Built-in controls</p><div className="mt-6 space-y-5">{[["Individual sign-in","Every member authorizes their own connection."],["Role-aware tools","Tool access follows the member's firm role."],["Firm-controlled case work","Owners can enable or disable access and document download links."],["Audited connector activity","Case-work tool calls are recorded for the firm."]].map(([title, desc],i)=><div key={title} className="flex gap-4"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#eaf0f8] text-xs font-semibold text-[#41699f]">0{i+1}</span><div><h3 className="text-sm font-semibold text-[#2d415e]">{title}</h3><p className="mt-1 text-sm leading-6 text-[#7c899b]">{desc}</p></div></div>)}</div></div>
        </div>
      </section>

      <section className="border-y border-[#e9edf3] bg-white">
        <div className="mx-auto max-w-5xl px-6 py-20 sm:px-8 lg:px-10 lg:py-24">
          <div className="text-center"><p className="text-[11px] font-bold uppercase tracking-[.2em] text-[#6683b0]">Questions, answered</p><h2 className="mt-4 text-3xl font-semibold tracking-[-.04em] text-[#182943] sm:text-4xl">Before you connect</h2></div>
          <div className="mt-10 divide-y divide-[#e9edf2]">
            {[
              ["Is MeritDesk a separate legal case-management app?", "The main experience is your AI assistant. MeritDesk provides the connector, official-source library and firm-controlled case-work tools. The website is used for account, firm, connector and billing setup."],
              ["Does it work with Claude and ChatGPT?", "Yes. Add MeritDesk as a custom remote MCP connector. Claude requires Pro, Max, Team or Enterprise. ChatGPT Business, Enterprise and Edu support full tool actions; ChatGPT Pro currently supports read/fetch tools only."],
              ["Can my assistant access client matters?", "Only when the firm owner enables case-work access, the connected AI client is recognized by the platform, the firm is entitled to use the service, and the member's role allows the requested tool."],
              ["Do client documents get sent to the AI provider?", "When an enabled tool returns matter information or a skill report, that information becomes part of the AI conversation. Document contents are not automatically returned by the document-list tools. Review the disclosure and provider terms before use."],
              ["What happens when a skill is run?", "A confirmed skill run is queued and processed in the background. It can read eligible matter documents and the firm's practice context, and may create documents or reports. It uses the firm's model budget."],
              ["How much does it cost?", "Every firm starts with 30 days free. After that, the plan is $20 per user per month. Billing is managed on the MeritDesk website."],
            ].map(([q, a]) => <details key={q} className="group py-5"><summary className="flex cursor-pointer list-none items-center justify-between gap-5 text-left text-sm font-semibold text-[#2b415e]"><span>{q}</span><span className="text-xl font-normal text-[#8192a9] transition group-open:rotate-45">+</span></summary><p className="mt-3 max-w-3xl text-sm leading-7 text-[#748399]">{a}</p></details>)}
          </div>
        </div>
      </section>

      <section className="bg-[#17345f]">
        <div className="mx-auto flex max-w-7xl flex-col gap-9 px-6 py-16 sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:px-10 lg:py-20">
          <div className="max-w-2xl"><p className="text-[11px] font-bold uppercase tracking-[.2em] text-[#a9c1e4]">Make your AI more useful for immigration law</p><h2 className="mt-4 text-3xl font-semibold tracking-[-.04em] text-white sm:text-4xl">Bring MeritDesk into the conversation.</h2><p className="mt-4 text-sm leading-7 text-[#d2deed]">Start with the official legal library, then enable the firm tools your team needs.</p></div>
          <div className="flex shrink-0 flex-wrap gap-3"><Link href="/sign-up" className="inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3.5 text-sm font-semibold text-[#17345f] transition hover:bg-[#edf3fb]">Start free month <Arrow /></Link><Link href="/pricing" className="inline-flex items-center gap-2 rounded-xl border border-white/30 px-5 py-3.5 text-sm font-semibold text-white transition hover:bg-white/10">See pricing <Arrow /></Link></div>
        </div>
      </section>
    </div>
  );
}
