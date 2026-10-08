/**
 * Closed business days (proposal module 06; group 3).
 *
 * A day is closed while its latest DayClose revision is CLOSED. Writes that
 * are dated INTO a closed day (declared sales, the payments reconciliation,
 * back-dated manual sales, worksheet entries, wastage, petty cash and expenses
 * dated that day) are refused with 409: a closed day is never changed
 * silently. The correction path is reopening the day (moneyDesk.reopenDay),
 * which is audited and requires a new close.
 *
 * Orders and payments are never blocked (service must not stop); anything
 * they change after the close shows on the money desk as "changed since close".
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { type AccessContext, ConflictError } from "@/server/db/scope";
import { outletBusinessDay, type BusinessDateInput } from "@/server/services/businessDay";

type Db = PrismaClient | Prisma.TransactionClient;

/** Latest close revision for an outlet business day (null = never closed). */
export async function latestDayClose(db: Db, ctx: AccessContext, outletId: string, businessDate: BusinessDateInput) {
  const day = await outletBusinessDay(db, ctx, outletId, businessDate);
  const row = await db.dayClose.findFirst({
    where: { organizationId: ctx.organizationId, outletId, businessDate: day.key },
    orderBy: { revision: "desc" },
  });
  return { day, close: row };
}

/** Refuse a write dated into a closed business day. `at` is an instant or a "YYYY-MM-DD" business date. */
export async function assertDayOpen(db: Db, ctx: AccessContext, outletId: string, at: BusinessDateInput, what: string) {
  const { day, close } = await latestDayClose(db, ctx, outletId, at);
  if (close?.status === "CLOSED") {
    throw new ConflictError(`Business day ${day.date} is closed, so ${what} cannot change it. Reopen the day on the money desk to make a correction.`);
  }
  return day;
}
