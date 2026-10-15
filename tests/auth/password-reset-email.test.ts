/**
 * Password-reset email via Resend's emails API.
 *
 * The HTTP boundary is stubbed. A 2xx body with an id is the only success.
 * These tests do not open a database.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "@/server/auth/session";
import { completePasswordToken, passwordLinkDeliveryConfigured, registerPasswordResetDelivery, requestPasswordReset, setPasswordLinkDelivery, RESET_ACCEPTED_MESSAGE } from "@/server/auth/account";
import { passwordResetUrl } from "@/server/auth/passwordResetMail";
import { INVALID_TOKEN_MESSAGE, PASSWORD_TOKEN_TTL_MS, findUsablePasswordToken, issuePasswordToken } from "@/server/auth/passwordTokens";
import { validateProductionEnv } from "@/server/config/env";

const API_KEY = "re_unit_test_key_not_real_0000";
const FROM = "RESTORA <reset@example.com>";
const BASE = "https://demo.example";
const GOOD = "Kitchen#Pass42";

type UserRow = { id: string; email: string; name: string; active: boolean; organizationId: string; passwordHash: string };
type TokenRow = {
  id: string;
  organizationId: string;
  userId: string;
  purpose: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdById: string | null;
  user?: UserRow;
};
type AuditRow = { id: string; action: string; after: string; entityId: string };

function createDb(user: UserRow | null) {
  const tokens: TokenRow[] = [];
  const audits: AuditRow[] = [];
  let n = 0;
  const db = {
    user: {
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
        if (!user) return null;
        if (where.email && where.email !== user.email) return null;
        if (where.id && where.id !== user.id) return null;
        return user;
      },
      updateMany: async ({ where, data }: { where: { id: string; active?: boolean; passwordHash?: string }; data: { passwordHash: string } }) => {
        if (!user || user.id !== where.id || (where.active === true && !user.active)) return { count: 0 };
        if (where.passwordHash !== undefined && where.passwordHash !== user.passwordHash) return { count: 0 };
        user.passwordHash = data.passwordHash;
        return { count: 1 };
      },
    },
    session: {
      updateMany: async () => ({ count: 0 }),
    },
    passwordToken: {
      updateMany: async ({ where, data }: { where: { id?: string; userId?: string; tokenHash?: string; usedAt?: null; expiresAt?: { gt: Date } }; data: { usedAt: Date } }) => {
        let count = 0;
        for (const t of tokens) {
          if (where.id && t.id !== where.id) continue;
          if (where.tokenHash && t.tokenHash !== where.tokenHash) continue;
          if (where.userId && t.userId !== where.userId) continue;
          if (where.usedAt === null && t.usedAt !== null) continue;
          if (where.expiresAt && !(t.expiresAt > where.expiresAt.gt)) continue;
          t.usedAt = data.usedAt;
          count++;
        }
        return { count };
      },
      create: async ({ data }: { data: Omit<TokenRow, "id" | "usedAt" | "user"> }) => {
        const row: TokenRow = { id: `tok-${++n}`, usedAt: null, ...data };
        tokens.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
        const t = tokens.find((row) => row.tokenHash === where.tokenHash);
        return t && user ? { ...t, user } : null;
      },
    },
    auditLog: {
      create: async ({ data }: { data: { action: string; after: string; entityId: string } }) => {
        const row = { id: `aud-${++n}`, action: data.action, after: data.after, entityId: data.entityId };
        audits.push(row);
        return { id: row.id };
      },
      // Like the database (append-only triggers on AuditLog): history is never rewritten.
      update: async () => {
        throw new Error("AuditLog is append-only: UPDATE is not allowed");
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return { db, tokens, audits };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installEnv() {
  process.env.RESEND_API_KEY = API_KEY;
  process.env.RESEND_FROM = FROM;
  process.env.PUBLIC_BASE_URL = BASE;
}

function clearEnv() {
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
  delete process.env.PUBLIC_BASE_URL;
}

afterEach(() => {
  setPasswordLinkDelivery(null);
  clearEnv();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Resend password-reset delivery", () => {
  it("sends the reset link and records delivery only after Resend accepts it", async () => {
    installEnv();
    const user: UserRow = { id: "user-1", email: "ada@example.com", name: "Ada <script>", active: true, organizationId: "org-1", passwordHash: "old" };
    const { db, tokens, audits } = createDb(user);
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "email_123" }));
    vi.stubGlobal("fetch", fetchMock);

    await requestPasswordReset(db as never, { email: "Ada@Example.com" });

    expect(passwordLinkDeliveryConfigured()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body.from).toBe(FROM);
    expect(body.to).toEqual(["ada@example.com"]);
    expect(body.subject).toContain("RESTORA");
    const token = String(body.text).match(/\/set-password#token=([A-Za-z0-9_-]{43})/)?.[1];
    expect(token).toBeTruthy();
    expect(body.html).toContain(`/set-password#token=${token}`);
    expect(body.html).toContain("Ada &lt;script&gt;");
    expect(body.html).not.toContain("Ada <script>");
    expect(String(body.text)).not.toContain("?token=");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].purpose).toBe("RESET");
    expect(tokens[0].tokenHash).toBe(hashToken(token!));
    expect(tokens[0].usedAt).toBeNull();
    expect(Math.abs(tokens[0].expiresAt.getTime() - Date.now() - PASSWORD_TOKEN_TTL_MS.RESET)).toBeLessThan(5_000);
    // The request is recorded when it is made; the delivery is a second row (the audit log is append-only).
    expect(audits.map((a) => a.action)).toEqual(["PASSWORD_RESET_REQUEST", "PASSWORD_RESET_DELIVERED"]);
    expect(JSON.parse(audits[1].after)).toMatchObject({ delivered: true });
    expect(JSON.stringify(audits)).not.toContain(token!);
    expect(JSON.stringify(audits)).not.toContain(API_KEY);
  });

  it("does not send or issue a token when Resend is not configured", async () => {
    clearEnv();
    const user: UserRow = { id: "user-2", email: "bea@example.com", name: "Bea", active: true, organizationId: "org-1", passwordHash: "old" };
    const { db, tokens, audits } = createDb(user);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestPasswordReset(db as never, { email: user.email })).resolves.toBeUndefined();
    await expect(requestPasswordReset(createDb(null).db as never, { email: "missing@example.com" })).resolves.toBeUndefined();

    expect(passwordLinkDeliveryConfigured()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokens).toHaveLength(0);
    expect(JSON.parse(audits[0].after)).toMatchObject({ delivered: false });
  });

  it("does not report delivery and retires the token when Resend rejects the email", async () => {
    installEnv();
    const user: UserRow = { id: "user-3", email: "cy@example.com", name: "Cy", active: true, organizationId: "org-1", passwordHash: "old" };
    const { db, tokens, audits } = createDb(user);
    const fetchMock = vi.fn(async () => jsonResponse(422, { name: "validation_error", message: `Invalid from ${API_KEY}` }));
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(requestPasswordReset(db as never, { email: user.email })).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    const token = String(body.text).match(/\/set-password#token=([A-Za-z0-9_-]{43})/)?.[1];
    expect(token).toBeTruthy();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].usedAt).not.toBeNull();
    expect(JSON.parse(audits[0].after)).toMatchObject({ delivered: false });
    expect(audits).toHaveLength(1);
    const logged = errorSpy.mock.calls.flat().map(String).join("\n");
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain(token!);
    expect(logged).not.toContain(tokens[0].tokenHash);
    await expect(findUsablePasswordToken(db as never, token!)).rejects.toThrow(INVALID_TOKEN_MESSAGE);
  });

  it("a failed send retires only its own link: a newer link issued meanwhile keeps working", async () => {
    const user: UserRow = { id: "user-9", email: "eve@example.com", name: "Eve", active: true, organizationId: "org-1", passwordHash: "old" };
    const { db, tokens } = createDb(user);
    let newer: string | null = null;
    // While the first email is in flight, a second request issues (and delivers) a newer link.
    setPasswordLinkDelivery(async () => {
      newer = (await issuePasswordToken(db as never, { organizationId: "org-1", userId: user.id, purpose: "RESET" })).token;
      throw new Error("provider timeout");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await requestPasswordReset(db as never, { email: user.email });
    expect(tokens).toHaveLength(2);
    expect(newer).toBeTruthy();
    await expect(findUsablePasswordToken(db as never, newer!)).resolves.toMatchObject({ userId: user.id });
  });

  it("treats a success body without an email id as a failed delivery", async () => {
    installEnv();
    const user: UserRow = { id: "user-4", email: "dee@example.com", name: "Dee", active: true, organizationId: "org-1", passwordHash: "old" };
    const { db, tokens, audits } = createDb(user);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { id: "" })));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await requestPasswordReset(db as never, { email: user.email });

    expect(tokens[0].usedAt).not.toBeNull();
    expect(JSON.parse(audits[0].after)).toMatchObject({ delivered: false });
  });

  it("sends nothing for an unknown or inactive account and resolves the same way for both", async () => {
    installEnv();
    const inactive: UserRow = { id: "user-5", email: "eve@example.com", name: "Eve", active: false, organizationId: "org-1", passwordHash: "old" };
    const inactiveDb = createDb(inactive);
    const unknownDb = createDb(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const inactiveResult = await requestPasswordReset(inactiveDb.db as never, { email: inactive.email });
    const unknownResult = await requestPasswordReset(unknownDb.db as never, { email: "nobody@example.com" });

    expect(inactiveResult).toBeUndefined();
    expect(unknownResult).toBeUndefined();
    expect(inactiveResult).toBe(unknownResult);
    expect(RESET_ACCEPTED_MESSAGE).toContain("If an active account exists");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inactiveDb.tokens).toHaveLength(0);
    expect(unknownDb.audits).toHaveLength(0);
  });

  it("puts the token in the fragment of the public reset URL", () => {
    const token = "A".repeat(43);
    expect(passwordResetUrl(`${BASE}/`, token)).toBe(`${BASE}/set-password#token=${token}`);
    expect(passwordResetUrl(BASE, token)).toBe(`${BASE}/set-password#token=${token}`);
    expect(passwordResetUrl(BASE, token)).not.toContain("?token=");
  });

  it("registers Resend on server startup when configured and does not replace an existing sender", async () => {
    const startup = fs.readFileSync(path.join(process.cwd(), "src/instrumentation-node.ts"), "utf8");
    expect(startup).toContain("registerPasswordResetDelivery()");

    clearEnv();
    registerPasswordResetDelivery();
    expect(passwordLinkDeliveryConfigured()).toBe(false);

    installEnv();
    registerPasswordResetDelivery();
    expect(passwordLinkDeliveryConfigured()).toBe(true);

    const seen: string[] = [];
    setPasswordLinkDelivery(async (msg) => { seen.push(msg.to); });
    registerPasswordResetDelivery();
    const user: UserRow = { id: "user-7", email: "gia@example.com", name: "Gia", active: true, organizationId: "org-1", passwordHash: "old" };
    const { db, tokens, audits } = createDb(user);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await requestPasswordReset(db as never, { email: user.email });
    expect(seen).toEqual(["gia@example.com"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokens[0]?.usedAt).toBeNull();
    expect(audits.map((a) => a.action)).toEqual(["PASSWORD_RESET_REQUEST", "PASSWORD_RESET_DELIVERED"]);
    expect(JSON.parse(audits[1].after)).toMatchObject({ delivered: true });
  });

  it("rejects an expired reset token and accepts a token only once", async () => {
    const user: UserRow = { id: "user-6", email: "fay@example.com", name: "Fay", active: true, organizationId: "org-1", passwordHash: "old" };
    const { db, tokens } = createDb(user);
    const issued = await issuePasswordToken(db as never, { organizationId: user.organizationId, userId: user.id, purpose: "RESET" }, new Date(Date.now() - PASSWORD_TOKEN_TTL_MS.RESET - 60_000));
    await expect(completePasswordToken(db as never, { token: issued.token, password: GOOD })).rejects.toThrow(INVALID_TOKEN_MESSAGE);
    expect(user.passwordHash).toBe("old");

    const fresh = await issuePasswordToken(db as never, { organizationId: user.organizationId, userId: user.id, purpose: "RESET" });
    expect(tokens.filter((t) => t.usedAt === null)).toHaveLength(1);
    await completePasswordToken(db as never, { token: fresh.token, password: GOOD });
    expect(user.passwordHash).not.toBe("old");
    await expect(completePasswordToken(db as never, { token: fresh.token, password: "Tandoor!Night77" })).rejects.toThrow(INVALID_TOKEN_MESSAGE);
  });
});

describe("production validation for Resend", () => {
  const prod: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    DATABASE_URL: "file:./prod.db",
    AUTH_SECRET: "a-sufficiently-long-production-secret-value-0123456789",
  };

  it("accepts a complete Resend configuration and refuses a partial one without echoing the key", () => {
    expect(() => validateProductionEnv({ ...prod, RESEND_API_KEY: API_KEY, RESEND_FROM: FROM, PUBLIC_BASE_URL: BASE })).not.toThrow();
    let message = "";
    try {
      validateProductionEnv({ ...prod, RESEND_API_KEY: API_KEY });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("RESEND_FROM");
    expect(message).toContain("PUBLIC_BASE_URL");
    expect(message).not.toContain(API_KEY);
  });
});
