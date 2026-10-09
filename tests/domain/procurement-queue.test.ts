/**
 * The combined procurement queue (audit PP-04) against the real database: purchase orders and indents in one list with the
 * tabs that matter (needs approval, in progress, done), paged without skipping or repeating a document, and shown only to
 * the people who may see them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { ForbiddenError } from "@/server/db/scope";
import type { AccessContext } from "@/server/db/scope";
import { procurementQueue } from "@/server/services/procurementQueue";
import { makeEnv, member, uniq, type Env } from "./growthSupport";

let env: Env;
let vendor: string;
let material: string;
let store: AccessContext;
const T0 = Date.now() - 3 * 86_400_000;
let seq = 0;

/** createdAt is set explicitly so the order of the queue is known. */
const at = () => new Date(T0 + ++seq * 60_000);
async function po(status: string, extra: { outletId?: string; total?: number; source?: string } = {}) {
  return prisma.purchaseOrder.create({ data: { organizationId: env.orgId, outletId: extra.outletId ?? env.outletA, number: `PO-Q-${uniq()}`, vendorId: vendor, status, total: extra.total ?? 100, subtotal: extra.total ?? 100, source: extra.source, createdAt: at(), lines: { create: [{ organizationId: env.orgId, materialId: material, qty: 1, rate: 10 }, { organizationId: env.orgId, materialId: material, qty: 2, rate: 10 }] } } });
}
async function indent(status: string, outletId = env.outletA) {
  return prisma.purchaseIndent.create({ data: { organizationId: env.orgId, outletId, number: `IND-Q-${uniq()}`, status, createdAt: at(), lines: { create: [{ organizationId: env.orgId, materialId: material, qty: 1 }] } } });
}
const queue = (input: Record<string, unknown> = {}, ctx: AccessContext = env.manager) => procurementQueue(prisma, ctx, { outletId: env.outletA, ...input } as never);
const ids = (r: { items: Array<{ id: string }> }) => r.items.map((i) => i.id);

beforeAll(async () => {
  env = await makeEnv("Gpq");
  store = member(env.orgId, "STORE", env.outletA);
  vendor = (await prisma.vendor.create({ data: { organizationId: env.orgId, name: `Vendor ${uniq()}`, status: "ACTIVE", active: true } })).id;
  const unit = await prisma.unit.create({ data: { organizationId: env.orgId, code: `kg${uniq()}`, name: "kg", kind: "WEIGHT" } });
  material = (await prisma.material.create({ data: { organizationId: env.orgId, sku: `Q-${uniq()}`, name: "Flour", baseUnitId: unit.id } })).id;
}, 60000);
afterAll(async () => { await prisma.$disconnect(); });

describe("Q1. tabs and counts", () => {
  it("Q1 needs-approval holds submitted orders and indents, newest first; in-progress and done hold the rest; counts match", async () => {
    const [d1, s1, a1, o1, p1, r1, c1, x1] = [await po("DRAFT"), await po("SUBMITTED", { total: 500 }), await po("APPROVED"), await po("ORDERED"), await po("PARTIAL"), await po("RECEIVED"), await po("CLOSED"), await po("CANCELLED")];
    const [id1, is1, ia1, ic1] = [await indent("DRAFT"), await indent("SUBMITTED"), await indent("APPROVED"), await indent("CLOSED")];
    const needs = await queue({ tab: "needs-approval" });
    expect(ids(needs)).toEqual([is1.id, s1.id]); // the indent was made after the order: newest first
    const progress = await queue({ tab: "in-progress" });
    expect(ids(progress)).toEqual([ia1.id, id1.id, p1.id, o1.id, a1.id, d1.id]);
    const done = await queue({ tab: "done" });
    expect(ids(done)).toEqual([ic1.id, x1.id, c1.id, r1.id]);
    expect((await queue({ tab: "all" })).items).toHaveLength(12);
    expect(needs.counts).toEqual({ "needs-approval": 2, "in-progress": 6, done: 4 });
    // The chips are the same whatever tab is open.
    expect((await queue({ tab: "done" })).counts).toEqual(needs.counts);
  });

  it("Q1 each row says what it is: kind, number, status, lines, amount (orders only), where it came from, where to open it", async () => {
    const o = await po("SUBMITTED", { total: 1234.5, source: "REORDER" });
    const i = await indent("SUBMITTED");
    const [first, second] = (await queue({ tab: "needs-approval" })).items.filter((x) => [o.id, i.id].includes(x.id)).sort((a, b) => a.kind.localeCompare(b.kind));
    expect(first).toMatchObject({ kind: "INDENT", id: i.id, number: i.number, status: "SUBMITTED", lines: 1, total: null, vendorId: null, href: `/procurement/indents/${i.id}` });
    expect(second).toMatchObject({ kind: "PURCHASE_ORDER", id: o.id, number: o.number, lines: 2, total: 1234.5, vendorId: vendor, source: "REORDER", href: `/procurement/purchase-orders/${o.id}` });
  });

  it("Q1 the kind filter narrows the list but not the logic", async () => {
    const only = await queue({ tab: "all", kind: "indent", take: 100 });
    expect(only.items.every((x) => x.kind === "INDENT")).toBe(true);
    const orders = await queue({ tab: "all", kind: "purchase-order", take: 100 });
    expect(orders.items.every((x) => x.kind === "PURCHASE_ORDER")).toBe(true);
    expect(orders.items.length + only.items.length).toBe((await queue({ tab: "all", take: 100 })).items.length);
  });
});

describe("Q2. paging", () => {
  it("Q2 pages in small steps visit every document once, in order, across both tables", async () => {
    const e = await makeEnv("Gpr");
    const v = (await prisma.vendor.create({ data: { organizationId: e.orgId, name: `V ${uniq()}`, status: "ACTIVE", active: true } })).id;
    const u = await prisma.unit.create({ data: { organizationId: e.orgId, code: `u${uniq()}`, name: "u", kind: "COUNT" } });
    const m = (await prisma.material.create({ data: { organizationId: e.orgId, sku: `P-${uniq()}`, name: "Salt", baseUnitId: u.id } })).id;
    const made: string[] = [];
    // The same createdAt on a purchase order and an indent: the id breaks the tie, nothing is lost.
    const tie = new Date(T0 + 10 * 86_400_000);
    for (let i = 0; i < 7; i++) {
      const when = i === 3 ? tie : new Date(T0 + 10 * 86_400_000 + i * 60_000);
      made.push((await prisma.purchaseOrder.create({ data: { organizationId: e.orgId, outletId: e.outletA, number: `PO-${i}-${uniq()}`, vendorId: v, status: "SUBMITTED", createdAt: when, lines: { create: [{ organizationId: e.orgId, materialId: m, qty: 1, rate: 1 }] } } })).id);
      made.push((await prisma.purchaseIndent.create({ data: { organizationId: e.orgId, outletId: e.outletA, number: `IN-${i}-${uniq()}`, status: "SUBMITTED", createdAt: when, lines: { create: [{ organizationId: e.orgId, materialId: m, qty: 1 }] } } })).id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const r: Awaited<ReturnType<typeof procurementQueue>> = await procurementQueue(prisma, e.manager, { outletId: e.outletA, tab: "needs-approval", take: 4, cursor: cursor ?? undefined });
      seen.push(...r.items.map((x) => x.id));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(14);
    expect(new Set(seen).size).toBe(14);
    expect([...seen].sort()).toEqual([...made].sort());
    expect(await prisma.purchaseOrder.count({ where: { organizationId: e.orgId } })).toBe(7);
  });

  it("Q2 a malformed cursor is ignored, a page size over the limit is refused", async () => {
    expect((await queue({ cursor: "garbage" })).items.length).toBeGreaterThan(0);
    await expect(queue({ take: 1000 })).rejects.toThrow();
    await expect(queue({ tab: "nope" })).rejects.toThrow();
  });
});

describe("Q3. who sees what", () => {
  it("Q3 purchasing sees both; the kitchen sees indents only, with no amounts; a cashier sees nothing", async () => {
    const both = await queue({ tab: "all", take: 100 }, store);
    expect(both.includesPurchaseOrders).toBe(true);
    expect(both.items.some((x) => x.kind === "PURCHASE_ORDER" && x.total !== null)).toBe(true);
    const kitchen = await queue({ tab: "all", take: 100 }, env.kitchen);
    expect(kitchen.includesPurchaseOrders).toBe(false);
    expect(kitchen.items.length).toBeGreaterThan(0);
    expect(kitchen.items.every((x) => x.kind === "INDENT" && x.total === null)).toBe(true);
    expect(kitchen.counts["needs-approval"]).toBeGreaterThan(0);
    await expect(queue({}, env.cashier)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Q3 other outlets and other restaurants are never in the list", async () => {
    const other = await po("SUBMITTED", { outletId: env.outletB });
    expect(ids(await queue({ tab: "all", take: 100 }))).not.toContain(other.id);
    await expect(queue({ outletId: env.outletB }, env.manager)).rejects.toThrow(); // not their outlet
    expect(ids(await procurementQueue(prisma, env.owner, { outletId: env.outletB, tab: "all", take: 100 }))).toContain(other.id);
    const foreign = await procurementQueue(prisma, env.foreign, { outletId: env.outletA, tab: "all" }).catch(() => ({ items: [] }));
    expect(foreign.items).toEqual([]);
  });
});
