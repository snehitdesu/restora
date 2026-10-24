/**
 * Cloud side of desktop sync (/api/sync/*): the scoped incremental feed of online orders and the idempotent action
 * endpoint, over HTTP with real route handlers and real services. Customer ordering (QR) is exercised end to end:
 * a guest orders, the order is stored once, staff see it, accept it once, and the guest's tracker follows.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
vi.mock("next/headers", async () => (await import("./harness")).nextHeadersMock());
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { middleware } from "@/middleware";
import { rotateOutletCommonQr, rotateTableQr } from "@/server/services/masterData";
import { cancelOrder, placeOrder } from "@/server/services/orders";
import { getGuestOrder, startGuestPayment, confirmGuestPayment } from "@/server/services/guestOrdering";
import { guestTracker } from "@/domain/orderProgress";
import * as Guest from "@/app/api/qr/[[...path]]/route";
import * as Sync from "@/app/api/sync/[[...path]]/route";
import * as Orders from "@/app/api/orders/[[...path]]/route";
import * as Kitchen from "@/app/api/kitchen/[[...path]]/route";
import * as Payments from "@/app/api/payments/[[...path]]/route";
import { call, sessionFor } from "../api/routeSupport";
import { makeStaff, makeWorld, PASSWORD, type World, RUN } from "./harness";
import type { SyncOpResult, WireFeed, WireGuestQr, WireOrder } from "@/lib/sync/wire";

let w: World, other: World;
let cashier: string, kitchen: string, accountant: string, customerRole: string, foreignOwner: string, otherOutletCashier: string, manager: string;
let n = 0;
const opId = () => `op-${RUN}-${++n}-abcdefgh`;

/** A guest order. Each call uses its own table unless `token` is given (a table takes at most three unaccepted orders). */
async function guestOrder(items = [{ menuItemId: w.coffee, qty: 2, modifierOptionIds: [w.largeOption] }, { menuItemId: w.brownie, qty: 1 }], extra: Record<string, unknown> = {}, token?: string) {
  let t = token;
  if (!t) {
    const table = await prisma.restaurantTable.create({ data: { organizationId: w.orgId, outletId: w.outletId, code: `X${++n}` } });
    t = (await rotateTableQr(w.ctx, table.id)).qrToken!;
  }
  const res = await call(Guest, "POST", `t/${t}/orders`, { headers: { "idempotency-key": `guest-${RUN}-${++n}-key` }, body: { items, ...extra } });
  expect(res.status).toBe(200);
  return res.json.data as { orderId: string; ref: string; accessKey: string };
}
/**
 * A cloud order that may be accepted before payment (ONLINE channel, fresh table). A guest QR order cannot be
 * accepted before its online payment is verified (kitchenGate.ts; see "guest QR orders" below).
 */
async function onlineOrder(items = [{ menuItemId: w.coffee, qty: 2, modifierOptionIds: [w.largeOption] }, { menuItemId: w.brownie, qty: 1 }]) {
  const table = await prisma.restaurantTable.create({ data: { organizationId: w.orgId, outletId: w.outletId, code: `X${++n}` } });
  const o = await placeOrder(w.ctx, { outletId: w.outletId, channel: "ONLINE", source: "ONLINE", tableId: table.id, items, idempotencyKey: `online-${RUN}-${++n}-key` });
  return { orderId: o.id };
}
const feed = async (session: string, qs = "") => (await call(Sync, "GET", `orders?outletId=${w.outletId}${qs}`, { session })).json?.data as WireFeed;

beforeAll(async () => {
  w = await makeWorld("Cloud", { qr: true });
  other = await makeWorld("OtherOrg");
  manager = await sessionFor(w.orgId, "MANAGER", w.outletId);
  cashier = await sessionFor(w.orgId, "CASHIER", w.outletId);
  kitchen = await sessionFor(w.orgId, "KITCHEN", w.outletId);
  accountant = await sessionFor(w.orgId, "ACCOUNTANT", w.outletId);
  customerRole = await sessionFor(w.orgId, "CUSTOMER", w.outletId);
  foreignOwner = await sessionFor(other.orgId, "OWNER", null);
  const sister = (await prisma.outlet.create({ data: { organizationId: w.orgId, code: `SIS${RUN.slice(-4)}`, name: "Sister" } })).id;
  otherOutletCashier = await sessionFor(w.orgId, "CASHIER", sister);
});
afterAll(async () => { await prisma.$disconnect(); });

describe("customer QR order → cloud (scenarios 1, 2, 7, 19)", () => {
  it("stores a valid table QR order exactly once, however often the request is repeated", async () => {
    const body = { items: [{ menuItemId: w.coffee, qty: 1 }] };
    const key = `idem-${RUN}-same-key-1`;
    const a = await call(Guest, "POST", `t/${w.qrToken}/orders`, { headers: { "idempotency-key": key }, body });
    const b = await call(Guest, "POST", `t/${w.qrToken}/orders`, { headers: { "idempotency-key": key }, body });
    expect(a.status).toBe(200);
    expect(b.json.data.orderId).toBe(a.json.data.orderId);
    expect(b.json.data.replayed).toBe(true);
    expect(await prisma.order.count({ where: { organizationId: w.orgId, idempotencyKey: { endsWith: key } } })).toBe(1);
  });

  it("rejects an unknown, malformed or rotated (inactive) QR code", async () => {
    const body = { items: [{ menuItemId: w.coffee, qty: 1 }] };
    expect((await call(Guest, "POST", "t/not-a-real-token-123/orders", { headers: { "idempotency-key": `k-${RUN}-bad-1-aaaa` }, body })).status).toBe(404);
    expect((await call(Guest, "POST", "t/x/orders", { headers: { "idempotency-key": `k-${RUN}-bad-2-aaaa` }, body })).status).toBeGreaterThanOrEqual(400);
    const old = w.qrToken;
    w.qrToken = (await rotateTableQr(w.ctx, w.tableId)).qrToken!;
    expect((await call(Guest, "POST", `t/${old}/orders`, { headers: { "idempotency-key": `k-${RUN}-bad-3-aaaa` }, body })).status).toBe(404);
  });
});

describe("feed: scoped, incremental, minimal (scenarios 3, 8, 10, 20)", () => {
  it("requires a session, and the order.view permission at the outlet", async () => {
    expect((await call(Sync, "GET", `orders?outletId=${w.outletId}`, {})).status).toBe(401);
    expect((await call(Sync, "GET", `orders?outletId=${w.outletId}`, { session: customerRole })).status).toBe(403);
    expect((await call(Sync, "GET", `orders?outletId=${w.outletId}`, { session: kitchen })).status).toBe(200);
  });

  it("is scoped to the caller's organization and outlet: another tenant, or a sister outlet's staff, get nothing", async () => {
    await guestOrder();
    // another organization's owner naming this outlet: a foreign outlet is not even confirmed to exist
    expect((await call(Sync, "GET", `orders?outletId=${w.outletId}`, { session: foreignOwner })).status).toBe(404);
    // same organization, but a member of a different outlet only
    expect((await call(Sync, "GET", `orders?outletId=${w.outletId}`, { session: otherOutletCashier })).status).toBe(403);
    expect((await call(Sync, "GET", "orders/does-not-exist", { session: foreignOwner })).status).toBe(404);
  });

  it("lists online orders with the cloud reference, items, add-ons and no guest phone, QR token or access key", async () => {
    const placed = await guestOrder(undefined, { customer: { name: "Asha", phone: "9876543210" } }, w.qrToken!);
    const f = await feed(cashier, "&includeActive=1");
    const o = f.orders.find((x) => x.id === placed.orderId)!;
    expect(o).toBeDefined();
    expect(o).toMatchObject({ ref: placed.ref, source: "QR", status: "OPEN", tableCode: "T09", guestName: "Asha", payments: [], kots: [] });
    expect(o.items.map((i) => i.menuItemName).sort()).toEqual(["Brownie", "Cold Coffee"]);
    expect(o.items.find((i) => i.menuItemName === "Cold Coffee")!.modifiers).toEqual([{ name: "Size: Large", priceDelta: "30" }]);
    const raw = JSON.stringify(f);
    expect(raw).not.toContain("9876543210");
    expect(raw).not.toContain(w.qrToken!);
    expect(raw).not.toContain(placed.accessKey);
    expect(raw).not.toMatch(/qrToken|accessKey|passwordHash/);
  });

  it("only offers QR / online orders, never counter sales", async () => {
    await call(Orders, "POST", "", { session: cashier, body: { outletId: w.outletId, items: [{ menuItemId: w.brownie, qty: 1 }] } });
    const f = await feed(cashier, "&includeActive=1");
    expect(f.orders.every((x) => x.source === "QR" || x.source === "ONLINE")).toBe(true);
  });

  it("pages by cursor, resumes after the cursor, and re-offers running orders on request", async () => {
    const a = await guestOrder();
    const first = await feed(cashier, "&take=1&backfillHours=1");
    expect(first.orders).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const seen = new Set(first.orders.map((x) => x.id));
    let cursor = first.nextCursor!;
    for (let i = 0; i < 30; i++) {
      const next = await feed(cashier, `&take=1&cursor=${encodeURIComponent(cursor)}`);
      for (const x of next.orders) {
        expect(seen.has(x.id)).toBe(false); // the cursor never repeats a page row
        seen.add(x.id);
      }
      cursor = next.nextCursor ?? cursor;
      if (!next.hasMore) break;
    }
    expect(seen.has(a.orderId)).toBe(true);
    // Caught up: nothing new without includeActive, the running orders with it.
    expect((await feed(cashier, `&cursor=${encodeURIComponent(cursor)}`)).orders).toHaveLength(0);
    expect((await feed(cashier, `&cursor=${encodeURIComponent(cursor)}&includeActive=1`)).orders.length).toBeGreaterThan(0);
    expect((await call(Sync, "GET", `orders?outletId=${w.outletId}&cursor=garbage`, { session: cashier })).status).toBe(422);
  });

  it("rewindSeconds re-offers an order that committed late behind the cursor, so a finished order is never skipped", async () => {
    await guestOrder();
    const caughtUp = await feed(cashier, "&backfillHours=1");
    const cursor = caughtUp.nextCursor!;
    const cursorAt = new Date(cursor.split("|")[0]!);
    // An order stamped before the cursor but committed after that poll (a slow transaction), already finished.
    const late = await guestOrder();
    await prisma.order.update({ where: { id: late.orderId }, data: { status: "PAID", updatedAt: new Date(cursorAt.getTime() - 5_000) } });

    const plain = await feed(cashier, `&cursor=${encodeURIComponent(cursor)}&includeActive=1`);
    expect(plain.orders.map((o) => o.id)).not.toContain(late.orderId); // the hole the rewind closes
    const rewound = await feed(cashier, `&cursor=${encodeURIComponent(cursor)}&includeActive=1&rewindSeconds=30`);
    expect(rewound.orders.map((o) => o.id)).toContain(late.orderId);
    expect(rewound.orders.every((o) => o.outletId === w.outletId)).toBe(true);
    // The rewind never moves the position backwards and is bounded.
    expect(new Date(rewound.nextCursor!.split("|")[0]!).getTime()).toBeGreaterThanOrEqual(cursorAt.getTime());
    expect((await call(Sync, "GET", `orders?outletId=${w.outletId}&cursor=${encodeURIComponent(cursor)}&rewindSeconds=301`, { session: cashier })).status).toBe(422);
  });

  it("includeActive reloads only the authorized outlet: sister-outlet and other-org running orders stay out", async () => {
    const own = await guestOrder();
    const sisterId = (await prisma.outlet.create({ data: { organizationId: w.orgId, code: `SIB${RUN.slice(-4)}`, name: "Sister feed" } })).id;
    const sisterTable = await prisma.restaurantTable.create({ data: { organizationId: w.orgId, outletId: sisterId, code: `S${++n}` } });
    const sisterToken = (await rotateTableQr(w.ctx, sisterTable.id)).qrToken!;
    const sisterPlaced = await call(Guest, "POST", `t/${sisterToken}/orders`, { headers: { "idempotency-key": `sib-${RUN}-${++n}-key` }, body: { items: [{ menuItemId: w.coffee, qty: 1 }] } });
    expect(sisterPlaced.status).toBe(200);
    const foreignTable = await prisma.restaurantTable.create({ data: { organizationId: other.orgId, outletId: other.outletId, code: `F${++n}` } });
    const foreignToken = (await rotateTableQr(other.ctx, foreignTable.id)).qrToken!;
    const foreignMenu = (await prisma.menuItem.findFirstOrThrow({ where: { organizationId: other.orgId, active: true } })).id;
    const foreignPlaced = await call(Guest, "POST", `t/${foreignToken}/orders`, { headers: { "idempotency-key": `for-${RUN}-${++n}-key` }, body: { items: [{ menuItemId: foreignMenu, qty: 1 }] } });
    expect(foreignPlaced.status).toBe(200);

    const f = await feed(cashier, "&includeActive=1");
    const ids = f.orders.map((o) => o.id);
    expect(ids).toContain(own.orderId);
    expect(ids).not.toContain(sisterPlaced.json.data.orderId);
    expect(ids).not.toContain(foreignPlaced.json.data.orderId);
    expect(f.orders.every((o) => o.outletId === w.outletId)).toBe(true);

    expect(f.nextCursor).toBeTruthy();
    const caughtUp = await feed(cashier, `&cursor=${encodeURIComponent(f.nextCursor!)}&includeActive=1`);
    const caughtIds = caughtUp.orders.map((o) => o.id);
    expect(caughtIds).not.toContain(sisterPlaced.json.data.orderId);
    expect(caughtIds).not.toContain(foreignPlaced.json.data.orderId);
    expect(caughtUp.orders.every((o) => o.outletId === w.outletId)).toBe(true);
  });
});

describe("actions: accept + kitchen, idempotent and conflict-aware (scenarios 7, 9, 11, 13, 17, 18)", () => {
  it("accepts once: one KOT, however often the same operation is retried; a different operation finds it already accepted", async () => {
    const placed = await onlineOrder();
    const id = opId();
    const a = await call(Sync, "POST", "ops", { session: cashier, body: { action: "ACCEPT", opId: id, orderId: placed.orderId } });
    expect(a.status).toBe(200);
    expect((a.json.data as SyncOpResult).outcome).toBe("APPLIED");
    expect((a.json.data as SyncOpResult).order.kots).toHaveLength(1);
    const retry = await call(Sync, "POST", "ops", { session: cashier, body: { action: "ACCEPT", opId: id, orderId: placed.orderId } });
    expect(retry.json.data).toMatchObject({ outcome: "APPLIED", replayed: true });
    const second = await call(Sync, "POST", "ops", { session: cashier, body: { action: "ACCEPT", opId: opId(), orderId: placed.orderId } });
    expect(second.json.data).toMatchObject({ outcome: "ALREADY", replayed: false });
    expect(await prisma.kot.count({ where: { orderId: placed.orderId } })).toBe(1);
    expect(await prisma.syncOpReceipt.count({ where: { organizationId: w.orgId, orderId: placed.orderId } })).toBe(2);
    // accepted → the customer-facing tracker follows, and the order is still unpaid
    expect(guestTracker(await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId }, include: { kots: true } })).confirmed).toBe(true);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).status).toBe("SENT");
    expect(await prisma.payment.count({ where: { orderId: placed.orderId } })).toBe(0);
  });

  it("refuses a different request under a used operation id", async () => {
    const a = await guestOrder();
    const b = await guestOrder();
    const id = opId();
    await call(Sync, "POST", "ops", { session: cashier, body: { action: "ACCEPT", opId: id, orderId: a.orderId } });
    expect((await call(Sync, "POST", "ops", { session: cashier, body: { action: "ACCEPT", opId: id, orderId: b.orderId } })).status).toBe(422);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: b.orderId } })).status).toBe("OPEN");
  });

  it("does not let staff without the permission accept or move a ticket, nor other tenants touch the order", async () => {
    const placed = await guestOrder();
    for (const session of [kitchen, accountant]) {
      expect((await call(Sync, "POST", "ops", { session, body: { action: "ACCEPT", opId: opId(), orderId: placed.orderId } })).status).toBe(403);
    }
    expect((await call(Sync, "POST", "ops", { session: foreignOwner, body: { action: "ACCEPT", opId: opId(), orderId: placed.orderId } })).status).toBe(404);
    expect((await call(Sync, "POST", "ops", { session: undefined, body: { action: "ACCEPT", opId: opId(), orderId: placed.orderId } })).status).toBe(401);
    expect((await call(Sync, "POST", "ops", { session: cashier, origin: "https://evil.example", body: { action: "ACCEPT", opId: opId(), orderId: placed.orderId } })).status).toBe(403);
    expect((await call(Sync, "POST", "ops", { session: cashier, body: { action: "ACCEPT", opId: "x", orderId: placed.orderId } })).status).toBe(422);
    expect((await call(Sync, "POST", "ops", { session: cashier, body: { action: "DELETE_EVERYTHING", opId: opId(), orderId: placed.orderId } })).status).toBe(422);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).status).toBe("OPEN");
    expect(await prisma.kot.count({ where: { orderId: placed.orderId } })).toBe(0);
  });

  it("reports a conflict, not a silent overwrite, when the order was cancelled in the cloud first", async () => {
    const placed = await guestOrder();
    await cancelOrder(w.ctx, placed.orderId, "Customer left");
    const r = await call(Sync, "POST", "ops", { session: cashier, body: { action: "ACCEPT", opId: opId(), orderId: placed.orderId } });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ outcome: "CONFLICT" });
    expect(r.json.data.order.status).toBe("CANCELLED");
    expect(await prisma.kot.count({ where: { orderId: placed.orderId } })).toBe(0);
  });

  it("moves a ticket forward once, treats repeats as already done and a stale request as superseded", async () => {
    const placed = await onlineOrder();
    const acc = await call(Sync, "POST", "ops", { session: cashier, body: { action: "ACCEPT", opId: opId(), orderId: placed.orderId } });
    const kotId = (acc.json.data as SyncOpResult).order.kots[0].id;
    const step = (to: string, id = opId()) => call(Sync, "POST", "ops", { session: kitchen, body: { action: "KOT_STATUS", opId: id, orderId: placed.orderId, kotId, to } });
    expect((await step("ACCEPTED")).json.data.outcome).toBe("APPLIED");
    const again = opId();
    expect((await step("PREPARING", again)).json.data.outcome).toBe("APPLIED");
    expect((await step("PREPARING", again)).json.data).toMatchObject({ outcome: "APPLIED", replayed: true });
    expect((await step("PREPARING")).json.data.outcome).toBe("ALREADY");
    expect((await step("READY")).json.data.outcome).toBe("APPLIED");
    expect((await step("ACCEPTED")).json.data.outcome).toBe("SUPERSEDED"); // an old queued request arriving late
    expect((await prisma.kot.findUniqueOrThrow({ where: { id: kotId } })).status).toBe("READY");
    // a ticket of another order is not addressable through this order
    const other2 = await guestOrder();
    expect((await call(Sync, "POST", "ops", { session: kitchen, body: { action: "KOT_STATUS", opId: opId(), orderId: other2.orderId, kotId, to: "SERVED" } })).status).toBe(404);
  });

  it("reaches the same state whether accepted through the sync API or the hosted POS (no second KOT)", async () => {
    const placed = await onlineOrder();
    expect((await call(Orders, "POST", `${placed.orderId}/submit`, { session: cashier, body: {} })).status).toBe(200);
    const r = await call(Sync, "POST", "ops", { session: cashier, body: { action: "ACCEPT", opId: opId(), orderId: placed.orderId } });
    expect(r.json.data.outcome).toBe("ALREADY");
    expect(await prisma.kot.count({ where: { orderId: placed.orderId } })).toBe(1);
  });

  it("keeps an order unpaid until a staff-verified payment, which the feed then carries", async () => {
    const placed = await onlineOrder();
    await call(Sync, "POST", "ops", { session: cashier, body: { action: "ACCEPT", opId: opId(), orderId: placed.orderId } });
    expect((await feed(cashier, "&includeActive=1")).orders.find((x) => x.id === placed.orderId)).toMatchObject({ status: "SENT", payments: [], paidAt: null });
    const total = (await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).total.toString();
    const pay = await call(Payments, "POST", "", { session: cashier, body: { orderId: placed.orderId, method: "CASH", amount: Number(total) } });
    expect(pay.status).toBe(200);
    await call(Payments, "POST", `${pay.json.data.id}/verify`, { session: cashier, body: {} });
    const o = (await feed(cashier, "&includeActive=1&backfillHours=1")).orders.find((x) => x.id === placed.orderId) as WireOrder;
    expect(o.payments.map((p) => p.status)).toContain("SUCCESS");
    expect(o.status).toBe("PAID");
    void Kitchen;
  });

  it("guest QR orders: no acceptance before the online payment is verified (CONFLICT, no KOT), no counter payment; paying releases it once", async () => {
    const placed = await guestOrder();
    const id = opId();
    const r = await call(Sync, "POST", "ops", { session: cashier, body: { action: "ACCEPT", opId: id, orderId: placed.orderId } });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ outcome: "CONFLICT" });
    expect((r.json.data as SyncOpResult).detail).toMatch(/waiting for the guest's online payment/);
    expect((r.json.data as SyncOpResult).order.kots).toHaveLength(0);
    expect((await call(Sync, "POST", "ops", { session: manager, body: { action: "ACCEPT", opId: opId(), orderId: placed.orderId } })).json.data).toMatchObject({ outcome: "CONFLICT" });
    expect((await call(Orders, "POST", `${placed.orderId}/submit`, { session: manager, body: {} })).status).toBe(422);
    const total = Number((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).total);
    expect((await call(Payments, "POST", "", { session: cashier, body: { orderId: placed.orderId, method: "CASH", amount: total } })).status).toBe(422);
    expect(await prisma.kot.count({ where: { orderId: placed.orderId } })).toBe(0);
    const pay = await startGuestPayment(placed.orderId, placed.accessKey, `gp-${RUN}-${++n}-key`);
    await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: pay.paymentId });
    expect(await prisma.kot.count({ where: { orderId: placed.orderId } })).toBe(1);
    expect((await call(Sync, "POST", "ops", { session: cashier, body: { action: "ACCEPT", opId: opId(), orderId: placed.orderId } })).json.data).toMatchObject({ outcome: "ALREADY" });
    expect(await prisma.kot.count({ where: { orderId: placed.orderId } })).toBe(1);
    expect((await getGuestOrder(placed.orderId, placed.accessKey)).tracker.confirmed).toBe(true);
  });

  // 2026-10-19: the desktop settles a cloud order with its device token only (mirrorGuard.createPaymentMirrored).
  // The edge middleware used to 401 it before the router could validate the token.
  it("a linked desktop takes payment for a cloud order with its device token alone (edge + router)", async () => {
    const staff = await makeStaff(w, "MANAGER");
    const token = ((await call(Sync, "POST", "enroll", { body: { email: staff.email, password: PASSWORD } })).json.data as { token: string }).token;
    const bearer = { authorization: `Bearer ${token}` };
    const edge = middleware(new NextRequest("https://restora.example/api/payments", { method: "POST", headers: bearer }));
    expect(edge.headers.get("x-middleware-next")).toBe("1");

    const placed = await onlineOrder();
    await call(Sync, "POST", "ops", { headers: bearer, body: { action: "ACCEPT", opId: opId(), orderId: placed.orderId } });
    const total = Number((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).total);
    const pay = await call(Payments, "POST", "", { headers: { ...bearer, "idempotency-key": `desk-pay-${RUN}` }, body: { orderId: placed.orderId, method: "CASH", amount: total } });
    expect(pay.status).toBe(200);
    const again = await call(Payments, "POST", "", { headers: { ...bearer, "idempotency-key": `desk-pay-${RUN}` }, body: { orderId: placed.orderId, method: "CASH", amount: total } });
    expect(again.json.data.id).toBe(pay.json.data.id); // a retried request is the same payment
    expect((await call(Payments, "POST", `${pay.json.data.id}/verify`, { headers: bearer, body: {} })).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).status).toBe("PAID");
    expect(await prisma.payment.count({ where: { orderId: placed.orderId } })).toBe(1);

    // A revoked device passes the edge (it only sees a Bearer header) but the router refuses it.
    await prisma.cloudDevice.updateMany({ where: { enrolledById: staff.id }, data: { status: "REVOKED", revokedAt: new Date() } });
    const next = await guestOrder();
    expect((await call(Payments, "POST", "", { headers: bearer, body: { orderId: next.orderId, method: "CASH", amount: 1 } })).status).toBe(401);
    expect(await prisma.payment.count({ where: { orderId: next.orderId } })).toBe(0);
  });
});

describe("device pairing and credentials (scenario 8)", () => {
  it("issues a one-time pairing code to a manager and rejects cashiers, reuse, and junk codes", async () => {
    expect((await call(Sync, "POST", "pair", { session: cashier, body: { outletId: w.outletId } })).status).toBe(403);
    const created = await call(Sync, "POST", "pair", { session: manager, body: { outletId: w.outletId } });
    expect(created.status).toBe(200);
    const code = (created.json.data as { code: string }).code;
    expect(code).toMatch(/^[0-9A-HJ-NP-TV-Z]{8}$/);
    const raw = JSON.stringify(created.json);
    expect(raw).not.toMatch(/tokenHash|passwordHash/);
    const first = await call(Sync, "POST", "pair/complete", { body: { code, deviceName: "Till 1" } });
    expect(first.status).toBe(200);
    const token = (first.json.data as { token: string }).token;
    expect(token.length).toBeGreaterThan(20);
    expect((await call(Sync, "POST", "pair/complete", { body: { code } })).status).toBe(401);
    expect((await call(Sync, "POST", "pair/complete", { body: { code: "00000000" } })).status).toBe(401);
    expect((await call(Sync, "GET", `orders?outletId=${w.outletId}`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await call(Sync, "GET", `orders?outletId=${w.outletId}`, { headers: { authorization: "Bearer not-a-device" } })).status).toBe(401);
  });

  it("rejects a revoked or expired device, and does not keep a staff session after password enroll", async () => {
    const staff = await makeStaff(w, "MANAGER");
    const sessionsBefore = await prisma.session.count({ where: { userId: staff.id, revokedAt: null } });
    const enrolled = await call(Sync, "POST", "enroll", { body: { email: staff.email, password: PASSWORD } });
    expect(enrolled.status).toBe(200);
    const token = (enrolled.json.data as { token: string; outlet: { id: string } }).token;
    expect(await prisma.session.count({ where: { userId: staff.id, revokedAt: null } })).toBe(sessionsBefore);
    expect((await call(Sync, "GET", `orders?outletId=${w.outletId}`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    await prisma.cloudDevice.updateMany({ where: { enrolledById: staff.id }, data: { status: "REVOKED", revokedAt: new Date() } });
    expect((await call(Sync, "GET", `orders?outletId=${w.outletId}`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    const expiredStaff = await makeStaff(w, "MANAGER");
    const again = await call(Sync, "POST", "enroll", { body: { email: expiredStaff.email, password: PASSWORD } });
    const expiredToken = (again.json.data as { token: string }).token;
    await prisma.cloudDevice.updateMany({ where: { enrolledById: expiredStaff.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call(Sync, "GET", `orders?outletId=${w.outletId}`, { headers: { authorization: `Bearer ${expiredToken}` } })).status).toBe(401);
    expect((await call(Sync, "POST", "enroll", { body: { email: staff.email, password: "wrong-password" } })).status).toBe(401);
    expect((await call(Sync, "POST", "enroll", { session: cashier, body: { email: staff.email, password: PASSWORD } })).status).toBe(200); // public: session ignored
  });

  it("a device cannot read another outlet, and listing devices does not return credentials", async () => {
    const staff = await makeStaff(w, "MANAGER");
    const enrolled = await call(Sync, "POST", "enroll", { body: { email: staff.email, password: PASSWORD } });
    const token = (enrolled.json.data as { token: string }).token;
    expect((await call(Sync, "GET", `orders?outletId=${other.outletId}`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
    const listed = await call(Sync, "GET", "devices", { session: manager });
    expect(listed.status).toBe(200);
    const body = JSON.stringify(listed.json);
    expect(body).not.toContain(token);
    expect(body).not.toMatch(/tokenHash|passwordHash/);
  });
});

describe("guest QR codes for a linked desktop (/api/sync/qr)", () => {
  it("gives the paired device this outlet's table tokens by code and the configured public address; they open the guest menu", async () => {
    const common = (await rotateOutletCommonQr(w.ctx, w.outletId)).qrToken!;
    const staff = await makeStaff(w, "MANAGER");
    const token = ((await call(Sync, "POST", "enroll", { body: { email: staff.email, password: PASSWORD } })).json.data as { token: string }).token;
    const auth = { authorization: `Bearer ${token}` };
    vi.stubEnv("PUBLIC_BASE_URL", "https://order.cafe.test/");
    try {
      const res = await call(Sync, "GET", `qr?outletId=${w.outletId}`, { headers: auth });
      expect(res.status).toBe(200);
      const qr = res.json.data as WireGuestQr;
      expect(qr.guestBaseUrl).toBe("https://order.cafe.test");
      expect(qr.tables).toContainEqual({ code: w.tableCode, qrToken: w.qrToken });
      expect(qr.commonQrToken).toBe(common);
      // Only tables with a live code; each one is this deployment's guest menu.
      expect(qr.tables.every((t) => typeof t.qrToken === "string")).toBe(true);
      expect((await call(Guest, "GET", `t/${w.qrToken}`)).status).toBe(200);
      expect((await call(Guest, "GET", `t/${common}`)).status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
    vi.stubEnv("PUBLIC_BASE_URL", "");
    try {
      expect(((await call(Sync, "GET", `qr?outletId=${w.outletId}`, { headers: auth })).json.data as WireGuestQr).guestBaseUrl).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is scoped like the hosted Tables screen: no other outlet or organization, the common QR for managers only", async () => {
    const staff = await makeStaff(w, "MANAGER");
    const token = ((await call(Sync, "POST", "enroll", { body: { email: staff.email, password: PASSWORD } })).json.data as { token: string }).token;
    expect((await call(Sync, "GET", `qr?outletId=${other.outletId}`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
    expect((await call(Sync, "GET", `qr?outletId=${w.outletId}`)).status).toBe(401);
    expect((await call(Sync, "GET", `qr?outletId=${w.outletId}`, { session: foreignOwner })).status).toBe(404);
    expect((await call(Sync, "GET", `qr?outletId=${w.outletId}`, { session: otherOutletCashier })).status).toBe(403);
    expect((await call(Sync, "GET", `qr?outletId=${w.outletId}`, { session: customerRole })).status).toBe(403);
    const asCashier = (await call(Sync, "GET", `qr?outletId=${w.outletId}`, { session: cashier })).json.data as WireGuestQr;
    expect(asCashier.tables).toContainEqual({ code: w.tableCode, qrToken: w.qrToken });
    expect(asCashier.commonQrToken).toBeNull();
  });
});
