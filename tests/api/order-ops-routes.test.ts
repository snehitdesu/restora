/** Table transfer, merge and split over HTTP: who may do them, validation, the Idempotency-Key header, and tenant isolation. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { createMenuItem } from "@/server/services/menu";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { makeEnv, uniq, type Env } from "../domain/growthSupport";
import * as Orders from "@/app/api/orders/[[...path]]/route";
import { call, sessionFor } from "./routeSupport";

let env: Env;
let dish: string;
const s: Record<string, string> = {};
let n = 0;

const table = async () => (await prisma.restaurantTable.create({ data: { organizationId: env.orgId, outletId: env.outletA, code: `R${++n}-${uniq()}`, capacity: 4 } })).id;
async function order(lines = 2) {
  const t = await table();
  const o = await createOrder(env.owner, { outletId: env.outletA, tableId: t, channel: "DINE_IN" });
  const ids: string[] = [];
  for (let i = 0; i < lines; i++) ids.push(((await addOrderItem(env.owner, o.id, { menuItemId: dish, qty: 1 })) as { id: string }).id);
  return { id: o.id, table: t, ids };
}

beforeAll(async () => {
  env = await makeEnv("Gro");
  dish = (await createMenuItem(env.owner, { name: "Route Dosa", price: 100, taxPct: 5 })).id;
  s.captain = await sessionFor(env.orgId, "CAPTAIN", env.outletA);
  s.cashier = await sessionFor(env.orgId, "CASHIER", env.outletA);
  s.kitchen = await sessionFor(env.orgId, "KITCHEN", env.outletA);
  s.accountant = await sessionFor(env.orgId, "ACCOUNTANT", env.outletA);
  s.foreign = await sessionFor((await prisma.organization.create({ data: { name: `Other ${Date.now()}` } })).id, "OWNER", null);
});
afterAll(async () => { await prisma.$disconnect(); });

describe("POST /api/orders/:id/transfer", () => {
  it("floor staff move an order; the kitchen, accountants and strangers cannot; no session is a 401", async () => {
    const o = await order();
    const target = await table();
    expect((await call(Orders, "POST", `${o.id}/transfer`, { body: { tableId: target } })).status).toBe(401);
    for (const role of ["kitchen", "accountant"]) expect((await call(Orders, "POST", `${o.id}/transfer`, { session: s[role], body: { tableId: target } })).status, role).toBe(403);
    expect((await call(Orders, "POST", `${o.id}/transfer`, { session: s.foreign, body: { tableId: target } })).status).toBe(404);
    const r = await call(Orders, "POST", `${o.id}/transfer`, { session: s.captain, body: { tableId: target } });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ unchanged: false, order: { id: o.id, tableId: target } });
    expect((await call(Orders, "POST", `${o.id}/transfer`, { session: s.cashier, body: { tableId: target } })).json.data).toMatchObject({ unchanged: true });
  });

  it("a missing table id is a 422 and a busy table is a 422 with the reason", async () => {
    const o = await order();
    const busy = await order();
    expect((await call(Orders, "POST", `${o.id}/transfer`, { session: s.captain, body: {} })).status).toBe(422);
    const r = await call(Orders, "POST", `${o.id}/transfer`, { session: s.captain, body: { tableId: busy.table } });
    expect(r.status).toBe(422);
    expect(r.json.error.message).toMatch(/running order/);
  });
});

describe("POST /api/orders/:id/merge", () => {
  it("merges and answers the merged order; the same request again is a harmless replay", async () => {
    const a = await order(1);
    const b = await order(1);
    const first = await call(Orders, "POST", `${a.id}/merge`, { session: s.captain, body: { fromOrderId: b.id } });
    expect(first.status).toBe(200);
    expect(first.json.data.replayed).toBe(false);
    expect(first.json.data.order.items).toHaveLength(2);
    const again = await call(Orders, "POST", `${a.id}/merge`, { session: s.captain, body: { fromOrderId: b.id } });
    expect(again.status).toBe(200);
    expect(again.json.data.replayed).toBe(true);
  });

  it("refuses itself, a stranger and the kitchen", async () => {
    const a = await order(1);
    const b = await order(1);
    expect((await call(Orders, "POST", `${a.id}/merge`, { session: s.captain, body: { fromOrderId: a.id } })).status).toBe(422);
    expect((await call(Orders, "POST", `${a.id}/merge`, { session: s.captain, body: {} })).status).toBe(422);
    expect((await call(Orders, "POST", `${a.id}/merge`, { session: s.kitchen, body: { fromOrderId: b.id } })).status).toBe(403);
    expect((await call(Orders, "POST", `${a.id}/merge`, { session: s.foreign, body: { fromOrderId: b.id } })).status).toBe(404);
  });
});

describe("POST /api/orders/:id/split", () => {
  it("splits with an Idempotency-Key header: a retry returns the same new bill; a different request under the key is a 409", async () => {
    const o = await order(3);
    const key = `route-split-${uniq()}`;
    const headers = { "idempotency-key": key };
    const first = await call(Orders, "POST", `${o.id}/split`, { session: s.captain, headers, body: { lines: [{ orderItemId: o.ids[2] }] } });
    expect(first.status).toBe(200);
    expect(first.json.data).toMatchObject({ replayed: false, original: { id: o.id }, order: { items: [{ id: o.ids[2] }] } });
    const retry = await call(Orders, "POST", `${o.id}/split`, { session: s.captain, headers, body: { lines: [{ orderItemId: o.ids[2] }] } });
    expect(retry.json.data).toMatchObject({ replayed: true });
    expect(retry.json.data.order.id).toBe(first.json.data.order.id);
    const clash = await call(Orders, "POST", `${o.id}/split`, { session: s.captain, headers, body: { lines: [{ orderItemId: o.ids[1] }] } });
    expect(clash.status).toBe(409);
  });

  it("validation and permissions", async () => {
    const o = await order(2);
    const body = { lines: [{ orderItemId: o.ids[1] }] };
    expect((await call(Orders, "POST", `${o.id}/split`, { session: s.captain, body: { lines: [] } })).status).toBe(422);
    expect((await call(Orders, "POST", `${o.id}/split`, { session: s.captain, body: { lines: [{ orderItemId: o.ids[0] }, { orderItemId: o.ids[1] }] } })).status).toBe(422);
    expect((await call(Orders, "POST", `${o.id}/split`, { session: s.kitchen, body })).status).toBe(403);
    expect((await call(Orders, "POST", `${o.id}/split`, { session: s.foreign, body })).status).toBe(404);
    expect((await call(Orders, "POST", `${o.id}/split`, { body })).status).toBe(401);
    // Without a key the split still works (the screen sends one, curl may not).
    expect((await call(Orders, "POST", `${o.id}/split`, { session: s.cashier, body })).status).toBe(200);
  });
});
