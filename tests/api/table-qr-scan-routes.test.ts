/**
 * POST /api/master/table-qr/scan — the staff QR scanner's server check.
 * Who may call it, valid / inactive / unknown tables through the guest site's
 * own lookup, foreign tenants answered as "not recognised", unsafe or foreign
 * links refused before any lookup, tokens never echoed, and the rate limit.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/client";
import { NotFoundError } from "@/server/db/scope";
import { resolveTable } from "@/server/services/guestOrdering";
import { resetRateLimitStoreForTests } from "@/server/api/rateLimit";
import * as Master from "@/app/api/master/[[...path]]/route";
import { makeEnv, type Env } from "../domain/growthSupport";
import { ORIGIN, call, sessionFor } from "./routeSupport";

const RUN = Date.now().toString(36);
const tok = (s: string) => `scan${s}${RUN}abcdef`;
const URL_FOR = (t: string, origin = ORIGIN) => `${origin}/t/${t}`;

let env: Env;
const s: Record<string, string> = {};
const tokens = { a: tok("A"), b: tok("B"), off: tok("Off"), foreign: tok("Fo") };
let offOutlet: string;
const savedBase = process.env.PUBLIC_BASE_URL;

beforeAll(async () => {
  delete process.env.PUBLIC_BASE_URL;
  env = await makeEnv("Qsc");
  await prisma.restaurantTable.create({ data: { organizationId: env.orgId, outletId: env.outletA, code: "T01", qrToken: tokens.a } });
  await prisma.restaurantTable.create({ data: { organizationId: env.orgId, outletId: env.outletB, code: "B07", qrToken: tokens.b } });
  offOutlet = (await prisma.outlet.create({ data: { organizationId: env.orgId, code: `QSO${RUN}`, name: "Closed outlet", active: false } })).id;
  await prisma.restaurantTable.create({ data: { organizationId: env.orgId, outletId: offOutlet, code: "T09", qrToken: tokens.off } });
  const fo = await prisma.organization.create({ data: { name: `Qsc Foreign ${RUN}` } });
  const fOut = await prisma.outlet.create({ data: { organizationId: fo.id, code: `QSF${RUN}`, name: "Foreign outlet" } });
  await prisma.restaurantTable.create({ data: { organizationId: fo.id, outletId: fOut.id, code: "T01", qrToken: tokens.foreign } });

  s.owner = await sessionFor(env.orgId, "OWNER", null);
  s.captainA = await sessionFor(env.orgId, "CAPTAIN", env.outletA);
  s.kitchenA = await sessionFor(env.orgId, "KITCHEN", env.outletA);
  s.storeA = await sessionFor(env.orgId, "STORE", env.outletA);
});
afterEach(() => resetRateLimitStoreForTests());
afterAll(async () => {
  if (savedBase === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = savedBase;
  await prisma.$disconnect();
});

const scan = (session: string | undefined, text: unknown, origin?: string | null) => call(Master, "POST", "table-qr/scan", { session, body: { text }, origin });

describe("who may check a table QR", () => {
  it("needs a session, a same-origin request, and the right to see tables", async () => {
    expect((await scan(undefined, URL_FOR(tokens.a))).status).toBe(401);
    expect((await scan(s.captainA, URL_FOR(tokens.a), "https://evil.example")).status).toBe(403);
    // Same audience as Floors & tables: KITCHEN holds order.view, so it may check codes; STORE has no table access.
    expect((await scan(s.kitchenA, URL_FOR(tokens.a))).json.data).toMatchObject({ status: "valid" });
    const store = await scan(s.storeA, URL_FOR(tokens.a));
    expect(store.status).toBe(403);
    expect(JSON.stringify(store.json)).not.toContain(tokens.a);
  });

  it("refuses a malformed body", async () => {
    expect((await call(Master, "POST", "table-qr/scan", { session: s.owner, body: { text: 5 } })).status).toBe(422);
    expect((await call(Master, "POST", "table-qr/scan", { session: s.owner, body: { text: "x", extra: 1 } })).status).toBe(422);
    expect((await call(Master, "POST", "table-qr/scan", { session: s.owner, body: { text: "x".repeat(5000) } })).status).toBe(422);
  });
});

describe("what a scanned code resolves to", () => {
  it("a live table: code, outlet, restaurant, masked token and the normalized guest link on this deployment", async () => {
    const r = await scan(s.captainA, URL_FOR(tokens.a));
    expect(r.status).toBe(200);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: env.orgId } });
    expect(r.json.data).toMatchObject({
      status: "valid",
      table: { code: "T01" },
      outletName: "Qsc A",
      restaurantName: org.name,
      tokenHint: `••••${tokens.a.slice(-3)}`,
      guestUrl: `${ORIGIN}/t/${tokens.a}`,
      environment: { qrOrigin: ORIGIN, appOrigin: ORIGIN, matchesApp: true },
    });
    // Nothing else about the table (ids, status, capacity, orders) leaves the server.
    expect(Object.keys(r.json.data.table)).toEqual(["code"]);
    expect(JSON.stringify(r.json.data)).not.toMatch(/"id"|outletId|organizationId/);
    // A pasted bare token works the same, with nothing to compare the address against.
    const bare = await scan(s.captainA, tokens.a);
    expect(bare.json.data).toMatchObject({ status: "valid", table: { code: "T01" }, environment: { qrOrigin: null, matchesApp: null } });
  });

  it("an outlet that is switched off is 'inactive' for staff, while guests still get the one generic error", async () => {
    const r = await scan(s.owner, URL_FOR(tokens.off));
    expect(r.json.data).toMatchObject({ status: "inactive", table: { code: "T09" }, outletName: "Closed outlet" });
    expect(r.json.data.guestUrl).toBeUndefined();
    await expect(resolveTable(tokens.off)).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolveTable(tokens.a)).resolves.toMatchObject({ table: { code: "T01" } });
  });

  it("unknown, revoked, other-outlet and other-restaurant codes are all just 'not recognised'", async () => {
    const unknown = await scan(s.owner, URL_FOR(tok("Nope")));
    expect(unknown.json.data).toMatchObject({ status: "not_found", tokenHint: `••••${tok("Nope").slice(-3)}` });
    const foreign = await scan(s.owner, URL_FOR(tokens.foreign));
    expect(foreign.json.data.status).toBe("not_found");
    expect(JSON.stringify(foreign.json.data)).not.toContain("Foreign outlet");
    // A captain at outlet A does not learn about outlet B's tables; the owner does.
    expect((await scan(s.captainA, URL_FOR(tokens.b))).json.data.status).toBe("not_found");
    expect((await scan(s.owner, URL_FOR(tokens.b))).json.data).toMatchObject({ status: "valid", table: { code: "B07" } });
  });

  it("refuses unsafe, foreign and malformed links before any lookup, without echoing the token", async () => {
    const cases: Array<[string, string]> = [
      ["javascript:alert(1)", "unsafe_scheme"],
      [`data:text/html,${tokens.a}`, "unsafe_scheme"],
      [`file:///t/${tokens.a}`, "unsafe_scheme"],
      [URL_FOR(tokens.a, "https://evil.example"), "untrusted_origin"],
      [`${URL_FOR(tokens.a)}?next=https://evil.example`, "query_or_fragment"],
      [`${ORIGIN}/t/${tokens.a}/checkout`, "wrong_path"],
      [`${ORIGIN}/t/a!b`, "bad_token"],
    ];
    for (const [text, reason] of cases) {
      const r = await scan(s.owner, text);
      expect(r.status, text).toBe(200);
      expect(r.json.data, text).toMatchObject({ status: "rejected", reason });
      expect(JSON.stringify(r.json.data)).not.toContain(tokens.a);
    }
  });

  it("trusts PUBLIC_BASE_URL as this deployment's guest address, and flags a QR printed for another trusted address", async () => {
    process.env.PUBLIC_BASE_URL = "https://menu.qsc.example/";
    try {
      const printed = await scan(s.owner, URL_FOR(tokens.a, "https://menu.qsc.example"));
      expect(printed.json.data).toMatchObject({ status: "valid", guestUrl: `https://menu.qsc.example/t/${tokens.a}`, environment: { matchesApp: true, appOrigin: "https://menu.qsc.example" } });
      const local = await scan(s.owner, URL_FOR(tokens.a));
      expect(local.json.data).toMatchObject({ status: "valid", guestUrl: `https://menu.qsc.example/t/${tokens.a}`, environment: { qrOrigin: ORIGIN, matchesApp: false } });
      expect((await scan(s.owner, URL_FOR(tokens.a, "https://other.example"))).json.data).toMatchObject({ status: "rejected", reason: "untrusted_origin" });
    } finally {
      delete process.env.PUBLIC_BASE_URL;
    }
  });
});

describe("rate limit", () => {
  it("caps checks per user per minute", async () => {
    let limited = 0;
    for (let i = 0; i < 61; i++) {
      const r = await scan(s.captainA, URL_FOR(tok(`R${i}`)));
      if (r.status === 429) limited++;
    }
    expect(limited).toBe(1);
  });
});
