/**
 * Scheduled jobs that must run once per day per scope across any number of app
 * instances (group 5). The claim is a JobRun row whose unique key is
 * (name, scope, run date): whoever inserts it runs the job; everyone else sees
 * the conflict and skips. A run that failed is retried later (bounded), a run
 * that died mid-way (RUNNING for too long) is taken over.
 *
 * POS_REPULL (proposal p. 7, "Nightly re-pull at 1:30 AM -- the system asks the
 * POS for yesterday's full order list and fills any gap a dropped webhook left.
 * Retries never double-count"): for every outlet with a connected POS
 * connection, once the outlet's local clock has passed 01:30, yesterday's
 * settled orders are fetched from the provider and the ones RESTORA never
 * received are imported through the same pipeline as a webhook (unique order
 * keys: a repeat changes nothing). Nothing is invented: a provider that cannot
 * answer (not configured, unreachable) makes the run FAILED with the safe
 * reason and raises an alert; it is retried on later ticks, at most three
 * times a day.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { reconcilePOSOrders } from "@/server/services/reconciliation";
import { lowStock } from "@/server/services/inventory";
import { vendorDues } from "@/server/services/procurement";
import { notify } from "@/server/services/notifications";
import { runInTx } from "@/server/services/_workflow";
import { D, money } from "@/domain/money";
import { getPOSProvider, type POSProvider } from "@/integrations/pos";
import { safeMessage } from "@/integrations/http";
import { businessDayRange } from "@/domain/time";
import { log } from "@/server/observability/log";
import { inc } from "@/server/observability/metrics";
import { raiseAlert } from "@/server/observability/alerts";

export const POS_REPULL = "POS_REPULL";
export const REPULL_AT = { hour: 1, minute: 30 };
/** Once a day per outlet, from 08:00 on its own clock: low stock and overdue vendor bills reach the people who act on them. */
export const OPS_ALERTS = "OPS_ALERTS";
export const OPS_ALERTS_AT = { hour: 8, minute: 0 };
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 60 * 60_000;
const STALE_RUNNING_MS = 30 * 60_000;

/** Local wall-clock hour / minute in a time zone. */
function localClock(now: Date, tz: string) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  return { hour: Number(p.find((x) => x.type === "hour")?.value ?? 0), minute: Number(p.find((x) => x.type === "minute")?.value ?? 0) };
}
export const pastRepullTime = (now: Date, tz: string) => {
  const c = localClock(now, tz);
  return c.hour * 60 + c.minute >= REPULL_AT.hour * 60 + REPULL_AT.minute;
};

type Attempts = { attempts: number } & Record<string, unknown>;
const readDetail = (s: string | null): Attempts => { try { const j = JSON.parse(s ?? "{}"); return { ...j, attempts: Number(j.attempts) || 0 }; } catch { return { attempts: 0 }; } };

/** Claim one run of a job. True = this caller runs it now. */
export async function claimJobRun(db: PrismaClient, name: string, scopeKey: string, runDate: string, now = new Date()): Promise<boolean> {
  try {
    await db.jobRun.create({ data: { name, scopeKey, runDate, status: "RUNNING", startedAt: now, detail: JSON.stringify({ attempts: 1 }) } });
    return true;
  } catch (e) {
    if ((e as { code?: string })?.code !== "P2002") throw e;
  }
  const row = await db.jobRun.findUnique({ where: { name_scopeKey_runDate: { name, scopeKey, runDate } } });
  if (!row || row.status === "SUCCESS") return false;
  const d = readDetail(row.detail);
  if (row.status === "RUNNING") {
    // Died mid-way (crash, restart): take it over once it is clearly stale.
    if (now.getTime() - row.startedAt.getTime() < STALE_RUNNING_MS || d.attempts >= MAX_ATTEMPTS) return false;
    const taken = await db.jobRun.updateMany({ where: { id: row.id, status: "RUNNING", startedAt: row.startedAt }, data: { startedAt: now, detail: JSON.stringify({ ...d, attempts: d.attempts + 1 }) } });
    return taken.count === 1;
  }
  // FAILED: try again after a pause, a bounded number of times.
  if (d.attempts >= MAX_ATTEMPTS || !row.finishedAt || now.getTime() - row.finishedAt.getTime() < RETRY_AFTER_MS) return false;
  const again = await db.jobRun.updateMany({ where: { id: row.id, status: "FAILED", finishedAt: row.finishedAt }, data: { status: "RUNNING", startedAt: now, finishedAt: null, detail: JSON.stringify({ ...d, attempts: d.attempts + 1 }) } });
  return again.count === 1;
}

export async function finishJobRun(db: PrismaClient, name: string, scopeKey: string, runDate: string, status: "SUCCESS" | "FAILED", extra: Record<string, unknown>, now = new Date()) {
  const row = await db.jobRun.findUnique({ where: { name_scopeKey_runDate: { name, scopeKey, runDate } } });
  const d = readDetail(row?.detail ?? null);
  await db.jobRun.updateMany({ where: { name, scopeKey, runDate }, data: { status, finishedAt: now, detail: JSON.stringify({ ...d, ...extra }) } });
}

export type RepullResult = { outlets: number; started: number; succeeded: number; failed: number; skipped: number; imported: number };

/** Nightly re-pull for every outlet whose clock has passed 01:30. `providerFor` lets tests supply the POS adapter. `onlyOutletId` limits one tick to a single outlet (tests); omitted means every connected outlet. */
export async function runNightlyPosRepull(db: PrismaClient = prisma, now = new Date(), providerFor: (provider: string) => POSProvider = getPOSProvider, onlyOutletId?: string): Promise<RepullResult> {
  const result: RepullResult = { outlets: 0, started: 0, succeeded: 0, failed: 0, skipped: 0, imported: 0 };
  const conns = await db.integrationConnection.findMany({ where: { kind: "POS", status: "CONNECTED", outletId: onlyOutletId ?? { not: null } }, select: { organizationId: true, outletId: true, provider: true }, orderBy: [{ outletId: "asc" }, { provider: "asc" }] });
  const outlets = await db.outlet.findMany({ where: { id: { in: conns.map((c) => c.outletId!) } }, select: { id: true, organizationId: true, timezone: true } });
  const byId = new Map(outlets.map((o) => [o.id, o]));
  const seen = new Set<string>();
  for (const c of conns) {
    const outlet = byId.get(c.outletId!);
    if (!outlet || outlet.organizationId !== c.organizationId || seen.has(outlet.id)) continue; // one run per outlet, never across organizations
    seen.add(outlet.id);
    result.outlets++;
    if (!pastRepullTime(now, outlet.timezone)) { result.skipped++; continue; }
    // Yesterday's business day at this outlet.
    const today = businessDayRange(now, outlet.timezone);
    const yesterday = businessDayRange(new Date(today.start.getTime() - 1), outlet.timezone);
    if (!(await claimJobRun(db, POS_REPULL, outlet.id, yesterday.date, now))) { result.skipped++; continue; }
    result.started++;
    try {
      const ctx = systemContext(outlet.organizationId, [outlet.id]);
      const report = await reconcilePOSOrders(ctx, { outletId: outlet.id, from: yesterday.start, to: new Date(yesterday.end.getTime() - 1), autoImport: true }, { provider: providerFor(c.provider), db });
      await finishJobRun(db, POS_REPULL, outlet.id, yesterday.date, "SUCCESS", { providerCount: report.providerCount, localCount: report.localCount, missing: report.missing.length, imported: report.imported.length, provider: report.provider }, now);
      result.succeeded++;
      result.imported += report.imported.length;
      inc("restora_job_runs_total", { job: POS_REPULL, status: "success" });
      if (report.imported.length) log.info("nightly POS re-pull filled gaps", { event: "pos_repull_imported", outletId: outlet.id, date: yesterday.date, imported: report.imported.length });
    } catch (e) {
      const why = safeMessage(e);
      await finishJobRun(db, POS_REPULL, outlet.id, yesterday.date, "FAILED", { error: why }, now);
      result.failed++;
      inc("restora_job_runs_total", { job: POS_REPULL, status: "failed" });
      inc("restora_job_failures_total", { type: "pos_repull" });
      log.warn("nightly POS re-pull failed", { event: "pos_repull_failed", outletId: outlet.id, date: yesterday.date, error: why });
      raiseAlert(`pos_repull_failed:${outlet.id}`, "warning", "The nightly POS re-pull could not complete; yesterday's orders may have gaps until it succeeds", { outletId: outlet.id, date: yesterday.date, error: why });
    }
  }
  return result;
}

export type OpsAlertsResult = { outlets: number; started: number; succeeded: number; failed: number; skipped: number; lowStock: number; overdue: number };

/**
 * Morning check for every active outlet whose clock has passed 08:00: one LOW_STOCK notification when anything is at or
 * below its reorder level, one VENDOR_DUE notification when vendor bills are past their due date. The claim (JobRun) makes
 * it run once per outlet per day across any number of instances; nothing is sent when there is nothing to say.
 */
export async function runOperationsAlerts(db: PrismaClient = prisma, now = new Date(), onlyOutletId?: string): Promise<OpsAlertsResult> {
  const result: OpsAlertsResult = { outlets: 0, started: 0, succeeded: 0, failed: 0, skipped: 0, lowStock: 0, overdue: 0 };
  const outlets = await db.outlet.findMany({ where: { active: true, organization: { active: true }, ...(onlyOutletId ? { id: onlyOutletId } : {}) }, select: { id: true, organizationId: true, timezone: true } });
  for (const outlet of outlets) {
    result.outlets++;
    const c = localClock(now, outlet.timezone);
    if (c.hour * 60 + c.minute < OPS_ALERTS_AT.hour * 60 + OPS_ALERTS_AT.minute) { result.skipped++; continue; }
    const day = businessDayRange(now, outlet.timezone).date;
    if (!(await claimJobRun(db, OPS_ALERTS, outlet.id, day, now))) { result.skipped++; continue; }
    result.started++;
    try {
      const ctx = systemContext(outlet.organizationId, [outlet.id]);
      const low = await lowStock(db, ctx, outlet.id);
      const dues = await vendorDues(db, ctx, { outletId: outlet.id, asOf: now });
      const overdue = dues.reduce((a, d) => a.plus(D(d.overdue)), D(0));
      await runInTx(db, async (tx) => {
        if (low.length) await notify.lowStock(tx, ctx, outlet.id, low.length);
        if (overdue.gt(0)) await notify.vendorDue(tx, ctx, outlet.id, money(overdue).toFixed(2));
      });
      await finishJobRun(db, OPS_ALERTS, outlet.id, day, "SUCCESS", { lowStock: low.length, overdue: money(overdue).toFixed(2) });
      result.succeeded++;
      result.lowStock += low.length ? 1 : 0;
      result.overdue += overdue.gt(0) ? 1 : 0;
      inc("restora_job_runs_total", { job: OPS_ALERTS, status: "success" });
    } catch (e) {
      const why = safeMessage(e);
      await finishJobRun(db, OPS_ALERTS, outlet.id, day, "FAILED", { error: why }, now);
      result.failed++;
      inc("restora_job_runs_total", { job: OPS_ALERTS, status: "failed" });
      inc("restora_job_failures_total", { type: "ops_alerts" });
      log.warn("morning stock and dues check failed", { event: "ops_alerts_failed", outletId: outlet.id, date: day, error: why });
    }
  }
  return result;
}

/** All scheduled jobs; called from the worker tick (cheap when nothing is due). */
export async function runScheduledJobs(db: PrismaClient = prisma, now = new Date()) {
  const posRepull = await runNightlyPosRepull(db, now);
  let opsAlerts: OpsAlertsResult | null = null;
  try {
    opsAlerts = await runOperationsAlerts(db, now);
  } catch (e) {
    inc("restora_job_failures_total", { type: "ops_alerts" });
    log.error("morning stock and dues check failed", { event: "ops_alerts_failed", error: e });
  }
  // Group 6 automations (campaigns, feedback requests, booking messages, birthday / win-back offers, the 9 AM summary).
  // Loaded lazily: they import this module's claim helpers. A failure there never costs the POS re-pull its result.
  const { runGrowthJobs } = await import("@/server/services/lifecycle");
  let growth: Awaited<ReturnType<typeof runGrowthJobs>> | null = null;
  try {
    growth = await runGrowthJobs(db, now);
  } catch (e) {
    inc("restora_job_failures_total", { type: "growth" });
    log.error("growth jobs failed", { event: "growth_jobs_failed", error: e });
  }
  return { posRepull, opsAlerts, growth };
}
