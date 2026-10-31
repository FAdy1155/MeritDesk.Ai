import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { withTenantContext } from "@/db/client";
import { clients, matters, matterParties, matterPartyRoleEnum } from "@/db/schema";
import { AUDIT_ACTIONS, recordAuditEvent } from "@/lib/audit/service";
import { MATTER_DETAIL_FIELDS, isMatterStatus, isMatterVenue, type MatterDetailField } from "./details";
import type { MatterDetailsValues, NewMatterValues } from "./details-schema";

export type NewClientInput = {
  fullName: string;
  aNumber?: string;
  dateOfBirth?: string;
  countryOfBirth?: string;
  primaryLanguage?: string;
  contactEmail?: string;
  contactPhone?: string;
};

/** A refusal the user can act on; Server Actions return its message instead of throwing it. */
export class MatterRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatterRequestError";
  }
}

export async function listClients(tenantId: string) {
  return withTenantContext(tenantId, (tx) =>
    tx.select().from(clients).where(eq(clients.tenantId, tenantId)).orderBy(desc(clients.createdAt))
  );
}

/**
 * Creates a client record. Only the listed fields are stored, each by name,
 * so nothing else in `input` (a tenantId, an id) can reach the insert. The
 * audit entry holds the new row's id only: client details are PII and the
 * log is permanent.
 */
export async function createClient(tenantId: string, actorUserId: string, input: NewClientInput) {
  return withTenantContext(tenantId, async (tx) => {
    const [row] = await tx
      .insert(clients)
      .values({
        fullName: input.fullName,
        aNumber: input.aNumber ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        countryOfBirth: input.countryOfBirth ?? null,
        primaryLanguage: input.primaryLanguage ?? null,
        contactEmail: input.contactEmail ?? null,
        contactPhone: input.contactPhone ?? null,
        tenantId,
      })
      .returning();
    await recordAuditEvent(tx, {
      tenantId,
      actorUserId,
      action: AUDIT_ACTIONS.clientCreated,
      resourceType: "client",
      resourceId: row.id,
    });
    return row;
  });
}

export async function listMatters(tenantId: string) {
  return withTenantContext(tenantId, (tx) =>
    tx.select().from(matters).where(eq(matters.tenantId, tenantId)).orderBy(desc(matters.createdAt))
  );
}

export async function getMatter(tenantId: string, matterId: string) {
  return withTenantContext(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(matters)
      .where(and(eq(matters.id, matterId), eq(matters.tenantId, tenantId)))
      .limit(1);
    return rows[0] ?? null;
  });
}

/** "" from a form means "not set", which the matters columns store as null. */
function orNull(value: string): string | null {
  return value === "" ? null : value;
}

/** Takes values already validated by newMatterInputSchema (src/lib/matters/details-schema.ts). */
export async function createMatter(tenantId: string, actorUserId: string, values: NewMatterValues) {
  return withTenantContext(tenantId, async (tx) => {
    const [row] = await tx
      .insert(matters)
      .values({
        tenantId,
        caseType: values.caseType,
        venue: orNull(values.venue),
        circuit: orNull(values.circuit),
        court: orNull(values.court),
        ntaDate: orNull(values.ntaDate),
        oneYearClockDate: orNull(values.oneYearClockDate),
        nextHearingDate: orNull(values.nextHearingDate),
      })
      .returning();
    await recordAuditEvent(tx, {
      tenantId,
      actorUserId,
      action: AUDIT_ACTIONS.matterCreated,
      resourceType: "matter",
      resourceId: row.id,
      after: { caseType: row.caseType },
    });
    return row;
  });
}

/**
 * Saves the matter's details form (values already validated by
 * matterDetailsInputSchema). status and venue must come from their lists,
 * except that the value already stored is accepted unchanged. Writes nothing
 * when no field changed; otherwise updates the row and records
 * matter.update in the same transaction. The audit entry names the fields
 * that changed and the status, never the other values: audit_logs is
 * permanent, and court names and case dates are matter content.
 */
export async function updateMatterDetails(
  tenantId: string,
  actorUserId: string,
  matterId: string,
  values: MatterDetailsValues
): Promise<{ changedFields: MatterDetailField[] }> {
  return withTenantContext(tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(matters)
      .where(and(eq(matters.id, matterId), eq(matters.tenantId, tenantId)))
      .limit(1)
      .for("update");
    if (!existing) throw new MatterRequestError("This matter was not found.");

    if (!isMatterStatus(values.status) && values.status !== existing.status) {
      throw new MatterRequestError("Status: choose a status from the list.");
    }
    if (values.venue !== "" && !isMatterVenue(values.venue) && values.venue !== existing.venue) {
      throw new MatterRequestError("Venue: choose a venue from the list.");
    }

    const next: Record<MatterDetailField, string | null> = {
      status: values.status,
      venue: orNull(values.venue),
      circuit: orNull(values.circuit),
      court: orNull(values.court),
      ntaDate: orNull(values.ntaDate),
      oneYearClockDate: orNull(values.oneYearClockDate),
      nextHearingDate: orNull(values.nextHearingDate),
    };
    const changedFields = MATTER_DETAIL_FIELDS.filter((field) => (existing[field] ?? null) !== next[field]);
    if (changedFields.length === 0) return { changedFields };

    await tx
      .update(matters)
      .set({ ...next, status: values.status, updatedAt: new Date() })
      .where(and(eq(matters.id, matterId), eq(matters.tenantId, tenantId)));

    await recordAuditEvent(tx, {
      tenantId,
      actorUserId,
      action: AUDIT_ACTIONS.matterUpdated,
      resourceType: "matter",
      resourceId: matterId,
      before: { status: existing.status },
      after: { changedFields, status: values.status },
    });
    return { changedFields };
  });
}

export async function listMatterParties(tenantId: string, matterId: string) {
  return withTenantContext(tenantId, (tx) =>
    tx
      .select({
        id: matterParties.id,
        role: matterParties.role,
        client: clients,
      })
      .from(matterParties)
      // Both sides filtered by tenant: a party row can never show another firm's client.
      .innerJoin(clients, and(eq(clients.id, matterParties.clientId), eq(clients.tenantId, tenantId)))
      .where(and(eq(matterParties.tenantId, tenantId), eq(matterParties.matterId, matterId)))
  );
}

export type MatterPartyRole = (typeof matterPartyRoleEnum.enumValues)[number];

export function isMatterPartyRole(value: unknown): value is MatterPartyRole {
  return typeof value === "string" && (matterPartyRoleEnum.enumValues as readonly string[]).includes(value);
}

/**
 * Adds a client to a matter in a role. matterId and clientId come from the
 * browser, and the foreign keys alone would accept another tenant's matter
 * or client (FK checks bypass RLS), so both are checked against this tenant
 * first, as initiateDocumentUpload checks its matter. Adding the same client
 * in the same role twice is refused. Audited as matter_party.create.
 */
export async function addMatterParty(
  tenantId: string,
  actorUserId: string,
  matterId: string,
  clientId: string,
  role: MatterPartyRole
) {
  return withTenantContext(tenantId, async (tx) => {
    const [matter] = await tx
      .select({ id: matters.id })
      .from(matters)
      .where(and(eq(matters.id, matterId), eq(matters.tenantId, tenantId)))
      .limit(1);
    if (!matter) throw new MatterRequestError("This matter was not found.");
    const [client] = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.id, clientId), eq(clients.tenantId, tenantId)))
      .limit(1);
    if (!client) throw new MatterRequestError("That client was not found.");

    const [existing] = await tx
      .select({ id: matterParties.id })
      .from(matterParties)
      .where(
        and(
          eq(matterParties.tenantId, tenantId),
          eq(matterParties.matterId, matterId),
          eq(matterParties.clientId, clientId),
          eq(matterParties.role, role)
        )
      )
      .limit(1);
    if (existing) throw new MatterRequestError("That client is already a party to this matter in that role.");

    const [row] = await tx.insert(matterParties).values({ tenantId, matterId, clientId, role }).returning();
    await recordAuditEvent(tx, {
      tenantId,
      actorUserId,
      action: AUDIT_ACTIONS.matterPartyAdded,
      resourceType: "matter_party",
      resourceId: row.id,
      after: { matterId, clientId, role },
    });
    return row;
  });
}
