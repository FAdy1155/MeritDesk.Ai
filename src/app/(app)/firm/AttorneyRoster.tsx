"use client";

import { useRef, useState, useTransition } from "react";
import {
  SIGNATURE_MAX_BYTES,
  SIGNATURE_MAX_HEIGHT_PX,
  SIGNATURE_MAX_WIDTH_PX,
  type FirmAttorneyInput,
  type FirmAttorneyView,
} from "@/lib/firm-identity/schema";
import {
  addFirmAttorneyAction,
  previewFirmSignatureAction,
  removeFirmAttorneyAction,
  removeFirmSignatureAction,
  updateFirmAttorneyAction,
  uploadFirmSignatureAction,
} from "./actions";
import { inputClass, labelClass, sectionClass } from "./FirmIdentityForm";

const ROLE_LABELS: Record<FirmAttorneyView["role"], string> = {
  attorney: "Attorney",
  accredited_representative: "Accredited representative",
};

const buttonClass =
  "rounded-md border border-black/15 px-3 py-1 text-xs font-medium disabled:opacity-50 dark:border-white/20";
const primaryButtonClass =
  "rounded-md bg-black px-3 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black";

function toInput(attorney: FirmAttorneyView | null, firstEntry: boolean): Required<FirmAttorneyInput> {
  return {
    fullName: attorney?.fullName ?? "",
    title: attorney?.title ?? "",
    role: attorney?.role ?? "attorney",
    barState: attorney?.barState ?? "",
    barNumber: attorney?.barNumber ?? "",
    eoirId: attorney?.eoirId ?? "",
    email: attorney?.email ?? "",
    isDefaultSigner: attorney?.isDefaultSigner ?? firstEntry,
  };
}

export function AttorneyRoster({ attorneys, canEdit }: { attorneys: FirmAttorneyView[]; canEdit: boolean }) {
  const [editing, setEditing] = useState<string | null>(null); // a roster id, "new", or null

  return (
    <section className={sectionClass}>
      <h2 className="font-semibold">Attorneys and accredited representatives</h2>
      <p className="text-xs text-black/60 dark:text-white/60">
        The default signer signs generated documents unless the matter or the case note names someone else on
        this roster. A signature image, when on file, is placed above the signer&apos;s typed name; without one,
        documents carry a /s/ line instead.
      </p>
      {attorneys.length === 0 && editing !== "new" && (
        <p className="text-sm text-black/60 dark:text-white/60">No one is on the roster yet.</p>
      )}
      <ul className="flex flex-col gap-3">
        {attorneys.map((attorney) =>
          editing === attorney.id ? (
            <li key={attorney.id}>
              <AttorneyForm attorney={attorney} firstEntry={false} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={attorney.id}>
              <AttorneyCard attorney={attorney} canEdit={canEdit} onEdit={() => setEditing(attorney.id)} />
            </li>
          )
        )}
      </ul>
      {canEdit &&
        (editing === "new" ? (
          <AttorneyForm attorney={null} firstEntry={attorneys.length === 0} onDone={() => setEditing(null)} />
        ) : (
          <div>
            <button type="button" className={primaryButtonClass} onClick={() => setEditing("new")}>
              Add a person
            </button>
          </div>
        ))}
    </section>
  );
}

function AttorneyCard({
  attorney,
  canEdit,
  onEdit,
}: {
  attorney: FirmAttorneyView;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleRemove() {
    if (!window.confirm(`Remove ${attorney.fullName} from the roster? Their signature image is removed with them.`)) return;
    setError(null);
    startTransition(async () => {
      const result = await removeFirmAttorneyAction(attorney.id);
      if (!result.ok) setError(result.error);
    });
  }

  const details = [
    ROLE_LABELS[attorney.role],
    attorney.title,
    attorney.role === "attorney" && attorney.barNumber
      ? `Bar: ${attorney.barState ? `${attorney.barState} ` : ""}No. ${attorney.barNumber}`
      : null,
    attorney.eoirId ? `EOIR ID: ${attorney.eoirId}` : null,
    attorney.email,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-black/10 p-3 dark:border-white/10">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{attorney.fullName}</span>
        {attorney.isDefaultSigner && (
          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-900 dark:bg-blue-950 dark:text-blue-100">
            Default signer
          </span>
        )}
        {canEdit && (
          <span className="ml-auto flex gap-2">
            <button type="button" className={buttonClass} disabled={isPending} onClick={onEdit}>
              Edit
            </button>
            <button type="button" className={buttonClass} disabled={isPending} onClick={handleRemove}>
              Remove
            </button>
          </span>
        )}
      </div>
      <p className="text-xs text-black/60 dark:text-white/60">{details.join(" - ")}</p>
      {attorney.role === "attorney" && !attorney.barNumber && (
        <p className="text-xs text-amber-700 dark:text-amber-300">No bar number on file.</p>
      )}
      <SignatureControls attorney={attorney} canEdit={canEdit} />
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

function SignatureControls({ attorney, canEdit }: { attorney: FirmAttorneyView; canEdit: boolean }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const signature = attorney.signature;

  function handleUpload() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setError(null);
    if (file.size > SIGNATURE_MAX_BYTES) {
      setError(`The file is ${Math.ceil(file.size / 1024)} KB; signature images are limited to ${SIGNATURE_MAX_BYTES / 1024} KB.`);
      return;
    }
    const formData = new FormData();
    formData.set("attorneyId", attorney.id);
    formData.set("file", file);
    startTransition(async () => {
      const result = await uploadFirmSignatureAction(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreviewUrl(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    });
  }

  function handlePreview() {
    setError(null);
    startTransition(async () => {
      const result = await previewFirmSignatureAction(attorney.id);
      if (result.ok) setPreviewUrl(result.url);
      else setError(result.error);
    });
  }

  function handleRemoveSignature() {
    if (!window.confirm(`Remove ${attorney.fullName}'s signature image? Later documents get a /s/ line instead.`)) return;
    setError(null);
    startTransition(async () => {
      const result = await removeFirmSignatureAction(attorney.id);
      if (result.ok) setPreviewUrl(null);
      else setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-2 border-t border-black/5 pt-2 dark:border-white/5">
      <p className="text-xs">
        {signature
          ? `Signature image on file (${signature.mediaType === "image/png" ? "PNG" : "JPEG"}${
              signature.widthPx && signature.heightPx ? `, ${signature.widthPx} x ${signature.heightPx} px` : ""
            }, uploaded ${new Date(signature.uploadedAt).toLocaleDateString()}).`
          : "No signature image on file."}
      </p>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg"
            className="text-xs"
            aria-label={`Signature image for ${attorney.fullName}`}
          />
          <button type="button" className={buttonClass} disabled={isPending} onClick={handleUpload}>
            {signature ? "Replace signature" : "Upload signature"}
          </button>
          {signature && (
            <>
              {previewUrl ? (
                <button type="button" className={buttonClass} onClick={() => setPreviewUrl(null)}>
                  Hide
                </button>
              ) : (
                <button type="button" className={buttonClass} disabled={isPending} onClick={handlePreview}>
                  Show signature
                </button>
              )}
              <button type="button" className={buttonClass} disabled={isPending} onClick={handleRemoveSignature}>
                Remove signature
              </button>
            </>
          )}
        </div>
      )}
      {canEdit && (
        <p className="text-xs text-black/50 dark:text-white/50">
          PNG or JPEG, up to {SIGNATURE_MAX_BYTES / 1024} KB and {SIGNATURE_MAX_WIDTH_PX} x {SIGNATURE_MAX_HEIGHT_PX} px,
          cropped to the signature on a white or transparent background. Image metadata is removed on upload.
        </p>
      )}
      {previewUrl && (
        // A short-lived presigned URL, fetched by the browser directly: next/image
        // would fetch and cache the signature on the server instead.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={previewUrl}
          alt={`Signature of ${attorney.fullName}`}
          referrerPolicy="no-referrer"
          className="max-h-24 w-fit rounded border border-black/10 bg-white p-2 dark:border-white/10"
        />
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

function AttorneyForm({
  attorney,
  firstEntry,
  onDone,
}: {
  attorney: FirmAttorneyView | null;
  firstEntry: boolean;
  onDone: () => void;
}) {
  const [values, setValues] = useState(() => toInput(attorney, firstEntry));
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const isAttorney = values.role === "attorney";

  const set = (field: "fullName" | "title" | "barState" | "barNumber" | "eoirId" | "email") =>
    (e: React.ChangeEvent<HTMLInputElement>) => setValues({ ...values, [field]: e.target.value });

  function handleSave() {
    setError(null);
    // Bar details belong to attorneys only.
    const input = isAttorney ? values : { ...values, barState: "", barNumber: "" };
    startTransition(async () => {
      const result = attorney
        ? await updateFirmAttorneyAction(attorney.id, input)
        : await addFirmAttorneyAction(input);
      if (result.ok) onDone();
      else setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-black/15 p-3 dark:border-white/20">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Full name</span>
          <input className={inputClass} value={values.fullName} onChange={set("fullName")} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Title (optional)</span>
          <input className={inputClass} value={values.title} onChange={set("title")} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Role</span>
          <select
            className={inputClass}
            value={values.role}
            onChange={(e) => setValues({ ...values, role: e.target.value as FirmAttorneyView["role"] })}
          >
            {Object.entries(ROLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Email (optional)</span>
          <input className={inputClass} type="email" value={values.email} onChange={set("email")} />
        </label>
        {isAttorney && (
          <>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Bar state</span>
              <input className={inputClass} value={values.barState} onChange={set("barState")} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Bar number</span>
              <input className={inputClass} value={values.barNumber} onChange={set("barNumber")} />
            </label>
          </>
        )}
        <label className="flex flex-col gap-1">
          <span className={labelClass}>EOIR ID (optional)</span>
          <input className={inputClass} value={values.eoirId} onChange={set("eoirId")} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={values.isDefaultSigner}
          onChange={(e) => setValues({ ...values, isDefaultSigner: e.target.checked })}
        />
        Default signer
        {firstEntry && <span className="text-xs text-black/50 dark:text-white/50">(the first person added always is)</span>}
      </label>
      <div className="flex items-center gap-2">
        <button type="button" className={primaryButtonClass} disabled={isPending} onClick={handleSave}>
          {isPending ? "Saving..." : attorney ? "Save" : "Add to roster"}
        </button>
        <button type="button" className={buttonClass} disabled={isPending} onClick={onDone}>
          Cancel
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  );
}
