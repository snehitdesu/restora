/**
 * Write Coders' Cafe table QR labels from the tokens already stored in the database.
 *
 *   npm run qr:tables
 *   npm run qr:tables -- --base-url http://localhost:3000
 *   npm run qr:tables -- --mode production --base-url https://pos.example.com
 *
 * Local mode (the default on this computer) writes a sheet marked
 * NOT FOR CUSTOMER PRINTING. Production mode refuses localhost, private
 * addresses, and any URL that is not public https, and it writes nothing
 * when the URL is refused. Tokens are not created or rotated here.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { CAFE, findCafe } from "../../prisma/coders-cafe/seed";
import {
  CAFE_TABLE_CODES,
  QR_CLI_HELP,
  TableQrError,
  buildTableQrPack,
  parseQrArgs,
  qrBaseUrlProblem,
  writeTableQrFiles,
  type QrEnvironment,
  type TableQrPack,
} from "@/server/qr/tableLabels";

export async function loadCafeTableRows(db: PrismaClient): Promise<Array<{ code: string; qrToken: string | null }>> {
  const org = await findCafe(db);
  if (!org) throw new TableQrError(`${CAFE.orgName} is not in this database. Seed it with npm run db:seed:cafe. No QR codes were generated.`);
  const outlet = await db.outlet.findFirst({ where: { organizationId: org.id, code: CAFE.outletCode }, select: { id: true } });
  if (!outlet) throw new TableQrError(`${CAFE.orgName} has no ${CAFE.outletCode} outlet. No QR codes were generated.`);
  return db.restaurantTable.findMany({
    where: { organizationId: org.id, outletId: outlet.id, code: { in: [...CAFE_TABLE_CODES] } },
    select: { code: true, qrToken: true },
    orderBy: { code: "asc" },
  });
}

export async function runQrGenerate(argv: string[], db: PrismaClient, env: QrEnvironment = process.env): Promise<{ help: true } | { help: false; dir: string; pack: TableQrPack }> {
  const opts = parseQrArgs(argv, env);
  if (opts.help) return { help: true };
  // Refuse a bad production URL before reading tokens or writing files.
  const problem = qrBaseUrlProblem(opts.baseUrl, opts.mode);
  if (problem) throw new TableQrError(problem);
  const rows = await loadCafeTableRows(db);
  const pack = buildTableQrPack({
    mode: opts.mode,
    baseUrl: opts.baseUrl,
    restaurantName: CAFE.orgName,
    tables: rows,
    expectedCodes: CAFE.tableCodes,
  });
  const dir = writeTableQrFiles(opts.outDir, pack);
  return { help: false, dir, pack };
}

function report(result: { help: true } | { help: false; dir: string; pack: TableQrPack }) {
  if (result.help) {
    process.stdout.write(`${QR_CLI_HELP}\n`);
    return;
  }
  const { pack, dir } = result;
  process.stdout.write(`${CAFE.orgName} table QR — ${pack.mode} mode\n`);
  process.stdout.write(`printReady: ${pack.printReady}\n`);
  process.stdout.write(`${pack.labels.length} labels written to ${dir}\n`);
  if (!pack.printReady) process.stdout.write(`${pack.notice}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  try {
    const result = await runQrGenerate(argv, prisma);
    report(result);
  } catch (e) {
    process.stderr.write(`${e instanceof TableQrError ? e.message : e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  void main();
}
