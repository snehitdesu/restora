/**
 * Pending-payment recovery (services/paymentRecovery.ts): fairness, claims,
 * budgets, evidence rules, and the real invocation chain
 * (GET /api/cron/worker → runWorkerTick → recheckPendingPayments, and
 * GET /api/cron/payments → recheckPendingPayments), unmocked.
 *
 * The bank is a stub provider injected per run (status answers and call
 * counts); settlement goes through the real payment.verifyPayment with the
 * MOCK adapter. Classification: LOCAL tests.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import type { AccessContext } from "@/server/db/scope";
import { createMenuItem } from "@/server/services/menu";
import { placeOrder } from "@/server/services/orders";
import { createPayment } from "@/server/services/payment";
import { recheckPendingPayments, FAST_EVERY_MS, SLOW_EVERY_MS } from "@/server/services/paymentRecovery";
import { runWorkerTick } from "@/server/ops/worker";
import { GET as cronWorker } from "@/app/api/cron/worker/route";
import { GET as cronPayments, POST as cronPaymentsPost } from "@/app/api/cron/payments/route";
import { MockPaymentProvider, type PaymentProvider, type ProviderPaymentStatus } from "@/integrations/payment";

const RUN = Date.now().toString(36);
const SECRET = `cron-secret-${RUN}-not-real-0000000000`;
let orgId: string, outletId: string, sys: AccessContext, item: string;
let n = 0;

/** A bank stub: answers `answer(ref)` and counts probes per reference. */
function stubBank(answer: (ref: string) => ProviderPaymentStatus["status"] | Promise<never> = () => "PENDING") {
  const probes = new Map<string, number>();
  const provider = new MockPaymentProvider() as PaymentProvider;
  provider.getPaymentStatus = async (ref: string) => {
    probes.set(ref, (probes.get(ref) ?? 0) + 1);
    const status = await answer(ref);
    return { providerRef: ref, amount: 0, status };
  };
  return { probes, providerFor: () => provider };
}

/** A PENDING online payment `ageMs` old with a gateway reference. */
async function pending(ageMs: number, opts: { recheckedAgoMs?: number } = {}) {
  const order = await placeOrder(sys, { outletId, channel: "DINE_IN", items: [{ menuItemId: item, qty: 1 }] });
  const p = await createPayment(sys, order.id, { method: "ONLINE", amount: Number(order.total), provider: "mock", idempotencyKey: `rec-${RUN}-${++n}-abcdefgh` });
  const ref = `ref-${RUN}-${n}`;
  await prisma.payment.update({ where: { id: p.id }, data: { providerRef: ref, createdAt: new Date(Date.now() - ageMs), recheckedAt: opts.recheckedAgoMs === undefined ? null : new Date(Date.now() - opts.recheckedAgoMs) } });
  return { id: p.id, ref, orderId: order.id };
}
const MIN = 60_000;
/** Fixtures one at a time: SQLite has a single writer. */
async function many(count: number, ageMs: number) {
  const out: Awaited<ReturnType<typeof pending>>[] = [];
  for (let i = 0; i < count; i++) out.push(await pending(ageMs));
  return out;
}
const scoped = (extra: Parameters<typeof recheckPendingPayments>[2] = {}) => ({ organizationId: orgId, ...extra });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Recovery Org ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `RC${RUN}`, name: "Recovery Café" } })).id;
  sys = systemContext(orgId, [outletId]);
  await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId, name: "KITCHEN", kind: "KITCHEN" } });
  item = (await createMenuItem(sys, { name: `Idli ${RUN}`, price: 60, taxPct: 5, station: "KITCHEN" })).id;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  // Each test starts from no pending payments in this restaurant.
  await prisma.payment.updateMany({ where: { organizationId: orgId, status: "PENDING" }, data: { status: "FAILED" } });
});

describe("evidence rules", () => {
  it("only a CAPTURED / FAILED probe leads to verification; PENDING and UNKNOWN leave the payment untouched (but probed)", async () => {
    const a = await pending(5 * MIN);
    const b = await pending(5 * MIN);
    const bank = stubBank((ref) => (ref === a.ref ? "PENDING" : "UNKNOWN"));
    const r = await recheckPendingPayments(prisma, new Date(), scoped({ providerFor: bank.providerFor }));
    expect(r).toMatchObject({ checked: 2, stillPending: 2, settled: 0, failed: 0 });
    for (const p of [a, b]) {
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
      expect(row.status).toBe("PENDING");
      expect(row.recheckedAt).not.toBeNull();
    }
  });

  it("a bank error or timeout decides nothing; the payment is tried again on a later run", async () => {
    const a = await pending(5 * MIN);
    const failing = stubBank(() => Promise.reject(new Error("timeout")));
    const r = await recheckPendingPayments(prisma, new Date(), scoped({ providerFor: failing.providerFor }));
    expect(r).toMatchObject({ checked: 1, errors: 1, settled: 0 });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("PENDING");
    // Throttled (not re-asked within FAST_EVERY_MS), then asked again.
    const ok = stubBank(() => "CAPTURED");
    expect((await recheckPendingPayments(prisma, new Date(), scoped({ providerFor: ok.providerFor }))).checked).toBe(0);
    const later = await recheckPendingPayments(prisma, new Date(Date.now() + FAST_EVERY_MS + 1000), scoped({ providerFor: ok.providerFor, clock: () => Date.now() + FAST_EVERY_MS + 1000 }));
    expect(later.settled).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: a.orderId } })).status).toBe("PAID");
  });

  it("payments younger than 2 minutes are left to the guest's screen; older than the window are left alone", async () => {
    await pending(30_000);
    await pending(30 * 3600_000);
    const bank = stubBank();
    expect((await recheckPendingPayments(prisma, new Date(), scoped({ providerFor: bank.providerFor }))).checked).toBe(0);
  });
});

describe("fairness: abandoned checkouts cannot starve a fresh payment", () => {
  it("a fresh payment is probed first even behind 30 older never-probed abandoned ones, and the old lane rotates", async () => {
    const old = await many(30, 5 * 3600_000);
    const fresh = await pending(3 * MIN);
    const bank = stubBank();
    const r1 = await recheckPendingPayments(prisma, new Date(), scoped({ providerFor: bank.providerFor, maxCalls: 5 }));
    expect(r1).toMatchObject({ checked: 5, budgetExhausted: true });
    expect(bank.probes.get(fresh.ref)).toBe(1);
    // Next run: the probed ones wait their turn, others go — every abandoned payment is eventually reached.
    for (let i = 0; i < 6; i++) await recheckPendingPayments(prisma, new Date(), scoped({ providerFor: bank.providerFor, maxCalls: 5 }));
    expect(old.every((p) => bank.probes.get(p.ref) === 1)).toBe(true);
    expect(bank.probes.get(fresh.ref)).toBe(1); // throttled: not re-asked within FAST_EVERY_MS
  });

  it("payments whose adapter is refused here (e.g. MOCK on a production server) are skipped but still take their turn, so they cannot fill the window", async () => {
    const payable = await pending(10 * MIN);
    // Newer and never probed: these sort ahead of `payable`, more of them than one run reads (maxCalls * 2).
    const refused = await many(12, 3 * MIN);
    await prisma.payment.updateMany({ where: { id: { in: refused.map((p) => p.id) } }, data: { provider: "razorpay" } });
    const bank = stubBank();
    const providerFor = (name: string) => {
      if (name === "razorpay") throw new Error("adapter refused on this deployment");
      return bank.providerFor();
    };
    for (let i = 0; i < 3; i++) await recheckPendingPayments(prisma, new Date(), scoped({ providerFor, maxCalls: 5 }));
    expect(bank.probes.get(payable.ref)).toBe(1);
    // Nothing about the skipped payments was decided.
    expect(await prisma.payment.count({ where: { id: { in: refused.map((p) => p.id) }, status: "PENDING" } })).toBe(12);
  });

  it("an old payment is re-asked only every SLOW_EVERY_MS, a young one every FAST_EVERY_MS", async () => {
    const young = await pending(10 * MIN, { recheckedAgoMs: FAST_EVERY_MS + 5000 });
    const oldRecent = await pending(3 * 3600_000, { recheckedAgoMs: FAST_EVERY_MS + 5000 });
    const oldDue = await pending(3 * 3600_000, { recheckedAgoMs: SLOW_EVERY_MS + 5000 });
    const bank = stubBank();
    await recheckPendingPayments(prisma, new Date(), scoped({ providerFor: bank.providerFor }));
    expect(bank.probes.get(young.ref)).toBe(1);
    expect(bank.probes.get(oldRecent.ref)).toBeUndefined();
    expect(bank.probes.get(oldDue.ref)).toBe(1);
  });
});

describe("concurrency and budgets", () => {
  it("two workers at once never probe or settle the same payment twice", async () => {
    const ps = await many(6, 5 * MIN);
    const bank = stubBank(() => "CAPTURED");
    const [r1, r2] = await Promise.all([recheckPendingPayments(prisma, new Date(), scoped({ providerFor: bank.providerFor })), recheckPendingPayments(prisma, new Date(), scoped({ providerFor: bank.providerFor }))]);
    expect(r1.checked + r2.checked).toBe(6);
    expect(ps.every((p) => bank.probes.get(p.ref) === 1)).toBe(true);
    expect(r1.settled + r2.settled).toBe(6);
    for (const p of ps) {
      expect(await prisma.kot.count({ where: { orderId: p.orderId } })).toBeLessThanOrEqual(1);
      expect(await prisma.taxInvoice.count({ where: { sourceKey: `inv:${p.orderId}` } })).toBe(1);
    }
  });

  it("no probe starts after the deadline, and at most maxCalls probes run", async () => {
    await many(4, 5 * MIN);
    const bank = stubBank();
    const past = await recheckPendingPayments(prisma, new Date(), scoped({ providerFor: bank.providerFor, deadlineAt: Date.now() - 1 }));
    expect(past).toMatchObject({ checked: 0, budgetExhausted: true });
    let t = Date.now();
    const slowClock = () => (t += 4000); // every probe "takes" 4 s
    const r = await recheckPendingPayments(prisma, new Date(), scoped({ providerFor: bank.providerFor, deadlineAt: Date.now() + 10_000, clock: slowClock }));
    expect(r.checked).toBeLessThan(4);
    expect(r.budgetExhausted).toBe(true);
  });
});

describe("invocation chain (unmocked)", () => {
  it("the worker tick runs housekeeping first and the payment recheck last, within its budget", async () => {
    await pending(5 * MIN);
    const tick = await runWorkerTick(prisma, new Date(), { housekeeping: true, paymentRecheck: { deadlineAt: Date.now() - 1 } });
    expect(tick.housekeeping).toBeDefined();
    expect(tick.paymentRecheck).toMatchObject({ checked: 0, budgetExhausted: true });
    expect((await runWorkerTick(prisma, new Date(), { housekeeping: false, paymentRecheck: false })).paymentRecheck).toBeUndefined();
  });

  it("GET /api/cron/worker with CRON_SECRET reaches the recovery job; without it nothing runs", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const denied = await cronWorker(new Request("http://x/api/cron/worker"));
    expect(denied.status).toBe(401);
    const ok = await cronWorker(new Request("http://x/api/cron/worker", { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { result: { paymentRecheck?: unknown } };
    expect(body.result.paymentRecheck).toMatchObject({ checked: expect.any(Number), budgetExhausted: expect.any(Boolean) });
  });

  it("GET/POST /api/cron/payments: bearer CRON_SECRET only, runs the recovery job, returns counts only", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const p = await pending(5 * MIN);
    for (const auth of [undefined, "Bearer wrong", `Basic ${SECRET}`]) {
      const r = await cronPayments(new Request("http://x/api/cron/payments", auth ? { headers: { authorization: auth } } : {}));
      expect(r.status).toBe(401);
    }
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).recheckedAt).toBeNull();
    const ok = await cronPaymentsPost(new Request("http://x/api/cron/payments", { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const text = await ok.text();
    expect(JSON.parse(text)).toMatchObject({ ok: true, result: { checked: expect.any(Number) } });
    expect(text).not.toContain(p.id);
    expect(text).not.toContain(p.ref);
    // The mock adapter answers UNKNOWN: probed, never settled.
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.recheckedAt).not.toBeNull();
    expect(row.status).toBe("PENDING");
  });
});
