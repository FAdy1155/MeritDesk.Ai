"use client";

import { useId, useRef, useState, useTransition } from "react";
import {
  FEDERAL_CIRCUITS,
  MATTER_DATE_FIELDS,
  MATTER_DETAIL_LABELS,
  MATTER_STATUSES,
  MATTER_VENUES,
  formatMatterDate,
  isFederalCircuit,
  isMatterStatus,
  isMatterVenue,
  matterStatusLabel,
  matterVenueLabel,
} from "@/lib/matters/details";
import { updateMatterDetailsAction } from "../actions";

/** The matters columns this card shows and edits, as the page passes them in. */
export type MatterDetailsShown = {
  status: string;
  venue: string | null;
  circuit: string | null;
  court: string | null;
  ntaDate: string | null;
  oneYearClockDate: string | null;
  nextHearingDate: string | null;
};

// The circuit select's value for "type it yourself" (never stored).
const OTHER_CIRCUIT = "__other__";

type FormState = {
  status: string;
  venue: string;
  circuitChoice: string;
  circuitOther: string;
  court: string;
  ntaDate: string;
  oneYearClockDate: string;
  nextHearingDate: string;
};

function toFormState(details: MatterDetailsShown): FormState {
  const circuit = details.circuit ?? "";
  const listed = circuit === "" || isFederalCircuit(circuit);
  return {
    status: details.status,
    venue: details.venue ?? "",
    circuitChoice: listed ? circuit : OTHER_CIRCUIT,
    circuitOther: listed ? "" : circuit,
    court: details.court ?? "",
    ntaDate: details.ntaDate ?? "",
    oneYearClockDate: details.oneYearClockDate ?? "",
    nextHearingDate: details.nextHearingDate ?? "",
  };
}

const labelClass = "text-xs font-semibold text-[#53657d]";
const inputClass =
  "mt-1.5 w-full rounded-xl border border-[#dce4ee] bg-white px-3.5 py-2.5 text-sm text-[#263b57] outline-none focus:border-[#7899c4] focus:ring-4 focus:ring-[#dce8f7] disabled:opacity-60";
const primaryButton =
  "rounded-xl bg-[#17345f] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#244a7c] disabled:opacity-50";
const secondaryButton =
  "rounded-xl border border-[#dce4ee] bg-white px-4 py-2.5 text-sm font-semibold text-[#536b8a] hover:bg-[#f7f9fc] disabled:opacity-50";


export function MatterDetails({
  matterId,
  details,
  canEdit,
}: {
  matterId: string;
  details: MatterDetailsShown;
  /** False for read-only members: no Edit button (the action refuses them too). */
  canEdit: boolean;
}) {
  const [form, setForm] = useState<FormState | null>(null);
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const idPrefix = useId();
  const fieldId = (name: string) => `${idPrefix}-${name}`;

  function startEditing() {
    setMessage(null);
    setForm(toFormState(details));
  }

  function stopEditing() {
    setForm(null);
    // Back to the button that opened the form, for keyboard users.
    requestAnimationFrame(() => editButtonRef.current?.focus());
  }

  function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form) return;
    const input = {
      status: form.status,
      venue: form.venue,
      circuit: form.circuitChoice === OTHER_CIRCUIT ? form.circuitOther : form.circuitChoice,
      court: form.court,
      ntaDate: form.ntaDate,
      oneYearClockDate: form.oneYearClockDate,
      nextHearingDate: form.nextHearingDate,
    };
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await updateMatterDetailsAction(matterId, input);
        if (!result.ok) {
          setMessage({ tone: "error", text: result.error });
          return;
        }
        setMessage({
          tone: "ok",
          text: result.changedFields.length > 0 ? "Matter details saved. New skill runs will read them." : "No changes to save.",
        });
        stopEditing();
      } catch (err) {
        setMessage({ tone: "error", text: `Could not save: ${err instanceof Error ? err.message : String(err)}` });
      }
    });
  }

  const set = (field: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((prev) => (prev ? { ...prev, [field]: e.target.value } : prev));

  const shown: [string, string | null][] = [
    [MATTER_DETAIL_LABELS.status, matterStatusLabel(details.status)],
    [MATTER_DETAIL_LABELS.venue, matterVenueLabel(details.venue)],
    [MATTER_DETAIL_LABELS.circuit, details.circuit],
    [MATTER_DETAIL_LABELS.court, details.court],
    ...MATTER_DATE_FIELDS.map((field): [string, string | null] => {
      const value = details[field];
      return [MATTER_DETAIL_LABELS[field], value ? formatMatterDate(value) : null];
    }),
  ];

  return (
    <section
      aria-labelledby={fieldId("heading")}
      className="flex flex-col gap-4 rounded-2xl border border-[#e4eaf1] bg-white p-5 shadow-[0_8px_30px_-25px_rgba(22,43,72,.2)] sm:p-6"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={fieldId("heading")} className="font-medium">
          Matter details
        </h2>
        {canEdit && !form && (
          <button ref={editButtonRef} type="button" className={secondaryButton} onClick={startEditing}>
            Edit details
          </button>
        )}
      </div>
      <p className="text-xs leading-6 text-[#8290a4]">
        Every skill run reads these details as they are when the run is queued.
      </p>

      {!form && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          {shown.map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-[#91a0b4]">{label}</dt>
              <dd className={value ? "mt-1 text-sm font-medium text-[#344b66]" : "mt-1 text-sm text-[#a0aaba]"}>{value ?? "Not set"}</dd>
            </div>
          ))}
        </dl>
      )}

      {form && (
        <form onSubmit={handleSave} className="flex flex-col gap-3" aria-describedby={fieldId("form-help")}>
          <p id={fieldId("form-help")} className="sr-only">
            Edit the matter details, then save. Dates are entered as YYYY-MM-DD.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor={fieldId("status")} className={labelClass}>
                {MATTER_DETAIL_LABELS.status}
              </label>
              <select id={fieldId("status")} className={inputClass} value={form.status} onChange={set("status")} required>
                {MATTER_STATUSES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
                {/* A status stored before the list existed stays selectable, unchanged. */}
                {!isMatterStatus(details.status) && (
                  <option value={details.status}>{matterStatusLabel(details.status)} (current)</option>
                )}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={fieldId("venue")} className={labelClass}>
                {MATTER_DETAIL_LABELS.venue}
              </label>
              <select id={fieldId("venue")} className={inputClass} value={form.venue} onChange={set("venue")}>
                <option value="">Not set</option>
                {MATTER_VENUES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
                {details.venue && !isMatterVenue(details.venue) && (
                  <option value={details.venue}>{matterVenueLabel(details.venue)} (current)</option>
                )}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={fieldId("circuit")} className={labelClass}>
                {MATTER_DETAIL_LABELS.circuit}
              </label>
              <select
                id={fieldId("circuit")}
                className={inputClass}
                value={form.circuitChoice}
                onChange={set("circuitChoice")}
              >
                <option value="">Not set</option>
                {FEDERAL_CIRCUITS.map((circuit) => (
                  <option key={circuit} value={circuit}>
                    {circuit}
                  </option>
                ))}
                <option value={OTHER_CIRCUIT}>Other (type it below)</option>
              </select>
            </div>

            {form.circuitChoice === OTHER_CIRCUIT && (
              <div className="flex flex-col gap-1">
                <label htmlFor={fieldId("circuit-other")} className={labelClass}>
                  Circuit (other)
                </label>
                <input
                  id={fieldId("circuit-other")}
                  className={inputClass}
                  value={form.circuitOther}
                  onChange={set("circuitOther")}
                  maxLength={100}
                  required
                />
              </div>
            )}

            <div className="flex flex-col gap-1 sm:col-span-2">
              <label htmlFor={fieldId("court")} className={labelClass}>
                {MATTER_DETAIL_LABELS.court}
              </label>
              <input
                id={fieldId("court")}
                className={inputClass}
                value={form.court}
                onChange={set("court")}
                maxLength={200}
                aria-describedby={fieldId("court-help")}
              />
              <span id={fieldId("court-help")} className="text-xs text-black/50 dark:text-white/50">
                The Immigration Court, Asylum Office or USCIS office handling the matter, as skills should name it.
              </span>
            </div>

            {MATTER_DATE_FIELDS.map((field) => (
              <div key={field} className="flex flex-col gap-1">
                <label htmlFor={fieldId(field)} className={labelClass}>
                  {MATTER_DETAIL_LABELS[field]}
                </label>
                <input
                  id={fieldId(field)}
                  type="date"
                  className={inputClass}
                  value={form[field]}
                  onChange={set(field)}
                  min="1900-01-01"
                  max="2100-12-31"
                  pattern="\d{4}-\d{2}-\d{2}"
                  placeholder="YYYY-MM-DD"
                />
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button type="submit" className={primaryButton} disabled={isPending}>
              {isPending ? "Saving..." : "Save matter details"}
            </button>
            <button type="button" className={secondaryButton} disabled={isPending} onClick={stopEditing}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <p
        aria-live="polite"
        className={`text-xs ${message?.tone === "error" ? "text-red-700 dark:text-red-400" : "text-green-700 dark:text-green-400"}`}
      >
        {message?.text}
      </p>
    </section>
  );
}
