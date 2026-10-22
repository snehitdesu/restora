/**
 * Seed the RESTORA Demo Café SAMPLE dataset (prisma/demo-cafe; review list in
 * docs/demo-cafe-data.md).
 *
 *   npm run db:seed:demo-cafe -- --confirm-demo-database=<db>           create it (no-op report if it exists)
 *   npm run db:seed:demo-cafe -- --confirm-demo-database=<db> --reset   delete ONLY the demo organization and rebuild it
 *
 * <db> is the target database's name (SQLite file name, e.g. demo-cafe.db, or the
 * PostgreSQL database name): the seed adds sign-in accounts, so it must never run
 * against a database by accident, however empty that database looks, and the
 * confirmation only ever covers the database it names (demo-cafe/target.ts). The
 * working dev.db is always refused. Other organizations are never touched. Refused
 * under NODE_ENV=production. PostgreSQL also needs DEMO_DATABASE_CONFIRMED=true and
 * a unique DEMO_STAFF_PASSWORD (the same rules as the Coders' Cafe seed); SQLite
 * uses DEMO_STAFF_PASSWORD or the documented local demo password.
 */
import { prisma } from "@/server/db/client";
import { demoStaffPasswordForCli } from "./coders-cafe/seed";
import { DEMO_CAFE, DEMO_IN_USE, seedDemoCafe } from "./demo-cafe/seed";
import { demoSeedTarget } from "./demo-cafe/target";

async function main() {
  demoSeedTarget(process.argv);
  const password = demoStaffPasswordForCli();
  const r = await seedDemoCafe(prisma, { password, reset: process.argv.includes("--reset") });
  console.log(r.created ? `Created ${DEMO_CAFE.orgName}.` : `${DEMO_CAFE.orgName} already exists (organization ${r.organizationId}); nothing changed. Use --reset to rebuild it.`);
  console.log(`${r.categories} categories, ${r.items} menu items (${r.variants} sizes), ${r.modifierGroups} modifier groups, ${r.ingredients} ingredients with opening stock, ${r.recipes} recipes, ${r.suppliers} sample suppliers, ${r.tables} tables.`);
  console.log("SAMPLE DATA: prices, recipes, quantities and ingredient rates are demo estimates, not approved or verified (docs/demo-cafe-data.md).");
  console.log(`Sign-in accounts (password is not logged): ${DEMO_CAFE.users.map((u) => `${u.email} (${u.role})`).join(", ")}`);
}

main()
  .catch((e) => {
    const message = e instanceof Error ? e.message : String(e);
    console.error(message === DEMO_IN_USE ? `Not reset: ${message}` : message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
