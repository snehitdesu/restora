/**
 * KDS board logic, derived from the backend's KOT lifecycle (KOT_TRANSITIONS):
 *   NEW -> ACCEPTED -> PREPARING -> READY -> SERVED   (any pre-READY state -> CANCELLED)
 * Columns group live statuses; SERVED/CANCELLED tickets leave the board.
 */
import { KOT_TRANSITIONS, canTransition, type KOTStatus } from "@/constants/enums";

export type KdsTicket = {
  id: string;
  number: number;
  status: KOTStatus;
  createdAt: string;
  orderId: string;
  station: { id: string; name: string } | null;
  order: { id: string; channel: string; source: string; covers: number; notes: string | null; createdAt: string; table: { code: string } | null } | null;
  items: Array<{ id: string; name: string; qty: string | number; status: string; notes: string | null; orderItem: { menuItemId?: string | null; notes: string | null; modifiers: Array<{ name: string }> } | null }>;
};

export const KDS_COLUMNS: Array<{ id: "new" | "progress" | "ready"; title: string; statuses: KOTStatus[] }> = [
  { id: "new", title: "New", statuses: ["NEW"] },
  { id: "progress", title: "In progress", statuses: ["ACCEPTED", "PREPARING"] },
  { id: "ready", title: "Ready", statuses: ["READY"] },
];

export function groupTickets(tickets: KdsTicket[]): Record<"new" | "progress" | "ready", KdsTicket[]> {
  const out = { new: [] as KdsTicket[], progress: [] as KdsTicket[], ready: [] as KdsTicket[] };
  for (const col of KDS_COLUMNS) {
    out[col.id] = tickets.filter((t) => col.statuses.includes(t.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
  }
  return out;
}

const FORWARD: Partial<Record<KOTStatus, { to: KOTStatus; label: string }>> = {
  NEW: { to: "ACCEPTED", label: "Accept" },
  ACCEPTED: { to: "PREPARING", label: "Start" },
  PREPARING: { to: "READY", label: "Ready" },
  READY: { to: "SERVED", label: "Served" },
};

/** The one-tap forward action for a ticket (only if the backend allows that transition). */
export function primaryAction(status: KOTStatus): { to: KOTStatus; label: string } | null {
  const a = FORWARD[status];
  return a && canTransition(KOT_TRANSITIONS, status, a.to) ? a : null;
}

export function canCancel(status: KOTStatus): boolean {
  return canTransition(KOT_TRANSITIONS, status, "CANCELLED");
}

/** Visual urgency by ticket age (minutes). */
export function urgency(createdAt: string, now: number = Date.now(), thresholds = { warn: 10, late: 20 }): "normal" | "warn" | "late" {
  const mins = (now - new Date(createdAt).getTime()) / 60000;
  return mins >= thresholds.late ? "late" : mins >= thresholds.warn ? "warn" : "normal";
}

// ---------------- measured expectations and late tickets ----------------

/** Median minutes (measured by `dishPrepTimes`) a dish usually takes, only for dishes with enough tickets behind them. */
export type PrepExpectations = { byItem: Record<string, number>; byName: Record<string, number> };
export const NO_EXPECTATIONS: PrepExpectations = { byItem: {}, byName: {} };

export function expectationsFrom(dishes: Array<{ menuItemId: string | null; name: string; medianMinutes: number; reliable: boolean }>): PrepExpectations {
  const out: PrepExpectations = { byItem: {}, byName: {} };
  for (const d of dishes) {
    if (!d.reliable) continue;
    if (d.menuItemId) out.byItem[d.menuItemId] = d.medianMinutes;
    else out.byName[d.name] = d.medianMinutes;
  }
  return out;
}

/** A ticket is expected to be ready when its slowest dish usually is. Null when no dish on it has a measured time. */
export function expectedMinutes(t: KdsTicket, ex: PrepExpectations): number | null {
  let slowest: number | null = null;
  for (const i of t.items) {
    const m = (i.orderItem?.menuItemId ? ex.byItem[i.orderItem.menuItemId] : undefined) ?? ex.byName[i.name];
    if (m !== undefined && (slowest === null || m > slowest)) slowest = m;
  }
  return slowest;
}

export type Lateness = { level: "normal" | "warn" | "late"; expected: number | null; elapsed: number };

/**
 * Warn once the ticket has waited as long as it usually takes; late at half as long again (and at least 3 minutes over),
 * so the kitchen hears about it before the guest asks. Dishes without a measured time fall back to the fixed 10 / 20
 * minute line. Tickets already READY are waiting to be served, not to be cooked: they are never "late" for the kitchen.
 */
export function ticketLateness(t: KdsTicket, now: number, ex: PrepExpectations = NO_EXPECTATIONS): Lateness {
  const elapsed = (now - new Date(t.createdAt).getTime()) / 60000;
  if (t.status === "READY") return { level: "normal", expected: null, elapsed };
  const expected = expectedMinutes(t, ex);
  if (expected === null) return { level: urgency(t.createdAt, now), expected: null, elapsed };
  const late = Math.max(expected * 1.5, expected + 3);
  return { level: elapsed >= late ? "late" : elapsed >= expected ? "warn" : "normal", expected, elapsed };
}

/** What the banner says: tickets past their late line, and tickets that have reached their usual time. */
export function lateSummary(tickets: KdsTicket[], now: number, ex: PrepExpectations = NO_EXPECTATIONS): { late: number; due: number } {
  let late = 0;
  let due = 0;
  for (const t of tickets) {
    const l = ticketLateness(t, now, ex).level;
    if (l === "late") late++;
    else if (l === "warn") due++;
  }
  return { late, due };
}

export function ticketLabel(t: KdsTicket): string {
  if (!t.order) return "Order";
  if (t.order.channel === "DINE_IN") return t.order.table ? `Table ${t.order.table.code}` : "Dine-in";
  // A guest's QR order is a dine-in order placed from the table's QR code.
  if (t.order.channel === "QR") return t.order.table ? `Table ${t.order.table.code} · QR` : "QR order";
  return t.order.channel.replace("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}
