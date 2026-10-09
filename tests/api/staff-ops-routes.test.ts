/** Roster, checklists, hours, sales per staff and the invitation e-mail over HTTP: 401 / 403 / 404 / 422, the password step-up, and the shape of each answer. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/auth/session";
import { hashPassword } from "@/server/auth/password";
import { SESSION_COOKIE } from "@/constants/auth";
import { POST as reauthRoute } from "@/app/api/auth/reauth/route";
import * as Staff from "@/app/api/staff/[[...path]]/route";
import * as Reports from "@/app/api/reports/[[...path]]/route";
import { createShift } from "@/server/services/staff";
import { makeEnv, connectMock, uniq, type Env } from "../domain/growthSupport";
import { call, sessionFor } from "./routeSupport";

const PW = "StaffOps#Pass123";
let env: Env;
let shiftId: string;
let cashierId: string;
const s: Record<string, string> = {};
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function ownerSession() {
  const u = await prisma.user.create({ data: { organizationId: env.orgId, email: `owner-${uniq()}@so.test`, name: "Owner", passwordHash: await hashPassword(PW) } });
  await prisma.membership.create({ data: { organizationId: env.orgId, userId: u.id, outletId: null, role: "OWNER" } });
  return (await createSession(prisma, u.id)).token;
}
async function reauth(token: string) {
  const req = new NextRequest("http://localhost/api/auth/reauth", { method: "POST", body: JSON.stringify({ password: PW, scope: "staff.manage" }), headers: { host: "localhost", "x-forwarded-for": `10.78.${Math.floor(Math.random() * 250)}.7`, cookie: `${SESSION_COOKIE}=${token}` } });
  return (await reauthRoute(req)).status;
}

beforeAll(async () => {
  env = await makeEnv("Gsr");
  shiftId = (await createShift(env.owner, { outletId: env.outletA, name: `Lunch ${uniq()}`, startTime: "11:00", endTime: "15:00" })).id;
  s.owner = await ownerSession();
  s.manager = await sessionFor(env.orgId, "MANAGER", env.outletA);
  s.cashier = await sessionFor(env.orgId, "CASHIER", env.outletA);
  s.kitchen = await sessionFor(env.orgId, "KITCHEN", env.outletA);
  s.foreign = await sessionFor((await prisma.organization.create({ data: { name: `Other ${uniq()}` } })).id, "OWNER", null);
  cashierId = (await prisma.user.findFirstOrThrow({ where: { organizationId: env.orgId, memberships: { some: { role: "CASHIER" } } } })).id;
}, 60000);
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await prisma.$disconnect(); });

describe("roster", () => {
  it("a manager assigns and reads; others are refused; a stranger gets a 404", async () => {
    const body = { shiftId, userId: cashierId, date: day(2) };
    expect((await call(Staff, "POST", "roster", { body })).status).toBe(401);
    for (const role of ["cashier", "kitchen"]) expect((await call(Staff, "POST", "roster", { session: s[role], body })).status, role).toBe(403);
    expect((await call(Staff, "POST", "roster", { session: s.foreign, body })).status).toBe(404);
    expect((await call(Staff, "POST", "roster", { session: s.manager, body: { ...body, date: "tomorrow" } })).status).toBe(422);
    expect((await call(Staff, "POST", "roster", { session: s.manager, body: { ...body, extra: 1 } })).status).toBe(422);
    const ok = await call(Staff, "POST", "roster", { session: s.manager, body });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ created: true, assignment: { shiftId, userId: cashierId, date: day(2) } });
    expect((await call(Staff, "POST", "roster", { session: s.manager, body })).json.data.created).toBe(false);

    const grid = await call(Staff, "GET", `roster?outletId=${env.outletA}&from=${day(0)}&days=7`, { session: s.manager });
    expect(grid.status).toBe(200);
    expect(grid.json.data.days).toHaveLength(7);
    expect(grid.json.data.days[2].shifts.find((x: { shiftId: string }) => x.shiftId === shiftId).people).toHaveLength(1);
    expect((await call(Staff, "GET", `roster?outletId=${env.outletA}&from=${day(0)}`, { session: s.cashier })).status).toBe(403);
    expect((await call(Staff, "GET", `roster?outletId=${env.outletA}`, { session: s.manager })).status).toBe(422); // from is required

    const mine = await call(Staff, "GET", `my-shifts?from=${day(0)}`, { session: s.cashier });
    expect(mine.status).toBe(200);
    expect(Array.isArray(mine.json.data)).toBe(true);

    expect((await call(Staff, "DELETE", `roster/${ok.json.data.assignment.id}`, { session: s.cashier })).status).toBe(403);
    expect((await call(Staff, "DELETE", `roster/${ok.json.data.assignment.id}`, { session: s.manager })).status).toBe(200);
    expect((await call(Staff, "DELETE", `roster/${ok.json.data.assignment.id}`, { session: s.manager })).status).toBe(404);
  });
});

describe("checklists", () => {
  it("create, list with the day's progress, edit, start; roles and tenants respected", async () => {
    const items = [{ title: "Open the gate" }, { title: "Light the stoves", priority: "HIGH" }];
    expect((await call(Staff, "POST", "checklists", { body: { outletId: env.outletA, name: "Opening", items } })).status).toBe(401);
    expect((await call(Staff, "POST", "checklists", { session: s.kitchen, body: { outletId: env.outletA, name: "Opening", items } })).status).toBe(403);
    expect((await call(Staff, "POST", "checklists", { session: s.manager, body: { outletId: env.outletA, name: "Opening", items: [] } })).status).toBe(422);
    const made = await call(Staff, "POST", "checklists", { session: s.manager, body: { outletId: env.outletA, name: "Opening", kind: "OPENING", items } });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const id = made.json.data.id;
    expect((await call(Staff, "POST", "checklists", { session: s.manager, body: { outletId: env.outletA, name: "Opening", items } })).status).toBe(422);

    expect((await call(Staff, "POST", `checklists/${id}/start`, { session: s.kitchen, body: {} })).status).toBe(403);
    expect((await call(Staff, "POST", `checklists/${id}/start`, { session: s.foreign, body: {} })).status).toBe(404);
    const started = await call(Staff, "POST", `checklists/${id}/start`, { session: s.manager, body: {} });
    expect(started.json.data).toMatchObject({ created: 2, existing: 0 });
    expect((await call(Staff, "POST", `checklists/${id}/start`, { session: s.manager, body: {} })).json.data).toMatchObject({ created: 0, existing: 2 });
    expect((await call(Staff, "POST", `checklists/${id}/start`, { session: s.manager, body: { date: day(-3) } })).status).toBe(422);

    const list = await call(Staff, "GET", `checklists?outletId=${env.outletA}&date=${day(0)}`, { session: s.kitchen });
    expect(list.status).toBe(200);
    expect(list.json.data.find((x: { id: string }) => x.id === id).run).toMatchObject({ total: 2, open: 2 });
    expect((await call(Staff, "GET", `checklists?outletId=${env.outletA}`, { session: s.foreign })).status).toBeGreaterThanOrEqual(403);

    expect((await call(Staff, "PATCH", `checklists/${id}`, { session: s.kitchen, body: { name: "x" } })).status).toBe(403);
    const patched = await call(Staff, "PATCH", `checklists/${id}`, { session: s.manager, body: { name: "Opening duties" } });
    expect(patched.json.data.name).toBe("Opening duties");
    expect((await call(Staff, "PATCH", `checklists/${id}`, { session: s.manager, body: { surprise: true } })).status).toBe(422);
  });
});

describe("hours and sales reports", () => {
  it("are reports: staff.manage for hours, reports.view for sales; a manager reads, a cashier does not", async () => {
    for (const id of ["STAFF_HOURS", "SALES_BY_STAFF"]) {
      const ok = await call(Reports, "GET", `${id}?outletId=${env.outletA}&from=${day(-30)}&to=${day(0)}`, { session: s.manager });
      expect(ok.status, id).toBe(200);
      expect(ok.json.data.report).toBe(id);
      expect((await call(Reports, "GET", `${id}?outletId=${env.outletA}`, { session: s.cashier })).status, id).toBe(403);
    }
    expect((await call(Reports, "GET", `STAFF_HOURS?outletId=${env.outletA}&dailyHours=99`, { session: s.manager })).status).toBe(422);
  });
});

describe("invitation e-mail", () => {
  it("is a sensitive action (password again), refused for the unauthorised, and reports what happened", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://app.restora.test");
    await connectMock(env.orgId);
    const created = await call(Staff, "POST", "", { session: s.owner, body: { name: "Nina", email: `nina-${uniq()}@so.test`, role: "CASHIER", outletId: env.outletA, emailInvite: true } });
    expect(created.json.error.code).toBe("ReauthRequiredError");
    expect(await reauth(s.owner)).toBe(200);
    const withInvite = await call(Staff, "POST", "", { session: s.owner, body: { name: "Nina", email: `nina-${uniq()}@so.test`, role: "CASHIER", outletId: env.outletA, emailInvite: true } });
    expect(withInvite.status, JSON.stringify(withInvite.json)).toBe(200);
    expect(withInvite.json.data.invite).toMatchObject({ sent: true, status: "SENT" });
    expect(withInvite.json.data.setup.token).toBeTruthy(); // the creator can still copy it
    const without = await call(Staff, "POST", "", { session: s.owner, body: { name: "Omar", email: `omar-${uniq()}@so.test`, role: "CASHIER", outletId: env.outletA } });
    expect(without.json.data.invite).toBeUndefined();

    const again = await call(Staff, "POST", `users/${withInvite.json.data.id}/invite`, { session: s.owner });
    expect(again.status).toBe(200);
    expect(again.json.data.invite).toMatchObject({ sent: true });
    expect(again.json.data.link.token).not.toBe(withInvite.json.data.setup.token);
    expect((await call(Staff, "POST", `users/${withInvite.json.data.id}/invite`, { session: s.cashier })).status).toBe(403);
    expect((await call(Staff, "POST", `users/${withInvite.json.data.id}/invite`, { session: s.foreign })).status).toBeGreaterThanOrEqual(403);
    expect((await call(Staff, "POST", `users/${withInvite.json.data.id}/invite`)).status).toBe(401);

    vi.stubEnv("PUBLIC_BASE_URL", "");
    const noBase = await call(Staff, "POST", `users/${withInvite.json.data.id}/invite`, { session: s.owner });
    expect(noBase.status).toBe(422);
    expect(noBase.json.error.message).toMatch(/PUBLIC_BASE_URL/);
  });
});
