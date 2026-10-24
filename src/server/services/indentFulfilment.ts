/**
 * What the store has dispatched against an indent (audit PP-08, proposal p. 5: "the store dispatches an indent; stock moves
 * department to department"). An issue may name the approved indent it fulfils; this is the arithmetic that keeps the two
 * honest: per material, what was asked, what posted issues have moved, what is still owed — all in base units, so a line
 * asked in packs and issued in kilos still adds up.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { type AccessContext } from "@/server/db/scope";
import { D, num, qty as roundQty } from "@/domain/money";
import { toBaseUnits } from "@/server/services/inventory";
import type { Client } from "@/server/services/_workflow";

export type FulfilmentLine = { materialId: string; requested: number; issued: number; outstanding: number; baseUnitId: string | null };
export type Fulfilment = { lines: FulfilmentLine[]; complete: boolean; issues: Array<{ id: string; number: string; status: string; issuedAt: string | null }> };

type Db = PrismaClient | Prisma.TransactionClient | Client;

/**
 * Per material, in base units: asked on the indent, moved by issues already posted against it, still outstanding.
 * `extra` adds a draft's lines to what has been issued (to check an issue before it is saved or posted).
 */
export async function indentFulfilment(db: Db, ctx: AccessContext, indentId: string, extra: Array<{ materialId: string; qty: Prisma.Decimal | number | string; unitId?: string | null }> = []): Promise<Fulfilment> {
  const client = db as PrismaClient;
  const [lines, issues] = await Promise.all([
    client.purchaseIndentLine.findMany({ where: { indentId, organizationId: ctx.organizationId } }),
    client.inventoryIssue.findMany({ where: { indentId, organizationId: ctx.organizationId, status: { not: "CANCELLED" } }, include: { lines: true }, orderBy: { createdAt: "asc" } }),
  ]);
  const requested = new Map<string, { qty: Prisma.Decimal; baseUnitId: string | null }>();
  for (const l of lines) {
    const b = await toBaseUnits(db as Client, ctx, l.materialId, l.qty, l.unitId);
    const cur = requested.get(l.materialId);
    requested.set(l.materialId, { qty: (cur?.qty ?? D(0)).plus(b.qty), baseUnitId: b.baseUnitId });
  }
  const issued = new Map<string, Prisma.Decimal>();
  for (const i of issues) {
    if (i.status !== "ISSUED") continue; // a draft moves nothing yet
    for (const l of i.lines) issued.set(l.materialId, (issued.get(l.materialId) ?? D(0)).plus((await toBaseUnits(db as Client, ctx, l.materialId, l.qty, l.unitId)).qty));
  }
  for (const l of extra) issued.set(l.materialId, (issued.get(l.materialId) ?? D(0)).plus((await toBaseUnits(db as Client, ctx, l.materialId, l.qty, l.unitId)).qty));
  const out: FulfilmentLine[] = [...requested.entries()].map(([materialId, r]) => {
    const done = issued.get(materialId) ?? D(0);
    const left = r.qty.minus(done);
    return { materialId, requested: num(roundQty(r.qty)), issued: num(roundQty(done)), outstanding: num(roundQty(left.gt(0) ? left : D(0))), baseUnitId: r.baseUnitId };
  });
  return {
    lines: out,
    complete: out.length > 0 && out.every((l) => l.outstanding <= 0),
    issues: issues.map((i) => ({ id: i.id, number: i.number, status: i.status, issuedAt: i.issuedAt?.toISOString() ?? null })),
  };
}
