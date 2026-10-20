/**
 * Builds the acceptance-test database from nothing (prisma/e2e-acceptance.db).
 * Run by playwright.acceptance.config.ts before `next start`; dev.db and the main
 * E2E database are never touched.
 *
 *  1. the committed migration history (`prisma migrate deploy`)
 *  2. the Coders' Cafe dataset: real menu, tables T01–T10, one user per role
 *  3. what an operator sets up in Settings: the outlet's GSTIN (a registered
 *     business issues CGST / SGST invoices) and the bank merchant binding
 *     (bank callbacks are bound to the tenant by the merchant id; here the
 *     test bank emulator's)
 *  4. what an operator sets up under Recipes / Inventory: ingredients for the
 *     dish the test orders (Loaded Veg Nachos), its approved recipe, and received
 *     stock in the kitchen department. The Coders' Cafe draft recipes are left
 *     out here (seedCodersCafe { draftRecipes: false }).
 *  5. a second, unrelated restaurant (owner, outlet, table, dish) for the
 *     cross-tenant checks.
 *
 * The numbers the spec asserts (ingredient quantities, opening stock) are
 * exported from ./fixture.ts so the data and the assertions cannot drift apart.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ACCEPTANCE_DB_PATH } from "./fixture";

async function main() {
  // Fresh evidence for a fresh database.
  fs.rmSync(path.join(process.cwd(), "e2e", ".evidence-acceptance"), { recursive: true, force: true });
  for (const s of ["", "-journal", "-wal", "-shm"]) if (fs.existsSync(ACCEPTANCE_DB_PATH + s)) fs.rmSync(ACCEPTANCE_DB_PATH + s);
  fs.mkdirSync(path.dirname(ACCEPTANCE_DB_PATH), { recursive: true });
  const url = `file:${ACCEPTANCE_DB_PATH.replace(/\\/g, "/")}`;
  process.env.DATABASE_URL = url;
  execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });

  const { prisma } = await import("@/server/db/client");
  const { seedCodersCafe, CAFE } = await import("../../prisma/coders-cafe/seed");
  const { systemContext } = await import("@/server/auth/context");
  const { hashPassword } = await import("@/server/auth/password");
  const { recordPurchaseReceipt } = await import("@/server/services/inventory");
  const { createMenuItem } = await import("@/server/services/menu");
  const fx = await import("./fixture");

  // Without the estimated draft recipes: step 4 sets up the dish's own approved
  // recipe (a menu item has one recipe), and the spec asserts its exact quantities.
  const cafe = await seedCodersCafe(prisma, { draftRecipes: false });
  const merchant = process.env.UPI_EMULATOR_MERCHANT_ID;
  if (!merchant) throw new Error("UPI_EMULATOR_MERCHANT_ID is required (playwright.acceptance.config.ts)");
  await prisma.integrationConnection.create({ data: { organizationId: cafe.organizationId, outletId: cafe.outletId, kind: "PAYMENT", provider: "upi_emulator", externalRef: merchant, status: "CONNECTED", mode: "MOCK" } });
  await prisma.outlet.update({ where: { id: cafe.outletId }, data: { gstin: fx.CAFE_GSTIN } });

  // ---- ingredients, recipe, stock (the dish the acceptance order buys)
  const ctx = systemContext(cafe.organizationId, [cafe.outletId]);
  const dish = await prisma.menuItem.findFirstOrThrow({ where: { organizationId: cafe.organizationId, name: fx.DISH.name } });
  const kitchen = await prisma.department.findFirstOrThrow({ where: { outletId: cafe.outletId, kind: "KITCHEN" } });
  const kg = await prisma.unit.create({ data: { organizationId: cafe.organizationId, code: "kg", name: "kilogram", kind: "WEIGHT" } });
  const recipe = await prisma.recipe.create({ data: { organizationId: cafe.organizationId, name: `${fx.DISH.name} (plate)`, outputType: "MENU_ITEM", menuItemId: dish.id } });
  const version = await prisma.recipeVersion.create({ data: { organizationId: cafe.organizationId, recipeId: recipe.id, version: 1, status: "APPROVED", yieldQty: 1 } });
  for (const ing of fx.INGREDIENTS) {
    const material = await prisma.material.create({ data: { organizationId: cafe.organizationId, sku: ing.sku, name: ing.name, baseUnitId: kg.id } });
    await prisma.recipeLine.create({ data: { organizationId: cafe.organizationId, recipeVersionId: version.id, componentType: "MATERIAL", materialId: material.id, qty: ing.perPlate } });
    await recordPurchaseReceipt(ctx, { outletId: cafe.outletId, materialId: material.id, departmentId: kitchen.id, quantity: ing.openingQty, rate: ing.rate, sourceRef: `acceptance:opening:${ing.sku}`, note: "Opening stock received for the acceptance test" });
  }

  // ---- a second restaurant that must stay invisible to the first
  const other = await prisma.organization.create({ data: { name: fx.OTHER.orgName, currency: "INR", timezone: "Asia/Kolkata" } });
  const otherOutlet = await prisma.outlet.create({ data: { organizationId: other.id, code: "MB01", name: fx.OTHER.orgName, currency: "INR", timezone: "Asia/Kolkata", invoiceSeries: "MB" } });
  const owner = await prisma.user.create({ data: { organizationId: other.id, email: fx.OTHER.ownerEmail, name: "Other Owner", passwordHash: await hashPassword(CAFE.password) } });
  await prisma.membership.create({ data: { organizationId: other.id, userId: owner.id, outletId: null, role: "OWNER" } });
  await prisma.restaurantTable.create({ data: { organizationId: other.id, outletId: otherOutlet.id, code: "X01", qrToken: fx.OTHER.tableToken } });
  await createMenuItem(systemContext(other.id, [otherOutlet.id]), { name: fx.OTHER.dish, price: 99, taxPct: 5, station: "KITCHEN" });

  console.log(`acceptance e2e: Coders' Cafe ${cafe.items} items, ${cafe.tables.length} tables, GSTIN set, test bank merchant bound, recipe + stock for "${fx.DISH.name}"; second restaurant "${fx.OTHER.orgName}" created`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
