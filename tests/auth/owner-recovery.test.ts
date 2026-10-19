/**
 * Owner account recovery: offline recovery codes (generation behind step-up,
 * hashes only, single use, invalidation, session revocation, rate limits),
 * verified-email password reset, email verification, password-change notices
 * and honest reporting when email delivery is missing or failing. Plus the
 * role rules that keep recovery from becoming an escalation path.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { buildAccessContext } from "@/server/auth/context";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createSession, validateToken } from "@/server/auth/session";
import { grantReauth } from "@/server/auth/reauth";
import { ForbiddenError, ValidationError } from "@/server/db/scope";
import { assignMembership, issuePasswordLink, revokeMembership, setUserActive } from "@/server/services/staff";
import { issuePasswordToken, findUsablePasswordToken, PASSWORD_TOKEN_TTL_MS, INVALID_TOKEN_MESSAGE } from "@/server/auth/passwordTokens";
import { completePasswordToken, changePassword, requestPasswordReset, setPasswordLinkDelivery } from "@/server/auth/account";
import {
  generateRecoveryCodes, redeemRecoveryCode, recoveryStatus, normalizeRecoveryCode, hashRecoveryCode, newRecoveryCode,
  INVALID_RECOVERY_MESSAGE, RECOVERY_CODE_COUNT,
} from "@/server/auth/recoveryCodes";
import { requestEmailVerification, confirmEmailVerification, INVALID_VERIFY_MESSAGE } from "@/server/auth/emailVerification";
import { setSecurityMailer, EMAIL_NOT_CONFIGURED_MESSAGE, type SecurityMailer } from "@/server/auth/securityMail";
import { settleAfterCommit } from "@/server/services/afterCommit";
import { resetRateLimitStoreForTests } from "@/server/api/rateLimit";
import { SESSION_COOKIE } from "@/constants/auth";
import { POST as recoverRoute } from "@/app/api/auth/recovery/route";
import { POST as codesRoute } from "@/app/api/auth/recovery-codes/route";
import { GET as securityRoute } from "@/app/api/auth/security/route";
import { POST as verifyRequestRoute } from "@/app/api/auth/email/verify-request/route";
import { POST as verifyRoute } from "@/app/api/auth/email/verify/route";

const RUN = Date.now().toString(36);
const GOOD = "Kitchen#Pass42";
const NEW = "Tandoor!Night77";
let orgId: string, outletA: string;
let n = 0;

async function makeUser(tag: string, memberships: Array<{ role: string; outletId: string | null }>, opts: { verified?: boolean } = {}) {
  const u = await prisma.user.create({
    data: { organizationId: orgId, email: `${tag}-${RUN}-${++n}@rec.test`, name: tag, passwordHash: await hashPassword(GOOD), lastLoginAt: new Date(), emailVerifiedAt: opts.verified ? new Date() : null },
  });
  for (const m of memberships) await prisma.membership.create({ data: { organizationId: orgId, userId: u.id, outletId: m.outletId, role: m.role } });
  return u;
}
const owner = (tag: string, opts?: { verified?: boolean }) => makeUser(tag, [{ role: "OWNER", outletId: null }], opts);

const ip = () => `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
function req(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body), headers: { host: "localhost", "x-forwarded-for": ip(), ...headers } });
}
async function json(res: Response) {
  return { status: res.status, headers: res.headers, body: await res.json() };
}

/** Records every message; `fail` makes the provider reject. */
function fakeMailer(fail = false) {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const mailer: SecurityMailer = {
    baseUrl: "https://restora.example",
    send: async (m) => {
      if (fail) throw new Error("provider down");
      sent.push({ to: m.to, subject: m.subject, text: m.text });
    },
  };
  return { mailer, sent };
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Recovery Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `RA${RUN}`, name: "A" } })).id;
});
afterEach(async () => {
  await settleAfterCommit();
  setSecurityMailer(undefined);
  setPasswordLinkDelivery(null);
  vi.useRealTimers();
});
afterAll(async () => { await prisma.$disconnect(); });

describe("recovery code format", () => {
  it("80-bit Crockford codes; typing variations normalize; junk is rejected", () => {
    const codes = new Set(Array.from({ length: 2000 }, newRecoveryCode));
    expect(codes.size).toBe(2000);
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(normalizeRecoveryCode("abcd-efgh-jkmn-pqrs")).toBe("ABCDEFGHJKMNPQRS");
    expect(normalizeRecoveryCode(" ABCD EFGH JKMN PQ0O ")).toBe("ABCDEFGHJKMNPQ00");
    expect(normalizeRecoveryCode("ABCDEFGHJKMNPQIL")).toBe("ABCDEFGHJKMNPQ11");
    expect(normalizeRecoveryCode("ABCD-EFGH-JKMN-PQU1")).toBeNull(); // U is not in the alphabet
    expect(normalizeRecoveryCode("short")).toBeNull();
    // Hashes are bound to the user: the same code means nothing for anyone else.
    expect(hashRecoveryCode("u1", "ABCDEFGHJKMNPQRS")).not.toBe(hashRecoveryCode("u2", "ABCDEFGHJKMNPQRS"));
  });
});

describe("generating recovery codes", () => {
  it("owner only; 10 codes shown once; only hashes stored; audited without the codes", async () => {
    const o = await owner("gen");
    const { codes } = await generateRecoveryCodes(prisma, o.id);
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const c of codes) expect(c).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const rows = await prisma.recoveryCode.findMany({ where: { userId: o.id } });
    expect(rows).toHaveLength(RECOVERY_CODE_COUNT);
    const stored = JSON.stringify(rows);
    for (const c of codes) {
      expect(stored).not.toContain(c);
      expect(stored).not.toContain(c.replace(/-/g, ""));
    }
    expect(rows.map((r) => r.codeHash).sort()).toEqual(codes.map((c) => hashRecoveryCode(o.id, normalizeRecoveryCode(c)!)).sort());
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: o.id, action: "RECOVERY_CODES_GENERATED" } });
    for (const c of codes) expect(audit.after).not.toContain(c.replace(/-/g, "").slice(0, 8));

    const manager = await makeUser("genmgr", [{ role: "MANAGER", outletId: outletA }]);
    await expect(generateRecoveryCodes(prisma, manager.id)).rejects.toBeInstanceOf(ForbiddenError);
    const outletOwner = await makeUser("genoutletowner", [{ role: "OWNER", outletId: outletA }]); // not org-wide
    await expect(generateRecoveryCodes(prisma, outletOwner.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("route: needs a session, then a fresh password confirmation for security.manage; response is no-store", async () => {
    const o = await owner("genroute");
    const s = await createSession(prisma, o.id);
    const cookie = { cookie: `${SESSION_COOKIE}=${s.token}` };
    expect((await codesRoute(req("/api/auth/recovery-codes", {}))).status).toBe(401);
    const noStepUp = await json(await codesRoute(req("/api/auth/recovery-codes", {}, cookie)));
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.body.error).toMatchObject({ code: "ReauthRequiredError", details: { scope: "security.manage" } });
    expect(await prisma.recoveryCode.count({ where: { userId: o.id } })).toBe(0);
    // A grant for another scope does not count.
    await grantReauth(prisma, { id: s.sessionId, userId: o.id }, { password: GOOD, scope: "staff.manage" });
    expect((await codesRoute(req("/api/auth/recovery-codes", {}, cookie))).status).toBe(403);
    await grantReauth(prisma, { id: s.sessionId, userId: o.id }, { password: GOOD, scope: "security.manage" });
    expect((await codesRoute(req("/api/auth/recovery-codes", {}, { ...cookie, origin: "https://evil.example" }))).status).toBe(403);
    const okRes = await json(await codesRoute(req("/api/auth/recovery-codes", {}, cookie)));
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get("cache-control")).toBe("no-store");
    expect(okRes.body.data.codes).toHaveLength(RECOVERY_CODE_COUNT);

    const mgr = await makeUser("genroutemgr", [{ role: "MANAGER", outletId: outletA }]);
    const ms = await createSession(prisma, mgr.id);
    await grantReauth(prisma, { id: ms.sessionId, userId: mgr.id }, { password: GOOD, scope: "security.manage" });
    expect((await codesRoute(req("/api/auth/recovery-codes", {}, { cookie: `${SESSION_COOKIE}=${ms.token}` }))).status).toBe(403);
  });

  it("a new set invalidates every earlier code", async () => {
    const o = await owner("regen");
    const first = await generateRecoveryCodes(prisma, o.id);
    const second = await generateRecoveryCodes(prisma, o.id);
    await expect(redeemRecoveryCode(prisma, { email: o.email, code: first.codes[0], newPassword: NEW })).rejects.toThrow(INVALID_RECOVERY_MESSAGE);
    await expect(redeemRecoveryCode(prisma, { email: o.email, code: second.codes[0], newPassword: NEW })).resolves.toMatchObject({ remaining: RECOVERY_CODE_COUNT - 1 });
  });
});

describe("redeeming a recovery code", () => {
  it("sets the password, consumes exactly that code, revokes every session and retires password links", async () => {
    const o = await owner("redeem");
    const { codes } = await generateRecoveryCodes(prisma, o.id);
    const s1 = await createSession(prisma, o.id);
    const s2 = await createSession(prisma, o.id);
    const link = await issuePasswordToken(prisma, { organizationId: orgId, userId: o.id, purpose: "RESET" });
    const res = await redeemRecoveryCode(prisma, { email: o.email.toUpperCase(), code: codes[3].toLowerCase().replace(/-/g, " "), newPassword: NEW });
    expect(res).toMatchObject({ email: o.email, remaining: RECOVERY_CODE_COUNT - 1, sessionsRevoked: 2 });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: o.id } });
    expect(await verifyPassword(NEW, after.passwordHash)).toBe(true);
    expect(await validateToken(prisma, s1.token)).toBeNull();
    expect(await validateToken(prisma, s2.token)).toBeNull();
    await expect(findUsablePasswordToken(prisma, link.token)).rejects.toThrow(INVALID_TOKEN_MESSAGE);
    const used = await prisma.auditLog.findFirstOrThrow({ where: { entityId: o.id, action: "RECOVERY_CODE_USED" } });
    expect(JSON.parse(used.after!)).toMatchObject({ remaining: RECOVERY_CODE_COUNT - 1, sessionsRevoked: 2 });
    expect((await recoveryStatus(prisma, o.id)).remaining).toBe(RECOVERY_CODE_COUNT - 1);
  });

  it("single use: the same code never works twice, even concurrently", async () => {
    const o = await owner("single");
    const { codes } = await generateRecoveryCodes(prisma, o.id);
    const results = await Promise.allSettled([
      redeemRecoveryCode(prisma, { email: o.email, code: codes[0], newPassword: NEW }),
      redeemRecoveryCode(prisma, { email: o.email, code: codes[0], newPassword: "Biryani$Night88" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(redeemRecoveryCode(prisma, { email: o.email, code: codes[0], newPassword: NEW })).rejects.toThrow(INVALID_RECOVERY_MESSAGE);
    expect(await prisma.recoveryCode.count({ where: { userId: o.id, usedAt: { not: null } } })).toBe(1);
  });

  it("invalid codes: unknown email, wrong code, another owner's code, a non-owner all get the same error; failures are audited", async () => {
    const a = await owner("inva");
    const b = await owner("invb");
    const { codes: aCodes } = await generateRecoveryCodes(prisma, a.id);
    const { codes: bCodes } = await generateRecoveryCodes(prisma, b.id);
    const attempts = [
      { email: `ghost-${RUN}@rec.test`, code: aCodes[0] },
      { email: a.email, code: newRecoveryCode() },
      { email: a.email, code: bCodes[0] }, // B's real code does not work for A
      { email: a.email, code: "not a code" },
    ];
    for (const at of attempts) {
      const err = await redeemRecoveryCode(prisma, { ...at, newPassword: NEW }).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toBe(INVALID_RECOVERY_MESSAGE);
    }
    await settleAfterCommit(); // failures are audited after the response
    expect(await prisma.auditLog.count({ where: { entityId: a.id, action: "RECOVERY_CODE_FAILED" } })).toBe(3);
    // Nothing was consumed and A's password is unchanged.
    expect(await prisma.recoveryCode.count({ where: { usedAt: { not: null }, userId: { in: [a.id, b.id] } } })).toBe(0);
    expect(await verifyPassword(GOOD, (await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).passwordHash)).toBe(true);
  });

  it("a password the policy rejects does not burn the code", async () => {
    const o = await owner("weak");
    const { codes } = await generateRecoveryCodes(prisma, o.id);
    await expect(redeemRecoveryCode(prisma, { email: o.email, code: codes[0], newPassword: "weak" })).rejects.toBeInstanceOf(ValidationError);
    await expect(redeemRecoveryCode(prisma, { email: o.email, code: codes[0], newPassword: NEW })).resolves.toMatchObject({ remaining: RECOVERY_CODE_COUNT - 1 });
  });

  it("codes stop working when the user is no longer an active owner", async () => {
    const keeper = await owner("keeper");
    const o = await owner("demoted");
    const { codes } = await generateRecoveryCodes(prisma, o.id);
    const keeperCtx = await buildAccessContext(prisma, keeper.id);
    const m = await prisma.membership.findFirstOrThrow({ where: { userId: o.id, role: "OWNER" } });
    await revokeMembership(keeperCtx, m.id);
    await expect(redeemRecoveryCode(prisma, { email: o.email, code: codes[0], newPassword: NEW })).rejects.toThrow(INVALID_RECOVERY_MESSAGE);
    // Demotion destroys the codes: granting OWNER again does not revive them.
    expect(await prisma.recoveryCode.count({ where: { userId: o.id } })).toBe(0);
    await assignMembership(keeperCtx, { userId: o.id, role: "OWNER" });
    await expect(redeemRecoveryCode(prisma, { email: o.email, code: codes[1], newPassword: NEW })).rejects.toThrow(INVALID_RECOVERY_MESSAGE);

    // Deactivation destroys them too, and reactivation does not revive them.
    const { codes: fresh } = await generateRecoveryCodes(prisma, o.id);
    await setUserActive(keeperCtx, o.id, false);
    await expect(redeemRecoveryCode(prisma, { email: o.email, code: fresh[0], newPassword: NEW })).rejects.toThrow(INVALID_RECOVERY_MESSAGE);
    expect(await prisma.recoveryCode.count({ where: { userId: o.id } })).toBe(0);
    await setUserActive(keeperCtx, o.id, true);
    await expect(redeemRecoveryCode(prisma, { email: o.email, code: fresh[0], newPassword: NEW })).rejects.toThrow(INVALID_RECOVERY_MESSAGE);
    // An inactive user without that cleanup (direct DB change) is still refused.
    const { codes: third } = await generateRecoveryCodes(prisma, o.id);
    await prisma.user.update({ where: { id: o.id }, data: { active: false } });
    await expect(redeemRecoveryCode(prisma, { email: o.email, code: third[0], newPassword: NEW })).rejects.toThrow(INVALID_RECOVERY_MESSAGE);
  });

  it("never writes a recovery code, the new password or a hash to the console", async () => {
    resetRateLimitStoreForTests();
    const lines: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); }));
    try {
      setSecurityMailer(fakeMailer(true).mailer); // the notice fails and is logged
      const o = await owner("logleak", { verified: true });
      const { codes } = await generateRecoveryCodes(prisma, o.id);
      await recoverRoute(req("/api/auth/recovery", { email: o.email, code: newRecoveryCode(), newPassword: NEW })); // wrong code
      await recoverRoute(req("/api/auth/recovery", { email: o.email, code: codes[0], newPassword: "weak" })); // policy refusal
      expect((await recoverRoute(req("/api/auth/recovery", { email: o.email, code: codes[0], newPassword: NEW }))).status).toBe(200);
      await settleAfterCommit();
      const out = lines.join("\n");
      expect(out).toContain("security notice delivery failed"); // something was logged
      for (const c of codes) {
        expect(out).not.toContain(c);
        expect(out).not.toContain(c.replace(/-/g, ""));
        expect(out).not.toContain(hashRecoveryCode(o.id, normalizeRecoveryCode(c)!));
      }
      expect(out).not.toContain(NEW);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("route: rate limited per email and per IP before any lookup", async () => {
    resetRateLimitStoreForTests();
    const email = `flood-${RUN}@rec.test`;
    const perEmail: number[] = [];
    for (let i = 0; i < 6; i++) perEmail.push((await recoverRoute(req("/api/auth/recovery", { email, code: newRecoveryCode(), newPassword: NEW }))).status);
    expect(perEmail.slice(0, 5)).toEqual([422, 422, 422, 422, 422]);
    expect(perEmail[5]).toBe(429);
    const fixedIp = { "x-forwarded-for": "10.77.0.9" };
    const perIp: number[] = [];
    for (let i = 0; i < 11; i++) perIp.push((await recoverRoute(req("/api/auth/recovery", { email: `ip${i}-${RUN}@rec.test`, code: newRecoveryCode(), newPassword: NEW }, fixedIp))).status);
    expect(perIp.slice(0, 10).every((s) => s === 422)).toBe(true);
    expect(perIp[10]).toBe(429);
    resetRateLimitStoreForTests();
  });

  it("route: a valid code works end to end and the old session cookie is dead", async () => {
    resetRateLimitStoreForTests();
    const o = await owner("routeok");
    const { codes } = await generateRecoveryCodes(prisma, o.id);
    const s = await createSession(prisma, o.id);
    const res = await json(await recoverRoute(req("/api/auth/recovery", { email: o.email, code: codes[9], newPassword: NEW })));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ email: o.email, remaining: 9, notice: "not_verified" });
    expect((await securityRoute(new NextRequest("http://localhost/api/auth/security", { headers: { host: "localhost", cookie: `${SESSION_COOKIE}=${s.token}` } }))).status).toBe(401);
  });
});

describe("email reset links", () => {
  it("are only issued for a verified address", async () => {
    const sent: string[] = [];
    setPasswordLinkDelivery(async (m) => { sent.push(m.to); });
    const unverified = await makeUser("unv", [{ role: "CASHIER", outletId: outletA }]);
    const verified = await makeUser("ver", [{ role: "CASHIER", outletId: outletA }], { verified: true });
    await requestPasswordReset(prisma, { email: unverified.email });
    await requestPasswordReset(prisma, { email: verified.email });
    expect(sent).toEqual([verified.email]);
    expect(await prisma.passwordToken.count({ where: { userId: unverified.id } })).toBe(0);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { entityId: unverified.id, action: "PASSWORD_RESET_REQUEST" } });
    expect(JSON.parse(row.after!)).toMatchObject({ delivered: false, reason: "email_not_verified" });
  });

  it("expire after an hour and work once", async () => {
    const u = await makeUser("expiry", [{ role: "CASHIER", outletId: outletA }]);
    const issuedAt = new Date();
    const t = await issuePasswordToken(prisma, { organizationId: orgId, userId: u.id, purpose: "RESET" }, issuedAt);
    await expect(findUsablePasswordToken(prisma, t.token, new Date(issuedAt.getTime() + PASSWORD_TOKEN_TTL_MS.RESET + 1))).rejects.toThrow(INVALID_TOKEN_MESSAGE);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(issuedAt.getTime() + PASSWORD_TOKEN_TTL_MS.RESET + 1000));
    await expect(completePasswordToken(prisma, { token: t.token, password: NEW })).rejects.toThrow(INVALID_TOKEN_MESSAGE);
    vi.useRealTimers();
    const fresh = await issuePasswordToken(prisma, { organizationId: orgId, userId: u.id, purpose: "RESET" });
    await completePasswordToken(prisma, { token: fresh.token, password: NEW });
    await expect(completePasswordToken(prisma, { token: fresh.token, password: GOOD })).rejects.toThrow(INVALID_TOKEN_MESSAGE);
  });
});

describe("email verification", () => {
  it("not configured: the request fails loudly with the settings to fix, and nothing is issued", async () => {
    setSecurityMailer(null);
    const u = await makeUser("nocfg", [{ role: "CASHIER", outletId: outletA }]);
    await expect(requestEmailVerification(prisma, u.id)).rejects.toThrow(EMAIL_NOT_CONFIGURED_MESSAGE);
    expect(await prisma.passwordToken.count({ where: { userId: u.id } })).toBe(0);
    const s = await createSession(prisma, u.id);
    const res = await json(await verifyRequestRoute(req("/api/auth/email/verify-request", {}, { cookie: `${SESSION_COOKIE}=${s.token}` })));
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: "EmailNotConfigured" });
    expect(res.body.error.message).toContain("RESEND_API_KEY");
    const status = await json(await securityRoute(new NextRequest("http://localhost/api/auth/security", { headers: { host: "localhost", cookie: `${SESSION_COOKIE}=${s.token}` } })));
    expect(status.body.data.emailDelivery.configured).toBe(false);
  });

  it("delivery failure: reported to the user, the link is retired and the failure audited", async () => {
    setSecurityMailer(fakeMailer(true).mailer);
    const u = await makeUser("vfail", [{ role: "CASHIER", outletId: outletA }]);
    const err = await requestEmailVerification(prisma, u.id).catch((e) => e);
    expect(err).toMatchObject({ name: "EmailDeliveryFailed", status: 503 });
    expect(await prisma.passwordToken.count({ where: { userId: u.id, usedAt: null } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityId: u.id, action: "EMAIL_VERIFICATION_FAILED" } })).toBe(1);
  });

  it("a verification link confirms the address once; it can never set a password, and a reset link cannot verify", async () => {
    const { mailer, sent } = fakeMailer();
    setSecurityMailer(mailer);
    const u = await makeUser("verify", [{ role: "CASHIER", outletId: outletA }]);
    const res = await requestEmailVerification(prisma, u.id);
    expect(res.status).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(u.email);
    const token = new URL(sent[0].text.match(/https:\/\/\S+/)![0]).hash.replace("#token=", "");
    await expect(completePasswordToken(prisma, { token, password: NEW })).rejects.toThrow(INVALID_TOKEN_MESSAGE);
    const reset = await issuePasswordToken(prisma, { organizationId: orgId, userId: u.id, purpose: "RESET" });
    await expect(confirmEmailVerification(prisma, { token: reset.token })).rejects.toThrow(INVALID_VERIFY_MESSAGE);
    // Issuing the reset link did not retire the verification link (different kinds).
    const ok = await json(await verifyRoute(req("/api/auth/email/verify", { token })));
    expect(ok).toMatchObject({ status: 200, body: { data: { email: u.email } } });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).emailVerifiedAt).not.toBeNull();
    expect((await json(await verifyRoute(req("/api/auth/email/verify", { token })))).status).toBe(422);
    await expect(requestEmailVerification(prisma, u.id)).resolves.toMatchObject({ status: "already_verified" });
  });

  it("verification links expire after 24 hours", async () => {
    const { mailer, sent } = fakeMailer();
    setSecurityMailer(mailer);
    const u = await makeUser("vexp", [{ role: "CASHIER", outletId: outletA }]);
    await requestEmailVerification(prisma, u.id);
    const token = new URL(sent[0].text.match(/https:\/\/\S+/)![0]).hash.replace("#token=", "");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + PASSWORD_TOKEN_TTL_MS.VERIFY_EMAIL + 1000));
    await expect(confirmEmailVerification(prisma, { token })).rejects.toThrow(INVALID_VERIFY_MESSAGE);
  });
});

describe("password-change notices", () => {
  it("a verified address is told about a change, a link reset and a recovery-code reset", async () => {
    const { mailer, sent } = fakeMailer();
    setSecurityMailer(mailer);
    const o = await owner("notice", { verified: true });
    const s = await createSession(prisma, o.id);
    expect((await changePassword(prisma, { userId: o.id, sessionToken: s.token }, { currentPassword: GOOD, newPassword: NEW })).notice).toBe("sent");
    const link = await issuePasswordToken(prisma, { organizationId: orgId, userId: o.id, purpose: "RESET" });
    expect((await completePasswordToken(prisma, { token: link.token, password: GOOD })).notice).toBe("sent");
    const { codes } = await generateRecoveryCodes(prisma, o.id);
    expect((await redeemRecoveryCode(prisma, { email: o.email, code: codes[0], newPassword: NEW })).notice).toBe("sent");
    await settleAfterCommit();
    expect(sent.map((m) => m.subject)).toEqual([
      "Your RESTORA password was changed",
      "Your RESTORA password was changed",
      "New RESTORA recovery codes were generated",
      "Your RESTORA password was changed",
    ]);
    expect(sent.every((m) => m.to === o.email)).toBe(true);
    expect(sent[3].text).toContain("recovery code");
    for (const m of sent) for (const c of codes) expect(m.text).not.toContain(c);
    const notices = await prisma.auditLog.findMany({ where: { entityId: o.id, action: "SECURITY_NOTICE" } });
    expect(notices.map((r) => JSON.parse(r.after!).delivered)).toEqual([true, true, true, true]);
  });

  it("unverified address or no email set up: nothing is sent and the reason is recorded", async () => {
    const { mailer, sent } = fakeMailer();
    setSecurityMailer(mailer);
    const u = await makeUser("nonotice", [{ role: "CASHIER", outletId: outletA }]);
    const s = await createSession(prisma, u.id);
    expect((await changePassword(prisma, { userId: u.id, sessionToken: s.token }, { currentPassword: GOOD, newPassword: NEW })).notice).toBe("not_verified");
    setSecurityMailer(null);
    const v = await makeUser("nocfgnotice", [{ role: "CASHIER", outletId: outletA }], { verified: true });
    const vs = await createSession(prisma, v.id);
    expect((await changePassword(prisma, { userId: v.id, sessionToken: vs.token }, { currentPassword: GOOD, newPassword: NEW })).notice).toBe("not_configured");
    await settleAfterCommit();
    expect(sent).toHaveLength(0);
    const reasons = await prisma.auditLog.findMany({ where: { entityId: { in: [u.id, v.id] }, action: "SECURITY_NOTICE" } });
    expect(reasons.map((r) => JSON.parse(r.after!).reason).sort()).toEqual(["email_not_configured", "email_not_verified"]);
  });

  it("a provider failure is recorded but never undoes the password change", async () => {
    setSecurityMailer(fakeMailer(true).mailer);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const u = await makeUser("provfail", [{ role: "CASHIER", outletId: outletA }], { verified: true });
      const s = await createSession(prisma, u.id);
      await changePassword(prisma, { userId: u.id, sessionToken: s.token }, { currentPassword: GOOD, newPassword: NEW });
      await settleAfterCommit();
      expect(await verifyPassword(NEW, (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash)).toBe(true);
      const row = await prisma.auditLog.findFirstOrThrow({ where: { entityId: u.id, action: "SECURITY_NOTICE" } });
      expect(JSON.parse(row.after!)).toMatchObject({ delivered: false, reason: "provider_rejected" });
    } finally {
      errors.mockRestore();
    }
  });
});

describe("no escalation through recovery", () => {
  it("a manager cannot make themselves (or anyone) an owner; an owner can add a second owner who can then issue a link", async () => {
    const first = await owner("first");
    const mgr = await makeUser("climber", [{ role: "MANAGER", outletId: outletA }]);
    const mgrCtx = await buildAccessContext(prisma, mgr.id);
    await expect(assignMembership(mgrCtx, { userId: mgr.id, role: "OWNER" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignMembership(mgrCtx, { userId: mgr.id, role: "MANAGER", outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    const other = await makeUser("other", [{ role: "CASHIER", outletId: outletA }]);
    await expect(assignMembership(mgrCtx, { userId: other.id, role: "OWNER" })).rejects.toBeInstanceOf(ForbiddenError);
    // Nor can a manager issue a password link for an owner.
    await expect(issuePasswordLink(mgrCtx, first.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.membership.count({ where: { userId: mgr.id, role: "OWNER" } })).toBe(0);

    const firstCtx = await buildAccessContext(prisma, first.id);
    const second = await makeUser("second", [{ role: "MANAGER", outletId: outletA }]);
    await assignMembership(firstCtx, { userId: second.id, role: "OWNER" });
    const secondCtx = await buildAccessContext(prisma, second.id);
    const link = await issuePasswordLink(secondCtx, first.id);
    expect(link.purpose).toBe("RESET");
    expect((await recoveryStatus(prisma, first.id)).activeOwners).toBeGreaterThanOrEqual(2);
    // An owner still cannot issue a link for themselves.
    await expect(issuePasswordLink(firstCtx, first.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
