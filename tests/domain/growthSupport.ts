/** Shared setup for the Group 6 (growth) suites: an organization, staff contexts, a mock messaging connection, paid orders. */
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import type { AccessContext } from "@/server/db/scope";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { createCustomer } from "@/server/services/crm";
import { setConsent } from "@/server/services/consent";
import { settleAfterCommit } from "@/server/services/afterCommit";

export const RUN = Date.now().toString(36);
let seq = 0;
export const uniq = () => `${RUN}${(++seq).toString(36)}`;

export type Env = { orgId: string; outletA: string; outletB: string; owner: AccessContext; manager: AccessContext; cashier: AccessContext; kitchen: AccessContext; foreign: AccessContext };

export const member = (orgId: string, role: string, outletId: string): AccessContext => ({ userId: `${role}-${outletId}`, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });

export async function makeEnv(label: string): Promise<Env> {
  const orgId = (await prisma.organization.create({ data: { name: `${label} ${RUN}`, timezone: "Asia/Kolkata" } })).id;
  const outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `${label.slice(0, 2).toUpperCase()}A${RUN}`, name: `${label} A` } })).id;
  const outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `${label.slice(0, 2).toUpperCase()}B${RUN}`, name: `${label} B` } })).id;
  const fo = (await prisma.organization.create({ data: { name: `${label} Foreign ${RUN}` } })).id;
  const fOutlet = (await prisma.outlet.create({ data: { organizationId: fo, code: `${label.slice(0, 2).toUpperCase()}F${RUN}`, name: "F" } })).id;
  return {
    orgId, outletA, outletB,
    owner: { ...systemContext(orgId, [outletA, outletB]), userId: `owner-${RUN}`, roles: ["OWNER"], orgRoles: ["OWNER"], isOrgWide: true, isSuperAdmin: false },
    manager: member(orgId, "MANAGER", outletA),
    cashier: member(orgId, "CASHIER", outletA),
    kitchen: member(orgId, "KITCHEN", outletA),
    foreign: { ...systemContext(fo, [fOutlet]), userId: `fo-${RUN}`, roles: ["OWNER"], orgRoles: ["OWNER"], isOrgWide: true, isSuperAdmin: false },
  };
}

/** A connected MOCK messaging provider (the outbox rows are what the tests read). */
export async function connectMock(orgId: string, config: Record<string, unknown> = {}) {
  const existing = await prisma.integrationConnection.findFirst({ where: { organizationId: orgId, kind: "MESSAGING", provider: "mock" } });
  if (existing) return prisma.integrationConnection.update({ where: { id: existing.id }, data: { status: "CONNECTED", config: JSON.stringify(config) } });
  return prisma.integrationConnection.create({ data: { organizationId: orgId, kind: "MESSAGING", provider: "mock", status: "CONNECTED", config: JSON.stringify(config) } });
}

let pseq = 0;
/** A unique Indian mobile number per call. */
export const phone = () => String(9000000000 + (Number.parseInt(RUN, 36) % 90000) * 1000 + (++pseq % 1000));

/** A guest with a phone (and optionally an e-mail and marketing consent on the given channels). */
export async function guest(env: Env, name: string, opts: { email?: string; marketing?: Array<"SMS" | "WHATSAPP" | "EMAIL">; birthday?: string; anniversary?: string } = {}) {
  const c = await createCustomer(env.manager, { name, phone: phone(), email: opts.email, birthday: opts.birthday ? new Date(opts.birthday) : undefined } as never);
  if (opts.anniversary) await prisma.customer.update({ where: { id: c.id }, data: { anniversary: new Date(opts.anniversary) } });
  if (opts.marketing?.length) await setConsent(env.manager, c.id, opts.marketing.map((channel) => ({ channel, marketing: true })));
  return c;
}

/** An order settled through the payment service (so the real post-payment hooks run). */
export async function paidOrder(env: Env, outletId: string, customerId: string | undefined, amount: number, opts: { taxPct?: number; couponCode?: string } = {}) {
  const o = await createOrder(env.owner, { outletId, customerId, channel: "TAKEAWAY" });
  await addOrderItem(env.owner, o.id, { name: "Meal", qty: 1, unitPrice: amount, taxPct: opts.taxPct ?? 0 });
  if (opts.couponCode) {
    const { applyCoupon } = await import("@/server/services/coupons");
    await applyCoupon(env.owner, o.id, opts.couponCode);
  }
  const total = Number((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).total);
  const p = await createPayment(env.owner, o.id, { method: "UPI", amount: total });
  await verifyPayment(env.owner, p.id);
  await settleAfterCommit();
  return { orderId: o.id, total };
}

export const deliveries = (orgId: string, where: Record<string, unknown> = {}) => prisma.integrationDelivery.findMany({ where: { organizationId: orgId, kind: "MESSAGE", ...where }, orderBy: { createdAt: "asc" } });
