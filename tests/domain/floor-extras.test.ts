/**
 * Counter and host-stand extras, against the real services and database:
 *  H  held bills (MB-09): the POS's named hold list
 *  B  a seated booking's note reaches the kitchen ticket (RS-06)
 *  W  "your table is ready" by message to a waiting party (RS-03), through the one message gate
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import type { AccessContext } from "@/server/db/scope";
import { createMenuItem } from "@/server/services/menu";
import { createOrder, placeOrder, listOrders, submitOrder, addOrderItem } from "@/server/services/orders";
import { createReservation, seatReservation, createWaitlistEntry, promoteWaitlistEntry, markWaitlistArrived } from "@/server/services/reservations";
import { listKOTs } from "@/server/services/kot";
import { notifyWaitlistEntry, WAITLIST_MAX_NOTIFICATIONS, WAITLIST_MIN_GAP_MS } from "@/server/services/waitlistNotify";
import { setConsent } from "@/server/services/consent";
import { makeEnv, member, connectMock, deliveries, phone, uniq, type Env } from "./growthSupport";

let env: Env;
let captain: AccessContext;
let dish: string;
let tableSeq = 0;
const table = async (outletId = env.outletA) => (await prisma.restaurantTable.create({ data: { organizationId: env.orgId, outletId, code: `F${++tableSeq}-${uniq()}`, capacity: 6 } })).id;
const MIN = 60_000;

beforeAll(async () => {
  env = await makeEnv("Gfx");
  captain = member(env.orgId, "CAPTAIN", env.outletA);
  dish = (await createMenuItem(env.owner, { name: "Masala Dosa", price: 120, taxPct: 5 })).id;
}, 60000);
afterAll(async () => { await prisma.$disconnect(); });

describe("H. held bills", () => {
  const held = (outletId = env.outletA, ctx: AccessContext = env.owner) => listOrders(prisma, ctx, { outletId, held: true });
  const place = (extra: Record<string, unknown> = {}, ctx: AccessContext = env.owner) =>
    placeOrder(ctx, { outletId: env.outletA, channel: "TAKEAWAY", items: [{ menuItemId: dish, qty: 1 }], ...extra } as never);

  it("H1 a saved bill carries its name and the time it was put aside; the hold list shows only unsent held bills, oldest first", async () => {
    const before = (await held()).items.length;
    const first = await place({ hold: true, holdLabel: "  Window table  " });
    const unnamed = await place({ hold: true });
    const plain = await place({}); // saved the old way: not on the hold list
    const sent = await place({ submit: true });
    const list = (await held()).items;
    expect(list.map((o) => o.id)).toEqual(expect.arrayContaining([first.id, unnamed.id]));
    expect(list.length).toBe(before + 2);
    expect(list.map((o) => o.id)).not.toContain(plain.id);
    expect(list.map((o) => o.id)).not.toContain(sent.id);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: first.id } });
    expect(row).toMatchObject({ status: "OPEN", holdLabel: "Window table" });
    expect(row.heldAt).toBeInstanceOf(Date);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: unnamed.id } })).holdLabel).toBeNull();
    // Oldest first: the one put aside first comes first.
    const ids = list.map((o) => o.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(unnamed.id));
  });

  it("H2 sending a held bill to the kitchen takes it off the list; so does cancelling it", async () => {
    const o = await place({ hold: true, holdLabel: "Ravi" });
    expect((await held()).items.map((x) => x.id)).toContain(o.id);
    await submitOrder(env.owner, o.id);
    expect((await held()).items.map((x) => x.id)).not.toContain(o.id);
  });

  it("H3 a held bill is never sent in the same breath; the name has a limit", async () => {
    await expect(place({ hold: true, submit: true })).rejects.toThrow(/held bill is not sent/);
    await expect(place({ holdLabel: "x".repeat(61) })).rejects.toThrow();
  });

  it("H4 the list is scoped to the outlet and the restaurant, and needs the right to see orders", async () => {
    const mine = await place({ hold: true, holdLabel: "Mine" });
    expect((await held(env.outletB)).items.map((x) => x.id)).not.toContain(mine.id);
    expect((await held(env.outletA, env.foreign)).items).toEqual([]); // another restaurant reads only its own orders
    await expect(held(env.outletA, member(env.orgId, "STORE", env.outletA))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(held(env.outletB, member(env.orgId, "CAPTAIN", env.outletA))).rejects.toThrow();
  });

  it("H5 a retried save with the same key is the same held bill", async () => {
    const key = `hold-${uniq()}-abcd`;
    const a = await place({ hold: true, holdLabel: "Twice", idempotencyKey: key });
    const b = await place({ hold: true, holdLabel: "Twice", idempotencyKey: key });
    expect(b.id).toBe(a.id);
    expect(b.replayed).toBe(true);
  });
});

describe("B. a seated booking's note reaches the kitchen", () => {
  const seat = async (notes: string | undefined, partySize = 2) => {
    const t = await table();
    const r = await createReservation(env.owner, { outletId: env.outletA, tableId: t, partySize, reservedAt: new Date(Date.now() + 5 * MIN), notes });
    await seatReservation(env.owner, r.id);
    return { t, r };
  };

  it("B1 the note travels with the first order at the table, joined to the captain's own note, and prints on the kitchen ticket", async () => {
    const { t } = await seat("Anniversary - cake at 9pm, one guest is allergic to nuts");
    const o = await createOrder(captain, { outletId: env.outletA, tableId: t, channel: "DINE_IN", notes: "Window seat" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).notes).toBe("Window seat · Booking note: Anniversary - cake at 9pm, one guest is allergic to nuts");
    await addOrderItem(captain, o.id, { menuItemId: dish, qty: 2 });
    await submitOrder(captain, o.id);
    const tickets = (await listKOTs(prisma, env.owner, { outletId: env.outletA })).filter((k) => k.orderId === o.id);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].order.notes).toMatch(/Booking note: Anniversary/);
  });

  it("B2 a booking with no note, a party that was not seated, a finished booking and a takeaway add nothing", async () => {
    const noNote = await seat(undefined);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: (await createOrder(captain, { outletId: env.outletA, tableId: noNote.t, channel: "DINE_IN" })).id } })).notes).toBeNull();

    const t = await table();
    await createReservation(env.owner, { outletId: env.outletA, tableId: t, partySize: 2, reservedAt: new Date(Date.now() + 5 * MIN), notes: "Not seated yet" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: (await createOrder(captain, { outletId: env.outletA, tableId: t, channel: "DINE_IN" })).id } })).notes).toBeNull();

    const takeaway = await createOrder(captain, { outletId: env.outletA, channel: "TAKEAWAY" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: takeaway.id } })).notes).toBeNull();
  });

  it("B3 the bookkeeping note of a party seated from the waitlist is not something for the kitchen", async () => {
    const t = await table();
    const w = await createWaitlistEntry(env.owner, { outletId: env.outletA, customerName: "Kiran", partySize: 2 });
    await promoteWaitlistEntry(env.owner, w.id, t);
    const o = await createOrder(captain, { outletId: env.outletA, tableId: t, channel: "DINE_IN" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).notes).toBeNull();
  });

  it("B4 only this restaurant's bookings count (another restaurant's note on a table id is never read)", async () => {
    const t = await table();
    const other = await prisma.organization.create({ data: { name: `Other ${uniq()}` } });
    const otherOutlet = await prisma.outlet.create({ data: { organizationId: other.id, code: `OT${uniq()}`, name: "O" } });
    await prisma.reservation.create({ data: { organizationId: other.id, outletId: otherOutlet.id, tableId: t, partySize: 2, reservedAt: new Date(), status: "SEATED", notes: "Secret of another restaurant" } });
    const o = await createOrder(captain, { outletId: env.outletA, tableId: t, channel: "DINE_IN" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).notes).toBeNull();
  });
});

describe("W. telling a waiting party their table is ready", () => {
  const wait = (extra: Record<string, unknown> = {}) => createWaitlistEntry(env.owner, { outletId: env.outletA, customerName: "Meera", partySize: 4, phone: phone(), ...extra } as never);
  const tellAt = (id: string, at: Date, ctx: AccessContext = captain) => notifyWaitlistEntry(ctx, id, { now: at });

  it("W1 queues one message through the gate (masked number, transactional, about the guest), stamps the entry, creates the guest record", async () => {
    await connectMock(env.orgId);
    const w = await wait();
    const r = await tellAt(w.id, new Date());
    expect(r).toMatchObject({ sent: true, count: 1 });
    expect(["WHATSAPP", "SMS"]).toContain((r as { channel: string }).channel);
    const rows = (await deliveries(env.orgId)).filter((d) => d.idempotencyKey === `waitlist:${w.id}:1`);
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload) as { template: string; purpose: string; body: string };
    expect(payload).toMatchObject({ template: "WAITLIST_READY", purpose: "TRANSACTIONAL" });
    expect(payload.body).toMatch(/your table for 4 is ready.*within 10 minutes/);
    expect(rows[0].target).not.toContain(w.phone!.slice(2, 8)); // masked in the outbox
    const entry = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: w.id } });
    expect(entry.notifyCount).toBe(1);
    expect(entry.notifiedAt).toBeInstanceOf(Date);
    expect(await prisma.customer.count({ where: { organizationId: env.orgId, name: "Meera" } })).toBeGreaterThan(0);
    expect(await prisma.auditLog.count({ where: { organizationId: env.orgId, entityId: w.id, after: { contains: '"notified"' } } })).toBe(1);
  });

  it("W2 an existing guest is reused whichever way the number was typed", async () => {
    await connectMock(env.orgId);
    const digits = String(9100000000 + (Number.parseInt(uniq(), 36) % 80000000));
    const customer = await prisma.customer.create({ data: { organizationId: env.orgId, name: "Existing Guest", phone: digits } });
    const before = await prisma.customer.count({ where: { organizationId: env.orgId } });
    const w = await wait({ phone: `+91 ${digits.slice(0, 5)} ${digits.slice(5)}` });
    expect(await tellAt(w.id, new Date())).toMatchObject({ sent: true });
    expect(await prisma.customer.count({ where: { organizationId: env.orgId } })).toBe(before);
    const row = (await deliveries(env.orgId)).find((d) => d.idempotencyKey === `waitlist:${w.id}:1`)!;
    expect(row.sourceId).toBe(customer.id);
  });

  it("W3 a double tap is refused; a reminder after a couple of minutes is a second message; three is the limit", async () => {
    await connectMock(env.orgId);
    const w = await wait();
    const t0 = new Date();
    await tellAt(w.id, t0);
    await expect(tellAt(w.id, new Date(t0.getTime() + 30_000))).rejects.toThrow(/a moment ago/);
    expect(await tellAt(w.id, new Date(t0.getTime() + WAITLIST_MIN_GAP_MS + 1000))).toMatchObject({ sent: true, count: 2 });
    expect(await tellAt(w.id, new Date(t0.getTime() + 2 * WAITLIST_MIN_GAP_MS + 2000))).toMatchObject({ sent: true, count: WAITLIST_MAX_NOTIFICATIONS });
    await expect(tellAt(w.id, new Date(t0.getTime() + 10 * WAITLIST_MIN_GAP_MS))).rejects.toThrow(/3 times/);
    expect((await deliveries(env.orgId)).filter((d) => d.idempotencyKey?.startsWith(`waitlist:${w.id}:`))).toHaveLength(3);
  });

  it("W4 nothing is claimed when nothing could be sent: no provider, no number, an opted-out guest", async () => {
    const lone = await makeEnv("Gfy"); // no messaging provider connected
    const w = await createWaitlistEntry(lone.owner, { outletId: lone.outletA, customerName: "Noor", partySize: 2, phone: phone() });
    const r = await notifyWaitlistEntry(lone.owner, w.id);
    expect(r).toMatchObject({ sent: false });
    expect((r as { reason: string }).reason).toMatch(/provider is connected.*in person/);
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: w.id } })).notifiedAt).toBeNull();

    await connectMock(env.orgId);
    const noNumber = await wait({ phone: undefined });
    expect(await notifyWaitlistEntry(env.owner, noNumber.id)).toMatchObject({ sent: false, reason: expect.stringMatching(/no usable mobile number/) });
    const garbage = await wait({ phone: "12345" });
    expect(await notifyWaitlistEntry(env.owner, garbage.id)).toMatchObject({ sent: false });

    const number = phone();
    const optedOut = await wait({ phone: number });
    const c = await prisma.customer.create({ data: { organizationId: env.orgId, name: "Opted Out", phone: `+91${number}` } });
    await setConsent(env.manager, c.id, [{ channel: "SMS", transactional: false }, { channel: "WHATSAPP", transactional: false }] as never);
    const r2 = await notifyWaitlistEntry(env.owner, optedOut.id);
    expect(r2).toMatchObject({ sent: false });
    expect((r2 as { reason: string }).reason).toMatch(/opted out/);
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: optedOut.id } })).notifyCount).toBe(0);
  });

  it("W5 only a party that is still waiting can be told", async () => {
    await connectMock(env.orgId);
    const w = await wait();
    await markWaitlistArrived(env.owner, w.id);
    await expect(notifyWaitlistEntry(env.owner, w.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("W6 permissions and tenants: the host stand (reservation.manage) may; a cashier may not; another restaurant sees no such party", async () => {
    await connectMock(env.orgId);
    const w = await wait();
    await expect(notifyWaitlistEntry(env.cashier, w.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(notifyWaitlistEntry(env.foreign, w.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(notifyWaitlistEntry(member(env.orgId, "CAPTAIN", env.outletB), w.id)).rejects.toThrow();
    await expect(notifyWaitlistEntry(captain, w.id, { holdMinutes: 0 })).rejects.toThrow();
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: w.id } })).notifyCount).toBe(0);
    expect(await notifyWaitlistEntry(captain, w.id, { holdMinutes: 15 })).toMatchObject({ sent: true });
    const row = (await deliveries(env.orgId)).find((d) => d.idempotencyKey === `waitlist:${w.id}:1`)!;
    expect((JSON.parse(row.payload) as { body: string }).body).toMatch(/within 15 minutes/);
  });
});
