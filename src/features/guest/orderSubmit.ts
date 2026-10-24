/**
 * Placing a guest order over a slow or flaky connection.
 *
 * A guest order is one idempotent request: the server keys it per table, and a
 * replay of the same Idempotency-Key returns the order it already placed (it is
 * never placed, or sent to the kitchen, twice). So a timeout or a lost response
 * does not mean the order failed — it means we do not know yet. Instead of
 * reporting a failure, the SAME request (same key, same body) is replayed a few
 * times to learn the outcome from the server:
 *
 *  - success at any attempt → the order (placed now, or recovered);
 *  - a definite refusal (4xx: validation, sold out, price changed, …) → failed.
 *    After an uncertain attempt a refusal still proves nothing was created: the
 *    replay found no order under that key and refused for the same reason;
 *  - every attempt uncertain → "unknown": the caller keeps the request and offers
 *    a safe "check again" (which replays it once more) instead of an error.
 */
import { ApiError } from "@/lib/api/client";

/** Per attempt. Well above the slowest successful placement seen (~23 s across regions). */
export const ORDER_ATTEMPT_TIMEOUT_MS = 45_000;
/** When the guest is told the café's connection is slow (the request keeps going). */
export const ORDER_SLOW_NOTICE_MS = 8_000;
/** Pauses before each replay that asks the server what became of the order. */
export const ORDER_RECONCILE_DELAYS_MS = [2_000, 5_000, 10_000];

export type SubmitPhase = "sending" | "slow" | "confirming";
export type SubmitOutcome<T> = { status: "ok"; value: T } | { status: "failed"; error: unknown } | { status: "unknown"; error: unknown };

/** The request may or may not have been carried out: no answer, a gateway/server error, a timeout. */
export function outcomeUnknown(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true; // never claim a failure we cannot explain
  return e.status === 0 || e.status === 408 || e.status >= 500;
}

export async function submitWithReconcile<T>(
  send: (attempt: number) => Promise<T>,
  opts: { onPhase?: (phase: SubmitPhase) => void; delaysMs?: number[]; slowAfterMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<SubmitOutcome<T>> {
  const delays = opts.delaysMs ?? ORDER_RECONCILE_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let uncertain = false;
  let last: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      opts.onPhase?.("confirming");
      await sleep(delays[attempt - 1]);
    } else opts.onPhase?.("sending");
    const slow = attempt === 0 ? setTimeout(() => opts.onPhase?.("slow"), opts.slowAfterMs ?? ORDER_SLOW_NOTICE_MS) : undefined;
    try {
      return { status: "ok", value: await send(attempt) };
    } catch (e) {
      last = e;
      if (outcomeUnknown(e)) {
        uncertain = true;
        continue;
      }
      // Rate limited: refused before anything ran — if an earlier attempt is still unexplained, it stays unexplained.
      if (uncertain && e instanceof ApiError && e.status === 429) continue;
      return { status: "failed", error: e };
    } finally {
      clearTimeout(slow);
    }
  }
  return { status: "unknown", error: last };
}
