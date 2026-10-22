/**
 * Read-only report: which tables still carry a guessable QR token.
 *
 *   npm run qr:audit
 *
 * For every table in DATABASE_URL (and every outlet's common QR, as the row
 * "(restaurant QR)") it prints organization, outlet, table code and one class,
 * never the token itself:
 *   legacy-derivable  computable by anyone with the source: the Coders' Cafe
 *                     hash of public constants the seed stored before
 *                     2026-10-20, or the demo seed's "<outlet>-<table>" value
 *                     stored before 2026-10-05
 *   random            24-character base64url, the shape newTableQrToken issues
 *   nonstandard       any other stored value (hand-set, load-test, fixture)
 *   none              no QR issued (revoked or never issued)
 * Exit code 2 when any legacy-derivable or nonstandard token is live, so the
 * rotation runbook (docs/qr-token-rotation.md) can gate on it; 3 when the
 * database holds no tables at all (almost always the wrong DATABASE_URL, so
 * never a clean result); 1 on an error. Writes nothing.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { legacyCafeTableToken } from "../../prisma/coders-cafe/seed";

export type TokenClass = "legacy-derivable" | "random" | "nonstandard" | "none";

export function classifyTableToken(code: string, token: string | null, outletCode?: string): TokenClass {
  if (!token) return "none";
  if (token === legacyCafeTableToken(code)) return "legacy-derivable";
  if (outletCode && token === `${outletCode}-${code}`) return "legacy-derivable";
  if (/^[A-Za-z0-9_-]{24}$/.test(token)) return "random";
  return "nonstandard";
}

export type TokenAuditRow = { organization: string; outlet: string; code: string; class: TokenClass };

/** Row code of an outlet's common QR (one code for every table) in the report. */
export const COMMON_QR_ROW = "(restaurant QR)";

export async function auditTableTokens(db: PrismaClient): Promise<TokenAuditRow[]> {
  const [tables, outlets] = await Promise.all([
    db.restaurantTable.findMany({ select: { outletId: true, code: true, qrToken: true }, orderBy: [{ organizationId: "asc" }, { outletId: "asc" }, { code: "asc" }] }),
    db.outlet.findMany({ select: { id: true, code: true, organization: { select: { name: true } } } }),
  ]);
  const byId = new Map(outlets.map((o) => [o.id, o]));
  const rows: TokenAuditRow[] = tables.map((t) => {
    const o = byId.get(t.outletId);
    return { organization: o?.organization.name ?? "?", outlet: o?.code ?? "?", code: t.code, class: classifyTableToken(t.code, t.qrToken, o?.code) };
  });
  // Outlets' common QR codes. A database still on an older release has no such column
  // (Prisma P2022): there is nothing to audit then, and the table rows above still count.
  try {
    const common = await db.outlet.findMany({ where: { guestQrToken: { not: null } }, select: { code: true, guestQrToken: true, organization: { select: { name: true } } }, orderBy: [{ organizationId: "asc" }, { code: "asc" }] });
    for (const o of common) rows.push({ organization: o.organization.name, outlet: o.code, code: COMMON_QR_ROW, class: classifyTableToken(COMMON_QR_ROW, o.guestQrToken, o.code) });
  } catch (e) {
    if ((e as { code?: string }).code !== "P2022") throw e;
  }
  return rows;
}

/** 0 = audited and nothing derivable; 2 = a derivable / nonstandard token is live; 3 = nothing to audit. */
export function auditExitCode(rows: TokenAuditRow[]): 0 | 2 | 3 {
  if (rows.length === 0) return 3;
  return rows.some((r) => r.class === "legacy-derivable" || r.class === "nonstandard") ? 2 : 0;
}

async function main() {
  try {
    const rows = await auditTableTokens(prisma);
    for (const r of rows) process.stdout.write(`${r.organization}\t${r.outlet}\t${r.code}\t${r.class}\n`);
    const count = (c: TokenClass) => rows.filter((r) => r.class === c).length;
    process.stdout.write(`\n${rows.length} tables: ${count("random")} random, ${count("legacy-derivable")} legacy-derivable, ${count("nonstandard")} nonstandard, ${count("none")} without a QR\n`);
    process.exitCode = auditExitCode(rows);
    if (process.exitCode === 3) process.stderr.write("No tables found: check DATABASE_URL points at the restaurant's database. Nothing was audited.\n");
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  void main();
}
