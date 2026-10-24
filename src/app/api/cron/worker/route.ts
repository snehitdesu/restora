/**
 * Authenticated maintenance tick for hosts that cannot run an in-process worker
 * (Vercel). Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
 *
 * Idempotent: runWorkerTick claims rows with compare-and-set, so overlapping
 * invocations do not double-send (pending-payment probes included:
 * paymentRecovery claims each payment before asking the bank). Does not run
 * migrations or seeds. For timely payment recovery on Vercel, also call
 * /api/cron/payments every 1–2 minutes (docs/payment-safety.md §3).
 */
import { cronAuthorized } from "@/server/ops/opsStatus";
import { runWorkerTick } from "@/server/ops/worker";
import { log } from "@/server/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const headers = { "Cache-Control": "no-store" };

/** Of the 60 s function limit: the bank probes may start until 35 s in (each bank call is itself bounded by the adapter's timeout). */
const PAYMENT_BUDGET_MS = 35_000;

async function tick(req: Request): Promise<Response> {
  const started = Date.now();
  if (!cronAuthorized(req.headers.get("authorization"))) {
    return Response.json({ ok: false, error: { code: "UnauthorizedError", message: "Authentication required" } }, { status: 401, headers: { ...headers, "WWW-Authenticate": "Bearer" } });
  }
  try {
    // Bank probes for pending payments run last and stop starting new calls well before maxDuration.
    const result = await runWorkerTick(undefined, undefined, { paymentRecheck: { deadlineAt: started + PAYMENT_BUDGET_MS } });
    return Response.json({ ok: true, result }, { headers });
  } catch (e) {
    log.error("cron worker tick failed", { event: "cron_worker_failed", error: e });
    return Response.json({ ok: false, error: { code: "Busy", message: "Worker tick failed" } }, { status: 503, headers });
  }
}

export function GET(req: Request) {
  return tick(req);
}

export function POST(req: Request) {
  return tick(req);
}
