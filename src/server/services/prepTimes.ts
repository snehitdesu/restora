/**
 * Measured preparation time (proposal p. 16: "average prep time per dish, measured" and "late tickets before the guest
 * complains"). Nothing is estimated: a ticket's time is the gap between the moment it reached the kitchen and the
 * moment the kitchen marked it READY, both stamped by the KOT lifecycle (`Kot.createdAt`, `Kot.readyAt`). The cooking
 * time (READY minus the moment someone pressed Start, else Accept) is reported next to it.
 *
 * A ticket carries several dishes and the kitchen cooks them together, so every dish on a ticket is credited with the
 * ticket's time; that is what a guest waits for, and it is why a slow dish drags its neighbours into the number.
 * Cancelled tickets and tickets nobody marked READY are not samples.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { type AccessContext, assertOutletAccess } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";

/** A dish needs this many measured tickets before its time is used as an expectation. */
export const PREP_MIN_SAMPLES = 3;
export const PREP_MAX_TICKETS = 5000;

const querySchema = z.object({
  outletId: z.string().min(1),
  days: z.coerce.number().int().min(1).max(365).default(30),
  stationId: z.string().min(1).optional(),
});

export type PrepStat = { tickets: number; averageMinutes: number; medianMinutes: number; p90Minutes: number; cookMedianMinutes: number | null };
export type DishPrep = PrepStat & { key: string; menuItemId: string | null; name: string; reliable: boolean };
export type StationPrep = PrepStat & { stationId: string | null; name: string };

const round1 = (n: number) => Math.round(n * 10) / 10;
/** Linear-interpolated percentile of a sorted list (0..1). */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function stat(totals: number[], cooks: number[]): PrepStat {
  const s = [...totals].sort((a, b) => a - b);
  const c = [...cooks].sort((a, b) => a - b);
  return {
    tickets: s.length,
    averageMinutes: s.length ? round1(s.reduce((a, b) => a + b, 0) / s.length) : 0,
    medianMinutes: round1(percentile(s, 0.5)),
    p90Minutes: round1(percentile(s, 0.9)),
    cookMedianMinutes: c.length ? round1(percentile(c, 0.5)) : null,
  };
}

export async function dishPrepTimes(db: PrismaClient, ctx: AccessContext, input: z.input<typeof querySchema>, now = new Date()) {
  const q = querySchema.parse(input);
  assertOutletAccess(ctx, q.outletId);
  assertCan(ctx, "kot.view", q.outletId);
  const since = new Date(now.getTime() - q.days * 86400_000);
  const kots = await db.kot.findMany({
    where: { organizationId: ctx.organizationId, outletId: q.outletId, status: { in: ["READY", "SERVED"] }, readyAt: { not: null, gte: since }, ...(q.stationId ? { stationId: q.stationId } : {}) },
    orderBy: { readyAt: "desc" },
    take: PREP_MAX_TICKETS,
    select: { createdAt: true, startedAt: true, acceptedAt: true, readyAt: true, stationId: true, station: { select: { name: true } }, items: { select: { name: true, orderItem: { select: { menuItemId: true } } } } },
  });
  const all: number[] = [];
  const allCook: number[] = [];
  const dish = new Map<string, { menuItemId: string | null; name: string; totals: number[]; cooks: number[] }>();
  const station = new Map<string, { stationId: string | null; name: string; totals: number[]; cooks: number[] }>();
  for (const k of kots) {
    const total = (k.readyAt!.getTime() - k.createdAt.getTime()) / 60000;
    if (!(total >= 0) || total > 12 * 60) continue; // a clock fix or a ticket left open overnight is not a measurement
    const began = k.startedAt ?? k.acceptedAt;
    const cook = began && k.readyAt!.getTime() >= began.getTime() ? (k.readyAt!.getTime() - began.getTime()) / 60000 : null;
    all.push(total);
    if (cook !== null) allCook.push(cook);
    const sk = k.stationId ?? "none";
    const s = station.get(sk) ?? station.set(sk, { stationId: k.stationId, name: k.station?.name ?? "No station", totals: [], cooks: [] }).get(sk)!;
    s.totals.push(total);
    if (cook !== null) s.cooks.push(cook);
    for (const key of new Set(k.items.map((i) => i.orderItem?.menuItemId ?? `name:${i.name}`))) {
      const item = k.items.find((i) => (i.orderItem?.menuItemId ?? `name:${i.name}`) === key)!;
      const d = dish.get(key) ?? dish.set(key, { menuItemId: item.orderItem?.menuItemId ?? null, name: item.name, totals: [], cooks: [] }).get(key)!;
      d.totals.push(total);
      if (cook !== null) d.cooks.push(cook);
    }
  }
  const dishes: DishPrep[] = [...dish.entries()]
    .map(([key, d]) => ({ key, menuItemId: d.menuItemId, name: d.name, ...stat(d.totals, d.cooks), reliable: d.totals.length >= PREP_MIN_SAMPLES }))
    .sort((a, b) => Number(b.reliable) - Number(a.reliable) || b.medianMinutes - a.medianMinutes || a.name.localeCompare(b.name))
    .slice(0, 300);
  const stations: StationPrep[] = [...station.values()].map((s) => ({ stationId: s.stationId, name: s.name, ...stat(s.totals, s.cooks) })).sort((a, b) => b.medianMinutes - a.medianMinutes);
  return { outletId: q.outletId, days: q.days, minSamples: PREP_MIN_SAMPLES, overall: stat(all, allCook), dishes, stations, truncated: kots.length >= PREP_MAX_TICKETS };
}
