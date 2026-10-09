/**
 * Staff operations beyond attendance and leave (audit SO-03, SO-05, SO-06, SO-07):
 *
 *   roster            who works which shift on which day (a person once per shift per day, never two overlapping shifts,
 *                     never on a day of approved leave), a week grid for the manager and "my shifts" for everyone
 *   checklists        reusable duty lists (opening, closing, training) that become one task per item for a day; starting
 *                     the same list twice for a day makes each task once, and an item added later is added on the next start
 *   staffHours        hours worked per person from the attendance records, with overtime beyond a daily limit, for payroll
 *   salesByStaff      what each person rang up (orders and sales that were paid), for incentives and coaching
 *
 * Nothing here pays anybody: hours are the payroll input, not a payroll. No tip is recorded anywhere in RESTORA, so none is shared out.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { D, num } from "@/domain/money";
import { localDate } from "@/domain/time";
import { Priority } from "@/constants/enums";
import { outletTimeZone } from "@/server/services/businessDay";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { authorizedOutletIds } from "@/server/services/analytics";

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-12").refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, "That date does not exist");
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayIndex = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const actor = (ctx: AccessContext) => (ctx.userId === "system" ? null : ctx.userId);

/** A shift on a day as minutes since the epoch day 0; a shift that ends at or before it starts runs into the next morning. */
function interval(day: string, startTime: string, endTime: string): [number, number] {
  const start = dayIndex(day) * 1440 + minutes(startTime);
  let end = dayIndex(day) * 1440 + minutes(endTime);
  if (end <= start) end += 1440;
  return [start, end];
}

async function worksAt(tx: Tx | PrismaClient, ctx: AccessContext, userId: string, outletId: string) {
  return Boolean(await tx.membership.findFirst({ where: { organizationId: ctx.organizationId, userId, active: true, OR: [{ outletId }, { outletId: null }] }, select: { id: true } }));
}

// ============================================================
// Roster
// ============================================================

const assignSchema = z.object({ shiftId: z.string().min(1), userId: z.string().min(1), date: dayString }).strict();

/** Put somebody on a shift on a day. Repeating it is a no-op. */
export async function assignShift(ctx: AccessContext, input: z.input<typeof assignSchema>, db: Client = prisma) {
  const data = assignSchema.parse(input);
  return runInTx(db, async (tx) => {
    const shift = await tx.shift.findUnique({ where: { id: data.shiftId } });
    if (!shift || shift.organizationId !== ctx.organizationId) throw new NotFoundError("Shift not found");
    assertOutletAccess(ctx, shift.outletId);
    assertCan(ctx, "staff.manage", shift.outletId);
    const user = await tx.user.findUnique({ where: { id: data.userId }, select: { id: true, organizationId: true, name: true, active: true } });
    if (!user || user.organizationId !== ctx.organizationId) throw new NotFoundError("User not found");
    if (!user.active) throw new ValidationError(`${user.name} is not active`);
    if (!(await worksAt(tx, ctx, user.id, shift.outletId))) throw new ValidationError(`${user.name} has no active role at this outlet`);

    const existing = await tx.shiftAssignment.findUnique({ where: { shiftId_userId_date: { shiftId: shift.id, userId: user.id, date: data.date } } });
    if (existing) return { assignment: existing, created: false };

    const leaves = await tx.leaveRequest.findMany({ where: { organizationId: ctx.organizationId, userId: user.id, status: "APPROVED" }, select: { fromDate: true, toDate: true } });
    if (leaves.some((l) => l.fromDate.toISOString().slice(0, 10) <= data.date && data.date <= l.toDate.toISOString().slice(0, 10))) throw new ValidationError(`${user.name} is on approved leave on ${data.date}`);

    // No two shifts at once, at this or any other outlet: look at the day before, the day itself and the day after.
    const near = await tx.shiftAssignment.findMany({ where: { organizationId: ctx.organizationId, userId: user.id, date: { in: [addDays(data.date, -1), data.date, addDays(data.date, 1)] } }, include: { shift: { select: { name: true, startTime: true, endTime: true } } } });
    const [s, e] = interval(data.date, shift.startTime, shift.endTime);
    for (const other of near) {
      const [os, oe] = interval(other.date, other.shift.startTime, other.shift.endTime);
      if (s < oe && os < e) throw new ValidationError(`${user.name} is already on ${other.shift.name} (${other.shift.startTime}–${other.shift.endTime}) on ${other.date}, which overlaps`);
    }

    let row;
    try {
      row = await tx.shiftAssignment.create({ data: { organizationId: ctx.organizationId, outletId: shift.outletId, shiftId: shift.id, userId: user.id, date: data.date, createdById: actor(ctx) } });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") return { assignment: await tx.shiftAssignment.findUniqueOrThrow({ where: { shiftId_userId_date: { shiftId: shift.id, userId: user.id, date: data.date } } }), created: false };
      throw err;
    }
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "ShiftAssignment", entityId: row.id, outletId: shift.outletId, after: { shift: shift.name, userId: user.id, date: data.date } });
    return { assignment: row, created: true };
  });
}

export async function unassignShift(ctx: AccessContext, assignmentId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const a = await tx.shiftAssignment.findUnique({ where: { id: assignmentId }, include: { shift: { select: { name: true } } } });
    if (!a || a.organizationId !== ctx.organizationId) throw new NotFoundError("Roster entry not found");
    assertOutletAccess(ctx, a.outletId);
    assertCan(ctx, "staff.manage", a.outletId);
    await tx.shiftAssignment.delete({ where: { id: a.id } });
    await writeAudit(tx, ctx, { action: "VOID", entityType: "ShiftAssignment", entityId: a.id, outletId: a.outletId, before: { shift: a.shift.name, userId: a.userId, date: a.date } });
    return { id: a.id, removed: true };
  });
}

const rosterSchema = z.object({ outletId: z.string().min(1), from: dayString, days: z.coerce.number().int().min(1).max(31).default(7) });

export type RosterDay = { date: string; shifts: Array<{ shiftId: string; name: string; startTime: string; endTime: string; people: Array<{ assignmentId: string; userId: string; name: string; onLeave: boolean }> }> };
export type RosterView = { outletId: string; from: string; days: RosterDay[]; people: Array<{ id: string; name: string }> };

/** The manager's grid: every shift of the outlet on every day, with who is on it and who is also on leave. */
export async function roster(db: PrismaClient, ctx: AccessContext, input: z.input<typeof rosterSchema>): Promise<RosterView> {
  const q = rosterSchema.parse(input);
  assertOutletAccess(ctx, q.outletId);
  assertCan(ctx, "staff.manage", q.outletId);
  const dates = Array.from({ length: q.days }, (_, i) => addDays(q.from, i));
  const [shifts, rows, leaves, members] = await Promise.all([
    db.shift.findMany({ where: { organizationId: ctx.organizationId, outletId: q.outletId }, orderBy: [{ startTime: "asc" }, { id: "asc" }] }),
    db.shiftAssignment.findMany({ where: { organizationId: ctx.organizationId, outletId: q.outletId, date: { gte: dates[0], lte: dates[dates.length - 1] } }, include: { shift: { select: { id: true } } } }),
    db.leaveRequest.findMany({ where: { organizationId: ctx.organizationId, status: "APPROVED", fromDate: { lte: new Date(`${dates[dates.length - 1]}T23:59:59Z`) }, toDate: { gte: new Date(`${dates[0]}T00:00:00Z`) } }, select: { userId: true, fromDate: true, toDate: true } }),
    db.user.findMany({ where: { organizationId: ctx.organizationId, active: true, memberships: { some: { active: true, OR: [{ outletId: q.outletId }, { outletId: null }] } } }, select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] }),
  ]);
  const names = new Map(members.map((m) => [m.id, m.name]));
  const missing = [...new Set(rows.map((r) => r.userId))].filter((id) => !names.has(id));
  if (missing.length) for (const u of await db.user.findMany({ where: { organizationId: ctx.organizationId, id: { in: missing } }, select: { id: true, name: true } })) names.set(u.id, u.name);
  const onLeave = (userId: string, date: string) => leaves.some((l) => l.userId === userId && l.fromDate.toISOString().slice(0, 10) <= date && date <= l.toDate.toISOString().slice(0, 10));
  return {
    outletId: q.outletId,
    from: q.from,
    people: members,
    days: dates.map((date) => ({
      date,
      shifts: shifts.map((s) => ({
        shiftId: s.id, name: s.name, startTime: s.startTime, endTime: s.endTime,
        people: rows.filter((r) => r.date === date && r.shiftId === s.id).map((r) => ({ assignmentId: r.id, userId: r.userId, name: names.get(r.userId) ?? "Former staff", onLeave: onLeave(r.userId, date) })).sort((a, b) => a.name.localeCompare(b.name) || a.assignmentId.localeCompare(b.assignmentId)),
      })),
    })),
  };
}

const mineSchema = z.object({ from: dayString.optional(), days: z.coerce.number().int().min(1).max(60).default(14) });

/** The caller's own upcoming shifts, at any outlet they can reach. */
export async function myShifts(db: PrismaClient, ctx: AccessContext, input: z.input<typeof mineSchema> = {}) {
  const q = mineSchema.parse(input);
  const from = q.from ?? new Date().toISOString().slice(0, 10);
  const rows = await db.shiftAssignment.findMany({
    where: { organizationId: ctx.organizationId, userId: ctx.userId, date: { gte: from, lte: addDays(from, q.days - 1) } },
    include: { shift: { select: { name: true, startTime: true, endTime: true } } },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });
  const outlets = new Map((await db.outlet.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...new Set(rows.map((r) => r.outletId))] } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
  return rows.filter((r) => ctx.isOrgWide || ctx.outletIds.includes(r.outletId)).map((r) => ({ id: r.id, date: r.date, outletId: r.outletId, outlet: outlets.get(r.outletId) ?? "", shift: r.shift.name, startTime: r.shift.startTime, endTime: r.shift.endTime }));
}

// ============================================================
// Checklists
// ============================================================

export const CHECKLIST_KINDS = ["OPENING", "CLOSING", "TRAINING", "OTHER"] as const;
const itemSchema = z.object({ id: z.string().min(1).optional(), title: z.string().trim().min(1).max(160), description: z.string().trim().max(500).nullable().optional(), priority: Priority.zod.default("MEDIUM") }).strict();
const templateSchema = z.object({
  outletId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(CHECKLIST_KINDS).default("OPENING"),
  items: z.array(itemSchema).min(1, "A checklist needs at least one item").max(60),
}).strict();

async function loadTemplate(tx: Tx | PrismaClient, ctx: AccessContext, id: string) {
  const t = await tx.checklistTemplate.findUnique({ where: { id }, include: { items: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] } } });
  if (!t || t.organizationId !== ctx.organizationId) throw new NotFoundError("Checklist not found");
  assertOutletAccess(ctx, t.outletId);
  return t;
}

export async function createChecklistTemplate(ctx: AccessContext, input: z.input<typeof templateSchema>, db: Client = prisma) {
  const data = templateSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "task.manage", data.outletId);
  return runInTx(db, async (tx) => {
    const outlet = await tx.outlet.findUnique({ where: { id: data.outletId }, select: { organizationId: true } });
    if (!outlet || outlet.organizationId !== ctx.organizationId) throw new NotFoundError("Outlet not found");
    if (await tx.checklistTemplate.findUnique({ where: { outletId_name: { outletId: data.outletId, name: data.name } } })) throw new ValidationError(`A checklist called "${data.name}" already exists at this outlet`);
    const t = await tx.checklistTemplate.create({
      data: {
        organizationId: ctx.organizationId, outletId: data.outletId, name: data.name, kind: data.kind, createdById: actor(ctx),
        items: { create: data.items.map((i, n) => ({ title: i.title, description: i.description ?? null, priority: i.priority, sortOrder: n })) },
      },
      include: { items: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] } },
    });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "ChecklistTemplate", entityId: t.id, outletId: data.outletId, after: { name: data.name, kind: data.kind, items: data.items.length } });
    return t;
  });
}

const patchSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), kind: z.enum(CHECKLIST_KINDS).optional(), active: z.boolean().optional(), items: z.array(itemSchema).min(1).max(60).optional() }).strict();

/**
 * Rename, retire, or replace the items. An item that keeps its id keeps its place in the days already started; an item left
 * out is removed from the list (tasks already made from it stay); an item without an id is new.
 */
export async function updateChecklistTemplate(ctx: AccessContext, id: string, patch: z.input<typeof patchSchema>, db: Client = prisma) {
  const data = patchSchema.parse(patch);
  return runInTx(db, async (tx) => {
    const t = await loadTemplate(tx, ctx, id);
    assertCan(ctx, "task.manage", t.outletId);
    if (data.name && data.name !== t.name && (await tx.checklistTemplate.findUnique({ where: { outletId_name: { outletId: t.outletId, name: data.name } } }))) throw new ValidationError(`A checklist called "${data.name}" already exists at this outlet`);
    if (data.items) {
      const known = new Set(t.items.map((i) => i.id));
      for (const i of data.items) if (i.id && !known.has(i.id)) throw new ValidationError("An item does not belong to this checklist");
      const keep = new Set(data.items.map((i) => i.id).filter((x): x is string => Boolean(x)));
      const drop = t.items.filter((i) => !keep.has(i.id)).map((i) => i.id);
      if (drop.length) await tx.checklistTemplateItem.deleteMany({ where: { templateId: id, id: { in: drop } } });
      for (const [n, i] of data.items.entries()) {
        if (i.id) await tx.checklistTemplateItem.update({ where: { id: i.id }, data: { title: i.title, description: i.description ?? null, priority: i.priority, sortOrder: n } });
        else await tx.checklistTemplateItem.create({ data: { templateId: id, title: i.title, description: i.description ?? null, priority: i.priority, sortOrder: n } });
      }
    }
    await tx.checklistTemplate.update({ where: { id }, data: { name: data.name, kind: data.kind, active: data.active } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "ChecklistTemplate", entityId: id, outletId: t.outletId, before: { name: t.name, kind: t.kind, active: t.active, items: t.items.length }, after: { ...data, items: data.items?.length } });
    return loadTemplate(tx, ctx, id);
  });
}

const listSchema = z.object({ outletId: z.string().min(1), date: dayString.optional(), includeInactive: z.coerce.boolean().default(false) });
export type ChecklistRun = { total: number; open: number; inProgress: number; done: number; verified: number };

/** The outlet's checklists; with a date, how far each one has got that day. */
export async function listChecklistTemplates(db: PrismaClient, ctx: AccessContext, input: z.input<typeof listSchema>) {
  const q = listSchema.parse(input);
  assertOutletAccess(ctx, q.outletId);
  assertCan(ctx, "task.view", q.outletId);
  const templates = await db.checklistTemplate.findMany({
    where: { organizationId: ctx.organizationId, outletId: q.outletId, ...(q.includeInactive ? {} : { active: true }) },
    include: { items: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] } },
    orderBy: [{ kind: "asc" }, { name: "asc" }, { id: "asc" }],
  });
  let progress = new Map<string, ChecklistRun>();
  if (q.date) {
    const tasks = await db.task.findMany({ where: { organizationId: ctx.organizationId, outletId: q.outletId, runDate: q.date, templateItemId: { not: null }, status: { not: "CANCELLED" } }, select: { templateItemId: true, status: true } });
    const owner = new Map(templates.flatMap((t) => t.items.map((i) => [i.id, t.id] as const)));
    progress = new Map(templates.map((t) => [t.id, { total: 0, open: 0, inProgress: 0, done: 0, verified: 0 }]));
    for (const task of tasks) {
      const run = progress.get(owner.get(task.templateItemId!) ?? "");
      if (!run) continue;
      run.total++;
      if (task.status === "OPEN") run.open++;
      else if (task.status === "IN_PROGRESS") run.inProgress++;
      else if (task.status === "DONE") run.done++;
      else if (task.status === "VERIFIED") run.verified++;
    }
  }
  return templates.map((t) => ({ ...t, run: q.date ? progress.get(t.id) ?? null : null }));
}

const startSchema = z.object({ date: dayString.optional(), assignedToId: z.string().min(1).optional(), dueAt: z.coerce.date().optional() }).strict();

/** Make the day's tasks from a checklist. Safe to repeat: each item becomes one task per day. */
export async function startChecklist(ctx: AccessContext, templateId: string, input: z.input<typeof startSchema> = {}, db: Client = prisma) {
  const data = startSchema.parse(input);
  return runInTx(db, async (tx) => {
    const t = await loadTemplate(tx, ctx, templateId);
    assertCan(ctx, "task.manage", t.outletId);
    if (!t.active) throw new ValidationError("This checklist is retired");
    const tz = await outletTimeZone(tx as PrismaClient, ctx, t.outletId);
    const today = localDate(new Date(), tz);
    const date = data.date ?? today;
    if (date < today) throw new ValidationError("A checklist cannot be started for a day that has passed");
    if (date > addDays(today, 30)) throw new ValidationError("A checklist can be started at most 30 days ahead");
    if (data.assignedToId && !(await worksAt(tx, ctx, data.assignedToId, t.outletId))) throw new ValidationError("The person has no active role at this outlet");
    const have = new Set((await tx.task.findMany({ where: { templateItemId: { in: t.items.map((i) => i.id) }, runDate: date }, select: { templateItemId: true } })).map((x) => x.templateItemId));
    let created = 0;
    for (const item of t.items) {
      if (have.has(item.id)) continue;
      await tx.task.create({
        data: {
          organizationId: ctx.organizationId, outletId: t.outletId, title: item.title, description: [`${t.name}`, item.description].filter(Boolean).join(": "), priority: item.priority,
          assignedToId: data.assignedToId, dueAt: data.dueAt, status: "OPEN", createdById: actor(ctx), templateItemId: item.id, runDate: date,
        },
      });
      created++;
    }
    if (created) await writeAudit(tx, ctx, { action: "CREATE", entityType: "ChecklistTemplate", entityId: t.id, outletId: t.outletId, after: { started: date, tasks: created, assignedToId: data.assignedToId ?? null } });
    return { templateId: t.id, date, created, existing: t.items.length - created };
  });
}

// ============================================================
// Hours and overtime
// ============================================================

const hoursSchema = z.object({
  outletId: z.string().optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  /** Hours in one day beyond which the rest is overtime. */
  dailyHours: z.coerce.number().min(1).max(24).default(8),
}).refine((f) => f.from <= f.to, { message: "`from` must be on or before `to`" });
const MAX_ATTENDANCE_ROWS = 20_000;

export type HoursRow = { userId: string; name: string; days: number; shifts: number; hours: number; regularHours: number; overtimeHours: number; openRecords: number };

/**
 * Hours worked per person, from attendance records that have both a check-in and a check-out in the range (the day a record
 * belongs to is the check-in day at its outlet). Overtime is whatever a person works in one day beyond `dailyHours`. A record with
 * no check-out is not counted as time worked; it is counted in `openRecords` so it can be corrected before payroll is run.
 */
export async function staffHours(db: PrismaClient, ctx: AccessContext, input: z.input<typeof hoursSchema>): Promise<{ rows: HoursRow[]; dailyHours: number; from: Date; to: Date }> {
  const f = hoursSchema.parse(input);
  const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "staff.manage");
  const records = await db.attendance.findMany({
    where: { organizationId: ctx.organizationId, outletId: { in: ids }, checkIn: { gte: f.from, lte: f.to } },
    select: { userId: true, outletId: true, checkIn: true, checkOut: true },
    orderBy: [{ checkIn: "asc" }, { id: "asc" }],
    take: MAX_ATTENDANCE_ROWS + 1,
  });
  if (records.length > MAX_ATTENDANCE_ROWS) throw new ValidationError("That range holds too many attendance records; choose a shorter one");
  const tz = new Map<string, string>();
  for (const id of new Set(records.map((r) => r.outletId))) tz.set(id, await outletTimeZone(db, ctx, id));
  const people = new Map<string, { perDay: Map<string, number>; shifts: number; open: number }>();
  for (const r of records) {
    const p = people.get(r.userId) ?? { perDay: new Map(), shifts: 0, open: 0 };
    people.set(r.userId, p);
    if (!r.checkOut) { p.open++; continue; }
    const hours = Math.max(0, (r.checkOut.getTime() - r.checkIn.getTime()) / 3_600_000);
    const day = localDate(r.checkIn, tz.get(r.outletId)!);
    p.perDay.set(day, (p.perDay.get(day) ?? 0) + hours);
    p.shifts++;
  }
  const users = await db.user.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...people.keys()] } }, select: { id: true, name: true } });
  const name = new Map(users.map((u) => [u.id, u.name]));
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const rows = [...people.entries()].map(([userId, p]): HoursRow => {
    let total = 0;
    let over = 0;
    for (const h of p.perDay.values()) { total += h; over += Math.max(0, h - f.dailyHours); }
    return { userId, name: name.get(userId) ?? "Former staff", days: p.perDay.size, shifts: p.shifts, hours: r2(total), regularHours: r2(total - over), overtimeHours: r2(over), openRecords: p.open };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
  return { rows, dailyHours: f.dailyHours, from: f.from, to: f.to };
}

// ============================================================
// Sales per staff member
// ============================================================

const salesSchema = z.object({ outletId: z.string().optional(), from: z.coerce.date(), to: z.coerce.date() }).refine((f) => f.from <= f.to, { message: "`from` must be on or before `to`" });
export type StaffSalesRow = { userId: string | null; name: string; orders: number; covers: number; sales: number; avgOrder: number; discounts: number };

/** What each person rang up: paid orders created by them in the range (refunded orders are left out; self-service and guest orders appear as one line without a name). */
export async function salesByStaff(db: PrismaClient, ctx: AccessContext, input: z.input<typeof salesSchema>): Promise<StaffSalesRow[]> {
  const f = salesSchema.parse(input);
  const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "reports.view");
  const grouped = await db.order.groupBy({
    by: ["createdById"],
    where: { organizationId: ctx.organizationId, outletId: { in: ids }, status: "PAID", createdAt: { gte: f.from, lte: f.to } },
    _count: { _all: true },
    _sum: { total: true, discount: true, covers: true },
  });
  const users = await db.user.findMany({ where: { organizationId: ctx.organizationId, id: { in: grouped.map((g) => g.createdById).filter((x): x is string => Boolean(x)) } }, select: { id: true, name: true } });
  const name = new Map(users.map((u) => [u.id, u.name]));
  const r2 = (n: ReturnType<typeof D>) => num(n.toDecimalPlaces(2));
  return grouped
    .map((g): StaffSalesRow => {
      const sales = D(g._sum.total ?? 0);
      return { userId: g.createdById, name: g.createdById ? name.get(g.createdById) ?? "Former staff" : "Guest or online orders", orders: g._count._all, covers: Number(g._sum.covers ?? 0), sales: r2(sales), avgOrder: g._count._all ? r2(sales.div(g._count._all)) : 0, discounts: r2(D(g._sum.discount ?? 0)) };
    })
    .sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name));
}
