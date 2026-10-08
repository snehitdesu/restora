/**
 * Group 3 money desk: two managers close the same business day at the same
 * moment. Exactly one close may be recorded (revision 1, one audit row, the
 * reconciliations completed once); the other request gets 409 and changes
 * nothing. Started together and awaited with Promise.allSettled: on PostgreSQL
 * these are concurrent SERIALIZABLE transactions on separate connections (the
 * loser is aborted and retried, then sees the close, or hits the unique
 * revision); on SQLite the single writer serializes them. Same for two
 * simultaneous reopens.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { type AccessContext, ConflictError } from "@/server/db/scope";
import { closeDay, declareSales, reopenDay } from "@/server/services/moneyDesk";
import { saveDailyReconciliation } from "@/server/services/finance";
import { businessDayRange } from "@/domain/time";

const onPostgres = /^postgres(ql)?:/.test(process.env.DATABASE_URL ?? "");
const RUN = Date.now().toString(36);
const TZ = "Asia/Kolkata";
let orgId: string, A: string;
let alice: AccessContext, bob: AccessContext;
const member = (userId: string): AccessContext => ({ userId, organizationId: orgId, outletIds: [A], roles: ["MANAGER"], outletRoles: { [A]: ["MANAGER"] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });
const today = () => businessDayRange(new Date(), TZ).date;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Close conc ${RUN}`, timezone: TZ } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `CC${RUN}`, name: "CC", timezone: TZ } })).id;
  alice = member(`alice-${RUN}`);
  bob = member(`bob-${RUN}`);
  await declareSales(alice, { outletId: A, businessDate: today(), declared: [{ channel: "DINE_IN", amount: 0 }] });
  await saveDailyReconciliation(alice, { outletId: A, businessDate: today(), actuals: [{ method: "CASH", actual: 0 }] });
});

afterAll(async () => { await prisma.$disconnect(); });

function oneWinner(results: PromiseSettledResult<unknown>[]) {
  const ok = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  expect(ok).toHaveLength(1);
  expect(failed).toHaveLength(1);
  expect(failed[0].reason).toBeInstanceOf(ConflictError);
  expect((failed[0].reason as ConflictError).status).toBe(409);
}

describe(`concurrent day close (${onPostgres ? "PostgreSQL" : "SQLite"})`, () => {
  it("two simultaneous closes: one DayClose revision, one audit row, the other request is 409", async () => {
    const results = await Promise.allSettled([closeDay(alice, { outletId: A, businessDate: today() }), closeDay(bob, { outletId: A, businessDate: today() })]);
    oneWinner(results);
    const closes = await prisma.dayClose.findMany({ where: { outletId: A } });
    expect(closes.map((c) => [c.revision, c.status])).toEqual([[1, "CLOSED"]]);
    expect(await prisma.auditLog.count({ where: { entityType: "DayClose", outletId: A, action: "APPROVE" } })).toBe(1);
    const recons = await prisma.reconciliation.findMany({ where: { outletId: A } });
    expect(recons.map((r) => r.status)).toEqual(["COMPLETED", "COMPLETED"]);
    expect(await prisma.auditLog.count({ where: { entityType: "Reconciliation", outletId: A, action: "APPROVE" } })).toBe(2);
  });

  it("two simultaneous reopens: one succeeds, the other is 409; then one close makes revision 2", async () => {
    const results = await Promise.allSettled([
      reopenDay(alice, { outletId: A, businessDate: today(), reason: "count correction one" }),
      reopenDay(bob, { outletId: A, businessDate: today(), reason: "count correction two" }),
    ]);
    oneWinner(results);
    expect(await prisma.auditLog.count({ where: { entityType: "DayClose", outletId: A, action: "UPDATE" } })).toBe(1);
    const again = await Promise.allSettled([closeDay(alice, { outletId: A, businessDate: today() }), closeDay(bob, { outletId: A, businessDate: today() })]);
    oneWinner(again);
    const closes = await prisma.dayClose.findMany({ where: { outletId: A }, orderBy: { revision: "asc" } });
    expect(closes.map((c) => [c.revision, c.status])).toEqual([[1, "REOPENED"], [2, "CLOSED"]]);
  });
});
