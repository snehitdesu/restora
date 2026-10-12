/** Switching dishes on/off on the ordering platforms over HTTP: the menu route triggers it, the control room lists and retries it. */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "@/server/db/client";
import { createMenuItem } from "@/server/services/menu";
import { upsertIntegration } from "@/server/services/integrations";
import { settleAfterCommit } from "@/server/services/afterCommit";
import { MockAggregatorProvider } from "@/integrations/aggregator";
import * as Menu from "@/app/api/menu/[[...path]]/route";
import * as Integrations from "@/app/api/integrations/[[...path]]/route";
import { makeEnv, uniq, type Env } from "../domain/growthSupport";
import { call, sessionFor } from "./routeSupport";

let env: Env;
let item: string;
const s: Record<string, string> = {};

beforeAll(async () => {
  env = await makeEnv("Gar");
  await upsertIntegration(env.owner, { kind: "AGGREGATOR", provider: "mock", outletId: env.outletA, externalRef: `store_${uniq()}`, status: "CONNECTED", mode: "SANDBOX" });
  item = (await createMenuItem(env.owner, { name: `Route Item ${uniq()}`, price: 80, taxPct: 5, posCode: "ROUTE-1" })).id;
  s.owner = await sessionFor(env.orgId, "OWNER", null);
  s.cashier = await sessionFor(env.orgId, "CASHIER", env.outletA);
  s.foreign = await sessionFor((await prisma.organization.create({ data: { name: `Other ${uniq()}` } })).id, "OWNER", null);
}, 60000);
afterAll(async () => { await prisma.$disconnect(); });

describe("POST /api/menu/items/:id/availability and the outbox", () => {
  it("a sold-out switch reaches the store; the control room lists it; a platform failure is retried from the control room", async () => {
    expect((await call(Menu, "POST", `items/${item}/availability`, { session: s.cashier, body: { soldOut: true } })).status).toBe(403);
    expect((await call(Menu, "POST", `items/${item}/availability`, { session: s.foreign, body: { soldOut: true } })).status).toBe(404);
    expect(await prisma.integrationDelivery.count({ where: { organizationId: env.orgId, kind: "AGGREGATOR_ITEM" } })).toBe(0);

    const spy = vi.spyOn(MockAggregatorProvider.prototype, "setItemAvailability").mockRejectedValueOnce(new Error("Zomato unavailable"));
    const r = await call(Menu, "POST", `items/${item}/availability`, { session: s.owner, body: { soldOut: true } });
    expect(r.status).toBe(200); // the menu change stands whatever the platform does
    await settleAfterCommit();
    spy.mockRestore();

    const list = await call(Integrations, "GET", "deliveries?kind=AGGREGATOR_ITEM", { session: s.owner });
    expect(list.status).toBe(200);
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0]).toMatchObject({ kind: "AGGREGATOR_ITEM", status: "FAILED", mode: "MOCK", attempts: 1 });
    expect(list.json.data[0].lastError).toMatch(/Zomato unavailable/);
    expect(list.json.data[0].target).toMatch(/→ off$/);

    expect((await call(Integrations, "POST", `deliveries/${list.json.data[0].id}/retry`, { session: s.cashier, body: {} })).status).toBe(403);
    expect((await call(Integrations, "POST", `deliveries/${list.json.data[0].id}/retry`, { session: s.foreign, body: {} })).status).toBe(404);
    const retried = await call(Integrations, "POST", `deliveries/${list.json.data[0].id}/retry`, { session: s.owner, body: {} });
    expect(retried.status).toBe(200);
    expect(retried.json.data).toMatchObject({ status: "SENT", attempts: 2 });
    expect((await call(Integrations, "POST", `deliveries/${list.json.data[0].id}/retry`, { session: s.owner, body: {} })).status).toBe(422); // only failed ones
  });
});
