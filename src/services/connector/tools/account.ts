import { z } from "zod";
import { formatDay } from "@/lib/billing/config";
import type { Entitlement } from "@/lib/billing/entitlement";
import { defineConnectorTool, type ConnectorTool } from "../types";
import { lockedFirmMessage, textResult, unrecognizedClientMessage } from "./results";

// get_connection_info: who the connection acts as and what it offers, so a
// member can check the firm and role a connection uses (a member of several
// firms picks one when connecting) without the app's web page, and where
// the firm's free month or subscription stands. Not tenant client data: no
// audit entry. The one tool a locked firm keeps.

const ROLE_LABELS: Record<string, string> = {
  owner_admin: "owner/admin",
  attorney: "attorney",
  paralegal: "paralegal",
  read_only: "read-only",
};

/** The firm's billing standing in a sentence; subscribing is always on the website. */
function billingLine(entitlement: Entitlement, billingUrl: string): string {
  switch (entitlement.state) {
    case "trialing":
      return `Free month: ${entitlement.trialDaysLeft === 1 ? "1 day" : `${entitlement.trialDaysLeft} days`} left${entitlement.trialEndsAt ? ` (ends ${formatDay(entitlement.trialEndsAt)})` : ""}. The firm's owner subscribes on the website, never here: ${billingUrl}`;
    case "active":
      if (entitlement.reason === "complimentary") return `Access: complimentary (no subscription needed). Billing is managed on the website: ${billingUrl}`;
      return entitlement.subscription?.cancelAtPeriodEnd && entitlement.subscription.currentPeriodEnd
        ? `Subscription: ends ${formatDay(entitlement.subscription.currentPeriodEnd)} (cancellation scheduled); the firm's owner can renew it at ${billingUrl}`
        : `Subscription: active${entitlement.subscription?.currentPeriodEnd ? `, next payment ${formatDay(entitlement.subscription.currentPeriodEnd)}` : ""}. Billing is managed on the website: ${billingUrl}`;
    case "past_due":
      return `A payment failed; full access continues until ${entitlement.graceEndsAt ? formatDay(entitlement.graceEndsAt) : "the grace period ends"}. The firm's owner updates the card on the website: ${billingUrl}`;
    case "locked":
      return lockedFirmMessage(entitlement, billingUrl);
  }
}

const connectionInfoTool = defineConnectorTool({
  name: "get_connection_info",
  title: "Show this connection's firm and access",
  description:
    "The firm this connection acts for, the user's role in it, where the firm's free month or subscription stands (subscribing happens on the MeritDesk.AI website, never here), and which tools are on: the library tools always; the case-work tools only when the firm's owner/admin has turned them on in the app and the connection comes from a recognized Claude or ChatGPT client; document download links only when the firm allows them.",
  group: "account",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(_input, { identity, settings, entitlement, billingUrl }) {
    const locked = entitlement.state === "locked";
    const caseWorkHere = settings.caseWorkActive && identity.clientAllowed;
    const lines = [
      `Firm: ${identity.tenantName}`,
      `Role: ${ROLE_LABELS[identity.role] ?? identity.role}`,
      billingLine(entitlement, billingUrl),
      locked ? "" : "Library tools (official sources and EOIR statistics): on.",
      locked
        ? ""
        : caseWorkHere
          ? "Case-work tools (matters, documents lists, skills, skill runs, legal updates): on, turned on by the firm's owner/admin. Every case-work call is recorded in the firm's audit log."
          : settings.caseWorkActive
            ? unrecognizedClientMessage(identity.oauthClientId)
            : settings.disclosureOutdated
              ? "Case-work tools: off until the firm's owner/admin acknowledges the updated disclosure on the app's Firm page."
              : "Case-work tools: off. The firm's owner/admin can turn them on from the app's Firm page.",
      !locked && caseWorkHere
        ? `Document download links: ${settings.allowDocumentDownloads ? "on for owner/admin, attorney and paralegal roles (clean documents only, links expire after a few minutes)" : "off"}.`
        : "",
      "To act for a different firm, disconnect and connect again, choosing that firm on the sign-in consent screen.",
    ];
    return textResult(lines.filter(Boolean).join("\n"));
  },
});

export const ACCOUNT_TOOLS: readonly ConnectorTool[] = [connectionInfoTool];
