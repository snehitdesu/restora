/**
 * Post-commit side effects (printing, customer messages, drawer kick,
 * aggregator status). They run AFTER the business transaction committed, are
 * never awaited by the request that triggered them, and can never fail it:
 * an integration problem is recorded on its own job / delivery row.
 *
 * Kept dependency-free so domain services can call it without import cycles;
 * the hook implementations are loaded lazily.
 */
import { log } from "@/server/observability/log";
import { inc } from "@/server/observability/metrics";

const pending = new Set<Promise<void>>();

/** Returns the tracked promise (it never rejects) for callers that must keep a serverless function alive until it settles. */
export function runAfterCommit(label: string, fn: () => Promise<unknown>): Promise<void> {
  const p: Promise<void> = (async () => {
    try {
      await fn();
    } catch (e) {
      inc("restora_job_failures_total", { type: "after_commit" });
      log.error("post-commit side effect failed", { event: "after_commit_failed", label, error: e });
    }
  })();
  pending.add(p);
  void p.finally(() => pending.delete(p));
  return p;
}

/** Wait for every scheduled side effect (tests, graceful shutdown). */
export async function settleAfterCommit(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/** A Prisma interactive-transaction client has no $transaction: side effects must wait for the outer commit. */
export const isRootClient = (db: unknown) => typeof (db as { $transaction?: unknown })?.$transaction === "function";
