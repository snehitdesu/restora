/**
 * The invitation e-mail for new team members (PA-03): the one-time link goes to the person through the connected e-mail provider
 * (here the mock one), is never written to the outbox or the audit trail, and a failed send never costs the creator the link.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { prisma } from "@/server/db/client";
import { ForbiddenError, ValidationError } from "@/server/db/scope";
import { createStaff } from "@/server/services/staff";
import { emailPasswordLink, sendStaffInvite } from "@/server/services/staffInvite";
import { findUsablePasswordToken } from "@/server/auth/passwordTokens";
import { MockMessagingProvider } from "@/integrations/messaging";
import { makeEnv, connectMock, uniq, type Env } from "./growthSupport";

let env: Env;
const email = (name: string) => `${name}-${uniq()}@invite.test`.toLowerCase();
const invites = (userId: string) => prisma.integrationDelivery.findMany({ where: { organizationId: env.orgId, sourceType: "User", sourceId: userId }, orderBy: { createdAt: "asc" } });
const usable = (token: string) => findUsablePasswordToken(prisma, token).then(() => true, () => false);
const sentBodies = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => c[0] as { to: string; subject?: string; body: string; channel: string });

beforeAll(async () => { env = await makeEnv("Gsi"); }, 60000);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await prisma.$disconnect(); });

describe("I. invitation e-mail", () => {
  it("I1 the e-mail carries a working one-time link; the outbox row and the audit trail do not", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://app.restora.test/");
    await connectMock(env.orgId);
    const spy = vi.spyOn(MockMessagingProvider.prototype, "send");
    const to = email("Priya");
    const created = await createStaff(env.owner, { email: to, name: "Priya", role: "CASHIER", outletId: env.outletA });
    const outcome = await emailPasswordLink(env.owner, { userId: created.id, email: created.email, name: created.name, ...created.setup });
    expect(outcome).toMatchObject({ sent: true, status: "SENT", to: expect.stringMatching(/^p\*\*\*@invite\.test$/) });

    const [mail] = sentBodies(spy);
    expect(mail).toMatchObject({ channel: "EMAIL", to });
    expect(mail.subject).toMatch(/account is ready/);
    expect(mail.body).toContain(`https://app.restora.test/set-password#token=${encodeURIComponent(created.setup.token)}`);
    expect(mail.body).toMatch(/works once and expires/);
    // The link in the e-mail is the one that works.
    expect(await usable(created.setup.token)).toBe(true);

    const [row] = await invites(created.id);
    expect(row).toMatchObject({ kind: "MESSAGE", status: "SENT", mode: "MOCK", attempts: 1, maxAttempts: 1, target: expect.stringContaining("***@") });
    const everything = JSON.stringify([row, await prisma.auditLog.findMany({ where: { organizationId: env.orgId, entityId: created.id, action: "MESSAGE_SEND" } })]);
    expect(everything).not.toContain(created.setup.token);
    expect(everything).not.toContain(to);
    expect(await prisma.auditLog.count({ where: { organizationId: env.orgId, entityType: "User", entityId: created.id, action: "MESSAGE_SEND" } })).toBe(1);
  });

  it("I2 sending a fresh invitation retires the old link and returns the new one either way; only someone who may manage that person can", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://app.restora.test");
    await connectMock(env.orgId);
    const created = await createStaff(env.owner, { email: email("Ravi"), name: "Ravi", role: "CAPTAIN", outletId: env.outletA });
    const r = await sendStaffInvite(env.owner, created.id);
    expect(r.invite).toMatchObject({ sent: true, status: "SENT" });
    expect(r.link.purpose).toBe("SETUP");
    expect(await usable(created.setup.token)).toBe(false); // the first link no longer works
    expect(await usable(r.link.token)).toBe(true);
    await expect(sendStaffInvite(env.cashier, created.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(sendStaffInvite(env.foreign, created.id)).rejects.toThrow();
    expect(await invites(created.id)).toHaveLength(1);
  });

  it("I3 when the provider fails the creator keeps the link; the failure is recorded without the link and is not retried by the worker", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://app.restora.test");
    await connectMock(env.orgId);
    vi.spyOn(MockMessagingProvider.prototype, "send").mockRejectedValue(new Error("Resend is down"));
    const created = await createStaff(env.owner, { email: email("Sana"), name: "Sana", role: "CAPTAIN", outletId: env.outletA });
    const outcome = await emailPasswordLink(env.owner, { userId: created.id, email: created.email, name: created.name, ...created.setup });
    expect(outcome).toMatchObject({ sent: false, status: "FAILED", reason: expect.stringContaining("Resend is down") });
    const [row] = await invites(created.id);
    expect(row).toMatchObject({ status: "FAILED", attempts: 1, maxAttempts: 1, nextAttemptAt: null });
    expect(JSON.stringify(row)).not.toContain(created.setup.token);
    expect(await usable(created.setup.token)).toBe(true); // still copyable and valid
    // A manual retry of the stored message would send a placeholder, so it is refused.
    const { deliverMessage } = await import("@/server/services/messaging");
    await expect(deliverMessage(env.owner, row.id)).rejects.toThrow(/Gave up/);
  });

  it("I4 nothing is sent, and the old link is kept, when no e-mail provider is connected or the app has no public address", async () => {
    const lone = await makeEnv("Gsj");
    const created = await createStaff(lone.owner, { email: email("Tara"), name: "Tara", role: "CAPTAIN", outletId: lone.outletA });
    vi.stubEnv("PUBLIC_BASE_URL", "https://app.restora.test");
    await expect(sendStaffInvite(lone.owner, created.id)).rejects.toThrow(/No e-mail provider/);
    expect(await usable(created.setup.token)).toBe(true);
    expect(await emailPasswordLink(lone.owner, { userId: created.id, email: created.email, ...created.setup })).toMatchObject({ sent: false, status: "NOT_SENT", reason: expect.stringMatching(/No e-mail provider/) });

    await connectMock(lone.orgId);
    vi.stubEnv("PUBLIC_BASE_URL", "");
    await expect(sendStaffInvite(lone.owner, created.id)).rejects.toBeInstanceOf(ValidationError);
    await expect(sendStaffInvite(lone.owner, created.id)).rejects.toThrow(/PUBLIC_BASE_URL/);
    expect(await usable(created.setup.token)).toBe(true);
    expect(await prisma.integrationDelivery.count({ where: { organizationId: lone.orgId } })).toBe(0);
  });

  it("I5 the same link is never e-mailed twice", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://app.restora.test");
    await connectMock(env.orgId);
    const spy = vi.spyOn(MockMessagingProvider.prototype, "send");
    const created = await createStaff(env.owner, { email: email("Uma"), name: "Uma", role: "CAPTAIN", outletId: env.outletA });
    const link = { userId: created.id, email: created.email, name: created.name, ...created.setup };
    await emailPasswordLink(env.owner, link);
    const again = await emailPasswordLink(env.owner, link);
    expect(again).toMatchObject({ sent: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
