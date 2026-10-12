/** The hold list and the waitlist message over HTTP: who may use them, validation, and the shapes the screens rely on. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { createMenuItem } from "@/server/services/menu";
import { createWaitlistEntry } from "@/server/services/reservations";
import { makeEnv, connectMock, phone, type Env } from "../domain/growthSupport";
import * as Orders from "@/app/api/orders/[[...path]]/route";
import * as Reservations from "@/app/api/reservations/[[...path]]/route";
import { call, sessionFor } from "./routeSupport";

let env: Env;
let dish: string;
const s: Record<string, string> = {};

beforeAll(async () => {
  env = await makeEnv("Gfr");
  dish = (await createMenuItem(env.owner, { name: "Route Dosa", price: 100, taxPct: 5 })).id;
  s.captain = await sessionFor(env.orgId, "CAPTAIN", env.outletA);
  s.cashier = await sessionFor(env.orgId, "CASHIER", env.outletA);
  s.store = await sessionFor(env.orgId, "STORE", env.outletA);
  s.foreign = await sessionFor((await prisma.organization.create({ data: { name: `Other ${Date.now()}` } })).id, "OWNER", null);
});
afterAll(async () => { await prisma.$disconnect(); });

describe("held bills over HTTP", () => {
  const body = (extra: Record<string, unknown> = {}) => ({ outletId: env.outletA, channel: "TAKEAWAY", items: [{ menuItemId: dish, qty: 1 }], ...extra });

  it("a bill saved with a name is on the hold list; sending a held bill in one breath is a 422; a long name is a 422", async () => {
    const saved = await call(Orders, "POST", "", { session: s.cashier, body: body({ hold: true, holdLabel: "Window table" }), headers: { "idempotency-key": `route-hold-${Date.now()}-aa` } });
    expect(saved.status).toBe(200);
    expect(saved.json.data).toMatchObject({ status: "OPEN" });
    const list = await call(Orders, "GET", `?outletId=${env.outletA}&held=true`, { session: s.cashier });
    expect(list.status).toBe(200);
    expect(list.json.data.items.map((o: { id: string }) => o.id)).toContain(saved.json.data.id);
    expect(list.json.data.items.find((o: { id: string }) => o.id === saved.json.data.id)).toMatchObject({ holdLabel: "Window table" });
    expect((await call(Orders, "POST", "", { session: s.cashier, body: body({ hold: true, submit: true }) })).status).toBe(422);
    expect((await call(Orders, "POST", "", { session: s.cashier, body: body({ holdLabel: "x".repeat(61) }) })).status).toBe(422);
  });

  it("needs a session and the right to see orders; a bad flag is a 422", async () => {
    expect((await call(Orders, "GET", `?outletId=${env.outletA}&held=true`)).status).toBe(401);
    expect((await call(Orders, "GET", `?outletId=${env.outletA}&held=true`, { session: s.store })).status).toBe(403);
    expect((await call(Orders, "GET", `?outletId=${env.outletA}&held=maybe`, { session: s.cashier })).status).toBe(422);
    const other = await call(Orders, "GET", `?outletId=${env.outletA}&held=true`, { session: s.foreign });
    expect(other.status === 200 ? other.json.data.items : []).toEqual([]);
  });
});

describe("POST /api/reservations/waitlist/:id/notify", () => {
  it("the host stand tells a waiting party; the cashier cannot; unknown and foreign parties are a 404; a bad hold time is a 422", async () => {
    await connectMock(env.orgId);
    const w = await createWaitlistEntry(env.owner, { outletId: env.outletA, customerName: "Route Guest", partySize: 3, phone: phone() });
    const url = `waitlist/${w.id}/notify`;
    expect((await call(Reservations, "POST", url, { body: {} })).status).toBe(401);
    expect((await call(Reservations, "POST", url, { session: s.cashier, body: {} })).status).toBe(403);
    expect((await call(Reservations, "POST", url, { session: s.foreign, body: {} })).status).toBe(404);
    expect((await call(Reservations, "POST", "waitlist/no-such-entry/notify", { session: s.captain, body: {} })).status).toBe(404);
    expect((await call(Reservations, "POST", url, { session: s.captain, body: { holdMinutes: 0 } })).status).toBe(422);
    const ok = await call(Reservations, "POST", url, { session: s.captain, body: { holdMinutes: 15 } });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ sent: true, count: 1 });
    // A second tap straight away is refused with the reason, not sent again.
    const again = await call(Reservations, "POST", url, { session: s.captain, body: {} });
    expect(again.status).toBe(422);
    expect(again.json.error.message).toMatch(/a moment ago/);
  });

  it("when nothing could be sent the answer is a normal 200 that says why", async () => {
    const lone = await makeEnv("Gfs"); // no provider connected
    const session = await sessionFor(lone.orgId, "CAPTAIN", lone.outletA);
    const w = await createWaitlistEntry(lone.owner, { outletId: lone.outletA, customerName: "Nobody", partySize: 2, phone: phone() });
    const r = await call(Reservations, "POST", `waitlist/${w.id}/notify`, { session, body: {} });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ sent: false, reason: expect.stringMatching(/in person/) });
  });
});
