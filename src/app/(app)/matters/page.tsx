import Link from "next/link";
import { EDITOR_ROLES, getCurrentTenant, hasRole } from "@/lib/tenant";
import { listMatters } from "@/lib/matters/service";
import { MATTER_CASE_TYPES, caseTypeLabel } from "@/lib/matters/case-types";
import { FEDERAL_CIRCUITS, MATTER_DETAIL_LABELS, MATTER_VENUES, formatMatterDate, matterStatusLabel, matterVenueLabel } from "@/lib/matters/details";
import { createMatterAction } from "./actions";

const OTHER_CIRCUIT = "__other__";
async function createMatterFromForm(formData: FormData) {
  "use server";
  const field = (name: string) => String(formData.get(name) ?? "");
  const circuitChoice = field("circuit");
  await createMatterAction({ caseType: field("caseType"), venue: field("venue"), circuit: circuitChoice === OTHER_CIRCUIT ? field("circuitOther") : circuitChoice, court: field("court"), ntaDate: field("ntaDate"), oneYearClockDate: field("oneYearClockDate"), nextHearingDate: field("nextHearingDate") });
}
const inputClass = "mt-1.5 w-full rounded-xl border border-[#dce4ee] bg-white px-3.5 py-2.5 text-sm text-[#263b57] outline-none transition placeholder:text-[#9aa7b8] focus:border-[#7899c4] focus:ring-4 focus:ring-[#dce8f7]";
const labelClass = "flex flex-col gap-1 text-xs font-medium text-[#53657d]";

export default async function MattersPage() {
  const { tenant, membership } = await getCurrentTenant();
  const canEdit = hasRole(membership, EDITOR_ROLES);
  const matterRows = await listMatters(tenant.id);
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-7">
      <header className="flex flex-col justify-between gap-4 border-b border-[#e6ebf1] pb-6 sm:flex-row sm:items-end">
        <div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#7890b2]">CASE MANAGEMENT</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-[#1b2e49]">Matters</h1><p className="mt-2 max-w-xl text-sm leading-6 text-[#7b899d]">Keep each immigration case, its key details and supporting documents organized in one place.</p></div>
        <div className="rounded-xl border border-[#e5ebf2] bg-white px-4 py-3"><p className="text-[10px] font-medium uppercase tracking-wider text-[#8b98aa]">Your workspace</p><p className="mt-1 text-sm font-semibold text-[#344a67]">{matterRows.length} {matterRows.length === 1 ? "matter" : "matters"}</p></div>
      </header>
      {canEdit && <section className="rounded-2xl border border-[#e4eaf1] bg-white p-5 shadow-[0_8px_30px_-25px_rgba(22,43,72,.25)] sm:p-7">
        <div className="mb-5"><h2 className="text-base font-semibold text-[#263b57]">Create a matter</h2><p className="mt-1 text-xs leading-5 text-[#8996a8]">Start with the case type. You can add or update details later.</p></div>
        <form action={createMatterFromForm} aria-label="New matter" className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className={labelClass}>Case type<select name="caseType" required className={inputClass}><option value="">Select case type...</option>{MATTER_CASE_TYPES.map(([value,lbl])=><option key={value} value={value}>{lbl}</option>)}</select></label>
          <label className={labelClass}>{MATTER_DETAIL_LABELS.venue}<select name="venue" className={inputClass}><option value="">Not set</option>{MATTER_VENUES.map(([value,lbl])=><option key={value} value={value}>{lbl}</option>)}</select></label>
          <label className={labelClass}>{MATTER_DETAIL_LABELS.court}<input name="court" maxLength={200} className={inputClass} placeholder="Court or office name" /></label>
          <label className={labelClass}>{MATTER_DETAIL_LABELS.circuit}<select name="circuit" className={inputClass}><option value="">Not set</option>{FEDERAL_CIRCUITS.map(c=><option key={c} value={c}>{c}</option>)}<option value={OTHER_CIRCUIT}>Other (enter below)</option></select></label>
          <label className={labelClass}>Circuit, if other<input name="circuitOther" maxLength={100} className={inputClass} placeholder="Enter circuit" /></label>
          <label className={labelClass}>{MATTER_DETAIL_LABELS.ntaDate}<input name="ntaDate" type="date" min="1900-01-01" max="2100-12-31" className={inputClass} /></label>
          <label className={labelClass}>{MATTER_DETAIL_LABELS.oneYearClockDate}<input name="oneYearClockDate" type="date" min="1900-01-01" max="2100-12-31" className={inputClass} /></label>
          <label className={labelClass}>{MATTER_DETAIL_LABELS.nextHearingDate}<input name="nextHearingDate" type="date" min="1900-01-01" max="2100-12-31" className={inputClass} /></label>
          <div className="flex items-end"><button type="submit" className="w-full rounded-xl bg-[#17345f] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#244a7c] focus:outline-none focus:ring-4 focus:ring-[#dce8f7] sm:w-auto">Create matter <span aria-hidden="true">→</span></button></div>
        </form>
      </section>}
      <section className="overflow-hidden rounded-2xl border border-[#e4eaf1] bg-white shadow-[0_8px_30px_-25px_rgba(22,43,72,.2)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#edf0f4] px-5 py-4 sm:px-6"><div><h2 className="text-sm font-semibold text-[#2c415e]">All matters</h2><p className="mt-1 text-xs text-[#8996a8]">Your firm's case records</p></div><span className="rounded-full bg-[#f1f5fa] px-3 py-1.5 text-[11px] font-medium text-[#607794]">{matterRows.length} total</span></div>
        {matterRows.length ? <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left"><thead><tr><th className="px-5 py-3 text-[10px] font-semibold uppercase tracking-wider text-[#8492a5]">Case type</th><th className="px-5 py-3 text-[10px] font-semibold uppercase tracking-wider text-[#8492a5]">Status</th><th className="px-5 py-3 text-[10px] font-semibold uppercase tracking-wider text-[#8492a5]">Venue</th><th className="px-5 py-3 text-[10px] font-semibold uppercase tracking-wider text-[#8492a5]">Next hearing</th><th className="px-5 py-3 text-right text-[10px] font-semibold uppercase tracking-wider text-[#8492a5]"> </th></tr></thead><tbody>{matterRows.map(m=><tr key={m.id} className="border-t border-[#edf0f4] transition hover:bg-[#fafbfd]"><td className="px-5 py-4 text-sm font-semibold text-[#30445f]">{caseTypeLabel(m.caseType)}</td><td className="px-5 py-4"><span className="inline-flex rounded-full bg-[#f1f5fa] px-2.5 py-1 text-[11px] font-medium text-[#61748d]">{matterStatusLabel(m.status)}</span></td><td className="px-5 py-4 text-sm text-[#687991]">{matterVenueLabel(m.venue) ?? "Not set"}</td><td className="px-5 py-4 text-sm text-[#687991]">{m.nextHearingDate ? formatMatterDate(m.nextHearingDate) : "Not set"}</td><td className="px-5 py-4 text-right"><Link href={\`/matters/\${m.id}\`} className="inline-flex items-center gap-1 text-xs font-semibold text-[#416da5] hover:text-[#244d83]">Open matter <span>→</span><span className="sr-only"> {caseTypeLabel(m.caseType)} matter</span></Link></td></tr>)}</tbody></table></div> : <div className="px-6 py-14 text-center"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[#f1f5fa] text-xl text-[#7188a7]">▤</span><h3 className="mt-4 text-sm font-semibold text-[#30445f]">No matters yet</h3><p className="mx-auto mt-1 max-w-sm text-xs leading-6 text-[#8996a8]">When you create your first matter, it will appear here with its case details and next steps.</p></div>}
      </section>
    </div>
  );
}
