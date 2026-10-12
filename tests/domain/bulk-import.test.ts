/**
 * CSV bulk import of materials and vendors (audit MD-21) against the real services and database: a dry run that writes
 * nothing, an all-or-nothing commit, safe repetition, the same validation and permissions as typing each row in.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { ForbiddenError, ValidationError } from "@/server/db/scope";
import { importMasterData, IMPORT_MAX_ROWS } from "@/server/services/bulkImport";
import { makeEnv, member, uniq, type Env } from "./growthSupport";

let env: Env;
let kg: string;
let kgCode: string;
let pcsCode: string;

const run = (kind: "materials" | "vendors", csv: string, commit = false, ctx = env.owner) => importMasterData(ctx, kind, { csv, commit });
const count = (model: "material" | "vendor" | "materialCategory") => (prisma[model] as unknown as { count: (a: unknown) => Promise<number> }).count({ where: { organizationId: env.orgId } });

beforeAll(async () => {
  env = await makeEnv("Gbi");
  const tag = uniq();
  kgCode = `kg${tag}`;
  pcsCode = `pc${tag}`;
  kg = (await prisma.unit.create({ data: { organizationId: env.orgId, code: kgCode, name: "Kilogram", kind: "WEIGHT" } })).id;
  await prisma.unit.create({ data: { organizationId: env.orgId, code: pcsCode, name: "Pieces", kind: "COUNT" } });
  await prisma.vendor.create({ data: { organizationId: env.orgId, name: "Fresh Farms", status: "ACTIVE", active: true } });
}, 60000);
afterAll(async () => { await prisma.$disconnect(); });

describe("B1. checking a file writes nothing", () => {
  it("B1 each row is told apart: create, skip (already there), error with the reason; unknown columns are named and ignored", async () => {
    await prisma.material.create({ data: { organizationId: env.orgId, sku: "RICE-1", name: "Rice", baseUnitId: kg } });
    const csv = [
      "Name,SKU,Brand,Category,Unit,GST %,Reorder level,Par level,Perishable,Vendor,Weird column",
      `Basmati Rice,RICE-2,India Gate,Grains,${kgCode},5,10,40,no,Fresh Farms,x`,
      `Rice,RICE-1,,Grains,${kgCode},,,,,,`,
      `,NO-NAME,,,${kgCode},,,,,,`,
      `Paneer,PAN-1,,Dairy,furlongs,,,,,,`,
      `Tomato,TOM-1,,Produce,${kgCode},abc,,,,,`,
      `Milk,MILK-1,Amul,Dairy,${kgCode},,20,10,maybe,Nobody Ltd,`,
    ].join("\n");
    const before = [await count("material"), await count("materialCategory")];
    const r = await run("materials", csv);
    expect(r.committed).toBe(false);
    expect(r.counts).toEqual({ create: 1, skip: 1, error: 4 });
    expect(r.rows.map((x) => [x.line, x.action])).toEqual([[2, "CREATE"], [3, "SKIP"], [4, "ERROR"], [5, "ERROR"], [6, "ERROR"], [7, "ERROR"]]);
    expect(r.rows[1].message).toMatch(/SKU RICE-1 already exists/);
    expect(r.rows[2].message).toMatch(/name is required/);
    expect(r.rows[3].message).toMatch(/unit "furlongs" is not one of your units/);
    expect(r.rows[4].message).toMatch(/tax %: "abc" is not a number/);
    expect(r.rows[5].message).toMatch(/vendor "Nobody Ltd" does not exist.*perishable: use yes or no/);
    expect(r.columns.ignored).toEqual(["Weird column"]);
    expect(r.columns.used).toEqual(expect.arrayContaining(["name", "sku", "brand", "category", "baseunit", "taxpct", "reorderlevel", "parlevel", "perishable", "preferredvendor"]));
    expect(r.newCategories).toEqual(["Grains"]);
    expect(r.note).toMatch(/Fix the lines marked as errors/);
    expect([await count("material"), await count("materialCategory")]).toEqual(before); // a check writes nothing
  });

  it("B1 headers are matched forgivingly (case, spaces, common names), numbers may carry ₹ and thousands separators", async () => {
    const csv = `Material Name;Item Code;UOM;Reorder At;Minimum Stock\nSaffron;SAF-1;${kgCode};"1,000";₹2\n`;
    const r = await run("materials", csv);
    expect(r.counts).toEqual({ create: 1, skip: 0, error: 0 });
    expect(r.columns.used).toEqual(expect.arrayContaining(["name", "sku", "baseunit", "reorderlevel", "minstock"]));
  });
});

describe("B2. committing", () => {
  it("B2 one bad row stops everything: nothing is created, every problem is listed", async () => {
    const before = [await count("material"), await count("materialCategory")];
    const r = await run("materials", `Name,Unit,Category\nGood Item,${kgCode},Spices\nBad Item,nope,Spices\n`, true);
    expect(r.committed).toBe(false);
    expect(r.counts.error).toBe(1);
    expect(r.note).toMatch(/Nothing was imported/);
    expect([await count("material"), await count("materialCategory")]).toEqual(before);
  });

  it("B2 a clean file creates the materials and the categories it needs, generates SKUs, validates like the form, and audits once", async () => {
    const csv = [
      "Name,SKU,Brand,Category,Unit,Purchase unit,GST %,Min stock,Reorder level,Par level,Perishable,Track batch,Vendor",
      `Turmeric,TUR-1,Everest,spices,${kgCode},,5,2,5,20,no,no,Fresh Farms`,
      `Cumin,,Everest,Spices,${kgCode},,5,1,3,,no,no,`,
      `Coriander,COR-1,,Fresh Herbs,Pieces,${pcsCode},0,,,,yes,yes,`,
    ].join("\n");
    const r = await run("materials", csv, true);
    expect(r).toMatchObject({ committed: true, counts: { create: 3, skip: 0, error: 0 }, note: "Imported." });
    expect(r.newCategories.sort()).toEqual(["Fresh Herbs", "spices"].sort());
    const made = await prisma.material.findMany({ where: { organizationId: env.orgId, name: { in: ["Turmeric", "Cumin", "Coriander"] } }, include: { category: true } });
    const by = Object.fromEntries(made.map((m) => [m.name, m]));
    expect(by.Turmeric).toMatchObject({ sku: "TUR-1", brand: "Everest", baseUnitId: kg });
    expect(Number(by.Turmeric.reorderLevel)).toBe(5);
    expect(Number(by.Turmeric.parLevel)).toBe(20);
    expect(by.Turmeric.preferredVendorId).toBeTruthy();
    expect(by.Cumin.sku).toMatch(/^RM-\d{4}$/); // generated
    expect(by.Coriander).toMatchObject({ perishable: true, trackBatch: true });
    // "spices" and "Spices" in the file are one category.
    expect(by.Turmeric.categoryId).toBe(by.Cumin.categoryId);
    expect(await prisma.materialCategory.count({ where: { organizationId: env.orgId, name: { in: ["spices", "Spices"] } } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: env.orgId, entityType: "BulkImport" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: env.orgId, entityType: "Material", entityId: by.Turmeric.id, action: "CREATE" } })).toBe(1);
  });

  it("B2 importing the same file again creates nothing and says so (safe to repeat)", async () => {
    const csv = `Name,SKU,Unit\nIdempotent One,IDM-1,${kgCode}\nIdempotent Two,IDM-2,${kgCode}\n`;
    expect((await run("materials", csv, true)).counts.create).toBe(2);
    const n = await count("material");
    const again = await run("materials", csv, true);
    expect(again).toMatchObject({ committed: false, counts: { create: 0, skip: 2, error: 0 }, note: "Nothing to import: every row already exists." });
    expect(await count("material")).toBe(n);
    // With no SKU in the file, the name is what identifies a row.
    const noSku = `Name,Unit\nNamed Only,${kgCode}\n`;
    expect((await run("materials", noSku, true)).counts.create).toBe(1);
    expect((await run("materials", noSku, true)).counts).toEqual({ create: 0, skip: 1, error: 0 });
  });

  it("B2 duplicates inside the file are errors that name the other line; par below reorder is refused", async () => {
    const r = await run("materials", `Name,SKU,Unit,Reorder level,Par level\nDup A,DUP-1,${kgCode},,\nDup B,DUP-1,${kgCode},,\nLow Par,LP-1,${kgCode},10,5\nSame,,${kgCode},,\nSame,,${kgCode},,\n`);
    expect(r.rows[1].message).toMatch(/SKU DUP-1 is already on line 2/);
    expect(r.rows[2].message).toMatch(/par level cannot be below the reorder level/);
    expect(r.rows[4].message).toMatch(/"Same" is already on line 5/);
  });
});

describe("B3. vendors", () => {
  it("B3 new vendors start awaiting approval; existing names are skipped; GSTIN, nature of supply and credit are checked", async () => {
    const csv = [
      "Vendor,Company,Phone,Email,GSTIN,Terms,Credit limit,Category,Nature of supply",
      "Dairy Direct,Dairy Direct Pvt Ltd,9876543210,sales@dairy.test,27AAPFU0939F1ZV,NET15,50000,Dairy,goods",
      "Fresh Farms,,,,,,,,",
      "Bad GST,,,,NOT-A-GSTIN,,,,",
      "Odd Supply,,,,,,,,widgets",
      "Packaging Hub,,,,,,,Packaging,Goods and services",
    ].join("\n");
    const dry = await run("vendors", csv);
    expect(dry.counts).toEqual({ create: 2, skip: 1, error: 2 });
    expect(dry.rows[3].message).toMatch(/nature of supply "widgets"/);
    expect(dry.rows[2].message).toMatch(/gstin/i);
    expect(await prisma.vendor.count({ where: { organizationId: env.orgId, name: "Dairy Direct" } })).toBe(0);
    const ok = await run("vendors", [csv.split("\n")[0], csv.split("\n")[1], csv.split("\n")[2], csv.split("\n")[5]].join("\n"), true);
    expect(ok).toMatchObject({ committed: true, counts: { create: 2, skip: 1, error: 0 } });
    expect(ok.note).toMatch(/awaiting approval/);
    const dd = await prisma.vendor.findFirstOrThrow({ where: { organizationId: env.orgId, name: "Dairy Direct" } });
    expect(dd).toMatchObject({ status: "PENDING", active: false, category: "Dairy", natureOfSupply: "GOODS", paymentTerms: "NET15", companyName: "Dairy Direct Pvt Ltd" });
    expect(Number(dd.creditLimit)).toBe(50000);
    expect((await prisma.vendor.findFirstOrThrow({ where: { organizationId: env.orgId, name: "Packaging Hub" } })).natureOfSupply).toBe("BOTH");
  });
});

describe("B4. who may, and what a file may be", () => {
  it("B4 only organization-wide managers of master data import; another restaurant's rows never count as existing", async () => {
    await expect(run("materials", `Name,Unit\nX,${kgCode}\n`, false, env.cashier)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run("materials", `Name,Unit\nX,${kgCode}\n`, false, env.manager)).rejects.toBeInstanceOf(ForbiddenError); // an outlet manager is not org-wide
    await expect(run("vendors", "Name\nX\n", true, member(env.orgId, "CAPTAIN", env.outletA))).rejects.toBeInstanceOf(ForbiddenError);
    const other = await makeEnv("Gbj");
    await prisma.material.create({ data: { organizationId: other.orgId, sku: "SHARED-1", name: "Shared", baseUnitId: (await prisma.unit.create({ data: { organizationId: other.orgId, code: `u${uniq()}`, name: "u", kind: "COUNT" } })).id } });
    const r = await run("materials", `Name,SKU,Unit\nShared,SHARED-1,${kgCode}\n`);
    expect(r.counts).toEqual({ create: 1, skip: 0, error: 0 });
  });

  it("B4 a file that cannot be read says why; limits hold", async () => {
    await expect(run("materials", "")).rejects.toThrow();
    await expect(run("materials", "Name,Unit\n")).rejects.toThrow(/header but no rows/);
    await expect(run("materials", 'Name,Unit\n"open,1\n')).rejects.toThrow(/never closed/);
    await expect(run("materials", "Name,Name\nA,B\n")).rejects.toThrow(/appears twice/);
    await expect(run("materials", "Name,Unit\n" + `X,${kgCode}\n`.repeat(IMPORT_MAX_ROWS + 1))).rejects.toBeInstanceOf(ValidationError);
    await expect(run("materials", "A".repeat(900_001))).rejects.toThrow(/too large/);
    // No unit column at all is told once per row, not silently accepted.
    const r = await run("materials", "Name\nNo Unit Column\n");
    expect(r.rows[0].message).toMatch(/no unit column/);
    await expect(run("plants" as never, "Name\nX\n")).rejects.toThrow();
  });
});
