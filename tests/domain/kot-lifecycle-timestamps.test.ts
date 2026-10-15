/**
 * KOT lifecycle stamps (acceptedAt / startedAt / readyAt / servedAt): set by the
 * server on the transition that reaches each state, once, atomically with the
 * status, never by a refused, repeated, rolled-back or losing concurrent request.
 * Real services on the isolated test database.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { fail } from "@/server/api/respond";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { createMenuItem } from "@/server/services/menu";
import { placeOrder } from "@/server/services/orders";
import { updateKOTStatus, KOT_STAMP } from "@/server/services/kot";

const RUN = `kts${Date.now().toString(36)}`;
let orgId: string, outletId: string, otherOutletId: string;
let kitchen: AccessContext, captain: AccessContext, cashier: AccessContext, otherKitchen: AccessContext, foreignKitchen: AccessContext;
let dosa: string, cola: string;
let seq = 0;

const role = (org: string, outlet: string, r: string): AccessContext => ({ userId: `${r.toLowerCase()}-${RUN}-${outlet.slice(-4)}`, organizationId: org, outletIds: [outlet], roles: [r], outletRoles: { [outlet]: [r] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });
const STAMPS = ["acceptedAt", "startedAt", "readyAt", "servedAt"] as const;
const stamps = async (id: string) => {
  const k = await prisma.kot.findUniqueOrThrow({ where: { id } });
  return { status: k.status, createdAt: k.createdAt, acceptedAt: k.acceptedAt, startedAt: k.startedAt, readyAt: k.readyAt, servedAt: k.servedAt };
};
const audits = (id: string) => prisma.auditLog.count({ where: { entityType: "Kot", entityId: id } });
const onPostgres = /^postgres(ql)?:/.test(process.env.DATABASE_URL ?? "");
/** The error Prisma raises for a PostgreSQL serialization failure / deadlock (40001 / 40P01). */
const conflict = () => new Prisma.PrismaClientKnownRequestError("Transaction failed due to a write conflict or a deadlock. Please retry your transaction", { code: "P2034", clientVersion: Prisma.prismaVersion.client });

/** A fresh submitted order; returns its KOTs (one per station). */
async function freshKots(items: Array<{ menuItemId: string; qty: number }> = [{ menuItemId: dosa, qty: 1 }]) {
  const o = await placeOrder(captain, { outletId, channel: "TAKEAWAY", idempotencyKey: `${RUN}-${++seq}-order`, submit: true, items });
  return prisma.kot.findMany({ where: { orderId: o.id }, include: { station: true }, orderBy: { number: "asc" } });
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `KOT stamps ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `K${RUN}`, name: "Stamps" } })).id;
  otherOutletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `L${RUN}`, name: "Other" } })).id;
  const foreignOrg = (await prisma.organization.create({ data: { name: `KOT stamps foreign ${RUN}` } })).id;
  const foreignOutlet = (await prisma.outlet.create({ data: { organizationId: foreignOrg, code: `F${RUN}`, name: "Foreign" } })).id;
  const sys = systemContext(orgId, [outletId]);
  kitchen = role(orgId, outletId, "KITCHEN");
  captain = role(orgId, outletId, "CAPTAIN");
  cashier = role(orgId, outletId, "CASHIER");
  otherKitchen = role(orgId, otherOutletId, "KITCHEN");
  foreignKitchen = role(foreignOrg, foreignOutlet, "KITCHEN");
  for (const s of ["KITCHEN", "BAR"]) await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId, name: s, kind: s } });
  dosa = (await createMenuItem(sys, { name: `Dosa ${RUN}`, price: 120, taxPct: 5, station: "KITCHEN" })).id;
  cola = (await createMenuItem(sys, { name: `Cola ${RUN}`, price: 60, taxPct: 18, station: "BAR" })).id;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("KOT lifecycle timestamps", () => {
  it("maps each state reached to exactly one stamp; CANCELLED and NEW carry none", () => {
    expect(KOT_STAMP).toEqual({ ACCEPTED: "acceptedAt", PREPARING: "startedAt", READY: "readyAt", SERVED: "servedAt" });
  });

  it("a new ticket has no stamps (nothing is fabricated at creation)", async () => {
    const [k] = await freshKots();
    const s = await stamps(k.id);
    expect(s.status).toBe("NEW");
    for (const f of STAMPS) expect(s[f]).toBeNull();
  });

  it("each valid transition sets its own stamp from the server clock and keeps the earlier ones", async () => {
    const [k] = await freshKots();
    const steps = [["ACCEPTED", "acceptedAt"], ["PREPARING", "startedAt"], ["READY", "readyAt"], ["SERVED", "servedAt"]] as const;
    let previous = await stamps(k.id);
    for (const [to, field] of steps) {
      const before = Date.now();
      const returned = await updateKOTStatus(kitchen, k.id, to);
      const after = Date.now();
      const now = await stamps(k.id);
      expect(now.status).toBe(to);
      expect(returned.status).toBe(to);
      expect(returned[field]?.getTime()).toBe(now[field]?.getTime()); // the caller sees the stored stamp
      expect(now[field]!.getTime()).toBeGreaterThanOrEqual(before);
      expect(now[field]!.getTime()).toBeLessThanOrEqual(after);
      // earlier stamps unchanged, later ones still empty
      for (const f of STAMPS) {
        if (f === field) continue;
        expect(now[f]?.getTime() ?? null).toBe(previous[f]?.getTime() ?? null);
      }
      previous = now;
    }
    const s = previous;
    expect(s.createdAt.getTime()).toBeLessThanOrEqual(s.acceptedAt!.getTime());
    expect(s.acceptedAt!.getTime()).toBeLessThanOrEqual(s.startedAt!.getTime());
    expect(s.startedAt!.getTime()).toBeLessThanOrEqual(s.readyAt!.getTime());
    expect(s.readyAt!.getTime()).toBeLessThanOrEqual(s.servedAt!.getTime());
    expect(await audits(k.id)).toBe(4);
  });

  it("repeating a transition never overwrites its stamp and writes no second audit row", async () => {
    const [k] = await freshKots();
    await updateKOTStatus(kitchen, k.id, "ACCEPTED");
    const first = await stamps(k.id);
    await new Promise((r) => setTimeout(r, 15));
    const again = await updateKOTStatus(kitchen, k.id, "ACCEPTED");
    expect(again.acceptedAt?.getTime()).toBe(first.acceptedAt!.getTime());
    expect((await stamps(k.id)).acceptedAt!.getTime()).toBe(first.acceptedAt!.getTime());
    expect(await audits(k.id)).toBe(1);
  });

  it("invalid transitions are refused and change nothing", async () => {
    const [k] = await freshKots();
    await updateKOTStatus(kitchen, k.id, "ACCEPTED");
    const before = await stamps(k.id);
    await expect(updateKOTStatus(kitchen, k.id, "SERVED")).rejects.toBeInstanceOf(ValidationError); // skips PREPARING / READY
    await expect(updateKOTStatus(kitchen, k.id, "READY")).rejects.toBeInstanceOf(ValidationError);
    await expect(updateKOTStatus(kitchen, k.id, "NEW")).rejects.toBeInstanceOf(ValidationError); // no going back
    await expect(updateKOTStatus(kitchen, k.id, "BOGUS" as never)).rejects.toThrow();
    expect(await stamps(k.id)).toEqual(before);
    expect(await audits(k.id)).toBe(1);

    // A cancelled ticket stays cancelled and gains no stamp.
    await updateKOTStatus(kitchen, k.id, "CANCELLED");
    await expect(updateKOTStatus(kitchen, k.id, "PREPARING")).rejects.toBeInstanceOf(ValidationError);
    const c = await stamps(k.id);
    expect(c).toMatchObject({ status: "CANCELLED", startedAt: null, readyAt: null, servedAt: null });
    expect(c.acceptedAt!.getTime()).toBe(before.acceptedAt!.getTime());
  });

  it("a rolled-back transaction leaves no status, stamp, item or audit change behind", async () => {
    const [k] = await freshKots();
    await expect(
      prisma.$transaction(async (tx) => {
        await updateKOTStatus(kitchen, k.id, "ACCEPTED", tx);
        expect((await tx.kot.findUniqueOrThrow({ where: { id: k.id } })).acceptedAt).not.toBeNull(); // written inside
        throw new Error("boom after the KOT update");
      })
    ).rejects.toThrow("boom");
    const s = await stamps(k.id);
    expect(s.status).toBe("NEW");
    for (const f of STAMPS) expect(s[f]).toBeNull();
    expect(await prisma.kotItem.count({ where: { kotId: k.id, status: { not: "NEW" } } })).toBe(0);
    expect(await audits(k.id)).toBe(0);
  });

  it("concurrent identical requests apply the move once with one stamp", async () => {
    const [k] = await freshKots();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => updateKOTStatus(kitchen, k.id, "ACCEPTED")));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const s = await stamps(k.id);
    expect(s.status).toBe("ACCEPTED");
    const values = results.map((r) => (r as PromiseFulfilledResult<{ acceptedAt: Date | null }>).value.acceptedAt?.getTime());
    expect(new Set(values)).toEqual(new Set([s.acceptedAt!.getTime()]));
    expect(await audits(k.id)).toBe(1);
  });

  it("concurrent conflicting requests end in one valid state with only that state's stamps", async () => {
    const [k] = await freshKots();
    await updateKOTStatus(kitchen, k.id, "ACCEPTED");
    const results = await Promise.allSettled([updateKOTStatus(kitchen, k.id, "PREPARING"), updateKOTStatus(kitchen, k.id, "CANCELLED")]);
    const s = await stamps(k.id);
    expect(["PREPARING", "CANCELLED"]).toContain(s.status);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ValidationError);
    if (s.status === "CANCELLED" && results[0].status === "rejected") expect(s.startedAt).toBeNull(); // cancel won first
    expect(s.readyAt).toBeNull();
    expect(s.servedAt).toBeNull();
  });

  it("compare-and-set: a request that read a stale status never overwrites a newer state or stamp", async () => {
    const [k] = await freshKots();
    const stale = await prisma.kot.findUniqueOrThrow({ where: { id: k.id } }); // read while NEW
    // Simulate the interleaving SQLite's single writer hides: our request read NEW, another moved the ticket on.
    const staleTx = (tx: Prisma.TransactionClient) => {
      let served = false;
      const kot = new Proxy(tx.kot, {
        get(target, prop, recv) {
          if (prop === "findUnique" && !served) { served = true; return async () => stale; }
          const v = Reflect.get(target, prop, recv);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      return new Proxy(tx, { get: (t, p, r) => (p === "kot" ? kot : Reflect.get(t, p, r)) });
    };

    // (a) the other request made the SAME move: ours is a no-op (stamp and audit untouched).
    await updateKOTStatus(kitchen, k.id, "ACCEPTED");
    const won = await stamps(k.id);
    await new Promise((r) => setTimeout(r, 15));
    const noop = await prisma.$transaction((tx) => updateKOTStatus(kitchen, k.id, "ACCEPTED", staleTx(tx)));
    expect(noop.acceptedAt?.getTime()).toBe(won.acceptedAt!.getTime());
    expect(await stamps(k.id)).toEqual(won);
    expect(await audits(k.id)).toBe(1);

    // (b) the ticket moved further: ours is refused with a conflict, nothing changes.
    await updateKOTStatus(kitchen, k.id, "PREPARING");
    const further = await stamps(k.id);
    await expect(prisma.$transaction((tx) => updateKOTStatus(kitchen, k.id, "ACCEPTED", staleTx(tx)))).rejects.toBeInstanceOf(ConflictError);
    expect(await stamps(k.id)).toEqual(further);
    expect(await audits(k.id)).toBe(2);
  });

  it("each KOT / station gets its own stamps; other tickets of the same order are untouched", async () => {
    const kots = await freshKots([{ menuItemId: dosa, qty: 1 }, { menuItemId: cola, qty: 2 }]);
    expect(kots.map((k) => k.station?.name).sort()).toEqual(["BAR", "KITCHEN"]);
    const kit = kots.find((k) => k.station?.name === "KITCHEN")!;
    const bar = kots.find((k) => k.station?.name === "BAR")!;
    await updateKOTStatus(kitchen, kit.id, "ACCEPTED");
    await updateKOTStatus(kitchen, kit.id, "PREPARING");
    await updateKOTStatus(kitchen, bar.id, "ACCEPTED");
    const k = await stamps(kit.id);
    const b = await stamps(bar.id);
    expect(k.status).toBe("PREPARING");
    expect(k.startedAt).not.toBeNull();
    expect(b.status).toBe("ACCEPTED");
    expect(b.acceptedAt).not.toBeNull();
    expect(b.startedAt).toBeNull();
    expect(b.acceptedAt!.getTime()).toBeGreaterThanOrEqual(k.startedAt!.getTime()); // recorded at its own transition
  });

  it("stamps are stored as UTC wall-clock time with millisecond precision (independent of the server time zone)", async () => {
    const [k] = await freshKots();
    const moved = await updateKOTStatus(kitchen, k.id, "ACCEPTED");
    const at = moved.acceptedAt!;
    if (onPostgres) {
      // Column type from the PostgreSQL migration: TIMESTAMP(3) WITHOUT TIME ZONE, holding UTC as Prisma writes it.
      const [col] = await prisma.$queryRaw<{ data_type: string; datetime_precision: number }[]>`
        SELECT data_type, datetime_precision FROM information_schema.columns WHERE table_name = 'Kot' AND column_name = 'acceptedAt'`;
      expect(col).toEqual({ data_type: "timestamp without time zone", datetime_precision: 3 });
      const [raw] = await prisma.$queryRaw<{ t: string; tz: string }[]>`
        SELECT to_char("acceptedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS t, current_setting('TimeZone') AS tz FROM "Kot" WHERE id = ${k.id}`;
      expect(`${raw.t}Z`).toBe(at.toISOString()); // stored digits are UTC even when the session zone is not
      process.stdout.write(`[pg] session TimeZone=${raw.tz}, stored=${raw.t}, ISO=${at.toISOString()}\n`);
    } else {
      const [raw] = await prisma.$queryRaw<{ t: bigint | number }[]>`SELECT "acceptedAt" AS t FROM "Kot" WHERE id = ${k.id}`;
      expect(Number(raw.t)).toBe(at.getTime()); // epoch milliseconds (UTC)
    }
    expect(at.getUTCMilliseconds()).toBe((await stamps(k.id)).acceptedAt!.getUTCMilliseconds()); // ms survive the round trip
  });

  it("a serialization-conflict retry re-runs from scratch: the aborted attempt leaves no stamp or audit, the retry writes one", async () => {
    const [k] = await freshKots();
    let attempts = 0;
    let abortedStamp: Date | null = null;
    // A client whose first transaction does the real work, then aborts as PostgreSQL does (P2034).
    const flaky = {
      $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, opts?: object) =>
        prisma.$transaction(async (tx) => {
          const r = await fn(tx);
          if (++attempts === 1) {
            abortedStamp = (await tx.kot.findUniqueOrThrow({ where: { id: k.id } })).acceptedAt;
            throw conflict();
          }
          return r;
        }, opts),
    } as unknown as PrismaClient;
    await new Promise((r) => setTimeout(r, 5));
    const done = await updateKOTStatus(kitchen, k.id, "ACCEPTED", flaky);
    expect(attempts).toBe(2);
    expect(abortedStamp).not.toBeNull(); // the first attempt really wrote, inside its transaction
    const s = await stamps(k.id);
    expect(s.status).toBe("ACCEPTED");
    expect(s.acceptedAt!.getTime()).toBe(done.acceptedAt!.getTime()); // the committed (retry) stamp
    expect(s.acceptedAt!.getTime()).toBeGreaterThanOrEqual(abortedStamp!.getTime());
    expect(await audits(k.id)).toBe(1); // no duplicate audit from the aborted attempt
    expect(await prisma.kotItem.count({ where: { kotId: k.id, status: "ACCEPTED" } })).toBe(1);
  });

  it("an exhausted retry budget surfaces a safe 503 Busy and leaves the ticket untouched", async () => {
    const [k] = await freshKots();
    let attempts = 0;
    const alwaysConflicts = {
      $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, opts?: object) =>
        prisma.$transaction(async (tx) => { await fn(tx); attempts++; throw conflict(); }, opts),
    } as unknown as PrismaClient;
    const err = await updateKOTStatus(kitchen, k.id, "ACCEPTED", alwaysConflicts).then(() => null, (e: unknown) => e);
    expect(attempts).toBe(8); // MAX_TX_ATTEMPTS in services/_workflow.ts
    expect((err as { code?: string }).code).toBe("P2034");
    const res = fail(err);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("Busy");
    const s = await stamps(k.id);
    expect(s.status).toBe("NEW");
    for (const f of STAMPS) expect(s[f]).toBeNull();
    expect(await audits(k.id)).toBe(0);
  });

  it("a 20-way burst of the same move on one ticket commits once (real database concurrency, retries counted)", async () => {
    const [k] = await freshKots();
    await updateKOTStatus(kitchen, k.id, "ACCEPTED");
    let transactions = 0;
    const counting = new Proxy(prisma, {
      get: (t, p, r) => (p === "$transaction" ? (...a: Parameters<PrismaClient["$transaction"]>) => { transactions++; return (t.$transaction as (...x: unknown[]) => unknown)(...a); } : Reflect.get(t, p, r)),
    });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => updateKOTStatus(kitchen, k.id, "PREPARING", counting)));
    const rejected = results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason));
    expect(rejected).toEqual([]);
    const s = await stamps(k.id);
    expect(s.status).toBe("PREPARING");
    expect(s.readyAt).toBeNull();
    const startedValues = new Set(results.map((r) => (r as PromiseFulfilledResult<{ startedAt: Date | null }>).value.startedAt?.getTime()));
    expect(startedValues).toEqual(new Set([s.startedAt!.getTime()]));
    expect(await prisma.auditLog.count({ where: { entityType: "Kot", entityId: k.id, after: { contains: "PREPARING" } } })).toBe(1);
    process.stdout.write(`[${onPostgres ? "pg" : "sqlite"}] 20-way burst: ${transactions} transactions for 20 requests (${transactions - 20} serialization retries)\n`);
  });

  it("authorization and tenancy are still enforced before any stamp is written", async () => {
    const [k] = await freshKots();
    await expect(updateKOTStatus(cashier, k.id, "ACCEPTED")).rejects.toBeInstanceOf(ForbiddenError); // no kot.update
    await expect(updateKOTStatus(captain, k.id, "ACCEPTED")).rejects.toBeInstanceOf(ForbiddenError); // kot.serve only serves
    await expect(updateKOTStatus(otherKitchen, k.id, "ACCEPTED")).rejects.toBeInstanceOf(ForbiddenError); // other outlet
    await expect(updateKOTStatus(foreignKitchen, k.id, "ACCEPTED")).rejects.toBeInstanceOf(NotFoundError); // other org
    let s = await stamps(k.id);
    expect(s.status).toBe("NEW");
    for (const f of STAMPS) expect(s[f]).toBeNull();
    expect(await audits(k.id)).toBe(0);

    // Floor staff may hand over READY food: the captain's SERVED sets servedAt, audited as the captain.
    for (const to of ["ACCEPTED", "PREPARING", "READY"] as const) await updateKOTStatus(kitchen, k.id, to);
    await updateKOTStatus(captain, k.id, "SERVED");
    s = await stamps(k.id);
    expect(s.servedAt).not.toBeNull();
    const last = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Kot", entityId: k.id }, orderBy: { createdAt: "desc" } });
    expect(last.actorId).toBe(captain.userId);
    expect(JSON.parse(last.after!)).toEqual({ status: "SERVED" });
  });
});
