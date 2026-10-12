/**
 * Universal search (audit PA-05) against the real database: each kind of result appears only for logins that may open
 * it, everything is scoped to the caller's organization and outlets, matching ignores letter case, and odd input is safe.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { createMenuItem } from "@/server/services/menu";
import { createMaterial, createUnit, createVendor } from "@/server/services/masterData";
import { createCustomer } from "@/server/services/crm";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { universalSearch, SEARCH_MIN_CHARS } from "@/server/services/search";
import { makeEnv, member, phone, type Env } from "./growthSupport";

let env: Env;
let other: Env;
const find = async (ctx: Env["owner"], q: string) => universalSearch(prisma, ctx, { q });
const types = (r: Awaited<ReturnType<typeof find>>) => r.groups.map((g) => g.type);

beforeAll(async () => {
  env = await makeEnv("Gsr");
  other = await makeEnv("Gss");
  await createMenuItem(env.owner, { name: "Zesty Paneer Wrap", price: 140, taxPct: 5 });
  await createMenuItem(other.owner, { name: "Zesty Secret Burger", price: 200, taxPct: 5 });
  await createMenuItem(env.owner, { name: "Lunch 50% Combo", price: 250, taxPct: 5 });
  await createCustomer(env.manager, { name: "Zesty Zoya", phone: "9333300001" } as never);
  await createCustomer(other.owner, { name: "Zesty Stranger", phone: "9333300002" } as never);
  const gram = (await createUnit(env.owner, { code: `zg${Date.now().toString(36)}`, name: "Gram", kind: "WEIGHT" })).id;
  await createMaterial(env.owner, { sku: "ZST-001", name: "Zesty Spice Mix", baseUnitId: gram });
  await createVendor(env.owner, { name: "Zesty Traders", companyName: "Zesty Traders Pvt Ltd" } as never);
  await prisma.restaurantTable.create({ data: { organizationId: env.orgId, outletId: env.outletA, code: "ZT1" } });
  await prisma.restaurantTable.create({ data: { organizationId: env.orgId, outletId: env.outletB, code: "ZT2" } });
  const o = await createOrder(env.owner, { outletId: env.outletA, channel: "TAKEAWAY" });
  await addOrderItem(env.owner, o.id, { name: "Open item", qty: 1, unitPrice: 50, taxPct: 0 });
  await prisma.order.update({ where: { id: o.id }, data: { invoiceNo: "ZST/2627/0001" } });
});
afterAll(async () => { await prisma.$disconnect(); });

describe("universal search", () => {
  it("an owner finds every kind, grouped, with the places they open", async () => {
    const r = await find(env.owner, "zesty");
    expect(types(r)).toEqual(["customer", "menu", "material", "vendor"]); // the order is found by invoice number, not by "zesty"
    const byType = Object.fromEntries(r.groups.map((g) => [g.type, g.items]));
    expect(byType.customer[0]).toMatchObject({ title: "Zesty Zoya", subtitle: "9333300001", href: expect.stringMatching(/^\/customers\//) });
    expect(byType.menu[0]).toMatchObject({ title: "Zesty Paneer Wrap", href: expect.stringMatching(/^\/menu\/items\//) });
    expect(byType.material[0]).toMatchObject({ title: "Zesty Spice Mix", subtitle: "ZST-001", href: expect.stringMatching(/^\/master\/materials\//) });
    expect(byType.vendor[0]).toMatchObject({ title: "Zesty Traders", subtitle: "Zesty Traders Pvt Ltd" });
  });

  it("matching ignores case; a phone is found by its digits, an order by invoice number; a table by code", async () => {
    expect((await find(env.owner, "ZESTY PANEER")).groups.find((g) => g.type === "menu")!.items).toHaveLength(1);
    expect((await find(env.owner, "93333 00001")).groups.find((g) => g.type === "customer")!.items[0].title).toBe("Zesty Zoya");
    const inv = (await find(env.owner, "zst/2627")).groups.find((g) => g.type === "order")!.items[0];
    expect(inv).toMatchObject({ title: "Invoice ZST/2627/0001", href: expect.stringMatching(/^\/pos\/bill\//) });
    expect((await find(env.owner, "zt")).groups.find((g) => g.type === "table")!.items.map((t) => t.title).sort()).toEqual(["Table ZT1", "Table ZT2"]);
  });

  it("an order is found by the reference on the bill (last characters of its id)", async () => {
    const o = await prisma.order.findFirstOrThrow({ where: { organizationId: env.orgId, invoiceNo: "ZST/2627/0001" } });
    const r = await find(env.owner, o.id.slice(-6).toUpperCase());
    expect(r.groups.find((g) => g.type === "order")!.items[0].id).toBe(o.id);
  });

  it("only what the login may open: a cashier gets customers, menu, orders and tables but not materials, vendors, recipes, staff or purchase data", async () => {
    const r = await find(env.cashier, "zesty");
    expect(types(r).sort()).toEqual(["customer", "menu"]);
    expect(types(await find(env.kitchen, "zesty"))).toEqual(["menu"]); // the kitchen sees the menu
    const manager = await find(env.manager, "zesty");
    expect(types(manager)).toEqual(expect.arrayContaining(["customer", "menu", "material", "vendor"]));
  });

  it("outlet-bound logins only see their outlets' tables and orders; org-wide roles see all", async () => {
    expect((await find(env.manager, "zt")).groups.find((g) => g.type === "table")!.items.map((t) => t.title)).toEqual(["Table ZT1"]);
    const atB = member(env.orgId, "MANAGER", env.outletB);
    expect((await find(atB, "zt")).groups.find((g) => g.type === "table")!.items.map((t) => t.title)).toEqual(["Table ZT2"]);
    expect((await find(atB, "zst/2627")).groups.find((g) => g.type === "order")).toBeUndefined(); // the order is at outlet A
  });

  it("another restaurant never appears, in either direction", async () => {
    const mine = JSON.stringify(await find(env.owner, "zesty"));
    expect(mine).not.toContain("Secret Burger");
    expect(mine).not.toContain("Stranger");
    const theirs = JSON.stringify(await find(other.owner, "zesty"));
    expect(theirs).toContain("Secret Burger");
    expect(theirs).not.toContain("Paneer Wrap");
    expect(theirs).not.toContain("Zoya");
  });

  it("short, long or odd input is safe: too short is refused, wildcards match literally, nothing found is an empty list", async () => {
    await expect(universalSearch(prisma, env.owner, { q: "z" })).rejects.toThrow();
    await expect(universalSearch(prisma, env.owner, { q: "x".repeat(61) })).rejects.toThrow();
    expect(SEARCH_MIN_CHARS).toBe(2);
    for (const q of ["%%", "__", "'; DROP TABLE users;--", "\\\\", "a%b"]) expect((await find(env.owner, q)).groups, q).toEqual([]);
    // A wildcard typed by a person is just a character.
    expect((await find(env.owner, "50%")).groups.flatMap((g) => g.items.map((i) => i.title))).toEqual(["Lunch 50% Combo"]);
    expect((await find(env.owner, "nothing-called-this")).groups).toEqual([]);
    expect((await universalSearch(prisma, env.owner, { q: "zesty", limit: 1 })).groups.every((g) => g.items.length <= 1)).toBe(true);
    void phone;
  });
});
