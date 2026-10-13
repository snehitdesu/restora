/**
 * Rate limiting for security-sensitive and expensive endpoints.
 *
 * Fixed-window counters behind a `RateLimitStore` interface:
 *  - MemoryRateLimitStore (default): per-process. Correct for local development,
 *    the desktop app and single-instance deployments.
 *  - DatabaseRateLimitStore (RATE_LIMIT_STORE=database): one atomic upsert per
 *    hit in the app's own database (RateLimitBucket), shared by every instance.
 *    Several instances (serverless, more than one container) each have their
 *    own memory, so per-process limits multiply by the instance count there.
 *    Only the `shared` policies (sign-in, password reset/set/change, step-up)
 *    use it; high-volume guest throttles stay per-process. A database error
 *    falls back to the per-process store for that hit (logged), so a missing
 *    table or a database blip never locks everyone out of signing in.
 *  - Any other store name (e.g. redis) fails loudly: it is not implemented.
 *
 * Env: RATE_LIMIT_DISABLED=true turns limiting off (e.g. load tests);
 *      RATE_LIMIT_STORE=memory|database.
 *
 * Client IP comes from X-Forwarded-For, which is only trustworthy behind a
 * reverse proxy. Proxies APPEND the address they saw, so the client controls
 * every entry left of the ones added by our own proxies: the IP is read
 * TRUSTED_PROXY_HOPS entries from the RIGHT (default 1 = one proxy / load
 * balancer in front of the app). Taking the leftmost entry (as before) let a
 * client pick a fresh "IP" per request, defeating the per-IP login limit and
 * flooding the store. Login is ALSO limited per email.
 */
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { log } from "@/server/observability/log";

export class RateLimitError extends Error {
  status = 429;
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message = "Too many requests") {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface RateLimitStore {
  /** Count one hit for `key` in the current window; returns the new count and window end (ms epoch). */
  hit(key: string, windowMs: number, now?: number): Promise<{ count: number; resetAt: number }>;
  reset(key?: string): Promise<void>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly maxKeys = 50_000) {}

  async hit(key: string, windowMs: number, now = Date.now()) {
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      if (this.windows.size >= this.maxKeys) this.prune(now);
      w = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    return { count: w.count, resetAt: w.resetAt };
  }

  async reset(key?: string) {
    if (key) this.windows.delete(key);
    else this.windows.clear();
  }

  private prune(now: number) {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    // Still full (a flood of distinct keys): drop the oldest half rather than grow without bound.
    if (this.windows.size >= this.maxKeys) [...this.windows.keys()].slice(0, Math.floor(this.maxKeys / 2)).forEach((k) => this.windows.delete(k));
  }
}

type BucketRow = { count: number | bigint; resetAt: number | bigint };

/**
 * Counters in the RateLimitBucket table. One statement per hit (insert, or
 * increment / start a new window), so concurrent instances never lose a count.
 * Keys are hashed: the table never holds an email address or IP.
 */
export class DatabaseRateLimitStore implements RateLimitStore {
  constructor(private readonly db: Pick<PrismaClient, "$queryRaw" | "$executeRaw">) {}

  static bucketKey(key: string): string {
    return createHash("sha256").update(key).digest("hex");
  }

  async hit(key: string, windowMs: number, now = Date.now()) {
    const id = DatabaseRateLimitStore.bucketKey(key);
    const resetAt = now + windowMs;
    const rows = await this.db.$queryRaw<BucketRow[]>`
      INSERT INTO "RateLimitBucket" ("key", "count", "resetAt") VALUES (${id}, 1, CAST(${resetAt} AS BIGINT))
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "RateLimitBucket"."resetAt" <= CAST(${now} AS BIGINT) THEN 1 ELSE "RateLimitBucket"."count" + 1 END,
        "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= CAST(${now} AS BIGINT) THEN CAST(${resetAt} AS BIGINT) ELSE "RateLimitBucket"."resetAt" END
      RETURNING "count", "resetAt"`;
    const row = rows[0];
    if (!row) throw new Error("rate limit upsert returned no row");
    return { count: Number(row.count), resetAt: Number(row.resetAt) };
  }

  async reset(key?: string) {
    if (key) await this.db.$executeRaw`DELETE FROM "RateLimitBucket" WHERE "key" = ${DatabaseRateLimitStore.bucketKey(key)}`;
    else await this.db.$executeRaw`DELETE FROM "RateLimitBucket"`;
  }
}

/** Delete windows that ended before `before` (housekeeping). Safe when the table is unused. */
export function purgeRateLimitBuckets(db: Pick<PrismaClient, "$executeRaw">, before = Date.now()): Promise<number> {
  return db.$executeRaw`DELETE FROM "RateLimitBucket" WHERE "resetAt" < CAST(${before} AS BIGINT)`;
}

/**
 * Shared store with a per-process fallback: if the database cannot count a hit
 * (table not migrated yet, connection lost), that hit is counted in memory and
 * the failure is logged at most once a minute.
 */
export class FallbackRateLimitStore implements RateLimitStore {
  private lastErrorLog = -Infinity;
  constructor(private readonly primary: RateLimitStore, private readonly fallback: RateLimitStore) {}

  async hit(key: string, windowMs: number, now = Date.now()) {
    try {
      return await this.primary.hit(key, windowMs, now);
    } catch (e) {
      if (now - this.lastErrorLog >= 60_000) {
        this.lastErrorLog = now;
        log.error("shared rate limit store failed; counting in this process only", { event: "rate_limit_store_failed", error: e instanceof Error ? e.name : "Error" });
      }
      return this.fallback.hit(key, windowMs, now);
    }
  }

  async reset(key?: string) {
    await this.fallback.reset(key);
    await this.primary.reset(key).catch(() => undefined);
  }
}

export type RateLimitStoreKind = "memory" | "database";

export function rateLimitStoreKind(env: NodeJS.ProcessEnv = process.env): RateLimitStoreKind {
  const kind = (env.RATE_LIMIT_STORE ?? "memory").trim().toLowerCase() || "memory";
  if (kind !== "memory" && kind !== "database") throw new Error(`RATE_LIMIT_STORE=${kind} is not implemented; use "memory" (single instance) or "database" (several instances)`);
  return kind;
}

let store: RateLimitStore | null = null;
let sharedStore: RateLimitStore | null = null;

/** Per-process counters: every policy that is not `shared`, and every policy in memory mode. */
export function getRateLimitStore(): RateLimitStore {
  if (store) return store;
  rateLimitStoreKind(); // an unknown store name fails here too, not only for shared policies
  store = new MemoryRateLimitStore();
  return store;
}

/** The store for `shared` policies: the database in database mode, else the per-process store. */
export async function getSharedRateLimitStore(): Promise<RateLimitStore> {
  if (sharedStore) return sharedStore;
  if (rateLimitStoreKind() === "memory") return getRateLimitStore();
  const { prisma } = await import("@/server/db/client");
  sharedStore = new FallbackRateLimitStore(new DatabaseRateLimitStore(prisma), getRateLimitStore());
  return sharedStore;
}

/** Tests only: forget the selected stores (e.g. after changing RATE_LIMIT_STORE). */
export function resetRateLimitStores(): void {
  store = null;
  sharedStore = null;
}

/**
 * `shared`: counted in the shared store in database mode — the limits that
 * protect accounts (guessing passwords, flooding reset links).
 */
export type RatePolicy = { name: string; limit: number; windowMs: number; shared?: boolean };

export const RATE_POLICIES = {
  loginPerEmail: { name: "login-email", limit: 10, windowMs: 15 * 60_000, shared: true },
  loginPerIp: { name: "login-ip", limit: 50, windowMs: 60_000, shared: true },
  passwordResetPerEmail: { name: "pwreset-email", limit: 5, windowMs: 60 * 60_000, shared: true },
  passwordResetPerIp: { name: "pwreset-ip", limit: 20, windowMs: 15 * 60_000, shared: true },
  passwordCompletePerIp: { name: "pwcomplete-ip", limit: 20, windowMs: 15 * 60_000, shared: true },
  passwordChangePerUser: { name: "pwchange-user", limit: 10, windowMs: 15 * 60_000, shared: true },
  reauthPerUser: { name: "reauth-user", limit: 30, windowMs: 15 * 60_000, shared: true },
  webhook: { name: "webhook", limit: 600, windowMs: 60_000 },
  export: { name: "export", limit: 20, windowMs: 60_000 },
  report: { name: "report", limit: 120, windowMs: 60_000 },
  // Calls that reach an external provider or device (test connection / test print / test message).
  integrationAction: { name: "integration-action", limit: 30, windowMs: 60_000 },
  // Guest QR ordering (anonymous). Guests behind restaurant Wi-Fi share one IP,
  // so per-IP limits are generous; order placement is also capped per table.
  guestReadPerIp: { name: "guest-read-ip", limit: 600, windowMs: 60_000 },
  guestWritePerIp: { name: "guest-write-ip", limit: 60, windowMs: 60_000 },
  guestOrderPerTable: { name: "guest-order-table", limit: 20, windowMs: 10 * 60_000 },
  // Cart re-pricing (read-only POST): several guests on one café Wi-Fi share an IP.
  guestQuotePerIp: { name: "guest-quote-ip", limit: 240, windowMs: 60_000 },
} satisfies Record<string, RatePolicy>;

export function trustedProxyHops(): number {
  const n = Number(process.env.TRUSTED_PROXY_HOPS ?? 1);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 1;
}

export function clientIp(req: NextRequest | Request, hops = trustedProxyHops()): string {
  const chain = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // The entry added by the outermost trusted proxy; if the chain is shorter than
  // expected (misconfigured / no proxy), fall back to its first entry.
  const ip = chain.length ? chain[Math.max(0, chain.length - hops)] : req.headers.get("x-real-ip")?.trim();
  return (ip || "unknown").slice(0, 64);
}

/** Count a hit and throw RateLimitError (429 + Retry-After) when over the limit. */
export async function enforceRateLimit(policy: RatePolicy, key: string, now = Date.now()): Promise<void> {
  if (process.env.RATE_LIMIT_DISABLED === "true") return;
  const s = policy.shared ? await getSharedRateLimitStore() : getRateLimitStore();
  const { count, resetAt } = await s.hit(`${policy.name}:${key}`, policy.windowMs, now);
  if (count > policy.limit) throw new RateLimitError(Math.max(1, Math.ceil((resetAt - now) / 1000)));
}
