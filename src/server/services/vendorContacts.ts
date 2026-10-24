/**
 * The people to call at a vendor (audit MD-15): the account manager, the delivery desk, accounts. A vendor has several; one
 * can be marked as the main contact. Managed by whoever manages vendors; read by whoever may see vendors. Contact details are
 * ordinary business details (a name, a phone, an e-mail): bank and UPI details stay on the vendor and stay masked.
 */
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { assertOrgWide } from "@/server/services/masterData";
import { writeAudit } from "@/server/audit/log";
import { type Client, runInTx } from "@/server/services/_workflow";

const phone = z.string().trim().regex(/^\+?[0-9][0-9 -]{4,18}$/, "Phone must be digits (spaces and dashes allowed)");
const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(60).nullable().optional(),
  phone: phone.nullable().optional(),
  email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  isPrimary: z.boolean().optional(),
}).strict();
export const MAX_CONTACTS_PER_VENDOR = 20;

async function loadVendor(tx: Client, ctx: AccessContext, vendorId: string) {
  const v = await (tx as typeof prisma).vendor.findUnique({ where: { id: vendorId }, select: { id: true, organizationId: true, name: true } });
  if (!v || v.organizationId !== ctx.organizationId) throw new NotFoundError("Vendor not found");
  return v;
}

export async function listVendorContacts(db: typeof prisma, ctx: AccessContext, vendorId: string) {
  assertCan(ctx, "vendor.view");
  await loadVendor(db, ctx, vendorId);
  return db.vendorContact.findMany({ where: { organizationId: ctx.organizationId, vendorId }, orderBy: [{ isPrimary: "desc" }, { name: "asc" }, { id: "asc" }] });
}

export async function addVendorContact(ctx: AccessContext, vendorId: string, input: z.input<typeof contactSchema>, db: Client = prisma) {
  const data = contactSchema.parse(input);
  assertOrgWide(ctx, "vendor.manage");
  return runInTx(db, async (tx) => {
    await loadVendor(tx, ctx, vendorId);
    if ((await tx.vendorContact.count({ where: { vendorId } })) >= MAX_CONTACTS_PER_VENDOR) throw new ValidationError(`A vendor can have at most ${MAX_CONTACTS_PER_VENDOR} contacts`);
    const first = (await tx.vendorContact.count({ where: { vendorId } })) === 0;
    const primary = data.isPrimary ?? first; // the first contact is the main one unless said otherwise
    if (primary) await tx.vendorContact.updateMany({ where: { vendorId, isPrimary: true }, data: { isPrimary: false } });
    const c = await tx.vendorContact.create({ data: { organizationId: ctx.organizationId, vendorId, name: data.name, role: data.role ?? null, phone: data.phone ?? null, email: data.email ?? null, isPrimary: primary } });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "VendorContact", entityId: c.id, after: { vendorId, name: c.name, role: c.role, isPrimary: c.isPrimary } });
    return c;
  });
}

export async function updateVendorContact(ctx: AccessContext, contactId: string, patch: Partial<z.input<typeof contactSchema>>, db: Client = prisma) {
  const data = contactSchema.partial().parse(patch);
  assertOrgWide(ctx, "vendor.manage");
  return runInTx(db, async (tx) => {
    const c = await tx.vendorContact.findUnique({ where: { id: contactId } });
    if (!c || c.organizationId !== ctx.organizationId) throw new NotFoundError("Contact not found");
    if (data.isPrimary) await tx.vendorContact.updateMany({ where: { vendorId: c.vendorId, isPrimary: true, id: { not: c.id } }, data: { isPrimary: false } });
    const updated = await tx.vendorContact.update({ where: { id: contactId }, data });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "VendorContact", entityId: contactId, before: { name: c.name, role: c.role, isPrimary: c.isPrimary }, after: data });
    return updated;
  });
}

export async function removeVendorContact(ctx: AccessContext, contactId: string, db: Client = prisma) {
  assertOrgWide(ctx, "vendor.manage");
  return runInTx(db, async (tx) => {
    const c = await tx.vendorContact.findUnique({ where: { id: contactId } });
    if (!c || c.organizationId !== ctx.organizationId) throw new NotFoundError("Contact not found");
    await tx.vendorContact.delete({ where: { id: contactId } });
    // The main contact leaving hands the role to the next person, so a vendor with contacts always has one.
    if (c.isPrimary) {
      const next = await tx.vendorContact.findFirst({ where: { vendorId: c.vendorId }, orderBy: [{ name: "asc" }, { id: "asc" }] });
      if (next) await tx.vendorContact.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
    await writeAudit(tx, ctx, { action: "VOID", entityType: "VendorContact", entityId: contactId, before: { vendorId: c.vendorId, name: c.name } });
    return { removed: true };
  });
}
