/**
 * Pending online-payment recovery.
 *
 * A guest may pay and then close the browser, lose the network, or the bank
 * may time out before RESTORA hears back; the callback may be late or lost.
 * Such a payment stays PENDING, and its QR order stays out of the kitchen.
 * This job re-asks the bank about those payments and applies the answer
 * through the normal path (payment.verifyPayment: merchant / reference /
 * amount / currency checks, compare-and-set, one settlement, one invoice, one
 * set of KOTs; a payment that arrives after the fulfilment window is recorded
 * but the order is held for staff — kitchenGate.ts).
 *
 * Evidence rules — nothing is decided on a guess:
 *  - Only payments whose provider implements getPaymentStatus are rechecked
 *    (the MOCK adapter answers UNKNOWN and is never settled by this job).
 *  - The status probe only decides whether to verify: CAPTURED or FAILED at
 *    the bank runs the full verifyPayment, which asks the bank again and
 *    checks everything. PENDING / UNKNOWN / anything else leaves it PENDING.
 *  - A timeout, network error or malformed answer leaves the payment PENDING
 *    and is counted as an error; a later run tries again.
 *
 * Fairness and bounds (each run is cheap and cannot starve anything):
 *  - Eligibility is durable (Payment.recheckedAt), not per process: a payment
 *    younger than an hour is probed at most every FAST_EVERY_MS, an older one
 *    every SLOW_EVERY_MS, whichever process or cron invocation runs the job.
 *  - The least recently probed payments go first (never probed first, then
 *    newest), the young lane before the old one: a backlog of abandoned
 *    checkouts cannot keep a fresh payment waiting.
 *  - Before probing, a run claims the payment with a compare-and-set on
 *    recheckedAt; a concurrent worker that loses the claim skips it, so two
 *    workers never probe (or settle) the same payment at once.
 *  - At most `maxCalls` probes and no new probe after `deadlineAt`, so the job
 *    fits inside a cron function's time limit (route maxDuration).
 *
 * Scheduling: the in-process maintenance worker (ops/worker.ts, every 30 s on
 * self-hosted / desktop servers) and, on Vercel, only what calls
 * /api/cron/worker or /api/cron/payments (docs/payment-safety.md §3).
 */
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { runInTx } from "@/server/services/_workflow";
import { systemContext } from "@/server/auth/context";
import { verifyPayment } from "@/server/services/payment";
import { GATEWAY_PROVIDERS, getPaymentProvider, type PaymentProvider } from "@/integrations/payment";
import { log } from "@/server/observability/log";
import { inc } from "@/server/observability/metrics";

const envInt = (name: string, d: number, min = 1) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min ? n : d;
};

/** Younger payments are still in the guest's hands (QR on screen, polling); the page's own checks and the callback cover them. */
export const RECHECK_MIN_AGE_MS = 2 * 60_000;
export const FAST_LANE_MAX_AGE_MS = 60 * 60_000;
export const recheckMaxAgeMs = () => envInt("PAYMENT_RECHECK_MAX_AGE_HOURS", 26) * 3600_000;
export const FAST_EVERY_MS = 2 * 60_000;
export const SLOW_EVERY_MS = 30 * 60_000;
/** Default probes per run: well inside a 60 s cron function even if every bank call takes its full timeout twice. */
export const DEFAULT_MAX_CALLS = 20;

export type RecheckResult = { checked: number; settled: number; failed: number; stillPending: number; skipped: number; errors: number; claimLost: number; budgetExhausted: boolean };

export type RecheckOptions = {
  minAgeMs?: number;
  maxAgeMs?: number;
  /** Most bank probes this run may make. */
  maxCalls?: number;
  /** No probe is started after this moment (the caller's time budget). */
  deadlineAt?: number;
  /** One restaurant only (an operator's targeted recheck; tests). */
  organizationId?: string;
  /** Injectable for tests; production resolves the adapter by the payment's provider name. */
  providerFor?: (name: string) => PaymentProvider;
  /** Clock for budget checks (tests). */
  clock?: () => number;
};

type Due = { id: string; organizationId: string; outletId: string; provider: string | null; providerRef: string | null; recheckedAt: Date | null };

/** Payments due for a probe in one age lane, least recently probed first (never probed first, then newest). */
function dueInLane(db: PrismaClient, now: Date, lane: { from: Date; to: Date; every: number }, take: number, organizationId?: string): Promise<Due[]> {
  return db.payment.findMany({
    where: {
      ...(organizationId ? { organizationId } : {}),
      status: "PENDING",
      provider: { in: [...GATEWAY_PROVIDERS] },
      providerRef: { not: null },
      createdAt: { gte: lane.from, lte: lane.to },
      OR: [{ recheckedAt: null }, { recheckedAt: { lte: new Date(now.getTime() - lane.every) } }],
    },
    orderBy: [{ recheckedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
    take,
    select: { id: true, organizationId: true, outletId: true, provider: true, providerRef: true, recheckedAt: true },
  });
}

/** Recheck PENDING gateway payments created between `maxAgeMs` and `minAgeMs` ago, within the call and time budget. */
export async function recheckPendingPayments(db: PrismaClient = prisma, now = new Date(), opts: RecheckOptions = {}): Promise<RecheckResult> {
  const minAgeMs = opts.minAgeMs ?? RECHECK_MIN_AGE_MS;
  const maxAgeMs = opts.maxAgeMs ?? recheckMaxAgeMs();
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;
  const clock = opts.clock ?? Date.now;
  const providerFor = opts.providerFor ?? getPaymentProvider;
  const t = now.getTime();
  const youngest = new Date(t - minAgeMs);
  const oldest = new Date(t - maxAgeMs);
  const laneSplit = new Date(t - Math.min(FAST_LANE_MAX_AGE_MS, maxAgeMs));
  const r: RecheckResult = { checked: 0, settled: 0, failed: 0, stillPending: 0, skipped: 0, errors: 0, claimLost: 0, budgetExhausted: false };
  // The young lane first; the old lane gets what is left of the budget. Over-read a little: some claims are lost or skipped.
  const fast = await dueInLane(db, now, { from: laneSplit, to: youngest, every: FAST_EVERY_MS }, maxCalls * 2, opts.organizationId);
  const slow = laneSplit > oldest ? await dueInLane(db, now, { from: oldest, to: new Date(laneSplit.getTime() - 1), every: SLOW_EVERY_MS }, maxCalls * 2, opts.organizationId) : [];

  for (const p of [...fast, ...slow]) {
    if (r.checked >= maxCalls || (opts.deadlineAt !== undefined && clock() >= opts.deadlineAt)) {
      r.budgetExhausted = true;
      break;
    }
    // Claim the turn: of two workers that read the same row, one takes it.
    // Queued like every other write (runInTx): a bare write outside the queue can lose SQLite's write lock under load.
    const claim = () => runInTx(db, (tx) => tx.payment.updateMany({ where: { id: p.id, status: "PENDING", recheckedAt: p.recheckedAt }, data: { recheckedAt: new Date(clock()) } }));
    let gateway: PaymentProvider | null = null;
    try {
      gateway = providerFor(p.provider!);
    } catch {
      gateway = null; // e.g. the MOCK adapter on a production deployment
    }
    if (!gateway?.getPaymentStatus) {
      // Not probed and nothing decided, but its turn is used up: left unstamped it would sort first
      // (never probed) on every run and, in numbers, fill the read window ahead of payable payments.
      await claim();
      r.skipped++;
      continue;
    }
    const claimed = await claim();
    if (claimed.count !== 1) {
      r.claimLost++;
      continue;
    }
    r.checked++;
    try {
      const probe = await gateway.getPaymentStatus(p.providerRef!);
      if (probe.status !== "CAPTURED" && probe.status !== "FAILED") {
        r.stillPending++;
        continue;
      }
      const res = await verifyPayment(systemContext(p.organizationId, [p.outletId]), p.id, {}, db);
      if (res.payment.status === "SUCCESS") r.settled++;
      else if (res.payment.status === "FAILED" && !res.pending) r.failed++;
      else r.stillPending++;
    } catch (e) {
      // Unreachable bank, timeout, malformed answer, a concurrent verification (409): nothing was applied; it stays PENDING.
      r.errors++;
      inc("restora_job_failures_total", { type: "payment_recheck" });
      log.warn("pending payment recheck failed", { event: "payment_recheck_failed", paymentId: p.id, provider: p.provider, error: e instanceof Error ? e.name : "error" });
    }
  }
  if (r.settled || r.failed || r.errors || r.budgetExhausted) log.info("pending payments rechecked", { event: "payment_recheck", ...r });
  return r;
}
