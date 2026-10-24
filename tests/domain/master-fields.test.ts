/**
 * Brand on a material (MD-02), category and nature of supply on a vendor, cuisine tags on a menu item: stored, validated,
 * cleared, searched and audited like any other field.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { createMaterial, updateMaterial, listMaterials, createVendor, updateVendor, listVendors, getVendor } from "@/server/services/masterData";
import { createMenuItem, updateMenuItem } from "@/server/services/menu";
import { makeEnv, uniq, type Env } from "./growthSupport";

let env: Env;
let unit: string;

beforeAll(async () => {
  env = await makeEnv("Gmf");
  unit = (await prisma.unit.create({ data: { organizationId: env.orgId, code: `kg${uniq()}`, name: "Kilogram", kind: "WEIGHT" } })).id;
}, 60000);
afterAll(async () => { await prisma.$disconnect(); });

describe("F1. brand on a material", () => {
  it("F1 is stored, trimmed, found by search, changed and cleared, with before and after in the audit", async () => {
    const sku = `BR-${uniq()}`;
    const m = await createMaterial(env.owner, { sku, name: `Butter ${uniq()}`, baseUnitId: unit, brand: "  Amul  " });
    expect(m.brand).toBe("Amul");
    const found = await listMaterials(prisma, env.owner, { search: "amul" });
    expect(found.items.map((x) => x.id)).toContain(m.id);

    expect((await updateMaterial(env.owner, m.id, { brand: "Mother Dairy" })).brand).toBe("Mother Dairy");
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: env.orgId, entityType: "Material", entityId: m.id, action: "UPDATE" }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(audit?.before)).toContain("Amul");
    expect(JSON.stringify(audit?.after)).toContain("Mother Dairy");

    expect((await updateMaterial(env.owner, m.id, { brand: null })).brand).toBeNull();
    expect((await updateMaterial(env.owner, m.id, { name: `Butter renamed ${uniq()}` })).brand).toBeNull(); // untouched fields stay untouched
    await expect(updateMaterial(env.owner, m.id, { brand: "" })).rejects.toThrow();
    await expect(updateMaterial(env.owner, m.id, { brand: "x".repeat(61) })).rejects.toThrow();
  });

  it("F1 a material without a brand is fine", async () => {
    const m = await createMaterial(env.owner, { sku: `NB-${uniq()}`, name: `Salt ${uniq()}`, baseUnitId: unit });
    expect(m.brand).toBeNull();
  });
});

describe("F2. vendor category and nature of supply", () => {
  it("F2 are stored, validated, searched and cleared; the detail carries them", async () => {
    const v = await createVendor(env.owner, { name: `Dairy Co ${uniq()}`, category: "Dairy", natureOfSupply: "GOODS" });
    expect([v.category, v.natureOfSupply]).toEqual(["Dairy", "GOODS"]);
    expect((await listVendors(prisma, env.owner, { search: "dairy" })).items.map((x) => x.id)).toContain(v.id);
    expect(await getVendor(prisma, env.owner, v.id)).toMatchObject({ category: "Dairy", natureOfSupply: "GOODS", contacts: [] });
    await expect(updateVendor(env.owner, v.id, { natureOfSupply: "STUFF" as never })).rejects.toThrow();
    expect(await updateVendor(env.owner, v.id, { natureOfSupply: "BOTH", category: "Dairy & eggs" })).toMatchObject({ natureOfSupply: "BOTH", category: "Dairy & eggs" });
    expect(await updateVendor(env.owner, v.id, { natureOfSupply: null, category: null })).toMatchObject({ natureOfSupply: null, category: null });
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: env.orgId, entityType: "Vendor", entityId: v.id, action: "UPDATE" }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(audit?.before)).toContain("Dairy & eggs");
  });
});

describe("F3. cuisine tags on a menu item", () => {
  it("F3 are lower-cased, de-duplicated, limited and clearable", async () => {
    const item = await createMenuItem(env.owner, { name: `Masala Dosa ${uniq()}`, price: 120, taxPct: 5, cuisineTags: ["South-Indian", "breakfast", "breakfast"] });
    expect(item.cuisineTags).toBe("south-indian,breakfast");
    const same = await updateMenuItem(env.owner, item.id, { price: 130 });
    expect(same.cuisineTags).toBe("south-indian,breakfast"); // not mentioned: unchanged
    expect((await updateMenuItem(env.owner, item.id, { cuisineTags: ["snack"] })).cuisineTags).toBe("snack");
    expect((await updateMenuItem(env.owner, item.id, { cuisineTags: [] })).cuisineTags).toBeNull();
    await expect(updateMenuItem(env.owner, item.id, { cuisineTags: ["has space"] })).rejects.toThrow();
    await expect(updateMenuItem(env.owner, item.id, { cuisineTags: ["-leading"] })).rejects.toThrow();
    await expect(updateMenuItem(env.owner, item.id, { cuisineTags: Array.from({ length: 9 }, (_, i) => `t${i}`) })).rejects.toThrow();
    await expect(updateMenuItem(env.owner, item.id, { cuisineTags: ["x".repeat(25)] })).rejects.toThrow();
  });

  it("F3 only a role that manages the menu may set them", async () => {
    await expect(createMenuItem(env.cashier, { name: `Nope ${uniq()}`, price: 10, taxPct: 0, cuisineTags: ["a"] })).rejects.toThrow();
  });
});
