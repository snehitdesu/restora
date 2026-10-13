/**
 * Floor operations on running orders (audit MB-03), against the real services and database: moving a party to another table,
 * merging two orders into one bill, splitting one bill into several. Orders, kitchen tickets, payments and reservations are
 * all made through the services, never inserted by hand (except the stamps that simulate the kitchen's progress).
 *
 *  T1 transfer   T2 merge   T3 split (whole lines, part of a line, shared tickets, discount)   T4 money and permissions
 *  T5 the two bills of a split are paid separately and free the table once
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import type { AccessContext } from "@/server/db/scope";
import { createMenuItem } from "@/server/services/menu";
import { createOrder, addOrderItem, submitOrder, applyDiscount, requestBill, getOrder } from "@/server/services/orders";
import { transferOrderTable, mergeOrders, splitOrder } from "@/server/services/orderOps";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { createReservation, seatReservation, completeReservation } from "@/server/services/reservations";
import { applyCoupon, createCoupon } from "@/server/services/coupons";
import { listKOTs, updateKOTStatus } from "@/server/services/kot";
import { settleAfterCommit } from "@/server/services/afterCommit";
import { makeEnv, member, uniq, type Env } from "./growthSupport";

let env: Env;
let captain: AccessContext;
const dish: Record<string, string> = {};
let tableSeq = 0;

const num = (v: unknown) => Number(v);
/** A fresh table (every test gets its own, so nothing depends on another test's leftovers). */
const table = async (outletId = env.outletA, status = "AVAILABLE") => (await prisma.restaurantTable.create({ data: { organizationId: env.orgId, outletId, code: `X${++tableSeq}-${uniq()}`, capacity: 6, status } })).id;
const tableRow = (id: string) => prisma.restaurantTable.findUniqueOrThrow({ where: { id } });
const orderRow = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });

/** An order at a table with the named dishes (qty 1 each unless `[name, qty]`), optionally sent to the kitchen. */
async function openAt(tableId: string | undefined, lines: Array<string | [string, number]>, opts: { fire?: boolean; covers?: number; outletId?: string } = {}) {
  const o = await createOrder(captain, { outletId: opts.outletId ?? env.outletA, tableId, channel: tableId ? "DINE_IN" : "TAKEAWAY", covers: opts.covers ?? 2 });
  const itemIds: string[] = [];
  for (const l of lines) {
    const [name, qty] = Array.isArray(l) ? l : [l, 1];
    itemIds.push(((await addOrderItem(captain, o.id, { menuItemId: dish[name], qty })) as { id: string }).id);
  }
  if (opts.fire) await submitOrder(captain, o.id);
  return { id: o.id, itemIds };
}

beforeAll(async () => {
  env = await makeEnv("Gop");
  captain = member(env.orgId, "CAPTAIN", env.outletA);
  for (const [name, price, tax, station] of [["Masala Dosa", 120, 5, "KITCHEN"], ["Filter Coffee", 40, 5, "KITCHEN"], ["Beer", 250, 18, "BAR"], ["Idli", 60, 5, "KITCHEN"]] as const) {
    dish[name] = (await createMenuItem(env.owner, { name, price, taxPct: tax, station })).id;
  }
}, 120000);
afterAll(async () => { await prisma.$disconnect(); });

describe("T1. moving a party to another table", () => {
  it("T1 the order, its tickets and its guests move; the old table frees, the new one shows occupied; audited", async () => {
    const [t1, t2] = [await table(), await table()];
    const o = await openAt(t1, ["Masala Dosa", "Beer"], { fire: true });
    const kitchenBefore = (await listKOTs(prisma, env.owner, { outletId: env.outletA })).filter((k) => k.orderId === o.id);
    expect(kitchenBefore.length).toBe(2); // KITCHEN + BAR
    const r = await transferOrderTable(captain, o.id, { tableId: t2 });
    expect(r).toMatchObject({ unchanged: false });
    expect(r.order.tableId).toBe(t2);
    expect((await tableRow(t1)).status).toBe("AVAILABLE");
    expect((await tableRow(t2)).status).toBe("OCCUPIED");
    // The kitchen's screen follows: the same tickets now read the new table.
    const t2Code = (await tableRow(t2)).code;
    const kitchenAfter = (await listKOTs(prisma, env.owner, { outletId: env.outletA })).filter((k) => k.orderId === o.id);
    expect(kitchenAfter.map((k) => k.id).sort()).toEqual(kitchenBefore.map((k) => k.id).sort());
    expect(kitchenAfter.every((k) => k.order.table?.code === t2Code)).toBe(true);
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: env.orgId, entityType: "Order", entityId: o.id, after: { contains: '"transfer":true' } } });
    expect(audit).not.toBeNull();
    expect(audit!.actorId).toBe(captain.userId);
  });

  it("T1 asking for the table it is already at changes nothing; a billed order moves with its bill-requested state", async () => {
    const [t1, t2] = [await table(), await table()];
    const o = await openAt(t1, ["Idli"], { fire: true });
    expect(await transferOrderTable(captain, o.id, { tableId: t1 })).toMatchObject({ unchanged: true });
    await requestBill(captain, o.id);
    expect((await tableRow(t1)).status).toBe("BILL_REQUESTED");
    await transferOrderTable(captain, o.id, { tableId: t2 });
    expect((await tableRow(t2)).status).toBe("BILL_REQUESTED");
    expect((await tableRow(t1)).status).toBe("AVAILABLE");
    expect((await orderRow(o.id)).status).toBe("BILLED");
  });

  it("T1 refuses a table with a running order (merge instead), a cleaning table, another outlet's table, and an order with no table", async () => {
    const [t1, t2, busy, cleaning, elsewhere] = [await table(), await table(), await table(), await table(env.outletA, "CLEANING"), await table(env.outletB)];
    const o = await openAt(t1, ["Idli"]);
    await openAt(busy, ["Filter Coffee"]);
    await expect(transferOrderTable(captain, o.id, { tableId: busy })).rejects.toThrow(/already has a running order/);
    await expect(transferOrderTable(captain, o.id, { tableId: cleaning })).rejects.toThrow(/being cleaned/);
    await expect(transferOrderTable(captain, o.id, { tableId: elsewhere })).rejects.toThrow(/not in this outlet/);
    await expect(transferOrderTable(captain, o.id, { tableId: "no-such-table" })).rejects.toBeInstanceOf(ValidationError);
    const takeaway = await openAt(undefined, ["Idli"]);
    await expect(transferOrderTable(captain, takeaway.id, { tableId: t2 })).rejects.toThrow(/not at a table/);
    expect((await orderRow(o.id)).tableId).toBe(t1); // nothing moved
  });

  it("T1 a table with a booking close to now is not taken; a party seated from a reservation takes the reservation along", async () => {
    const [t1, t2, booked] = [await table(), await table(), await table()];
    await createReservation(env.owner, { outletId: env.outletA, tableId: booked, partySize: 2, reservedAt: new Date(Date.now() + 30 * 60_000) });
    const seatedRes = await createReservation(env.owner, { outletId: env.outletA, tableId: t1, partySize: 2, reservedAt: new Date(Date.now() + 5 * 60_000) });
    await seatReservation(env.owner, seatedRes.id);
    const o = await openAt(t1, ["Idli"]);
    await expect(transferOrderTable(captain, o.id, { tableId: booked })).rejects.toThrow(/already reserved/);
    await transferOrderTable(captain, o.id, { tableId: t2 });
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: seatedRes.id } })).tableId).toBe(t2);
    expect(await prisma.reservationSlot.count({ where: { reservationId: seatedRes.id, tableId: t2 } })).toBeGreaterThan(0);
    expect(await prisma.reservationSlot.count({ where: { reservationId: seatedRes.id, tableId: t1 } })).toBe(0);
    // Completing the reservation later does not free a table somebody else could be using, and leaves t2 to the order.
    await completeReservation(env.owner, seatedRes.id);
    expect((await tableRow(t2)).status).toBe("OCCUPIED");
  });

  it("T1 permissions and tenants: kitchen staff cannot, another restaurant sees no such order, a paid order cannot move", async () => {
    const [t1, t2] = [await table(), await table()];
    const o = await openAt(t1, ["Idli"]);
    await expect(transferOrderTable(env.kitchen, o.id, { tableId: t2 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(transferOrderTable(env.foreign, o.id, { tableId: t2 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(transferOrderTable(member(env.orgId, "CAPTAIN", env.outletB), o.id, { tableId: t2 })).rejects.toThrow();
    await expect(transferOrderTable(captain, o.id, {} as never)).rejects.toThrow();
    const total = num((await orderRow(o.id)).total);
    const p = await createPayment(env.owner, o.id, { method: "UPI", amount: total });
    await verifyPayment(env.owner, p.id);
    await settleAfterCommit();
    await expect(transferOrderTable(captain, o.id, { tableId: t2 })).rejects.toThrow(/paid/);
  });
});

describe("T2. merging two orders into one bill", () => {
  it("T2 lines and tickets move to the target, totals add up, the emptied order closes with a note and its table frees", async () => {
    const [ta, tb] = [await table(), await table()];
    const a = await openAt(ta, ["Masala Dosa"], { fire: true, covers: 2 });
    const b = await openAt(tb, ["Filter Coffee", "Beer"], { fire: true, covers: 3 });
    const totalA = num((await orderRow(a.id)).total);
    const totalB = num((await orderRow(b.id)).total);
    const ticketsB = await prisma.kot.findMany({ where: { orderId: b.id } });
    const r = await mergeOrders(captain, a.id, { fromOrderId: b.id });
    expect(r.replayed).toBe(false);
    const merged = await getOrder(prisma, env.owner, a.id);
    expect(merged.items.map((i) => i.name).sort()).toEqual(["Beer", "Filter Coffee", "Masala Dosa"]);
    expect(num(merged.total)).toBeCloseTo(totalA + totalB, 2);
    expect(merged.covers).toBe(5);
    expect(merged.kots.map((k) => k.id)).toEqual(expect.arrayContaining(ticketsB.map((k) => k.id)));
    const gone = await orderRow(b.id);
    expect(gone).toMatchObject({ status: "CANCELLED", notes: `Merged into order #${a.id.slice(-6).toUpperCase()}` });
    expect(num(gone.total)).toBe(0);
    expect(await prisma.orderItem.count({ where: { orderId: b.id } })).toBe(0);
    expect((await tableRow(tb)).status).toBe("AVAILABLE");
    expect((await tableRow(ta)).status).toBe("OCCUPIED");
    // Both orders show in the audit trail.
    expect(await prisma.auditLog.count({ where: { organizationId: env.orgId, entityId: { in: [a.id, b.id] }, after: { contains: "merge" } } })).toBeGreaterThanOrEqual(2);
  });

  it("T2 asking twice (a double tap) returns the merged order and does nothing more", async () => {
    const [ta, tb] = [await table(), await table()];
    const a = await openAt(ta, ["Idli"], { fire: true });
    const b = await openAt(tb, ["Filter Coffee"], { fire: true });
    await mergeOrders(captain, a.id, { fromOrderId: b.id });
    const lines = await prisma.orderItem.count({ where: { orderId: a.id } });
    const again = await mergeOrders(captain, a.id, { fromOrderId: b.id });
    expect(again.replayed).toBe(true);
    expect(await prisma.orderItem.count({ where: { orderId: a.id } })).toBe(lines);
    // A different pair is not mistaken for a replay.
    const c = await openAt(await table(), ["Idli"]);
    await expect(mergeOrders(captain, c.id, { fromOrderId: b.id })).rejects.toThrow(/cancelled/);
  });

  it("T2 the more advanced kitchen state wins; the customer of the emptied order is kept when the target has none; notes are combined", async () => {
    const cust = await prisma.customer.create({ data: { organizationId: env.orgId, name: `Guest ${uniq()}` } });
    const a = await openAt(await table(), ["Idli"]); // OPEN
    const bOrder = await createOrder(captain, { outletId: env.outletA, tableId: await table(), channel: "DINE_IN", customerId: cust.id, notes: "Allergic to nuts" });
    await addOrderItem(captain, bOrder.id, { menuItemId: dish["Filter Coffee"], qty: 1 });
    await submitOrder(captain, bOrder.id); // SENT
    await prisma.order.update({ where: { id: a.id }, data: { notes: "Birthday" } });
    await mergeOrders(captain, a.id, { fromOrderId: bOrder.id });
    expect(await orderRow(a.id)).toMatchObject({ status: "SENT", customerId: cust.id, notes: "Birthday · Allergic to nuts" });
  });

  it("T2 refusals: itself, another outlet, a billed order, money or a discount on the emptied order, closed orders", async () => {
    const a = await openAt(await table(), ["Idli"], { fire: true });
    await expect(mergeOrders(captain, a.id, { fromOrderId: a.id })).rejects.toThrow(/different order/);
    const other = await openAt(await table(env.outletB), ["Idli"], { outletId: env.outletB, fire: true }).catch(() => null);
    if (other) await expect(mergeOrders(env.owner, a.id, { fromOrderId: other.id })).rejects.toThrow(/different outlets/);

    const billed = await openAt(await table(), ["Idli"], { fire: true });
    await requestBill(captain, billed.id);
    await expect(mergeOrders(captain, a.id, { fromOrderId: billed.id })).rejects.toThrow(/already has its bill requested/);
    await expect(mergeOrders(captain, billed.id, { fromOrderId: a.id })).rejects.toThrow(/already has its bill requested/);

    const paying = await openAt(await table(), ["Filter Coffee"], { fire: true });
    const p = await createPayment(env.owner, paying.id, { method: "CASH", amount: 10 });
    await verifyPayment(env.owner, p.id);
    await expect(mergeOrders(captain, a.id, { fromOrderId: paying.id })).rejects.toThrow(/already has a payment/);

    const discounted = await openAt(await table(), ["Masala Dosa"], { fire: true });
    await applyDiscount(env.owner, discounted.id, 20);
    await expect(mergeOrders(captain, a.id, { fromOrderId: discounted.id })).rejects.toThrow(/carries a discount/);

    const couponed = await openAt(await table(), ["Masala Dosa"], { fire: true });
    const c = await createCoupon(env.manager, { code: `OPS${uniq()}`.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16), name: "Ops", kind: "PERCENT", value: 10 } as never);
    await applyCoupon(env.owner, couponed.id, c.code);
    await expect(mergeOrders(captain, a.id, { fromOrderId: couponed.id })).rejects.toThrow(/coupon .* is applied/);

    expect((await orderRow(paying.id)).status).not.toBe("CANCELLED"); // every refusal left the orders alone
    expect(await prisma.orderItem.count({ where: { orderId: discounted.id } })).toBe(1);
  });

  it("T2 permissions and tenants", async () => {
    const a = await openAt(await table(), ["Idli"]);
    const b = await openAt(await table(), ["Idli"]);
    await expect(mergeOrders(env.kitchen, a.id, { fromOrderId: b.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(mergeOrders(env.foreign, a.id, { fromOrderId: b.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(mergeOrders(captain, a.id, {} as never)).rejects.toThrow();
  });
});

describe("T3. splitting a bill", () => {
  it("T3 whole lines go to a new bill at the same table; tickets move with them; totals follow the one pricing rule", async () => {
    const t = await table();
    const o = await openAt(t, ["Masala Dosa", "Filter Coffee", "Beer"], { fire: true, covers: 3 });
    const before = await orderRow(o.id);
    const r = await splitOrder(captain, o.id, { lines: [{ orderItemId: o.itemIds[2] }], covers: 1 }, `split-${uniq()}-aaaa`);
    expect(r.replayed).toBe(false);
    expect(r.order.id).not.toBe(o.id);
    expect(r.order).toMatchObject({ tableId: t, status: "SENT", channel: "DINE_IN", covers: 1 });
    expect(r.original.covers).toBe(2);
    expect(r.order.items.map((i) => i.name)).toEqual(["Beer"]);
    expect(r.original.items.map((i) => i.name).sort()).toEqual(["Filter Coffee", "Masala Dosa"]);
    // Beer 250 + 18% = 295; dosa 120 + coffee 40 at 5% = 168.
    expect(num(r.order.total)).toBe(295);
    expect(num(r.original.total)).toBe(168);
    expect(Math.abs(num(r.order.total) + num(r.original.total) - num(before.total))).toBeLessThanOrEqual(0.02);
    // The bar ticket was only Beer: it moved whole. The kitchen ticket stayed.
    expect(r.order.kots).toHaveLength(1);
    expect(r.original.kots).toHaveLength(1);
    expect(r.order.kots[0].items.map((i) => i.name)).toEqual(["Beer"]);
    expect((await tableRow(t)).status).toBe("OCCUPIED");
    expect(await prisma.auditLog.count({ where: { organizationId: env.orgId, entityId: { in: [o.id, r.order.id] }, after: { contains: "split" } } })).toBe(2);
  });

  it("T3 a ticket shared by both bills becomes two tickets in the same state; nothing is cooked twice", async () => {
    const o = await openAt(await table(), ["Masala Dosa", "Filter Coffee", "Idli"], { fire: true });
    const [shared] = await prisma.kot.findMany({ where: { orderId: o.id } });
    await updateKOTStatus(env.kitchen, shared.id, "ACCEPTED");
    await updateKOTStatus(env.kitchen, shared.id, "PREPARING");
    const stampsBefore = await prisma.kot.findUniqueOrThrow({ where: { id: shared.id } });
    const r = await splitOrder(captain, o.id, { lines: [{ orderItemId: o.itemIds[1] }] }, `split-${uniq()}-bbbb`);
    const orig = r.original.kots[0];
    const twin = r.order.kots[0];
    expect(orig.id).toBe(shared.id);
    expect(twin.id).not.toBe(shared.id);
    expect(twin.number).toBeGreaterThan(orig.number);
    expect(twin.status).toBe("PREPARING");
    expect(orig.items.map((i) => i.name).sort()).toEqual(["Idli", "Masala Dosa"]);
    expect(twin.items.map((i) => i.name)).toEqual(["Filter Coffee"]);
    const twinRow = await prisma.kot.findUniqueOrThrow({ where: { id: twin.id } });
    expect(twinRow.startedAt?.getTime()).toBe(stampsBefore.startedAt?.getTime());
    expect(twinRow.createdAt.getTime()).toBe(stampsBefore.createdAt.getTime());
    // Every ordered dish is on exactly one live ticket.
    const live = (await listKOTs(prisma, env.owner, { outletId: env.outletA })).filter((k) => [orig.id, twin.id].includes(k.id));
    expect(live.flatMap((k) => k.items.map((i) => i.name)).sort()).toEqual(["Filter Coffee", "Idli", "Masala Dosa"]);
  });

  it("T3 part of a line can be moved (2 of 3): quantities, the kitchen's counts and the money all agree", async () => {
    const o = await openAt(await table(), [["Idli", 3], "Filter Coffee"], { fire: true });
    await prisma.orderItem.update({ where: { id: o.itemIds[0] }, data: { discount: 10 } });
    const r = await splitOrder(captain, o.id, { lines: [{ orderItemId: o.itemIds[0], qty: 2 }] }, `split-${uniq()}-cccc`);
    const kept = r.original.items.find((i) => i.name === "Idli")!;
    const moved = r.order.items.find((i) => i.name === "Idli")!;
    expect([num(kept.qty), num(moved.qty)]).toEqual([1, 2]);
    expect(num(kept.discount) + num(moved.discount)).toBe(10); // the line's own discount is shared to the paisa
    expect(num(moved.discount)).toBe(6.67);
    const kotQty = (k: { items: Array<{ name: string; qty: unknown }> }[]) => k.flatMap((x) => x.items).filter((i) => i.name === "Idli").map((i) => num(i.qty));
    expect(kotQty(r.original.kots)).toEqual([1]);
    expect(kotQty(r.order.kots)).toEqual([2]);
    // Line totals follow: 3 × 60 − 10 = 170 before; 60 − 3.33 and 120 − 6.67 after.
    expect(num(kept.lineTotal) + num(moved.lineTotal)).toBe(170);
  });

  it("T3 an order-level discount is shared by value between the two bills, exactly", async () => {
    const o = await openAt(await table(), ["Masala Dosa", "Beer"], { fire: true }); // 120 + 250 = 370
    await applyDiscount(env.owner, o.id, 37);
    const r = await splitOrder(captain, o.id, { lines: [{ orderItemId: o.itemIds[1] }] }, `split-${uniq()}-dddd`);
    expect(num(r.order.discount)).toBe(25); // 250 / 370 of 37 = 25.0
    expect(num(r.original.discount)).toBe(12);
    expect(num(r.order.discount) + num(r.original.discount)).toBe(37);
    // Beer: (250 − 25) × 1.18 = 265.50; dosa: (120 − 12) × 1.05 = 113.40.
    expect(num(r.order.total)).toBe(265.5);
    expect(num(r.original.total)).toBe(113.4);
  });

  it("T3 a billed order can be split; both bills stay billed and the table keeps asking for payment", async () => {
    const t = await table();
    const o = await openAt(t, ["Masala Dosa", "Filter Coffee"], { fire: true });
    await requestBill(captain, o.id);
    const r = await splitOrder(captain, o.id, { lines: [{ orderItemId: o.itemIds[1] }] }, `split-${uniq()}-eeee`);
    expect([r.order.status, r.original.status]).toEqual(["BILLED", "BILLED"]);
    expect((await tableRow(t)).status).toBe("BILL_REQUESTED");
  });

  it("T3 the same key and request returns the same new bill; the same key for another request is refused", async () => {
    const o = await openAt(await table(), ["Masala Dosa", "Filter Coffee", "Idli"], { fire: true });
    const key = `split-${uniq()}-ffff`;
    const first = await splitOrder(captain, o.id, { lines: [{ orderItemId: o.itemIds[1] }] }, key);
    const again = await splitOrder(captain, o.id, { lines: [{ orderItemId: o.itemIds[1] }] }, key);
    expect(again.replayed).toBe(true);
    expect(again.order.id).toBe(first.order.id);
    expect(await prisma.order.count({ where: { tableId: first.order.tableId! } })).toBe(2);
    await expect(splitOrder(captain, o.id, { lines: [{ orderItemId: o.itemIds[2] }] }, key)).rejects.toBeInstanceOf(ConflictError);
  });

  it("T3 bad requests are refused and leave the bill alone", async () => {
    const o = await openAt(await table(), ["Masala Dosa", ["Filter Coffee", 2]], { fire: true });
    const other = await openAt(await table(), ["Idli"]);
    const snapshot = async () => JSON.stringify((await getOrder(prisma, env.owner, o.id)).items.map((i) => [i.id, i.qty.toString(), i.orderId]));
    const before = await snapshot();
    const k = () => `split-${uniq()}-gggg`;
    await expect(splitOrder(captain, o.id, { lines: [] } as never, k())).rejects.toThrow();
    await expect(splitOrder(captain, o.id, { lines: [{ orderItemId: o.itemIds[0] }, { orderItemId: o.itemIds[1] }] }, k())).rejects.toThrow(/at least one item/);
    await expect(splitOrder(captain, o.id, { lines: [{ orderItemId: o.itemIds[1], qty: 3 }] }, k())).rejects.toThrow(/Only 2/);
    await expect(splitOrder(captain, o.id, { lines: [{ orderItemId: o.itemIds[0] }, { orderItemId: o.itemIds[0] }] }, k())).rejects.toThrow(/twice/);
    await expect(splitOrder(captain, o.id, { lines: [{ orderItemId: other.itemIds[0] }] }, k())).rejects.toThrow(/not on this order/);
    await expect(splitOrder(captain, o.id, { lines: [{ orderItemId: o.itemIds[0], qty: 0 }] }, k())).rejects.toThrow();
    await expect(splitOrder(captain, o.id, { lines: [{ orderItemId: o.itemIds[0], extra: 1 }] } as never, k())).rejects.toThrow();
    expect(await snapshot()).toBe(before);
    expect(await prisma.order.count({ where: { tableId: (await orderRow(o.id)).tableId! } })).toBe(1);
  });

  it("T3 a line that was never sent can be split too: it goes to the new bill unsent and is sent there", async () => {
    const o = await openAt(await table(), ["Masala Dosa"], { fire: true });
    const late = ((await addOrderItem(captain, o.id, { menuItemId: dish["Idli"], qty: 2 })) as { id: string }).id;
    const r = await splitOrder(captain, o.id, { lines: [{ orderItemId: late, qty: 1 }] }, `split-${uniq()}-hhhh`);
    expect(r.order.kots).toHaveLength(0);
    expect(r.order.items.map((i) => [i.name, num(i.qty)])).toEqual([["Idli", 1]]);
    expect(r.original.items.map((i) => [i.name, num(i.qty)]).sort()).toEqual([["Idli", 1], ["Masala Dosa", 1]]);
  });
});

describe("T4. money, permissions, tenants", () => {
  it("T4 a bill that holds a payment, or a coupon, is not split; a closed order is not either", async () => {
    const o = await openAt(await table(), ["Masala Dosa", "Filter Coffee"], { fire: true });
    const p = await createPayment(env.owner, o.id, { method: "CASH", amount: 20 });
    await verifyPayment(env.owner, p.id);
    await expect(splitOrder(captain, o.id, { lines: [{ orderItemId: o.itemIds[1] }] }, `split-${uniq()}-iiii`)).rejects.toThrow(/already has a payment/);

    const c = await openAt(await table(), ["Masala Dosa", "Filter Coffee"], { fire: true });
    const code = `OPS${uniq()}`.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
    await createCoupon(env.manager, { code, name: "Ops", kind: "PERCENT", value: 10 } as never);
    await applyCoupon(env.owner, c.id, code);
    await expect(splitOrder(captain, c.id, { lines: [{ orderItemId: c.itemIds[1] }] }, `split-${uniq()}-jjjj`)).rejects.toThrow(/coupon .* is applied/);

    const done = await openAt(await table(), ["Masala Dosa", "Filter Coffee"], { fire: true });
    await prisma.order.update({ where: { id: done.id }, data: { status: "CANCELLED" } });
    await expect(splitOrder(captain, done.id, { lines: [{ orderItemId: done.itemIds[1] }] }, `split-${uniq()}-kkkk`)).rejects.toThrow(/cancelled/);
  });

  it("T4 permissions and tenants", async () => {
    const o = await openAt(await table(), ["Masala Dosa", "Filter Coffee"]);
    const body = { lines: [{ orderItemId: o.itemIds[1] }] };
    await expect(splitOrder(env.kitchen, o.id, body, `split-${uniq()}-llll`)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(splitOrder(env.foreign, o.id, body, `split-${uniq()}-mmmm`)).rejects.toBeInstanceOf(NotFoundError);
    await expect(splitOrder(member(env.orgId, "CAPTAIN", env.outletB), o.id, body, `split-${uniq()}-nnnn`)).rejects.toThrow();
    expect(await prisma.order.count({ where: { tableId: (await orderRow(o.id)).tableId! } })).toBe(1);
  });
});

describe("T5. two bills, paid separately", () => {
  it("T5 each bill gets its own invoice; the table frees only when the last one is paid; the original is untouched by the second payment", async () => {
    const t = await table();
    const o = await openAt(t, ["Masala Dosa", "Beer"], { fire: true });
    const r = await splitOrder(captain, o.id, { lines: [{ orderItemId: o.itemIds[1] }] }, `split-${uniq()}-pppp`);
    const pay = async (id: string) => {
      const total = num((await orderRow(id)).total);
      const p = await createPayment(env.owner, id, { method: "UPI", amount: total });
      await verifyPayment(env.owner, p.id);
      await settleAfterCommit();
      return orderRow(id);
    };
    const first = await pay(r.order.id);
    expect(first.status).toBe("PAID");
    expect(first.invoiceNo).toBeTruthy();
    expect((await tableRow(t)).status).toBe("OCCUPIED"); // the other bill is still open
    const second = await pay(o.id);
    expect(second.status).toBe("PAID");
    expect(second.invoiceNo).toBeTruthy();
    expect(second.invoiceNo).not.toBe(first.invoiceNo);
    expect((await tableRow(t)).status).toBe("AVAILABLE");
    // Each invoice is for its own lines and its own tax.
    expect(num(first.total)).toBe(295);
    expect(num(first.tax)).toBe(45);
    expect(num(second.total)).toBe(126);
    expect(num(second.tax)).toBe(6);
  });
});
