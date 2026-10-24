/**
 * The guest-menu screenshot's table token. Issued like any real token (random,
 * src/server/qr/tableToken.ts), never a constant from source: a fixed token
 * would be guessable by anyone who reads the repository. The guest path is
 * written to a gitignored file for scripts/site/capture-screens.mjs instead of
 * being printed, so it does not end up in terminal logs.
 */
import fs from "node:fs";
import path from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { issueTableQrToken } from "@/server/qr/tableToken";
import { GUEST_PATH_FILE } from "./guest-path.mjs";

/** Gitignored (/artifacts/table-qr/). Read by capture-screens.mjs through guest-path.mjs. */
export const SITE_DEMO_GUEST_PATH_FILE = GUEST_PATH_FILE;

export async function assignSiteDemoQrToken(db: PrismaClient | Prisma.TransactionClient, tableId: string, file = GUEST_PATH_FILE): Promise<string> {
  const qrToken = await issueTableQrToken(db);
  await db.restaurantTable.update({ where: { id: tableId }, data: { qrToken } });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `/t/${qrToken}\n`);
  return file;
}
