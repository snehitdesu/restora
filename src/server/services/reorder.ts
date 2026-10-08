/**
 * Reorder engine (proposal module 02, p.5; docs/master-feature-audit.md PP-01..03):
 * the screen the store-keeper opens every morning.
 *
 * Recommendations are computed live from the inventory ledger for one outlet at
 * one `asOf` instant; nothing is stored. Per material (base units, Decimal):
 *
 *   OH        on hand = Σ ledger qty of every department of the outlet
 *   Incoming  open PO qty (DRAFT..PARTIAL, not yet received) + open indent qty
 *             (DRAFT..APPROVED) + DRAFT GRNs raised without a PO
 *   P         stock position = max(OH, 0) + Incoming
 *   U         usage in the window = −Σ net qty of USAGE_TYPES, floored at 0
 *   ADU       U / observed days (days since the first ledger row, capped by the window)
 *   ROP       max(reorderLevel, minStock), raised to minStock + ADU × lead time
 *             when the history is long enough
 *   Target    max(parLevel ?? reorderLevel, ROP)
 *   eligible  active, configured (ROP_static > 0 or parLevel > 0) and P < ROP
 *   order     Target − P, rounded UP to whole purchase packs (or to 4 dp)
 *
 * Vendors: only ACTIVE vendors are ever suggested or accepted (the Group 1
 * approval gate, enforced again by createPurchaseOrderInTx). Raising creates
 * DRAFT documents only, in one transaction, keyed by a mandatory
 * Idempotency-Key, after re-checking that nothing was ordered meanwhile.
 */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, ConflictError, ValidationError } from "@/server/db/scope";
import { assertOutletInOrg } from "@/server/db/outletGuard";
import { assertCan } from "@/server/auth/rbac";
import { idempotencyKeySchema, requestHashOf } from "@/server/services/idempotency";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { resolveUnit } from "@/server/services/inventory";
import { createIndentInTx, createPurchaseOrderInTx, ensureVendor, parseIndentInput, parsePurchaseOrderInput } from "@/server/services/procurement";
import { D, money, num } from "@/domain/money";

type Dec = Prisma.Decimal;
const DAY = 86_400_000;

/** Fixed engine parameters (approved design D3). */
export const REORDER = {
  DEFAULT_WINDOW_DAYS: 14,
  MIN_WINDOW_DAYS: 7,
  MAX_WINDOW_DAYS: 90,
  /** Fewer observed days than this: usage is shown but never raises the reorder point. */
  MIN_HISTORY_DAYS: 7,
  /**
   * Lead time is whole days, at least 1. A vendor link with no lead time, or
   * 0 ("same day"), counts as 1 day: an order placed today is not in the
   * store before the next service, and a 0 would make "runs out before
   * delivery" undefined.
   */
  MIN_LEAD_TIME_DAYS: 1,
  /** HIGH priority: days of cover at most this many lead times. */
  HIGH_COVER_LEAD_TIMES: 2,
} as const;

/** Ledger movements that are demand on this outlet's stock. Issues move stock between its own departments (OUT + IN) and are not usage. */
export const USAGE_TYPES = ["SALE_CONSUMPTION", "PRODUCTION_CONSUMPTION", "WASTAGE", "SPOILAGE", "STAFF_MEAL", "TRANSFER_OUT"] as const;
export const OPEN_PO_STATES = ["DRAFT", "SUBMITTED", "APPROVED", "ORDERED", "PARTIAL"] as const;
export const OPEN_INDENT_STATES = ["DRAFT", "SUBMITTED", "APPROVED"] as const;
export const REORDER_SOURCE = "REORDER";

export type Priority = "CRITICAL" | "HIGH" | "NORMAL";
export type HistoryStatus = "OK" | "INSUFFICIENT" | "NONE";
export type ReasonCode =
  | "OUT_OF_STOCK" | "NEGATIVE_STOCK" | "BELOW_SAFETY_STOCK" | "BELOW_REORDER_POINT" | "STOCKOUT_BEFORE_DELIVERY"
  | "USAGE_RAISED_REORDER_POINT" | "NO_HISTORY" | "INSUFFICIENT_HISTORY" | "PARTLY_ON_ORDER" | "INCLUDES_DRAFTS"
  | "NO_PACK_CONVERSION" | "NO_COST" | "NO_VENDOR" | "PREFERRED_VENDOR_BLOCKED";

/** 400: the request itself is malformed (bad query / body shape, missing Idempotency-Key). */
export class BadRequestError extends Error {
  status = 400;
  details?: unknown;
  constructor(message = "Bad request", details?: unknown) {
    super(message);
    this.name = "BadRequestError";
    this.details = details;
  }
}

// ============================================================
// Pure calculation
// ============================================================

export type PlanInput = {
  onHand: Dec;
  incoming: Dec;
  /** Net usage in the window, already floored at 0. */
  usage: Dec;
  observedDays: number;
  minStock: Dec;
  reorderLevel: Dec;
  parLevel: Dec | null;
  /** Effective lead time (>= MIN_LEAD_TIME_DAYS). */
  leadTimeDays: number;
  /** Purchase pack: base units per pack; "missing" when a purchase unit has no conversion. */
  pack: { factor: Dec } | "missing" | null;
  /** Unit cost for the estimate (average cost, else last cost); null when unknown. */
  unitCost: Dec | null;
};

export type Plan = {
  configured: boolean;
  eligible: boolean;
  onHandClamped: Dec;
  position: Dec;
  avgDailyUse: Dec;
  history: HistoryStatus;
  reorderPoint: Dec;
  target: Dec;
  daysOfCover: Dec | null;
  rawQty: Dec;
  /** Order quantity in the order unit (whole packs, or base units). */
  orderQty: Dec;
  /** The same order in base units (packs × factor). */
  orderBaseQty: Dec;
  packFactor: Dec | null;
  estimatedValue: Dec | null;
  priority: Priority;
  reasons: ReasonCode[];
};

/** One material's recommendation from its inputs. No I/O: every rule of the engine is here. */
export function planLine(i: PlanInput): Plan {
  const zero = D(0);
  const onHandClamped = i.onHand.gt(0) ? i.onHand : zero;
  const position = onHandClamped.plus(i.incoming);
  const days = Math.max(1, i.observedDays);
  const avgDailyUse = i.usage.gt(0) ? i.usage.div(days) : zero;
  const history: HistoryStatus = i.usage.lte(0) ? "NONE" : days < REORDER.MIN_HISTORY_DAYS ? "INSUFFICIENT" : "OK";
  const lead = Math.max(REORDER.MIN_LEAD_TIME_DAYS, Math.floor(i.leadTimeDays));

  const ropStatic = Prisma.Decimal.max(i.reorderLevel, i.minStock);
  const ropUsage = i.minStock.plus(avgDailyUse.times(lead));
  const usageRaises = history === "OK" && ropUsage.gt(ropStatic);
  const reorderPoint = usageRaises ? ropUsage : ropStatic;
  const par = i.parLevel ?? i.reorderLevel;
  const target = Prisma.Decimal.max(par, reorderPoint);
  const configured = ropStatic.gt(0) || (i.parLevel?.gt(0) ?? false);
  const eligible = configured && position.lt(reorderPoint);

  const rawQty = eligible ? target.minus(position) : zero;
  let orderQty = zero, orderBaseQty = zero, packFactor: Dec | null = null;
  if (eligible) {
    if (i.pack && i.pack !== "missing") {
      packFactor = i.pack.factor;
      orderQty = rawQty.div(packFactor).toDecimalPlaces(0, Prisma.Decimal.ROUND_UP);
      orderBaseQty = orderQty.times(packFactor);
    } else {
      orderQty = rawQty.toDecimalPlaces(4, Prisma.Decimal.ROUND_UP);
      orderBaseQty = orderQty;
    }
  }
  const estimatedValue = eligible && i.unitCost ? money(orderBaseQty.times(i.unitCost)) : null;
  const daysOfCover = avgDailyUse.gt(0) ? onHandClamped.div(avgDailyUse) : null;

  const reasons: ReasonCode[] = [];
  if (i.onHand.lte(0)) reasons.push("OUT_OF_STOCK");
  if (i.onHand.lt(0)) reasons.push("NEGATIVE_STOCK");
  const belowSafety = i.minStock.gt(0) && onHandClamped.lt(i.minStock);
  if (belowSafety) reasons.push("BELOW_SAFETY_STOCK");
  if (eligible) reasons.push("BELOW_REORDER_POINT");
  const stockoutFirst = daysOfCover !== null && daysOfCover.lt(lead);
  if (stockoutFirst) reasons.push("STOCKOUT_BEFORE_DELIVERY");
  if (usageRaises) reasons.push("USAGE_RAISED_REORDER_POINT");
  if (history === "NONE") reasons.push("NO_HISTORY");
  if (history === "INSUFFICIENT") reasons.push("INSUFFICIENT_HISTORY");
  if (i.incoming.gt(0)) reasons.push("PARTLY_ON_ORDER");
  if (eligible && i.pack === "missing") reasons.push("NO_PACK_CONVERSION");
  if (eligible && !i.unitCost) reasons.push("NO_COST");

  const priority: Priority =
    i.onHand.lte(0) || belowSafety || stockoutFirst ? "CRITICAL"
      : daysOfCover !== null && daysOfCover.lte(lead * REORDER.HIGH_COVER_LEAD_TIMES) ? "HIGH"
        : "NORMAL";

  return { configured, eligible, onHandClamped, position, avgDailyUse, history, reorderPoint, target, daysOfCover, rawQty, orderQty, orderBaseQty, packFactor, estimatedValue, priority, reasons };
}

const PRIORITY_RANK: Record<Priority, number> = { CRITICAL: 0, HIGH: 1, NORMAL: 2 };

/** Priority, then least days of cover (no usage last), then name. */
export function compareRows(a: { priority: Priority; daysOfCover: number | null; name: string }, b: { priority: Priority; daysOfCover: number | null; name: string }) {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || (a.daysOfCover ?? Number.POSITIVE_INFINITY) - (b.daysOfCover ?? Number.POSITIVE_INFINITY)
    || a.name.localeCompare(b.name);
}

// ============================================================
// Vendor selection (pure)
// ============================================================

export type VendorCandidate = { vendorId: string; name: string; status: string; lastRate: Dec | null; leadTimeDays: number | null; linkPreferred: boolean; linked: boolean };
export type VendorChoice = {
  selected: VendorCandidate | null;
  selectedBecause: "PREFERRED_VENDOR" | "PREFERRED_LINK" | "LOWEST_RATE" | "ONLY_ELIGIBLE" | "SHORTEST_LEAD_TIME" | "BY_NAME" | null;
  eligible: VendorCandidate[];
  blockedNote: string | null;
};

const blockedText = (v: { name: string; status: string }) => (v.status === "PENDING" ? `${v.name} is awaiting approval` : `${v.name} is ${v.status.toLowerCase()}`);

/**
 * Only ACTIVE vendors are candidates. Ranking: the material's preferred vendor,
 * a link marked preferred, the lowest known rate (unknown rates last), the
 * shortest lead time, then name. A preferred vendor that is PENDING, INACTIVE
 * or BLACKLISTED is never used; the note says why.
 */
export function chooseVendor(preferredVendorId: string | null, candidates: VendorCandidate[]): VendorChoice {
  const eligible = candidates.filter((c) => c.status === "ACTIVE");
  const rateKey = (c: VendorCandidate) => (c.lastRate && c.lastRate.gt(0) ? c.lastRate : null);
  eligible.sort((a, b) => {
    const pa = a.vendorId === preferredVendorId ? 0 : 1, pb = b.vendorId === preferredVendorId ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (a.linkPreferred !== b.linkPreferred) return a.linkPreferred ? -1 : 1;
    const ra = rateKey(a), rb = rateKey(b);
    if (ra && rb && !ra.eq(rb)) return ra.lt(rb) ? -1 : 1;
    if (ra && !rb) return -1;
    if (!ra && rb) return 1;
    const la = a.leadTimeDays ?? Number.POSITIVE_INFINITY, lb = b.leadTimeDays ?? Number.POSITIVE_INFINITY;
    if (la !== lb) return la - lb;
    return a.name.localeCompare(b.name);
  });
  const selected = eligible[0] ?? null;
  const preferredBlocked = candidates.find((c) => c.status !== "ACTIVE" && (c.vendorId === preferredVendorId || c.linkPreferred));
  let selectedBecause: VendorChoice["selectedBecause"] = null;
  if (selected) {
    const next = eligible[1];
    if (selected.vendorId === preferredVendorId) selectedBecause = "PREFERRED_VENDOR";
    else if (selected.linkPreferred) selectedBecause = "PREFERRED_LINK";
    else if (!next) selectedBecause = "ONLY_ELIGIBLE";
    else if (rateKey(selected) && (!rateKey(next) || rateKey(selected)!.lt(rateKey(next)!))) selectedBecause = "LOWEST_RATE";
    else if ((selected.leadTimeDays ?? Infinity) < (next.leadTimeDays ?? Infinity)) selectedBecause = "SHORTEST_LEAD_TIME";
    else selectedBecause = "BY_NAME";
  }
  return { selected, selectedBecause, eligible, blockedNote: preferredBlocked ? blockedText(preferredBlocked) : null };
}

// ============================================================
// Request parsing (asOf / window)
// ============================================================

/**
 * One instant for a whole calculation. Omitted: the server's clock. Malformed
 * or in the future: 400 (a recommendation "as of tomorrow" would count stock
 * nobody has).
 */
export function parseAsOf(raw: unknown, now: Date = new Date()): Date {
  if (raw === undefined || raw === null || raw === "") return now;
  if (typeof raw !== "string" && !(raw instanceof Date)) throw new BadRequestError("asOf must be an ISO date-time");
  const d = raw instanceof Date ? raw : /^\d{4}-\d{2}-\d{2}/.test(raw) ? new Date(raw) : new Date(NaN);
  if (Number.isNaN(d.getTime())) throw new BadRequestError("asOf is not a valid date-time");
  if (d.getTime() > now.getTime()) throw new BadRequestError("asOf cannot be in the future");
  return d;
}

function parseWindow(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return REORDER.DEFAULT_WINDOW_DAYS;
  const n = typeof raw === "number" ? raw : /^\d+$/.test(String(raw)) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < REORDER.MIN_WINDOW_DAYS || n > REORDER.MAX_WINDOW_DAYS) {
    throw new BadRequestError(`lookbackDays must be a whole number from ${REORDER.MIN_WINDOW_DAYS} to ${REORDER.MAX_WINDOW_DAYS}`);
  }
  return n;
}

function parseOutletId(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new BadRequestError("outletId is required");
  return raw;
}

// ============================================================
// Loading (one asOf, batched reads)
// ============================================================

type IncomingDoc = { type: "PO" | "INDENT" | "GRN"; id: string; number: string; status: string; qty: number; draft: boolean };

/** Unit factors to base, from the organization's conversions (material-specific first, then generic; same rule as inventory.resolveUnit). */
async function loadConverter(db: Client, org: string, materials: Map<string, { baseUnitId: string }>) {
  const convs = await db.unitConversion.findMany({ where: { organizationId: org }, select: { fromUnitId: true, toUnitId: true, factor: true, materialId: true } });
  return (materialId: string, unitId: string | null | undefined): Dec | null => {
    const m = materials.get(materialId);
    if (!m) return null;
    if (!unitId || unitId === m.baseUnitId) return D(1);
    const c = convs.find((x) => x.fromUnitId === unitId && x.toUnitId === m.baseUnitId && x.materialId === materialId)
      ?? convs.find((x) => x.fromUnitId === unitId && x.toUnitId === m.baseUnitId && x.materialId === null);
    return c && D(c.factor).gt(0) ? D(c.factor) : null;
  };
}

/**
 * Stock already on its way, per material, in base units, with the documents:
 * open PO lines (ordered − received, in the line unit), open indent lines, and
 * DRAFT GRNs raised without a PO (a draft GRN against a PO is already inside
 * that PO's open quantity). Documents created after `asOf` are not counted.
 */
async function loadIncoming(db: Client, org: string, outletId: string, materialIds: string[], asOf: Date, factorOf: (materialId: string, unitId: string | null) => Dec | null) {
  const [poLines, indentLines, grnLines] = await Promise.all([
    db.purchaseOrderLine.findMany({
      where: { organizationId: org, materialId: { in: materialIds }, po: { outletId, status: { in: [...OPEN_PO_STATES] }, createdAt: { lte: asOf } } },
      select: { materialId: true, qty: true, receivedQty: true, unitId: true, po: { select: { id: true, number: true, status: true } } },
    }),
    db.purchaseIndentLine.findMany({
      where: { organizationId: org, materialId: { in: materialIds }, indent: { outletId, status: { in: [...OPEN_INDENT_STATES] }, createdAt: { lte: asOf } } },
      select: { materialId: true, qty: true, unitId: true, indent: { select: { id: true, number: true, status: true } } },
    }),
    db.goodsReceiptLine.findMany({
      where: { organizationId: org, materialId: { in: materialIds }, grn: { outletId, status: "DRAFT", poId: null, createdAt: { lte: asOf } } },
      select: { materialId: true, qty: true, damagedQty: true, unitId: true, grn: { select: { id: true, number: true, status: true } } },
    }),
  ]);
  const total = new Map<string, Dec>();
  /** The part of `total` that only DRAFT documents account for. */
  const draftTotal = new Map<string, Dec>();
  const docs = new Map<string, IncomingDoc[]>();
  const add = (materialId: string, qtyInUnit: Dec, unitId: string | null, doc: Omit<IncomingDoc, "qty" | "draft">) => {
    if (qtyInUnit.lte(0)) return;
    const f = factorOf(materialId, unitId);
    if (!f) throw new ValidationError(`${doc.type} ${doc.number} has a line whose unit no longer converts to the material's base unit; fix the unit conversion`);
    const base = qtyInUnit.times(f);
    total.set(materialId, (total.get(materialId) ?? D(0)).plus(base));
    if (doc.status === "DRAFT") draftTotal.set(materialId, (draftTotal.get(materialId) ?? D(0)).plus(base));
    const list = docs.get(materialId) ?? [];
    const same = list.find((d) => d.type === doc.type && d.id === doc.id);
    if (same) same.qty = num(D(same.qty).plus(base));
    else list.push({ ...doc, qty: num(base), draft: doc.status === "DRAFT" });
    docs.set(materialId, list);
  };
  for (const l of poLines) add(l.materialId, D(l.qty).minus(D(l.receivedQty)), l.unitId, { type: "PO", ...l.po });
  for (const l of indentLines) add(l.materialId, D(l.qty), l.unitId, { type: "INDENT", ...l.indent });
  for (const l of grnLines) add(l.materialId, D(l.qty).minus(D(l.damagedQty)), l.unitId, { type: "GRN", ...l.grn });
  return { total, draftTotal, docs };
}

export type ReorderRow = {
  materialId: string; sku: string; name: string; category: string | null;
  baseUnitId: string; baseUnit: string;
  priority: Priority; reasons: ReasonCode[];
  onHand: number; onHandClamped: number;
  incoming: number; incomingDocs: IncomingDoc[]; includesDrafts: boolean;
  position: number; safetyStock: number; reorderLevel: number; parLevel: number | null; reorderPoint: number; target: number;
  usedInWindow: number; observedDays: number; avgDailyUse: number; daysOfCover: number | null; stockoutDate: string | null;
  historyStatus: HistoryStatus; leadTimeDays: number;
  suggestedBaseQty: number;
  order: { unitId: string; unitCode: string; qty: number; packFactor: number | null };
  vendor: { id: string; name: string; rate: number | null; leadTimeDays: number | null; selectedBecause: VendorChoice["selectedBecause"] } | null;
  blockedVendorNote: string | null;
  alternatives: Array<{ vendorId: string; name: string; rate: number | null; leadTimeDays: number | null; estimatedValue: number | null }>;
  unitCost: number | null; costSource: "AVG_COST" | "LAST_COST" | null; estimatedValue: number | null;
  /** Default PO rate per ORDER unit (vendor rate per base unit × pack factor; else cost). */
  poRate: number | null;
  departments: Array<{ departmentId: string | null; name: string; onHand: number }>;
};

export type SetupRow = { materialId: string; sku: string; name: string; reason: "NO_REORDER_SETTINGS" | "NO_ELIGIBLE_VENDOR"; usedInWindow: number; onHand: number; blockedVendorNote: string | null };

type Evaluated = { row: ReorderRow; plan: Plan; configured: boolean; usage: Dec; onHand: Dec; draftIncoming: Dec; hasEligibleVendor: boolean; active: boolean };

/**
 * A configured material that is NOT listed only because DRAFT documents count
 * as incoming. Shown separately so an abandoned draft never hides real demand.
 */
export type DraftCoveredRow = { materialId: string; sku: string; name: string; baseUnit: string; onHand: number; reorderPoint: number; incoming: number; draftIncoming: number; drafts: IncomingDoc[] };

/** Every material of the organization evaluated at one outlet and instant (optionally only some). */
async function evaluate(db: Client, ctx: AccessContext, outletId: string, asOf: Date, windowDays: number, onlyMaterialIds?: string[]): Promise<Evaluated[]> {
  const org = ctx.organizationId;
  const since = new Date(asOf.getTime() - windowDays * DAY);
  const materials = await db.material.findMany({
    where: { organizationId: org, ...(onlyMaterialIds ? { id: { in: onlyMaterialIds } } : { active: true }) },
    select: {
      id: true, sku: true, name: true, active: true, minStock: true, reorderLevel: true, parLevel: true, preferredVendorId: true, baseUnitId: true, purchaseUnitId: true,
      baseUnit: { select: { code: true } }, category: { select: { name: true } },
    },
  });
  if (!materials.length) return [];
  const ids = materials.map((m) => m.id);
  const byId = new Map(materials.map((m) => [m.id, m]));
  const factorOf = await loadConverter(db, org, byId);

  const [stock, usage, firstSeen, costs, links, incoming, units] = await Promise.all([
    db.inventoryLedger.groupBy({ by: ["materialId", "departmentId"], where: { organizationId: org, outletId, materialId: { in: ids }, createdAt: { lte: asOf } }, _sum: { qty: true } }),
    db.inventoryLedger.groupBy({ by: ["materialId"], where: { organizationId: org, outletId, materialId: { in: ids }, txnType: { in: [...USAGE_TYPES] }, createdAt: { gt: since, lte: asOf } }, _sum: { qty: true } }),
    db.inventoryLedger.groupBy({ by: ["materialId"], where: { organizationId: org, outletId, materialId: { in: ids }, createdAt: { lte: asOf } }, _min: { createdAt: true } }),
    db.outletMaterialCost.findMany({ where: { organizationId: org, outletId, materialId: { in: ids } }, select: { materialId: true, avgCost: true, lastCost: true } }),
    db.vendorMaterial.findMany({ where: { organizationId: org, materialId: { in: ids } }, select: { materialId: true, vendorId: true, lastRate: true, leadTimeDays: true, preferred: true } }),
    loadIncoming(db, org, outletId, ids, asOf, factorOf),
    db.unit.findMany({ where: { organizationId: org }, select: { id: true, code: true } }),
  ]);
  const vendorIds = [...new Set([...materials.map((m) => m.preferredVendorId), ...links.map((l) => l.vendorId)].filter((x): x is string => Boolean(x)))];
  const deptIds = [...new Set(stock.map((s) => s.departmentId).filter((x): x is string => Boolean(x)))];
  const [vendors, depts] = await Promise.all([
    vendorIds.length ? db.vendor.findMany({ where: { organizationId: org, id: { in: vendorIds } }, select: { id: true, name: true, status: true } }) : [],
    deptIds.length ? db.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } }) : [],
  ]);
  const vendorById = new Map(vendors.map((v) => [v.id, v]));
  const deptName = new Map(depts.map((d) => [d.id, d.name]));
  const unitCode = new Map(units.map((u) => [u.id, u.code]));
  const usageMap = new Map(usage.map((u) => [u.materialId, D(u._sum.qty ?? 0).neg()]));
  const firstMap = new Map(firstSeen.map((f) => [f.materialId, f._min.createdAt]));
  const costMap = new Map(costs.map((c) => [c.materialId, c]));
  const stockByMat = new Map<string, Array<{ departmentId: string | null; qty: Dec }>>();
  for (const s of stock) (stockByMat.get(s.materialId) ?? stockByMat.set(s.materialId, []).get(s.materialId)!).push({ departmentId: s.departmentId, qty: D(s._sum.qty ?? 0) });

  const out: Evaluated[] = [];
  for (const m of materials) {
    const parts = stockByMat.get(m.id) ?? [];
    const onHand = parts.reduce((s, p) => s.plus(p.qty), D(0));
    const used = Prisma.Decimal.max(usageMap.get(m.id) ?? D(0), 0);
    const first = firstMap.get(m.id);
    const observedDays = first ? Math.min(windowDays, Math.max(1, Math.ceil((asOf.getTime() - first.getTime()) / DAY))) : 1;

    const candidates: VendorCandidate[] = [];
    const seen = new Set<string>();
    for (const l of links.filter((x) => x.materialId === m.id)) {
      const v = vendorById.get(l.vendorId);
      if (!v || seen.has(v.id)) continue;
      seen.add(v.id);
      candidates.push({ vendorId: v.id, name: v.name, status: v.status, lastRate: D(l.lastRate), leadTimeDays: l.leadTimeDays, linkPreferred: l.preferred, linked: true });
    }
    if (m.preferredVendorId && !seen.has(m.preferredVendorId)) {
      const v = vendorById.get(m.preferredVendorId);
      if (v) candidates.push({ vendorId: v.id, name: v.name, status: v.status, lastRate: null, leadTimeDays: null, linkPreferred: false, linked: false });
    }
    const choice = chooseVendor(m.preferredVendorId, candidates);
    const lead = Math.max(REORDER.MIN_LEAD_TIME_DAYS, choice.selected?.leadTimeDays ?? REORDER.MIN_LEAD_TIME_DAYS);

    const hasPack = Boolean(m.purchaseUnitId && m.purchaseUnitId !== m.baseUnitId);
    const packFactor = hasPack ? factorOf(m.id, m.purchaseUnitId) : null;
    const cost = costMap.get(m.id);
    const unitCost = cost && D(cost.avgCost).gt(0) ? D(cost.avgCost) : cost && D(cost.lastCost).gt(0) ? D(cost.lastCost) : null;
    const costSource = cost && D(cost.avgCost).gt(0) ? "AVG_COST" as const : unitCost ? "LAST_COST" as const : null;

    const inc = incoming.total.get(m.id) ?? D(0);
    const plan = planLine({
      onHand, incoming: inc, usage: used, observedDays,
      minStock: D(m.minStock), reorderLevel: D(m.reorderLevel), parLevel: m.parLevel === null ? null : D(m.parLevel),
      leadTimeDays: lead, pack: hasPack ? (packFactor ? { factor: packFactor } : "missing") : null, unitCost,
    });
    const docs = incoming.docs.get(m.id) ?? [];
    const includesDrafts = docs.some((d) => d.draft);
    const reasons = [...plan.reasons];
    if (includesDrafts) reasons.push("INCLUDES_DRAFTS");
    if (!choice.selected) reasons.push("NO_VENDOR");
    if (choice.blockedNote) reasons.push("PREFERRED_VENDOR_BLOCKED");

    const orderUnitId = plan.packFactor ? m.purchaseUnitId! : m.baseUnitId;
    const vendorRate = choice.selected?.lastRate?.gt(0) ? choice.selected.lastRate : null;
    const baseRate = vendorRate ?? unitCost;
    const poRate = baseRate ? baseRate.times(plan.packFactor ?? 1).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP) : null;
    const cover = plan.daysOfCover;

    const row: ReorderRow = {
      materialId: m.id, sku: m.sku, name: m.name, category: m.category?.name ?? null, baseUnitId: m.baseUnitId, baseUnit: m.baseUnit.code,
      priority: plan.priority, reasons,
      onHand: num(onHand.toDecimalPlaces(4)), onHandClamped: num(plan.onHandClamped.toDecimalPlaces(4)),
      incoming: num(inc.toDecimalPlaces(4)), incomingDocs: docs, includesDrafts,
      position: num(plan.position.toDecimalPlaces(4)), safetyStock: num(D(m.minStock)), reorderLevel: num(D(m.reorderLevel)), parLevel: m.parLevel === null ? null : num(D(m.parLevel)),
      reorderPoint: num(plan.reorderPoint.toDecimalPlaces(4, Prisma.Decimal.ROUND_UP)), target: num(plan.target.toDecimalPlaces(4, Prisma.Decimal.ROUND_UP)),
      usedInWindow: num(used.toDecimalPlaces(4)), observedDays, avgDailyUse: num(plan.avgDailyUse.toDecimalPlaces(4)),
      daysOfCover: cover ? num(cover.toDecimalPlaces(1, Prisma.Decimal.ROUND_DOWN)) : null,
      stockoutDate: cover ? new Date(asOf.getTime() + Math.floor(num(cover) * DAY)).toISOString() : null,
      historyStatus: plan.history, leadTimeDays: lead,
      suggestedBaseQty: num(plan.orderBaseQty),
      order: { unitId: orderUnitId, unitCode: unitCode.get(orderUnitId) ?? m.baseUnit.code, qty: num(plan.orderQty), packFactor: plan.packFactor ? num(plan.packFactor) : null },
      vendor: choice.selected ? { id: choice.selected.vendorId, name: choice.selected.name, rate: vendorRate ? num(vendorRate) : null, leadTimeDays: choice.selected.leadTimeDays, selectedBecause: choice.selectedBecause } : null,
      blockedVendorNote: choice.blockedNote,
      alternatives: choice.eligible.map((c) => ({
        vendorId: c.vendorId, name: c.name, rate: c.lastRate?.gt(0) ? num(c.lastRate) : null, leadTimeDays: c.leadTimeDays,
        estimatedValue: c.lastRate?.gt(0) && plan.eligible ? num(money(plan.orderBaseQty.times(c.lastRate))) : null,
      })),
      unitCost: unitCost ? num(unitCost.toDecimalPlaces(4)) : null, costSource, estimatedValue: plan.estimatedValue ? num(plan.estimatedValue) : null,
      poRate: poRate ? num(poRate) : null,
      departments: parts.filter((p) => !p.qty.isZero()).map((p) => ({ departmentId: p.departmentId, name: p.departmentId ? deptName.get(p.departmentId) ?? "Department" : "Outlet store", onHand: num(p.qty.toDecimalPlaces(4)) })),
    };
    out.push({ row, plan, configured: plan.configured, usage: used, onHand, draftIncoming: incoming.draftTotal.get(m.id) ?? D(0), hasEligibleVendor: Boolean(choice.selected), active: m.active });
  }
  return out;
}

// ============================================================
// Recommendations (GET)
// ============================================================

export async function computeReorder(db: Client, ctx: AccessContext, query: Record<string, unknown>, now: Date = new Date()) {
  const outletId = parseOutletId(query.outletId);
  const asOf = parseAsOf(query.asOf, now);
  const lookbackDays = parseWindow(query.lookbackDays);
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "purchase.view", outletId);
  // A foreign organization's outlet id is "not found" (never confirmed to exist).
  await assertOutletInOrg(db, ctx, outletId);

  const all = await evaluate(db, ctx, outletId, asOf, lookbackDays);
  const rows = all.filter((e) => e.plan.eligible).map((e) => e.row).sort(compareRows);
  const needsSetup: SetupRow[] = [];
  for (const e of all) {
    if (!e.configured && e.usage.gt(0)) needsSetup.push({ materialId: e.row.materialId, sku: e.row.sku, name: e.row.name, reason: "NO_REORDER_SETTINGS", usedInWindow: e.row.usedInWindow, onHand: e.row.onHand, blockedVendorNote: null });
    else if (e.configured && !e.hasEligibleVendor) needsSetup.push({ materialId: e.row.materialId, sku: e.row.sku, name: e.row.name, reason: "NO_ELIGIBLE_VENDOR", usedInWindow: e.row.usedInWindow, onHand: e.row.onHand, blockedVendorNote: e.row.blockedVendorNote });
  }
  needsSetup.sort((a, b) => a.reason.localeCompare(b.reason) || b.usedInWindow - a.usedInWindow || a.name.localeCompare(b.name));
  const coveredByDrafts: DraftCoveredRow[] = all
    .filter((e) => e.configured && !e.plan.eligible && e.draftIncoming.gt(0) && e.plan.position.minus(e.draftIncoming).lt(e.plan.reorderPoint))
    .map((e) => ({
      materialId: e.row.materialId, sku: e.row.sku, name: e.row.name, baseUnit: e.row.baseUnit, onHand: e.row.onHand, reorderPoint: e.row.reorderPoint,
      incoming: e.row.incoming, draftIncoming: num(e.draftIncoming.toDecimalPlaces(4)), drafts: e.row.incomingDocs.filter((d) => d.draft),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const groups = new Map<string, { vendorId: string | null; vendorName: string | null; lines: number; spend: Dec }>();
  let budget = D(0);
  for (const r of rows) {
    const k = r.vendor?.id ?? "";
    const g = groups.get(k) ?? { vendorId: r.vendor?.id ?? null, vendorName: r.vendor?.name ?? null, lines: 0, spend: D(0) };
    g.lines++;
    if (r.estimatedValue !== null) { g.spend = g.spend.plus(r.estimatedValue); budget = budget.plus(r.estimatedValue); }
    groups.set(k, g);
  }
  return {
    outletId, asOf: asOf.toISOString(), lookbackDays,
    rows,
    needsSetup,
    coveredByDrafts,
    summary: {
      items: rows.length,
      critical: rows.filter((r) => r.priority === "CRITICAL").length,
      high: rows.filter((r) => r.priority === "HIGH").length,
      normal: rows.filter((r) => r.priority === "NORMAL").length,
      budget: num(money(budget)),
      noVendor: rows.filter((r) => !r.vendor).length,
      includesDrafts: rows.filter((r) => r.includesDrafts).length,
      coveredByDrafts: coveredByDrafts.length,
      byVendor: [...groups.values()]
        .sort((a, b) => (a.vendorId ? 0 : 1) - (b.vendorId ? 0 : 1) || (a.vendorName ?? "").localeCompare(b.vendorName ?? ""))
        .map((g) => ({ vendorId: g.vendorId, vendorName: g.vendorName, lines: g.lines, spend: num(money(g.spend)) })),
    },
  };
}

// ============================================================
// Raising documents (POST)
// ============================================================

const qtyField = z.number().positive().max(1_000_000_000).refine((v) => Math.abs(Math.round(v * 10_000) - v * 10_000) < 1e-6, "Quantities can have at most 4 decimal places");
const lineBase = { materialId: z.string().min(1), qty: qtyField, unitId: z.string().min(1).nullish(), expectedIncoming: z.number().nonnegative() };
const raisePoSchema = z.object({
  outletId: z.string().min(1),
  asOf: z.string().min(1),
  lookbackDays: z.number().int().optional(),
  expectedDate: z.coerce.date().optional(),
  notes: z.string().max(1000).optional(),
  lines: z.array(z.object({ ...lineBase, vendorId: z.string().min(1), rate: z.number().positive().max(100_000_000).optional() })).min(1).max(200),
});
const raiseIndentSchema = z.object({
  outletId: z.string().min(1),
  asOf: z.string().min(1),
  lookbackDays: z.number().int().optional(),
  departmentId: z.string().min(1).optional(),
  notes: z.string().max(1000).optional(),
  lines: z.array(z.object(lineBase)).min(1).max(200),
});

function parseBody<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new BadRequestError("Invalid reorder request", r.error.flatten());
  return r.data;
}

function requireKey(key: string | undefined): string {
  if (!key) throw new BadRequestError("An Idempotency-Key header is required to raise documents from the reorder screen");
  const r = idempotencyKeySchema.safeParse(key);
  if (!r.success) throw new BadRequestError("Invalid Idempotency-Key");
  return r.data;
}

function assertUniqueMaterials(lines: Array<{ materialId: string }>) {
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.materialId)) throw new BadRequestError("A material appears twice; merge the lines");
    seen.add(l.materialId);
  }
}

/** Tolerance for comparing the client's view of incoming stock (4 dp quantities, JSON numbers). */
const INCOMING_EPSILON = D("0.0001");

/**
 * Inside the write transaction: re-evaluate the requested materials now. If
 * more stock is on its way than the screen showed, someone ordered meanwhile:
 * 409, nothing is created. Under SERIALIZABLE isolation two concurrent raises
 * cannot both pass this check (the loser is retried and then sees the winner).
 */
async function recheck(tx: Tx, ctx: AccessContext, outletId: string, lookbackDays: number, lines: Array<{ materialId: string; expectedIncoming: number }>) {
  const now = new Date();
  const evals = await evaluate(tx, ctx, outletId, now, lookbackDays, lines.map((l) => l.materialId));
  const byId = new Map(evals.map((e) => [e.row.materialId, e]));
  const changed: Array<{ materialId: string; name: string; expectedIncoming: number; incoming: number; documents: string[] }> = [];
  for (const l of lines) {
    const e = byId.get(l.materialId);
    if (!e) throw new ValidationError(`Material ${l.materialId} not found`);
    if (!e.active) throw new ValidationError(`${e.row.name} is inactive and cannot be ordered`);
    if (D(e.row.incoming).gt(D(l.expectedIncoming).plus(INCOMING_EPSILON))) {
      changed.push({ materialId: l.materialId, name: e.row.name, expectedIncoming: l.expectedIncoming, incoming: e.row.incoming, documents: e.row.incomingDocs.map((d) => d.number) });
    }
  }
  if (changed.length) {
    const first = changed[0];
    const err = new ConflictError(`${first.name} was ordered since you loaded this screen (${first.documents.join(", ") || "another document"}). Reload the reorder screen.`);
    (err as ConflictError & { details?: unknown }).details = { changed };
    throw err;
  }
  return { byId, recheckedAt: now };
}

/** The audit snapshot of one raised line: what was suggested vs what was ordered. */
function auditLine(e: Evaluated, line: { materialId: string; qty: number; unitId?: string | null; vendorId?: string; rate?: number }, orderedBase: Dec) {
  const r = e.row;
  return {
    materialId: line.materialId, onHand: r.onHand, incoming: r.incoming, reorderPoint: r.reorderPoint, target: r.target, avgDailyUse: r.avgDailyUse, historyStatus: r.historyStatus,
    eligibleNow: e.plan.eligible, suggestedBaseQty: e.plan.eligible ? r.suggestedBaseQty : null, orderedQty: line.qty, orderedUnitId: line.unitId ?? r.baseUnitId, orderedBaseQty: num(orderedBase),
    qtyOverride: !e.plan.eligible || !orderedBase.eq(D(r.suggestedBaseQty)),
    ...(line.vendorId !== undefined ? { suggestedVendorId: r.vendor?.id ?? null, vendorId: line.vendorId, vendorOverride: line.vendorId !== (r.vendor?.id ?? null), rate: line.rate } : {}),
  };
}

type RaisedPo = Awaited<ReturnType<typeof createPurchaseOrderInTx>>;
const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "P2002";

/**
 * Accepted reorder lines → one DRAFT purchase order per vendor, all in one
 * transaction (all or nothing). Mandatory Idempotency-Key: each vendor's PO
 * stores "<key>:<vendorId>" with the hash of the WHOLE request, so a retry
 * returns the same POs and a different request under the key is a 409.
 */
export async function raiseReorderPurchaseOrders(ctx: AccessContext, input: unknown, idempotencyKey: string | undefined, db: Client = prisma, now: Date = new Date()) {
  const key = requireKey(idempotencyKey);
  const data = parseBody(raisePoSchema, input);
  const asOf = parseAsOf(data.asOf, now);
  const lookbackDays = parseWindow(data.lookbackDays);
  assertUniqueMaterials(data.lines);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "purchase.create", data.outletId);
  const hash = requestHashOf(ctx, "reorder-purchase-orders", data);
  const org = ctx.organizationId;

  const replay = async () => {
    const prior = await prisma.purchaseOrder.findMany({ where: { organizationId: org, idempotencyKey: { startsWith: `${key}:` } }, include: { lines: true }, orderBy: { idempotencyKey: "asc" } });
    if (!prior.length) return null;
    if (prior.some((p) => p.requestHash !== hash)) throw new ConflictError("Idempotency key was already used for a different request");
    return { purchaseOrders: prior, replayed: true };
  };
  const prior = await replay();
  if (prior) return prior;

  const vendorIds = [...new Set(data.lines.map((l) => l.vendorId))].sort();
  try {
    return await runInTx(db, async (tx) => {
      // Group 1 gate first, for every vendor, before anything is written.
      for (const v of vendorIds) await ensureVendor(tx, ctx, v, "buy");
      const { byId, recheckedAt } = await recheck(tx, ctx, data.outletId, lookbackDays, data.lines);

      const created: RaisedPo[] = [];
      for (const vendorId of vendorIds) {
        const lines = data.lines.filter((l) => l.vendorId === vendorId);
        const poLines = [];
        const audit = [];
        for (const l of lines) {
          const e = byId.get(l.materialId)!;
          const factor = await unitFactor(tx, ctx, l.materialId, l.unitId);
          const link = await tx.vendorMaterial.findUnique({ where: { vendorId_materialId: { vendorId, materialId: l.materialId } }, select: { lastRate: true } });
          const baseRate = link && D(link.lastRate).gt(0) ? D(link.lastRate) : e.row.unitCost !== null ? D(e.row.unitCost) : null;
          const rate = l.rate !== undefined ? D(l.rate) : baseRate ? baseRate.times(factor).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP) : null;
          if (!rate || rate.lte(0)) throw new ValidationError(`Enter a rate for ${e.row.name}: there is no vendor rate or cost to default from`);
          poLines.push({ materialId: l.materialId, qty: l.qty, rate: num(rate), unitId: l.unitId ?? undefined });
          audit.push(auditLine(e, { ...l, rate: num(rate) }, D(l.qty).times(factor)));
        }
        const po = await createPurchaseOrderInTx(
          tx, ctx,
          parsePurchaseOrderInput({ outletId: data.outletId, vendorId, expectedDate: data.expectedDate, notes: data.notes ?? "Raised from the reorder screen", lines: poLines }),
          { idempotencyKey: `${key}:${vendorId}`, requestHash: hash, source: REORDER_SOURCE, audit: { source: REORDER_SOURCE, asOf: asOf.toISOString(), recheckedAt: recheckedAt.toISOString(), lookbackDays, lines: audit } },
        );
        created.push(po);
      }
      const purchaseOrders = await tx.purchaseOrder.findMany({ where: { id: { in: created.map((p) => p.id) } }, include: { lines: true }, orderBy: { idempotencyKey: "asc" } });
      return { purchaseOrders, replayed: false };
    });
  } catch (e) {
    // The same request racing itself (same key): the loser hits the unique key, or its
    // re-check sees the winner's document. Either way it returns the winner's result.
    if (isUniqueViolation(e) || e instanceof ConflictError) {
      const winner = await replay();
      if (winner) return winner;
    }
    throw e;
  }
}

/** Accepted reorder lines → one DRAFT purchase request (indent); no vendor needed. */
export async function raiseReorderIndent(ctx: AccessContext, input: unknown, idempotencyKey: string | undefined, db: Client = prisma, now: Date = new Date()) {
  const key = requireKey(idempotencyKey);
  const data = parseBody(raiseIndentSchema, input);
  const asOf = parseAsOf(data.asOf, now);
  const lookbackDays = parseWindow(data.lookbackDays);
  assertUniqueMaterials(data.lines);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "purchase.create", data.outletId);
  const hash = requestHashOf(ctx, "reorder-indent", data);
  const org = ctx.organizationId;

  const replay = async () => {
    const prior = await prisma.purchaseIndent.findUnique({ where: { organizationId_idempotencyKey: { organizationId: org, idempotencyKey: key } }, include: { lines: true } });
    if (!prior) return null;
    if (prior.requestHash !== hash) throw new ConflictError("Idempotency key was already used for a different request");
    return { indent: prior, replayed: true };
  };
  const prior = await replay();
  if (prior) return prior;

  try {
    return await runInTx(db, async (tx) => {
      if (data.departmentId) {
        const dept = await tx.department.findUnique({ where: { id: data.departmentId } });
        if (!dept || dept.organizationId !== org || dept.outletId !== data.outletId) throw new ValidationError("The department does not belong to this outlet");
        if (!dept.active) throw new ValidationError(`Department ${dept.name} is inactive`);
      }
      const { byId, recheckedAt } = await recheck(tx, ctx, data.outletId, lookbackDays, data.lines);
      const audit = [];
      for (const l of data.lines) audit.push(auditLine(byId.get(l.materialId)!, l, D(l.qty).times(await unitFactor(tx, ctx, l.materialId, l.unitId))));
      const indent = await createIndentInTx(
        tx, ctx,
        parseIndentInput({ outletId: data.outletId, departmentId: data.departmentId, lines: data.lines.map((l) => ({ materialId: l.materialId, qty: l.qty, unitId: l.unitId ?? undefined })) }),
        { idempotencyKey: key, requestHash: hash, source: REORDER_SOURCE, notes: data.notes ?? "Raised from the reorder screen", audit: { source: REORDER_SOURCE, asOf: asOf.toISOString(), recheckedAt: recheckedAt.toISOString(), lookbackDays, lines: audit } },
      );
      return { indent: await tx.purchaseIndent.findUniqueOrThrow({ where: { id: indent.id }, include: { lines: true } }), replayed: false };
    });
  } catch (e) {
    // The same request racing itself (same key): the loser hits the unique key, or its
    // re-check sees the winner's document. Either way it returns the winner's result.
    if (isUniqueViolation(e) || e instanceof ConflictError) {
      const winner = await replay();
      if (winner) return winner;
    }
    throw e;
  }
}

/** Base units per one `unitId` of the material (422 when it does not convert). */
async function unitFactor(tx: Tx, ctx: AccessContext, materialId: string, unitId: string | null | undefined): Promise<Dec> {
  return (await resolveUnit(tx, ctx, materialId, unitId)).factor;
}
