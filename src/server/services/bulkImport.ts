/**
 * Bulk import of the master data a restaurant already has in a spreadsheet (audit MD-21): materials and vendors, from a CSV
 * saved out of Excel or Google Sheets.
 *
 * The same rules as typing each row in by hand: every row goes through the ordinary material / vendor validation, new
 * vendors still start PENDING (an approver must activate them before anyone can buy), and the same permission is needed.
 * Safe to repeat: a row whose SKU (or, with no SKU, whose name) already exists is skipped and reported, never duplicated or
 * overwritten. The check is a dry run by default and writes nothing; committing is all-or-nothing, so a file with any row in
 * error creates nothing and says exactly which lines to fix.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, ValidationError } from "@/server/db/scope";
import { writeAudit } from "@/server/audit/log";
import { CsvParseError, parseCSV, type ParsedCsv } from "@/domain/csv";
import { type Client, runInTx } from "@/server/services/_workflow";
import { assertOrgWide, createMaterial, createMaterialCategory, createVendor, materialInputSchema, vendorInputSchema } from "@/server/services/masterData";

export const IMPORT_MAX_ROWS = 1000;
/** The API accepts bodies up to 1 MB. */
export const IMPORT_MAX_CHARS = 900_000;

export type ImportKind = "materials" | "vendors";
export type ImportAction = "CREATE" | "SKIP" | "ERROR";
export type ImportRow = { line: number; label: string; action: ImportAction; message?: string };
export type ImportReport = {
  kind: ImportKind;
  committed: boolean;
  counts: { create: number; skip: number; error: number };
  rows: ImportRow[];
  /** Categories the import would create (materials). */
  newCategories: string[];
  /** Columns the importer used, and columns in the file it does not know (ignored, never an error). */
  columns: { used: string[]; ignored: string[] };
  note: string | null;
};

const kindSchema = z.enum(["materials", "vendors"]);
const inputSchema = z.object({ csv: z.string().min(1, "The file is empty").max(IMPORT_MAX_CHARS, "The file is too large; import it in parts"), commit: z.boolean().default(false) }).strict();

const ALIASES: Record<ImportKind, Record<string, string[]>> = {
  materials: {
    name: ["name", "material", "materialname", "item", "itemname"],
    sku: ["sku", "code", "itemcode", "materialcode"],
    brand: ["brand"],
    category: ["category", "group"],
    baseunit: ["baseunit", "unit", "stockunit", "uom"],
    purchaseunit: ["purchaseunit", "buyunit", "purchaseuom"],
    taxpct: ["taxpct", "tax", "gst", "gstpct", "taxpercent"],
    minstock: ["minstock", "minimumstock", "safetystock"],
    reorderlevel: ["reorderlevel", "reorderat", "reorderpoint"],
    parlevel: ["parlevel", "orderupto", "par"],
    perishable: ["perishable"],
    trackbatch: ["trackbatch", "batchtracking", "trackbatches"],
    preferredvendor: ["preferredvendor", "vendor", "defaultvendor", "supplier"],
  },
  vendors: {
    name: ["name", "vendor", "vendorname", "supplier"],
    companyname: ["companyname", "company", "legalname"],
    phone: ["phone", "mobile", "contactnumber"],
    email: ["email", "mail"],
    address: ["address"],
    gstin: ["gstin", "gst", "gstnumber"],
    paymentterms: ["paymentterms", "terms"],
    creditlimit: ["creditlimit", "credit"],
    category: ["category", "vendorcategory", "type"],
    natureofsupply: ["natureofsupply", "supply", "nature"],
    notes: ["notes", "remarks"],
  },
};

/** The header keys of the file mapped to the importer's own names. */
function mapColumns(kind: ImportKind, parsed: ParsedCsv) {
  const byKey = new Map<string, string>();
  for (const [own, names] of Object.entries(ALIASES[kind])) for (const n of names) if (!byKey.has(n)) byKey.set(n, own);
  const used = new Map<string, string>(); // file key -> own name
  const ignored: string[] = [];
  parsed.keys.forEach((k, i) => {
    const own = byKey.get(k);
    if (own && ![...used.values()].includes(own)) used.set(k, own);
    else ignored.push(parsed.headers[i]);
  });
  return { used, ignored };
}

const cleanNumber = (v: string) => v.replace(/[₹,\s]/g, "");
function numberCell(v: string, what: string, errors: string[]): number | undefined {
  if (v === "") return undefined;
  const n = Number(cleanNumber(v));
  if (!Number.isFinite(n)) { errors.push(`${what}: "${v}" is not a number`); return undefined; }
  return n;
}
function boolCell(v: string, what: string, errors: string[]): boolean | undefined {
  const t = v.trim().toLowerCase();
  if (t === "") return undefined;
  if (["yes", "y", "true", "1"].includes(t)) return true;
  if (["no", "n", "false", "0"].includes(t)) return false;
  errors.push(`${what}: use yes or no (got "${v}")`);
  return undefined;
}
const flat = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "row"}: ${i.message}`).join("; ");
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function parseFile(csv: string): ParsedCsv {
  try {
    const parsed = parseCSV(csv);
    if (parsed.rows.length === 0) throw new CsvParseError("The file has a header but no rows");
    if (parsed.rows.length > IMPORT_MAX_ROWS) throw new CsvParseError(`More than ${IMPORT_MAX_ROWS} rows: import the file in parts`);
    return parsed;
  } catch (e) {
    if (e instanceof CsvParseError) throw new ValidationError(e.message, { fieldErrors: { csv: [e.message] } });
    throw e;
  }
}

// ---------------------------------------------------------------- materials

type MaterialPlan = { line: number; label: string; action: ImportAction; message?: string; input?: z.input<typeof materialInputSchema>; category?: string };

async function planMaterials(db: Client, ctx: AccessContext, parsed: ParsedCsv) {
  const client = db as PrismaClient;
  const { used, ignored } = mapColumns("materials", parsed);
  const ownKeys = [...used.values()];
  const [units, categories, vendors, existing] = await Promise.all([
    client.unit.findMany({ where: { organizationId: ctx.organizationId, active: true }, select: { id: true, code: true, name: true } }),
    client.materialCategory.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true, name: true } }),
    client.vendor.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true, name: true } }),
    client.material.findMany({ where: { organizationId: ctx.organizationId }, select: { sku: true, name: true } }),
  ]);
  const unitBy = new Map(units.flatMap((u) => [[norm(u.code), u.id], [norm(u.name), u.id]] as const));
  const catBy = new Map(categories.map((c) => [norm(c.name), c.id]));
  const vendorBy = new Map(vendors.map((v) => [norm(v.name), v.id]));
  const skus = new Set(existing.map((m) => norm(m.sku)));
  const names = new Set(existing.map((m) => norm(m.name)));
  let skuSeq = existing.reduce((max, m) => { const n = /^RM-(\d+)$/i.exec(m.sku)?.[1]; return n ? Math.max(max, Number(n)) : max; }, 0);
  const seenSku = new Map<string, number>();
  const seenName = new Map<string, number>();
  const newCategories = new Map<string, string>(); // lower-case -> as typed ("Dairy" and "dairy" are one category)

  const plans: MaterialPlan[] = parsed.rows.map((row) => {
    const cell = (own: string) => {
      const key = [...used.entries()].find(([, o]) => o === own)?.[0];
      return key ? (row.cells[key] ?? "").trim() : "";
    };
    const errors: string[] = [];
    const name = cell("name");
    const label = name || `line ${row.line}`;
    if (!name) errors.push("name is required");
    if (!ownKeys.includes("baseunit")) errors.push("the file has no unit column (base unit)");
    const unitText = cell("baseunit");
    const baseUnitId = unitText ? unitBy.get(norm(unitText)) : undefined;
    if (ownKeys.includes("baseunit") && !baseUnitId) errors.push(unitText ? `unit "${unitText}" is not one of your units (${units.map((u) => u.code).slice(0, 8).join(", ")})` : "base unit is required");
    const purchaseText = cell("purchaseunit");
    const purchaseUnitId = purchaseText ? unitBy.get(norm(purchaseText)) : undefined;
    if (purchaseText && !purchaseUnitId) errors.push(`purchase unit "${purchaseText}" is not one of your units`);
    const vendorText = cell("preferredvendor");
    const preferredVendorId = vendorText ? vendorBy.get(norm(vendorText)) : undefined;
    if (vendorText && !preferredVendorId) errors.push(`vendor "${vendorText}" does not exist (import vendors first)`);
    const catText = cell("category");
    const categoryId = catText ? catBy.get(norm(catText)) : undefined;

    const input = {
      sku: cell("sku") || undefined, name, brand: cell("brand") || undefined,
      baseUnitId: baseUnitId ?? "", purchaseUnitId, categoryId, preferredVendorId,
      taxPct: numberCell(cell("taxpct"), "tax %", errors), minStock: numberCell(cell("minstock"), "minimum stock", errors),
      reorderLevel: numberCell(cell("reorderlevel"), "reorder level", errors), parLevel: numberCell(cell("parlevel"), "par level", errors),
      perishable: boolCell(cell("perishable"), "perishable", errors), trackBatch: boolCell(cell("trackbatch"), "track batch", errors),
    };
    // Duplicates inside the file, then what already exists.
    const skuKey = input.sku ? norm(input.sku) : "";
    const nameKey = norm(name);
    if (skuKey && seenSku.has(skuKey)) errors.push(`SKU ${input.sku} is already on line ${seenSku.get(skuKey)}`);
    else if (!skuKey && nameKey && seenName.has(nameKey)) errors.push(`"${name}" is already on line ${seenName.get(nameKey)}`);
    if (errors.length) return { line: row.line, label, action: "ERROR" as const, message: errors.join("; ") };
    if (skuKey) seenSku.set(skuKey, row.line);
    if (nameKey) seenName.set(nameKey, row.line);
    if (skuKey ? skus.has(skuKey) : names.has(nameKey)) return { line: row.line, label, action: "SKIP" as const, message: skuKey ? `SKU ${input.sku} already exists` : `a material called "${name}" already exists` };
    // The row must pass the same validation as typing it in (without the SKU we are about to generate).
    const generatedSku = input.sku ?? `RM-${String(++skuSeq).padStart(4, "0")}`;
    const full = { ...input, sku: generatedSku };
    const parsedRow = materialInputSchema.safeParse(full);
    if (!parsedRow.success) return { line: row.line, label, action: "ERROR" as const, message: flat(parsedRow.error) };
    if (parsedRow.data.parLevel != null && parsedRow.data.parLevel < parsedRow.data.reorderLevel) return { line: row.line, label, action: "ERROR" as const, message: "par level cannot be below the reorder level" };
    if (catText && !categoryId && !newCategories.has(norm(catText))) newCategories.set(norm(catText), catText.trim());
    skus.add(norm(generatedSku));
    return { line: row.line, label: `${name} (${generatedSku})`, action: "CREATE" as const, input: full, category: catText && !categoryId ? norm(catText) : undefined };
  });
  return { plans, newCategories: [...newCategories.values()], used: ownKeys, ignored };
}

// ---------------------------------------------------------------- vendors

type VendorPlan = { line: number; label: string; action: ImportAction; message?: string; input?: z.input<typeof vendorInputSchema> };

async function planVendors(db: Client, ctx: AccessContext, parsed: ParsedCsv) {
  const client = db as PrismaClient;
  const { used, ignored } = mapColumns("vendors", parsed);
  const existing = await client.vendor.findMany({ where: { organizationId: ctx.organizationId }, select: { name: true } });
  const names = new Set(existing.map((v) => norm(v.name)));
  const seen = new Map<string, number>();
  const plans: VendorPlan[] = parsed.rows.map((row) => {
    const cell = (own: string) => {
      const key = [...used.entries()].find(([, o]) => o === own)?.[0];
      return key ? (row.cells[key] ?? "").trim() : "";
    };
    const errors: string[] = [];
    const name = cell("name");
    const label = name || `line ${row.line}`;
    if (!name) errors.push("name is required");
    const nature = cell("natureofsupply").toUpperCase().replace(/\s+/g, "");
    const natureOfSupply = nature === "" ? undefined : ["GOODS", "SERVICES", "BOTH"].includes(nature) ? nature : nature === "GOODSANDSERVICES" ? "BOTH" : undefined;
    if (nature && !natureOfSupply) errors.push(`nature of supply "${cell("natureofsupply")}": use goods, services or both`);
    const input = {
      name, companyName: cell("companyname") || undefined, phone: cell("phone") || undefined, email: cell("email").toLowerCase() || undefined, address: cell("address") || undefined,
      gstin: cell("gstin").toUpperCase() || undefined, paymentTerms: cell("paymentterms") || undefined, creditLimit: numberCell(cell("creditlimit"), "credit limit", errors),
      category: cell("category") || undefined, natureOfSupply: natureOfSupply as "GOODS" | "SERVICES" | "BOTH" | undefined, notes: cell("notes") || undefined,
    };
    const key = norm(name);
    if (key && seen.has(key)) errors.push(`"${name}" is already on line ${seen.get(key)}`);
    if (errors.length) return { line: row.line, label, action: "ERROR" as const, message: errors.join("; ") };
    seen.set(key, row.line);
    if (names.has(key)) return { line: row.line, label, action: "SKIP" as const, message: `a vendor called "${name}" already exists` };
    const checked = vendorInputSchema.safeParse(input);
    if (!checked.success) return { line: row.line, label, action: "ERROR" as const, message: flat(checked.error) };
    return { line: row.line, label, action: "CREATE" as const, input };
  });
  return { plans, newCategories: [] as string[], used: [...used.values()], ignored };
}

// ---------------------------------------------------------------- the one entry point

function report(kind: ImportKind, committed: boolean, p: { plans: Array<{ line: number; label: string; action: ImportAction; message?: string }>; newCategories: string[]; used: string[]; ignored: string[] }, note: string | null): ImportReport {
  const rows = p.plans.map(({ line, label, action, message }) => ({ line, label, action, ...(message ? { message } : {}) }));
  return {
    kind, committed, rows, newCategories: p.newCategories, columns: { used: p.used, ignored: p.ignored }, note,
    counts: { create: rows.filter((r) => r.action === "CREATE").length, skip: rows.filter((r) => r.action === "SKIP").length, error: rows.filter((r) => r.action === "ERROR").length },
  };
}

export async function importMasterData(ctx: AccessContext, kind: ImportKind, input: z.input<typeof inputSchema>, db: Client = prisma): Promise<ImportReport> {
  kind = kindSchema.parse(kind);
  const { csv, commit } = inputSchema.parse(input);
  assertOrgWide(ctx, kind === "materials" ? "master.manage" : "vendor.manage");
  const parsed = parseFile(csv);
  const plan = (c: Client) => (kind === "materials" ? planMaterials(c, ctx, parsed) : planVendors(c, ctx, parsed));

  if (!commit) {
    const p = await plan(db);
    const checked = report(kind, false, p, null);
    return { ...checked, note: checked.counts.error ? "Fix the lines marked as errors, then check the file again." : "Nothing has been saved yet. Import to create the rows marked Create." };
  }
  return runInTx(db, async (tx) => {
    const p = await plan(tx);
    const counts = report(kind, false, p, null).counts;
    if (counts.error) return report(kind, false, p, "Nothing was imported: fix the lines marked as errors and try again.");
    if (!counts.create) return report(kind, false, p, "Nothing to import: every row already exists.");
    if (kind === "materials") {
      const cats = new Map<string, string>();
      for (const name of p.newCategories) cats.set(norm(name), (await createMaterialCategory(ctx, { name }, tx)).id);
      for (const plan of p.plans as MaterialPlan[]) {
        if (plan.action !== "CREATE" || !plan.input) continue;
        await createMaterial(ctx, { ...plan.input, categoryId: plan.input.categoryId ?? (plan.category ? cats.get(norm(plan.category)) : undefined) }, tx);
      }
    } else {
      for (const plan of p.plans as VendorPlan[]) if (plan.action === "CREATE" && plan.input) await createVendor(ctx, plan.input, tx);
    }
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "BulkImport", entityId: randomUUID(), after: { kind, created: counts.create, skipped: counts.skip, rows: parsed.rows.length, newCategories: p.newCategories.length } });
    return report(kind, true, p, kind === "vendors" ? "Imported. New vendors are awaiting approval: nobody can buy from them until an approver activates them." : "Imported.");
  });
}
