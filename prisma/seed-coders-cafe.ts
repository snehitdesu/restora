/**
 * Seed the Coders' Cafe demo / acceptance dataset (prisma/coders-cafe).
 *
 *   npm run db:seed:cafe            create it (no-op report if it already exists)
 *   npm run db:seed:cafe -- --reset delete ONLY the Coders' Cafe organization and rebuild it
 *   npm run db:seed:cafe -- --add-draft-recipes
 *                                   add the DRAFT / estimated recipes (prisma/coders-cafe/recipes.ts) to an
 *                                   existing Coders' Cafe without resetting it: additive, idempotent, never
 *                                   changes the menu, never approved (no stock or food-cost effect)
 *
 * Other organizations in the database are never touched. Refused under
 * NODE_ENV=production (public demo password) unless
 * ALLOW_DEMO_SEED=true on a disposable database.
 *
 * Table QR tokens are bearer secrets, so the report prints only how many tables
 * have one (prisma/coders-cafe/qrStatus.ts), never a token or guest link.
 * Printable sheets are `npm run qr:tables -- --base-url <URL>` (local) or
 * `npm run qr:tables -- --mode production --base-url <public https URL>`.
 */
import { prisma } from "@/server/db/client";
import { CAFE, demoStaffPasswordForCli, findCafe, seedCodersCafe } from "./coders-cafe/seed";
import { cafeQrStatusLines } from "./coders-cafe/qrStatus";
import { NOT_COVERED, seedCodersCafeDraftRecipes } from "./coders-cafe/recipes";
import { systemContext } from "@/server/auth/context";
import { UNRESOLVED } from "./coders-cafe/menu";

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "true") {
    throw new Error("Refusing to seed demo data with NODE_ENV=production (public demo password). Set ALLOW_DEMO_SEED=true only for a disposable database.");
  }
  const reset = process.argv.includes("--reset");
  const existing = await findCafe(prisma);
  if (existing && !reset && process.argv.includes("--add-draft-recipes")) {
    const outlets = await prisma.outlet.findMany({ where: { organizationId: existing.id }, select: { id: true } });
    const r = await seedCodersCafeDraftRecipes(prisma, systemContext(existing.id, outlets.map((o) => o.id)));
    console.log(`${CAFE.orgName}: ${r.created} draft recipes added (${r.existing} menu items already had a recipe; ${r.materialsCreated} ingredients created). All are DRAFT with estimated quantities.`);
    if (r.missingMenuItems.length) console.log(`Menu items not found (left alone): ${r.missingMenuItems.join(", ")}`);
    console.log(`No draft for: ${NOT_COVERED.map((n) => n.item).join(", ")} (contents not on the boards).`);
  } else if (existing && !reset) {
    console.log(`${CAFE.orgName} already exists (organization ${existing.id}). Nothing changed; use --reset to rebuild it, or --add-draft-recipes to add the draft recipes only.`);
  } else {
    const password = demoStaffPasswordForCli();
    const r = await seedCodersCafe(prisma, { reset, password });
    console.log(`${reset && existing ? "Rebuilt" : "Created"} ${CAFE.orgName}: ${r.categories} categories, ${r.items} menu items, ${r.tables.length} tables.`);
    console.log(`Not imported (unreadable on the boards): ${UNRESOLVED.length} entries, see prisma/coders-cafe/menu.ts.`);
    console.log(`${r.draftRecipes} DRAFT recipes with estimated quantities (not used for stock or food cost until confirmed and approved).`);
  }
  console.log(`\nSign-in accounts (password is not logged): ${CAFE.users.map((u) => `${u.email} (${u.role})`).join(", ")}`);
  const org = await findCafe(prisma);
  const outlet = org ? await prisma.outlet.findFirst({ where: { organizationId: org.id, code: CAFE.outletCode }, select: { id: true } }) : null;
  // Only which tables have a token is read; the tokens themselves are never selected or printed.
  const withToken = outlet
    ? await prisma.restaurantTable.findMany({ where: { outletId: outlet.id, code: { in: [...CAFE.tableCodes] }, qrToken: { not: null } }, select: { code: true } })
    : [];
  const tables = withToken.map((t) => ({ code: t.code, hasQrToken: true }));
  for (const line of cafeQrStatusLines({ baseUrl: process.env.PUBLIC_BASE_URL, tableCodes: CAFE.tableCodes, tables })) console.log(line);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
