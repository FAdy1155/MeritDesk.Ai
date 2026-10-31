"use client";

import { useState, useTransition } from "react";
import { MAX_ADDRESS_LINES, type FirmIdentityInput, type FirmIdentityView } from "@/lib/firm-identity/schema";
import { saveFirmIdentityAction } from "./actions";

export const sectionClass = "flex flex-col gap-3 rounded-lg border border-black/10 p-4 dark:border-white/10";
export const labelClass = "text-sm font-medium";
export const inputClass =
  "rounded-md border border-black/15 bg-transparent px-3 py-1.5 text-sm disabled:opacity-60 dark:border-white/20";

// The I-130 expedite letter generator keeps the firm's plain-ASCII gate, so
// an accented name stops it; say so before anyone runs into it.
const NON_ASCII = /[^\x20-\x7e]/;

function toInput(identity: FirmIdentityView | null): Required<FirmIdentityInput> {
  const lines = identity?.addressLines ?? [];
  return {
    legalName: identity?.legalName ?? "",
    addressLines: Array.from({ length: MAX_ADDRESS_LINES }, (_, i) => lines[i] ?? ""),
    phone: identity?.phone ?? "",
    fax: identity?.fax ?? "",
    email: identity?.email ?? "",
    website: identity?.website ?? "",
    licensureLine: identity?.licensureLine ?? "",
  };
}

export function FirmIdentityForm({
  initialIdentity,
  canEdit,
}: {
  initialIdentity: FirmIdentityView | null;
  canEdit: boolean;
}) {
  const [values, setValues] = useState(() => toInput(initialIdentity));
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const set = (field: keyof Omit<FirmIdentityInput, "addressLines">) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues({ ...values, [field]: e.target.value });
  const hasNonAscii = [values.legalName, ...values.addressLines, values.phone, values.fax, values.email, values.website, values.licensureLine].some(
    (v) => NON_ASCII.test(v)
  );

  function handleSave() {
    setMessage(null);
    startTransition(async () => {
      const result = await saveFirmIdentityAction(values);
      setMessage(result.ok ? { tone: "ok", text: "Saved." } : { tone: "error", text: result.error });
    });
  }

  return (
    <section className={sectionClass}>
      <h2 className="font-semibold">Letterhead</h2>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Firm legal name</span>
        <input className={inputClass} disabled={!canEdit} value={values.legalName} onChange={set("legalName")} />
      </label>
      <fieldset className="flex flex-col gap-1">
        <legend className={labelClass}>Address (one letterhead line per box)</legend>
        {values.addressLines.map((line, i) => (
          <input
            key={i}
            className={inputClass}
            disabled={!canEdit}
            aria-label={`Address line ${i + 1}`}
            value={line}
            onChange={(e) =>
              setValues({ ...values, addressLines: values.addressLines.map((l, j) => (j === i ? e.target.value : l)) })
            }
          />
        ))}
      </fieldset>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Office phone</span>
          <input className={inputClass} disabled={!canEdit} value={values.phone} onChange={set("phone")} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Fax (optional)</span>
          <input className={inputClass} disabled={!canEdit} value={values.fax} onChange={set("fax")} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Email</span>
          <input className={inputClass} disabled={!canEdit} type="email" value={values.email} onChange={set("email")} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Website (optional)</span>
          <input className={inputClass} disabled={!canEdit} value={values.website} onChange={set("website")} />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Licensure line (optional)</span>
        <input
          className={inputClass}
          disabled={!canEdit}
          placeholder="A line your letterhead prints under the address, if any"
          value={values.licensureLine}
          onChange={set("licensureLine")}
        />
      </label>
      {hasNonAscii && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Some details use characters outside plain ASCII (for example accented letters). The I-130 expedite
          letter generator prints plain ASCII only and stops on them.
        </p>
      )}
      {canEdit && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={isPending}
            onClick={handleSave}
            className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            {isPending ? "Saving..." : "Save letterhead"}
          </button>
          {message && (
            <span className={message.tone === "ok" ? "text-sm text-green-700 dark:text-green-400" : "text-sm text-red-600"}>
              {message.text}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
