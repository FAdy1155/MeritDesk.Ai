import Link from "next/link";
import { headers } from "next/headers";
import { CONNECTOR_SETTINGS_ROLES, FIRM_IDENTITY_EDIT_ROLES, MEMBERS_MANAGE_ROLES, getCurrentTenant, hasRole } from "@/lib/tenant";
import { getFirmIdentityPageData } from "@/lib/firm-identity/service";
import { missingFirmIdentityFields } from "@/lib/firm-identity/schema";
import { getConnectorSettings } from "@/lib/connector/settings";
import { listUnrecognizedConnectorClients } from "@/lib/connector/unrecognized-clients";
import { listFirmMembers } from "@/lib/tenants/members";
import {
  connectorClientAllowListConfigured,
  connectorResourceUrl,
  resolveConnectorOrigin,
} from "@/services/connector/config";
import { FirmIdentityForm } from "./FirmIdentityForm";
import { AttorneyRoster } from "./AttorneyRoster";
import { ConnectorSettings } from "./ConnectorSettings";
import { MembersList } from "./MembersList";

export default async function FirmPage() {
  const { tenant, membership, userId } = await getCurrentTenant();
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
  // Null in production until CONNECTOR_PUBLIC_ORIGIN is set (the connector itself answers 500 until then).
  const { origin: connectorPublicOrigin } = resolveConnectorOrigin(await headers());
  const serverUrl = connectorPublicOrigin ? connectorResourceUrl(connectorPublicOrigin) : null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Firm identity</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Skill runs use these details wherever the firm&apos;s skills name a law firm, an attorney, or a
          firm&apos;s contact details, and document generators print them as the letterhead and signature
          block. A run uses the details as they were when it was queued.
        </p>
      </div>

      {missing.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          Firm identity setup is incomplete. Missing: {missing.join("; ")}. Until it is complete, skill runs write
          bracketed placeholders such as [FIRM NAME] in its place and flag them in their reports.
        </div>
      )}

      {!canEdit && (
        <p className="text-sm text-black/60 dark:text-white/60">
          Only an owner/admin or an attorney can change the firm identity, the roster, or signature images.
        </p>
      )}

      <FirmIdentityForm initialIdentity={identity} canEdit={canEdit} />
      <AttorneyRoster attorneys={attorneys} canEdit={canEdit} />
      <MembersList members={members} canManage={canManageMembers} currentUserId={userId} />
      <p className="text-sm text-black/70 dark:text-white/70">
        Adding the connector to Claude or ChatGPT, step by step, is on the{" "}
        <Link href="/connect" className="underline">
          Connect page
        </Link>
        . The switches below decide what the connector may read.
      </p>
      <ConnectorSettings
        initialSettings={connectorSettings}
        canManage={canManageConnector}
        serverUrl={serverUrl}
        clientAllowListConfigured={connectorClientAllowListConfigured()}
        unrecognizedClients={unrecognizedClients}
      />
    </div>
  );
}
