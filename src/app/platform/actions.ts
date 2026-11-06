"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { PlatformForbiddenError, setFirmSuspended } from "@/lib/platform/service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function suspendFirmAction(formData: FormData): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new PlatformForbiddenError();
  const tenantId = String(formData.get("tenantId") ?? "");
  const suspended = String(formData.get("suspended") ?? "") === "true";
  const reason = String(formData.get("reason") ?? "");
  if (!UUID_RE.test(tenantId)) throw new Error("Invalid firm id.");
  await setFirmSuspended({ actorUserId: userId, tenantId, suspended, reason: reason || null });
  revalidatePath("/platform");
}
