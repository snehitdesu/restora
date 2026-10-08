/** Kitchen timing and upsell over HTTP: who may read what, input validation, and the shapes the screens rely on. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { createMenuItem } from "@/server/services/menu";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { makeEnv, type Env } from "../domain/growthSupport";
import * as Kitchen from "@/app/api/kitchen/[[...path]]/route";
import * as Menu from "@/app/api/menu/[[...path]]/route";
import { call, sessionFor } from "./routeSupport";

let env: Env;
let dish: string;
const s: Record<string, string> = {};

beforeAll(async () => {
  env = await makeEnv("Gkr");
  dish = (await createMenuItem(env.owner, { name: "Route Dosa", price: 100, taxPct: 5 })).id;
  s.owner = await sessionFor(env.orgId, "OWNER", null);
  s.manager = await sessionFor(env.orgId, "MANAGER", env.outletA);
  s.cashier = await sessionFor(env.orgId, "CASHIER", env.outletA);
  s.kitchen = await sessionFor(env.orgId, "KITCHEN", env.outletA);
  s.captain = await sessionFor(env.orgId, "CAPTAIN", env.outletA);
  s.foreign = await sessionFor((await prisma.organization.create({ data: { name: `Other ${Date.now()}` } })).id, "OWNER", null);
  const o = await createOrder(env.owner, { outletId: env.outletA, channel: "TAKEAWAY" });
  await addOrderItem(env.owner, o.id, { menuItemId: dish, qty: 1 });
});
afterAll(async () => { await prisma.$disconnect(); });

describe("GET /api/kitchen/prep-times", () => {
  const url = () => `prep-times?outletId=${env.outletA}&days=14`;
  it("needs a session; the kitchen and managers read it, the cashier does not", async () => {
    expect((await call(Kitchen, "GET", url())).status).toBe(401);
    for (const role of ["kitchen", "manager", "owner", "captain"]) {
      const r = await call(Kitchen, "GET", url(), { session: s[role] });
      expect(r.status, role).toBe(200);
      expect(r.json.data).toMatchObject({ days: 14, minSamples: 3, overall: { tickets: 0 }, dishes: [], stations: [] });
    }
    expect((await call(Kitchen, "GET", url(), { session: s.cashier })).status).toBe(403);
  });

  it("rejects bad input and another restaurant's view is empty", async () => {
    expect((await call(Kitchen, "GET", "prep-times", { session: s.manager })).status).toBe(422);
    expect((await call(Kitchen, "GET", `prep-times?outletId=${env.outletA}&days=0`, { session: s.manager })).status).toBe(422);
    expect((await call(Kitchen, "GET", `prep-times?outletId=${env.outletA}&days=9999`, { session: s.manager })).status).toBe(422);
    const foreign = await call(Kitchen, "GET", url(), { session: s.foreign });
    expect(foreign.status === 200 ? foreign.json.data.overall.tickets : 0).toBe(0);
  });
});

describe("GET /api/menu/upsell", () => {
  const url = (items = dish) => `upsell?outletId=${env.outletA}&items=${items}`;
  it("order takers may ask (an empty answer is a normal answer); the kitchen may not; no session is a 401", async () => {
    expect((await call(Menu, "GET", url())).status).toBe(401);
    for (const role of ["cashier", "captain", "manager", "owner"]) {
      const r = await call(Menu, "GET", url(), { session: s[role] });
      expect(r.status, role).toBe(200);
      expect(r.json.data).toEqual([]);
    }
    expect((await call(Menu, "GET", url(), { session: s.kitchen })).status).toBe(403);
  });

  it("rejects bad input", async () => {
    expect((await call(Menu, "GET", "upsell", { session: s.cashier })).status).toBe(422);
    expect((await call(Menu, "GET", `upsell?outletId=${env.outletA}&limit=9`, { session: s.cashier })).status).toBe(422);
    expect((await call(Menu, "GET", `upsell?outletId=${env.outletA}&items=${"x".repeat(2100)}`, { session: s.cashier })).status).toBe(422);
  });
});
