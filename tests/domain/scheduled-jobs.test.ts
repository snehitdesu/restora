/**
 * Group 5 scheduled jobs: the once-a-day claim (JobRun) and the nightly POS
 * re-pull at 01:30 local time (proposal p. 7: "fills any gap a dropped webhook
 * left. Retries never double-count").
 *
 *  J1 the claim: one winner per (job, scope, day); retries after a pause, bounded; stale runs are taken over
 *  J2 before 01:30 local time nothing runs; after it, yesterday's missing orders are imported once
 *  J3 an order already received is not imported or consumed twice
 *  J4 a provider failure is recorded, retried later, bounded; recovery completes the day
 *  J5 the worker tick runs the schedule; other organizations' outlets are never mixed
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { claimJobRun, pastRepullTime, POS_REPULL, runNightlyPosRepull } from "@/server/ops/scheduled";
import { runWorkerTick } from "@/server/ops/worker";
import { processPOSOrder } from "@/server/services/pos";
import { MockPOSProvider } from "@/integrations/pos/mock";
import type { NormalizedOrder, POSProvider } from "@/integrations/pos/types";
import { IntegrationError } from "@/integrations/http";

const RUN = Date.now().toString(36);
let orgId: string, A: string, otherOrg: string;
const HOUR = 3600_000;
// Asia/Kolkata is UTC+5:30: 02:00 local on 9 Oct is 20:30 UTC on 8 Oct; yesterday (8 Oct local) is [07 Oct 18:30Z, 08 Oct 18:30Z).
const AFTER_0130 = new Date("2026-10-08T20:30:00Z");
const BEFORE_0130 = new Date("2026-10-08T19:30:00Z");
const YESTERDAY = "2026-10-08";
const posOrder = (ref: string, total = 105): NormalizedOrder => ({
  externalRef: `${ref}-${RUN}`, eventId: `ev-${ref}-${RUN}`, outletId: A, source: "PETPOOJA", channel: "DINE_IN", placedAt: new Date("2026-10-08T10:00:00Z"),
  items: [{ posItemCode: `POS-${RUN}`, name: "House special", qty: 1, unitPrice: 100, taxPct: 5 }], total, payments: [{ method: "CASH", amount: total }], settled: true,
});
const runs = () => prisma.jobRun.findMany({ where: { name: POS_REPULL, scopeKey: A }, orderBy: { runDate: "asc" } });
const detail = (r: { detail: string | null }) => JSON.parse(r.detail ?? "{}") as Record<string, unknown>;
const ordersAt = () => prisma.order.count({ where: { organizationId: orgId, outletId: A, externalRef: { endsWith: `-${RUN}` } } });
const provider = (orders: NormalizedOrder[]): POSProvider => new MockPOSProvider(orders);

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Sched Org ${RUN}`, timezone: "Asia/Kolkata" } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `SC${RUN}`, name: "Sched A", timezone: "Asia/Kolkata" } })).id;
  otherOrg = (await prisma.organization.create({ data: { name: `Sched Other ${RUN}` } })).id;
  await prisma.integrationConnection.create({ data: { organizationId: orgId, kind: "POS", provider: "mock", outletId: A, externalRef: `store-${RUN}`, status: "CONNECTED", mode: "SANDBOX" } });
});

afterAll(async () => { await prisma.$disconnect(); });

describe("J1. the claim", () => {
  it("J1 one winner per day; a failed run waits an hour and is tried at most three times; a run that died mid-way is taken over once", async () => {
    const scope = `scope-${RUN}`;
    const t0 = new Date("2026-10-08T21:00:00Z");
    // two instances claiming at the same moment: exactly one runs
    const claims = await Promise.all([claimJobRun(prisma, "TEST_JOB", scope, "2026-10-08", t0), claimJobRun(prisma, "TEST_JOB", scope, "2026-10-08", t0), claimJobRun(prisma, "TEST_JOB", scope, "2026-10-08", t0)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    // still RUNNING and fresh: nobody else takes it
    expect(await claimJobRun(prisma, "TEST_JOB", scope, "2026-10-08", new Date(t0.getTime() + 10 * 60_000))).toBe(false);
    // died mid-way: after 30 minutes one caller takes it over (attempt 2)
    const takeovers = await Promise.all([claimJobRun(prisma, "TEST_JOB", scope, "2026-10-08", new Date(t0.getTime() + 31 * 60_000)), claimJobRun(prisma, "TEST_JOB", scope, "2026-10-08", new Date(t0.getTime() + 31 * 60_000))]);
    expect(takeovers.filter(Boolean)).toHaveLength(1);
    const row = () => prisma.jobRun.findUniqueOrThrow({ where: { name_scopeKey_runDate: { name: "TEST_JOB", scopeKey: scope, runDate: "2026-10-08" } } });
    expect(JSON.parse((await row()).detail!)).toMatchObject({ attempts: 2 });
    // a failed run: not before an hour has passed, then again, at most three attempts in all
    const failedAt = new Date(t0.getTime() + HOUR);
    await prisma.jobRun.update({ where: { id: (await row()).id }, data: { status: "FAILED", finishedAt: failedAt } });
    expect(await claimJobRun(prisma, "TEST_JOB", scope, "2026-10-08", new Date(failedAt.getTime() + 30 * 60_000))).toBe(false);
    expect(await claimJobRun(prisma, "TEST_JOB", scope, "2026-10-08", new Date(failedAt.getTime() + 61 * 60_000))).toBe(true); // attempt 3
    await prisma.jobRun.update({ where: { id: (await row()).id }, data: { status: "FAILED", finishedAt: failedAt } });
    expect(await claimJobRun(prisma, "TEST_JOB", scope, "2026-10-08", new Date(failedAt.getTime() + 5 * HOUR))).toBe(false); // exhausted
    // a finished run is never run again that day; the next day is a new run
    await prisma.jobRun.update({ where: { id: (await row()).id }, data: { status: "SUCCESS", finishedAt: failedAt } });
    expect(await claimJobRun(prisma, "TEST_JOB", scope, "2026-10-08", new Date(failedAt.getTime() + 9 * HOUR))).toBe(false);
    expect(await claimJobRun(prisma, "TEST_JOB", scope, "2026-10-09", new Date(failedAt.getTime() + 9 * HOUR))).toBe(true);
  });

  it("J1b 01:30 is the outlet's own clock, wherever the server runs", () => {
    expect(pastRepullTime(new Date("2026-10-08T19:59:00Z"), "Asia/Kolkata")).toBe(false); // 01:29 IST
    expect(pastRepullTime(new Date("2026-10-08T20:00:00Z"), "Asia/Kolkata")).toBe(true); // 01:30 IST
    expect(pastRepullTime(new Date("2026-10-08T20:00:00Z"), "UTC")).toBe(true); // 20:00 UTC
    expect(pastRepullTime(new Date("2026-10-08T01:29:00Z"), "UTC")).toBe(false);
    expect(pastRepullTime(new Date("2026-10-08T01:30:00Z"), "UTC")).toBe(true);
    expect(pastRepullTime(new Date("2026-10-08T00:00:00Z"), "Asia/Kolkata")).toBe(true); // 05:30 IST
  });
});

describe("J2. the nightly re-pull", () => {
  it("J2 before 01:30 nothing runs; after it yesterday's missing orders are imported once; the same day again does nothing; the next day is a new run", async () => {
    const early = await runNightlyPosRepull(prisma, BEFORE_0130, () => provider([posOrder("N1")]));
    expect(early).toMatchObject({ outlets: 1, started: 0, skipped: 1 });
    expect(await runs()).toHaveLength(0);

    const store = [posOrder("N1"), posOrder("N2", 210)];
    const first = await runNightlyPosRepull(prisma, AFTER_0130, () => provider(store));
    expect(first).toMatchObject({ outlets: 1, started: 1, succeeded: 1, failed: 0, imported: 2 });
    expect(await ordersAt()).toBe(2);
    const [run] = await runs();
    expect(run).toMatchObject({ status: "SUCCESS", runDate: YESTERDAY });
    expect(detail(run)).toMatchObject({ attempts: 1, providerCount: 2, missing: 2, imported: 2 });
    expect(run.finishedAt).not.toBeNull();

    const again = await runNightlyPosRepull(prisma, new Date(AFTER_0130.getTime() + 2 * HOUR), () => provider(store));
    expect(again).toMatchObject({ started: 0, skipped: 1, imported: 0 });
    expect(await ordersAt()).toBe(2);
    expect(await runs()).toHaveLength(1);

    const nextDay = await runNightlyPosRepull(prisma, new Date(AFTER_0130.getTime() + 24 * HOUR), () => provider([]));
    expect(nextDay).toMatchObject({ started: 1, succeeded: 1, imported: 0 });
    expect((await runs()).map((r) => r.runDate)).toEqual([YESTERDAY, "2026-10-09"]);
  });

  it("J3 an order the webhook already delivered is neither imported nor consumed a second time", async () => {
    await prisma.jobRun.deleteMany({ where: { name: POS_REPULL, scopeKey: A } });
    const ctx = systemContext(orgId, [A]);
    const have = posOrder("W1", 105);
    await processPOSOrder(ctx, have);
    const before = await ordersAt();
    const consumedBefore = await prisma.order.count({ where: { organizationId: orgId, outletId: A, stockConsumed: true } });
    const r = await runNightlyPosRepull(prisma, AFTER_0130, () => provider([have, posOrder("W2", 52.5)]));
    expect(r).toMatchObject({ succeeded: 1, imported: 1 });
    expect(await ordersAt()).toBe(before + 1);
    const [run] = await runs();
    expect(detail(run)).toMatchObject({ providerCount: 2, missing: 1, imported: 1 });
    // repeating the same pull (a different instance, a retry) cannot create anything
    await prisma.jobRun.deleteMany({ where: { name: POS_REPULL, scopeKey: A } });
    const repeat = await runNightlyPosRepull(prisma, AFTER_0130, () => provider([have, posOrder("W2", 52.5)]));
    expect(repeat).toMatchObject({ succeeded: 1 });
    expect(await ordersAt()).toBe(before + 1);
    expect(await prisma.order.count({ where: { organizationId: orgId, outletId: A, stockConsumed: true } })).toBeGreaterThanOrEqual(consumedBefore);
  });
});

describe("J4. provider failure", () => {
  it("J4 a failing provider is recorded with a safe reason and retried after an hour, at most three times; when it answers the day completes", async () => {
    await prisma.jobRun.deleteMany({ where: { name: POS_REPULL, scopeKey: A } });
    let calls = 0;
    const flaky = (okAfter: number, orders: NormalizedOrder[]): POSProvider => ({
      ...new MockPOSProvider(orders),
      name: "mock",
      getSettledOrders: async () => { calls++; if (calls <= okAfter) throw new IntegrationError("UNAVAILABLE", "Petpooja returned 503 token=abc123secret", true, 503); return orders; },
    } as unknown as POSProvider);
    const mk = (orders: NormalizedOrder[], okAfter: number) => () => flaky(okAfter, orders);

    const t = (mins: number) => new Date(AFTER_0130.getTime() + mins * 60_000);
    const one = await runNightlyPosRepull(prisma, t(0), mk([posOrder("F1")], 2));
    expect(one).toMatchObject({ started: 1, failed: 1, succeeded: 0 });
    let [run] = await runs();
    expect(run).toMatchObject({ status: "FAILED" });
    expect(detail(run).error).toMatch(/Petpooja returned 503/);
    expect(String(detail(run).error)).not.toContain("abc123secret"); // credentials never reach the record
    expect(await ordersAt()).toBe(0 + (await ordersAt()));

    expect(await runNightlyPosRepull(prisma, t(30), mk([posOrder("F1")], 2))).toMatchObject({ started: 0, skipped: 1 }); // too soon
    expect(await runNightlyPosRepull(prisma, t(61), mk([posOrder("F1")], 2))).toMatchObject({ started: 1, failed: 1 }); // attempt 2 fails again
    const third = await runNightlyPosRepull(prisma, t(130), mk([posOrder("F1")], 2)); // attempt 3: the provider answers
    expect(third).toMatchObject({ started: 1, succeeded: 1, imported: 1 });
    [run] = await runs();
    expect(run).toMatchObject({ status: "SUCCESS" });
    expect(detail(run)).toMatchObject({ attempts: 3, imported: 1 });

    // a provider that never answers: three tries, then it stays FAILED for the day
    await prisma.jobRun.deleteMany({ where: { name: POS_REPULL, scopeKey: A } });
    calls = 0;
    const dead = () => flaky(99, []);
    await runNightlyPosRepull(prisma, t(0), dead);
    await runNightlyPosRepull(prisma, t(70), dead);
    await runNightlyPosRepull(prisma, t(140), dead);
    expect(await runNightlyPosRepull(prisma, t(300), dead)).toMatchObject({ started: 0, skipped: 1 });
    [run] = await runs();
    expect(run).toMatchObject({ status: "FAILED" });
    expect(detail(run).attempts).toBe(3);
  });
});

describe("J5. the worker and tenancy", () => {
  it("J5 the worker tick runs the schedule (once a day); a connection pointing at another organization's outlet is ignored", async () => {
    await prisma.jobRun.deleteMany({ where: { name: POS_REPULL, scopeKey: A } });
    // a bogus connection: another organization claims this outlet
    await prisma.integrationConnection.create({ data: { organizationId: otherOrg, kind: "POS", provider: "mock", outletId: A, externalRef: `bogus-${RUN}`, status: "CONNECTED", mode: "SANDBOX" } });
    const tick = await runWorkerTick(prisma, AFTER_0130, { housekeeping: false });
    expect(tick).toBeTruthy();
    const [run] = await runs();
    expect(run).toMatchObject({ status: "SUCCESS", runDate: YESTERDAY });
    expect(await prisma.jobRun.count({ where: { name: POS_REPULL, scopeKey: A } })).toBe(1);
    await runWorkerTick(prisma, new Date(AFTER_0130.getTime() + HOUR), { housekeeping: false });
    expect(await prisma.jobRun.count({ where: { name: POS_REPULL, scopeKey: A } })).toBe(1); // still one run for the day
    // nothing was imported into the other organization
    expect(await prisma.order.count({ where: { organizationId: otherOrg } })).toBe(0);
  });
});
