/** GET /api/search over HTTP: a session is required, results follow the caller's permissions and organization, input is validated. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { createCustomer } from "@/server/services/crm";
import { createMenuItem } from "@/server/services/menu";
import { makeEnv, type Env } from "../domain/growthSupport";
import * as Search from "@/app/api/search/[[...path]]/route";
import { call, sessionFor } from "./routeSupport";

let env: Env;
const s: Record<string, string> = {};

beforeAll(async () => {
  env = await makeEnv("Gse");
  await createCustomer(env.manager, { name: "Quokka Guest", phone: "9444400001" } as never);
  await createMenuItem(env.owner, { name: "Quokka Special", price: 100, taxPct: 5 });
  s.manager = await sessionFor(env.orgId, "MANAGER", env.outletA);
  s.kitchen = await sessionFor(env.orgId, "KITCHEN", env.outletA);
  s.foreign = await sessionFor((await prisma.organization.create({ data: { name: `Elsewhere ${Date.now()}` } })).id, "OWNER", null);
});
afterAll(async () => { await prisma.$disconnect(); });

describe("GET /api/search", () => {
  it("needs a session; managers get customers and menu, the kitchen only the menu, another restaurant nothing", async () => {
    expect((await call(Search, "GET", "?q=quokka")).status).toBe(401);
    const m = await call(Search, "GET", "?q=quokka", { session: s.manager });
    expect(m.status).toBe(200);
    expect(m.json.data.groups.map((g: { type: string }) => g.type)).toEqual(["customer", "menu"]);
    expect((await call(Search, "GET", "?q=quokka", { session: s.kitchen })).json.data.groups.map((g: { type: string }) => g.type)).toEqual(["menu"]);
    expect((await call(Search, "GET", "?q=quokka", { session: s.foreign })).json.data.groups).toEqual([]);
  });

  it("validates input", async () => {
    expect((await call(Search, "GET", "", { session: s.manager })).status).toBe(422);
    expect((await call(Search, "GET", "?q=a", { session: s.manager })).status).toBe(422);
    expect((await call(Search, "GET", `?q=${"x".repeat(80)}`, { session: s.manager })).status).toBe(422);
    expect((await call(Search, "GET", "?q=quokka&limit=99", { session: s.manager })).status).toBe(422);
  });
});
