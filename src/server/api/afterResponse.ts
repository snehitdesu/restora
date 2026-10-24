/**
 * Work a route starts but does not wait for (e.g. sending a password-reset
 * email), so its response time cannot reveal what the work found.
 *
 * The work is tracked like every post-commit side effect (logged on failure,
 * drained on graceful shutdown, awaited by tests through settleAfterCommit) and
 * handed to Next's `after()`, which keeps a serverless function alive until it
 * settles. Outside a request scope (scripts, direct calls in tests) `after()`
 * throws; the tracked promise still runs.
 */
import { after } from "next/server";
import { runAfterCommit } from "@/server/services/afterCommit";

export function runAfterResponse(label: string, fn: () => Promise<unknown>): void {
  const work = runAfterCommit(label, fn);
  try {
    after(work);
  } catch {
    // No request scope: nothing to keep alive.
  }
}
