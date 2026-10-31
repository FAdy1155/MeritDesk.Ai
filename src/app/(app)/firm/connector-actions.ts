"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CONNECTOR_SETTINGS_ROLES, ForbiddenRoleError, getCurrentEntitledTenant, requireRole } from "@/lib/tenant";
import { EntitlementLockedError } from "@/lib/billing/entitlement";
import {
  ConnectorSettingsRequestError,
  updateConnectorSettings,
  type ConnectorSettingsView,
} from "@/lib/connector/settings";

// The Firm page's connector switches (src/lib/connector/settings.ts). A
// locked firm changes nothing (getCurrentEntitledTenant); only an
// owner/admin may change them; the input arrives from the browser and is
// validated here; the service checks the disclosure version and audits.

type ActionResult = { ok: true; settings: ConnectorSettingsView } | { ok: false; error: string };

const inputSchema = z.object({
  caseWorkEnabled: z.boolean(),
  acknowledgedDisclosureVersion: z.string().max(40).nullable().optional(),
  allowDocumentDownloads: z.boolean(),
});

export async function updateConnectorSettingsAction(input: unknown): Promise<ActionResult> {
  try {
    const { tenant, membership, userId } = await getCurrentEntitledTenant("change the firm's Claude and ChatGPT connector settings");
    requireRole(membership, CONNECTOR_SETTINGS_ROLES, "change the firm's Claude and ChatGPT connector settings");
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Invalid settings." };
    const settings = await updateConnectorSettings(tenant.id, userId, parsed.data);
    revalidatePath("/firm");
    return { ok: true, settings };
  } catch (err) {
    if (err instanceof ConnectorSettingsRequestError || err instanceof ForbiddenRoleError || err instanceof EntitlementLockedError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}
