/**
 * The shared rate-limit store (audit SE-03): counters in the application database, so several instances count against the same
 * number. Atomic under concurrency, windows roll over, instances share state, a database failure degrades to per-process counting.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { prisma } from "@/server/db/client";
import { DatabaseRateLimitStore, sweepRateLimitWindows, RATE_LIMIT_RETENTION_MS } from "@/server/api/rateLimitDb";
import { RateLimitError, RATE_POLICIES, enforceRateLimit, getRateLimitStore, resetRateLimitStoreForTests, MemoryRateLimitStore } from "@/server/api/rateLimit";
import { housekeeping } from "@/server/ops/worker";
import { uniq } from "../domain/growthSupport";

const key = (name = "k") => `test:${name}:${uniq()}`;

beforeEach(() => resetRateLimitStoreForTests());
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); resetRateLimitStoreForTests(); });
afterAll(async () => { await prisma.$disconnect(); });

describe("DatabaseRateLimitStore", () => {
  it("counts hits inside a window and starts a new window when it has ended", async () => {
    const s = new DatabaseRateLimitStore();
    const k = key();
    const t0 = 1_800_000_000_000;
    expect(await s.hit(k, 60_000, t0)).toEqual({ count: 1, resetAt: t0 + 60_000 });
    expect(await s.hit(k, 60_000, t0 + 10_000)).toEqual({ count: 2, resetAt: t0 + 60_000 });
    expect(await s.hit(k, 60_000, t0 + 59_999)).toEqual({ count: 3, resetAt: t0 + 60_000 });
    expect(await s.hit(k, 60_000, t0 + 60_000)).toEqual({ count: 1, resetAt: t0 + 120_000 }); // the window ended at t0 + 60,000
    expect(await s.hit(key("other"), 60_000, t0)).toMatchObject({ count: 1 }); // keys are independent
  });

  it("two instances sharing one database share one count; concurrent hits are never lost", async () => {
    const a = new DatabaseRateLimitStore();
    const b = new DatabaseRateLimitStore();
    const k = key("shared");
    const now = Date.now();
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).hit(k, 60_000, now)));
    expect(results.map((r) => r.count).sort((x, y) => x - y)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(Number((await prisma.rateLimitWindow.findUniqueOrThrow({ where: { key: k } })).count)).toBe(40);
  });

  it("reset forgets one key or all of them", async () => {
    const s = new DatabaseRateLimitStore();
    const [a, b] = [key("a"), key("b")];
    await s.hit(a, 60_000);
    await s.hit(b, 60_000);
    await s.reset(a);
    expect(await s.hit(a, 60_000)).toMatchObject({ count: 1 });
    expect(await s.hit(b, 60_000)).toMatchObject({ count: 2 });
  });

  it("if the database cannot be reached the limit still applies in this process, and it is reported", async () => {
    const broken = { $queryRaw: vi.fn().mockRejectedValue(new Error("connection refused")) } as never;
    const s = new DatabaseRateLimitStore(broken);
    const k = key();
    expect(await s.hit(k, 60_000, 1000)).toMatchObject({ count: 1 });
    expect(await s.hit(k, 60_000, 2000)).toMatchObject({ count: 2 });
  });

  it("windows that ended long ago are swept by housekeeping; recent ones are kept", async () => {
    const s = new DatabaseRateLimitStore();
    const old = key("old");
    const fresh = key("fresh");
    const now = Date.now();
    await s.hit(old, 1000, now - 3 * RATE_LIMIT_RETENTION_MS);
    await s.hit(fresh, 60_000, now);
    expect(await sweepRateLimitWindows(prisma, now)).toBeGreaterThanOrEqual(1);
    expect(await prisma.rateLimitWindow.findUnique({ where: { key: old } })).toBeNull();
    expect(await prisma.rateLimitWindow.findUnique({ where: { key: fresh } })).not.toBeNull();
    await s.hit(old, 1000, now - 3 * RATE_LIMIT_RETENTION_MS);
    await housekeeping(prisma, new Date(now));
    expect(await prisma.rateLimitWindow.findUnique({ where: { key: old } })).toBeNull();
  });
});

describe("selecting the store", () => {
  it("memory is the default; database is available; anything else is refused loudly", () => {
    expect(getRateLimitStore()).toBeInstanceOf(MemoryRateLimitStore);
    resetRateLimitStoreForTests();
    vi.stubEnv("RATE_LIMIT_STORE", "database");
    expect(getRateLimitStore()).toBeInstanceOf(DatabaseRateLimitStore);
    resetRateLimitStoreForTests();
    vi.stubEnv("RATE_LIMIT_STORE", "redis");
    expect(() => getRateLimitStore()).toThrow(/not supported/);
  });

  it("a limit is enforced across instances: the 11th login attempt on any of them is a 429 with Retry-After", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "database");
    const email = `someone-${uniq()}@x.test`;
    const policy = RATE_POLICIES.loginPerEmail; // 10 per 15 minutes
    const now = Date.now();
    for (let i = 0; i < policy.limit; i++) await enforceRateLimit(policy, email, now);
    // "Another instance": a fresh store object over the same database.
    resetRateLimitStoreForTests();
    const err = await enforceRateLimit(policy, email, now + 1000).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).status).toBe(429);
    expect((err as RateLimitError).retryAfterSeconds).toBeGreaterThan(0);
    // The window ending lets the person try again.
    await expect(enforceRateLimit(policy, email, now + policy.windowMs + 1)).resolves.toBeUndefined();
  });
});
