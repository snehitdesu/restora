/**
 * Route authorization for GET/POST /api/cron/worker.
 * runWorkerTick is mocked here so an authorized call cannot claim or send real jobs.
 * Claim and idempotency of the tick itself are covered in tests/domain/scheduled-jobs.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db/client";
import { GET as cronGet, POST as cronPost } from "@/app/api/cron/worker/route";
import { inProcessWorkerEnabled } from "@/server/ops/worker";
import { getExportRunner, InlineExportRunner } from "@/server/services/exportJobs";

const SECRET = "cron-secret-value-for-tests-not-real";
const runWorkerTick = vi.hoisted(() => vi.fn());

vi.mock("@/server/ops/worker", async () => {
  const actual = await vi.importActual<typeof import("@/server/ops/worker")>("@/server/ops/worker");
  return { ...actual, runWorkerTick };
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  runWorkerTick.mockReset();
});

function withSecret(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const prev = process.env.CRON_SECRET;
  if (value === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = value;
  return run().finally(() => {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  });
}

describe("cron worker route authorization", () => {
  it("refuses a missing or wrong secret and does not run the worker", async () => {
    await withSecret(undefined, async () => {
      const missing = await cronGet(new Request("http://localhost/api/cron/worker", { headers: { authorization: `Bearer ${SECRET}` } }));
      expect(missing.status).toBe(401);
      expect(JSON.stringify(await missing.json())).not.toContain(SECRET);
    });
    await withSecret(SECRET, async () => {
      const wrong = await cronPost(new Request("http://localhost/api/cron/worker", { headers: { authorization: "Bearer wrong" } }));
      expect(wrong.status).toBe(401);
      const body = await wrong.json();
      expect(body).toMatchObject({ ok: false, error: { code: "UnauthorizedError" } });
      expect(JSON.stringify(body)).not.toContain(SECRET);
    });
    expect(runWorkerTick).not.toHaveBeenCalled();
  });

  it("runs the mocked tick once when the bearer matches, and does not echo the secret", async () => {
    runWorkerTick.mockResolvedValue({ retried: 0, sent: 0 });
    await withSecret(SECRET, async () => {
      const ok = await cronGet(new Request("http://localhost/api/cron/worker", { headers: { authorization: `Bearer ${SECRET}` } }));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, result: { retried: 0, sent: 0 } });
      expect(runWorkerTick).toHaveBeenCalledTimes(1);
    });
  });

  it("returns a generic error when the tick fails and does not leak the secret", async () => {
    runWorkerTick.mockRejectedValue(new Error("tick failed"));
    await withSecret(SECRET, async () => {
      const failed = await cronGet(new Request("http://localhost/api/cron/worker", { headers: { authorization: `Bearer ${SECRET}` } }));
      expect(failed.status).toBe(503);
      const body = await failed.json();
      expect(body).toMatchObject({ ok: false, error: { code: "Busy", message: "Worker tick failed" } });
      expect(JSON.stringify(body)).not.toContain(SECRET);
    });
    expect(runWorkerTick).toHaveBeenCalledTimes(1);
  });
});

describe("cron worker process settings", () => {
  it("does not run an in-process worker on Vercel; exports default to inline there", () => {
    expect(inProcessWorkerEnabled({ WORKER_DISABLED: "true" })).toBe(false);
    expect(inProcessWorkerEnabled({ VERCEL: "1" })).toBe(false);
    expect(inProcessWorkerEnabled({})).toBe(true);
    const prevV = process.env.VERCEL;
    const prevR = process.env.EXPORT_RUNNER;
    try {
      process.env.VERCEL = "1";
      delete process.env.EXPORT_RUNNER;
      expect(getExportRunner(prisma)).toBeInstanceOf(InlineExportRunner);
    } finally {
      if (prevV === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = prevV;
      if (prevR === undefined) delete process.env.EXPORT_RUNNER;
      else process.env.EXPORT_RUNNER = prevR;
    }
  });
});
