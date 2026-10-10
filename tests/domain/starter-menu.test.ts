/**
 * The Coders' Cafe starter imports the real menu + tables T01–T10 into an
 * EXISTING restaurant (desktop first run / empty Menu screen): additive, only
 * into an empty menu, atomic, random QR tokens, no accounts, RBAC-checked.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { prisma } from "@/server/db/client";
import { num } from "@/domain/money";
import { buildAccessContext, systemContext } from "@/server/auth/context";
import { ForbiddenError } from "@/server/db/scope";
import * as rbac from "@/server/auth/rbac";
import { createMenuItem } from "@/server/services/menu";
import { importCodersCafeStarter, MENU_NOT_EMPTY, STARTER_TABLE_CODES } from "@/server/services/starterMenu";
import { menuItemCount, CODERS_CAFE_MENU, PIZZA_ADD_ONS } from "../../prisma/coders-cafe/menu";
import { cafeTableToken } from "../../prisma/coders-cafe/seed";

const RUN = Date.now().toString(36);
afterAll(async () => { await prisma.$disconnect(); });

/** An org shaped exactly like the desktop wizard leaves it (bootstrapOwner itself refuses a non-empty DB). */
async function restaurant(tag: string) {
  const org = await prisma.organization.create({ data: { name: `Starter ${tag} ${RUN}` } });
  const outlet = await prisma.outlet.create({ data: { organizationId: org.id, code: `S${tag}${RUN}`.toUpperCase().slice(0, 20), name: "Main" } });
  const mk = async (role: string, outletId: string | null) => {
    const u = await prisma.user.create({ data: { organizationId: org.id, email: `${role.toLowerCase()}-${tag}-${RUN}@starter.test`, name: role, passwordHash: "x" } });
    await prisma.membership.create({ data: { organizationId: org.id, userId: u.id, outletId, role } });
    return buildAccessContext(prisma, u.id);
  };
  return { org, outlet, owner: await mk("OWNER", null), cashier: await mk("CASHIER", outlet.id) };
}

describe("Coders' Cafe starter import", () => {
  it("imports the real menu and T01–T10 into an existing restaurant, with random QR tokens and no accounts", async () => {
    const { org, outlet, owner } = await restaurant("a");
    await prisma.restaurantTable.create({ data: { organizationId: org.id, outletId: outlet.id, code: "T07", capacity: 6, qrToken: `keep-${RUN}` } });
    const users = await prisma.user.count({ where: { organizationId: org.id } });

    const r = await importCodersCafeStarter(owner, { outletId: outlet.id }, prisma);
    expect(r).toMatchObject({ categories: 8, items: 64, tablesKept: ["T07"] });
    expect(r.tablesCreated).toHaveLength(9);
    expect(await prisma.menuCategory.count({ where: { organizationId: org.id } })).toBe(CODERS_CAFE_MENU.length);
    expect(await prisma.menuItem.count({ where: { organizationId: org.id } })).toBe(menuItemCount());
    expect(await prisma.menuItemVariant.count({ where: { menuItem: { organizationId: org.id } } })).toBe(r.variants);
    expect(r.variants).toBeGreaterThan(0);
    expect(await prisma.user.count({ where: { organizationId: org.id } })).toBe(users);

    const tables = await prisma.restaurantTable.findMany({ where: { outletId: outlet.id }, orderBy: { code: "asc" } });
    expect(tables.map((t) => t.code)).toEqual(["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10"]);
    const t07 = tables.find((t) => t.code === "T07")!;
    expect(t07).toMatchObject({ capacity: 6, qrToken: `keep-${RUN}` }); // existing table untouched
    for (const t of tables.filter((x) => x.code !== "T07")) {
      expect(t.qrToken).toBeTruthy();
      expect(t.qrToken).not.toBe(cafeTableToken(t.code)); // never the public, derivable demo token
    }
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, entityType: "MenuItem", action: "CREATE" } })).toBe(64);

    const fries = await prisma.menuItem.findFirstOrThrow({ where: { organizationId: org.id, name: "Classic Fries" }, include: { category: true, variants: { orderBy: { name: "asc" } } } });
    expect(fries.category?.name).toBe("Appetizers");
    expect(num(fries.price)).toBe(85);
    expect(num(fries.taxPct)).toBe(5);
    expect(fries).toMatchObject({ station: "KITCHEN", isVeg: true, active: true, soldOut: false, createdById: owner.userId });
    expect(fries.variants.map((v) => [v.name, num(v.priceDelta), num(v.consumptionFactor)])).toEqual([["Large", 25, 1], ["Medium", 10, 1]]);
    const friesAudit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: fries.id, action: "CREATE" } });
    expect(friesAudit).toMatchObject({ actorId: owner.userId, outletId: null, entityType: "MenuItem", before: null, after: JSON.stringify({ name: "Classic Fries", price: 85 }) });

    const pizza = await prisma.menuItem.findFirstOrThrow({
      where: { organizationId: org.id, name: "Classic Margherita Pizza" },
      include: { modifierGroups: { include: { group: { include: { options: { orderBy: { name: "asc" } } } } } } },
    });
    expect(pizza.modifierGroups).toHaveLength(1);
    expect(pizza.modifierGroups[0].group).toMatchObject({ name: PIZZA_ADD_ONS.name, minSelect: 0, maxSelect: 2 });
    expect(pizza.modifierGroups[0].group.options.map((o) => [o.name, num(o.priceDelta)])).toEqual([["Extra Veggies", 40], ["Make It a Cheese Melt", 60]]);
    const bucket = await prisma.menuItem.findFirstOrThrow({ where: { organizationId: org.id, name: "Chicken Popcorn + Fries Bucket" } });
    expect(bucket.description).toBe("Large Popcorn + Med Fries");

    const floor = await prisma.floor.findFirstOrThrow({ where: { outletId: outlet.id } });
    expect(floor.name).toBe("Main Floor");
    for (const t of tables.filter((x) => x.code !== "T07")) expect(t).toMatchObject({ capacity: 4, status: "AVAILABLE", floorId: floor.id });
    expect(t07.floorId).toBeNull();
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, entityType: "MenuCategory", action: "CREATE" } })).toBe(8);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, entityType: "MenuItemVariant", action: "CREATE" } })).toBe(r.variants);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, entityType: "ModifierGroup", action: "CREATE" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, entityType: "ModifierOption", action: "CREATE" } })).toBe(PIZZA_ADD_ONS.options.length);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, entityType: "MenuItem", action: "UPDATE" } })).toBe(13);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, entityType: "Floor", action: "CREATE" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, entityType: "RestaurantTable", action: "CREATE" } })).toBe(9);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, entityType: "RestaurantTable", action: "UPDATE" } })).toBe(9);
  });

  it("refuses a restaurant that already has a menu and changes nothing", async () => {
    const { org, outlet, owner } = await restaurant("b");
    await createMenuItem(owner, { name: `House Special ${RUN}`, price: 150 });
    await expect(importCodersCafeStarter(owner, { outletId: outlet.id }, prisma)).rejects.toThrow(MENU_NOT_EMPTY);
    expect(await prisma.menuItem.count({ where: { organizationId: org.id } })).toBe(1);
    expect(await prisma.restaurantTable.count({ where: { outletId: outlet.id } })).toBe(0);
  });

  it("a second import is refused (idempotent: never duplicates)", async () => {
    const { org, outlet, owner } = await restaurant("c");
    await importCodersCafeStarter(owner, { outletId: outlet.id }, prisma);
    await expect(importCodersCafeStarter(owner, { outletId: outlet.id }, prisma)).rejects.toThrow(MENU_NOT_EMPTY);
    expect(await prisma.menuItem.count({ where: { organizationId: org.id } })).toBe(64);
    expect(await prisma.restaurantTable.count({ where: { outletId: outlet.id } })).toBe(10);
  });

  it("rolls back menu, tables, and audit rows when a later insert fails", async () => {
    const kept = await restaurant("g");
    await prisma.restaurantTable.create({ data: { organizationId: kept.org.id, outletId: kept.outlet.id, code: "X1", qrToken: `taken-${RUN}` } });
    const { org, outlet, owner } = await restaurant("h");
    await expect(importCodersCafeStarter(owner, { outletId: outlet.id, tableToken: () => `taken-${RUN}` }, prisma)).rejects.toThrow(/Unique constraint/i);
    expect(await prisma.menuCategory.count({ where: { organizationId: org.id } })).toBe(0);
    expect(await prisma.menuItem.count({ where: { organizationId: org.id } })).toBe(0);
    expect(await prisma.menuItemVariant.count({ where: { organizationId: org.id } })).toBe(0);
    expect(await prisma.modifierGroup.count({ where: { organizationId: org.id } })).toBe(0);
    expect(await prisma.floor.count({ where: { organizationId: org.id } })).toBe(0);
    expect(await prisma.restaurantTable.count({ where: { outletId: outlet.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id } })).toBe(0);
    expect(await prisma.restaurantTable.count({ where: { qrToken: `taken-${RUN}` } })).toBe(1);
  });

  it("stores caller-supplied tokens without a rotation audit, and a system actor is not a user id", async () => {
    const { org, outlet } = await restaurant("i");
    const ctx = systemContext(org.id, [outlet.id]);
    await importCodersCafeStarter(ctx, { outletId: outlet.id, tableToken: (code) => `tok-${RUN}-${code}` }, prisma);
    const t01 = await prisma.restaurantTable.findFirstOrThrow({ where: { outletId: outlet.id, code: "T01" } });
    const floor = await prisma.floor.findFirstOrThrow({ where: { outletId: outlet.id } });
    expect(t01).toMatchObject({ qrToken: `tok-${RUN}-T01`, capacity: 4, status: "AVAILABLE", floorId: floor.id });
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, entityType: "RestaurantTable", action: "UPDATE" } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, entityType: "RestaurantTable", action: "CREATE" } })).toBe(10);
    const sample = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: org.id, entityType: "MenuItem", action: "CREATE" } });
    expect(sample.actorId).toBeNull();
    expect((await prisma.menuItem.findFirstOrThrow({ where: { organizationId: org.id } })).createdById).toBeNull();
  });

  it("refuses to create missing tables without outlet.manage, and skips that check when every table exists", async () => {
    const missing = await restaurant("k");
    const real = rbac.assertCan;
    const denyTables = vi.spyOn(rbac, "assertCan").mockImplementation((ctx, permission, outletId) => {
      if (permission === "outlet.manage") throw new ForbiddenError(`Missing permission "outlet.manage"${outletId ? ` for outlet ${outletId}` : ""}`);
      return real(ctx, permission, outletId);
    });
    try {
      await expect(importCodersCafeStarter(missing.owner, { outletId: missing.outlet.id }, prisma)).rejects.toThrow(/outlet\.manage/);
      expect(await prisma.menuCategory.count({ where: { organizationId: missing.org.id } })).toBe(0);
      expect(await prisma.menuItem.count({ where: { organizationId: missing.org.id } })).toBe(0);
      expect(await prisma.restaurantTable.count({ where: { outletId: missing.outlet.id } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { organizationId: missing.org.id } })).toBe(0);
    } finally {
      denyTables.mockRestore();
    }

    const present = await restaurant("m");
    for (const code of STARTER_TABLE_CODES) {
      await prisma.restaurantTable.create({ data: { organizationId: present.org.id, outletId: present.outlet.id, code, qrToken: `kept-${RUN}-${code}` } });
    }
    const denyAgain = vi.spyOn(rbac, "assertCan").mockImplementation((ctx, permission, outletId) => {
      if (permission === "outlet.manage") throw new ForbiddenError("outlet.manage should not be required");
      return real(ctx, permission, outletId);
    });
    try {
      const r = await importCodersCafeStarter(present.owner, { outletId: present.outlet.id }, prisma);
      expect(r.tablesCreated).toEqual([]);
      expect(r.tablesKept).toEqual([...STARTER_TABLE_CODES]);
      expect(await prisma.restaurantTable.count({ where: { outletId: present.outlet.id } })).toBe(10);
      expect(await prisma.auditLog.count({ where: { organizationId: present.org.id, entityType: "RestaurantTable" } })).toBe(0);
      const kept = await prisma.restaurantTable.findFirstOrThrow({ where: { outletId: present.outlet.id, code: "T01" } });
      expect(kept.qrToken).toBe(`kept-${RUN}-T01`);
    } finally {
      denyAgain.mockRestore();
    }
  });

  it("refuses an outlet manager, who has menu.manage but not an org-wide role", async () => {
    const { org, outlet } = await restaurant("j");
    const manager = await prisma.user.create({ data: { organizationId: org.id, email: `manager-j-${RUN}@starter.test`, name: "Manager", passwordHash: "x" } });
    await prisma.membership.create({ data: { organizationId: org.id, userId: manager.id, outletId: outlet.id, role: "MANAGER" } });
    const ctx = await buildAccessContext(prisma, manager.id);
    await expect(importCodersCafeStarter(ctx, { outletId: outlet.id }, prisma)).rejects.toThrow(/organization-wide/);
    expect(await prisma.menuCategory.count({ where: { organizationId: org.id } })).toBe(0);
    expect(await prisma.restaurantTable.count({ where: { outletId: outlet.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: org.id } })).toBe(0);
  });

  it("requires menu.manage: a cashier cannot import", async () => {
    const { org, outlet, cashier } = await restaurant("d");
    await expect(importCodersCafeStarter(cashier, { outletId: outlet.id }, prisma)).rejects.toThrow(/permission/i);
    expect(await prisma.menuCategory.count({ where: { organizationId: org.id } })).toBe(0);
  });

  it("refuses another organization's outlet (no rows written anywhere)", async () => {
    const a = await restaurant("e");
    const b = await restaurant("f");
    await expect(importCodersCafeStarter(a.owner, { outletId: b.outlet.id }, prisma)).rejects.toThrow(/Outlet not found/);
    expect(await prisma.menuCategory.count({ where: { organizationId: { in: [a.org.id, b.org.id] } } })).toBe(0);
    expect(await prisma.restaurantTable.count({ where: { outletId: b.outlet.id } })).toBe(0);
  });
});
