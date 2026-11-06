import Link from "next/link";
import { CONNECTOR_SETTINGS_ROLES, FIRM_IDENTITY_EDIT_ROLES, MEMBERS_MANAGE_ROLES, getCurrentTenantIfEntitled, hasRole } from "@/lib/tenant";
import { getFirmIdentityPageData } from "@/lib/firm-identity/service";
import { missingFirmIdentityFields } from "@/lib/firm-identity/schema";
import { getConnectorSettings } from "@/lib/connector/settings";
import { listUnrecognizedConnectorClients } from "@/lib/connector/unrecognized-clients";
import { listFirmMembers } from "@/lib/tenants/members";
import {
  connectorClientAllowListConfigured,
  connectorEndpointHelp,
  connectorListenPortMismatch,
  connectorPublicSurface,
} from "@/services/connector/config";
import { FirmIdentityForm } from "./FirmIdentityForm";
import { AttorneyRoster } from "./AttorneyRoster";
import { ConnectorSettings } from "./ConnectorSettings";
import { MembersList } from "./MembersList";

export default async function FirmPage() {
  const current = await getCurrentTenantIfEntitled();
  if (!current) return null;
  const { tenant, membership, userId } = current;
  // The actions check the role too; this only hides controls the role cannot use.
  const canEdit = hasRole(membership, FIRM_IDENTITY_EDIT_ROLES);
  const canManageConnector = hasRole(membership, CONNECTOR_SETTINGS_ROLES);
  const canManageMembers = hasRole(membership, MEMBERS_MANAGE_ROLES);
  const [{ identity, attorneys }, connectorSettings, unrecognizedClients, members] = await Promise.all([
    getFirmIdentityPageData(tenant.id),
    getConnectorSettings(tenant.id),
    // Only the owner/admin, who manages the connector, sees which unrecognized clients members used.
    canManageConnector ? listUnrecognizedConnectorClients(tenant.id) : Promise.resolve([]),
    listFirmMembers(tenant),
  ]);
  const missing = missingFirmIdentityFields({ firm: identity, attorneys });
  const surfaceOrError = connectorPublicSurface();
  const serverUrl = "error" in surfaceOrError ? null : surfaceOrError.mcpUrl;
  const endpointNote =
    "error" in surfaceOrError
      ? surfaceOrError.error
      : [connectorEndpointHelp(surfaceOrError), connectorListenPortMismatch(surfaceOrError)].filter(Boolean).join(" ");

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-7">
      <header className="border-b border-[#e6ebf1] pb-6">
        <p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#7890b2]">WORKSPACE ADMINISTRATION</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[#1b2e49]">Firm settings</h1>
        <p className="mt-2 max-w-2xl text-sm leading-7 text-[#7b899d]">Manage the identity used in generated documents, your attorney roster, team permissions and the AI connector access policy.</p>
      </header>
      <section className="rounded-2xl border border-[#dce5f0] bg-[linear-gradient(120deg,#f8fafd,#eef3fa)] p-5 sm:p-6">
        <p className="text-[10px] font-bold uppercase tracking-[.16em] text-[#7189aa]">FIRM LETTERHEAD</p>
        <h2 className="mt-2 text-base font-semibold text-[#293f5e]">Keep generated documents consistent</h2>
        <p className="mt-1 text-sm leading-6 text-[#718198]">Skill runs use the saved firm and attorney details when creating letters, signature blocks and other documents. A run keeps the details that were saved when it was queued.</p>
      </section>

      {missing.length > 0 && (
        <div className="rounded-2xl border border-[#f0dfbd] bg-[#fff9ef] p-4 text-sm leading-6 text-[#8a642c]">
          Firm identity setup is incomplete. Missing: {missing.join("; ")}. Until it is complete, skill runs write
          bracketed placeholders such as [FIRM NAME] in its place and flag them in their reports.
        </div>
      )}

      {!canEdit && (
        <p className="rounded-xl border border-[#e4eaf1] bg-white p-4 text-sm text-[#718198]">
          Only an owner/admin or an attorney can change the firm identity, the roster, or signature images.
        </p>
      )}

      <FirmIdentityForm initialIdentity={identity} canEdit={canEdit} />
      <AttorneyRoster attorneys={attorneys} canEdit={canEdit} />
      <MembersList members={members} canManage={canManageMembers} currentUserId={userId} />
      <p className="text-sm leading-6 text-[#718198]">
        Adding the connector to Claude or ChatGPT, step by step, is on the{" "}
        <Link href="/connect" className="font-semibold text-[#416da5] underline decoration-[#c4d2e4] underline-offset-2">
          Connect page
        </Link>
        . The switches below decide what the connector may read.
      </p>
      <ConnectorSettings
        initialSettings={connectorSettings}
        canManage={canManageConnector}
        serverUrl={serverUrl}
        endpointNote={endpointNote}
        clientAllowListConfigured={connectorClientAllowListConfigured()}
        unrecognizedClients={unrecognizedClients}
      />
    </div>
  );
}
