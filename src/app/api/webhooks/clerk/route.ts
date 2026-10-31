import { headers } from "next/headers";
import { Webhook } from "svix";
import { applyClerkEvent, defaultClerkEventDeps, type ClerkWebhookEvent } from "@/lib/tenants/clerk-events";

// Clerk's webhook endpoint, subscribed to organization.* and
// organizationMembership.* (DEPLOY.md step 8). The signature is verified
// here (svix headers, CLERK_WEBHOOK_SECRET); what each event does is in
// src/lib/tenants/clerk-events.ts: tenants and memberships kept in step
// with Clerk, a new organization's billing row and welcome email, a
// deleted organization's tenant marked deleted and its subscription
// canceled. A failure answers 500 so Clerk retries the delivery.

export async function POST(req: Request) {
  const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("CLERK_WEBHOOK_SECRET is not set");
    return new Response("Server misconfigured", { status: 500 });
  }

  const headerPayload = await headers();
  const svixId = headerPayload.get("svix-id");
  const svixTimestamp = headerPayload.get("svix-timestamp");
  const svixSignature = headerPayload.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response("Missing svix headers", { status: 400 });
  }

  const rawBody = await req.text();
  const wh = new Webhook(webhookSecret);
  let evt: ClerkWebhookEvent;
  try {
    evt = wh.verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkWebhookEvent;
  } catch (err) {
    console.error("Clerk webhook signature verification failed", err);
    return new Response("Invalid signature", { status: 400 });
  }

  await applyClerkEvent(evt, defaultClerkEventDeps());
  return new Response("ok", { status: 200 });
}
