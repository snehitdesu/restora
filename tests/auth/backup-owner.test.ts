/**
 * Business continuity: a second trusted OWNER. An owner invites another person
 * as an org-wide OWNER through the normal staff flow (single-use setup link,
 * behind a password re-confirmation, audited). The invitation expires, works
 * once and is revoked by deactivating the invitee. Nobody below OWNER can
 * grant OWNER (a manager cannot promote themselves), nothing crosses an
 * organization, and removing an owner never leaves an escalation behind.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { buildAccessContext } from "@/server/auth/context";
import { hashPassword } from "@/server/auth/password";
import { createSession, validateToken } from "@/server/auth/session";
import { loginWithPassword } from "@/server/auth/login";
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "@/server/db/scope";
import { createStaff, assignMembership, revokeMembership, setUserActive, issuePasswordLink } from "@/server/services/staff";
import { issuePasswordToken, PASSWORD_TOKEN_TTL_MS, INVALID_TOKEN_MESSAGE } from "@/server/auth/passwordTokens";
import { completePasswordToken } from "@/server/auth/account";
import { generateRecoveryCodes, recoveryStatus, recoverySetupGaps } from "@/server/auth/recoveryCodes";
import { settleAfterCommit } from "@/server/services/afterCommit";
import { SESSION_COOKIE } from "@/constants/auth";
import * as Staff from "@/app/api/staff/[[...path]]/route";
import { POST as reauthRoute } from "@/app/api/auth/reauth/route";

const RUN = Date.now().toString(36);
const PW = "Owner#Backup42";
const NEW = "Second$Owner77";
let orgId: string, otherOrgId: string, outletA: string, otherOutlet: string;
let n = 0;

async function makeUser(org: string, tag: string, memberships: Array<{ role: string; outletId: string | null }>) {
  const u = await prisma.user.create({ data: { organizationId: org, email: `${tag}-${RUN}-${++n}@bo.test`, name: tag, passwordHash: await hashPassword(PW), lastLoginAt: new Date() } });
  for (const m of memberships) await prisma.membership.create({ data: { organizationId: org, userId: u.id, outletId: m.outletId, role: m.role } });
  return u;
}
const ctxOf = (id: string) => buildAccessContext(prisma, id);

type Mod = Record<string, (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>;
async function staffCall(method: string, path: string, token: string, body?: unknown) {
  const req = new NextRequest(`http://localhost/api/staff/${path}`, { method, headers: { host: "localhost", cookie: `${SESSION_COOKIE}=${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await (Staff as unknown as Mod)[method](req, { params: Promise.resolve({ path: path ? path.split("/") : undefined }) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function reauth(token: string, scope: string) {
  const req = new NextRequest("http://localhost/api/auth/reauth", { method: "POST", body: JSON.stringify({ password: PW, scope }), headers: { host: "localhost", "x-forwarded-for": `10.5.${Math.floor(Math.random() * 250)}.7`, cookie: `${SESSION_COOKIE}=${token}` } });
  return (await reauthRoute(req)).status;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Backup Owner ${RUN}` } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `Other Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `BO${RUN}`, name: "A" } })).id;
  otherOutlet = (await prisma.outlet.create({ data: { organizationId: otherOrgId, code: `BX${RUN}`, name: "X" } })).id;
});
afterAll(async () => { await settleAfterCommit(); await prisma.$disconnect(); });

describe("inviting a second owner", () => {
  it("an owner invites; the invitee sets a password once and signs in separately as an org-wide owner; audited", async () => {
    const first = await makeUser(orgId, "first", [{ role: "OWNER", outletId: null }]);
    expect(await recoverySetupGaps(prisma, first.id)).toContain("sole_owner");
    const invited = await createStaff(await ctxOf(first.id), { email: `Second-${RUN}@bo.test`, name: "Second Owner", role: "OWNER" });
    expect(invited.setup.purpose).toBe("SETUP");
    expect(invited.setup.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(PASSWORD_TOKEN_TTL_MS.SETUP);

    // Before accepting, the invitee cannot sign in (unusable placeholder password).
    await expect(loginWithPassword(prisma, { email: invited.email, password: NEW })).rejects.toBeInstanceOf(UnauthorizedError);
    await completePasswordToken(prisma, { token: invited.setup.token, password: NEW });
    await expect(completePasswordToken(prisma, { token: invited.setup.token, password: NEW })).rejects.toThrow(INVALID_TOKEN_MESSAGE); // one-time

    const login = await loginWithPassword(prisma, { email: invited.email, password: NEW });
    expect(login.user.id).toBe(invited.id);
    const secondCtx = await ctxOf(invited.id);
    expect(secondCtx.isOrgWide).toBe(true);
    expect(secondCtx.orgRoles).toContain("OWNER");
    // The first owner's own password and session are untouched.
    await expect(loginWithPassword(prisma, { email: first.email, password: PW })).resolves.toMatchObject({ user: { id: first.id } });

    expect((await recoveryStatus(prisma, first.id)).activeOwners).toBe(2);
    expect(await recoverySetupGaps(prisma, first.id)).not.toContain("sole_owner");
    const audits = await prisma.auditLog.findMany({ where: { entityId: invited.id }, select: { action: true, actorId: true, after: true } });
    expect(audits.filter((a) => a.action === "CREATE")).toEqual([expect.objectContaining({ actorId: first.id })]);
    expect(JSON.parse(audits.find((a) => a.action === "CREATE")!.after!)).toMatchObject({ role: "OWNER", outletId: null });
    expect(audits.some((a) => a.action === "PASSWORD_LINK" && a.actorId === first.id)).toBe(true);
    expect(audits.some((a) => a.action === "PASSWORD_SET")).toBe(true);
    for (const a of audits) expect(a.after ?? "").not.toContain(invited.setup.token);
  });

  it("an expired, used, superseded or revoked invitation is refused", async () => {
    const first = await makeUser(orgId, "inviter", [{ role: "OWNER", outletId: null }]);
    const ctx = await ctxOf(first.id);
    const a = await createStaff(ctx, { email: `exp-${RUN}@bo.test`, name: "Expired", role: "OWNER" });
    const expired = await issuePasswordToken(prisma, { organizationId: orgId, userId: a.id, purpose: "SETUP" }, new Date(Date.now() - PASSWORD_TOKEN_TTL_MS.SETUP - 60_000));
    await expect(completePasswordToken(prisma, { token: expired.token, password: NEW })).rejects.toThrow(INVALID_TOKEN_MESSAGE);
    // Issuing the expired one retired the original invitation too.
    await expect(completePasswordToken(prisma, { token: a.setup.token, password: NEW })).rejects.toThrow(INVALID_TOKEN_MESSAGE);

    const b = await createStaff(ctx, { email: `sup-${RUN}@bo.test`, name: "Superseded", role: "OWNER" });
    const fresh = await issuePasswordLink(ctx, b.id);
    await expect(completePasswordToken(prisma, { token: b.setup.token, password: NEW })).rejects.toThrow(INVALID_TOKEN_MESSAGE);
    await expect(completePasswordToken(prisma, { token: fresh.token, password: NEW })).resolves.toMatchObject({ purpose: "SETUP" });

    // Revoking an invitation = deactivating the invitee: the link dies and they cannot sign in.
    const c = await createStaff(ctx, { email: `rev-${RUN}@bo.test`, name: "Revoked", role: "OWNER" });
    await setUserActive(ctx, c.id, false);
    await expect(completePasswordToken(prisma, { token: c.setup.token, password: NEW })).rejects.toThrow(INVALID_TOKEN_MESSAGE);
    await expect(loginWithPassword(prisma, { email: c.email, password: NEW })).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe("who may grant OWNER", () => {
  it("managers, area managers and admins cannot grant OWNER to anyone, themselves included", async () => {
    const target = await makeUser(orgId, "target", [{ role: "CASHIER", outletId: outletA }]);
    for (const role of ["MANAGER", "AREA_MANAGER", "ADMIN"]) {
      const actor = await makeUser(orgId, `climb-${role}`, [{ role, outletId: role === "MANAGER" ? outletA : null }]);
      const ctx = await ctxOf(actor.id);
      await expect(assignMembership(ctx, { userId: actor.id, role: "OWNER" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(assignMembership(ctx, { userId: target.id, role: "OWNER" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(createStaff(ctx, { email: `by-${role}-${RUN}@bo.test`, name: "x", role: "OWNER" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(createStaff(ctx, { email: `byo-${role}-${RUN}@bo.test`, name: "x", role: "OWNER", outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await prisma.membership.count({ where: { organizationId: orgId, role: "OWNER", user: { name: { startsWith: "climb-" } } } })).toBe(0);
    expect(await prisma.user.count({ where: { email: { startsWith: "by" , endsWith: `${RUN}@bo.test` } } })).toBe(0);
  });

  it("a manager keeps their limits: cannot revoke, deactivate or issue a link for an owner", async () => {
    const own = await makeUser(orgId, "protected", [{ role: "OWNER", outletId: null }]);
    await makeUser(orgId, "coowner", [{ role: "OWNER", outletId: null }]); // so 'last owner' is not what refuses
    const mgr = await makeUser(orgId, "mgr", [{ role: "MANAGER", outletId: outletA }]);
    const ctx = await ctxOf(mgr.id);
    const m = await prisma.membership.findFirstOrThrow({ where: { userId: own.id, role: "OWNER" } });
    await expect(revokeMembership(ctx, m.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setUserActive(ctx, own.id, false)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(issuePasswordLink(ctx, own.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: m.id } })).active).toBe(true);
  });

  it("route: granting OWNER needs a fresh password confirmation, and a manager is refused even with one", async () => {
    const own = await makeUser(orgId, "routeowner", [{ role: "OWNER", outletId: null }]);
    const ownToken = (await createSession(prisma, own.id)).token;
    const body = { email: `route-${RUN}@bo.test`, name: "Route Owner", role: "OWNER" };
    const noStepUp = await staffCall("POST", "", ownToken, body);
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.json.error).toMatchObject({ code: "ReauthRequiredError", details: { scope: "staff.manage" } });
    expect(await prisma.user.count({ where: { email: body.email } })).toBe(0);
    expect(await reauth(ownToken, "staff.manage")).toBe(200);
    const created = await staffCall("POST", "", ownToken, body);
    expect(created.status).toBe(200);
    expect(created.json.data.setup.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const mgr = await makeUser(orgId, "routemgr", [{ role: "MANAGER", outletId: outletA }]);
    const mgrToken = (await createSession(prisma, mgr.id)).token;
    expect(await reauth(mgrToken, "staff.manage")).toBe(200);
    expect((await staffCall("POST", "memberships", mgrToken, { userId: mgr.id, role: "OWNER" })).status).toBe(403);
    expect((await staffCall("POST", "", mgrToken, { email: `route2-${RUN}@bo.test`, name: "x", role: "OWNER" })).status).toBe(403);
    expect(await prisma.membership.count({ where: { userId: mgr.id, role: "OWNER" } })).toBe(0);
  });
});

describe("organization boundaries", () => {
  it("an owner of one organization cannot invite into, grant in, or reset accounts of another", async () => {
    const mine = await makeUser(orgId, "homeowner", [{ role: "OWNER", outletId: null }]);
    const foreignOwner = await makeUser(otherOrgId, "foreignowner", [{ role: "OWNER", outletId: null }]);
    const foreignStaff = await makeUser(otherOrgId, "foreignstaff", [{ role: "CASHIER", outletId: otherOutlet }]);
    const ctx = await ctxOf(mine.id);
    await expect(assignMembership(ctx, { userId: foreignStaff.id, role: "OWNER" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(issuePasswordLink(ctx, foreignOwner.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(setUserActive(ctx, foreignOwner.id, false)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createStaff(ctx, { email: `xorg-${RUN}@bo.test`, name: "x", role: "MANAGER", outletId: otherOutlet })).rejects.toBeInstanceOf(NotFoundError);
    const foreignM = await prisma.membership.findFirstOrThrow({ where: { userId: foreignOwner.id } });
    await expect(revokeMembership(ctx, foreignM.id)).rejects.toBeInstanceOf(NotFoundError);
    // A new owner is always created inside the inviter's organization.
    const created = await createStaff(ctx, { email: `inorg-${RUN}@bo.test`, name: "In Org", role: "OWNER" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: created.id } })).organizationId).toBe(orgId);
    expect(await prisma.membership.count({ where: { userId: foreignStaff.id, role: "OWNER" } })).toBe(0);
  });
});

describe("removing an owner", () => {
  it("deactivating a co-owner kills their sessions, links and recovery codes; the last owner cannot be removed", async () => {
    const a = await makeUser(orgId, "keepowner", [{ role: "OWNER", outletId: null }]);
    const b = await makeUser(orgId, "leavingowner", [{ role: "OWNER", outletId: null }]);
    const aCtx = await ctxOf(a.id);
    const bSession = await createSession(prisma, b.id);
    const bLink = await issuePasswordLink(aCtx, b.id);
    await generateRecoveryCodes(prisma, b.id);

    await setUserActive(aCtx, b.id, false);
    expect(await validateToken(prisma, bSession.token)).toBeNull();
    await expect(completePasswordToken(prisma, { token: bLink.token, password: NEW })).rejects.toThrow(INVALID_TOKEN_MESSAGE);
    expect(await prisma.recoveryCode.count({ where: { userId: b.id } })).toBe(0);
    await expect(loginWithPassword(prisma, { email: b.email, password: PW })).rejects.toBeInstanceOf(UnauthorizedError);

    // b's OWNER membership still exists (inactive user), so a is now the only ACTIVE owner and is protected.
    expect((await recoveryStatus(prisma, a.id)).activeOwners).toBeGreaterThanOrEqual(1);
    const soloOrg = (await prisma.organization.create({ data: { name: `Solo ${RUN}` } })).id;
    const solo = await makeUser(soloOrg, "solo", [{ role: "OWNER", outletId: null }]);
    const helper = await makeUser(soloOrg, "helper", [{ role: "OWNER", outletId: null }]);
    const helperCtx = await ctxOf(helper.id);
    await setUserActive(await ctxOf(solo.id), helper.id, false);
    const soloM = await prisma.membership.findFirstOrThrow({ where: { userId: solo.id, role: "OWNER" } });
    // Even through a context built before the helper was deactivated, the last active owner cannot be removed.
    await expect(setUserActive(helperCtx, solo.id, false)).rejects.toBeInstanceOf(ValidationError);
    await expect(revokeMembership(helperCtx, soloM.id)).rejects.toBeInstanceOf(ValidationError);
    await expect(setUserActive(await ctxOf(solo.id), solo.id, false)).rejects.toBeInstanceOf(ForbiddenError); // not yourself
    expect((await prisma.user.findUniqueOrThrow({ where: { id: solo.id } })).active).toBe(true);
  });

  it("revoking OWNER leaves the person with only their other roles; codes are gone and do not return", async () => {
    const a = await makeUser(orgId, "demoter", [{ role: "OWNER", outletId: null }]);
    const b = await makeUser(orgId, "demoted", [{ role: "OWNER", outletId: null }, { role: "MANAGER", outletId: outletA }]);
    await generateRecoveryCodes(prisma, b.id);
    const aCtx = await ctxOf(a.id);
    const m = await prisma.membership.findFirstOrThrow({ where: { userId: b.id, role: "OWNER" } });
    await revokeMembership(aCtx, m.id);
    const bCtx = await ctxOf(b.id);
    expect(bCtx.orgRoles).not.toContain("OWNER");
    expect(bCtx.isOrgWide).toBe(false);
    expect(await prisma.recoveryCode.count({ where: { userId: b.id } })).toBe(0);
    await expect(generateRecoveryCodes(prisma, b.id)).rejects.toBeInstanceOf(ForbiddenError);
    // The demoted manager cannot climb back.
    await expect(assignMembership(bCtx, { userId: b.id, role: "OWNER" })).rejects.toBeInstanceOf(ForbiddenError);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: m.id, action: "ROLE_CHANGE" }, orderBy: { createdAt: "desc" } });
    expect(JSON.parse(audit.after!)).toMatchObject({ active: false, role: "OWNER", recoveryCodesDeleted: 10 });
  });
});
