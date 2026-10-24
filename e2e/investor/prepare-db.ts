/**
 * Builds the investor E2E database from scratch (prisma/e2e-investor.db):
 * the committed migration history, the Coders' Cafe dataset (real menu,
 * T01–T10, role users) and the bank merchant binding an operator would
 * create in Settings → Integrations (bank callbacks are bound to the tenant
 * by the merchant id; here the test bank emulator's). Run by playwright.investor.config.ts before
 * `next start`; dev.db is never touched.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = path.join(process.cwd(), "prisma", "e2e-investor.db");

async function main() {
  for (const s of ["", "-journal", "-wal", "-shm"]) if (fs.existsSync(DB_PATH + s)) fs.rmSync(DB_PATH + s);
  const url = `file:${DB_PATH.replace(/\\/g, "/")}`;
  process.env.DATABASE_URL = url;
  execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });

  const { prisma } = await import("@/server/db/client");
  const { seedCodersCafe } = await import("../../prisma/coders-cafe/seed");
  const cafe = await seedCodersCafe(prisma);
  const merchant = process.env.UPI_EMULATOR_MERCHANT_ID;
  if (!merchant) throw new Error("UPI_EMULATOR_MERCHANT_ID is required (playwright.investor.config.ts)");
  await prisma.integrationConnection.create({ data: { organizationId: cafe.organizationId, outletId: cafe.outletId, kind: "PAYMENT", provider: "upi_emulator", externalRef: merchant, status: "CONNECTED", mode: "MOCK" } });
  console.log(`investor e2e: Coders' Cafe ${cafe.items} items, ${cafe.tables.length} tables, test bank merchant bound`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
