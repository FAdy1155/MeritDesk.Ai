import "server-only";
import { and, eq } from "drizzle-orm";
import { withTenantContext, type db, type TenantTransactionRunner } from "@/db/client";
import { tenantConnectorSettings } from "@/db/schema";
import { AUDIT_ACTIONS, recordAuditEvent } from "@/lib/audit/service";
import { CONNECTOR_DISCLOSURE_VERSION } from "./disclosure";

// A firm's connector switches (tenant_connector_settings, migration 0012):
// whether the connector's case-work tools are on, and whether they may hand
// out short-lived download links for clean documents. The library tools need
// no switch. Changed only by an owner/admin (CONNECTOR_SETTINGS_ROLES, checked
// by the Firm page's action), and every change is audited in the same
// transaction. inTenant is withTenantContext in the app (the connector check
// script passes a PGlite runner).

/** A refusal the owner/admin can act on; the action returns its message instead of throwing it. */
export class ConnectorSettingsRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorSettingsRequestError";
  }
}

export type ConnectorSettingsView = {
  /** What the connector applies: the switch is on and the acknowledged disclosure is the current one. */
  caseWorkActive: boolean;
  /** The stored switch, whatever disclosure it was acknowledged under. */
  caseWorkSwitch: boolean;
  /** The switch is on, but under an older disclosure: an owner/admin must acknowledge the new one. */
  disclosureOutdated: boolean;
  disclosureVersion: string | null;
  disclosureAcknowledgedBy: string | null;
  disclosureAcknowledgedAt: Date | null;
  /** Download links for clean documents (only while case work is active). */
  allowDocumentDownloads: boolean;
  updatedAt: Date | null;
};

type SettingsRow = typeof tenantConnectorSettings.$inferSelect;

function toView(row: SettingsRow | null): ConnectorSettingsView {
  const caseWorkSwitch = row?.caseWorkEnabled ?? false;
  const current = row?.disclosureVersion === CONNECTOR_DISCLOSURE_VERSION;
  return {
    caseWorkActive: caseWorkSwitch && current,
    caseWorkSwitch,
    disclosureOutdated: caseWorkSwitch && !current,
    disclosureVersion: row?.disclosureVersion ?? null,
    disclosureAcknowledgedBy: row?.disclosureAcknowledgedBy ?? null,
    disclosureAcknowledgedAt: row?.disclosureAcknowledgedAt ?? null,
    allowDocumentDownloads: row?.allowDocumentDownloads ?? false,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** The settings inside a caller's withTenantContext transaction for tenantId (the connector reads them with each call). */
export async function readConnectorSettings(tx: typeof db, tenantId: string): Promise<ConnectorSettingsView> {
  const [row] = await tx
    .select()
    .from(tenantConnectorSettings)
    .where(eq(tenantConnectorSettings.tenantId, tenantId))
    .limit(1);
  return toView(row ?? null);
}

export async function getConnectorSettings(
  tenantId: string,
  inTenant: TenantTransactionRunner = withTenantContext
): Promise<ConnectorSettingsView> {
  return inTenant(tenantId, (tx) => readConnectorSettings(tx, tenantId));
}

export type ConnectorSettingsInput = {
  caseWorkEnabled: boolean;
  /** Required to turn case work on (or keep it on after the disclosure changed): the version the owner/admin read. */
  acknowledgedDisclosureVersion?: string | null;
  allowDocumentDownloads: boolean;
};

/**
 * Saves the switches. Turning case work on needs the current disclosure
 * version, acknowledged by this user (the Firm page sends the version it
 * showed, so an acknowledgment of an older text is refused). Turning it off
 * needs nothing and keeps the earlier acknowledgment on record. Download
 * links can be on only while case work is. Writes nothing when nothing
 * changed; otherwise upserts the row and records connector_settings.update
 * in the same transaction, with the row locked so two saves are serialized.
 */
export async function updateConnectorSettings(
  tenantId: string,
  actorUserId: string,
  input: ConnectorSettingsInput,
  inTenant: TenantTransactionRunner = withTenantContext
): Promise<ConnectorSettingsView> {
  return inTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(tenantConnectorSettings)
      .where(eq(tenantConnectorSettings.tenantId, tenantId))
      .limit(1)
      .for("update");
    const before = toView(existing ?? null);

    const acknowledging = input.caseWorkEnabled && !before.caseWorkActive;
    if (acknowledging && input.acknowledgedDisclosureVersion !== CONNECTOR_DISCLOSURE_VERSION) {
      throw new ConnectorSettingsRequestError(
        "Read and acknowledge the disclosure before turning case work on (the page may be out of date: reload it)."
      );
    }
    const allowDocumentDownloads = input.caseWorkEnabled && input.allowDocumentDownloads;
    if (input.allowDocumentDownloads && !input.caseWorkEnabled) {
      throw new ConnectorSettingsRequestError("Document download links need case work turned on.");
    }

    if (
      !acknowledging &&
      before.caseWorkSwitch === input.caseWorkEnabled &&
      before.allowDocumentDownloads === allowDocumentDownloads
    ) {
      return before;
    }

    const now = new Date();
    const values = {
      caseWorkEnabled: input.caseWorkEnabled,
      allowDocumentDownloads,
      updatedBy: actorUserId,
      updatedAt: now,
      ...(acknowledging
        ? {
            disclosureVersion: CONNECTOR_DISCLOSURE_VERSION,
            disclosureAcknowledgedBy: actorUserId,
            disclosureAcknowledgedAt: now,
          }
        : {}),
    };
    const [row] = existing
      ? await tx
          .update(tenantConnectorSettings)
          .set(values)
          .where(and(eq(tenantConnectorSettings.id, existing.id), eq(tenantConnectorSettings.tenantId, tenantId)))
          .returning()
      : await tx
          .insert(tenantConnectorSettings)
          .values({ tenantId, ...values })
          .returning();
    const after = toView(row);

    await recordAuditEvent(tx, {
      tenantId,
      actorUserId,
      action: AUDIT_ACTIONS.connectorSettingsUpdated,
      resourceType: "connector_settings",
      resourceId: row.id,
      before: {
        caseWorkEnabled: before.caseWorkSwitch,
        allowDocumentDownloads: before.allowDocumentDownloads,
        disclosureVersion: before.disclosureVersion,
      },
      after: {
        caseWorkEnabled: after.caseWorkSwitch,
        allowDocumentDownloads: after.allowDocumentDownloads,
        disclosureVersion: after.disclosureVersion,
        disclosureAcknowledged: acknowledging,
      },
    });
    return after;
  });
}
