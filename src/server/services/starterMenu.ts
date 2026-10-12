/**
 * Coders' Cafe starter: the real Coders' Cafe menu (prisma/coders-cafe/menu.ts,
 * 8 categories / 64 items / sizes / pizza add-ons, transcribed from the owner's
 * menu boards) plus dine-in tables T01–T10, imported into an EXISTING
 * restaurant. It writes the same rows and audit records those menu and
 * master-data services would write, but as bulk inserts inside one transaction:
 * a per-row round trip exceeds the interactive-transaction limit on a remote
 * PostgreSQL database. It is the one builder for that dataset: the demo seed
 * (prisma/coders-cafe/seed.ts) and the desktop first-run / empty-menu import
 * all call it.
 *
 * Production-safe by construction:
 *  - additive only: never deletes or overwrites anything;
 *  - refuses unless the organization's menu is completely empty, so it cannot
 *    duplicate or mix into a menu the restaurant already built;
 *  - one transaction: a failure leaves the restaurant exactly as it was;
 *  - tables that already exist (same code at the outlet) are kept untouched;
 *  - no accounts, no public passwords, and QR codes are random (the same
 *    18-byte token rotateTableQr issues), never the demo seed's derivable
 *    tokens — unless the caller asks for fixed tokens (the demo seed does,
 *    for its printed demo QR cards).
 */
import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { AccessContext } from "@/server/db/scope";
import { ConflictError, ForbiddenError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { assertOutletInOrg } from "@/server/db/outletGuard";
import { D, money } from "@/domain/money";
import { runInTx } from "@/server/services/_workflow";
import { CODERS_CAFE_MENU, PIZZA_ADD_ONS } from "../../../prisma/coders-cafe/menu";

type Client = PrismaClient | Prisma.TransactionClient;

export const STARTER_TABLE_CODES = Array.from({ length: 10 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`);
export const MENU_NOT_EMPTY = "This restaurant already has a menu; the Coders' Cafe menu is only imported into an empty menu";

export type StarterResult = { categories: number; items: number; variants: number; tablesCreated: string[]; tablesKept: string[] };

/** Menu items + categories the organization holds (any state). */
export async function menuSize(db: Client, organizationId: string): Promise<number> {
  const [c, i] = await Promise.all([db.menuCategory.count({ where: { organizationId } }), db.menuItem.count({ where: { organizationId } })]);
  return c + i;
}

/** Client-generated primary key so child rows can reference parents before insert. */
function newId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * SQLite rejects one INSERT above its bound-parameter limit. Chunks stay inside
 * the caller's transaction, so PostgreSQL and SQLite still commit or roll back
 * together. 40 rows stays under SQLite's 999-parameter default.
 */
async function insertMany<T>(rows: T[], write: (data: T[]) => Promise<unknown>): Promise<void> {
  const size = 40;
  for (let i = 0; i < rows.length; i += size) await write(rows.slice(i, i + size));
}

export async function importCodersCafeStarter(
  ctx: AccessContext,
  input: { outletId: string; tableToken?: (code: string) => string },
  db: Client,
): Promise<StarterResult> {
  assertCan(ctx, "menu.manage", input.outletId);
  return runInTx(db, async (tx) => {
    await assertOutletInOrg(tx, ctx, input.outletId);
    if ((await menuSize(tx, ctx.organizationId)) > 0) throw new ConflictError(MENU_NOT_EMPTY);
    if (!ctx.isSuperAdmin && !ctx.isOrgWide) throw new ForbiddenError("The menu is organization-wide; changes need an org-wide role with menu.manage");

    const existing = new Set((await tx.restaurantTable.findMany({ where: { outletId: input.outletId, code: { in: STARTER_TABLE_CODES } }, select: { code: true } })).map((t) => t.code));
    const missing = STARTER_TABLE_CODES.filter((c) => !existing.has(c));
    if (missing.length) assertCan(ctx, "outlet.manage", input.outletId);

    const now = new Date();
    const actorId = ctx.userId === "system" ? null : ctx.userId;
    const organizationId = ctx.organizationId;
    const audits: Prisma.AuditLogCreateManyInput[] = [];
    const audit = (row: { action: string; entityType: string; entityId: string; after: unknown; outletId?: string }) => {
      audits.push({
        id: newId(),
        organizationId,
        outletId: row.outletId ?? null,
        actorId,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        before: null,
        after: JSON.stringify(row.after),
        createdAt: now,
      });
    };

    const groupId = newId();
    const group = { name: PIZZA_ADD_ONS.name, minSelect: PIZZA_ADD_ONS.minSelect, maxSelect: PIZZA_ADD_ONS.maxSelect };
    audit({ action: "CREATE", entityType: "ModifierGroup", entityId: groupId, after: group });
    const options: Prisma.ModifierOptionCreateManyInput[] = PIZZA_ADD_ONS.options.map((o) => {
      const id = newId();
      const after = { groupId, name: o.name, priceDelta: o.priceDelta };
      audit({ action: "CREATE", entityType: "ModifierOption", entityId: id, after });
      return { id, organizationId, groupId, name: o.name, priceDelta: money(o.priceDelta), active: true };
    });

    const categories: Prisma.MenuCategoryCreateManyInput[] = [];
    const items: Prisma.MenuItemCreateManyInput[] = [];
    const variants: Prisma.MenuItemVariantCreateManyInput[] = [];
    const links: Prisma.MenuItemModifierGroupCreateManyInput[] = [];
    for (const cat of CODERS_CAFE_MENU) {
      const categoryId = newId();
      const category = { name: cat.name, sortOrder: cat.sortOrder };
      categories.push({ id: categoryId, organizationId, ...category, active: true, createdAt: now, updatedAt: now });
      audit({ action: "CREATE", entityType: "MenuCategory", entityId: categoryId, after: category });
      for (const it of cat.items) {
        const menuItemId = newId();
        items.push({
          id: menuItemId,
          organizationId,
          categoryId,
          name: it.name,
          description: it.description ?? null,
          price: money(it.price),
          taxPct: D(5),
          station: "KITCHEN",
          isVeg: it.isVeg,
          active: true,
          soldOut: false,
          createdById: actorId,
          createdAt: now,
          updatedAt: now,
        });
        audit({ action: "CREATE", entityType: "MenuItem", entityId: menuItemId, after: { name: it.name, price: it.price } });
        for (const s of it.sizes ?? []) {
          const priceDelta = s.price - it.price;
          if (money(it.price).plus(priceDelta).lt(0)) throw new ValidationError("Variant price would be negative");
          const variantId = newId();
          const after = { menuItemId, name: s.name, priceDelta, consumptionFactor: 1 };
          variants.push({ id: variantId, organizationId, menuItemId, name: s.name, priceDelta: money(priceDelta), consumptionFactor: D(1), active: true });
          audit({ action: "CREATE", entityType: "MenuItemVariant", entityId: variantId, after });
        }
        if (it.pizzaAddOns) {
          links.push({ id: newId(), menuItemId, groupId });
          audit({ action: "UPDATE", entityType: "MenuItem", entityId: menuItemId, after: { attachedModifierGroup: groupId } });
        }
      }
    }

    const floors: Prisma.FloorCreateManyInput[] = [];
    const tables: Prisma.RestaurantTableCreateManyInput[] = [];
    if (missing.length) {
      const floor = await tx.floor.findFirst({ where: { outletId: input.outletId }, orderBy: { sortOrder: "asc" }, select: { id: true } });
      let floorId = floor?.id;
      if (!floorId) {
        floorId = newId();
        const after = { outletId: input.outletId, name: "Main Floor", sortOrder: 0 };
        floors.push({ id: floorId, organizationId, ...after, createdAt: now });
        audit({ action: "CREATE", entityType: "Floor", entityId: floorId, outletId: input.outletId, after });
      }
      for (const code of missing) {
        const id = newId();
        const qrToken = input.tableToken ? input.tableToken(code) : randomBytes(18).toString("base64url");
        audit({ action: "CREATE", entityType: "RestaurantTable", entityId: id, outletId: input.outletId, after: { outletId: input.outletId, code, capacity: 4, floorId } });
        if (!input.tableToken) audit({ action: "UPDATE", entityType: "RestaurantTable", entityId: id, outletId: input.outletId, after: { qrRotated: true } });
        tables.push({ id, organizationId, outletId: input.outletId, floorId, code, capacity: 4, status: "AVAILABLE", qrToken, createdAt: now, updatedAt: now });
      }
    }

    await insertMany([{ id: groupId, organizationId, ...group, active: true }], (data) => tx.modifierGroup.createMany({ data }));
    await insertMany(options, (data) => tx.modifierOption.createMany({ data }));
    await insertMany(categories, (data) => tx.menuCategory.createMany({ data }));
    await insertMany(items, (data) => tx.menuItem.createMany({ data }));
    await insertMany(variants, (data) => tx.menuItemVariant.createMany({ data }));
    await insertMany(links, (data) => tx.menuItemModifierGroup.createMany({ data }));
    await insertMany(floors, (data) => tx.floor.createMany({ data }));
    await insertMany(tables, (data) => tx.restaurantTable.createMany({ data }));
    await insertMany(audits, (data) => tx.auditLog.createMany({ data }));

    return { categories: categories.length, items: items.length, variants: variants.length, tablesCreated: missing, tablesKept: [...existing].sort() };
  });
}
