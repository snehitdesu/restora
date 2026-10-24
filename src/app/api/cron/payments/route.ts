/**
 * Authenticated pending-payment recovery tick, for an external scheduler (or a
 * Vercel Cron on a plan that allows minute schedules) to call every 1–2 minutes.
 * The daily /api/cron/worker is far too slow for a guest waiting on a QR order.
 *
 * `Authorization: Bearer <CRON_SECRET>`; GET or POST; no body. Runs only the
 * recovery job (services/paymentRecovery.ts): bounded calls, no new bank call
 * after PAYMENT_BUDGET_MS, each payment claimed before it is probed, so
 * overlapping or repeated calls are safe. Returns counts only — never a
 * payment id, reference or amount.
 */
import { cronAuthorized } from "@/server/ops/opsStatus";
import { recheckPendingPayments } from "@/server/services/paymentRecovery";
import { log } from "@/server/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Of the 60 s function limit: bank probes may start until 40 s in (each is itself bounded by the adapter's timeout). */
const PAYMENT_BUDGET_MS = 40_000;
const headers = { "Cache-Control": "no-store" };

async function tick(req: Request): Promise<Response> {
  const started = Date.now();
  if (!cronAuthorized(req.headers.get("authorization"))) {
    return Response.json({ ok: false, error: { code: "UnauthorizedError", message: "Authentication required" } }, { status: 401, headers: { ...headers, "WWW-Authenticate": "Bearer" } });
  }
  try {
    const result = await recheckPendingPayments(undefined, new Date(started), { deadlineAt: started + PAYMENT_BUDGET_MS });
    return Response.json({ ok: true, result, ms: Date.now() - started }, { headers });
  } catch (e) {
    log.error("cron payment recheck failed", { event: "cron_payments_failed", error: e });
    return Response.json({ ok: false, error: { code: "Busy", message: "Payment recheck failed" } }, { status: 503, headers });
  }
}

export function GET(req: Request) {
  return tick(req);
}

export function POST(req: Request) {
  return tick(req);
}
