/**
 * Guest order submission over a slow or flaky connection (orderSubmit.ts): an
 * answer that never came is "unknown", not a failure; the same request is
 * replayed to learn the outcome; only a definite refusal is a failure.
 */
import { describe, it, expect, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { outcomeUnknown, submitWithReconcile, ORDER_ATTEMPT_TIMEOUT_MS, ORDER_RECONCILE_DELAYS_MS } from "@/features/guest/orderSubmit";

const timeout = () => new ApiError(0, "Timeout", "The server took too long to respond");
const refused = (status: number) => new ApiError(status, "X", "refused");
const noSleep = { sleep: () => Promise.resolve(), slowAfterMs: 60_000 };

describe("guest order submission outcome", () => {
  it("a timeout, a dropped connection or a server/gateway error leaves the outcome unknown; a 4xx is a definite answer", () => {
    for (const e of [timeout(), new ApiError(0, "NetworkError", "x"), refused(500), refused(502), refused(503), refused(504), refused(408), new TypeError("boom")]) expect(outcomeUnknown(e)).toBe(true);
    for (const s of [400, 401, 403, 404, 409, 422, 429]) expect(outcomeUnknown(refused(s))).toBe(false);
  });

  it("each attempt gets well past the slowest placement seen (22.9 s)", () => {
    expect(ORDER_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(40_000);
    expect(ORDER_RECONCILE_DELAYS_MS.length).toBeGreaterThanOrEqual(2);
  });

  it("replays after an unknown outcome and returns the order the replay finds", async () => {
    const send = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValueOnce({ orderId: "o1", replayed: true });
    const phases: string[] = [];
    await expect(submitWithReconcile(send, { ...noSleep, onPhase: (p) => phases.push(p) })).resolves.toEqual({ status: "ok", value: { orderId: "o1", replayed: true } });
    expect(send.mock.calls.map((c) => c[0])).toEqual([0, 1]);
    expect(phases).toEqual(["sending", "confirming"]);
  });

  it("a refusal on the first attempt fails at once (not retried)", async () => {
    const send = vi.fn().mockRejectedValue(refused(422));
    const r = await submitWithReconcile(send, noSleep);
    expect(r).toMatchObject({ status: "failed" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rate limited first: a definite failure; rate limited while confirming: still unknown, keep asking", async () => {
    expect(await submitWithReconcile(vi.fn().mockRejectedValue(refused(429)), noSleep)).toMatchObject({ status: "failed" });
    const send = vi.fn().mockRejectedValueOnce(timeout()).mockRejectedValueOnce(refused(429)).mockResolvedValueOnce({ orderId: "o2" });
    expect(await submitWithReconcile(send, noSleep)).toEqual({ status: "ok", value: { orderId: "o2" } });
  });

  it("never answered: 'unknown' after the bounded replays (no failure claimed)", async () => {
    const send = vi.fn().mockRejectedValue(timeout());
    const r = await submitWithReconcile(send, { ...noSleep, delaysMs: [1, 1, 1] });
    expect(r.status).toBe("unknown");
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("tells the guest the connection is slow while the first attempt is still running", async () => {
    vi.useFakeTimers();
    try {
      const phases: string[] = [];
      let resolve!: (v: string) => void;
      const p = submitWithReconcile(() => new Promise<string>((r) => (resolve = r)), { onPhase: (ph) => phases.push(ph) });
      await vi.advanceTimersByTimeAsync(8_000);
      expect(phases).toEqual(["sending", "slow"]);
      resolve("done");
      await expect(p).resolves.toEqual({ status: "ok", value: "done" });
    } finally {
      vi.useRealTimers();
    }
  });
});
