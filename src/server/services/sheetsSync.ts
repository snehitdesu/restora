/**
 * Google Sheets sync (group 5; proposal p. 3 and p. 12: "Google Sheets two-way
 * sync: your team keeps using the spreadsheet they like; the system pushes and
 * pulls without anyone copying data").
 *
 * One SHEETS connection per organization (provider `google_sheets` with a
 * service account, or `mock`), pointing at one spreadsheet. Four datasets,
 * each in its own tab:
 *
 *  - MATERIALS (two-way): the team may edit three columns, the reorder level,
 *    the minimum stock and the PAR level. Name, unit and SKU belong to RESTORA.
 *    Edits are applied through the master-data service (same validation, same
 *    audit trail, org-wide `master.manage` needed) and never create materials.
 *  - STOCK, VENDOR_DUES, DAILY_SALES (push only): snapshots the team reads;
 *    nothing is ever pulled from them.
 *
 * Two-way rule (three-way merge, no timestamps to trust): for every material
 * the last value both sides agreed on is remembered as a hash
 * (SheetSyncRow). Only the sheet changed -> pull. Only RESTORA changed -> push.
 * Neither -> nothing. BOTH changed to different values -> a SheetSyncConflict:
 * neither side is touched until a person picks one. A first sync that finds a
 * row on both sides with different values is a conflict too: nothing is
 * overwritten silently. An invalid edit (text, negative, PAR below reorder) is
 * reported per row and the row is left alone; duplicates and unknown SKUs are
 * reported and skipped. A tab that does not look like ours is never
 * overwritten.
 *
 * Safety: a lease row serialises two syncs of one dataset; the sheet is re-read
 * just before the write and the run stops (nothing written) if a person edited
 * it meanwhile; remembered agreement is only advanced after the side that had
 * to change was changed, so a crash converges on the next run.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, ConflictError, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan, can } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { authorizedOutletIds, dailySales } from "@/server/services/analytics";
import { stockMatrix } from "@/server/services/departmentCosting";
import { vendorDues } from "@/server/services/procurement";
import { updateMaterial } from "@/server/services/masterData";
import { connectionCredentials, effectiveMode, recordHealth } from "@/server/services/integrations";
import { mockProvidersAllowed } from "@/integrations/policy";
import { GoogleSheetsClient, MockSheetsProvider, type SheetCell, type SheetsProvider, type SheetValues } from "@/integrations/sheets";
import { sheetsConfigSchema, sheetsCredsSchema } from "@/server/integrations/sheetsConfig";
import { IntegrationError, UnauthorizedIntegrationError, safeMessage, type FetchLike } from "@/integrations/http";
import { D } from "@/domain/money";

export const SHEET_DATASETS = ["MATERIALS", "STOCK", "VENDOR_DUES", "DAILY_SALES"] as const;
export type SheetDataset = (typeof SHEET_DATASETS)[number];
const MAX_ROWS = 5000;

// ---------------------------------------------------------------- provider

const mockSheets = new Map<string, MockSheetsProvider>();
/** The in-memory spreadsheet of a mock connection (tests and local development read and edit it). */
export function mockSheetFor(connectionId: string): MockSheetsProvider {
  return mockSheets.get(connectionId) ?? mockSheets.set(connectionId, new MockSheetsProvider()).get(connectionId)!;
}

export function sheetsProviderFor(c: { id: string; provider: string; mode: string; config: string | null; credentialsEnc: string | null }, fetchImpl?: FetchLike): SheetsProvider {
  if (c.provider === "mock") {
    if (!mockProvidersAllowed()) throw new IntegrationError("NOT_CONFIGURED", "Mock providers are not allowed in this deployment", false);
    return mockSheetFor(c.id);
  }
  if (c.provider === "google_sheets") {
    const cfg = sheetsConfigSchema.parse(c.config ? JSON.parse(c.config) : {});
    const raw = connectionCredentials(c);
    if (!raw) throw new IntegrationError("NOT_CONFIGURED", "Google service account credentials are not set", false);
    return new GoogleSheetsClient({ spreadsheetId: cfg.spreadsheetId, credentials: sheetsCredsSchema.parse(raw), mode: effectiveMode(c) === "LIVE" ? "LIVE" : "SANDBOX", fetchImpl });
  }
  throw new IntegrationError("NOT_CONFIGURED", `Unknown sheets provider "${c.provider}"`, false);
}

// ---------------------------------------------------------------- material tuples

const MATERIAL_HEADER = ["SKU", "Name (read-only)", "Unit (read-only)", "Reorder level", "Minimum stock", "PAR level (order up to)"];
const MATERIALS_TAB = "RESTORA Materials";

type Tuple = { reorderLevel: string; minStock: string; parLevel: string | null };
const fmt = (v: unknown) => D(v as never).toDecimalPlaces(4).toString();
const hashOf = (t: Tuple) => createHash("sha256").update(JSON.stringify([t.reorderLevel, t.minStock, t.parLevel])).digest("hex");
const tupleOfMaterial = (m: { reorderLevel: unknown; minStock: unknown; parLevel: unknown }): Tuple => ({ reorderLevel: fmt(m.reorderLevel), minStock: fmt(m.minStock), parLevel: m.parLevel === null || m.parLevel === undefined ? null : fmt(m.parLevel) });
const same = (a: Tuple, b: Tuple) => hashOf(a) === hashOf(b);

const NUMBER = /^\d{1,9}(\.\d{1,4})?$/;
function parseSheetRow(row: string[]): { ok: true; tuple: Tuple } | { ok: false; reason: string } {
  const cell = (i: number) => (row[i] ?? "").trim();
  const need = (i: number, label: string) => (NUMBER.test(cell(i)) ? null : cell(i) === "" ? `${label} is empty (enter 0 for none)` : `${label} must be a plain number, not "${cell(i).slice(0, 20)}"`);
  const bad = need(3, "Reorder level") ?? need(4, "Minimum stock") ?? (cell(5) === "" || NUMBER.test(cell(5)) ? null : `PAR level must be a plain number or empty, not "${cell(5).slice(0, 20)}"`);
  if (bad) return { ok: false, reason: bad };
  const tuple: Tuple = { reorderLevel: fmt(cell(3)), minStock: fmt(cell(4)), parLevel: cell(5) === "" ? null : fmt(cell(5)) };
  if (tuple.parLevel !== null && D(tuple.parLevel).lt(D(tuple.reorderLevel))) return { ok: false, reason: "The PAR level (order up to) cannot be below the reorder level" };
  return { ok: true, tuple };
}

// ---------------------------------------------------------------- lease

async function withLease<T>(db: PrismaClient, organizationId: string, key: string, fn: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  const where = { organizationId, dataset: "LOCK", rowKey: key };
  try {
    await db.sheetSyncRow.create({ data: { ...where, syncedHash: token, syncedAt: new Date() } });
  } catch (e) {
    if ((e as { code?: string })?.code !== "P2002") throw e;
    // A lease older than five minutes belongs to a crashed run.
    const taken = await db.sheetSyncRow.updateMany({ where: { ...where, syncedAt: { lt: new Date(Date.now() - 5 * 60_000) } }, data: { syncedHash: token, syncedAt: new Date() } });
    if (taken.count !== 1) throw new ConflictError("A sync of this sheet is already running; try again in a minute");
  }
  try { return await fn(); } finally { await db.sheetSyncRow.deleteMany({ where: { ...where, syncedHash: token } }); }
}

// ---------------------------------------------------------------- run

export type DatasetResult = {
  dataset: SheetDataset; tab: string; written: boolean;
  rows: number; pulled: number; pushed: number; unchanged: number; conflicts: number;
  invalid: Array<{ key: string; reason: string }>; unknownKeys: string[]; duplicateKeys: string[];
  /** The sheet was edited while the sync ran: nothing was written, run it again. */
  stoppedBecauseSheetChanged?: boolean;
  error?: string;
};
const blank = (dataset: SheetDataset, tab: string): DatasetResult => ({ dataset, tab, written: false, rows: 0, pulled: 0, pushed: 0, unchanged: 0, conflicts: 0, invalid: [], unknownKeys: [], duplicateKeys: [] });

const runSchema = z.object({
  connectionId: z.string().min(1),
  datasets: z.array(z.enum(SHEET_DATASETS)).min(1).max(4).default(["MATERIALS"]),
  outletId: z.string().min(1).optional(),
});

const tabSafe = (s: string) => s.replace(/[^A-Za-z0-9 _-]/g, "-").slice(0, 30);

async function loadConnection(db: PrismaClient, ctx: AccessContext, id: string) {
  const c = await db.integrationConnection.findUnique({ where: { id } });
  if (!c || c.organizationId !== ctx.organizationId || c.kind !== "SHEETS") throw new NotFoundError("Sheets connection not found");
  return c;
}

function refuseForeignTab(existing: SheetValues, header: string[], tab: string) {
  if (existing.length && (existing[0]?.[0] ?? "").trim() !== header[0]) throw new ValidationError(`The tab "${tab}" already holds other data (its first header is not "${header[0]}"). Rename or clear it first: RESTORA will not overwrite it.`);
}

/** Push-only snapshot: replace the tab's content with the grid. */
async function pushSnapshot(provider: SheetsProvider, dataset: SheetDataset, tab: string, header: string[], rows: SheetCell[][]): Promise<DatasetResult> {
  const r = blank(dataset, tab);
  if (rows.length > MAX_ROWS) throw new ValidationError(`Too many rows for a sheet (${rows.length}; at most ${MAX_ROWS})`);
  refuseForeignTab(await provider.read(tab), header, tab);
  await provider.write(tab, [header, ...rows]);
  return { ...r, written: true, rows: rows.length, pushed: rows.length };
}

async function syncMaterials(ctx: AccessContext, db: PrismaClient, provider: SheetsProvider): Promise<DatasetResult> {
  assertCan(ctx, "master.view");
  const out = blank("MATERIALS", MATERIALS_TAB);
  const materials = await db.material.findMany({ where: { organizationId: ctx.organizationId, active: true }, select: { id: true, sku: true, name: true, reorderLevel: true, minStock: true, parLevel: true, baseUnit: { select: { code: true } } }, orderBy: [{ sku: "asc" }], take: MAX_ROWS + 1 });
  if (materials.length > MAX_ROWS) throw new ValidationError(`Too many materials for a sheet (at most ${MAX_ROWS} active)`);
  const firstRead = await provider.read(MATERIALS_TAB);
  refuseForeignTab(firstRead, MATERIAL_HEADER, MATERIALS_TAB);

  // Sheet rows by SKU (row 0 is the header). Repeated SKUs are skipped: which row is meant is unknowable.
  const seen = new Map<string, string[][]>();
  for (const row of firstRead.slice(1)) {
    const sku = (row[0] ?? "").trim();
    if (!sku) continue;
    seen.set(sku, [...(seen.get(sku) ?? []), row]);
  }
  const duplicates = new Set([...seen].filter(([, rows]) => rows.length > 1).map(([sku]) => sku));
  out.duplicateKeys = [...duplicates].sort();
  const known = new Set(materials.map((m) => m.sku));
  out.unknownKeys = [...seen.keys()].filter((k) => !known.has(k)).sort();

  const bases = new Map((await db.sheetSyncRow.findMany({ where: { organizationId: ctx.organizationId, dataset: "MATERIALS" } })).map((b) => [b.rowKey, b]));
  const openConflicts = new Map((await db.sheetSyncConflict.findMany({ where: { organizationId: ctx.organizationId, dataset: "MATERIALS", status: "OPEN" } })).map((c) => [c.rowKey, c]));
  // Pulled edits go through the master-data service, which needs an org-wide role (materials belong to the organization).
  const canPull = can(ctx, "master.manage") && (ctx.isSuperAdmin || ctx.isOrgWide);
  const grid: SheetCell[][] = [MATERIAL_HEADER];
  const agreed: Array<{ sku: string; hash: string }> = []; // remembered after the sheet was written (push side)
  const now = new Date();

  const remember = (sku: string, hash: string) => db.sheetSyncRow.upsert({ where: { organizationId_dataset_rowKey: { organizationId: ctx.organizationId, dataset: "MATERIALS", rowKey: sku } }, create: { organizationId: ctx.organizationId, dataset: "MATERIALS", rowKey: sku, syncedHash: hash, syncedAt: now }, update: { syncedHash: hash, syncedAt: now } });
  const conflict = async (sku: string, restora: Tuple, sheet: Tuple) => {
    const data = { restoraValue: JSON.stringify(restora), sheetValue: JSON.stringify(sheet) };
    const open = openConflicts.get(sku);
    if (open) await db.sheetSyncConflict.update({ where: { id: open.id }, data });
    else await db.sheetSyncConflict.create({ data: { organizationId: ctx.organizationId, dataset: "MATERIALS", rowKey: sku, ...data } });
    out.conflicts++;
  };
  const closeConflict = async (sku: string) => {
    const open = openConflicts.get(sku);
    if (open) await db.sheetSyncConflict.update({ where: { id: open.id }, data: { status: "RESOLVED", resolvedAt: now } });
  };

  for (const m of materials) {
    const R = tupleOfMaterial(m);
    const restoraRow: SheetCell[] = [m.sku, m.name, m.baseUnit.code, Number(R.reorderLevel), Number(R.minStock), R.parLevel === null ? "" : Number(R.parLevel)];
    const rows = seen.get(m.sku);
    out.rows++;
    if (duplicates.has(m.sku)) { grid.push(...rows!); continue; } // left exactly as the team has it
    if (!rows) { grid.push(restoraRow); agreed.push({ sku: m.sku, hash: hashOf(R) }); out.pushed++; continue; }
    const sheetRow = rows[0];
    const parsed = parseSheetRow(sheetRow);
    if (!parsed.ok) { out.invalid.push({ key: m.sku, reason: parsed.reason }); grid.push(sheetRow); continue; }
    const S = parsed.tuple;
    const base = bases.get(m.sku)?.syncedHash;
    const hS = hashOf(S), hR = hashOf(R);
    const keepSheet = () => grid.push([m.sku, m.name, m.baseUnit.code, ...sheetRow.slice(3, 6)]); // the team's values, RESTORA's name and unit
    if (hS === hR) { // nothing to reconcile; remember the agreement (also closes an open conflict)
      await closeConflict(m.sku);
      if (base !== hR) await remember(m.sku, hR);
      grid.push(restoraRow); out.unchanged++; continue;
    }
    if (base === undefined || (hS !== base && hR !== base)) { // never agreed, or both sides moved apart
      await conflict(m.sku, R, S); keepSheet(); continue;
    }
    if (hS !== base) { // only the sheet changed -> pull
      if (!canPull) { out.invalid.push({ key: m.sku, reason: "Pulling sheet edits needs the master-data permission" }); keepSheet(); continue; }
      try {
        await updateMaterial(ctx, m.id, { reorderLevel: Number(S.reorderLevel), minStock: Number(S.minStock), parLevel: S.parLevel === null ? null : Number(S.parLevel) }, db);
      } catch (e) {
        if (e instanceof ValidationError) { out.invalid.push({ key: m.sku, reason: safeMessage(e) }); keepSheet(); continue; }
        throw e;
      }
      await remember(m.sku, hS); await closeConflict(m.sku);
      grid.push([m.sku, m.name, m.baseUnit.code, ...sheetRow.slice(3, 6)]); out.pulled++; continue;
    }
    // only RESTORA changed -> push
    grid.push(restoraRow); agreed.push({ sku: m.sku, hash: hR }); out.pushed++;
  }
  // Rows the team keeps that RESTORA does not know stay where they are (never deleted).
  for (const sku of out.unknownKeys) grid.push(...seen.get(sku)!);

  // Someone edited the sheet while we worked: stop before overwriting their edit (what was pulled is already safe in RESTORA).
  if (JSON.stringify(await provider.read(MATERIALS_TAB)) !== JSON.stringify(firstRead)) return { ...out, stoppedBecauseSheetChanged: true, pushed: 0 };
  await provider.write(MATERIALS_TAB, grid);
  out.written = true;
  for (const a of agreed) await remember(a.sku, a.hash);
  return out;
}

/** Run the chosen datasets against the organization's spreadsheet. Each dataset reports on its own; one failing never hides the others. */
export async function runSheetsSync(ctx: AccessContext, input: z.input<typeof runSchema>, db: PrismaClient = prisma, fetchImpl?: FetchLike) {
  const f = runSchema.parse(input);
  assertCan(ctx, "integration.manage");
  const c = await loadConnection(db, ctx, f.connectionId);
  if (c.status !== "CONNECTED") throw new ValidationError("The sheets connection is disconnected");
  if (f.datasets.some((d) => d === "STOCK" || d === "DAILY_SALES") && !f.outletId) throw new ValidationError("Choose an outlet for the stock and sales sheets", { fieldErrors: { outletId: ["Required"] } });
  const provider = sheetsProviderFor(c, fetchImpl);
  const outlet = f.outletId ? await db.outlet.findFirst({ where: { id: f.outletId, organizationId: ctx.organizationId }, select: { id: true, code: true } }) : null;
  if (f.outletId && !outlet) throw new NotFoundError("Outlet not found");
  const results: DatasetResult[] = [];
  for (const dataset of SHEET_DATASETS.filter((d) => f.datasets.includes(d))) {
    try {
      results.push(await withLease(db, ctx.organizationId, `${dataset}:${outlet?.id ?? "-"}`, async () => {
        if (dataset === "MATERIALS") return syncMaterials(ctx, db, provider);
        if (dataset === "VENDOR_DUES") {
          const due = await vendorDues(db, ctx, {});
          return pushSnapshot(provider, dataset, "RESTORA Vendor dues", ["Vendor", "Open bills", "Billed", "Paid", "Due", "Overdue"], due.map((v) => [v.vendorName, v.openBills, v.billed, v.paid, v.due, v.overdue]));
        }
        authorizedOutletIds(ctx, { outletId: outlet!.id }, dataset === "STOCK" ? "inventory.view" : "reports.view");
        if (dataset === "STOCK") {
          const m = await stockMatrix(db, ctx, { outletId: outlet!.id });
          const header = m.showValue ? ["SKU", "Name", "Unit", "On hand", "Reorder level", "Status", "Average cost", "Value"] : ["SKU", "Name", "Unit", "On hand", "Reorder level", "Status"];
          return pushSnapshot(provider, dataset, `RESTORA Stock ${tabSafe(outlet!.code)}`, header, m.rows.map((r) => [r.sku, r.name, r.unit, r.total, r.par, r.negative ? "NEGATIVE" : r.belowPar ? "BELOW PAR" : "OK", ...(m.showValue ? [r.avgCost ?? 0, r.value ?? 0] : [])]));
        }
        const to = new Date(), from = new Date(to.getTime() - 31 * 86400_000);
        const sales = await dailySales(db, ctx, { outletId: outlet!.id, from, to });
        return pushSnapshot(provider, dataset, `RESTORA Daily sales ${tabSafe(outlet!.code)}`, ["Date", "Orders", "Covers", "Gross sales", "Discounts", "Taxes", "Total", "Refunds", "Net sales"], sales.map((d) => [d.day, d.orders, d.covers, d.grossSales, d.discounts, d.taxes, d.total, d.refunds, d.netSales]));
      }));
    } catch (e) {
      const unauthorized = e instanceof UnauthorizedIntegrationError;
      results.push({ ...blank(dataset, dataset === "MATERIALS" ? MATERIALS_TAB : dataset), error: `${unauthorized ? "UNAUTHORIZED" : e instanceof IntegrationError ? e.code : e instanceof ConflictError || e instanceof ValidationError ? "REFUSED" : "FAILED"}: ${safeMessage(e)}` });
    }
  }
  const failed = results.filter((r) => r.error);
  // A refusal (foreign tab, running lease) is not the provider's fault; only provider errors mark the connection unhealthy.
  const providerFailure = failed.find((r) => !r.error?.startsWith("REFUSED"));
  await recordHealth(db, c.id, !providerFailure, providerFailure?.error);
  await db.$transaction((tx) => writeAudit(tx, ctx, {
    action: "INTEGRATION_SYNC", entityType: "SheetsSync", entityId: c.id, outletId: f.outletId,
    after: { provider: c.provider, mode: effectiveMode(c), datasets: results.map((r) => ({ dataset: r.dataset, written: r.written, pulled: r.pulled, pushed: r.pushed, conflicts: r.conflicts, invalid: r.invalid.length, error: r.error ?? null })) },
  }));
  return { provider: c.provider, mode: effectiveMode(c), results };
}

// ---------------------------------------------------------------- conflicts

export async function listSheetConflicts(db: PrismaClient, ctx: AccessContext, input: { status?: "OPEN" | "RESOLVED" } = {}) {
  assertCan(ctx, "integration.manage");
  const rows = await db.sheetSyncConflict.findMany({ where: { organizationId: ctx.organizationId, ...(input.status ? { status: input.status } : {}) }, orderBy: [{ detectedAt: "desc" }, { id: "desc" }], take: 200 });
  const skus = [...new Set(rows.map((r) => r.rowKey))];
  const names = new Map((await db.material.findMany({ where: { organizationId: ctx.organizationId, sku: { in: skus } }, select: { sku: true, name: true } })).map((m) => [m.sku, m.name]));
  return rows.map((r) => ({ id: r.id, dataset: r.dataset, key: r.rowKey, name: names.get(r.rowKey) ?? null, status: r.status, detectedAt: r.detectedAt.toISOString(), resolvedAt: r.resolvedAt?.toISOString() ?? null, restora: JSON.parse(r.restoraValue) as Tuple, sheet: JSON.parse(r.sheetValue) as Tuple }));
}

/** Settle a conflict in favour of RESTORA (the next sync overwrites the sheet) or of the sheet (applied to RESTORA now, validated like any edit). */
export async function resolveSheetConflict(ctx: AccessContext, id: string, choice: "RESTORA" | "SHEET", db: PrismaClient = prisma) {
  assertCan(ctx, "integration.manage");
  const c = await db.sheetSyncConflict.findUnique({ where: { id } });
  if (!c || c.organizationId !== ctx.organizationId) throw new NotFoundError("Conflict not found");
  if (c.status !== "OPEN") throw new ValidationError("This conflict is already resolved");
  const sheet = JSON.parse(c.sheetValue) as Tuple;
  if (choice === "SHEET") {
    const m = await db.material.findFirst({ where: { organizationId: ctx.organizationId, sku: c.rowKey }, select: { id: true } });
    if (!m) throw new NotFoundError("The material no longer exists");
    await updateMaterial(ctx, m.id, { reorderLevel: Number(sheet.reorderLevel), minStock: Number(sheet.minStock), parLevel: sheet.parLevel === null ? null : Number(sheet.parLevel) }, db);
  }
  // Agreement = the sheet's recorded value: with RESTORA chosen the next sync sees RESTORA changed and the sheet not, and pushes.
  const hash = hashOf(sheet);
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.sheetSyncRow.upsert({ where: { organizationId_dataset_rowKey: { organizationId: ctx.organizationId, dataset: c.dataset, rowKey: c.rowKey } }, create: { organizationId: ctx.organizationId, dataset: c.dataset, rowKey: c.rowKey, syncedHash: hash, syncedAt: now }, update: { syncedHash: hash, syncedAt: now } });
    const closed = await tx.sheetSyncConflict.updateMany({ where: { id: c.id, status: "OPEN" }, data: { status: "RESOLVED", resolvedAt: now, resolvedById: ctx.userId === "system" ? null : ctx.userId } });
    if (closed.count !== 1) throw new ConflictError("This conflict was just resolved by someone else");
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "SheetSyncConflict", entityId: c.id, after: { sku: c.rowKey, choice } });
  });
  return { id: c.id, choice, status: "RESOLVED" as const };
}
