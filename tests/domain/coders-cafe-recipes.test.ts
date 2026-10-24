/**
 * Coders' Cafe DRAFT recipes (prisma/coders-cafe/recipes.ts) and the
 * "estimated" safeguard on recipe versions (services/recipe.ts):
 *  - every draft names a real board item; every board item is covered or listed as not covered
 *  - ingredients / quantities / units are valid; notes label everything an estimate
 *  - seeding is idempotent and never changes the menu (names, prices, sizes, add-ons)
 *  - estimated drafts are never consumed or costed and cannot be approved until confirmed;
 *    once confirmed and approved, a sale consumes the recipe's ingredients
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { ValidationError, type AccessContext } from "@/server/db/scope";
import { placeOrder } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { addRecipeLine, approveRecipeVersion, calculateRecipeCost, createRecipe, createRecipeVersion, describeRecipeCost, menuItemCostAndMargin, RECIPE_ESTIMATED, updateRecipeVersion } from "@/server/services/recipe";
import { seedCodersCafe, type CafeSeedResult } from "../../prisma/coders-cafe/seed";
import { CODERS_CAFE_MENU, menuItemCount } from "../../prisma/coders-cafe/menu";
import { DRAFT_INGREDIENTS, DRAFT_RECIPES, NOT_COVERED, draftNotes, seedCodersCafeDraftRecipes } from "../../prisma/coders-cafe/recipes";
import { num } from "@/domain/money";

const boardItems = CODERS_CAFE_MENU.flatMap((c) => c.items.map((i) => i.name));

describe("the draft dataset (no database)", () => {
  it("covers every board item exactly once, or says why not; names are the board's own", () => {
    const drafted = DRAFT_RECIPES.map((r) => r.item);
    expect(new Set(drafted).size).toBe(drafted.length);
    for (const name of drafted) expect(boardItems, name).toContain(name);
    for (const n of NOT_COVERED) expect(boardItems).toContain(n.item);
    expect(drafted.filter((d) => NOT_COVERED.some((n) => n.item === d))).toEqual([]);
    expect(drafted.length + NOT_COVERED.length).toBe(menuItemCount());
  });

  it("every line names a known ingredient with a positive quantity; whole pieces for countable items", () => {
    const skus = new Map(DRAFT_INGREDIENTS.map((i) => [i.sku, i]));
    expect(skus.size).toBe(DRAFT_INGREDIENTS.length);
    for (const r of DRAFT_RECIPES) {
      expect(r.lines.length, r.item).toBeGreaterThan(0);
      expect(new Set(r.lines.map(([sku]) => sku)).size, `${r.item}: an ingredient listed twice`).toBe(r.lines.length);
      for (const [sku, qty] of r.lines) {
        expect(skus.has(sku), `${r.item}: ${sku}`).toBe(true);
        expect(qty, `${r.item}: ${sku}`).toBeGreaterThan(0);
        if (sku === "CC-WINGS" || sku === "CC-PIZZABASE") expect(Number.isInteger(qty), `${r.item}: ${sku}`).toBe(true);
      }
      expect(r.minutes).toBeGreaterThan(0);
    }
    // Wings scale with the piece count printed on the board.
    const wings = (n: number) => DRAFT_RECIPES.find((r) => r.item === `BBQ Chicken Wings (${n} Pc)`)!.lines.find(([sku]) => sku === "CC-WINGS")![1];
    expect([wings(6), wings(9), wings(12)]).toEqual([6, 9, 12]);
  });

  it("notes call every value an estimate and never claim a dish is allergen-free", () => {
    for (const r of DRAFT_RECIPES) {
      const notes = draftNotes(r);
      expect(notes).toMatch(/^ESTIMATED DRAFT/);
      expect(notes).toMatch(/Method \(estimated\)/);
      expect(notes).toMatch(/time \(estimated\)/);
      expect(notes).toMatch(/Allergens: NOT verified/);
      // The only mention of "allergen-free" is the warning against claiming it.
      expect(notes.replace("Never present any dish as allergen-free from this draft.", "")).not.toMatch(/allergen-free|free from|no allergens/i);
    }
    expect(draftNotes(DRAFT_RECIPES.find((r) => r.item === "Classic Margherita Pizza")!)).toMatch(/contains milk, wheat \(gluten\)/);
  });
});

describe("seeded into Coders' Cafe", () => {
  let cafe: CafeSeedResult;
  let ctx: AccessContext;
  let menuBefore: unknown;

  /** Everything the owner's menu consists of, in a comparable form. */
  async function menuSnapshot(orgId: string) {
    const items = await prisma.menuItem.findMany({
      where: { organizationId: orgId }, orderBy: { name: "asc" },
      select: { name: true, price: true, taxPct: true, isVeg: true, active: true, soldOut: true, description: true, category: { select: { name: true, sortOrder: true } }, variants: { orderBy: { name: "asc" }, select: { name: true, priceDelta: true, consumptionFactor: true, active: true } }, modifierGroups: { select: { group: { select: { name: true, options: { orderBy: { name: "asc" }, select: { name: true, priceDelta: true } } } } } } },
    });
    return JSON.parse(JSON.stringify(items));
  }

  beforeAll(async () => {
    // Menu first, recipes second: the menu snapshot in between proves the recipes change nothing on it.
    cafe = await seedCodersCafe(prisma, { reset: true, draftRecipes: false });
    ctx = systemContext(cafe.organizationId, [cafe.outletId]);
    menuBefore = await menuSnapshot(cafe.organizationId);
    const r = await seedCodersCafeDraftRecipes(prisma, ctx);
    expect(r).toMatchObject({ created: DRAFT_RECIPES.length, existing: 0, missingMenuItems: [], materialsCreated: DRAFT_INGREDIENTS.length });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("the menu is byte-for-byte the board menu after adding the recipes", async () => {
    expect(await menuSnapshot(cafe.organizationId)).toEqual(menuBefore);
    expect(cafe.items).toBe(menuItemCount());
  });

  it("re-running adds nothing (idempotent): no duplicate recipes, ingredients or units", async () => {
    const again = await seedCodersCafeDraftRecipes(prisma, ctx);
    expect(again).toMatchObject({ created: 0, existing: DRAFT_RECIPES.length, materialsCreated: 0, missingMenuItems: [] });
    expect(await prisma.recipe.count({ where: { organizationId: cafe.organizationId } })).toBe(DRAFT_RECIPES.length);
    expect(await prisma.material.count({ where: { organizationId: cafe.organizationId } })).toBe(DRAFT_INGREDIENTS.length);
    expect(await prisma.unit.count({ where: { organizationId: cafe.organizationId, code: { in: ["g", "ml", "pc"] } } })).toBe(3);
    expect(await menuSnapshot(cafe.organizationId)).toEqual(menuBefore);
  });

  it("each recipe is linked to its own menu item as one DRAFT, ESTIMATED version with the planned lines", async () => {
    const recipes = await prisma.recipe.findMany({ where: { organizationId: cafe.organizationId }, include: { menuItem: { select: { name: true } }, versions: { include: { lines: { include: { material: { select: { sku: true } } } } } } } });
    for (const rec of recipes) {
      const plan = DRAFT_RECIPES.find((d) => d.item === rec.name)!;
      expect(rec.menuItem?.name).toBe(rec.name);
      expect(rec.versions).toHaveLength(1);
      const v = rec.versions[0];
      expect(v).toMatchObject({ status: "DRAFT", estimated: true, approvedAt: null });
      expect(v.notes).toBe(draftNotes(plan));
      expect(v.lines.map((l) => [l.material!.sku, Number(l.qty)]).sort()).toEqual(plan.lines.map(([s, q]) => [s, q]).sort());
    }
    // No prices were invented for the ingredients.
    expect(await prisma.outletMaterialCost.count({ where: { organizationId: cafe.organizationId } })).toBe(0);
  });

  it("an estimated draft is never consumed or costed, and cannot be approved until its quantities are confirmed", async () => {
    const margherita = await prisma.menuItem.findUniqueOrThrow({ where: { organizationId_name: { organizationId: cafe.organizationId, name: "Classic Margherita Pizza" } }, include: { recipe: { include: { versions: true } } } });
    const version = margherita.recipe!.versions[0];

    // A sale while the recipe is an estimated draft: no stock moves.
    const sell = async () => {
      const o = await placeOrder(ctx, { outletId: cafe.outletId, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: margherita.id, qty: 1 }] });
      const total = num((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).total);
      const p = await createPayment(ctx, o.id, { method: "CASH", amount: total });
      await verifyPayment(ctx, p.id);
      return prisma.inventoryLedger.count({ where: { organizationId: cafe.organizationId, sourceId: o.id } });
    };
    expect(await sell()).toBe(0);
    await expect(menuItemCostAndMargin(prisma, ctx, margherita.id, cafe.outletId)).rejects.toThrow(/no approved recipe/);

    const refused = await approveRecipeVersion(ctx, version.id).catch((e) => e);
    expect(refused).toBeInstanceOf(ValidationError);
    expect((refused as ValidationError).details).toMatchObject({ code: RECIPE_ESTIMATED });
    expect((await prisma.recipeVersion.findUniqueOrThrow({ where: { id: version.id } })).status).toBe("DRAFT");

    // Someone checks the quantities against the kitchen and confirms them; approval is then possible.
    await updateRecipeVersion(ctx, version.id, { estimated: false });
    await approveRecipeVersion(ctx, version.id);
    expect(await sell()).toBe(DRAFT_RECIPES.find((r) => r.item === "Classic Margherita Pizza")!.lines.length);
    // Approved, but no ingredient has a cost yet: no plate cost, margin or food cost % is invented.
    expect(await menuItemCostAndMargin(prisma, ctx, margherita.id, cafe.outletId)).toMatchObject({
      versionId: version.id, complete: false, cost: null, plateCost: null, margin: null, foodCostPct: null,
    });
  });

  it("costing tells missing, partial and complete ingredient costs apart; a missing cost is never 0", async () => {
    const fries = await prisma.recipe.findFirstOrThrow({ where: { organizationId: cafe.organizationId, name: "Classic Fries" }, include: { versions: { include: { lines: true } } } });
    const v = fries.versions[0];
    const materialIds = v.lines.map((l) => l.materialId!);
    expect(materialIds.length).toBeGreaterThan(1);
    const view = async () => describeRecipeCost(prisma, ctx, await calculateRecipeCost(prisma, ctx, v.id, { outletId: cafe.outletId }));

    const none = await view();
    expect(none).toMatchObject({ complete: false, total: null, pricedSubtotal: 0, unpricedCount: materialIds.length });
    expect(none.lines.every((l) => !l.priced && l.unitCost === null && l.cost === null)).toBe(true);

    // Test-only prices on this disposable test database (never seeded into the cafe).
    await prisma.outletMaterialCost.create({ data: { organizationId: cafe.organizationId, outletId: cafe.outletId, materialId: materialIds[0], avgCost: 0.1 } });
    const partial = await view();
    expect(partial).toMatchObject({ complete: false, total: null, unpricedCount: materialIds.length - 1 });
    expect(partial.pricedSubtotal).toBeGreaterThan(0);
    expect(partial.lines.filter((l) => l.priced).map((l) => l.materialId)).toEqual([materialIds[0]]);

    for (const id of materialIds.slice(1)) await prisma.outletMaterialCost.create({ data: { organizationId: cafe.organizationId, outletId: cafe.outletId, materialId: id, avgCost: 0.2 } });
    const full = await view();
    expect(full).toMatchObject({ complete: true, unpricedCount: 0 });
    expect(full.total).toBe(full.pricedSubtotal);
    expect(full.total!).toBeGreaterThan(partial.pricedSubtotal);
    // Still an estimated draft: priced or not, it has no plate cost for the menu (not approved).
    await expect(menuItemCostAndMargin(prisma, ctx, fries.menuItemId!, cafe.outletId)).rejects.toThrow(/no approved recipe/);
    await prisma.outletMaterialCost.deleteMany({ where: { organizationId: cafe.organizationId, outletId: cafe.outletId, materialId: { in: materialIds } } });
  });

  it("a new version copies the estimate flag from an estimated source; confirming is audited", async () => {
    const corn = await prisma.recipe.findFirstOrThrow({ where: { organizationId: cafe.organizationId, name: "Corn Special" }, include: { versions: true } });
    // The draft must be resolved before a new version starts: confirm then approve v1, then estimate v2 again.
    await updateRecipeVersion(ctx, corn.versions[0].id, { estimated: false });
    expect(await prisma.auditLog.count({ where: { organizationId: cafe.organizationId, entityType: "RecipeVersion", entityId: corn.versions[0].id } })).toBeGreaterThan(0);
    await approveRecipeVersion(ctx, corn.versions[0].id);
    const v2 = await createRecipeVersion(ctx, corn.id, { estimated: true });
    expect(v2).toMatchObject({ status: "DRAFT", estimated: true, version: 2 });
    await expect(approveRecipeVersion(ctx, v2.id)).rejects.toBeInstanceOf(ValidationError);
    const v1 = await prisma.recipeVersion.findUniqueOrThrow({ where: { id: corn.versions[0].id } });
    expect(v1).toMatchObject({ status: "APPROVED", estimated: false }); // the approved one keeps driving consumption
  });

  it("quantity / ingredient validation still applies to drafts", async () => {
    const fries = await prisma.recipe.findFirstOrThrow({ where: { organizationId: cafe.organizationId, name: "Classic Fries" }, include: { versions: true } });
    const salt = await prisma.material.findUniqueOrThrow({ where: { organizationId_sku: { organizationId: cafe.organizationId, sku: "CC-SALT" } } });
    await expect(addRecipeLine(ctx, fries.versions[0].id, { componentType: "MATERIAL", materialId: salt.id, qty: 0 })).rejects.toBeInstanceOf(ZodError);
    await expect(addRecipeLine(ctx, fries.versions[0].id, { componentType: "MATERIAL", qty: 1 })).rejects.toBeInstanceOf(ZodError);
    const item = await prisma.menuItem.findUniqueOrThrow({ where: { organizationId_name: { organizationId: cafe.organizationId, name: "Classic Fries" } } });
    await expect(createRecipe(ctx, { name: "Second fries recipe", outputType: "MENU_ITEM", menuItemId: item.id, estimated: true })).rejects.toThrow(/already has a recipe/);
  });
});
