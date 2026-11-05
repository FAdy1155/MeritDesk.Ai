import Link from "next/link";
import { notFound } from "next/navigation";
import { EDITOR_ROLES, getCurrentTenantIfEntitled, hasRole } from "@/lib/tenant";
import { getMatter, listMatterParties, listClients } from "@/lib/matters/service";
import { caseTypeLabel } from "@/lib/matters/case-types";
import { formatMatterDate, matterStatusLabel, matterVenueLabel } from "@/lib/matters/details";
import { listDocuments } from "@/lib/documents/service";
import { getActiveProfileVersion } from "@/lib/practice-profile/service";
import { getFirmIdentityPageData } from "@/lib/firm-identity/service";
import { missingFirmIdentityFields } from "@/lib/firm-identity/schema";
import { listSkillRuns } from "@/lib/skill-runs/service";
import { readAttorneyNote, readEscalationFlags, readRetryOfRunId } from "@/lib/skill-runs/snapshot";
import { getRequesterLabels } from "@/lib/skill-runs/requesters";
import { matterPartyRoleEnum } from "@/db/schema";
import { getSkillCatalog } from "@/services/skill-runner/skills/catalog";
import { outputMatchesCurrentSchema } from "@/services/skill-runner/skills";
import { addMatterPartyAction } from "../actions";
import { DocumentUploader } from "./DocumentUploader";
import { DocumentList } from "./DocumentList";
import { MatterDetails } from "./MatterDetails";
import { SkillRunPanel, type PreRunChecks, type SkillRunForPanel } from "./SkillRunPanel";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function addPartyFromForm(formData: FormData) {
  "use server";
  const clientId = formData.get("clientId");
  if (!clientId) return;
  // addMatterPartyAction checks every value: they arrive from the browser.
  await addMatterPartyAction(formData.get("matterId"), clientId, formData.get("role"));
}

const inputClass =
  "rounded-xl border border-[#dce4ee] bg-white px-3 py-2.5 text-sm text-[#263b57] outline-none focus:border-[#7899c4] focus:ring-4 focus:ring-[#dce8f7]";

const partyRoleLabel = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);

export default async function MatterDetailPage({
  params,
}: {
  params: Promise<{ matterId: string }>;
}) {
  const { matterId } = await params;
  // A malformed id would otherwise reach a uuid column as a database error.
  if (!UUID_RE.test(matterId)) notFound();
  const current = await getCurrentTenantIfEntitled();
  if (!current) return null;
  const { tenant, membership, userId } = current;
  // read_only members see everything but change nothing; the actions behind
  // these controls check the role too.
  const canEdit = hasRole(membership, EDITOR_ROLES);
  const matter = await getMatter(tenant.id, matterId);
  if (!matter) notFound();

  const [parties, allClients, docs, skillRunRows, activeProfile, firmIdentity] = await Promise.all([
    listMatterParties(tenant.id, matterId),
    listClients(tenant.id),
    listDocuments(tenant.id, matterId),
    listSkillRuns(tenant.id, matterId),
    getActiveProfileVersion(tenant.id),
    getFirmIdentityPageData(tenant.id),
  ]);
  const requesterLabels = await getRequesterLabels(
    skillRunRows.map((run) => run.requestedBy),
    userId
  );

  // Everything the panel reads from a run's jsonb columns is parsed here, on
  // the server, and the schema checks run here too, so SkillRunPanel (a
  // Client Component) gets plain data: the zod schemas never ship to the
  // browser, and neither does the rest of input_snapshot.
  const runsForPanel: SkillRunForPanel[] = skillRunRows.map((run) => ({
    id: run.id,
    skillName: run.skillName,
    skillVersion: run.skillVersion,
    status: run.status,
    structuredOutput: run.structuredOutput,
    verificationLog: run.verificationLog,
    escalationFlags: readEscalationFlags(run.escalationFlags),
    errorMessage: run.errorMessage,
    requestedByLabel: requesterLabels[run.requestedBy] ?? run.requestedBy,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    attorneyNote: readAttorneyNote(run.inputSnapshot),
    retryOfRunId: readRetryOfRunId(run.inputSnapshot),
    outputMatchesSchema: run.status === "completed" && outputMatchesCurrentSchema(run.skillName, run.structuredOutput),
  }));

  const countScan = (status: string) => docs.filter((d) => d.malwareScanStatus === status).length;
  const preRunChecks: PreRunChecks = {
    documentCount: docs.length,
    documentsPendingScan: countScan("pending"),
    documentsNotScanned: countScan("error"),
    documentsInfected: countScan("infected"),
    practiceProfileConfirmed: activeProfile !== null,
    firmIdentityMissing: missingFirmIdentityFields({ firm: firmIdentity.identity, attorneys: firmIdentity.attorneys }),
  };

  const summary = [
    matterVenueLabel(matter.venue) ?? "No venue set",
    matterStatusLabel(matter.status),
    matter.nextHearingDate ? `Next hearing ${formatMatterDate(matter.nextHearingDate)}` : null,
  ].filter(Boolean);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-7">
      <header className="border-b border-[#e6ebf1] pb-6">
        <Link href="/matters" className="text-xs font-semibold text-[#5278a8] hover:text-[#244d83]">← All matters</Link>
        <p className="mt-4 text-[10px] font-bold uppercase tracking-[.18em] text-[#7890b2]">CASE WORKSPACE</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[#1b2e49]">{caseTypeLabel(matter.caseType)}</h1>
        <div className="mt-3 flex flex-wrap gap-2">{summary.map((item) => <span key={item} className="rounded-full border border-[#e4eaf1] bg-white px-3 py-1.5 text-xs font-medium text-[#63758d]">{item}</span>)}</div>
      </header>

      <MatterDetails
        matterId={matterId}
        canEdit={canEdit}
        details={{
          status: matter.status,
          venue: matter.venue,
          circuit: matter.circuit,
          court: matter.court,
          ntaDate: matter.ntaDate,
          oneYearClockDate: matter.oneYearClockDate,
          nextHearingDate: matter.nextHearingDate,
        }}
      />

      <section className="flex flex-col gap-4 rounded-2xl border border-[#e4eaf1] bg-white p-5 shadow-[0_8px_30px_-25px_rgba(22,43,72,.2)] sm:p-6">
        <div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-[#91a0b4]">PEOPLE</p><h2 className="mt-1 text-base font-semibold text-[#293f5e]">Parties</h2></div>
        <ul className="flex flex-col gap-2 text-sm">
          {parties.map((p) => (
            <li key={p.id}>
              {p.client.fullName} <span className="text-black/60 dark:text-white/60">({partyRoleLabel(p.role)})</span>
            </li>
          ))}
          {parties.length === 0 && <li className="text-black/50 dark:text-white/50">No parties yet.</li>}
        </ul>
        {canEdit && (
          <form action={addPartyFromForm} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="matterId" value={matterId} />
            <select name="clientId" required aria-label="Client" className={inputClass}>
              <option value="">Select client...</option>
              {allClients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.fullName}
                </option>
              ))}
            </select>
            <select name="role" required aria-label="Role in the matter" className={inputClass}>
              {matterPartyRoleEnum.enumValues.map((r) => (
                <option key={r} value={r}>
                  {partyRoleLabel(r)}
                </option>
              ))}
            </select>
            <button type="submit" className="rounded-md bg-black px-3 py-1 text-xs font-medium text-white dark:bg-white dark:text-black">
              Add party
            </button>
          </form>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-black/10 p-4 dark:border-white/10">
        <div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-[#91a0b4]">CASE FILES</p><h2 className="mt-1 text-base font-semibold text-[#293f5e]">Documents</h2></div>
        <p className="text-xs leading-6 text-[#8290a4]">
          Each upload is scanned for malware and its text extracted in the background. Only a file that scanned clean can be
          downloaded or read by a skill run: PDFs and images directly, Word and text files through their extracted text.
        </p>
        <DocumentList documents={docs} canEdit={canEdit} />
        {canEdit && <DocumentUploader matterId={matterId} />}
      </section>

      <SkillRunPanel
        matterId={matterId}
        matterCaseType={matter.caseType}
        catalog={getSkillCatalog()}
        runs={runsForPanel}
        canRun={canEdit}
        preRunChecks={preRunChecks}
      />
    </div>
  );
}
