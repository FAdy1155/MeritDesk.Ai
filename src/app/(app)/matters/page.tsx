import Link from "next/link";
import { EDITOR_ROLES, getCurrentTenant, hasRole } from "@/lib/tenant";
import { listMatters } from "@/lib/matters/service";
import { MATTER_CASE_TYPES, caseTypeLabel } from "@/lib/matters/case-types";
import {
  FEDERAL_CIRCUITS,
  MATTER_DETAIL_LABELS,
  MATTER_VENUES,
  formatMatterDate,
  matterStatusLabel,
  matterVenueLabel,
} from "@/lib/matters/details";
import { createMatterAction } from "./actions";

// The circuit select's value for "type it in the next box" (never stored).
const OTHER_CIRCUIT = "__other__";

async function createMatterFromForm(formData: FormData) {
  "use server";
  const field = (name: string) => String(formData.get(name) ?? "");
  const circuitChoice = field("circuit");
  // createMatterAction validates everything (lists, strict YYYY-MM-DD dates).
  await createMatterAction({
    caseType: field("caseType"),
    venue: field("venue"),
    circuit: circuitChoice === OTHER_CIRCUIT ? field("circuitOther") : circuitChoice,
    court: field("court"),
    ntaDate: field("ntaDate"),
    oneYearClockDate: field("oneYearClockDate"),
    nextHearingDate: field("nextHearingDate"),
  });
}

const inputClass =
  "rounded-md border border-black/15 bg-transparent px-3 py-1.5 text-sm dark:border-white/20";
const labelClass = "flex flex-col gap-1 text-xs text-black/60 dark:text-white/60";

export default async function MattersPage() {
  const { tenant, membership } = await getCurrentTenant();
  // read_only members can browse but not create (the action checks this too).
  const canEdit = hasRole(membership, EDITOR_ROLES);
  const matterRows = await listMatters(tenant.id);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <h1 className="text-xl font-semibold">Matters</h1>

      {canEdit && (
        <form
          action={createMatterFromForm}
          aria-label="New matter"
          className="grid grid-cols-1 gap-3 rounded-lg border border-black/10 p-4 sm:grid-cols-2 dark:border-white/10"
        >
          <label className={`${labelClass} sm:col-span-2`}>
            Case type
            <select name="caseType" required className={inputClass}>
              <option value="">Select case type...</option>
              {MATTER_CASE_TYPES.map(([value, lbl]) => (
                <option key={value} value={value}>
                  {lbl}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            {MATTER_DETAIL_LABELS.venue}
            <select name="venue" className={inputClass}>
              <option value="">Not set</option>
              {MATTER_VENUES.map(([value, lbl]) => (
                <option key={value} value={value}>
                  {lbl}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            {MATTER_DETAIL_LABELS.court}
            <input name="court" maxLength={200} className={inputClass} />
          </label>
          <label className={labelClass}>
            {MATTER_DETAIL_LABELS.circuit}
            <select name="circuit" className={inputClass}>
              <option value="">Not set</option>
              {FEDERAL_CIRCUITS.map((circuit) => (
                <option key={circuit} value={circuit}>
                  {circuit}
                </option>
              ))}
              <option value={OTHER_CIRCUIT}>Other (type it in the next box)</option>
            </select>
          </label>
          <label className={labelClass}>
            Circuit, if other
            <input name="circuitOther" maxLength={100} className={inputClass} />
          </label>
          <label className={labelClass}>
            {MATTER_DETAIL_LABELS.ntaDate}
            <input name="ntaDate" type="date" min="1900-01-01" max="2100-12-31" className={inputClass} />
          </label>
          <label className={labelClass}>
            {MATTER_DETAIL_LABELS.oneYearClockDate}
            <input name="oneYearClockDate" type="date" min="1900-01-01" max="2100-12-31" className={inputClass} />
          </label>
          <label className={labelClass}>
            {MATTER_DETAIL_LABELS.nextHearingDate}
            <input name="nextHearingDate" type="date" min="1900-01-01" max="2100-12-31" className={inputClass} />
          </label>
          <button
            type="submit"
            className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white sm:col-span-2 dark:bg-white dark:text-black"
          >
            Create matter
          </button>
        </form>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-black/10 text-left dark:border-white/10">
            <th className="py-2">Case type</th>
            <th>Status</th>
            <th>Venue</th>
            <th>Next hearing</th>
            <th>
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {matterRows.map((m) => (
            <tr key={m.id} className="border-b border-black/5 dark:border-white/5">
              <td className="py-2">{caseTypeLabel(m.caseType)}</td>
              <td>{matterStatusLabel(m.status)}</td>
              <td>{matterVenueLabel(m.venue) ?? "Not set"}</td>
              <td>{m.nextHearingDate ? formatMatterDate(m.nextHearingDate) : "Not set"}</td>
              <td>
                <Link href={`/matters/${m.id}`} className="text-blue-600 dark:text-blue-400">
                  Open<span className="sr-only"> {caseTypeLabel(m.caseType)} matter</span>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
