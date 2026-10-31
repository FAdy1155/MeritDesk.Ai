"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { EDITOR_ROLES, getCurrentEntitledTenant, requireRole } from "@/lib/tenant";
import { createClient } from "@/lib/matters/service";

// The clients page's create form. A Server Action can be called with any
// value, so the input is checked here: known fields only (others are
// dropped), each a string of bounded length, the date in the form's
// YYYY-MM-DD shape. Skill runs and generated documents read these values.
const optionalText = (max: number) => z.string().trim().max(max).optional();
const newClientInputSchema = z.object({
  fullName: z.string().trim().min(1, "Full legal name is required.").max(200),
  aNumber: optionalText(20),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be a date.")
    .optional(),
  countryOfBirth: optionalText(100),
  primaryLanguage: optionalText(100),
  contactEmail: optionalText(254),
  contactPhone: optionalText(50),
});

export async function createClientAction(input: unknown) {
  // A locked firm (free month or subscription ended) adds no clients; the error's message says to subscribe.
  const { tenant, membership, userId } = await getCurrentEntitledTenant("add clients");
  requireRole(membership, EDITOR_ROLES, "add clients");
  const parsed = newClientInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join(" "));
  const row = await createClient(tenant.id, userId, parsed.data);
  revalidatePath("/clients");
  return row;
}
