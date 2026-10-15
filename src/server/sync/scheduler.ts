/**
 * Desktop side: the background loop that keeps the cache in step with the cloud while the app is open
 * (started by instrumentation-node.ts when AHAROS_DESKTOP=1; never on the hosted deployment).
 *
 * A cycle runs every CLOUD_SYNC_INTERVAL_MS (default 4 s) so a customer's order appears within a few seconds. While the
 * cloud is unreachable the loop backs off (4 s → 8 s … 30 s) instead of hammering it, and it returns to the normal
 * rhythm on the first success. With no cloud link it just idles. On start-up it runs immediately, so an app that was
 * closed for hours or days resumes from its saved feed position.
 */
import { prisma } from "@/server/db/client";
import { log } from "@/server/observability/log";
import { runSyncCycle } from "@/server/sync/runner";

const MIN_MS = 1_000;

export function syncIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.CLOUD_SYNC_INTERVAL_MS);
  return Number.isInteger(v) && v >= MIN_MS ? v : 4_000;
}

export function nextDelay(base: number, failures: number, rand: () => number = Math.random): number {
  const wait = failures <= 0 ? base : Math.min(base * 2 ** Math.min(failures, 5), 30_000);
  const jitter = Math.floor(wait * 0.2 * rand());
  return Math.max(wait - Math.floor(wait * 0.1) + jitter, 1_000);
}

export function startCloudSync(): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: Promise<unknown> = Promise.resolve();
  let failures = 0;
  const base = syncIntervalMs();

  const tick = async () => {
    if (stopped) return;
    let delay = base;
    try {
      const link = await prisma.cloudLink.findFirst({ select: { organizationId: true } });
      if (!link) delay = 15_000; // not linked: look again in a while
      else {
        const r = await runSyncCycle(prisma, link.organizationId);
        failures = r.state === "ONLINE" ? 0 : r.state === "AUTH_REQUIRED" ? 0 : failures + 1;
        delay = r.state === "AUTH_REQUIRED" ? 15_000 : nextDelay(base, failures);
      }
    } catch (e) {
      failures++;
      delay = nextDelay(base, failures);
      log.error("cloud sync loop error", { event: "cloud_sync_loop", error: e });
    }
    if (!stopped) timer = setTimeout(() => { current = tick(); }, delay);
  };
  timer = setTimeout(() => { current = tick(); }, 500);

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await current.catch(() => undefined);
  };
}
