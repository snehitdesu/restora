/**
 * Staff operations against the real services and database:
 *  R roster (SO-03)        S sales per staff member (SO-06)
 *  C checklists (SO-07)    H hours and overtime (SO-05)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import type { AccessContext } from "@/server/db/scope";
import { createShift, requestLeave, approveLeave } from "@/server/services/staff";
import { assignShift, unassignShift, roster, myShifts, createChecklistTemplate, updateChecklistTemplate, listChecklistTemplates, startChecklist, staffHours, salesByStaff } from "@/server/services/staffOps";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { settleAfterCommit } from "@/server/services/afterCommit";
import { getReport } from "@/server/services/reports";
import { transitionTask } from "@/server/services/staff";
import { makeEnv, member, uniq, type Env } from "./growthSupport";

let env: Env;
let manager: AccessContext;
let outletManagerB: AccessContext;
const people: Record<string, { id: string; ctx: AccessContext }> = {};
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function person(name: string, role = "CAPTAIN", outletId: string | null = env.outletA) {
  const u = await prisma.user.create({ data: { organizationId: env.orgId, email: `${name.toLowerCase()}-${uniq()}@staffops.test`, name, passwordHash: "x" } });
  await prisma.membership.create({ data: { organizationId: env.orgId, userId: u.id, outletId, role } });
  const ctx = outletId ? { ...member(env.orgId, role, outletId), userId: u.id } : { ...env.owner, userId: u.id };
  people[name] = { id: u.id, ctx };
  return people[name];
}
let n = 0;
const shift = (startTime: string, endTime: string, outletId = env.outletA) => createShift(manager, { outletId, name: `Shift ${++n} ${uniq()}`, startTime, endTime });

beforeAll(async () => {
  env = await makeEnv("Gso");
  manager = { ...member(env.orgId, "MANAGER", env.outletA), userId: `mgr-${uniq()}` };
  outletManagerB = { ...member(env.orgId, "MANAGER", env.outletB), userId: `mgrb-${uniq()}` };
}, 60000);
afterAll(async () => { await prisma.$disconnect(); });

describe("R. roster", () => {
  it("R1 a manager puts people on shifts; repeating is a no-op; the roster grid shows it", async () => {
    const asha = await person("Asha");
    const s = await shift("09:00", "17:00");
    const day = addDays(today(), 3);
    const first = await assignShift(manager, { shiftId: s.id, userId: asha.id, date: day });
    expect(first.created).toBe(true);
    const again = await assignShift(manager, { shiftId: s.id, userId: asha.id, date: day });
    expect(again).toMatchObject({ created: false, assignment: { id: first.assignment.id } });
    expect(await prisma.shiftAssignment.count({ where: { shiftId: s.id } })).toBe(1);

    const grid = await roster(prisma, manager, { outletId: env.outletA, from: today(), days: 7 });
    expect(grid.days).toHaveLength(7);
    const cell = grid.days.find((d) => d.date === day)!.shifts.find((x) => x.shiftId === s.id)!;
    expect(cell.people).toEqual([{ assignmentId: first.assignment.id, userId: asha.id, name: "Asha", onLeave: false }]);
    expect(grid.days.find((d) => d.date === today())!.shifts.find((x) => x.shiftId === s.id)!.people).toEqual([]);
    expect(grid.people.map((p) => p.name)).toContain("Asha");
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: env.orgId, entityType: "ShiftAssignment", entityId: first.assignment.id } });
    expect(audit?.action).toBe("CREATE");
  });

  it("R2 never two shifts at once, including a night shift that runs into the next morning", async () => {
    const bela = await person("Bela");
    const day = addDays(today(), 5);
    const night = await shift("22:00", "06:00");
    const morning = await shift("05:00", "09:00");
    const afternoon = await shift("14:00", "18:00");
    const earlier = await shift("20:00", "23:00");
    await assignShift(manager, { shiftId: night.id, userId: bela.id, date: day });
    await expect(assignShift(manager, { shiftId: morning.id, userId: bela.id, date: addDays(day, 1) })).rejects.toThrow(/overlaps/); // 05:00 is still inside last night's shift
    await expect(assignShift(manager, { shiftId: earlier.id, userId: bela.id, date: day })).rejects.toThrow(/overlaps/);
    await assignShift(manager, { shiftId: afternoon.id, userId: bela.id, date: addDays(day, 1) }); // after it ended
    await assignShift(manager, { shiftId: morning.id, userId: bela.id, date: addDays(day, 3) });
  });

  it("R3 not on a day of approved leave; not somebody without a role here, inactive, or from another restaurant", async () => {
    const chen = await person("Chen");
    const s = await shift("09:00", "17:00");
    const day = addDays(today(), 8);
    const leave = await requestLeave(chen.ctx, { outletId: env.outletA, fromDate: new Date(`${day}T00:00:00Z`), toDate: new Date(`${addDays(day, 1)}T00:00:00Z`), reason: "Wedding" });
    await assignShift(manager, { shiftId: s.id, userId: chen.id, date: day }); // pending leave does not block
    await unassignShift(manager, (await prisma.shiftAssignment.findFirstOrThrow({ where: { userId: chen.id } })).id);
    await approveLeave(manager, leave.id);
    await expect(assignShift(manager, { shiftId: s.id, userId: chen.id, date: day })).rejects.toThrow(/approved leave/);
    await expect(assignShift(manager, { shiftId: s.id, userId: chen.id, date: addDays(day, 2) })).resolves.toMatchObject({ created: true });

    const atB = await person("Dev", "CAPTAIN", env.outletB);
    await expect(assignShift(manager, { shiftId: s.id, userId: atB.id, date: day })).rejects.toThrow(/no active role at this outlet/);
    const gone = await person("Esha");
    await prisma.user.update({ where: { id: gone.id }, data: { active: false } });
    await expect(assignShift(manager, { shiftId: s.id, userId: gone.id, date: day })).rejects.toThrow(/not active/);
    await expect(assignShift(manager, { shiftId: s.id, userId: "nope", date: day })).rejects.toBeInstanceOf(NotFoundError);
    await expect(assignShift(env.foreign, { shiftId: s.id, userId: chen.id, date: day })).rejects.toBeInstanceOf(NotFoundError);
    await expect(assignShift(manager, { shiftId: s.id, userId: chen.id, date: "2026-02-30" })).rejects.toThrow(/does not exist/);
  });

  it("R4 only staff.manage at that outlet assigns, removes or reads the roster; a person sees their own shifts; leave shows on the grid", async () => {
    const fay = await person("Fay");
    const s = await shift("10:00", "18:00");
    const day = addDays(today(), 2);
    for (const ctx of [env.cashier, env.kitchen, outletManagerB]) await expect(assignShift(ctx, { shiftId: s.id, userId: fay.id, date: day })).rejects.toBeInstanceOf(ForbiddenError);
    const a = await assignShift(manager, { shiftId: s.id, userId: fay.id, date: day });
    await expect(unassignShift(env.cashier, a.assignment.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(roster(prisma, env.cashier, { outletId: env.outletA, from: day })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(roster(prisma, outletManagerB, { outletId: env.outletA, from: day })).rejects.toThrow();

    const mine = await myShifts(prisma, fay.ctx, { from: today(), days: 14 });
    expect(mine.map((m) => [m.date, m.shift, m.startTime, m.endTime])).toEqual([[day, s.name, "10:00", "18:00"]]);
    expect(await myShifts(prisma, env.cashier, { from: today() })).toEqual([]);

    const leave = await requestLeave(fay.ctx, { outletId: env.outletA, fromDate: new Date(`${day}T00:00:00Z`), toDate: new Date(`${day}T00:00:00Z`) });
    await approveLeave(manager, leave.id);
    const cell = (await roster(prisma, manager, { outletId: env.outletA, from: day, days: 1 })).days[0].shifts.find((x) => x.shiftId === s.id)!;
    expect(cell.people[0]).toMatchObject({ name: "Fay", onLeave: true }); // rostered before the leave was approved: flagged for the manager

    expect(await unassignShift(manager, a.assignment.id)).toMatchObject({ removed: true });
    expect(await prisma.shiftAssignment.count({ where: { id: a.assignment.id } })).toBe(0);
    await expect(unassignShift(manager, a.assignment.id)).rejects.toBeInstanceOf(NotFoundError);
    const voided = await prisma.auditLog.findFirst({ where: { organizationId: env.orgId, entityType: "ShiftAssignment", entityId: a.assignment.id, action: "VOID" } });
    expect(voided).not.toBeNull();
  });
});

describe("C. checklists", () => {
  const items = [{ title: "Unlock the front door" }, { title: "Switch on the fridges", priority: "HIGH" as const }, { title: "Count the float", description: "Two people" }];

  it("C1 a manager builds a checklist; names are unique per outlet; kitchen staff cannot", async () => {
    const t = await createChecklistTemplate(manager, { outletId: env.outletA, name: `Opening ${uniq()}`, kind: "OPENING", items });
    expect(t.items.map((i) => [i.title, i.priority, i.sortOrder])).toEqual([["Unlock the front door", "MEDIUM", 0], ["Switch on the fridges", "HIGH", 1], ["Count the float", "MEDIUM", 2]]);
    await expect(createChecklistTemplate(manager, { outletId: env.outletA, name: t.name, items })).rejects.toThrow(/already exists/);
    await expect(createChecklistTemplate(env.kitchen, { outletId: env.outletA, name: `K ${uniq()}`, items })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createChecklistTemplate(manager, { outletId: env.outletA, name: `Empty ${uniq()}`, items: [] })).rejects.toThrow(/at least one item/);
    await expect(createChecklistTemplate(manager, { outletId: env.outletB, name: `B ${uniq()}`, items })).rejects.toThrow();
    expect((await listChecklistTemplates(prisma, env.kitchen, { outletId: env.outletA })).map((x) => x.id)).toContain(t.id); // anyone who sees tasks sees the lists
    await expect(listChecklistTemplates(prisma, env.cashier, { outletId: env.outletB })).rejects.toThrow();
  });

  it("C2 starting it makes one task per item; starting it again makes none; an item added later is added alone", async () => {
    const t = await createChecklistTemplate(manager, { outletId: env.outletA, name: `Closing ${uniq()}`, kind: "CLOSING", items });
    const gina = await person("Gina");
    const first = await startChecklist(manager, t.id, { assignedToId: gina.id });
    expect(first).toMatchObject({ date: today(), created: 3, existing: 0 });
    const tasks = await prisma.task.findMany({ where: { runDate: today(), templateItemId: { in: t.items.map((i) => i.id) } }, orderBy: { createdAt: "asc" } });
    expect(tasks).toHaveLength(3);
    expect(tasks.every((x) => x.assignedToId === gina.id && x.status === "OPEN" && x.outletId === env.outletA)).toBe(true);
    expect(tasks[2].description).toContain("Two people");
    expect(await startChecklist(manager, t.id)).toMatchObject({ created: 0, existing: 3 });
    expect(await prisma.task.count({ where: { runDate: today(), templateItemId: { in: t.items.map((i) => i.id) } } })).toBe(3);

    const updated = await updateChecklistTemplate(manager, t.id, { items: [...t.items.map((i) => ({ id: i.id, title: i.title, description: i.description, priority: i.priority as "MEDIUM" })), { title: "Lock the safe" }] });
    expect(updated.items).toHaveLength(4);
    expect(await startChecklist(manager, t.id)).toMatchObject({ created: 1, existing: 3 });
    // Tomorrow is a fresh day.
    expect(await startChecklist(manager, t.id, { date: addDays(today(), 1) })).toMatchObject({ created: 4, existing: 0 });
  });

  it("C3 progress for a day is counted from the tasks; cancelled tasks do not count", async () => {
    const t = await createChecklistTemplate(manager, { outletId: env.outletA, name: `Prep ${uniq()}`, kind: "OPENING", items });
    await startChecklist(manager, t.id);
    const tasks = await prisma.task.findMany({ where: { runDate: today(), templateItemId: { in: t.items.map((i) => i.id) } }, orderBy: { createdAt: "asc" } });
    const worker = { ...env.kitchen, userId: `kit-${uniq()}` };
    await transitionTask(worker, tasks[0].id, "IN_PROGRESS");
    await transitionTask(worker, tasks[1].id, "IN_PROGRESS");
    await transitionTask(worker, tasks[1].id, "DONE");
    await transitionTask(manager, tasks[1].id, "VERIFIED");
    const row = (await listChecklistTemplates(prisma, manager, { outletId: env.outletA, date: today() })).find((x) => x.id === t.id)!;
    expect(row.run).toEqual({ total: 3, open: 1, inProgress: 1, done: 0, verified: 1 });
    expect((await listChecklistTemplates(prisma, manager, { outletId: env.outletA })).find((x) => x.id === t.id)!.run).toBeNull();
  });

  it("C4 rules for starting: not a day gone by, not far ahead, only someone who works here, never a retired list", async () => {
    const t = await createChecklistTemplate(manager, { outletId: env.outletA, name: `Rules ${uniq()}`, items });
    await expect(startChecklist(manager, t.id, { date: addDays(today(), -2) })).rejects.toThrow(/passed/);
    await expect(startChecklist(manager, t.id, { date: addDays(today(), 45) })).rejects.toThrow(/30 days/);
    const atB = await person("Hari", "CAPTAIN", env.outletB);
    await expect(startChecklist(manager, t.id, { assignedToId: atB.id })).rejects.toThrow(/no active role/);
    await expect(startChecklist(env.cashier, t.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(startChecklist(env.foreign, t.id)).rejects.toBeInstanceOf(NotFoundError);
    await updateChecklistTemplate(manager, t.id, { active: false });
    await expect(startChecklist(manager, t.id)).rejects.toThrow(/retired/);
    expect((await listChecklistTemplates(prisma, manager, { outletId: env.outletA })).map((x) => x.id)).not.toContain(t.id);
    expect((await listChecklistTemplates(prisma, manager, { outletId: env.outletA, includeInactive: true })).map((x) => x.id)).toContain(t.id);
    await expect(updateChecklistTemplate(manager, t.id, { items: [{ id: "foreign-item", title: "x" }] })).rejects.toThrow(/does not belong/);
  });

  it("C5 two people starting the same list at once still make each task once", async () => {
    const t = await createChecklistTemplate(manager, { outletId: env.outletA, name: `Race ${uniq()}`, items });
    const results = await Promise.allSettled([startChecklist(manager, t.id), startChecklist(manager, t.id), startChecklist(manager, t.id)]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await prisma.task.count({ where: { runDate: today(), templateItemId: { in: t.items.map((i) => i.id) } } })).toBe(3);
  });
});

describe("H. hours and overtime", () => {
  const at = (iso: string) => new Date(iso);
  const rec = (userId: string, inAt: string, outAt: string | null) => prisma.attendance.create({ data: { organizationId: env.orgId, outletId: env.outletA, userId, checkIn: at(inAt), checkOut: outAt ? at(outAt) : null } });

  it("H1 hours per person with overtime beyond the daily limit; an open record is flagged, not counted", async () => {
    const ivy = await person("Ivy");
    const jai = await person("Jai");
    // Asia/Kolkata is UTC+5:30: 03:30Z is 09:00 local.
    await rec(ivy.id, "2031-03-03T03:30:00Z", "2031-03-03T13:30:00Z"); // 10h on the 3rd: 2h overtime
    await rec(ivy.id, "2031-03-04T03:30:00Z", "2031-03-04T11:30:00Z"); // 8h
    await rec(ivy.id, "2031-03-05T03:30:00Z", null); // forgot to check out
    await rec(jai.id, "2031-03-03T03:30:00Z", "2031-03-03T07:30:00Z"); // 4h in the morning
    await rec(jai.id, "2031-03-03T10:30:00Z", "2031-03-03T16:30:00Z"); // 6h in the evening, same day: 10h that day
    const r = await staffHours(prisma, manager, { outletId: env.outletA, from: at("2031-03-01T00:00:00Z"), to: at("2031-03-31T23:59:59Z") });
    expect(r.dailyHours).toBe(8);
    const byName = Object.fromEntries(r.rows.map((x) => [x.name, x]));
    expect(byName.Ivy).toMatchObject({ days: 2, shifts: 2, hours: 18, regularHours: 16, overtimeHours: 2, openRecords: 1 });
    expect(byName.Jai).toMatchObject({ days: 1, shifts: 2, hours: 10, regularHours: 8, overtimeHours: 2, openRecords: 0 });
    const strict = await staffHours(prisma, manager, { outletId: env.outletA, from: at("2031-03-01T00:00:00Z"), to: at("2031-03-31T23:59:59Z"), dailyHours: 6 });
    expect(strict.rows.find((x) => x.name === "Ivy")!.overtimeHours).toBe(6); // 4h + 2h
    const narrow = await staffHours(prisma, manager, { outletId: env.outletA, from: at("2031-03-04T00:00:00Z"), to: at("2031-03-04T23:59:59Z") });
    expect(narrow.rows.map((x) => x.name)).toEqual(["Ivy"]);
  });

  it("H2 a night shift belongs to the day it started on; hours do not cross outlets or restaurants", async () => {
    const kim = await person("Kim");
    await rec(kim.id, "2031-04-01T16:30:00Z", "2031-04-02T00:30:00Z"); // 22:00 to 06:00 local
    const r = await staffHours(prisma, manager, { outletId: env.outletA, from: at("2031-04-01T00:00:00Z"), to: at("2031-04-30T00:00:00Z") });
    expect(r.rows.find((x) => x.name === "Kim")).toMatchObject({ days: 1, hours: 8, overtimeHours: 0 });
    await expect(staffHours(prisma, outletManagerB, { outletId: env.outletA, from: at("2031-04-01T00:00:00Z"), to: at("2031-04-30T00:00:00Z") })).rejects.toThrow();
    expect((await staffHours(prisma, env.foreign, { from: at("2031-04-01T00:00:00Z"), to: at("2031-04-30T00:00:00Z") })).rows).toEqual([]);
    await expect(staffHours(prisma, env.cashier, { outletId: env.outletA, from: at("2031-04-01T00:00:00Z"), to: at("2031-04-30T00:00:00Z") })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(staffHours(prisma, manager, { outletId: env.outletA, from: at("2031-05-01T00:00:00Z"), to: at("2031-04-01T00:00:00Z") })).rejects.toThrow(/on or before/);
  });

  it("H3 the same figures are a report with a CSV export", async () => {
    const r = await getReport(prisma, manager, "STAFF_HOURS", { outletId: env.outletA, from: "2031-03-01", to: "2031-03-31" });
    expect(r.columns.map((c) => c.header)).toEqual(["Name", "Days worked", "Shifts", "Hours", "Regular hours", "Overtime hours", "Open records (no check-out)"]);
    expect(r.rows.find((x) => x.name === "Ivy")).toMatchObject({ hours: 18, overtimeHours: 2 });
    await expect(getReport(prisma, env.cashier, "STAFF_HOURS", { outletId: env.outletA, from: "2031-03-01", to: "2031-03-31" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("S. sales per staff member", () => {
  async function sale(by: AccessContext, amount: number, pay = true) {
    const o = await createOrder(by, { outletId: env.outletA, channel: "TAKEAWAY" });
    await addOrderItem(by, o.id, { name: "Meal", qty: 1, unitPrice: amount, taxPct: 0 });
    if (pay) {
      const p = await createPayment(env.owner, o.id, { method: "UPI", amount });
      await verifyPayment(env.owner, p.id);
    }
    return o.id;
  }

  it("S1 each person's orders and sales; unpaid orders are left out; the biggest seller comes first", async () => {
    const lia = await person("Lia", "CASHIER");
    const mo = await person("Mo", "CASHIER");
    await sale(lia.ctx, 300);
    await sale(lia.ctx, 100);
    await sale(mo.ctx, 150);
    await sale(mo.ctx, 999, false); // never paid
    await settleAfterCommit();
    const from = new Date(Date.now() - 3_600_000);
    const to = new Date(Date.now() + 3_600_000);
    const rows = await salesByStaff(prisma, manager, { outletId: env.outletA, from, to });
    expect(rows.map((r) => r.name)).toEqual(["Lia", "Mo"]);
    expect(rows[0]).toMatchObject({ userId: lia.id, orders: 2, sales: 400, avgOrder: 200 });
    expect(rows[1]).toMatchObject({ userId: mo.id, orders: 1, sales: 150 });
    expect((await salesByStaff(prisma, manager, { outletId: env.outletA, from: new Date(Date.now() + 86_400_000), to: new Date(Date.now() + 2 * 86_400_000) }))).toEqual([]);
  });

  it("S2 needs reports.view; stays inside the restaurant; is a report with a CSV export", async () => {
    await expect(salesByStaff(prisma, env.cashier, { outletId: env.outletA, from: new Date(0), to: new Date() })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(salesByStaff(prisma, outletManagerB, { outletId: env.outletA, from: new Date(0), to: new Date() })).rejects.toThrow();
    expect(await salesByStaff(prisma, env.foreign, { from: new Date(0), to: new Date(Date.now() + 86_400_000) })).toEqual([]);
    const day = today();
    const r = await getReport(prisma, manager, "SALES_BY_STAFF", { outletId: env.outletA, from: day, to: day });
    expect(r.columns.map((c) => c.header)).toEqual(["Name", "Orders", "Covers", "Sales", "Average order", "Discounts given"]);
    expect(r.rows.find((x) => x.name === "Lia")).toMatchObject({ orders: 2, sales: 400 });
  });
});
