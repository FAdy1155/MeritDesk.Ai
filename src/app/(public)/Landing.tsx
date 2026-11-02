import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/billing/config";

const features = [
  { number: "01", title: "A home for every matter", text: "Keep clients, immigration matters, case details and supporting documents together. Give your team a shared view of the work and a clear record of activity.", icon: "▤" },
  { number: "02", title: "26 purpose-built immigration skills", text: "Support claim evaluation, declarations, briefs, packet review, interview preparation, evidence organization and more—grounded in the matter and your firm's practice profile.", icon: "✳" },
  { number: "03", title: "An official legal library", text: "Search collected decisions, statutes, regulations, agency manuals and guidance. Skills can retrieve source material and link back to official documents.", icon: "§" },
  { number: "04", title: "Your AI tools, connected", text: "Connect Claude or ChatGPT through the firm's MCP connector. Each team member signs in individually, and the firm controls whether case-work tools are enabled.", icon: "⌘" },
];

const steps = [
  ["Create your firm workspace", "Set up your firm, invite your team and add the details used in your legal documents."],
  ["Organize clients and matters", "Create matters, keep case information together and upload the documents your team works with."],
  ["Connect your AI assistant", "Follow the guided steps to connect Claude or ChatGPT using your firm's secure connector."],
  ["Work with context and sources", "Use the legal library and immigration skills with firm-controlled access and an audit trail for case-work activity."],
];

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-4 w-4">{diagonal ? <path d="M5 15 15 5M6 5h9v9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /> : <path d="M3.5 10h12m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />}</svg>;
}

function ProductPreview() {
  return (
    <div className="relative mx-auto w-full max-w-[650px] lg:ml-auto">
      <div aria-hidden="true" className="absolute -inset-10 -z-10 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(87,128,190,.18),transparent_68%)] blur-2xl" />
      <div className="overflow-hidden rounded-[22px] border border-[#dfe5ed] bg-white shadow-[0_35px_100px_-42px_rgba(23,42,70,.42)]">
        <div className="flex items-center justify-between border-b border-[#e9edf2] bg-[#fbfcfe] px-5 py-4">
          <div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#17345f] text-sm font-semibold text-white">M</span><div><p className="text-sm font-semibold tracking-tight text-[#1b2e49]">MeritDesk.AI</p><p className="text-[11px] text-[#8491a3]">Firm workspace · Example view</p></div></div>
          <span className="rounded-full border border-[#dce8df] bg-[#f2f8f3] px-3 py-1 text-[10px] font-medium text-[#477455]">Illustrative preview</span>
        </div>
        <div className="grid min-h-[370px] grid-cols-[145px_1fr] sm:grid-cols-[172px_1fr]">
          <aside className="border-r border-[#edf0f4] bg-[#fafbfd] p-3 sm:p-4">
            <p className="mb-3 px-2 text-[9px] font-semibold uppercase tracking-[.15em] text-[#9aa6b6]">Workspace</p>
            {["Overview", "Matters", "Clients", "Legal library", "Practice profile"].map((item, i) => <div key={item} className={"mb-1 flex items-center gap-2 rounded-lg px-2.5 py-2.5 text-[10px] font-medium " + (i === 1 ? "bg-[#edf2fa] text-[#315c97]" : "text-[#758399]")}><span className="w-4 text-center">{["⌂","▤","♙","§","◎"][i]}</span>{item}</div>)}
            <div className="mt-8 rounded-xl border border-[#e8edf2] bg-white p-3"><p className="text-[9px] font-semibold text-[#425674]">AI connections</p><p className="mt-1 text-[9px] leading-4 text-[#8996a8]">Claude and ChatGPT setup</p><span className="mt-2 inline-flex rounded-full bg-[#f1f5fb] px-2 py-1 text-[8px] text-[#5877a4]">View setup</span></div>
          </aside>
          <div className="min-w-0 p-4 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[9px] font-semibold uppercase tracking-[.15em] text-[#91a0b2]">Matter management</p><h3 className="mt-1 text-xl font-semibold tracking-tight text-[#1d304c]">Your matters</h3><p className="mt-1 text-[10px] text-[#8995a6]">A clear view of the work your firm is handling.</p></div><span className="rounded-lg bg-[#17345f] px-3 py-2 text-[9px] font-semibold text-white">+ New matter</span></div>
            <div className="mt-5 grid grid-cols-2 gap-2.5">
              <div className="rounded-xl border border-[#e8edf2] p-3"><p className="text-[9px] text-[#8a97a9]">Case information</p><p className="mt-1 text-xs font-semibold text-[#334761]">Organized by matter</p><p className="mt-1 text-[9px] text-[#9aa5b4]">Details and key dates</p></div>
              <div className="rounded-xl border border-[#e8edf2] p-3"><p className="text-[9px] text-[#8a97a9]">Documents</p><p className="mt-1 text-xs font-semibold text-[#334761]">Kept in context</p><p className="mt-1 text-[9px] text-[#9aa5b4]">Files and extracted text</p></div>
            </div>
            <div className="mt-4 overflow-hidden rounded-xl border border-[#e8edf2]">
              <div className="border-b border-[#edf0f4] bg-[#fafbfd] px-3 py-2.5 text-[9px] font-semibold uppercase tracking-[.12em] text-[#8794a6]">Example matter workflow</div>
              <div className="grid grid-cols-[1.2fr_1fr_auto] gap-2 border-b border-[#edf0f4] px-3 py-3 text-[9px]"><span className="font-semibold text-[#354a65]">Matter details</span><span className="text-[#8491a3]">Case type and venue</span><span className="text-[#5477a8]">Open →</span></div>
              <div className="grid grid-cols-[1.2fr_1fr_auto] gap-2 border-b border-[#edf0f4] px-3 py-3 text-[9px]"><span className="font-semibold text-[#354a65]">Supporting documents</span><span className="text-[#8491a3]">Files and evidence</span><span className="text-[#5477a8]">Review →</span></div>
              <div className="grid grid-cols-[1.2fr_1fr_auto] gap-2 px-3 py-3 text-[9px]"><span className="font-semibold text-[#354a65]">Immigration skills</span><span className="text-[#8491a3]">26 guided workflows</span><span className="text-[#5477a8]">Explore →</span></div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">{["Firm-controlled access", "Activity audit log", "Official legal sources"].map(x => <span key={x} className="rounded-full bg-[#f4f6f9] px-2.5 py-1 text-[8px] text-[#75849a]">{x}</span>)}</div>
          </div>
        </div>
      </div>
      <p className="mt-3 text-center text-[10px] text-[#99a4b2]">Illustrative interface preview · Not live client data</p>
    </div>
  );
}

export function Landing() {
  return (
    <div className="overflow-hidden bg-[#fbfcfd] text-[#192b43]">
      <section className="relative isolate">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_78%_30%,rgba(220,231,246,.72),transparent_42%),linear-gradient(180deg,#fcfdff_0%,#f7f9fc_100%)]" />
        <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 pb-24 pt-16 sm:px-8 sm:pt-20 lg:grid-cols-[.9fr_1.1fr] lg:gap-12 lg:px-10 lg:pb-32 lg:pt-24">
          <div className="relative z-10 max-w-2xl">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[#dce5f0] bg-white/90 px-3.5 py-2 text-[11px] font-semibold tracking-wide text-[#496b9e] shadow-sm"><span className="h-1.5 w-1.5 rounded-full bg-[#5b83c6]" />Immigration law practice software</div>
            <h1 className="text-[2.8rem] font-semibold leading-[1.04] tracking-[-.055em] text-[#142641] sm:text-6xl lg:text-[4.25rem]">The workspace behind a better-run immigration practice.</h1>
            <p className="mt-7 max-w-xl text-base leading-8 text-[#65748a] sm:text-lg">Manage clients, immigration matters and documents. Put 26 purpose-built legal skills and an official-source library within reach of your team. Then connect Claude or ChatGPT to work with your firm&apos;s context—with access controlled by your firm.</p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link href="/sign-up" className="group inline-flex items-center gap-3 rounded-xl bg-[#17345f] px-6 py-3.5 text-sm font-semibold text-white shadow-[0_12px_25px_-12px_rgba(23,52,95,.65)] transition hover:-translate-y-0.5 hover:bg-[#214779]">Start your 30-day free trial <Arrow /></Link>
              <Link href="/pricing" className="inline-flex items-center gap-2 rounded-xl border border-[#d8e0eb] bg-white px-6 py-3.5 text-sm font-semibold text-[#344966] transition hover:border-[#aebed4] hover:bg-[#f7f9fc]">View pricing <Arrow diagonal /></Link>
            </div>
            <p className="mt-4 text-xs font-medium tracking-wide text-[#8996a8]">No credit card required for your first 30 days. $20 per user/month after trial.</p>
            <div className="mt-10 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[#e7ebf1] pt-6 text-[11px] font-medium text-[#77869b]"><span>Case and document management</span><span className="hidden h-1 w-1 rounded-full bg-[#b5c0ce] sm:block" /><span>26 immigration skills</span><span className="hidden h-1 w-1 rounded-full bg-[#b5c0ce] sm:block" /><span>Official legal sources</span></div>
          </div>
          <ProductPreview />
        </div>
      </section>

      <section id="features" className="border-y border-[#e9edf3] bg-white">
        <div className="mx-auto max-w-7xl px-6 py-20 sm:px-8 lg:px-10 lg:py-24">
          <div className="mx-auto mb-12 max-w-2xl text-center"><p className="text-[11px] font-bold uppercase tracking-[.2em] text-[#6683b0]">One connected workspace</p><h2 className="mt-4 text-3xl font-semibold tracking-[-.04em] text-[#182943] sm:text-4xl">The tools your immigration practice needs, working together.</h2><p className="mt-4 text-sm leading-7 text-[#77859a]">Less time moving between disconnected tools. A clearer place for your team to manage the work and use AI with the right context.</p></div>
          <div className="grid gap-4 md:grid-cols-2">
            {features.map(f => <article key={f.number} className="group rounded-2xl border border-[#e7ebf1] bg-[#fcfdff] p-7 transition duration-300 hover:-translate-y-1 hover:border-[#cbd8ea] hover:shadow-[0_20px_45px_-32px_rgba(30,57,96,.3)]"><div className="flex items-center justify-between"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#edf2fa] text-lg text-[#42689f]">{f.icon}</span><span className="text-xs font-semibold tracking-[.14em] text-[#a6b1c0]">{f.number}</span></div><h3 className="mt-6 text-lg font-semibold tracking-tight text-[#203550]">{f.title}</h3><p className="mt-3 text-sm leading-7 text-[#758399]">{f.text}</p></article>)}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="bg-[#f5f7fa]">
        <div className="mx-auto max-w-7xl px-6 py-20 sm:px-8 lg:px-10 lg:py-24">
          <div className="grid gap-12 lg:grid-cols-[.72fr_1.28fr] lg:gap-20">
            <div><p className="text-[11px] font-bold uppercase tracking-[.2em] text-[#6683b0]">A practical workflow</p><h2 className="mt-4 text-3xl font-semibold tracking-[-.04em] text-[#182943] sm:text-4xl">From firm setup to day-to-day legal work.</h2><p className="mt-5 max-w-sm text-sm leading-7 text-[#77859a]">Start with the information your firm already has. Add your team, organize the matters and connect the AI tools you use.</p><Link href="/sign-up" className="mt-8 inline-flex items-center gap-2 text-sm font-semibold text-[#315d9c] transition hover:gap-3">Create your workspace <Arrow /></Link></div>
            <ol className="grid gap-3 sm:grid-cols-2">{steps.map(([title, description], i) => <li key={title} className="rounded-2xl border border-[#e3e9f1] bg-white p-6"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#edf2fa] text-xs font-bold text-[#466a9f]">0{i+1}</span><h3 className="mt-5 text-base font-semibold text-[#243852]">{title}</h3><p className="mt-2 text-sm leading-7 text-[#78869a]">{description}</p></li>)}</ol>
          </div>
        </div>
      </section>

      <section id="security" className="border-y border-[#e9edf3] bg-white">
        <div className="mx-auto grid max-w-7xl gap-12 px-6 py-20 sm:px-8 lg:grid-cols-2 lg:items-center lg:px-10 lg:py-24">
          <div><p className="text-[11px] font-bold uppercase tracking-[.2em] text-[#6683b0]">AI, with firm context</p><h2 className="mt-4 text-3xl font-semibold tracking-[-.04em] text-[#182943] sm:text-4xl">Bring your firm&apos;s work into the AI tools you already use.</h2><p className="mt-5 text-sm leading-7 text-[#77859a]">MeritDesk.AI connects to Claude and ChatGPT through a remote MCP connector. Each person signs in with their own account. Your firm decides whether case-work tools are enabled, and case-work activity is recorded in the firm&apos;s audit log.</p><p className="mt-4 text-sm leading-7 text-[#77859a]">When case-work access is enabled, information returned from a matter is shared with the AI provider as part of that conversation and is subject to that provider&apos;s terms. Review the controls and disclosure before enabling it.</p><Link href="/pricing" className="mt-7 inline-flex items-center gap-2 text-sm font-semibold text-[#315d9c]">Explore plans <Arrow /></Link></div>
          <div className="rounded-2xl border border-[#e4eaf1] bg-[#fafbfd] p-6 sm:p-8"><p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#8797ad]">Designed for firm oversight</p><div className="mt-6 space-y-5">{[["Individual sign-in","Every team member connects with their own account."],["Firm-controlled permissions","Owners control access to case-work tools."],["Activity audit trail","Case-work connector calls are recorded for the firm."],["Official-source research","The legal library links back to source documents."]].map(([title, desc],i)=><div key={title} className="flex gap-4"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#eaf0f8] text-xs font-semibold text-[#41699f]">0{i+1}</span><div><h3 className="text-sm font-semibold text-[#2d415e]">{title}</h3><p className="mt-1 text-sm leading-6 text-[#7c899b]">{desc}</p></div></div>)}</div></div>
        </div>
      </section>

      <section id="pricing-summary" className="bg-[#17345f]">
        <div className="mx-auto flex max-w-7xl flex-col gap-9 px-6 py-16 sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:px-10 lg:py-20">
          <div className="max-w-2xl"><p className="text-[11px] font-bold uppercase tracking-[.2em] text-[#a9c1e4]">Straightforward pricing</p><h2 className="mt-4 text-3xl font-semibold tracking-[-.04em] text-white sm:text-4xl">30 days to see how it fits your practice.</h2><p className="mt-5 text-sm leading-7 text-[#c2cfe0]">Every firm starts with a 30-day free trial, with no card required. After that, it is $20 per user per month, billed to the firm. Seats follow your members, billing renews automatically, and receipts are sent by email. Cancel from the Billing page at any time.</p></div>
          <div className="flex shrink-0 flex-col items-start gap-4 sm:flex-row sm:items-center"><Link href="/sign-up" className="inline-flex items-center gap-3 rounded-xl bg-white px-6 py-3.5 text-sm font-semibold text-[#18365f] transition hover:-translate-y-0.5 hover:bg-[#edf3fb]">Start free month <Arrow /></Link><Link href="/pricing" className="inline-flex items-center gap-2 text-sm font-semibold text-white/85 transition hover:text-white">Full pricing details <Arrow diagonal /></Link></div>
        </div>
      </section>
      <div className="bg-[#fbfcfd] px-6 py-8 text-center text-[11px] leading-5 text-[#96a1af]">{PRODUCT_NAME} is a workflow and research tool for immigration law practices. It does not replace an attorney&apos;s professional judgment or review of source materials.</div>
    </div>
  );
}
