/**
 * Upsell hints (audit ME-04) against the real services and database: what guests really order together at this outlet,
 * the dishes menu engineering says are worth recommending, and the rules about what may never be suggested.
 *
 *  U1 pairing evidence  U2 profitable dishes fill the gaps, pairing first  U3 never suggested  U4 permissions, tenants
 *  U5 nothing about cost leaves the service
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@/server/db/client";
import { ForbiddenError } from "@/server/db/scope";
import type { AccessContext } from "@/server/db/scope";
import { createMenuItem, setMenuItemAvailability, setOutletMenuItem } from "@/server/services/menu";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { clearUpsellCache, upsellSuggestions, UPSELL_MIN_PAIRS } from "@/server/services/upsell";
import { settleAfterCommit } from "@/server/services/afterCommit";
import { makeEnv, member, type Env } from "./growthSupport";

let env: Env;
let captain: AccessContext;
const id: Record<string, string> = {};
const NOW = new Date();
type Classes = Map<string, "STAR" | "PUZZLE" | "PLOWHORSE" | "DOG">;
const suggest = (items: string[], extra: Record<string, unknown> = {}, ctx: AccessContext = captain, classes?: Classes) =>
  upsellSuggestions(prisma, ctx, { outletId: env.outletA, menuItemIds: items.map((n) => id[n]), ...extra } as never, NOW, classes ? { classes } : {});
const cls = (entries: Array<[string, "STAR" | "PUZZLE" | "PLOWHORSE" | "DOG"]>): Classes => new Map(entries.map(([n, c]) => [id[n], c]));

/** An order containing the named dishes, settled through the real payment service when `paid`. */
async function orderWith(names: string[], opts: { outletId?: string; paid?: boolean } = {}) {
  const o = await createOrder(env.owner, { outletId: opts.outletId ?? env.outletA, channel: "TAKEAWAY" });
  for (const n of names) await addOrderItem(env.owner, o.id, { menuItemId: id[n], qty: 1 });
  if (opts.paid !== false) {
    const total = Number((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).total);
    const p = await createPayment(env.owner, o.id, { method: "UPI", amount: total });
    await verifyPayment(env.owner, p.id);
    await settleAfterCommit();
  }
  return o.id;
}

beforeAll(async () => {
  env = await makeEnv("Gup");
  captain = member(env.orgId, "CAPTAIN", env.outletA);
  for (const [name, price] of [["Masala Dosa", 120], ["Filter Coffee", 40], ["Medu Vada", 60], ["Chef Special", 300], ["House Thali", 220], ["Old Favourite", 90]] as const) id[name] = (await createMenuItem(env.owner, { name, price, taxPct: 5 })).id;
  // At this outlet the dosa goes with coffee three times and with vada once.
  for (let i = 0; i < 3; i++) await orderWith(["Masala Dosa", "Filter Coffee"]);
  await orderWith(["Masala Dosa", "Medu Vada"]);
  // Orders that must not count: never paid, and another outlet's.
  for (let i = 0; i < 3; i++) await orderWith(["Masala Dosa", "Chef Special"], { paid: false });
  for (let i = 0; i < 3; i++) await orderWith(["Masala Dosa", "House Thali"], { outletId: env.outletB });
}, 120000);
beforeEach(() => clearUpsellCache());
afterAll(async () => { await prisma.$disconnect(); });

describe("U1. pairing evidence", () => {
  it("U1 suggests what guests at this outlet really add, with the reason in words; one order is not evidence", async () => {
    const r = await suggest(["Masala Dosa"]);
    expect(UPSELL_MIN_PAIRS).toBe(2);
    expect(r).toEqual([{ menuItemId: id["Filter Coffee"], name: "Filter Coffee", price: 40, reason: "PAIRS_WITH", with: "Masala Dosa", text: "Guests often add it to Masala Dosa" }]);
    // It works the other way round too.
    expect((await suggest(["Filter Coffee"])).map((h) => [h.name, h.with])).toEqual([["Masala Dosa", "Filter Coffee"]]);
  });

  it("U1 nothing on the order, nothing suggested; dishes already ordered are never suggested again", async () => {
    expect(await suggest([])).toEqual([]);
    expect(await suggest(["Masala Dosa", "Filter Coffee"])).toEqual([]);
  });

  it("U1 unknown or other restaurants' dishes on the order are ignored", async () => {
    expect(await suggest(["Masala Dosa"], { menuItemIds: [id["Masala Dosa"], "no-such-dish"] })).toHaveLength(1);
    expect(await suggest([], { menuItemIds: ["no-such-dish"] })).toEqual([]);
  });
});

describe("U2. profitable dishes fill the gaps, pairing first", () => {
  it("U2 a paired dish comes first, then dishes worth recommending (puzzles before stars); dogs and plow-horses never", async () => {
    const classes = cls([["Chef Special", "PUZZLE"], ["House Thali", "STAR"], ["Medu Vada", "DOG"], ["Old Favourite", "PLOWHORSE"]]);
    const r = await suggest(["Masala Dosa"], { limit: 5 }, captain, classes);
    expect(r.map((h) => [h.name, h.reason])).toEqual([["Filter Coffee", "PAIRS_WITH"], ["Chef Special", "FEATURED"], ["House Thali", "POPULAR"]]);
    expect(r[1].text).toMatch(/Worth recommending/);
    expect((await suggest(["Masala Dosa"], { limit: 2 }, captain, classes)).map((h) => h.name)).toEqual(["Filter Coffee", "Chef Special"]);
  });

  it("U2 a dish that is both paired and a puzzle is shown as paired (the truer reason) and outranks other pairs", async () => {
    const r = await suggest(["Masala Dosa"], {}, captain, cls([["Filter Coffee", "PUZZLE"]]));
    expect(r[0]).toMatchObject({ name: "Filter Coffee", reason: "PAIRS_WITH" });
  });

  it("U2 without a classification (no recipes or sales yet) only pairing evidence is used, and nothing breaks", async () => {
    const r = await suggest(["Masala Dosa"]); // the real menu-engineering path: nothing is classifiable here
    expect(r.map((h) => h.name)).toEqual(["Filter Coffee"]);
  });
});

describe("U3. never suggested", () => {
  it("U3 sold out, inactive and switched-off-here dishes are skipped", async () => {
    const classes = cls([["Chef Special", "PUZZLE"], ["House Thali", "STAR"], ["Old Favourite", "PUZZLE"]]);
    const names = async () => (await suggest(["Masala Dosa"], { limit: 5 }, captain, classes)).map((h) => h.name);
    expect(await names()).toEqual(["Filter Coffee", "Chef Special", "Old Favourite", "House Thali"]);
    await setMenuItemAvailability(env.owner, id["Chef Special"], { soldOut: true });
    expect(await names()).toEqual(["Filter Coffee", "Old Favourite", "House Thali"]);
    await setMenuItemAvailability(env.owner, id["House Thali"], { active: false });
    expect(await names()).toEqual(["Filter Coffee", "Old Favourite"]);
    await setOutletMenuItem(env.owner, { menuItemId: id["Old Favourite"], outletId: env.outletA, active: false } as never);
    expect(await names()).toEqual(["Filter Coffee"]);
    await setMenuItemAvailability(env.owner, id["Filter Coffee"], { soldOut: true });
    expect(await names()).toEqual([]);
    // Put the menu back for the tests that follow.
    await setMenuItemAvailability(env.owner, id["Filter Coffee"], { soldOut: false });
    await setMenuItemAvailability(env.owner, id["Chef Special"], { soldOut: false });
    await setMenuItemAvailability(env.owner, id["House Thali"], { active: true });
    await setOutletMenuItem(env.owner, { menuItemId: id["Old Favourite"], outletId: env.outletA, active: true } as never);
    expect(await names()).toEqual(["Filter Coffee", "Chef Special", "Old Favourite", "House Thali"]);
  });
});

describe("U4. permissions and tenants", () => {
  it("U4 whoever takes orders may ask; kitchen and other restaurants may not read this outlet's patterns", async () => {
    expect((await suggest(["Masala Dosa"], {}, env.cashier)).length).toBeGreaterThan(0);
    await expect(suggest(["Masala Dosa"], {}, env.kitchen)).rejects.toBeInstanceOf(ForbiddenError);
    // Another restaurant asking with this outlet's dish ids sees none of its history.
    expect(await suggest(["Masala Dosa"], {}, env.foreign)).toEqual([]);
    // A captain of outlet B cannot ask about outlet A.
    await expect(suggest(["Masala Dosa"], {}, member(env.orgId, "CAPTAIN", env.outletB))).rejects.toThrow();
  });

  it("U4 bad input is refused", async () => {
    await expect(suggest(["Masala Dosa"], { limit: 0 })).rejects.toThrow();
    await expect(suggest(["Masala Dosa"], { limit: 99 })).rejects.toThrow();
    await expect(upsellSuggestions(prisma, captain, { outletId: "" } as never, NOW)).rejects.toThrow();
  });
});

describe("U5. nothing about cost leaves the service", () => {
  it("U5 a hint carries only the dish, its menu price and a reason in words", async () => {
    const r = await suggest(["Masala Dosa"], { limit: 5 }, captain, cls([["Chef Special", "PUZZLE"], ["House Thali", "STAR"]]));
    for (const h of r) {
      expect(Object.keys(h).sort()).toEqual(h.with ? ["menuItemId", "name", "price", "reason", "text", "with"] : ["menuItemId", "name", "price", "reason", "text"]);
      expect(h.text).not.toMatch(/margin|cost|profit|%|₹|rs\./i);
    }
  });
});
