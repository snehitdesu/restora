/**
 * Authenticated maintenance tick for hosts that cannot run an in-process worker
 * (Vercel). Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
 *
 * Idempotent: runWorkerTick claims rows with compare-and-set, so overlapping
 * invocations do not double-send. Does not run migrations or seeds.
 */
import { cronAuthorized } from "@/server/ops/opsStatus";
import { runWorkerTick } from "@/server/ops/worker";
import { log } from "@/server/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const headers = { "Cache-Control": "no-store" };

async function tick(req: Request): Promise<Response> {
  if (!cronAuthorized(req.headers.get("authorization"))) {
    return Response.json({ ok: false, error: { code: "UnauthorizedError", message: "Authentication required" } }, { status: 401, headers: { ...headers, "WWW-Authenticate": "Bearer" } });
  }
  try {
    const result = await runWorkerTick();
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
