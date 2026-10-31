"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useOrganizationList } from "@clerk/nextjs";
import { createFirmAction } from "./actions";

const inputClass = "rounded-md border border-black/15 bg-transparent px-3 py-1.5 text-sm disabled:opacity-60 dark:border-white/20";
const buttonClass = "rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black";

/**
 * The create-firm form: the server creates the organization, the tenant
 * and the billing row (createFirmAction; the free month when the person
 * has not had one), then this makes the new organization the active one
 * in the session (Clerk's setActive) and goes to the Connect page, which
 * explains how to add the connector to Claude.
 */
export function CreateFirmForm() {
  const router = useRouter();
  const { setActive, isLoaded } = useOrganizationList();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createFirmAction(name);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (setActive) await setActive({ organization: result.clerkOrgId });
      router.push("/connect");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Create your firm">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Firm name</span>
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          required
          disabled={isPending}
          placeholder="The Law Office of ..."
        />
      </label>
      <button type="submit" className={buttonClass} disabled={isPending || !isLoaded || name.trim().length < 2}>
        {isPending ? "Creating the firm..." : "Create the firm"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
