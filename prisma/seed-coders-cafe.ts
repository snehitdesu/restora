/**
 * Seed the Coders' Cafe demo / acceptance dataset (prisma/coders-cafe).
 *
 *   npm run db:seed:cafe            create it (no-op report if it already exists)
 *   npm run db:seed:cafe -- --reset delete ONLY the Coders' Cafe organization and rebuild it
 *
 * Other organizations in the database are never touched. Refused under
 * NODE_ENV=production (public demo password, derivable QR tokens) unless
 * ALLOW_DEMO_SEED=true on a disposable database.
 *
 * PUBLIC_BASE_URL (or http://localhost:3000) is used only to print each table's
 * stored guest link. A localhost link is labelled not for customer printing.
 * Printable sheets are `npm run qr:tables` (local) or `--mode production`.
 */
import { prisma } from "@/server/db/client";
import { guestOrderingUrl, qrBaseUrlProblem } from "@/server/qr/tableLabels";
import { CAFE, demoStaffPasswordForCli, findCafe, seedCodersCafe } from "./coders-cafe/seed";
import { UNRESOLVED } from "./coders-cafe/menu";

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "true") {
    throw new Error("Refusing to seed demo data with NODE_ENV=production (public demo password, derivable QR tokens). Set ALLOW_DEMO_SEED=true only for a disposable database.");
  }
  const reset = process.argv.includes("--reset");
  const base = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const existing = await findCafe(prisma);
  if (existing && !reset) {
    console.log(`${CAFE.orgName} already exists (organization ${existing.id}). Nothing changed; use --reset to rebuild it.`);
  } else {
    const password = demoStaffPasswordForCli();
    const r = await seedCodersCafe(prisma, { reset, password });
    console.log(`${reset && existing ? "Rebuilt" : "Created"} ${CAFE.orgName}: ${r.categories} categories, ${r.items} menu items, ${r.tables.length} tables.`);
    console.log(`Not imported (unreadable on the boards): ${UNRESOLVED.length} entries, see prisma/coders-cafe/menu.ts.`);
  }
  console.log(`\nSign-in accounts (password is not logged): ${CAFE.users.map((u) => `${u.email} (${u.role})`).join(", ")}`);
  const org = await findCafe(prisma);
  const outlet = org ? await prisma.outlet.findFirst({ where: { organizationId: org.id, code: CAFE.outletCode }, select: { id: true } }) : null;
  const rows = outlet
    ? await prisma.restaurantTable.findMany({ where: { outletId: outlet.id, code: { in: [...CAFE.tableCodes] } }, select: { code: true, qrToken: true } })
    : [];
  const productionProblem = qrBaseUrlProblem(base, "production");
  const localProblem = qrBaseUrlProblem(base, "local");
  if (localProblem) console.log(`\nBase URL cannot be used for table QR links: ${localProblem}`);
  else if (productionProblem) {
    console.log("\nTable QR links below are for this computer only — not for customer printing.");
    console.log("Set PUBLIC_BASE_URL to the public https address, then run: npm run qr:tables -- --mode production");
  } else console.log("\nPUBLIC_BASE_URL is a public https origin. Print labels with: npm run qr:tables -- --mode production");
  if (!localProblem) {
    for (const code of CAFE.tableCodes) {
      const token = rows.find((r) => r.code === code)?.qrToken;
      console.log(token ? `  ${code}  ${guestOrderingUrl(base, token)}` : `  ${code}  (no token stored)`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
