"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { BILLING_ROLES, ForbiddenRoleError, getCurrentTenant, requireRole } from "@/lib/tenant";
import { BillingRequestError, type BillingErrorCode } from "@/lib/billing/errors";
import { openBillingPortal, startCheckout } from "@/lib/billing/service";
import { BillingNotConfiguredError } from "@/lib/billing/stripe";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { resolveConnectorOrigin } from "@/services/connector/config";

// The Billing page's two buttons, as form actions: each checks the role
// (owner/admin only), does its Stripe call through src/lib/billing/service.ts
// and sends the browser to Stripe's hosted page. These use getCurrentTenant,
// not getCurrentEntitledTenant: a locked firm must be able to subscribe. An
// expected refusal goes back to the page as ?error=<code>, a short code the
// page maps to fixed text (src/lib/billing/errors.ts); the details are
// logged here, never put in the URL. redirect() is called outside the try
// block, as Next requires.

/** Stripe's return links use the app's public origin (CONNECTOR_PUBLIC_ORIGIN; in development the request's host). */
async function currentOrigin(): Promise<string> {
  const { origin } = resolveConnectorOrigin(await headers());
  if (!origin) throw new BillingRequestError("origin_missing");
  return origin;
}

/** The code for an expected refusal, or null for anything else (rethrown, so the error page shows). */
function errorCode(err: unknown): BillingErrorCode | null {
  if (err instanceof BillingRequestError) return err.code;
  if (err instanceof BillingNotConfiguredError) return "not_configured";
  if (err instanceof ForbiddenRoleError) return "forbidden";
  return null;
}

export async function startCheckoutAction(): Promise<void> {
  let url: string;
  let code: BillingErrorCode | null = null;
  try {
    const { tenant, membership, userId } = await getCurrentTenant();
    requireRole(membership, BILLING_ROLES, "subscribe the firm");
    ({ url } = await startCheckout({ tenantId: tenant.id, tenantName: tenant.name, actorUserId: userId, origin: await currentOrigin() }));
  } catch (err) {
    code = errorCode(err);
    if (!code) {
      // Stripe refused or was unreachable: the page shows a fixed sentence; the cause goes to the log.
      console.error(`[billing] startCheckoutAction failed: ${describeErrorForLog(err)}`);
      code = "checkout_failed";
    }
    url = "";
  }
  if (code) redirect(`/billing?error=${code}`);
  redirect(url);
}

export async function openBillingPortalAction(): Promise<void> {
  let url: string;
  let code: BillingErrorCode | null = null;
  try {
    const { tenant, membership, userId } = await getCurrentTenant();
    requireRole(membership, BILLING_ROLES, "manage the firm's billing");
    ({ url } = await openBillingPortal({ tenantId: tenant.id, actorUserId: userId, origin: await currentOrigin() }));
  } catch (err) {
    code = errorCode(err);
    if (!code) {
      console.error(`[billing] openBillingPortalAction failed: ${describeErrorForLog(err)}`);
      code = "portal_unavailable";
    }
    url = "";
  }
  if (code) redirect(`/billing?error=${code}`);
  redirect(url);
}
