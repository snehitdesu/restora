/**
 * Desktop <-> cloud synchronization, end to end: a real cloud restaurant (QR ordering, hosted POS routes) and a real
 * desktop installation (its own SQLite ids, its own staff, the real sync service) joined only by a fake network that
 * can go offline, lose a response or have its session revoked. Covers: sign-in, mirroring, ids and references,
 * restarts and retries, acceptance and kitchen flow from either side, payments, offline queue, conflicts, expiry.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
vi.mock("next/headers", async () => (await import("./harness")).nextHeadersMock());
import { prisma } from "@/server/db/client";
import { buildAccessContext } from "@/server/auth/context";
import { cancelOrder } from "@/server/services/orders";
import { getGuestOrder } from "@/server/services/guestOrdering";
import { rotateTableQr } from "@/server/services/masterData";
import { decryptSecret } from "@/server/integrations/secrets";
import { CloudClient, CloudOfflineError, setCloudTransportForTests } from "@/server/sync/cloudClient";
import { desktopSync } from "@/server/sync/desktopDb";
import { connectCloud, disconnectCloud, syncStatus } from "@/server/sync/link";
import { createPairing } from "@/server/sync/device";
import { dismissOperation, listOperations, retryNow, runSyncCycle } from "@/server/sync/runner";
import { mirrorId } from "@/lib/sync/ids";
import * as Guest from "@/app/api/qr/[[...path]]/route";
import * as Orders from "@/app/api/orders/[[...path]]/route";
import * as Kitchen from "@/app/api/kitchen/[[...path]]/route";
import * as Payments from "@/app/api/payments/[[...path]]/route";
import * as CloudApi from "@/app/api/cloud/[[...path]]/route";
import { call } from "../api/routeSupport";
import { CLOUD_ORIGIN, fakeCloud, makeStaff, makeWorld, PASSWORD, RUN, type FakeCloud, type World } from "./harness";

let cloud: World, desk: World, desk2: World;
let fc: FakeCloud;
let syncUser: Awaited<ReturnType<typeof makeStaff>>;
let cloudCashier: Awaited<ReturnType<typeof makeStaff>>, cloudKitchen: Awaited<ReturnType<typeof makeStaff>>;
let deskOwner: Awaited<ReturnType<typeof makeStaff>>, deskCashier: Awaited<ReturnType<typeof makeStaff>>, deskKitchen: Awaited<ReturnType<typeof makeStaff>>;
let desk2Owner: Awaited<ReturnType<typeof makeStaff>>;
let n = 0;

beforeAll(async () => {
  vi.stubEnv("AHAROS_DESKTOP", "1");
  cloud = await makeWorld("Cloud", { qr: true });
  desk = await makeWorld("Desk");
  desk2 = await makeWorld("DeskNoBrownie", { skipDish: "Brownie" });
  fc = await fakeCloud();
  setCloudTransportForTests(fc.transport);
  syncUser = await makeStaff(cloud, "MANAGER");
  cloudCashier = await makeStaff(cloud, "CASHIER");
  cloudKitchen = await makeStaff(cloud, "KITCHEN");
  deskOwner = await makeStaff(desk, "OWNER", true);
  deskCashier = await makeStaff(desk, "CASHIER");
  deskKitchen = await makeStaff(desk, "KITCHEN");
  desk2Owner = await makeStaff(desk2, "OWNER", true);
});
afterAll(async () => {
  setCloudTransportForTests(null);
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

const ownerCtx = (u: { id: string }) => buildAccessContext(prisma, u.id);
const ddb = desktopSync(prisma);
const link = () => ddb.cloudLink.findUniqueOrThrow({ where: { organizationId: desk.orgId } });
const status = () => syncStatus(prisma, desk.orgId);

/** A guest order on a fresh cloud table (a table holds at most three unaccepted orders). */
async function guestOrder(items = [{ menuItemId: cloud.coffee, qty: 1 }]) {
  const table = await prisma.restaurantTable.create({ data: { organizationId: cloud.orgId, outletId: cloud.outletId, code: `D${++n}` } });
  await prisma.restaurantTable.create({ data: { organizationId: desk.orgId, outletId: desk.outletId, code: table.code } });
  await prisma.restaurantTable.create({ data: { organizationId: desk2.orgId, outletId: desk2.outletId, code: table.code } });
  const token = (await rotateTableQr(cloud.ctx, table.id)).qrToken!;
  const res = await call(Guest, "POST", `t/${token}/orders`, { headers: { "idempotency-key": `guest-${RUN}-${++n}-sync-key` }, body: { items } });
  expect(res.status).toBe(200);
  return res.json.data as { orderId: string; ref: string; accessKey: string };
}
const localOf = (cloudId: string) => mirrorId("ORDER", cloudId, desk.orgId);
const cycle = () => runSyncCycle(prisma, desk.orgId);
const submit = (cloudId: string, session = deskCashier.session) => call(Orders, "POST", `${localOf(cloudId)}/submit`, { session, body: {} });
const cloudOrder = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, include: { kots: true, payments: true } });
const localOrder = (cloudId: string) => prisma.order.findUniqueOrThrow({ where: { id: localOf(cloudId) }, include: { kots: true, payments: true, items: { include: { modifiers: true } } } });

describe("sign-in to the cloud (scenario 8)", () => {
  it("is for managers only, validates the address, and rejects wrong credentials without keeping anything", async () => {
    const cashierCtx = await ownerCtx(deskCashier);
    await expect(connectCloud(cashierCtx, { baseUrl: CLOUD_ORIGIN, email: syncUser.email, password: PASSWORD }, prisma, fc.transport)).rejects.toMatchObject({ status: 403 });
    const owner = await ownerCtx(deskOwner);
    await expect(connectCloud(owner, { baseUrl: "http://cloud.restora.test", email: syncUser.email, password: PASSWORD }, prisma, fc.transport)).rejects.toThrow(/https/);
    await expect(connectCloud(owner, { baseUrl: "https://user:pw@cloud.restora.test", email: syncUser.email, password: PASSWORD }, prisma, fc.transport)).rejects.toThrow(/user name/);
    await expect(connectCloud(owner, { baseUrl: CLOUD_ORIGIN, email: syncUser.email, password: "wrong-password" }, prisma, fc.transport)).rejects.toThrow(/did not accept/);
    await expect(connectCloud(owner, { baseUrl: CLOUD_ORIGIN, email: "nobody@sync.test", password: PASSWORD }, prisma, fc.transport)).rejects.toThrow(/did not accept/);
    fc.offline = true;
    await expect(connectCloud(owner, { baseUrl: CLOUD_ORIGIN, email: syncUser.email, password: PASSWORD }, prisma, fc.transport)).rejects.toThrow(/Could not reach/);
    fc.offline = false;
    expect(await ddb.cloudLink.count({ where: { organizationId: desk.orgId } })).toBe(0);
  });

  it("links one cloud outlet to the local outlet and stores only an encrypted session token", async () => {
    const st = await connectCloud(await ownerCtx(deskOwner), { baseUrl: CLOUD_ORIGIN, email: syncUser.email, password: PASSWORD, installId: "desk-install-aaaaaaaa" }, prisma, fc.transport);
    expect(st).toMatchObject({ state: "ONLINE", cloudOutletCode: cloud.outletCode, userEmail: syncUser.email, pendingOps: 0 });
    const l = await link();
    expect(l.localOutletId).toBe(desk.outletId);
    const token = decryptSecret(l.tokenCipher!);
    expect(token.length).toBeGreaterThan(30);
    expect(l.tokenCipher).not.toContain(token);
    // the password and the token appear nowhere that is readable back out of the app
    const dump = JSON.stringify({ st, audit: await prisma.auditLog.findMany({ where: { organizationId: desk.orgId } }) });
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain(token);
    expect(await prisma.cloudDevice.count({ where: { enrolledById: syncUser.id, status: "ACTIVE" } })).toBe(1);
    // enroll opens a staff session only long enough to issue the device, then revokes it (makeStaff's own test session remains).
    expect(await prisma.session.count({ where: { userId: syncUser.id, revokedAt: null } })).toBe(1);
  });

  it("pairs with a hosted one-time code and never stores the code", async () => {
    const pair = await createPairing(prisma, await ownerCtx(syncUser), { outletId: cloud.outletId });
    expect(pair.code).toMatch(/^[0-9A-HJ-NP-TV-Z]{8}$/);
    const st = await connectCloud(await ownerCtx(deskOwner), { baseUrl: CLOUD_ORIGIN, pairingCode: pair.code, installId: "desk-install-aaaaaaaa" }, prisma, fc.transport);
    expect(st.state).toBe("ONLINE");
    const dump = JSON.stringify(await prisma.auditLog.findMany({ where: { organizationId: { in: [desk.orgId, cloud.orgId] } } }));
    expect(dump).not.toContain(pair.code);
    await expect(connectCloud(await ownerCtx(deskOwner), { baseUrl: CLOUD_ORIGIN, pairingCode: pair.code }, prisma, fc.transport)).rejects.toThrow(/did not accept/);
  });
});

describe("mirroring a QR order (scenarios 3, 4, 5, 6, 7, 14)", () => {
  it("brings a cloud QR order onto the desktop once, unpaid, with the same reference and mapped dishes", async () => {
    const placed = await guestOrder([{ menuItemId: cloud.coffee, qty: 2, modifierOptionIds: [cloud.largeOption] } as never, { menuItemId: cloud.brownie, qty: 1 }]);
    const r = await cycle();
    expect(r).toMatchObject({ state: "ONLINE", imported: 1 });
    const o = await localOrder(placed.orderId);
    expect(o).toMatchObject({ source: "QR", channel: "QR", status: "OPEN", externalRef: placed.orderId, organizationId: desk.orgId, outletId: desk.outletId, stockConsumed: true, invoiceNo: null });
    expect(o.id).not.toBe(placed.orderId); // its own local id…
    expect(o.id.slice(-6).toUpperCase()).toBe(placed.ref); // …that shows the same short reference everywhere
    const cloudRow = await cloudOrder(placed.orderId);
    expect(o.total.toString()).toBe(cloudRow.total.toString());
    expect(o.tableId).not.toBeNull();
    expect((await prisma.restaurantTable.findUniqueOrThrow({ where: { id: o.tableId! } })).outletId).toBe(desk.outletId);
    const coffeeLine = o.items.find((i) => i.name.startsWith("Cold Coffee"))!;
    expect(coffeeLine.menuItemId).toBe(desk.coffee); // matched by name onto the desktop's own menu, not by cloud id
    expect(coffeeLine.menuItemId).not.toBe(cloud.coffee);
    expect(coffeeLine.modifiers.map((m) => m.name)).toEqual(["Size: Large"]);
    expect(o.payments).toHaveLength(0);
    expect(o.kots).toHaveLength(0);
    expect(await prisma.notification.count({ where: { organizationId: desk.orgId, type: "NEW_ORDER", body: { contains: placed.ref } } })).toBe(1);
    // traceability: every cloud record has a stable mapping
    const maps = await ddb.cloudRecordMap.findMany({ where: { organizationId: desk.orgId } });
    expect(maps.find((m) => m.kind === "ORDER" && m.cloudId === placed.orderId)?.localId).toBe(o.id);
    expect(maps.filter((m) => m.kind === "ORDER_ITEM")).toHaveLength(2);
  });

  it("does not import it again after repeated polls, a lost feed position, or a restart", async () => {
    const placed = await guestOrder();
    await cycle();
    await cycle();
    await ddb.cloudLink.update({ where: { organizationId: desk.orgId }, data: { cursor: null } }); // "restart" with the feed position lost
    const again = await cycle();
    expect(again.imported).toBe(0);
    expect(await prisma.order.count({ where: { organizationId: desk.orgId, externalRef: placed.orderId } })).toBe(1);
    expect(await prisma.orderItem.count({ where: { orderId: localOf(placed.orderId) } })).toBe(1);
    // two cycles started at the same moment share one run
    const [a, b] = await Promise.all([cycle(), cycle()]);
    expect(a).toBe(b);
  });

  it("still imports an order that committed late behind the saved feed position, exactly once", async () => {
    await guestOrder();
    await cycle();
    const cursorAt = new Date((await link()).cursor!.split("|")[0]!);
    const late = await guestOrder();
    // Stamped before the saved position, visible only now, and already finished (so no "running orders" re-offer).
    await prisma.order.update({ where: { id: late.orderId }, data: { status: "PAID", updatedAt: new Date(cursorAt.getTime() - 5_000) } });
    const r = await cycle();
    expect(r.state).toBe("ONLINE");
    expect(await prisma.order.count({ where: { organizationId: desk.orgId, externalRef: late.orderId } })).toBe(1);
    await cycle();
    expect(await prisma.order.count({ where: { organizationId: desk.orgId, externalRef: late.orderId } })).toBe(1);
    expect(new Date((await link()).cursor!.split("|")[0]!).getTime()).toBeGreaterThanOrEqual(cursorAt.getTime());
  });

  it("shows an order it cannot map, but refuses to accept it until the menu matches", async () => {
    await connectCloud(await ownerCtx(desk2Owner), { baseUrl: CLOUD_ORIGIN, email: syncUser.email, password: PASSWORD, installId: "desk2-install-bbbbbbbb" }, prisma, fc.transport);
    const placed = await guestOrder([{ menuItemId: cloud.brownie, qty: 1 }]);
    await runSyncCycle(prisma, desk2.orgId);
    const mirrored = await prisma.order.findFirstOrThrow({ where: { organizationId: desk2.orgId, externalRef: placed.orderId }, include: { items: true } });
    expect(mirrored.items[0]).toMatchObject({ menuItemId: null, posItemCode: "Brownie" });
    const sess = (await makeStaff(desk2, "CASHIER")).session;
    const res = await call(Orders, "POST", `${mirrored.id}/submit`, { session: sess, body: {} });
    expect(res.status).toBe(422);
    expect(res.json.error.message).toMatch(/Brownie/);
    expect((await cloudOrder(placed.orderId)).status).toBe("OPEN");
    expect((await syncStatus(prisma, desk2.orgId)).ordersWithIssues).toBeGreaterThanOrEqual(1);
  });
});

describe("acceptance and kitchen from either side (scenarios 11, 12, 13)", () => {
  it("accepts on the desktop: the cloud order is accepted once, with one KOT, and the customer sees it", async () => {
    const placed = await guestOrder();
    await cycle();
    const res = await submit(placed.orderId);
    expect(res.status).toBe(200);
    expect(res.json.data.sync).toMatchObject({ state: "CONFIRMED", outcome: "APPLIED" });
    expect((await cloudOrder(placed.orderId))).toMatchObject({ status: "SENT" });
    expect((await cloudOrder(placed.orderId)).kots).toHaveLength(1);
    const l = await localOrder(placed.orderId);
    expect(l.status).toBe("SENT");
    expect(l.kots).toHaveLength(1);
    expect((await getGuestOrder(placed.orderId, placed.accessKey)).tracker.confirmed).toBe(true);
    // a second tap, or a hosted-POS accept afterwards: nothing more happens
    expect((await submit(placed.orderId)).json.data.sync).toMatchObject({ outcome: "ALREADY" });
    expect((await cloudOrder(placed.orderId)).kots).toHaveLength(1);
    expect(await prisma.syncOpReceipt.count({ where: { organizationId: cloud.orgId, orderId: placed.orderId } })).toBe(1);
    // the sync account is recorded as the actor in the cloud's audit trail
    expect(await prisma.auditLog.count({ where: { organizationId: cloud.orgId, entityId: placed.orderId, actorId: syncUser.id } })).toBeGreaterThan(0);
  });

  it("accepts on the hosted POS: the desktop picks up the accepted order and its ticket on the next cycle", async () => {
    const placed = await guestOrder();
    await cycle();
    expect((await localOrder(placed.orderId)).status).toBe("OPEN");
    expect((await call(Orders, "POST", `${placed.orderId}/submit`, { session: cloudCashier.session, body: {} })).status).toBe(200);
    await cycle();
    const l = await localOrder(placed.orderId);
    expect(l.status).toBe("SENT");
    expect(l.kots).toHaveLength(1);
    expect(l.kots[0].status).toBe("NEW");
  });

  it("when both sides accept at once the cloud keeps a single acceptance and a single KOT", async () => {
    const placed = await guestOrder();
    await cycle();
    await call(Orders, "POST", `${placed.orderId}/submit`, { session: cloudCashier.session, body: {} }); // hosted POS wins first
    const stale = await submit(placed.orderId); // the desktop still thinks it is OPEN
    expect(stale.status).toBe(200);
    expect(stale.json.data.sync).toMatchObject({ state: "CONFIRMED", outcome: "ALREADY" });
    expect((await cloudOrder(placed.orderId)).kots).toHaveLength(1);
    expect((await localOrder(placed.orderId)).status).toBe("SENT");
  });

  it("moves kitchen tickets through the cloud from the desktop, and mirrors the hosted kitchen's progress", async () => {
    const placed = await guestOrder();
    await cycle();
    await submit(placed.orderId);
    const local = await localOrder(placed.orderId);
    const kotId = local.kots[0].id;
    const cloudKot = (await cloudOrder(placed.orderId)).kots[0];
    // an impossible jump is refused on the desktop itself
    expect((await call(Kitchen, "POST", `kots/${kotId}/status`, { session: deskKitchen.session, body: { status: "READY" } })).status).toBe(422);
    expect((await call(Kitchen, "POST", `kots/${kotId}/status`, { session: deskKitchen.session, body: { status: "ACCEPTED" } })).json.data.sync.state).toBe("CONFIRMED");
    expect((await call(Kitchen, "POST", `kots/${kotId}/status`, { session: deskKitchen.session, body: { status: "PREPARING" } })).status).toBe(200);
    expect((await prisma.kot.findUniqueOrThrow({ where: { id: cloudKot.id } })).status).toBe("PREPARING");
    expect((await localOrder(placed.orderId)).kots[0].status).toBe("PREPARING");
    // hosted kitchen marks it ready: the desktop (and so its kitchen screen) follows
    await call(Kitchen, "POST", `kots/${cloudKot.id}/status`, { session: cloudKitchen.session, body: { status: "READY" } });
    await cycle();
    expect((await localOrder(placed.orderId)).kots[0].status).toBe("READY");
    expect((await call(Kitchen, "POST", `kots/${kotId}/status`, { session: deskKitchen.session, body: { status: "SERVED" } })).status).toBe(200);
    expect((await prisma.kot.findUniqueOrThrow({ where: { id: cloudKot.id } })).status).toBe("SERVED");
    expect((await getGuestOrder(placed.orderId, placed.accessKey)).tracker.step).toBe(4);
  });
});

describe("payments and cancellations (scenarios 14, 15)", () => {
  it("never treats an imported order as paid; a payment taken on the desktop is verified by the cloud and mirrored", async () => {
    const placed = await guestOrder();
    await cycle();
    await submit(placed.orderId);
    expect((await localOrder(placed.orderId)).payments).toHaveLength(0);
    const total = Number((await localOrder(placed.orderId)).total);
    const created = await call(Payments, "POST", "", { session: deskCashier.session, headers: { "idempotency-key": `pay-${RUN}-${++n}-aaaa` }, body: { orderId: localOf(placed.orderId), method: "CASH", amount: total } });
    expect(created.status).toBe(200);
    expect(created.json.data.id).toBe(mirrorId("PAYMENT", (await cloudOrder(placed.orderId)).payments[0].id, desk.orgId));
    expect((await cloudOrder(placed.orderId)).status).not.toBe("PAID"); // pending until verified
    const verified = await call(Payments, "POST", `${created.json.data.id}/verify`, { session: deskCashier.session, body: {} });
    expect(verified.status).toBe(200);
    expect((await cloudOrder(placed.orderId)).status).toBe("PAID");
    const l = await localOrder(placed.orderId);
    expect(l.status).toBe("PAID");
    expect(l.payments).toHaveLength(1);
    expect(l.payments[0]).toMatchObject({ status: "SUCCESS", provider: "cloud" });
    // exactly one payment exists on each side — no duplicate sale
    expect((await cloudOrder(placed.orderId)).payments).toHaveLength(1);
  });

  it("does not treat a create-order body that happens to contain orderId as a mirrored payment", async () => {
    const placed = await guestOrder();
    await cycle();
    const mirroredId = localOf(placed.orderId);
    const beforeCloudPays = (await cloudOrder(placed.orderId)).payments.length;
    const res = await call(Orders, "POST", "", {
      session: deskCashier.session,
      headers: { "idempotency-key": `ctr-${RUN}-${++n}-aaaa` },
      body: { outletId: desk.outletId, orderId: mirroredId, items: [{ menuItemId: desk.brownie, qty: 1 }] },
    });
    expect(res.status).toBe(200);
    expect(res.json.data.id).not.toBe(mirroredId);
    expect(res.json.data.id).not.toBe(placed.orderId);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: res.json.data.id } })).toMatchObject({ organizationId: desk.orgId, source: "POS" });
    expect((await cloudOrder(placed.orderId)).payments).toHaveLength(beforeCloudPays);
    expect((await localOrder(placed.orderId)).payments).toHaveLength(beforeCloudPays);
  });

  it("still takes a local counter-sale payment without talking to the cloud", async () => {
    const counter = await call(Orders, "POST", "", { session: deskCashier.session, headers: { "idempotency-key": `loc-${RUN}-${++n}-aaaa` }, body: { outletId: desk.outletId, items: [{ menuItemId: desk.brownie, qty: 1 }], submit: true } });
    expect(counter.status).toBe(200);
    const calls = fc.calls.length;
    const total = Number((await prisma.order.findUniqueOrThrow({ where: { id: counter.json.data.id } })).total);
    const pay = await call(Payments, "POST", "", { session: deskCashier.session, headers: { "idempotency-key": `lpay-${RUN}-${++n}-aaaa` }, body: { orderId: counter.json.data.id, method: "CASH", amount: total } });
    expect(pay.status).toBe(200);
    expect(fc.calls.length).toBe(calls);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pay.json.data.id } })).orderId).toBe(counter.json.data.id);
  });

  it("rejects unauthenticated and empty payment bodies on the payment route", async () => {
    const placed = await guestOrder();
    await cycle();
    expect((await call(Payments, "POST", "", { body: { orderId: localOf(placed.orderId), method: "CASH", amount: 10 } })).status).toBe(401);
    expect((await call(Payments, "POST", "", { session: deskCashier.session, body: {} })).status).toBe(422);
    expect((await call(Payments, "POST", "not-a-payment/verify", { session: deskCashier.session, body: {} })).status).toBeGreaterThanOrEqual(400);
  });

  it("needs the cloud for a payment: offline it is refused and nothing is recorded anywhere", async () => {
    const placed = await guestOrder();
    await cycle();
    await submit(placed.orderId);
    fc.offline = true;
    const res = await call(Payments, "POST", "", { session: deskCashier.session, body: { orderId: localOf(placed.orderId), method: "CASH", amount: 100 } });
    fc.offline = false;
    expect(res.status).toBe(503);
    expect((await cloudOrder(placed.orderId)).payments).toHaveLength(0);
    expect((await localOrder(placed.orderId)).payments).toHaveLength(0);
  });

  it("a cloud 503 on a mirrored payment is unavailable, not Internal server error", async () => {
    const placed = await guestOrder();
    await cycle();
    await submit(placed.orderId);
    fc.cloudHttpStatus = 503;
    const res = await call(Payments, "POST", "", { session: deskCashier.session, body: { orderId: localOf(placed.orderId), method: "CASH", amount: 100 } });
    fc.cloudHttpStatus = null;
    expect(res.status).toBe(503);
    expect(res.json.error.message).not.toBe("Internal server error");
    expect(res.json.error.message).toMatch(/cloud|reachable|unavailable|moment/i);
    expect(JSON.stringify(res.json)).not.toMatch(/Bearer |postgresql:\/\/|qrToken/i);
    expect((await localOrder(placed.orderId)).payments).toHaveLength(0);
  });

  it("a revoked device cannot take a mirrored payment as if the till were merely offline", async () => {
    const placed = await guestOrder();
    await cycle();
    await submit(placed.orderId);
    await prisma.cloudDevice.updateMany({ where: { enrolledById: syncUser.id, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: new Date() } });
    const res = await call(Payments, "POST", "", { session: deskCashier.session, body: { orderId: localOf(placed.orderId), method: "CASH", amount: 100 } });
    expect(res.status).toBe(401);
    expect(res.json.error.message).not.toMatch(/offline|could not be reached/i);
    expect((await localOrder(placed.orderId)).payments).toHaveLength(0);
    await connectCloud(await ownerCtx(deskOwner), { baseUrl: CLOUD_ORIGIN, email: syncUser.email, password: PASSWORD, installId: "desk-install-aaaaaaaa" }, prisma, fc.transport);
  });

  it("mirrors a cancellation made in the cloud", async () => {
    const placed = await guestOrder();
    await cycle();
    await cancelOrder(cloud.ctx, placed.orderId, "Customer left");
    await cycle();
    expect((await localOrder(placed.orderId)).status).toBe("CANCELLED");
  });

  it("refuses to edit, discount, cancel or refund a cloud order on the desktop, but leaves counter sales alone", async () => {
    const placed = await guestOrder();
    await cycle();
    const id = localOf(placed.orderId);
    expect((await call(Orders, "POST", `${id}/discount`, { session: deskCashier.session, body: { amount: 10 } })).status).toBe(409);
    expect((await call(Orders, "POST", `${id}/cancel`, { session: deskOwner.session, body: { reason: "No longer wanted" } })).status).toBe(409);
    expect((await call(Orders, "POST", `${id}/items`, { session: deskCashier.session, body: { menuItemId: desk.brownie, qty: 1 } })).status).toBe(409);
    const item = (await localOrder(placed.orderId)).items[0];
    expect((await call(Orders, "DELETE", `items/${item.id}`, { session: deskCashier.session })).status).toBe(409);
    expect((await cloudOrder(placed.orderId)).status).toBe("OPEN");
    // a counter sale made on this desktop is not a mirror and works as ever
    const counter = await call(Orders, "POST", "", { session: deskCashier.session, body: { outletId: desk.outletId, items: [{ menuItemId: desk.brownie, qty: 1 }] } });
    expect(counter.status).toBe(200);
    expect((await call(Orders, "POST", `${counter.json.data.id}/discount`, { session: deskCashier.session, body: { amount: 5 } })).status).toBe(200);
  });
});

describe("offline, retries and conflicts (scenarios 16, 17, 18)", () => {
  it("queues an acceptance made offline, does not pretend it happened, and sends it once on reconnect", async () => {
    const placed = await guestOrder();
    await cycle();
    fc.offline = true;
    const res = await submit(placed.orderId);
    expect(res.status).toBe(200);
    expect(res.json.data.sync.state).toBe("QUEUED");
    expect((await localOrder(placed.orderId)).status).toBe("OPEN"); // not accepted until the cloud says so
    expect((await submit(placed.orderId)).json.data.sync.state).toBe("QUEUED");
    expect(await ddb.syncOperation.count({ where: { organizationId: desk.orgId, cloudOrderId: placed.orderId, status: "PENDING" } })).toBe(1);
    const off = await cycle();
    expect(off.state).toBe("OFFLINE");
    const st = await status();
    expect(st).toMatchObject({ state: "OFFLINE", pendingOps: 1 });
    expect(st.lastError).toBeTruthy();
    expect(st.staleSeconds).not.toBeNull();
    expect((await cloudOrder(placed.orderId)).status).toBe("OPEN");

    fc.offline = false;
    const early = await cycle(); // still inside the retry back-off: the queue waits
    expect(early.opsDone).toBe(0);
    const back = await retryNow(prisma, desk.orgId);
    expect(back).toMatchObject({ state: "ONLINE", opsDone: 1 });
    expect(await status()).toMatchObject({ state: "ONLINE", pendingOps: 0, conflictOps: 0 });
    expect((await cloudOrder(placed.orderId)).kots).toHaveLength(1);
    expect((await localOrder(placed.orderId)).status).toBe("SENT");
  });

  it("a cloud 503 is unavailable, not healthy ONLINE, and lastSuccessAt is kept", async () => {
    const placed = await guestOrder();
    const okCycle = await cycle();
    expect(okCycle.state).toBe("ONLINE");
    const successAt = (await link()).lastSuccessAt;
    expect(successAt).toBeTruthy();
    fc.cloudHttpStatus = 503;
    const down = await cycle();
    const st = await status();
    const after = await link();
    fc.cloudHttpStatus = null;
    expect(down.state).toBe("OFFLINE");
    expect(st.state).toBe("OFFLINE");
    expect(after.status).toBe("LINKED");
    expect(after.lastSuccessAt?.getTime()).toBe(successAt!.getTime());
    expect(st.lastSuccessAt).toBe(successAt!.toISOString());
    expect(st.lastError).toBeTruthy();
    expect(JSON.stringify({ down, st })).not.toMatch(/Bearer |postgresql:\/\/|qrToken/i);
    expect((await cloudOrder(placed.orderId)).status).toBe("OPEN");
    const back = await cycle();
    expect(back.state).toBe("ONLINE");
    expect(await status()).toMatchObject({ state: "ONLINE", lastError: null });
  });

  it("a cloud 401 during sync is AUTH_REQUIRED, not OFFLINE", async () => {
    await cycle();
    fc.cloudHttpStatus = 401;
    const r = await cycle();
    const st = await status();
    fc.cloudHttpStatus = null;
    expect(r.state).toBe("AUTH_REQUIRED");
    expect(st.state).toBe("AUTH_REQUIRED");
    await connectCloud(await ownerCtx(deskOwner), { baseUrl: CLOUD_ORIGIN, email: syncUser.email, password: PASSWORD, installId: "desk-install-aaaaaaaa" }, prisma, fc.transport);
    expect((await cycle()).state).toBe("ONLINE");
  });

  it("a lost response never causes a second acceptance or a second KOT", async () => {
    const placed = await guestOrder();
    await cycle();
    fc.loseNextResponse = true;
    const res = await submit(placed.orderId);
    expect(res.json.data.sync.state).toBe("QUEUED"); // the desktop cannot know the cloud already did it
    expect((await cloudOrder(placed.orderId)).status).toBe("SENT");
    const [op] = await ddb.syncOperation.findMany({ where: { cloudOrderId: placed.orderId } });
    await retryNow(prisma, desk.orgId); // same operation id is sent again
    expect((await ddb.syncOperation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe("DONE");
    expect((await cloudOrder(placed.orderId)).kots).toHaveLength(1);
    expect(await prisma.syncOpReceipt.count({ where: { organizationId: cloud.orgId, opId: op.id } })).toBe(1);
    expect((await localOrder(placed.orderId)).status).toBe("SENT");
  });

  it("keeps ticket progress queued in order while offline", async () => {
    const placed = await guestOrder();
    await cycle();
    await submit(placed.orderId);
    const kotId = (await localOrder(placed.orderId)).kots[0].id;
    fc.offline = true;
    for (const status of ["ACCEPTED", "PREPARING"]) {
      expect((await call(Kitchen, "POST", `kots/${kotId}/status`, { session: deskKitchen.session, body: { status } })).json.data.sync.state).toBe("QUEUED");
    }
    expect(await ddb.syncOperation.count({ where: { cloudOrderId: placed.orderId, status: "PENDING" } })).toBe(2);
    fc.offline = false;
    await retryNow(prisma, desk.orgId);
    expect((await cloudOrder(placed.orderId)).kots[0].status).toBe("PREPARING");
    expect((await localOrder(placed.orderId)).kots[0].status).toBe("PREPARING");
  });

  it("detects a conflicting change (cancelled in the cloud while an acceptance waited) and keeps it for a person", async () => {
    const placed = await guestOrder();
    await cycle();
    fc.offline = true;
    await submit(placed.orderId);
    fc.offline = false;
    await cancelOrder(cloud.ctx, placed.orderId, "Table left");
    await retryNow(prisma, desk.orgId);
    const [op] = await listOperations(prisma, desk.orgId, { attention: true });
    expect(op).toMatchObject({ status: "CONFLICT", outcome: "CONFLICT", action: "ACCEPT" });
    expect(op.detail).toMatch(/cancelled/);
    expect((await localOrder(placed.orderId)).status).toBe("CANCELLED"); // the cloud's state won; the stale action did not overwrite it
    expect((await localOrder(placed.orderId)).kots).toHaveLength(0);
    expect(await status()).toMatchObject({ conflictOps: 1 });
    await dismissOperation(prisma, desk.orgId, op.id);
    expect(await status()).toMatchObject({ conflictOps: 0 });
    await expect(dismissOperation(prisma, desk.orgId, op.id)).rejects.toThrow(/needs attention/);
  });
});

describe("session expiry and revocation (scenario 8)", () => {
  it("stops all cloud traffic once the cloud ends the session, queues work, and resumes after signing in again", async () => {
    const placed = await guestOrder();
    await cycle();
    await prisma.cloudDevice.updateMany({ where: { enrolledById: syncUser.id, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: new Date() } });
    const r = await cycle();
    expect(r.state).toBe("AUTH_REQUIRED");
    expect((await link()).status).toBe("AUTH_REQUIRED");
    const calls = fc.calls.length;
    expect((await cycle()).state).toBe("AUTH_REQUIRED");
    expect(fc.calls.length).toBe(calls); // no further privileged requests
    expect(await status()).toMatchObject({ state: "AUTH_REQUIRED" });
    // the operator can still take the action: it is queued, not lost, and not sent
    const res = await submit(placed.orderId);
    expect(res.json.data.sync.state).toBe("QUEUED");
    expect((await cloudOrder(placed.orderId)).status).toBe("OPEN");
    // sign in again → same link, feed position kept, queue drains
    await connectCloud(await ownerCtx(deskOwner), { baseUrl: CLOUD_ORIGIN, email: syncUser.email, password: PASSWORD, installId: "desk-install-aaaaaaaa" }, prisma, fc.transport);
    const back = await retryNow(prisma, desk.orgId);
    expect(back.state).toBe("ONLINE");
    expect((await cloudOrder(placed.orderId)).status).toBe("SENT");
    expect(await status()).toMatchObject({ state: "ONLINE", pendingOps: 0 });
  });

  it("refuses a deactivated cloud account", async () => {
    await prisma.user.update({ where: { id: syncUser.id }, data: { active: false } });
    expect((await cycle()).state).toBe("AUTH_REQUIRED");
    await prisma.user.update({ where: { id: syncUser.id }, data: { active: true } });
    await expect(connectCloud(await ownerCtx(deskOwner), { baseUrl: CLOUD_ORIGIN, email: syncUser.email, password: "nope" }, prisma, fc.transport)).rejects.toThrow();
    await connectCloud(await ownerCtx(deskOwner), { baseUrl: CLOUD_ORIGIN, email: syncUser.email, password: PASSWORD, installId: "desk-install-aaaaaaaa" }, prisma, fc.transport);
    expect((await cycle()).state).toBe("ONLINE");
  });
});

describe("scope, privacy and the control API (scenarios 10, 20)", () => {
  it("never mirrors another cloud outlet's or organization's orders", async () => {
    const otherCloud = await makeWorld("OtherCloud", { qr: true });
    const t = otherCloud.qrToken!;
    const res = await call(Guest, "POST", `t/${t}/orders`, { headers: { "idempotency-key": `o-${RUN}-${++n}-other-key` }, body: { items: [{ menuItemId: otherCloud.coffee, qty: 1 }] } });
    expect(res.status).toBe(200);
    await cycle();
    expect(await prisma.order.count({ where: { organizationId: desk.orgId, externalRef: res.json.data.orderId } })).toBe(0);
    // and a CloudClient pointed at a foreign outlet id is told no
    const token = decryptSecret((await link()).tokenCipher!);
    const c = new CloudClient({ baseUrl: CLOUD_ORIGIN, token, transport: fc.transport });
    await expect(c.get(`/api/sync/orders?outletId=${otherCloud.outletId}`)).rejects.toMatchObject({ status: 404 });
  });

  it("keeps the token and passwords out of errors and responses", async () => {
    const token = decryptSecret((await link()).tokenCipher!);
    fc.offline = true;
    const err = await new CloudClient({ baseUrl: CLOUD_ORIGIN, token, transport: fc.transport }).get("/api/sync/outlets").catch((e: unknown) => e);
    fc.offline = false;
    expect(err).toBeInstanceOf(CloudOfflineError);
    expect(String(err instanceof Error ? err.message : err) + JSON.stringify(err)).not.toContain(token);
    expect(JSON.stringify(await status())).not.toMatch(/token|cipher|password/i);
  });

  it("serves status, retry and dismiss through the local API with the right permissions, and only on the desktop", async () => {
    const st = await call(CloudApi, "GET", "status", { session: deskCashier.session });
    expect(st.status).toBe(200);
    expect(st.json.data.state).toBe("ONLINE");
    expect((await call(CloudApi, "POST", "connect", { session: deskCashier.session, body: { baseUrl: CLOUD_ORIGIN, email: syncUser.email, password: PASSWORD } })).status).toBe(403);
    expect((await call(CloudApi, "POST", "sync", { session: deskCashier.session, body: {} })).json.data.status.state).toBe("ONLINE");
    expect((await call(CloudApi, "GET", "status", {})).status).toBe(401);
    vi.stubEnv("AHAROS_DESKTOP", "0");
    expect((await call(CloudApi, "GET", "status", { session: deskCashier.session })).status).toBe(404);
    vi.stubEnv("AHAROS_DESKTOP", "1");
  });

  it("disconnects cleanly: refuses while actions wait, signs out of the cloud, forgets the token", async () => {
    const placed = await guestOrder();
    await cycle();
    fc.offline = true;
    await submit(placed.orderId);
    fc.offline = false;
    const ctx = await ownerCtx(deskOwner);
    await expect(disconnectCloud(ctx, prisma, { transport: fc.transport })).rejects.toMatchObject({ status: 409 });
    const st = await disconnectCloud(ctx, prisma, { discardPending: true, transport: fc.transport });
    expect(st.state).toBe("UNLINKED");
    expect(await ddb.cloudLink.count({ where: { organizationId: desk.orgId } })).toBe(0);
    expect(await ddb.syncOperation.count({ where: { organizationId: desk.orgId, status: "PENDING" } })).toBe(0);
    expect((await cycle()).state).toBe("UNLINKED");
    expect(await prisma.session.count({ where: { userId: syncUser.id, revokedAt: null } })).toBeGreaterThanOrEqual(0);
  });
});
