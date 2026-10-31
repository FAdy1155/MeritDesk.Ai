import { EDITOR_ROLES, getCurrentTenant, hasRole } from "@/lib/tenant";
import { listClients } from "@/lib/matters/service";
import { createClientAction } from "./actions";

async function createClientFromForm(formData: FormData) {
  "use server";
  await createClientAction({
    fullName: String(formData.get("fullName") ?? ""),
    aNumber: String(formData.get("aNumber") ?? "") || undefined,
    dateOfBirth: String(formData.get("dateOfBirth") ?? "") || undefined,
    countryOfBirth: String(formData.get("countryOfBirth") ?? "") || undefined,
    primaryLanguage: String(formData.get("primaryLanguage") ?? "") || undefined,
    contactEmail: String(formData.get("contactEmail") ?? "") || undefined,
    contactPhone: String(formData.get("contactPhone") ?? "") || undefined,
  });
}

const inputClass =
  "rounded-md border border-black/15 bg-transparent px-3 py-1.5 text-sm dark:border-white/20";

export default async function ClientsPage() {
  const { tenant, membership } = await getCurrentTenant();
  // read_only members can browse but not create (the action checks this too).
  const canEdit = hasRole(membership, EDITOR_ROLES);
  const clientRows = await listClients(tenant.id);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <h1 className="text-xl font-semibold">Clients</h1>

      {canEdit && (
        <form action={createClientFromForm} className="grid grid-cols-2 gap-3 rounded-lg border border-black/10 p-4 dark:border-white/10">
          <input name="fullName" placeholder="Full legal name" required className={`${inputClass} col-span-2`} />
          <input name="aNumber" placeholder="A-Number" className={inputClass} />
          <input name="dateOfBirth" type="date" placeholder="Date of birth" className={inputClass} />
          <input name="countryOfBirth" placeholder="Country of birth" className={inputClass} />
          <input name="primaryLanguage" placeholder="Primary language" className={inputClass} />
          <input name="contactEmail" type="email" placeholder="Contact email" className={inputClass} />
          <input name="contactPhone" placeholder="Contact phone" className={inputClass} />
          <button type="submit" className="col-span-2 rounded-md bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black">
            Add client
          </button>
        </form>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-black/10 text-left dark:border-white/10">
            <th className="py-2">Name</th>
            <th>A-Number</th>
            <th>Country</th>
            <th>Language</th>
          </tr>
        </thead>
        <tbody>
          {clientRows.map((c) => (
            <tr key={c.id} className="border-b border-black/5 dark:border-white/5">
              <td className="py-2">{c.fullName}</td>
              <td>{c.aNumber ?? "—"}</td>
              <td>{c.countryOfBirth ?? "—"}</td>
              <td>{c.primaryLanguage ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
