/**
 * Test harness for cloud <-> desktop sync: two independent "worlds" (organizations) in the one test database — a CLOUD
 * restaurant with a QR-enabled table, and a DESKTOP installation of the same café with its own ids — plus a fake
 * network (a `Transport`) that delivers the desktop's HTTP requests to the real cloud route handlers in-process.
 * The desktop code under test only ever sees that transport, exactly as in production it only sees `fetch`.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { hashPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/constants/auth";
import { rotateTableQr } from "@/server/services/masterData";
import { addModifierOption, attachModifierGroup, createMenuItem, createModifierGroup } from "@/server/services/menu";
import type { Transport } from "@/server/sync/cloudClient";
import type { AccessContext } from "@/server/db/scope";

export const RUN = Date.now().toString(36);
export const PASSWORD = "Correct@Horse9";
export const CLOUD_ORIGIN = "https://cloud.restora.test";

/** What the sign-in / sign-out routes set through next/headers (tests mock that module to write here). */
export const setCookies = new Map<string, string>();

export const nextHeadersMock = () => ({
  cookies: async () => ({
    set: (name: string, value: string) => void setCookies.set(name, value),
    get: (name: string) => (setCookies.has(name) ? { name, value: setCookies.get(name)! } : undefined),
  }),
});

export type World = {
  orgId: string;
  outletId: string;
  outletCode: string;
  tableId: string;
  tableCode: string;
  qrToken: string | null;
  ctx: AccessContext;
  coffee: string;
  brownie: string;
  largeOption: string;
};

/** A restaurant: one outlet, table T09, the same three-line menu (a dish with an add-on, two plain dishes). */
export async function makeWorld(label: string, opts: { qr?: boolean; skipDish?: string } = {}): Promise<World> {
  const orgId = (await prisma.organization.create({ data: { name: `${label} ${RUN}` } })).id;
  const outletCode = `CF${label.slice(0, 2).toUpperCase()}${RUN.slice(-4)}`;
  const outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: outletCode, name: `${label} Café`, openTime: null, closeTime: null } })).id;
  const ctx = systemContext(orgId, [outletId]);
  const table = await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: "T09" } });
  const qrToken = opts.qr ? (await rotateTableQr(ctx, table.id)).qrToken! : null;
  const coffee = (await createMenuItem(ctx, { name: "Cold Coffee", price: 120, taxPct: 5 })).id;
  const brownie = opts.skipDish === "Brownie" ? "" : (await createMenuItem(ctx, { name: "Brownie", price: 90, taxPct: 5 })).id;
  const group = await createModifierGroup(ctx, { name: "Size", minSelect: 0, maxSelect: 1 });
  const large = await addModifierOption(ctx, { groupId: group.id, name: "Large", priceDelta: 30 });
  await attachModifierGroup(ctx, coffee, group.id);
  return { orgId, outletId, outletCode, tableId: table.id, tableCode: "T09", qrToken, ctx, coffee, brownie, largeOption: large.id };
}

let seq = 0;
/** A staff account with a real password hash and one role at the world's outlet (null: organization-wide). */
export async function makeStaff(w: World, role: string, orgWide = false) {
  const email = `${role.toLowerCase()}-${RUN}-${++seq}@sync.test`;
  const user = await prisma.user.create({ data: { organizationId: w.orgId, email, name: role, passwordHash: await hashPassword(PASSWORD) } });
  await prisma.membership.create({ data: { organizationId: w.orgId, userId: user.id, outletId: orgWide ? null : w.outletId, role } });
  const session = (await createSession(prisma, user.id)).token;
  return { id: user.id, email, session };
}

// ---------------- fake network ----------------

type Handler = (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>;
type Route = Record<string, Handler>;

export type FakeCloud = {
  transport: Transport;
  /** Every request the desktop made: method + path (no query, no headers). */
  calls: Array<{ method: string; path: string }>;
  offline: boolean;
  /** Deliver the next POST to the cloud, then drop the answer (a lost response). */
  loseNextResponse: boolean;
  /** When set, every cloud API answer is this HTTP status (a reachable-but-unavailable service). */
  cloudHttpStatus: number | null;
};

/** Delivers requests addressed to CLOUD_ORIGIN to the real route handlers; honours offline / lost-response switches. */
export async function fakeCloud(): Promise<FakeCloud> {
  const [{ POST: login }, { POST: logout }, Sync, Payments] = await Promise.all([
    import("@/app/api/auth/login/route"),
    import("@/app/api/auth/logout/route"),
    import("@/app/api/sync/[[...path]]/route"),
    import("@/app/api/payments/[[...path]]/route"),
  ]);
  const state: FakeCloud = {
    calls: [],
    offline: false,
    loseNextResponse: false,
    cloudHttpStatus: null,
    transport: async (url, init) => {
      if (state.offline) throw new TypeError("fetch failed");
      const u = new URL(url);
      if (u.origin !== CLOUD_ORIGIN) throw new TypeError("fetch failed");
      if (state.cloudHttpStatus) {
        return new Response(JSON.stringify({ ok: false, error: { code: "Unavailable", message: "overloaded" } }), { status: state.cloudHttpStatus });
      }
      const method = (init.method ?? "GET").toUpperCase();
      state.calls.push({ method, path: u.pathname });
      const headers = new Headers(init.headers);
      headers.set("host", "cloud.restora.test");
      headers.set("x-forwarded-for", "203.0.113.77");
      const cookie = headers.get("cookie") ?? "";
      const req = new NextRequest(u, { method, headers, body: init.body as string | undefined });
      let res: Response;
      if (u.pathname === "/api/auth/login") {
        setCookies.clear();
        res = await login(req);
        const issued = setCookies.get(SESSION_COOKIE);
        if (issued) res = new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "set-cookie": `${SESSION_COOKIE}=${issued}; Path=/; HttpOnly; Secure; SameSite=Lax` } });
      } else if (u.pathname === "/api/auth/logout") {
        setCookies.clear();
        setCookies.set(SESSION_COOKIE, /aharos_session=([^;]+)/.exec(cookie)?.[1] ?? "");
        res = await logout(req);
      } else {
        const mod = (u.pathname.startsWith("/api/sync/") ? Sync : u.pathname.startsWith("/api/payments") ? Payments : null) as unknown as Route | null;
        if (!mod) throw new Error(`fake cloud has no route for ${u.pathname}`);
        const segs = u.pathname.split("/").slice(3);
        res = await mod[method](req, { params: Promise.resolve({ path: segs.length ? segs : undefined }) });
      }
      if (state.loseNextResponse && method === "POST" && u.pathname !== "/api/auth/login") {
        state.loseNextResponse = false;
        throw new TypeError("fetch failed");
      }
      return res;
    },
  };
  return state;
}
