/**
 * The restaurant's common QR (Outlet.guestQrToken; docs/common-qr-ordering.md):
 * one code for every table. A guest scans it, orders and pays without choosing a
 * table; the order has no table until staff assign one; the kitchen sees it as
 * unassigned; table QR codes keep working alongside it.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { createMenuItem } from "@/server/services/menu";
import { getOutletCommonQr, revokeOutletCommonQr, rotateOutletCommonQr, rotateTableQr } from "@/server/services/masterData";
import {
  guestMenu, lookupTableToken, placeGuestOrder, quoteGuestCart, startGuestPayment, confirmGuestPayment,
  MAX_WAITING_COMMON_QR_ORDERS, PAY_ONLINE_ONLY, ONLINE_PAYMENT_UNAVAILABLE, lockCommonQrCap,
  MAX_WAITING_GUEST_ORDERS, MAX_UNPAID_GUEST_ORDERS,
} from "@/server/services/guestOrdering";
import { listQrOrdersForTables, setOrderTable, TableGuestLimitError } from "@/server/services/orderOps";
import { listKOTs } from "@/server/services/kot";
import { issueTableQrToken, newTableQrToken } from "@/server/qr/tableToken";
import { getRateLimitStore, rateLimitKey, RATE_POLICIES, RateLimitError } from "@/server/api/rateLimit";
import { needsTable, ticketLabel, type KdsTicket } from "@/features/kitchen/kds";

const RUN = Date.now().toString(36);
const pg = (process.env.DATABASE_URL ?? "").startsWith("postgres");
let orgId: string, outletId: string, otherOutletId: string;
let sys: AccessContext, manager: AccessContext, cashier: AccessContext, kitchen: AccessContext, captain: AccessContext;
let dosa: string;
let common: string;
let seq = 0;
const key = () => `cq-${RUN}-${++seq}-abcdef`;
const role = (userId: string, r: string, outlets = [outletId]): AccessContext => ({ userId, organizationId: orgId, outletIds: outlets, roles: [r], outletRoles: Object.fromEntries(outlets.map((o) => [o, [r]])), orgRoles: [], isOrgWide: false, isSuperAdmin: false });
const order = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
const ip = () => `10.9.${Math.floor(seq / 250)}.${(seq % 250) + 1}`;
const place = (token = common, items = [{ menuItemId: dosa, qty: 1 }]) => placeGuestOrder(token, { items, paymentMethod: "ONLINE" }, key(), { ip: ip() });

async function table(code: string, out = outletId) {
  return prisma.restaurantTable.create({ data: { organizationId: orgId, outletId: out, code: `${code}-${RUN}` } });
}
async function paidCommonOrder() {
  const g = await place();
  const pay = await startGuestPayment(g.orderId, g.accessKey, key());
  await confirmGuestPayment(g.orderId, g.accessKey, { paymentId: pay.paymentId });
  return g;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Common QR Org ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `CQ${RUN}`.slice(0, 20), name: "Common Café" } })).id;
  otherOutletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `CQB${RUN}`.slice(0, 20), name: "Second Café" } })).id;
  sys = systemContext(orgId, [outletId, otherOutletId]);
  manager = role(`mgr-${RUN}`, "MANAGER");
  cashier = role(`cash-${RUN}`, "CASHIER");
  kitchen = role(`kit-${RUN}`, "KITCHEN");
  captain = role(`cap-${RUN}`, "CAPTAIN");
  await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId, name: "KITCHEN", kind: "KITCHEN" } });
  dosa = (await createMenuItem(sys, { name: `Dosa ${RUN}`, price: 120, taxPct: 5, station: "KITCHEN" })).id;
  common = (await rotateOutletCommonQr(manager, outletId)).qrToken!;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("issuing the common QR", () => {
  it("is a random 24-character token, audited without the token; only outlet managers manage it", async () => {
    expect(common).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect((await getOutletCommonQr(manager, outletId)).qrToken).toBe(common);
    const audits = await prisma.auditLog.findMany({ where: { entityType: "Outlet", entityId: outletId } });
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) expect(`${a.before ?? ""}${a.after ?? ""}`).not.toContain(common);
    for (const who of [cashier, kitchen, captain]) await expect(rotateOutletCommonQr(who, outletId)).rejects.toBeInstanceOf(ForbiddenError);
    // Another outlet is out of a manager's scope.
    await expect(getOutletCommonQr(manager, otherOutletId)).rejects.toThrow();
  });

  it("rotating kills the old code at once; disabling kills it too; table codes are untouched", async () => {
    const t = await table("ROT");
    const tableToken = (await rotateTableQr(manager, t.id)).qrToken!;
    const first = (await rotateOutletCommonQr(manager, outletId)).qrToken!;
    const second = (await rotateOutletCommonQr(manager, outletId)).qrToken!;
    expect(second).not.toBe(first);
    expect((await lookupTableToken(first)).status).toBe("not_found");
    expect((await lookupTableToken(second)).status).toBe("ok");
    await revokeOutletCommonQr(manager, outletId);
    expect((await lookupTableToken(second)).status).toBe("not_found");
    expect((await lookupTableToken(tableToken)).status).toBe("ok");
    common = (await rotateOutletCommonQr(manager, outletId)).qrToken!;
  });

  it("table and common tokens share one namespace: issuance skips a value an outlet holds", async () => {
    const draws = [common, `fresh${RUN}xx`];
    expect(await issueTableQrToken(prisma, () => draws.shift()!)).toBe(`fresh${RUN}xx`);
  });
});

describe("the guest flow from the common QR", () => {
  it("opens the right restaurant's menu, with no table", async () => {
    const m = await guestMenu(common);
    expect(m.restaurant).toMatchObject({ name: `Common QR Org ${RUN}`, outletName: "Common Café" });
    expect(m.table).toBeNull();
    expect(m.menu.map((i) => i.id)).toContain(dosa);
    const q = await quoteGuestCart(common, { items: [{ menuItemId: dosa, qty: 2 }] });
    expect(Number(q.total)).toBeGreaterThan(0);
  });

  it("invalid, unknown, revoked or inactive-outlet codes all get the same not-found", async () => {
    for (const bad of ["", "short", "x".repeat(65), "../etc", newTableQrToken()]) await expect(guestMenu(bad)).rejects.toBeInstanceOf(NotFoundError);
    const o = await prisma.outlet.create({ data: { organizationId: orgId, code: `CQX${RUN}`.slice(0, 20), name: "Closed Café" } });
    const t = (await rotateOutletCommonQr(sys, o.id)).qrToken!;
    await prisma.outlet.update({ where: { id: o.id }, data: { active: false } });
    expect((await lookupTableToken(t)).status).toBe("inactive");
    await expect(guestMenu(t)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an order needs no table: it is placed without one and waits for its online payment", async () => {
    const g = await place();
    expect(await order(g.orderId)).toMatchObject({ tableId: null, source: "QR", channel: "QR", outletId, status: "OPEN" });
    const alert = await prisma.notification.findFirst({ where: { organizationId: orgId, type: "NEW_ORDER" }, orderBy: { createdAt: "desc" } });
    expect(alert?.title).toBe("New QR order · no table yet");
    // Pay-at-the-counter stays refused on the common QR too.
    await expect(placeGuestOrder(common, { items: [{ menuItemId: dosa, qty: 1 }], paymentMethod: "CASH" }, key(), { ip: ip() })).rejects.toThrow(PAY_ONLINE_ONLY);
  });

  it("a table or outlet named in the request body is refused (strict body): only the code decides, nothing is created", async () => {
    const t = await table("SMUGGLE");
    const before = await prisma.order.count({ where: { organizationId: orgId } });
    await expect(placeGuestOrder(common, { items: [{ menuItemId: dosa, qty: 1 }], paymentMethod: "ONLINE", tableId: t.id, outletId: otherOutletId } as never, key(), { ip: ip() })).rejects.toThrow(/Unrecognized key/);
    expect(await prisma.order.count({ where: { organizationId: orgId } })).toBe(before);
  });

  it("a duplicate submission replays the same order; the same key through a table code is a different order", async () => {
    const k = key();
    const a = await placeGuestOrder(common, { items: [{ menuItemId: dosa, qty: 1 }], paymentMethod: "ONLINE" }, k, { ip: "10.1.1.1" });
    const b = await placeGuestOrder(common, { items: [{ menuItemId: dosa, qty: 1 }], paymentMethod: "ONLINE" }, k, { ip: "10.1.1.1" });
    expect(b).toMatchObject({ orderId: a.orderId, replayed: true });
    const t = await table("IDEM");
    const tableToken = (await rotateTableQr(manager, t.id)).qrToken!;
    const c = await placeGuestOrder(tableToken, { items: [{ menuItemId: dosa, qty: 1 }], paymentMethod: "ONLINE" }, k, { ip: "10.1.1.1" });
    expect(c.orderId).not.toBe(a.orderId);
    expect((await order(c.orderId)).tableId).toBe(t.id);
  });

  it("with SBI UPI selected (a stub until SBI is live) the common QR takes no order and creates nothing", async () => {
    vi.stubEnv("PAYMENT_PROVIDER", "sbi_upi");
    const before = await prisma.order.count({ where: { organizationId: orgId } });
    await expect(place()).rejects.toThrow(ONLINE_PAYMENT_UNAVAILABLE);
    expect(await prisma.order.count({ where: { organizationId: orgId } })).toBe(before);
    expect((await guestMenu(common)).payment.online).toBe(false);
  });

  it("only a server-verified payment sends it to the kitchen, once; it stays without a table", async () => {
    const g = await place();
    const pay = await startGuestPayment(g.orderId, g.accessKey, key());
    // A forged "success" from the browser is not a payment.
    expect(await prisma.kot.count({ where: { orderId: g.orderId } })).toBe(0);
    await confirmGuestPayment(g.orderId, g.accessKey, { paymentId: pay.paymentId });
    await confirmGuestPayment(g.orderId, g.accessKey, { paymentId: pay.paymentId });
    expect(await order(g.orderId)).toMatchObject({ status: "PAID", tableId: null });
    expect(await prisma.kot.count({ where: { orderId: g.orderId } })).toBe(1);
  });
});

describe("kitchen display", () => {
  it("lists the common-QR ticket as unassigned until staff give it a table", async () => {
    const g = await paidCommonOrder();
    const find = async () => (await listKOTs(prisma, kitchen, { outletId })).find((k) => k.orderId === g.orderId)! as unknown as KdsTicket;
    const before = await find();
    expect(before.order?.table).toBeNull();
    expect(needsTable(before)).toBe(true);
    expect(ticketLabel(before)).toBe("QR · no table yet");
    const t = await table("KDS");
    await setOrderTable(cashier, g.orderId, { tableId: t.id });
    const after = await find();
    expect(needsTable(after)).toBe(false);
    expect(ticketLabel(after)).toBe(`Table ${t.code} · QR`);
  });
});

describe("staff assign and change the table", () => {
  it("assigns a table to an order waiting for payment: the table shows occupied; a second assigner is told to reload", async () => {
    const g = await place();
    const t = await table("A1");
    const r = await setOrderTable(cashier, g.orderId, { tableId: t.id });
    expect(r).toMatchObject({ unchanged: false, fromTable: null, toTable: t.code });
    expect((await order(g.orderId)).tableId).toBe(t.id);
    expect((await prisma.restaurantTable.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("OCCUPIED");
    const audit = await prisma.auditLog.findFirst({ where: { entityType: "Order", entityId: g.orderId, action: "UPDATE" }, orderBy: { createdAt: "desc" } });
    expect(audit?.after).toContain("tableAssigned");
    // Changing it now is the normal move (to a free table).
    const t2 = await table("A2");
    await setOrderTable(cashier, g.orderId, { tableId: t2.id });
    expect((await order(g.orderId)).tableId).toBe(t2.id);
  });

  it("a shared table is fine for orders from one group; a table being cleaned is not", async () => {
    const t = await table("SHARE");
    const a = await place();
    const b = await place();
    await setOrderTable(cashier, a.orderId, { tableId: t.id });
    await setOrderTable(cashier, b.orderId, { tableId: t.id });
    expect((await order(b.orderId)).tableId).toBe(t.id);
    const dirty = await table("DIRTY");
    await prisma.restaurantTable.update({ where: { id: dirty.id }, data: { status: "CLEANING" } });
    const c = await place();
    await expect(setOrderTable(cashier, c.orderId, { tableId: dirty.id })).rejects.toBeInstanceOf(ValidationError);
    expect((await order(c.orderId)).tableId).toBeNull();
  });

  it("a prepaid order being cooked can be given (and changed to) its table without touching table states", async () => {
    const g = await paidCommonOrder();
    const t = await table("P1");
    const t2 = await table("P2");
    await setOrderTable(captain, g.orderId, { tableId: t.id });
    await setOrderTable(captain, g.orderId, { tableId: t2.id });
    expect((await order(g.orderId)).tableId).toBe(t2.id);
    for (const id of [t.id, t2.id]) expect((await prisma.restaurantTable.findUniqueOrThrow({ where: { id } })).status).toBe("AVAILABLE");
    // Once the food is served the order is finished: no more changes.
    await prisma.kot.updateMany({ where: { orderId: g.orderId }, data: { status: "SERVED" } });
    await expect(setOrderTable(captain, g.orderId, { tableId: t.id })).rejects.toThrow(/finished/);
  });

  it("refuses another outlet's table, cancelled orders, unknown orders and roles without order.modify", async () => {
    const g = await place();
    const foreign = await table("FOREIGN", otherOutletId);
    await expect(setOrderTable(cashier, g.orderId, { tableId: foreign.id })).rejects.toThrow(/not in this outlet/);
    await expect(setOrderTable(kitchen, g.orderId, { tableId: (await table("K")).id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setOrderTable(cashier, "no-such-order", { tableId: foreign.id })).rejects.toBeInstanceOf(NotFoundError);
    await prisma.order.update({ where: { id: g.orderId }, data: { status: "CANCELLED" } });
    await expect(setOrderTable(cashier, g.orderId, { tableId: (await table("X")).id })).rejects.toBeInstanceOf(ValidationError);
    // A manager of another outlet cannot reach this order.
    const other = role(`mgr2-${RUN}`, "MANAGER", [otherOutletId]);
    await expect(setOrderTable(other, g.orderId, { tableId: foreign.id })).rejects.toThrow();
  });

  it("concurrent assignment: exactly one wins, the other is refused, the table is never overwritten silently", async () => {
    const g = await place();
    const [x, y] = [await table("RACE1"), await table("RACE2")];
    // Both staff saw the order without a table (fromTableId: null), as the counter's list sends it.
    const results = await Promise.allSettled([setOrderTable(cashier, g.orderId, { tableId: x.id, fromTableId: null }), setOrderTable(captain, g.orderId, { tableId: y.id, fromTableId: null })]);
    const won = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof setOrderTable>>> => r.status === "fulfilled");
    expect(won).toHaveLength(1);
    const lost = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
    expect(lost.reason).toBeInstanceOf(ConflictError);
    expect((await order(g.orderId)).tableId).toBe(won[0].value.toTable === x.code ? x.id : y.id);
  });

  it("a second assigner working from a stale view (it saw no table) is refused, not turned into a silent move", async () => {
    const g = await place();
    const [x, y] = [await table("STALE1"), await table("STALE2")];
    await setOrderTable(cashier, g.orderId, { tableId: x.id, fromTableId: null });
    await expect(setOrderTable(captain, g.orderId, { tableId: y.id, fromTableId: null })).rejects.toBeInstanceOf(ConflictError);
    expect((await order(g.orderId)).tableId).toBe(x.id);
    // With the current table in view, changing it is the normal move.
    await expect(setOrderTable(captain, g.orderId, { tableId: y.id, fromTableId: x.id })).resolves.toMatchObject({ fromTable: x.code, toTable: y.code });
    // Callers that send no view keep the previous behaviour (assign, or move when already at a table).
    await expect(setOrderTable(cashier, g.orderId, { tableId: x.id })).resolves.toMatchObject({ toTable: x.code });
  });

  it("refuses a refunded order", async () => {
    const g = await place();
    await prisma.order.update({ where: { id: g.orderId }, data: { status: "REFUNDED" } });
    await expect(setOrderTable(cashier, g.orderId, { tableId: (await table("REF")).id })).rejects.toThrow(/refunded/);
  });

  // A table's guest limits (MAX_WAITING_GUEST_ORDERS waiting for payment, maxUnpaidGuestOrders() unsettled) bound
  // what guests can pile up from its QR. Staff may still seat a group past them, but only deliberately: the first
  // attempt is refused with the numbers, an explicit override goes through and the audit row names it.
  async function qrTableWith(prior: { status: string; n: number }) {
    const t = await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: `LIM-${RUN}-${++seq}`, qrToken: newTableQrToken() } });
    await prisma.order.createMany({ data: Array.from({ length: prior.n }, () => ({ organizationId: orgId, outletId, tableId: t.id, source: "QR", channel: "QR", status: prior.status })) });
    return t;
  }

  it("assigning past a table's waiting-for-payment limit is refused with the numbers; an explicit override is audited and attributable", async () => {
    const t = await qrTableWith({ status: "OPEN", n: MAX_WAITING_GUEST_ORDERS });
    const g = await place();
    const refused = await setOrderTable(cashier, g.orderId, { tableId: t.id }).catch((e) => e);
    expect(refused).toBeInstanceOf(TableGuestLimitError);
    expect(refused).toBeInstanceOf(ConflictError);
    expect(refused.details).toEqual({ table: t.code, waiting: MAX_WAITING_GUEST_ORDERS + 1, waitingLimit: MAX_WAITING_GUEST_ORDERS, unsettled: MAX_WAITING_GUEST_ORDERS + 1, unsettledLimit: MAX_UNPAID_GUEST_ORDERS });
    expect(JSON.stringify(refused.details)).not.toMatch(/qr|token|phone/i);
    expect((await order(g.orderId)).tableId).toBeNull();

    const r = await setOrderTable(cashier, g.orderId, { tableId: t.id, overrideGuestLimits: true });
    expect(r).toMatchObject({ unchanged: false, toTable: t.code });
    expect((await order(g.orderId)).tableId).toBe(t.id);
    const audit = await prisma.auditLog.findFirst({ where: { entityType: "Order", entityId: g.orderId, action: "UPDATE" }, orderBy: { createdAt: "desc" } });
    expect(audit?.actorId).toBe(cashier.userId);
    expect(JSON.parse(audit!.after!)).toMatchObject({ tableAssigned: true, guestLimitOverride: { waiting: MAX_WAITING_GUEST_ORDERS + 1, waitingLimit: MAX_WAITING_GUEST_ORDERS } });

    // The guest limits themselves are unchanged: the table's own QR still refuses a new guest order.
    await expect(place(t.qrToken!)).rejects.toThrow(/waiting for payment/);
  });

  it("the unsettled limit counts too; at or under both limits no override is asked for or recorded", async () => {
    const full = await qrTableWith({ status: "SENT", n: MAX_UNPAID_GUEST_ORDERS });
    const g = await place();
    await expect(setOrderTable(captain, g.orderId, { tableId: full.id })).rejects.toBeInstanceOf(TableGuestLimitError);
    const edge = await qrTableWith({ status: "OPEN", n: MAX_WAITING_GUEST_ORDERS - 1 });
    await setOrderTable(captain, g.orderId, { tableId: edge.id });
    const audit = await prisma.auditLog.findFirst({ where: { entityType: "Order", entityId: g.orderId, action: "UPDATE" }, orderBy: { createdAt: "desc" } });
    expect(audit?.after).not.toContain("guestLimitOverride");
    // The override needs the same permission as assigning at all.
    const h = await place();
    await expect(setOrderTable(kitchen, h.orderId, { tableId: full.id, overrideGuestLimits: true })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("two staff seating two orders at one table at once cannot both slip under its limit", async () => {
    const t = await qrTableWith({ status: "OPEN", n: MAX_WAITING_GUEST_ORDERS - 1 });
    const [a, b] = [await place(), await place()];
    const rs = await Promise.allSettled([setOrderTable(cashier, a.orderId, { tableId: t.id }), setOrderTable(captain, b.orderId, { tableId: t.id })]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = rs.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
    expect(lost.reason).toBeInstanceOf(TableGuestLimitError);
    expect(await prisma.order.count({ where: { tableId: t.id, source: "QR", status: "OPEN" } })).toBe(MAX_WAITING_GUEST_ORDERS);
  });

  it("the counter's list shows QR orders without a table first", async () => {
    const g = await place();
    const rows = await listQrOrdersForTables(cashier, { outletId });
    const firstWithTable = rows.findIndex((r) => r.tableId);
    const mine = rows.findIndex((r) => r.id === g.orderId);
    expect(mine).toBeGreaterThanOrEqual(0);
    if (firstWithTable >= 0) expect(mine).toBeLessThan(firstWithTable);
    await expect(listQrOrdersForTables(cashier, { outletId: otherOutletId })).rejects.toThrow();
  });
});

describe("abuse guards on a code every table shares", () => {
  it("the order limit counts per device on the common QR, not for the whole restaurant", async () => {
    const store = getRateLimitStore();
    const k = rateLimitKey(RATE_POLICIES.guestOrderPerTable, `${common}:10.66.0.1`);
    for (let i = 0; i < RATE_POLICIES.guestOrderPerTable.limit; i++) await store.hit(k, RATE_POLICIES.guestOrderPerTable.windowMs);
    await expect(placeGuestOrder(common, { items: [{ menuItemId: dosa, qty: 1 }], paymentMethod: "ONLINE" }, key(), { ip: "10.66.0.1" })).rejects.toBeInstanceOf(RateLimitError);
    await expect(placeGuestOrder(common, { items: [{ menuItemId: dosa, qty: 1 }], paymentMethod: "ONLINE" }, key(), { ip: "10.66.0.2" })).resolves.toMatchObject({ replayed: false });
    await store.reset(k);
  });

  it("the cap holds under concurrent submissions: from 29 waiting, five at once let exactly one through", async () => {
    const o = await prisma.outlet.create({ data: { organizationId: orgId, code: `CQR${RUN}`.slice(0, 20), name: "Race Café" } });
    const t = (await rotateOutletCommonQr(sys, o.id)).qrToken!;
    await prisma.order.createMany({ data: Array.from({ length: MAX_WAITING_COMMON_QR_ORDERS - 1 }, () => ({ organizationId: orgId, outletId: o.id, source: "QR", channel: "QR", status: "OPEN" })) });
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => placeGuestOrder(t, { items: [{ menuItemId: dosa, qty: 1 }], paymentMethod: "ONLINE" }, key(), { ip: `10.77.0.${i + 1}` })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(String((r.reason as Error).message)).toMatch(/Many orders are waiting/);
    expect(await prisma.order.count({ where: { outletId: o.id, status: "OPEN", tableId: null } })).toBe(MAX_WAITING_COMMON_QR_ORDERS);
  });

  // Deterministic interleaving (PostgreSQL, where new orders run READ COMMITTED): the test holds the outlet's
  // cap lock, so every submission inserts its order and stops at the in-transaction count at the same time —
  // the window in which a plain count let all of them through (5 of 5 from 29 waiting, before the lock).
  it.runIf(pg)("PostgreSQL: four submissions all past the early check from 28 waiting — exactly two placed, nothing left by the refused", async () => {
    const o = await prisma.outlet.create({ data: { organizationId: orgId, code: `CQL${RUN}`.slice(0, 20), name: "Barrier Café" } });
    const t = (await rotateOutletCommonQr(sys, o.id)).qrToken!;
    await prisma.order.createMany({ data: Array.from({ length: MAX_WAITING_COMMON_QR_ORDERS - 2 }, () => ({ organizationId: orgId, outletId: o.id, source: "QR", channel: "QR", status: "OPEN" })) });
    const ledgerBefore = await prisma.inventoryLedger.count({ where: { outletId: o.id } });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const lockHeld = new Promise<void>((r) => (held = r));
    const holder = prisma.$transaction(async (tx) => {
      await lockCommonQrCap(tx, o.id);
      held();
      await released;
    }, { timeout: 60_000 });
    await lockHeld;
    const submissions = Array.from({ length: 4 }, () => placeGuestOrder(t, { items: [{ menuItemId: dosa, qty: 1 }], paymentMethod: "ONLINE" }, key(), { ip: ip() }));
    // Barrier: all four are waiting on the cap lock, i.e. each has its order inserted and is about to count.
    const waiting = () => prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`.then((r) => r[0].n);
    try {
      const deadline = Date.now() + 10_000;
      while ((await waiting()) < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(await waiting()).toBe(4);
    } finally {
      release();
      await holder;
    }
    const results = await Promise.allSettled(submissions);
    const placed = results.filter((r): r is PromiseFulfilledResult<Awaited<(typeof submissions)[number]>> => r.status === "fulfilled");
    expect(placed).toHaveLength(2);
    for (const r of results) if (r.status === "rejected") expect(String((r.reason as Error).message)).toMatch(/Many orders are waiting/);
    expect(await prisma.order.count({ where: { outletId: o.id, source: "QR", status: "OPEN", tableId: null } })).toBe(MAX_WAITING_COMMON_QR_ORDERS);
    // The refused submissions rolled back whole: only the two placed orders have lines, audit rows and staff alerts.
    const placedIds = placed.map((r) => r.value.orderId).sort();
    expect((await prisma.orderItem.findMany({ where: { outletId: o.id }, select: { orderId: true } })).map((i) => i.orderId).sort()).toEqual(placedIds);
    // (Each placed order has two CREATE rows — placeOrder's and the guest one — so compare the orders audited.)
    expect([...new Set((await prisma.auditLog.findMany({ where: { outletId: o.id, entityType: "Order" }, select: { entityId: true } })).map((a) => a.entityId))].sort()).toEqual(placedIds);
    expect(await prisma.notification.count({ where: { outletId: o.id, type: "NEW_ORDER" } })).toBe(2);
    expect(await prisma.payment.count({ where: { outletId: o.id } })).toBe(0);
    expect(await prisma.kot.count({ where: { outletId: o.id } })).toBe(0);
    expect(await prisma.inventoryLedger.count({ where: { outletId: o.id } })).toBe(ledgerBefore);
  });

  it("below the cap, simultaneous orders from different phones are all placed", async () => {
    const o = await prisma.outlet.create({ data: { organizationId: orgId, code: `CQP${RUN}`.slice(0, 20), name: "Many Phones Café" } });
    const t = (await rotateOutletCommonQr(sys, o.id)).qrToken!;
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => placeGuestOrder(t, { items: [{ menuItemId: dosa, qty: 1 }], paymentMethod: "ONLINE" }, key(), { ip: ip() })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(6);
    expect(await prisma.order.count({ where: { outletId: o.id, tableId: null, status: "OPEN" } })).toBe(6);
  });

  it("a duplicate submission sent several times at once at the cap's edge places one order; the cap then holds", async () => {
    const o = await prisma.outlet.create({ data: { organizationId: orgId, code: `CQD${RUN}`.slice(0, 20), name: "Retry Café" } });
    const t = (await rotateOutletCommonQr(sys, o.id)).qrToken!;
    await prisma.order.createMany({ data: Array.from({ length: MAX_WAITING_COMMON_QR_ORDERS - 1 }, () => ({ organizationId: orgId, outletId: o.id, source: "QR", channel: "QR", status: "OPEN" })) });
    const k = key();
    const phone = ip();
    const results = await Promise.all(Array.from({ length: 4 }, () => placeGuestOrder(t, { items: [{ menuItemId: dosa, qty: 1 }], paymentMethod: "ONLINE" }, k, { ip: phone })));
    expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await prisma.order.count({ where: { outletId: o.id, tableId: null, status: "OPEN" } })).toBe(MAX_WAITING_COMMON_QR_ORDERS);
    await expect(placeGuestOrder(t, { items: [{ menuItemId: dosa, qty: 1 }], paymentMethod: "ONLINE" }, key(), { ip: ip() })).rejects.toThrow(/Many orders are waiting/);
  });

  it("only unpaid, unseated, recent common-QR orders count: paid, cancelled, refunded and seated ones do not", async () => {
    const o = await prisma.outlet.create({ data: { organizationId: orgId, code: `CQS${RUN}`.slice(0, 20), name: "Settled Café" } });
    const t = (await rotateOutletCommonQr(sys, o.id)).qrToken!;
    const seat = await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId: o.id, code: `S${RUN}` } });
    const n = MAX_WAITING_COMMON_QR_ORDERS;
    const rows = (status: string, tableId: string | null = null) => Array.from({ length: n }, () => ({ organizationId: orgId, outletId: o.id, source: "QR", channel: "QR", status, tableId }));
    await prisma.order.createMany({ data: [...rows("PAID"), ...rows("CANCELLED"), ...rows("REFUNDED"), ...rows("OPEN", seat.id)] });
    await expect(placeGuestOrder(t, { items: [{ menuItemId: dosa, qty: 1 }], paymentMethod: "ONLINE" }, key(), { ip: ip() })).resolves.toMatchObject({ replayed: false });
  });

  it("caps recent unpaid orders without a table, restaurant-wide; older abandoned ones stop counting", async () => {
    const o = await prisma.outlet.create({ data: { organizationId: orgId, code: `CQC${RUN}`.slice(0, 20), name: "Busy Café" } });
    const t = (await rotateOutletCommonQr(sys, o.id)).qrToken!;
    await prisma.order.createMany({ data: Array.from({ length: MAX_WAITING_COMMON_QR_ORDERS }, () => ({ organizationId: orgId, outletId: o.id, source: "QR", channel: "QR", status: "OPEN" })) });
    await expect(placeGuestOrder(t, { items: [{ menuItemId: dosa, qty: 1 }], paymentMethod: "ONLINE" }, key(), { ip: ip() })).rejects.toThrow(/Many orders are waiting/);
    await prisma.order.updateMany({ where: { outletId: o.id }, data: { createdAt: new Date(Date.now() - 60 * 60_000) } });
    await expect(placeGuestOrder(t, { items: [{ menuItemId: dosa, qty: 1 }], paymentMethod: "ONLINE" }, key(), { ip: ip() })).resolves.toMatchObject({ replayed: false });
  });
});

describe("audit and scanner see the common QR", () => {
  it("qr:audit reports it as a '(restaurant QR)' row, classified, never the token", async () => {
    const { auditTableTokens, COMMON_QR_ROW } = await import("../../scripts/qr/audit-table-tokens");
    const rows = await auditTableTokens(prisma);
    const outletCode = (await prisma.outlet.findUniqueOrThrow({ where: { id: outletId } })).code;
    expect(rows.find((r) => r.outlet === outletCode && r.code === COMMON_QR_ROW)).toMatchObject({ class: "random" });
    expect(JSON.stringify(rows)).not.toContain(common);
  });

  it("the staff scanner reports it valid with no table", async () => {
    const { scanTableQr } = await import("@/server/qr/scan");
    const r = await scanTableQr(manager, { text: `http://localhost:3000/t/${common}` }, { requestOrigin: "http://localhost:3000" });
    expect(r).toMatchObject({ status: "valid", table: null, outletName: "Common Café" });
    // Like a table code: staff get the guest link to open; every other field carries only a masked hint.
    const { guestUrl: _link, ...rest } = r as { guestUrl?: string };
    void _link;
    expect(JSON.stringify(rest)).not.toContain(common);
  });
});
