/**
 * Authentication / authorization matrix over the real HTTP route handlers.
 *
 *  - Every staff role × a set of protected endpoints: allowed exactly when the
 *    role holds the permission the endpoint needs (403 otherwise). The required
 *    permission per endpoint is written here by hand, from the services, so a
 *    route that forgets its check (or checks the wrong permission) fails.
 *  - Outlet scope: a role held at outlet A gives nothing at outlet B.
 *  - Organization scope: another organization's owner never sees this one.
 *  - Session states: none, forged, revoked, expired, idle, deactivated user,
 *    role removed mid-session (the next request already lacks the permission).
 *  - Sign-in replaces the browser's previous session.
 *  - The shared (database) rate-limit store: atomic counting, windows, hashing,
 *    fallback, configuration.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

// The sign-in route sets its cookie through next/headers, which needs Next's
// request scope; calling the handler directly has none. Record what it sets.
const setCookies = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: (name: string, value: string) => void setCookies.set(name, value),
    get: (name: string) => (setCookies.has(name) ? { name, value: setCookies.get(name)! } : undefined),
  }),
}));
import { prisma } from "@/server/db/client";
import { createSession, validateToken, hashToken } from "@/server/auth/session";
import { hashPassword } from "@/server/auth/password";
import { loginWithPassword } from "@/server/auth/login";
import { SESSION_COOKIE } from "@/constants/auth";
import { ROLE_PERMISSIONS, type Permission } from "@/server/auth/rbac";
import type { Role } from "@/constants/enums";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import {
  DatabaseRateLimitStore,
  FallbackRateLimitStore,
  MemoryRateLimitStore,
  RATE_POLICIES,
  enforceRateLimit,
  getRateLimitStore,
  purgeRateLimitBuckets,
  rateLimitStoreKind,
  resetRateLimitStores,
  RateLimitError,
} from "@/server/api/rateLimit";
import { productionEnvWarnings, validateProductionEnv } from "@/server/config/env";
import * as Orders from "@/app/api/orders/[[...path]]/route";
import * as Kitchen from "@/app/api/kitchen/[[...path]]/route";
import * as Finance from "@/app/api/finance/[[...path]]/route";
import * as Inventory from "@/app/api/inventory/[[...path]]/route";
import * as Procurement from "@/app/api/procurement/[[...path]]/route";
import * as Staff from "@/app/api/staff/[[...path]]/route";
import * as Customers from "@/app/api/customers/[[...path]]/route";
import * as Audit from "@/app/api/audit/[[...path]]/route";
import * as Menu from "@/app/api/menu/[[...path]]/route";
import * as Recipes from "@/app/api/recipes/[[...path]]/route";
import * as Integrations from "@/app/api/integrations/[[...path]]/route";
import * as Master from "@/app/api/master/[[...path]]/route";
import * as Anomalies from "@/app/api/anomalies/[[...path]]/route";
import * as Reservations from "@/app/api/reservations/[[...path]]/route";
import * as Exports from "@/app/api/exports/[[...path]]/route";

const RUN = Date.now().toString(36);
const PASSWORD = "Matrix#Pass42";

type Mod = Record<string, (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>;
async function call(module: object, method: string, path: string, opts: { token?: string; query?: Record<string, string> } = {}) {
  const url = new URL(`http://localhost/api/x/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { host: "localhost" };
  if (opts.token) headers.cookie = `${SESSION_COOKIE}=${opts.token}`;
  const req = new NextRequest(url, { method, headers });
  const res = await (module as unknown as Mod)[method](req, { params: Promise.resolve({ path: path ? path.split("/") : undefined }) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json };
}

/** Endpoint, the permission its service requires, and whether it is read per outlet (?outletId=). */
type Endpoint = { name: string; mod: object; path: string; perm: Permission; outlet: boolean };
const ENDPOINTS: Endpoint[] = [
  { name: "orders", mod: Orders, path: "", perm: "order.view", outlet: true },
  { name: "kitchen tickets", mod: Kitchen, path: "kots", perm: "kot.view", outlet: true },
  { name: "payments", mod: Finance, path: "payments", perm: "finance.view", outlet: true },
  { name: "stock", mod: Inventory, path: "stock", perm: "inventory.view", outlet: true },
  { name: "purchase orders", mod: Procurement, path: "purchase-orders", perm: "purchase.view", outlet: true },
  { name: "reservations", mod: Reservations, path: "", perm: "reservation.manage", outlet: true },
  { name: "staff", mod: Staff, path: "", perm: "staff.manage", outlet: false },
  { name: "customers", mod: Customers, path: "", perm: "customer.view", outlet: false },
  { name: "audit log", mod: Audit, path: "", perm: "audit.view", outlet: false },
  { name: "menu", mod: Menu, path: "", perm: "menu.view", outlet: false },
  { name: "recipes", mod: Recipes, path: "", perm: "recipe.view", outlet: false },
  { name: "integrations", mod: Integrations, path: "", perm: "integration.manage", outlet: false },
  { name: "materials", mod: Master, path: "materials", perm: "master.view", outlet: false },
  { name: "anomalies", mod: Anomalies, path: "", perm: "anomaly.view", outlet: false },
  { name: "exports", mod: Exports, path: "", perm: "export.run", outlet: false },
];

const ORG_ROLES: Role[] = ["OWNER", "ADMIN", "AREA_MANAGER"];
const OUTLET_ROLES: Role[] = ["MANAGER", "CASHIER", "KITCHEN", "CAPTAIN", "STORE", "ACCOUNTANT", "CUSTOMER"];
const ALL_ROLES = [...ORG_ROLES, ...OUTLET_ROLES];

let orgId: string, outletA: string, outletB: string;
const tokens = {} as Record<Role, string>;
let foreignOwner: string;
let orgCustomerId: string;

async function staff(org: string, tag: string, role: string, outletId: string | null, password?: string) {
  const u = await prisma.user.create({ data: { organizationId: org, email: `${tag}-${RUN}@matrix.test`, name: tag, passwordHash: password ? await hashPassword(password) : "x" } });
  await prisma.membership.create({ data: { organizationId: org, userId: u.id, outletId, role } });
  return u;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Matrix Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `MA${RUN}`, name: "A" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `MB${RUN}`, name: "B" } })).id;
  for (const role of ALL_ROLES) {
    const u = await staff(orgId, role.toLowerCase(), role, ORG_ROLES.includes(role) ? null : outletA);
    tokens[role] = (await createSession(prisma, u.id)).token;
  }
  const org2 = (await prisma.organization.create({ data: { name: `Matrix Org2 ${RUN}` } })).id;
  await prisma.outlet.create({ data: { organizationId: org2, code: `MZ${RUN}`, name: "Z" } });
  foreignOwner = (await createSession(prisma, (await staff(org2, "foreign", "OWNER", null)).id)).token;
  orgCustomerId = (await prisma.customer.create({ data: { organizationId: orgId, name: `Matrix Guest ${RUN}`, phone: `98${Date.now().toString().slice(-8)}` } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("role × endpoint authorization (server-side, real routes)", () => {
  const cases = ALL_ROLES.flatMap((role) => ENDPOINTS.map((ep) => ({ role, ep, allowed: ROLE_PERMISSIONS[role].includes(ep.perm) })));
  it.each(cases.map((c) => [c.role, c.ep.name, c.allowed ? "allowed" : "denied", c] as const))("%s → %s: %s", async (_r, _n, _a, c) => {
    const res = await call(c.ep.mod, "GET", c.ep.path, { token: tokens[c.role], query: c.ep.outlet ? { outletId: outletA } : {} });
    if (c.allowed) expect(res.status, JSON.stringify(res.json?.error)).toBe(200);
    else expect(res.status, JSON.stringify(res.json?.error)).toBe(403);
  });
});

describe("outlet scope: a role at outlet A gives nothing at outlet B", () => {
  const cases = OUTLET_ROLES.flatMap((role) => ENDPOINTS.filter((e) => e.outlet).map((ep) => ({ role, ep })));
  it.each(cases.map((c) => [c.role, c.ep.name, c] as const))("%s at A → %s of outlet B is refused", async (_r, _n, c) => {
    const res = await call(c.ep.mod, "GET", c.ep.path, { token: tokens[c.role], query: { outletId: outletB } });
    expect([403, 404]).toContain(res.status);
  });

  it.each(ORG_ROLES.flatMap((role) => ENDPOINTS.filter((e) => e.outlet && ROLE_PERMISSIONS[role].includes(e.perm)).map((ep) => [role, ep.name, ep] as const)))(
    "org-wide %s reads %s of every outlet in its organization",
    async (role, _n, ep) => {
      expect((await call(ep.mod, "GET", ep.path, { token: tokens[role as Role], query: { outletId: outletB } })).status).toBe(200);
    }
  );
});

describe("organization scope: another organization's owner", () => {
  it.each(ENDPOINTS.filter((e) => e.outlet).map((ep) => [ep.name, ep] as const))("cannot name this organization's outlet (%s): 404, nothing confirmed", async (_n, ep) => {
    const res = await call(ep.mod, "GET", ep.path, { token: foreignOwner, query: { outletId: outletA } });
    expect(res.status).toBe(404);
  });

  it("sees none of this organization's customers, staff or audit rows", async () => {
    const customers = await call(Customers, "GET", "", { token: foreignOwner });
    expect(customers.status).toBe(200);
    expect(JSON.stringify(customers.json)).not.toContain(orgCustomerId);
    const people = await call(Staff, "GET", "", { token: foreignOwner });
    expect(people.status).toBe(200);
    expect(JSON.stringify(people.json)).not.toContain(`manager-${RUN}@matrix.test`);
    const audit = await call(Audit, "GET", "", { token: foreignOwner });
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.json)).not.toContain(orgId);
  });

  it("cannot read this organization's customer by id (same empty answer as an id that does not exist)", async () => {
    const foreign = await call(Customers, "GET", orgCustomerId, { token: foreignOwner });
    const missing = await call(Customers, "GET", "cm0000000000000000000000", { token: foreignOwner });
    expect(foreign).toEqual(missing);
    expect(foreign.json?.data ?? null).toBeNull();
    expect(JSON.stringify(foreign.json)).not.toContain("Matrix Guest");
  });
});

describe("session states on every endpoint", () => {
  let revoked: string, expired: string, idle: string, deactivated: string;
  beforeAll(async () => {
    const u1 = await staff(orgId, "revoked", "OWNER", null);
    revoked = (await createSession(prisma, u1.id)).token;
    await prisma.session.updateMany({ where: { tokenHash: hashToken(revoked) }, data: { revokedAt: new Date() } });
    const u2 = await staff(orgId, "expired", "OWNER", null);
    expired = (await createSession(prisma, u2.id)).token;
    await prisma.session.updateMany({ where: { tokenHash: hashToken(expired) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const u3 = await staff(orgId, "idle", "OWNER", null);
    idle = (await createSession(prisma, u3.id)).token;
    await prisma.session.updateMany({ where: { tokenHash: hashToken(idle) }, data: { lastActivityAt: new Date(Date.now() - 16 * 60_000) } });
    const u4 = await staff(orgId, "deactivated", "OWNER", null);
    deactivated = (await createSession(prisma, u4.id)).token;
    await prisma.user.update({ where: { id: u4.id }, data: { active: false } });
  });

  const states = ["no cookie", "forged", "revoked", "expired", "idle", "deactivated user"] as const;
  it.each(states.flatMap((s) => ENDPOINTS.map((ep) => [s, ep.name, ep] as const)))("%s → %s: 401", async (state, _n, ep) => {
    const token = { "no cookie": undefined, forged: "A".repeat(43), revoked, expired, idle, "deactivated user": deactivated }[state];
    const res = await call(ep.mod, "GET", ep.path, { token, query: ep.outlet ? { outletId: outletA } : {} });
    expect(res.status).toBe(401);
  });

  it("a role removed mid-session is gone on the very next request (no stale permissions)", async () => {
    const u = await staff(orgId, "demoted", "MANAGER", outletA);
    const token = (await createSession(prisma, u.id)).token;
    expect((await call(Finance, "GET", "payments", { token, query: { outletId: outletA } })).status).toBe(200);
    await prisma.membership.updateMany({ where: { userId: u.id }, data: { role: "KITCHEN" } });
    expect((await call(Finance, "GET", "payments", { token, query: { outletId: outletA } })).status).toBe(403);
    await prisma.membership.updateMany({ where: { userId: u.id }, data: { active: false } });
    expect((await call(Kitchen, "GET", "kots", { token, query: { outletId: outletA } })).status).toBe(403);
  });
});

describe("sign-in replaces the browser's previous session", () => {
  const ip = () => `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
  const login = (body: unknown, cookie?: string) =>
    loginRoute(new NextRequest("http://localhost/api/auth/login", { method: "POST", body: JSON.stringify(body), headers: { host: "localhost", "x-forwarded-for": ip(), ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}) } }));

  it("service: the replaced token is revoked, the new one works, and the LOGIN audit says so", async () => {
    const u = await staff(orgId, "relogin", "CASHIER", outletA, PASSWORD);
    const old = await createSession(prisma, u.id);
    const res = await loginWithPassword(prisma, { email: u.email, password: PASSWORD }, {}, { replacesToken: old.token });
    expect(await validateToken(prisma, old.token)).toBeNull();
    expect(await validateToken(prisma, res.session.token)).toBe(u.id);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { actorId: u.id, action: "LOGIN" }, orderBy: { createdAt: "desc" } });
    expect(JSON.parse(audit.after!)).toEqual({ replacedSession: true });
  });

  it("route: signing in as another account ends the first account's session in that browser", async () => {
    const a = await staff(orgId, "first", "CASHIER", outletA, PASSWORD);
    const b = await staff(orgId, "second", "MANAGER", outletA, PASSWORD);
    const first = await createSession(prisma, a.id);
    const res = await login({ email: b.email, password: PASSWORD }, first.token);
    expect(res.status).toBe(200);
    expect(await validateToken(prisma, first.token)).toBeNull();
  });

  it("route: a failed sign-in leaves the existing session alone", async () => {
    const a = await staff(orgId, "keepme", "CASHIER", outletA, PASSWORD);
    const s = await createSession(prisma, a.id);
    expect((await login({ email: a.email, password: "Wrong#Pass99" }, s.token)).status).toBe(401);
    expect(await validateToken(prisma, s.token)).toBe(a.id);
  });

  it("route: a garbage cookie at sign-in is harmless", async () => {
    const a = await staff(orgId, "garbage", "CASHIER", outletA, PASSWORD);
    expect((await login({ email: a.email, password: PASSWORD }, "not-a-real-token")).status).toBe(200);
  });

  it("route: role, organization or permissions in the body are ignored", async () => {
    const a = await staff(orgId, "elevate", "KITCHEN", outletA, PASSWORD);
    const res = await login({ email: a.email, password: PASSWORD, role: "OWNER", organizationId: "other", isSuperAdmin: true, permissions: ["org.manage"] });
    // loginSchema strips unknown keys; the session's power comes from memberships only.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.user.isSuperAdmin).toBe(false);
    const token = setCookies.get(SESSION_COOKIE);
    expect(token).toBeTruthy();
    expect(await validateToken(prisma, token)).toBe(a.id);
    expect((await call(Staff, "GET", "", { token })).status).toBe(403);
  });
});

describe("shared rate-limit store (RATE_LIMIT_STORE=database)", () => {
  const store = new DatabaseRateLimitStore(prisma);
  afterEach(() => {
    delete process.env.RATE_LIMIT_STORE;
    resetRateLimitStores();
  });

  it("counts hits atomically across concurrent callers", async () => {
    const key = `concurrent:${RUN}`;
    const results = await Promise.all(Array.from({ length: 40 }, () => store.hit(key, 60_000)));
    expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it("starts a new window once the old one has ended", async () => {
    const key = `window:${RUN}`;
    const t0 = 1_900_000_000_000;
    expect((await store.hit(key, 1000, t0)).count).toBe(1);
    expect((await store.hit(key, 1000, t0 + 500)).count).toBe(2);
    const fresh = await store.hit(key, 1000, t0 + 1000);
    expect(fresh).toEqual({ count: 1, resetAt: t0 + 2000 });
  });

  it("never stores the email address or IP it counts", async () => {
    const subject = `login-email:victim-${RUN}@example.com`;
    await store.hit(subject, 60_000);
    const rows = await prisma.$queryRawUnsafe<Array<{ key: string }>>('SELECT "key" FROM "RateLimitBucket"');
    expect(rows.some((r) => r.key.includes("victim"))).toBe(false);
    expect(rows.some((r) => r.key === DatabaseRateLimitStore.bucketKey(subject))).toBe(true);
  });

  it("purges ended windows only", async () => {
    const t0 = 1_800_000_000_000;
    await store.hit(`old:${RUN}`, 1000, t0);
    await store.hit(`live:${RUN}`, 10 * 365 * 24 * 3600_000, Date.now());
    await purgeRateLimitBuckets(prisma, t0 + 5000);
    const keys = (await prisma.$queryRawUnsafe<Array<{ key: string }>>('SELECT "key" FROM "RateLimitBucket"')).map((r) => r.key);
    expect(keys).not.toContain(DatabaseRateLimitStore.bucketKey(`old:${RUN}`));
    expect(keys).toContain(DatabaseRateLimitStore.bucketKey(`live:${RUN}`));
  });

  it("database mode: the sign-in limit holds no matter which instance (memory) is asked", async () => {
    process.env.RATE_LIMIT_STORE = "database";
    resetRateLimitStores();
    const email = `shared-${RUN}@example.com`;
    for (let i = 0; i < RATE_POLICIES.loginPerEmail.limit; i++) {
      await enforceRateLimit(RATE_POLICIES.loginPerEmail, email);
      // A fresh "instance": its own empty memory store. The count lives in the database.
      resetRateLimitStores();
    }
    await expect(enforceRateLimit(RATE_POLICIES.loginPerEmail, email)).rejects.toBeInstanceOf(RateLimitError);
    // Guest throttles are not shared: they stay in this process's memory.
    await getRateLimitStore().reset();
    const before = await prisma.$queryRawUnsafe<Array<{ n: number | bigint }>>('SELECT COUNT(*) AS n FROM "RateLimitBucket"');
    await enforceRateLimit(RATE_POLICIES.guestReadPerIp, `10.1.1.${RUN.length}`);
    const after = await prisma.$queryRawUnsafe<Array<{ n: number | bigint }>>('SELECT COUNT(*) AS n FROM "RateLimitBucket"');
    expect(Number(after[0].n)).toBe(Number(before[0].n));
  });

  it("falls back to per-process counting when the database cannot count (logged, never fails open silently)", async () => {
    const broken = { $queryRaw: async () => { throw new Error("no such table: RateLimitBucket"); }, $executeRaw: async () => 0 } as never;
    const fallback = new MemoryRateLimitStore();
    const s = new FallbackRateLimitStore(new DatabaseRateLimitStore(broken), fallback);
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      for (let i = 1; i <= 3; i++) expect((await s.hit("k", 60_000, 1000 + i)).count).toBe(i);
    } finally {
      console.error = orig;
    }
    expect(errors.length).toBe(1); // at most once a minute
  });

  it.each([
    [undefined, "memory"],
    ["", "memory"],
    ["memory", "memory"],
    ["MEMORY", "memory"],
    ["database", "database"],
    [" Database ", "database"],
  ] as const)("RATE_LIMIT_STORE=%j selects %s", (value, kind) => {
    expect(rateLimitStoreKind((value === undefined ? {} : { RATE_LIMIT_STORE: value }) as NodeJS.ProcessEnv)).toBe(kind);
  });

  it.each(["redis", "memcached", "db"])("RATE_LIMIT_STORE=%s is refused (not implemented)", (value) => {
    expect(() => rateLimitStoreKind({ RATE_LIMIT_STORE: value } as unknown as NodeJS.ProcessEnv)).toThrow(/not implemented/);
  });

  it("production: database is accepted, unknown stores refused; Vercel without it is warned", () => {
    const base = { NODE_ENV: "production", AUTH_SECRET: "x".repeat(48), DATABASE_URL: "postgresql://u@db.example/restora", PAYMENT_WEBHOOK_SECRET: "w".repeat(40), CRON_SECRET: "c".repeat(40) } as NodeJS.ProcessEnv;
    const problems = (env: NodeJS.ProcessEnv) => {
      try {
        validateProductionEnv(env);
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(problems({ ...base, RATE_LIMIT_STORE: "database" })).not.toMatch(/RATE_LIMIT_STORE/);
    expect(problems({ ...base, RATE_LIMIT_STORE: "redis" })).toMatch(/RATE_LIMIT_STORE/);
    expect(productionEnvWarnings({ ...base, VERCEL: "1" }).some((w) => w.includes("RATE_LIMIT_STORE"))).toBe(true);
    expect(productionEnvWarnings({ ...base, VERCEL: "1", RATE_LIMIT_STORE: "database" }).some((w) => w.includes("RATE_LIMIT_STORE"))).toBe(false);
  });
});
