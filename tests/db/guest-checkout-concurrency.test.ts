/**
 * Load-test regression (2026-10-13): 25–50 guests checking out at once.
 *
 * placeGuestOrder used to write its audit row and the staff "New QR order"
 * alert in a second transaction AFTER the order (with its KOT) had committed,
 * outside the queued runInTx path. Under concurrent checkouts on SQLite that
 * transaction lost the write-lock wait (Prisma P1008), so the guest got HTTP 500
 * for an order that was already in the kitchen, and the audit row and staff
 * alert were never written (a retry only replays the order). They are now part
 * of the order's own transaction.
 *
 * Since online-only checkout the orders wait for their payment (no KOT at
 * placement); the guests then pay at the same moment, and each verified
 * payment releases its order to the kitchen exactly once.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@/server/db/client";
import { placeGuestOrder, startGuestPayment, confirmGuestPayment, lockTableQrCaps, MAX_WAITING_GUEST_ORDERS, MAX_UNPAID_GUEST_ORDERS } from "@/server/services/guestOrdering";

const RUN = Date.now().toString(36);
const N = 30;
let orgId: string, outletId: string, dish: string;
const tokens: string[] = [];

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Guest Conc ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `GC${RUN}`.slice(0, 12), name: "GC" } })).id;
  await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId, name: "KITCHEN", kind: "KITCHEN" } });
  dish = (await prisma.menuItem.create({ data: { organizationId: orgId, name: `GC dish ${RUN}`, price: 85, taxPct: 5, station: "KITCHEN" } })).id;
  for (let i = 0; i < N; i++) {
    const token = randomBytes(18).toString("base64url");
    await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: `C${i}`, qrToken: token } });
    tokens.push(token);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

const placedOrders: Array<{ orderId: string; accessKey: string }> = [];

describe(`${N} guests check out and pay online at the same moment`, () => {
  it("every order is placed once, waiting for its payment (no KOT yet), with one audit row and one staff alert; no request fails", async () => {
    const res = await Promise.allSettled(tokens.map((t, i) => placeGuestOrder(t, { items: [{ menuItemId: dish, qty: 1 }], paymentMethod: "ONLINE" }, `gc-${RUN}-${i}-key`)));
    const failed = res.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(failed.map((f) => `${(f.reason as { code?: string })?.code ?? ""} ${String((f.reason as Error)?.message).slice(0, 80)}`)).toEqual([]);
    const ids = res.map((r) => (r as PromiseFulfilledResult<{ orderId: string }>).value.orderId);
    expect(new Set(ids).size).toBe(N);
    const orders = await prisma.order.findMany({ where: { id: { in: ids } }, include: { kots: true } });
    expect(orders).toHaveLength(N);
    for (const o of orders) {
      expect(o.status).toBe("OPEN");
      expect(o.kots).toHaveLength(0);
    }
    for (const r of res) placedOrders.push((r as PromiseFulfilledResult<{ orderId: string; accessKey: string }>).value);
    // One "via guest-qr" row per order (placeOrder also writes its own CREATE row).
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, action: "CREATE", entityType: "Order", entityId: { in: ids }, after: { contains: "guest-qr" } } })).toBe(N);
    expect(await prisma.notification.count({ where: { organizationId: orgId, type: "NEW_ORDER" } })).toBe(N);
  });

  it("all paying at once: every verified payment releases its order once (one KOT, one invoice); no request fails", async () => {
    const started = await Promise.all(placedOrders.map((o, i) => startGuestPayment(o.orderId, o.accessKey, `gcpay-${RUN}-${i}-key`)));
    const res = await Promise.allSettled(placedOrders.map((o, i) => confirmGuestPayment(o.orderId, o.accessKey, { paymentId: started[i].paymentId })));
    const failed = res.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(failed.map((f) => String((f.reason as Error)?.message).slice(0, 80))).toEqual([]);
    const ids = placedOrders.map((o) => o.orderId);
    const orders = await prisma.order.findMany({ where: { id: { in: ids } }, include: { kots: true } });
    for (const o of orders) {
      expect(o.status).toBe("PAID");
      expect(o.kots).toHaveLength(1);
    }
    expect(await prisma.taxInvoice.count({ where: { sourceKey: { in: ids.map((id) => `inv:${id}`) } } })).toBe(N);
  });

  it("replaying all of them (lost responses) returns the same orders and adds nothing", async () => {
    const before = { orders: await prisma.order.count({ where: { organizationId: orgId } }), kots: await prisma.kot.count({ where: { organizationId: orgId } }), alerts: await prisma.notification.count({ where: { organizationId: orgId } }), audits: await prisma.auditLog.count({ where: { organizationId: orgId, action: "CREATE", entityType: "Order" } }) };
    const res = await Promise.all(tokens.map((t, i) => placeGuestOrder(t, { items: [{ menuItemId: dish, qty: 1 }], paymentMethod: "ONLINE" }, `gc-${RUN}-${i}-key`)));
    expect(res.every((r) => r.replayed)).toBe(true);
    expect({ orders: await prisma.order.count({ where: { organizationId: orgId } }), kots: await prisma.kot.count({ where: { organizationId: orgId } }), alerts: await prisma.notification.count({ where: { organizationId: orgId } }), audits: await prisma.auditLog.count({ where: { organizationId: orgId, action: "CREATE", entityType: "Order" } }) }).toEqual(before);
  });

  // 2026-10-19: a slow answer (22.9 s) makes the guest page replay the request while the first one may
  // still be running. Duplicate taps and replays of one key racing each other: one order (and, once paid, one KOT).
  it("the same request arriving several times at once (taps + replays racing the original) places ONE order", async () => {
    const token = randomBytes(18).toString("base64url");
    const tableId = (await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: `RACE${RUN}`.slice(0, 12), qrToken: token } })).id;
    const before = { kots: await prisma.kot.count({ where: { organizationId: orgId } }), alerts: await prisma.notification.count({ where: { organizationId: orgId } }) };
    const body = { items: [{ menuItemId: dish, qty: 2 }], paymentMethod: "ONLINE" as const };
    const res = await Promise.allSettled(Array.from({ length: 6 }, () => placeGuestOrder(token, body, `race-${RUN}-key`)));
    const failed = res.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(failed.map((f) => String((f.reason as Error)?.message).slice(0, 80))).toEqual([]);
    const placed = res.map((r) => (r as PromiseFulfilledResult<{ orderId: string; replayed: boolean; accessKey: string }>).value);
    expect(new Set(placed.map((p) => p.orderId)).size).toBe(1);
    expect(new Set(placed.map((p) => p.accessKey)).size).toBe(1);
    expect(placed.filter((p) => !p.replayed)).toHaveLength(1);
    const orders = await prisma.order.findMany({ where: { organizationId: orgId, tableId }, include: { kots: true } });
    expect(orders).toHaveLength(1);
    expect(orders[0].kots).toHaveLength(0);
    expect({ kots: await prisma.kot.count({ where: { organizationId: orgId } }), alerts: await prisma.notification.count({ where: { organizationId: orgId } }) }).toEqual({ kots: before.kots, alerts: before.alerts + 1 });
    // A later replay (the guest's "Check order status") still returns that order and adds nothing.
    await expect(placeGuestOrder(token, body, `race-${RUN}-key`)).resolves.toMatchObject({ orderId: placed[0].orderId, replayed: true });
    // Paid twice at once from two taps: one KOT.
    const pay = await startGuestPayment(placed[0].orderId, placed[0].accessKey, `racepay-${RUN}-key`);
    await Promise.allSettled([1, 2, 3].map(() => confirmGuestPayment(placed[0].orderId, placed[0].accessKey, { paymentId: pay.paymentId })));
    expect(await prisma.kot.count({ where: { organizationId: orgId } })).toBe(before.kots + 1);
  });

  // 2026-10-19: a replay whose original commits just AFTER the replay looked its key up, but before the
  // replay checked the table's limits, saw the original as one more waiting order and was refused (422),
  // so the guest page reported "failed" for an order the restaurant had. The refusal must recover it.
  it("a replay that races the original's commit returns the original instead of a limit refusal", async () => {
    const token = randomBytes(18).toString("base64url");
    const tableId = (await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: `LIM${RUN}`.slice(0, 12), qrToken: token } })).id;
    const body = { items: [{ menuItemId: dish, qty: 1 }] }; // waits for its online payment (OPEN)
    for (let i = 0; i < 2; i++) await placeGuestOrder(token, body, `lim-${RUN}-${i}-key`);
    const key = `lim-${RUN}-orig-key`;
    let original: { orderId: string } | undefined;
    let lookups = 0;
    // The replay's first key lookup misses; the original commits right after it (the third waiting order).
    const racing = new Proxy(prisma, {
      get(target, prop) {
        if (prop === "order") {
          return new Proxy(target.order, {
            get(o, p) {
              if (p === "findUnique" && lookups++ === 0) {
                return async (args: Parameters<typeof prisma.order.findUnique>[0]) => {
                  const miss = await o.findUnique(args);
                  original = await placeGuestOrder(token, body, key);
                  return miss;
                };
              }
              const v = Reflect.get(o, p);
              return typeof v === "function" ? v.bind(o) : v;
            },
          });
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const replay = await placeGuestOrder(token, body, key, {}, racing);
    expect(original).toBeDefined();
    expect(replay).toMatchObject({ orderId: original!.orderId, replayed: true });
    expect(await prisma.order.count({ where: { organizationId: orgId, tableId } })).toBe(3);
    // A genuinely new order is still refused at the limit.
    await expect(placeGuestOrder(token, body, `lim-${RUN}-new-key`)).rejects.toThrow(/waiting for payment/);
  });
});

// 2026-10-22: the per-table limits were checked only before the order's transaction, so submissions
// through one table QR at the same moment all passed (PostgreSQL: 6 waiting with a limit of 3, 8 unsettled
// with 6, 9 of 9 probe rounds). They are now counted again inside the transaction, one table at a time.
describe("a table's limits hold when its QR submits several orders at once", () => {
  let seq = 0;
  const tableWith = async (prior: { status: string; n: number }[] = []) => {
    const token = randomBytes(18).toString("base64url");
    const t = await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: `TL${RUN}${++seq}`.slice(0, 16), qrToken: token } });
    for (const p of prior) await prisma.order.createMany({ data: Array.from({ length: p.n }, () => ({ organizationId: orgId, outletId, tableId: t.id, source: "QR", channel: "QR", status: p.status })) });
    return { token, tableId: t.id };
  };
  const submit = (token: string, key = `tl-${RUN}-${++seq}-key`) => placeGuestOrder(token, { items: [{ menuItemId: dish, qty: 1 }], paymentMethod: "ONLINE" }, key, { ip: "10.5.5.5" });
  const waitingAt = (tableId: string) => prisma.order.count({ where: { tableId, source: "QR", status: "OPEN" } });
  const unsettledAt = (tableId: string) => prisma.order.count({ where: { tableId, source: "QR", status: { in: ["OPEN", "SENT", "PREPARING", "READY", "SERVED", "BILLED"] } } });
  const rejections = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => String((r.reason as Error)?.message));
  const placedIds = (rs: PromiseSettledResult<{ orderId: string }>[]) => rs.filter((r): r is PromiseFulfilledResult<{ orderId: string }> => r.status === "fulfilled").map((r) => r.value.orderId).sort();
  /** Refused submissions roll back whole: only the placed orders have lines, audit rows and staff alerts; nothing was paid, cooked or deducted. */
  async function onlyPlacedLeftTraces(tableId: string, ids: string[], before: { ledger: number }) {
    const orders = await prisma.order.findMany({ where: { tableId, idempotencyKey: { not: null } }, select: { id: true } });
    expect(orders.map((o) => o.id).sort()).toEqual(ids);
    expect([...new Set((await prisma.orderItem.findMany({ where: { order: { tableId } }, select: { orderId: true } })).map((i) => i.orderId))].sort()).toEqual(ids);
    // (Each placed order has two CREATE rows — placeOrder's and the guest one — so compare the orders audited.)
    const audited = await prisma.auditLog.findMany({ where: { organizationId: orgId, entityType: "Order", entityId: { in: ids } }, select: { entityId: true, after: true } });
    expect([...new Set(audited.map((a) => a.entityId))].sort()).toEqual(ids);
    expect(audited.filter((a) => String(a.after).includes("guest-qr"))).toHaveLength(ids.length);
    const tableCode = (await prisma.restaurantTable.findUniqueOrThrow({ where: { id: tableId } })).code;
    expect(await prisma.notification.count({ where: { organizationId: orgId, type: "NEW_ORDER", title: { endsWith: `table ${tableCode}` } } })).toBe(ids.length);
    expect(await prisma.payment.count({ where: { order: { tableId } } })).toBe(0);
    expect(await prisma.kot.count({ where: { order: { tableId } } })).toBe(0);
    expect(await prisma.inventoryLedger.count({ where: { outletId } })).toBe(before.ledger);
  }

  it(`waiting-for-payment limit (${MAX_WAITING_GUEST_ORDERS}): six at once on a fresh table place exactly ${MAX_WAITING_GUEST_ORDERS}`, async () => {
    const t = await tableWith();
    const ledger = await prisma.inventoryLedger.count({ where: { outletId } });
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () => submit(t.token)));
    expect(placedIds(rs)).toHaveLength(MAX_WAITING_GUEST_ORDERS);
    for (const m of rejections(rs)) expect(m).toMatch(/waiting for payment/);
    expect(await waitingAt(t.tableId)).toBe(MAX_WAITING_GUEST_ORDERS);
    await onlyPlacedLeftTraces(t.tableId, placedIds(rs), { ledger });
  });

  it(`waiting limit from ${MAX_WAITING_GUEST_ORDERS - 1} waiting: four at once let exactly one through`, async () => {
    const t = await tableWith([{ status: "OPEN", n: MAX_WAITING_GUEST_ORDERS - 1 }]);
    const ledger = await prisma.inventoryLedger.count({ where: { outletId } });
    const rs = await Promise.allSettled(Array.from({ length: 4 }, () => submit(t.token)));
    expect(placedIds(rs)).toHaveLength(1);
    for (const m of rejections(rs)) expect(m).toMatch(/waiting for payment/);
    expect(await waitingAt(t.tableId)).toBe(MAX_WAITING_GUEST_ORDERS);
    await onlyPlacedLeftTraces(t.tableId, placedIds(rs), { ledger });
  });

  it(`unsettled limit (${MAX_UNPAID_GUEST_ORDERS}): from ${MAX_UNPAID_GUEST_ORDERS - 1} unpaid in the kitchen, three at once let exactly one through`, async () => {
    const t = await tableWith([{ status: "SENT", n: MAX_UNPAID_GUEST_ORDERS - 1 }]);
    const ledger = await prisma.inventoryLedger.count({ where: { outletId } });
    const rs = await Promise.allSettled(Array.from({ length: 3 }, () => submit(t.token)));
    expect(placedIds(rs)).toHaveLength(1);
    for (const m of rejections(rs)) expect(m).toMatch(/unpaid orders/);
    expect(await unsettledAt(t.tableId)).toBe(MAX_UNPAID_GUEST_ORDERS);
    await onlyPlacedLeftTraces(t.tableId, placedIds(rs), { ledger });
  });

  it("below the limits, simultaneous orders from one table are all placed; paid ones free the table again", async () => {
    const t = await tableWith();
    const rs = await Promise.allSettled(Array.from({ length: MAX_WAITING_GUEST_ORDERS }, () => submit(t.token)));
    expect(rejections(rs)).toEqual([]);
    expect(await waitingAt(t.tableId)).toBe(MAX_WAITING_GUEST_ORDERS);
    const first = (rs[0] as PromiseFulfilledResult<{ orderId: string; accessKey: string }>).value;
    const pay = await startGuestPayment(first.orderId, first.accessKey, `tlpay-${RUN}-${++seq}-key`);
    await confirmGuestPayment(first.orderId, first.accessKey, { paymentId: pay.paymentId });
    await expect(submit(t.token)).resolves.toMatchObject({ replayed: false });
  });

  it("a duplicate submission sent several times at once at the limit's edge places one order; the limit then holds", async () => {
    const t = await tableWith([{ status: "OPEN", n: MAX_WAITING_GUEST_ORDERS - 1 }]);
    const k = `tl-${RUN}-dup-key`;
    const rs = await Promise.all(Array.from({ length: 4 }, () => submit(t.token, k)));
    expect(new Set(rs.map((r) => r.orderId)).size).toBe(1);
    expect(rs.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await waitingAt(t.tableId)).toBe(MAX_WAITING_GUEST_ORDERS);
    // A later replay still returns it; a genuinely new order is refused.
    await expect(submit(t.token, k)).resolves.toMatchObject({ orderId: rs[0].orderId, replayed: true });
    await expect(submit(t.token)).rejects.toThrow(/waiting for payment/);
  });

  // The guest's phone is found-or-created in the order's own transaction: a submission refused there (here by the
  // table's in-transaction limit count) leaves no customer record and no customer audit row behind.
  it("submissions refused at the limit leave no customer record; the placed one is linked to its guest's", async () => {
    const t = await tableWith([{ status: "OPEN", n: MAX_WAITING_GUEST_ORDERS - 1 }]);
    const phones = Array.from({ length: 4 }, (_, i) => `97${String(Date.now()).slice(-8)}${i}`);
    const rs = await Promise.allSettled(phones.map((phone, i) =>
      placeGuestOrder(t.token, { items: [{ menuItemId: dish, qty: 1 }], paymentMethod: "ONLINE", customer: { name: `Guest ${i}`, phone } }, `tl-${RUN}-cust-${i}-key`, { ip: "10.5.5.5" })));
    expect(placedIds(rs)).toHaveLength(1);
    for (const m of rejections(rs)) expect(m).toMatch(/waiting for payment/);
    const customers = await prisma.customer.findMany({ where: { organizationId: orgId, phone: { in: phones } } });
    expect(customers).toHaveLength(1);
    const placed = await prisma.order.findUniqueOrThrow({ where: { id: placedIds(rs)[0] } });
    expect(placed.customerId).toBe(customers[0].id);
    const customerAudits = await prisma.auditLog.findMany({ where: { organizationId: orgId, entityType: "Customer", after: { contains: phones[0].slice(0, 10) } }, select: { entityId: true } });
    expect(customerAudits.map((a) => a.entityId)).toEqual([customers[0].id]);
  });

  it("one new phone ordering from five tables at once: all five placed, one customer record", async () => {
    const ts = await Promise.all(Array.from({ length: 5 }, () => tableWith()));
    const phone = `95${String(Date.now()).slice(-8)}3`;
    const rs = await Promise.allSettled(ts.map((t, i) =>
      placeGuestOrder(t.token, { items: [{ menuItemId: dish, qty: 1 }], paymentMethod: "ONLINE", customer: { name: "Ravi", phone } }, `tl-${RUN}-samephone-${i}-key`, { ip: "10.5.5.5" })));
    expect(rejections(rs)).toEqual([]);
    const rows = await prisma.customer.findMany({ where: { organizationId: orgId, phone } });
    expect(rows).toHaveLength(1);
    const orders = await prisma.order.findMany({ where: { id: { in: placedIds(rs) } }, select: { customerId: true } });
    expect(orders.map((o) => o.customerId)).toEqual(Array(5).fill(rows[0].id));
  });

  it("a guest's phone: a replay returns the order; the same key with another phone is a conflict; a known customer is kept", async () => {
    const t = await tableWith();
    const phone = `96${String(Date.now()).slice(-8)}1`;
    const body = (p: string) => ({ items: [{ menuItemId: dish, qty: 1 }], paymentMethod: "ONLINE", customer: { name: "Asha", phone: p } });
    const k = `tl-${RUN}-phone-key`;
    const first = await placeGuestOrder(t.token, body(phone), k, { ip: "10.5.5.5" });
    await expect(placeGuestOrder(t.token, body(phone), k, { ip: "10.5.5.5" })).resolves.toMatchObject({ orderId: first.orderId, replayed: true });
    await expect(placeGuestOrder(t.token, body(`${phone.slice(0, -1)}2`), k, { ip: "10.5.5.5" })).rejects.toThrow(/Idempotency key/);
    // A second order from the same phone reuses the record (name unchanged), it is never duplicated.
    const second = await placeGuestOrder(t.token, { ...body(phone), customer: { name: "Someone else", phone } }, `tl-${RUN}-phone-key2`, { ip: "10.5.5.5" });
    const rows = await prisma.customer.findMany({ where: { organizationId: orgId, phone } });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Asha");
    const orders = await prisma.order.findMany({ where: { id: { in: [first.orderId, second.orderId] } }, select: { customerId: true } });
    expect(orders.every((o) => o.customerId === rows[0].id)).toBe(true);
    expect(await prisma.customer.count({ where: { organizationId: orgId, phone: `${phone.slice(0, -1)}2` } })).toBe(0);
  });

  // Deterministic interleaving (PostgreSQL, where new orders run READ COMMITTED): the test holds the table's
  // limit lock, so every submission inserts its order and stops at the in-transaction count at the same time —
  // the window in which the pre-transaction count let all of them through.
  const pg = (process.env.DATABASE_URL ?? "").startsWith("postgres");
  for (const c of [
    { limit: "waiting", prior: { status: "OPEN", n: MAX_WAITING_GUEST_ORDERS - 2 }, refusal: /waiting for payment/, count: waitingAt, cap: MAX_WAITING_GUEST_ORDERS },
    { limit: "unsettled", prior: { status: "SENT", n: MAX_UNPAID_GUEST_ORDERS - 2 }, refusal: /unpaid orders/, count: unsettledAt, cap: MAX_UNPAID_GUEST_ORDERS },
  ]) {
    it.runIf(pg)(`PostgreSQL: ${c.limit} limit — four submissions all past the early check, two short of it: exactly two placed, nothing left by the refused`, async () => {
      const t = await tableWith([c.prior]);
      const ledger = await prisma.inventoryLedger.count({ where: { outletId } });
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let held!: (pid: number) => void;
      const lockHeld = new Promise<number>((r) => (held = r));
      const holder = prisma.$transaction(async (tx) => {
        await lockTableQrCaps(tx, t.tableId);
        held((await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid);
        await released;
      }, { timeout: 60_000 });
      const holderPid = await lockHeld;
      const submissions = Array.from({ length: 4 }, () => submit(t.token));
      // Barrier: all four have inserted their orders and are blocked behind the test's lock — the first on the
      // table's limit lock, the others behind it on the table row it marked occupied (createOrderTx).
      const waiting = () => prisma.$queryRaw<{ n: number }[]>`
        WITH RECURSIVE blocked(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))
          UNION SELECT s.pid FROM pg_stat_activity s JOIN blocked b ON b.pid = ANY(pg_blocking_pids(s.pid))
        ) SELECT count(*)::int AS n FROM blocked`.then((r) => r[0].n);
      try {
        const deadline = Date.now() + 10_000;
        while ((await waiting()) < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
        expect(await waiting()).toBe(4);
      } finally {
        release();
        await holder;
      }
      const rs = await Promise.allSettled(submissions);
      expect(placedIds(rs)).toHaveLength(2);
      for (const m of rejections(rs)) expect(m).toMatch(c.refusal);
      expect(await c.count(t.tableId)).toBe(c.cap);
      await onlyPlacedLeftTraces(t.tableId, placedIds(rs), { ledger });
    });
  }
});
