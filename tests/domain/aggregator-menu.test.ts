/**
 * Switching dishes on and off across the ordering platforms (audit AG-04), against the real services and database, with the
 * mock aggregator adapter: what is sent and to which store, effective state per outlet, items the platform cannot match, the
 * outbox (failure, retry, superseded), tenant isolation and the production refusal of the mock.
 */
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { prisma } from "@/server/db/client";
import { createMenuItem, setMenuItemAvailability, setOutletMenuItem } from "@/server/services/menu";
import { upsertIntegration } from "@/server/services/integrations";
import { settleAfterCommit } from "@/server/services/afterCommit";
import { pushItemAvailability } from "@/server/services/aggregatorMenu";
import { retryDueDeliveries, recoverStuckWork } from "@/server/ops/worker";
import { MockAggregatorProvider } from "@/integrations/aggregator";
import { makeEnv, uniq, type Env } from "./growthSupport";

let env: Env;
let storeA: string;
let storeB: string;
const sent = () => prisma.integrationDelivery.findMany({ where: { organizationId: env.orgId, kind: "AGGREGATOR_ITEM" }, orderBy: { createdAt: "asc" } });
const forItem = async (menuItemId: string) => (await sent()).filter((d) => d.sourceId === menuItemId);
async function dish(posCode: string | null = `P-${uniq()}`) {
  return createMenuItem(env.owner, { name: `Dish ${uniq()}`, price: 100, taxPct: 5, ...(posCode ? { posCode } : {}) });
}
const set = async (id: string, input: { active?: boolean; soldOut?: boolean }) => { const r = await setMenuItemAvailability(env.owner, id, input); await settleAfterCommit(); return r; };

beforeAll(async () => {
  env = await makeEnv("Gam");
  storeA = `swiggy_a_${uniq()}`;
  storeB = `swiggy_b_${uniq()}`;
  await upsertIntegration(env.owner, { kind: "AGGREGATOR", provider: "mock", outletId: env.outletA, externalRef: storeA, status: "CONNECTED", mode: "SANDBOX" });
  await upsertIntegration(env.owner, { kind: "AGGREGATOR", provider: "mock", outletId: env.outletB, externalRef: storeB, status: "CONNECTED", mode: "SANDBOX" });
}, 60000);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await prisma.$disconnect(); });

describe("M1. sold out and back on", () => {
  it("M1 marking a dish sold out tells every connected store; putting it back tells them again; repeating a state tells nobody", async () => {
    const item = await dish("BIRYANI");
    await set(item.id, { soldOut: true });
    const off = await forItem(item.id);
    expect(off).toHaveLength(2); // one per store
    expect(off.every((d) => d.status === "SENT" && d.mode === "MOCK" && d.provider === "mock")).toBe(true);
    expect(off.map((d) => d.providerRef).sort()).toEqual([`mockitem_${storeA}_BIRYANI_off`, `mockitem_${storeB}_BIRYANI_off`].sort());
    expect(off[0].target).toMatch(/→ off$/);
    expect(JSON.stringify(off.map((d) => d.payload))).not.toMatch(/secret|password|token/i);

    await set(item.id, { soldOut: true }); // already sold out: nothing new
    expect(await forItem(item.id)).toHaveLength(2);

    await set(item.id, { soldOut: false });
    const all = await forItem(item.id);
    expect(all).toHaveLength(4);
    expect(all.slice(2).map((d) => d.providerRef).sort()).toEqual([`mockitem_${storeA}_BIRYANI_on`, `mockitem_${storeB}_BIRYANI_on`].sort());
    expect(new Set(all.map((d) => d.idempotencyKey)).size).toBe(4); // off, on, off, on cycles never collide on a key
  });

  it("M1 taking a dish off the menu switches it off; the audit trail and the menu change are unaffected by the platform", async () => {
    const item = await dish("PANEER");
    await set(item.id, { active: false });
    expect((await forItem(item.id)).map((d) => JSON.parse(d.payload).available)).toEqual([false, false]);
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } })).active).toBe(false);
    expect(await prisma.auditLog.count({ where: { organizationId: env.orgId, entityType: "MenuItem", entityId: item.id, action: "UPDATE" } })).toBe(1);
  });

  it("M1 changing only the price tells nobody", async () => {
    const item = await dish("TEA");
    const { updateMenuItem } = await import("@/server/services/menu");
    await updateMenuItem(env.owner, item.id, { price: 25 });
    await settleAfterCommit();
    expect(await forItem(item.id)).toHaveLength(0);
  });
});

describe("M2. per outlet", () => {
  it("M2 an outlet-level sold out tells only that outlet's store; the state is the effective one", async () => {
    const item = await dish("DOSA");
    await setOutletMenuItem(env.owner, { outletId: env.outletA, menuItemId: item.id, soldOut: true });
    await settleAfterCommit();
    const rows = await forItem(item.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].outletId).toBe(env.outletA);
    expect(rows[0].providerRef).toBe(`mockitem_${storeA}_DOSA_off`);

    // Sold out for the whole menu: outlet B goes off, outlet A is already off at its own level and is told too (state unchanged is still pushed at org level).
    await set(item.id, { soldOut: true });
    const afterOrg = await forItem(item.id);
    expect(afterOrg.filter((d) => d.outletId === env.outletB).map((d) => JSON.parse(d.payload).available)).toEqual([false]);

    // Back on for the menu: outlet A stays off (its own sold-out), outlet B comes back on.
    await set(item.id, { soldOut: false });
    const last = await forItem(item.id);
    const byOutlet = (o: string) => last.filter((d) => d.outletId === o).map((d) => JSON.parse(d.payload).available);
    expect(byOutlet(env.outletA).at(-1)).toBe(false);
    expect(byOutlet(env.outletB).at(-1)).toBe(true);
  });

  it("M2 switching a dish off at one outlet only (not offered there) is an outlet-level off", async () => {
    const item = await dish("LASSI");
    await setOutletMenuItem(env.owner, { outletId: env.outletB, menuItemId: item.id, active: false });
    await settleAfterCommit();
    const rows = await forItem(item.id);
    expect(rows.map((d) => [d.outletId, JSON.parse(d.payload).available])).toEqual([[env.outletB, false]]);
    await setOutletMenuItem(env.owner, { outletId: env.outletB, menuItemId: item.id, price: 90 });
    await settleAfterCommit();
    expect(await forItem(item.id)).toHaveLength(1); // a price override says nothing about availability
  });
});

describe("M3. what cannot be sent", () => {
  it("M3 a dish with no POS code cannot be matched on the platform: SKIPPED with the reason, never SENT", async () => {
    const item = await dish(null);
    await set(item.id, { soldOut: true });
    const rows = await forItem(item.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((d) => d.status === "SKIPPED" && /no POS code/.test(d.lastError ?? ""))).toBe(true);
  });

  it("M3 a store that is disconnected, and another restaurant's stores, are never told", async () => {
    const other = await makeEnv("Gamo");
    await upsertIntegration(other.owner, { kind: "AGGREGATOR", provider: "mock", outletId: other.outletA, externalRef: `other_${uniq()}`, status: "CONNECTED", mode: "SANDBOX" });
    const item = await dish("RAITA");
    await prisma.integrationConnection.updateMany({ where: { organizationId: env.orgId, externalRef: storeB }, data: { status: "DISCONNECTED" } });
    await set(item.id, { soldOut: true });
    const rows = await forItem(item.id);
    expect(rows.map((d) => d.outletId)).toEqual([env.outletA]);
    expect(await prisma.integrationDelivery.count({ where: { organizationId: other.orgId, kind: "AGGREGATOR_ITEM" } })).toBe(0);
    await prisma.integrationConnection.updateMany({ where: { organizationId: env.orgId, externalRef: storeB }, data: { status: "CONNECTED" } });
  });

  it("M3 with no store connected at all nothing is written", async () => {
    const lone = await makeEnv("Gamn");
    const item = await createMenuItem(lone.owner, { name: `Solo ${uniq()}`, price: 10, taxPct: 0, posCode: "SOLO" });
    await setMenuItemAvailability(lone.owner, item.id, { soldOut: true });
    await settleAfterCommit();
    expect(await prisma.integrationDelivery.count({ where: { organizationId: lone.orgId } })).toBe(0);
  });

  it("M3 in production the mock is refused: the delivery is SKIPPED saying nobody was told", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const item = await dish("KHEER");
    await set(item.id, { soldOut: true });
    const rows = await forItem(item.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((d) => d.status === "SKIPPED" && /was not told/.test(d.lastError ?? ""))).toBe(true);
    expect(rows.every((d) => d.providerRef === null && d.sentAt === null)).toBe(true);
  });
});

describe("M4. the outbox", () => {
  it("M4 a platform failure is recorded, never fails the menu change, and the worker retries it", async () => {
    const item = await dish("COKE");
    const spy = vi.spyOn(MockAggregatorProvider.prototype, "setItemAvailability").mockRejectedValue(new Error("Swiggy is down"));
    await expect(set(item.id, { soldOut: true })).resolves.toMatchObject({ soldOut: true });
    const failed = await forItem(item.id);
    expect(failed.every((d) => d.status === "FAILED" && d.attempts === 1 && d.nextAttemptAt && /Swiggy is down/.test(d.lastError ?? ""))).toBe(true);
    spy.mockRestore();

    await prisma.integrationDelivery.updateMany({ where: { id: { in: failed.map((d) => d.id) } }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const r = await retryDueDeliveries(prisma);
    expect(r.sent).toBeGreaterThanOrEqual(2);
    expect((await forItem(item.id)).every((d) => d.status === "SENT" && d.attempts === 2)).toBe(true);
  });

  it("M4 a failed 'off' that is retried after the dish was switched back on is dropped, not applied", async () => {
    const item = await dish("SODA");
    vi.spyOn(MockAggregatorProvider.prototype, "setItemAvailability").mockRejectedValueOnce(new Error("timeout")).mockRejectedValueOnce(new Error("timeout"));
    await set(item.id, { soldOut: true });
    const offRows = await forItem(item.id);
    expect(offRows.every((d) => d.status === "FAILED")).toBe(true);
    await set(item.id, { soldOut: false }); // the real mock sends "on" fine
    await prisma.integrationDelivery.updateMany({ where: { id: { in: offRows.map((d) => d.id) } }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await retryDueDeliveries(prisma);
    const after = await forItem(item.id);
    expect(after.filter((d) => JSON.parse(d.payload).available === false).every((d) => d.status === "SKIPPED" && /Superseded/.test(d.lastError ?? ""))).toBe(true);
    expect(after.filter((d) => JSON.parse(d.payload).available === true).every((d) => d.status === "SENT")).toBe(true);
  });

  it("M4 pushing the same change twice makes one delivery", async () => {
    const item = await dish("PIZZA");
    await prisma.menuItem.update({ where: { id: item.id }, data: { soldOut: true } });
    const a = await pushItemAvailability(env.owner, { menuItemId: item.id, outletId: env.outletA, changeKey: "same" });
    const b = await pushItemAvailability(env.owner, { menuItemId: item.id, outletId: env.outletA, changeKey: "same" });
    expect(a).toHaveLength(1);
    expect(b[0].deliveryId).toBe(a[0].deliveryId);
    expect(await forItem(item.id)).toHaveLength(1);
  });

  it("M4 stuck PENDING item deliveries are made retryable", async () => {
    const item = await dish("WRAP");
    const d = await prisma.integrationDelivery.create({ data: { organizationId: env.orgId, outletId: env.outletA, kind: "AGGREGATOR_ITEM", provider: "mock", mode: "MOCK", idempotencyKey: `stuck-${uniq()}`, payload: "{}", status: "PENDING", sourceType: "MenuItem", sourceId: item.id } });
    await recoverStuckWork(prisma, new Date());
    expect((await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("PENDING"); // fresh: still in progress
    await recoverStuckWork(prisma, new Date(Date.now() + 10 * 60_000));
    const after = await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: d.id } });
    expect(after.status).toBe("FAILED");
    expect(after.nextAttemptAt).not.toBeNull();
  });
});
