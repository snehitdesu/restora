/**
 * Read-only report: which tables still carry a guessable QR token.
 *
 *   npm run qr:audit
 *
 * For every table in DATABASE_URL it prints organization, outlet, table code
 * and one class, never the token itself:
 *   legacy-derivable  the hash of public constants the demo seed stored before
 *                     2026-10-20 (anyone with the source can compute it)
 *   random            24-character base64url, the shape newTableQrToken issues
 *   nonstandard       any other stored value (hand-set, load-test, fixture)
 *   none              no QR issued (revoked or never issued)
 * Exit code 2 when any legacy-derivable or nonstandard token is live, so the
 * rotation runbook (docs/qr-token-rotation.md) can gate on it. Writes nothing.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { legacyCafeTableToken } from "../../prisma/coders-cafe/seed";

export type TokenClass = "legacy-derivable" | "random" | "nonstandard" | "none";

export function classifyTableToken(code: string, token: string | null): TokenClass {
  if (!token) return "none";
  if (token === legacyCafeTableToken(code)) return "legacy-derivable";
  if (/^[A-Za-z0-9_-]{24}$/.test(token)) return "random";
  return "nonstandard";
}

export type TokenAuditRow = { organization: string; outlet: string; code: string; class: TokenClass };

export async function auditTableTokens(db: PrismaClient): Promise<TokenAuditRow[]> {
  const [tables, outlets] = await Promise.all([
    db.restaurantTable.findMany({ select: { outletId: true, code: true, qrToken: true }, orderBy: [{ organizationId: "asc" }, { outletId: "asc" }, { code: "asc" }] }),
    db.outlet.findMany({ select: { id: true, code: true, organization: { select: { name: true } } } }),
  ]);
  const byId = new Map(outlets.map((o) => [o.id, o]));
  return tables.map((t) => {
    const o = byId.get(t.outletId);
    return { organization: o?.organization.name ?? "?", outlet: o?.code ?? "?", code: t.code, class: classifyTableToken(t.code, t.qrToken) };
  });
}

async function main() {
  try {
    const rows = await auditTableTokens(prisma);
    for (const r of rows) process.stdout.write(`${r.organization}\t${r.outlet}\t${r.code}\t${r.class}\n`);
    const count = (c: TokenClass) => rows.filter((r) => r.class === c).length;
    process.stdout.write(`\n${rows.length} tables: ${count("random")} random, ${count("legacy-derivable")} legacy-derivable, ${count("nonstandard")} nonstandard, ${count("none")} without a QR\n`);
    if (count("legacy-derivable") || count("nonstandard")) process.exitCode = 2;
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
