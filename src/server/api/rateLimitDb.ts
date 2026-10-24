/**
 * Rate-limit counters kept in the application database (audit SE-03), so every app instance counts against the same
 * number. Select it with RATE_LIMIT_STORE=database; the per-process store stays the default (one instance, the desktop app).
 *
 * One statement per hit: an upsert that starts a new window when the old one has ended and otherwise adds one, returning the
 * new count. It is atomic on SQLite and PostgreSQL, so concurrent requests on different instances never lose a count.
 *
 * If the database cannot be reached the limiter does not stop the request; it falls back to per-process counters for that hit
 * (so a single instance still limits) and says so in the log and in a metric. Anything that needs the database fails on its own.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { log } from "@/server/observability/log";
import { inc } from "@/server/observability/metrics";
import { MemoryRateLimitStore, type RateLimitStore } from "@/server/api/rateLimitStore";

/** Windows that ended more than this long ago are removed by the worker. */
export const RATE_LIMIT_RETENTION_MS = 60 * 60_000;

export class DatabaseRateLimitStore implements RateLimitStore {
  private readonly fallback = new MemoryRateLimitStore();
  private lastWarn = 0;
  constructor(private readonly db: PrismaClient = prisma) {}

  async hit(key: string, windowMs: number, now = Date.now()) {
    const resetAt = BigInt(now + windowMs);
    const at = BigInt(now);
    try {
      const rows = await this.db.$queryRaw<Array<{ count: number | bigint; resetAt: number | bigint }>>`
        INSERT INTO "RateLimitWindow" ("key", "count", "resetAt") VALUES (${key}, 1, ${resetAt})
        ON CONFLICT ("key") DO UPDATE SET
          "count" = CASE WHEN "RateLimitWindow"."resetAt" <= ${at} THEN 1 ELSE "RateLimitWindow"."count" + 1 END,
          "resetAt" = CASE WHEN "RateLimitWindow"."resetAt" <= ${at} THEN ${resetAt} ELSE "RateLimitWindow"."resetAt" END
        RETURNING "count", "resetAt"`;
      return { count: Number(rows[0].count), resetAt: Number(rows[0].resetAt) };
    } catch (e) {
      inc("restora_rate_limit_store_errors_total");
      if (now - this.lastWarn > 60_000) {
        this.lastWarn = now;
        log.warn("rate limit store unavailable; counting in this process only", { event: "rate_limit_store_error", error: e });
      }
      return this.fallback.hit(key, windowMs, now);
    }
  }

  async reset(key?: string) {
    await this.db.rateLimitWindow.deleteMany({ where: key ? { key } : {} });
    await this.fallback.reset(key);
  }
}

/** Remove windows that ended long ago. Returns how many. */
export async function sweepRateLimitWindows(db: PrismaClient = prisma, now = Date.now()): Promise<number> {
  return (await db.rateLimitWindow.deleteMany({ where: { resetAt: { lt: BigInt(now - RATE_LIMIT_RETENTION_MS) } } })).count;
}
