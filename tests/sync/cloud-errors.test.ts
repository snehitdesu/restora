/**
 * Cloud error classification and HTTP mapping used by the desktop POS.
 * A reachable-but-unavailable cloud (503), a network failure, and a revoked
 * device must not be collapsed into a generic 500 or a healthy ONLINE state.
 */
import { describe, it, expect } from "vitest";
import { fail } from "@/server/api/respond";
import {
  CloudAuthError,
  CloudClient,
  CloudHttpError,
  CloudOfflineError,
  CloudUnavailableError,
  isTransientCloudError,
} from "@/server/sync/cloudClient";
import { nextDelay } from "@/server/sync/scheduler";

const json = async (res: Response) => res.json() as Promise<{ ok: boolean; error?: { code?: string; message?: string } }>;

describe("cloud error HTTP mapping", () => {
  it("maps a reachable-but-unavailable cloud to 503 with a safe message, not Internal server error", async () => {
    const res = fail(new CloudUnavailableError());
    expect(res.status).toBe(503);
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect(body.error?.message).not.toBe("Internal server error");
    expect(body.error?.message).toMatch(/cloud|unavailable|reachable|moment/i);
    expect(JSON.stringify(body)).not.toMatch(/Bearer |postgresql:\/\/|qrToken/i);
  });

  it("maps a network failure to 503 unavailable, not a 500", async () => {
    const res = fail(new CloudOfflineError());
    expect(res.status).toBe(503);
    const body = await json(res);
    expect(body.error?.message).not.toBe("Internal server error");
    expect(body.error?.message).toMatch(/cloud|reach/i);
  });

  it("maps revoked or expired credentials to 401, not a network 503", async () => {
    const res = fail(new CloudAuthError("The cloud session is no longer valid"));
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.error?.message).not.toBe("Internal server error");
    expect(body.error?.message).toMatch(/session|sign-in|valid/i);
  });
});

describe("CloudClient status classification", () => {
  const token = "desk-secret-token-value";

  it("treats HTTP 503 as unavailable/transient and never echoes the credential", async () => {
    const client = new CloudClient({
      baseUrl: "https://cloud.restora.test",
      token,
      transport: async () => new Response(JSON.stringify({ ok: false, error: { code: "Unavailable", message: `Bearer ${token} overloaded` } }), { status: 503 }),
    });
    const err = await client.get("/api/sync/orders").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudUnavailableError);
    expect(isTransientCloudError(err)).toBe(true);
    expect(String(err instanceof Error ? err.message : err)).not.toContain(token);
  });

  it("treats a dropped connection as offline, not auth", async () => {
    const client = new CloudClient({
      baseUrl: "https://cloud.restora.test",
      token,
      transport: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const err = await client.get("/api/sync/orders").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudOfflineError);
    expect(isTransientCloudError(err)).toBe(true);
    expect(err).not.toBeInstanceOf(CloudAuthError);
  });

  it("treats HTTP 401 as auth, not a network failure", async () => {
    const client = new CloudClient({
      baseUrl: "https://cloud.restora.test",
      token,
      transport: async () => new Response(JSON.stringify({ ok: false, error: { message: "Device revoked" } }), { status: 401 }),
    });
    const err = await client.get("/api/sync/orders").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudAuthError);
    expect(isTransientCloudError(err)).toBe(false);
  });

  it("treats HTTP 403 as a permanent client error, not offline", async () => {
    const client = new CloudClient({
      baseUrl: "https://cloud.restora.test",
      token,
      transport: async () => new Response(JSON.stringify({ ok: false, error: { code: "ForbiddenError", message: "Forbidden" } }), { status: 403 }),
    });
    const err = await client.get("/api/sync/orders").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudHttpError);
    expect((err as CloudHttpError).status).toBe(403);
    expect(isTransientCloudError(err)).toBe(false);
  });
});

describe("sync loop backoff", () => {
  it("backs off on repeated failures and stays capped, with no zero-delay retry loop", () => {
    const rand = () => 0;
    expect(nextDelay(4_000, 0, rand)).toBeGreaterThanOrEqual(1_000);
    expect(nextDelay(4_000, 2, rand)).toBeGreaterThan(nextDelay(4_000, 1, rand));
    expect(nextDelay(4_000, 20, rand)).toBeLessThanOrEqual(30_000);
  });
});
