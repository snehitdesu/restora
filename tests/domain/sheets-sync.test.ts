/**
 * Group 5 Google Sheets sync against the real services and database, with the
 * in-memory sheet standing in for Google (the Google client's own contract is in
 * tests/integrations/group5-adapters.test.ts).
 *
 *  H1 a first sync fills an empty sheet; a second changes nothing
 *  H2 the team edits a cell: pulled through the master-data service (audited)
 *  H3 RESTORA edits a material: pushed to the sheet
 *  H4 both edit the same row differently: a conflict, nothing overwritten; settled either way
 *  H5 invalid edits are reported per row and never applied
 *  H6 repeated SKUs, unknown SKUs and a deleted row
 *  H7 a tab that is not ours is never overwritten
 *  H8 the sheet changed while the sync ran: nothing is written
 *  H9 a running sync blocks a second; a stale lease is taken over
 *  H10 provider failures leave no partial state
 *  H11 push-only sheets never pull; authorization; tenants; connection rules
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { createMaterial, updateMaterial } from "@/server/services/masterData";
import { upsertIntegration } from "@/server/services/integrations";
import { listSheetConflicts, mockSheetFor, resolveSheetConflict, runSheetsSync } from "@/server/services/sheetsSync";
import { recordPurchaseReceipt } from "@/server/services/inventory";
import { IntegrationError, UnauthorizedIntegrationError } from "@/integrations/http";

const RUN = Date.now().toString(36);
const TAB = "RESTORA Materials";
const STOCK_TAB = (code: string) => `RESTORA Stock ${code}`.slice(0, 51);
const SALES_TAB = (code: string) => `RESTORA Daily sales ${code}`.slice(0, 51);
let orgId: string, A: string, kg: string;
let sys: AccessContext, outletCode: string;
let owner: AccessContext, manager: AccessContext, admin: AccessContext, foreign: AccessContext;
let connId: string;
let flour: string, sugar: string, salt: string, oil: string;
const sku = (s: string) => `${s}-${RUN}`.toUpperCase();
const member = (id: string, role: string, outletId: string): AccessContext => ({ userId: id, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });
const sheet = () => mockSheetFor(connId);
const rowOf = async (s: string) => (await sheet().read(TAB)).findIndex((r) => r[0] === s);
const cell = async (s: string, col: number) => (await sheet().read(TAB))[await rowOf(s)]?.[col];
const run = (datasets: Array<"MATERIALS" | "STOCK" | "VENDOR_DUES" | "DAILY_SALES"> = ["MATERIALS"], extra: Record<string, unknown> = {}) => runSheetsSync(owner, { connectionId: connId, datasets, ...extra } as never);
const materials = async () => new Map((await prisma.material.findMany({ where: { organizationId: orgId } })).map((m) => [m.sku, m]));
const num = (v: unknown) => Number(v);

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Sheets Org ${RUN}` } })).id;
  outletCode = `SH${RUN}`;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: outletCode, name: "Sheets A" } })).id;
  sys = systemContext(orgId, [A]);
  owner = { ...systemContext(orgId, [A]), userId: `owner-${RUN}`, roles: ["OWNER"], orgRoles: ["OWNER"], isOrgWide: true };
  manager = member(`mgr-${RUN}`, "MANAGER", A);
  admin = member(`adm-${RUN}`, "ADMIN", A); // integration.manage but not org-wide
  const fOrg = (await prisma.organization.create({ data: { name: `Sheets Foreign ${RUN}` } })).id;
  foreign = { ...systemContext(fOrg, [(await prisma.outlet.create({ data: { organizationId: fOrg, code: `SHF${RUN}`, name: "F" } })).id]), userId: `fo-${RUN}`, roles: ["OWNER"], orgRoles: ["OWNER"], isOrgWide: true };
  kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
  const mk = async (s: string, name: string, reorderLevel: number, minStock: number, parLevel?: number) => (await createMaterial(owner, { sku: sku(s), name: `${name} ${RUN}`, baseUnitId: kg, reorderLevel, minStock, parLevel })).id;
  flour = await mk("flour", "Flour", 10, 5, 40);
  sugar = await mk("sugar", "Sugar", 4, 2);
  salt = await mk("salt", "Salt", 1.5, 0.5, 6);
  oil = await mk("oil", "Oil", 8, 3, 20);
  connId = (await upsertIntegration(owner, { kind: "SHEETS", provider: "mock" })).id;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("H1. first sync", () => {
  it("H1 an empty sheet is filled from RESTORA (header, one row per material, numbers as numbers); a second sync changes nothing", async () => {
    await expect(upsertIntegration(owner, { kind: "SHEETS", provider: "google_sheets", config: { spreadsheetId: "not an id" } })).rejects.toThrow(/Invalid spreadsheet settings/);
    await expect(upsertIntegration(owner, { kind: "SHEETS", provider: "google_sheets", credentials: { clientEmail: "nope", privateKey: "x" } })).rejects.toThrow(/Invalid Google service account credentials/);
    await expect(upsertIntegration(owner, { kind: "SHEETS", provider: "dropbox" })).rejects.toThrow(/Unsupported spreadsheet provider/);
    await expect(upsertIntegration(owner, { kind: "SHEETS", provider: "mock", outletId: A })).rejects.toThrow(/organization-wide/);

    const r = await run();
    expect(r).toMatchObject({ provider: "mock", mode: "MOCK" });
    expect(r.results[0]).toMatchObject({ dataset: "MATERIALS", tab: TAB, written: true, pulled: 0, conflicts: 0, invalid: [], rows: 4, pushed: 4 });
    const grid = await sheet().read(TAB);
    expect(grid[0]).toEqual(["SKU", "Name (read-only)", "Unit (read-only)", "Reorder level", "Minimum stock", "PAR level (order up to)"]);
    expect(grid).toHaveLength(5);
    expect(grid.find((x) => x[0] === sku("salt"))).toEqual([sku("salt"), `Salt ${RUN}`, `kg${RUN}`, "1.5", "0.5", "6"]);
    expect(grid.find((x) => x[0] === sku("sugar"))![5]).toBe(""); // no PAR level set

    const again = await run();
    expect(again.results[0]).toMatchObject({ written: true, pulled: 0, pushed: 0, unchanged: 4, conflicts: 0 });
    expect(await prisma.sheetSyncRow.count({ where: { organizationId: orgId, dataset: "MATERIALS" } })).toBe(4);
    expect(await prisma.sheetSyncRow.count({ where: { organizationId: orgId, dataset: "LOCK" } })).toBe(0); // the lease is released
  });
});

describe("H2/H3. one side changes", () => {
  it("H2 the team edits a cell: it is applied through the master-data service, audited, and the sheet keeps the team's value", async () => {
    sheet().edit(TAB, await rowOf(sku("flour")), 3, "12");
    sheet().edit(TAB, await rowOf(sku("flour")), 5, "50");
    const r = (await run()).results[0];
    expect(r).toMatchObject({ pulled: 1, pushed: 0, conflicts: 0, invalid: [] });
    const m = (await materials()).get(sku("flour"))!;
    expect([num(m.reorderLevel), num(m.minStock), num(m.parLevel)]).toEqual([12, 5, 50]);
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, entityType: "Material", entityId: flour, action: "UPDATE" } })).toBe(1);
    expect(await cell(sku("flour"), 3)).toBe("12");
    expect((await run()).results[0]).toMatchObject({ pulled: 0, pushed: 0, unchanged: 4 }); // settled
  });

  it("H3 RESTORA edits a material: the next sync writes it to the sheet", async () => {
    await updateMaterial(owner, sugar, { reorderLevel: 6, minStock: 3, parLevel: 18 });
    const r = (await run()).results[0];
    expect(r).toMatchObject({ pulled: 0, pushed: 1, conflicts: 0 });
    expect(await cell(sku("sugar"), 3)).toBe("6");
    expect(await cell(sku("sugar"), 5)).toBe("18");
    // a name change in RESTORA reaches the sheet too (name and unit belong to RESTORA, whatever the team types there)
    sheet().edit(TAB, await rowOf(sku("sugar")), 1, "Hand-typed name");
    await run();
    expect(await cell(sku("sugar"), 1)).toBe(`Sugar ${RUN}`);
  });
});

describe("H4. conflicts", () => {
  it("H4 both sides changed the same row differently: nothing is overwritten; a person settles it, either way", async () => {
    await updateMaterial(owner, salt, { reorderLevel: 2 });
    sheet().edit(TAB, await rowOf(sku("salt")), 3, "3");
    await updateMaterial(owner, oil, { minStock: 4 });
    sheet().edit(TAB, await rowOf(sku("oil")), 4, "3.5");
    const r = (await run()).results[0];
    expect(r).toMatchObject({ pulled: 0, conflicts: 2 });
    const ms = await materials();
    expect(num(ms.get(sku("salt"))!.reorderLevel)).toBe(2); // RESTORA's value stays
    expect(await cell(sku("salt"), 3)).toBe("3"); // the team's value stays
    const open = await listSheetConflicts(prisma, owner, { status: "OPEN" });
    expect(open.map((c) => c.key).sort()).toEqual([sku("oil"), sku("salt")].sort());
    const saltC = open.find((c) => c.key === sku("salt"))!;
    expect(saltC).toMatchObject({ restora: { reorderLevel: "2", minStock: "0.5", parLevel: "6" }, sheet: { reorderLevel: "3", minStock: "0.5", parLevel: "6" } });
    // running again does not pile up duplicates
    await run();
    expect(await prisma.sheetSyncConflict.count({ where: { organizationId: orgId, status: "OPEN" } })).toBe(2);

    // Keep RESTORA: the next sync writes RESTORA's value over the sheet cell.
    await expect(resolveSheetConflict(manager, saltC.id, "RESTORA")).rejects.toBeInstanceOf(ForbiddenError);
    expect(await resolveSheetConflict(owner, saltC.id, "RESTORA")).toMatchObject({ status: "RESOLVED" });
    expect((await run()).results[0]).toMatchObject({ pushed: 1, conflicts: 1 }); // salt pushed; oil still open
    expect(await cell(sku("salt"), 3)).toBe("2");
    // Use the sheet: applied to RESTORA now, through the same validation.
    const oilC = (await listSheetConflicts(prisma, owner, { status: "OPEN" }))[0];
    await resolveSheetConflict(owner, oilC.id, "SHEET");
    expect(num((await materials()).get(sku("oil"))!.minStock)).toBe(3.5);
    await expect(resolveSheetConflict(owner, oilC.id, "SHEET")).rejects.toThrow(/already resolved/);
    expect((await run()).results[0]).toMatchObject({ pulled: 0, pushed: 0, conflicts: 0 });
    expect(await listSheetConflicts(prisma, owner, { status: "OPEN" })).toEqual([]);
    expect((await listSheetConflicts(prisma, owner, { status: "RESOLVED" })).length).toBe(2);
    await expect(resolveSheetConflict(foreign, oilC.id, "SHEET")).rejects.toBeInstanceOf(NotFoundError);
    expect(await listSheetConflicts(prisma, foreign)).toEqual([]);
  });

  it("H4b a sheet that already holds different numbers before the first sync is a conflict, never silently replaced", async () => {
    const org2 = (await prisma.organization.create({ data: { name: `Sheets 2 ${RUN}` } })).id;
    const o2 = (await prisma.outlet.create({ data: { organizationId: org2, code: `S2${RUN}`, name: "S2" } })).id;
    const ctx2: AccessContext = { ...systemContext(org2, [o2]), userId: `o2-${RUN}`, roles: ["OWNER"], orgRoles: ["OWNER"], isOrgWide: true };
    const u2 = (await prisma.unit.create({ data: { organizationId: org2, code: `kg2${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
    await createMaterial(ctx2, { sku: "RM-9", name: "Rice", baseUnitId: u2, reorderLevel: 5, minStock: 1 });
    const c2 = (await upsertIntegration(ctx2, { kind: "SHEETS", provider: "mock" })).id;
    mockSheetFor(c2).tabs.set(TAB, [["SKU", "Name (read-only)", "Unit (read-only)", "Reorder level", "Minimum stock", "PAR level (order up to)"], ["RM-9", "Rice", "kg", "9", "1", ""]]);
    const r = (await runSheetsSync(ctx2, { connectionId: c2, datasets: ["MATERIALS"] })).results[0];
    expect(r).toMatchObject({ pulled: 0, pushed: 0, conflicts: 1 });
    expect(num((await prisma.material.findFirstOrThrow({ where: { organizationId: org2, sku: "RM-9" } })).reorderLevel)).toBe(5);
    expect((await mockSheetFor(c2).read(TAB))[1][3]).toBe("9");
  });
});

describe("H5/H6/H7. bad input", () => {
  it("H5 invalid edits (text, negative, PAR below reorder, empty required cell) are reported per row and never applied", async () => {
    const before = (await materials()).get(sku("flour"))!;
    const row = await rowOf(sku("flour"));
    sheet().edit(TAB, row, 3, "twelve");
    sheet().edit(TAB, await rowOf(sku("sugar")), 3, "-1");
    sheet().edit(TAB, await rowOf(sku("oil")), 5, "1"); // PAR 1 < reorder 8
    sheet().edit(TAB, await rowOf(sku("salt")), 4, "");
    const r = (await run()).results[0];
    expect(r.pulled).toBe(0);
    expect(r.invalid.map((i) => i.key).sort()).toEqual([sku("flour"), sku("oil"), sku("salt"), sku("sugar")].sort());
    expect(r.invalid.find((i) => i.key === sku("flour"))!.reason).toMatch(/Reorder level must be a plain number/);
    expect(r.invalid.find((i) => i.key === sku("sugar"))!.reason).toMatch(/Reorder level must be a plain number/);
    expect(r.invalid.find((i) => i.key === sku("oil"))!.reason).toMatch(/PAR level \(order up to\) cannot be below/);
    expect(r.invalid.find((i) => i.key === sku("salt"))!.reason).toMatch(/Minimum stock is empty/);
    expect(num((await materials()).get(sku("flour"))!.reorderLevel)).toBe(num(before.reorderLevel));
    expect(await cell(sku("flour"), 3)).toBe("twelve"); // the team's cell is left for them to fix
    // fix them
    sheet().edit(TAB, row, 3, "12");
    sheet().edit(TAB, await rowOf(sku("sugar")), 3, "6");
    sheet().edit(TAB, await rowOf(sku("oil")), 5, "20");
    sheet().edit(TAB, await rowOf(sku("salt")), 4, "0.5");
    expect((await run()).results[0]).toMatchObject({ invalid: [], conflicts: 0, pulled: 0 });
  });

  it("H6 repeated SKUs are skipped, unknown SKUs are left alone, a deleted row comes back", async () => {
    const g = await sheet().read(TAB);
    g.push([sku("flour"), "dup", "kg", "99", "99", ""]);
    g.push(["RM-UNKNOWN", "Mystery", "kg", "1", "1", ""]);
    const del = g.findIndex((x, i) => i > 0 && x[0] === sku("oil"));
    g.splice(del, 1);
    sheet().tabs.set(TAB, g);
    const r = (await run()).results[0];
    expect(r.duplicateKeys).toEqual([sku("flour")]);
    expect(r.unknownKeys).toEqual(["RM-UNKNOWN"]);
    expect(num((await materials()).get(sku("flour"))!.reorderLevel)).toBe(12); // the repeated row's 99 was not applied
    expect(await rowOf(sku("oil"))).toBeGreaterThan(0); // RESTORA restored the deleted row
    expect(await rowOf("RM-UNKNOWN")).toBeGreaterThan(0); // the team's own row was not deleted
    expect((await materials()).has("RM-UNKNOWN")).toBe(false); // and no material was created from it
    // tidy the sheet for the next tests: one flour row, no mystery row
    const g2 = await sheet().read(TAB);
    const firstFlour = g2.findIndex((x) => x[0] === sku("flour"));
    sheet().tabs.set(TAB, g2.filter((x, i) => x[0] !== "RM-UNKNOWN" && !(x[0] === sku("flour") && i !== firstFlour)));
  });

  it("H7 a tab that is not ours is never overwritten", async () => {
    // (one SHEETS connection per provider per organization: the foreign content goes into this connection's sheet for a moment)
    const m = sheet();
    const saved = m.tabs.get(TAB)!.map((r) => [...r]);
    const mine = [["Date", "Amount"], ["2026-10-01", "100"]];
    m.tabs.set(TAB, mine);
    const r = (await run()).results[0];
    expect(r.error).toMatch(/^REFUSED: .*already holds other data/);
    expect(r.written).toBe(false);
    expect(m.tabs.get(TAB)).toEqual(mine);
    m.tabs.set(TAB, saved);
    m.tabs.set("RESTORA Vendor dues", [["Notes"], ["keep me"]]);
    const v = (await run(["VENDOR_DUES"])).results[0];
    expect(v.error).toMatch(/^REFUSED:/);
    expect(m.tabs.get("RESTORA Vendor dues")).toEqual([["Notes"], ["keep me"]]);
    m.tabs.delete("RESTORA Vendor dues");
  });
});

describe("H8/H9/H10. races and failures", () => {
  it("H8 the sheet is edited while the sync runs: nothing is written, the edit survives and is pulled next time", async () => {
    const m = sheet();
    const orig = m.read.bind(m);
    let reads = 0;
    m.read = async (tab: string) => { reads++; if (reads === 2) m.edit(TAB, await rowOf(sku("sugar")), 4, "2.5"); return orig(tab); };
    await updateMaterial(owner, flour, { minStock: 6 }); // something that WOULD be pushed
    const r = (await run()).results[0];
    m.read = orig;
    expect(r, JSON.stringify(r)).toMatchObject({ written: false, stoppedBecauseSheetChanged: true });
    expect(await cell(sku("sugar"), 4)).toBe("2.5"); // the person's edit is intact
    expect(await cell(sku("flour"), 4)).toBe("5"); // RESTORA's change was not pushed over a moving sheet
    const next = (await run()).results[0];
    expect(next).toMatchObject({ pulled: 1, pushed: 1, conflicts: 0 });
    expect(num((await materials()).get(sku("sugar"))!.minStock)).toBe(2.5);
    expect(await cell(sku("flour"), 4)).toBe("6");
  });

  it("H9 a running sync blocks a second one; a lease left by a crashed run (older than 5 minutes) is taken over", async () => {
    const lease = { organizationId: orgId, dataset: "LOCK", rowKey: "MATERIALS:-" };
    await prisma.sheetSyncRow.create({ data: { ...lease, syncedHash: "other-run", syncedAt: new Date() } });
    const blocked = (await run()).results[0];
    expect(blocked.error).toMatch(/^REFUSED: A sync of this sheet is already running/);
    expect(blocked.written).toBe(false);
    await prisma.sheetSyncRow.update({ where: { organizationId_dataset_rowKey: lease }, data: { syncedAt: new Date(Date.now() - 6 * 60_000) } });
    const taken = (await run()).results[0];
    expect(taken.error, JSON.stringify(taken)).toBeUndefined();
    expect(taken.written).toBe(true);
    expect(await prisma.sheetSyncRow.count({ where: { ...lease } })).toBe(0);
  });

  it("H10 a provider that is down or refuses the login leaves no partial state; the connection records the failure", async () => {
    await updateMaterial(owner, salt, { minStock: 0.75 });
    const snapshot = JSON.stringify(await sheet().read(TAB));
    const bases = JSON.stringify(await prisma.sheetSyncRow.findMany({ where: { organizationId: orgId }, orderBy: { rowKey: "asc" } }));
    sheet().failNext = new IntegrationError("UNAVAILABLE", "Provider returned 503", true, 503);
    const down = (await run()).results[0];
    expect(down.error).toMatch(/^UNAVAILABLE:/);
    expect(down.written).toBe(false);
    expect(JSON.stringify(await sheet().read(TAB))).toBe(snapshot);
    expect(JSON.stringify(await prisma.sheetSyncRow.findMany({ where: { organizationId: orgId }, orderBy: { rowKey: "asc" } }))).toBe(bases);
    let conn = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connId } });
    expect(conn.lastFailureAt).not.toBeNull();

    sheet().failNext = new UnauthorizedIntegrationError("Google Sheets refused the credentials (403)", 403);
    expect((await run()).results[0].error).toMatch(/^UNAUTHORIZED:/);
    const ok = (await run()).results[0]; // it recovers by itself: the change is still waiting
    expect(ok, JSON.stringify(ok)).toMatchObject({ written: true, pushed: 1 });
    expect(await cell(sku("salt"), 4)).toBe("0.75");
    conn = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connId } });
    expect(conn.lastError).toBeNull();
  });
});

describe("H11. push-only sheets, authorization, tenants", () => {
  it("H11 stock, vendor dues and daily sales are written but never pulled; stock values only for those who may see costs", async () => {
    await recordPurchaseReceipt(sys, { outletId: A, materialId: flour, quantity: 20, rate: 40, sourceRef: `sh:${RUN}:1` });
    const r = await run(["STOCK", "VENDOR_DUES", "DAILY_SALES"], { outletId: A });
    expect(r.results.map((x) => [x.dataset, x.written, x.error ?? null]), JSON.stringify(r.results)).toEqual([["STOCK", true, null], ["VENDOR_DUES", true, null], ["DAILY_SALES", true, null]]);
    const stock = await sheet().read(STOCK_TAB(outletCode));
    expect(stock[0]).toEqual(["SKU", "Name", "Unit", "On hand", "Reorder level", "Status", "Average cost", "Value"]);
    const flourRow = stock.find((x) => x[0] === sku("flour"))!;
    expect([flourRow[3], flourRow[6], flourRow[7]]).toEqual(["20", "40", "800"]);
    expect((await sheet().read("RESTORA Vendor dues"))[0]).toEqual(["Vendor", "Open bills", "Billed", "Paid", "Due", "Overdue"]);
    expect((await sheet().read(SALES_TAB(outletCode)))[0]).toEqual(["Date", "Orders", "Covers", "Gross sales", "Discounts", "Taxes", "Total", "Refunds", "Net sales"]);
    // edits in a push-only sheet are ignored by the next sync (it rewrites them) and reach no material
    sheet().edit(STOCK_TAB(outletCode), 1, 3, "99999");
    await run(["STOCK"], { outletId: A });
    expect(num((await prisma.inventoryLedger.aggregate({ where: { organizationId: orgId, materialId: flour }, _sum: { qty: true } }))._sum.qty)).toBe(20);
  });

  it("H11b only integration.manage; only an org-wide role pulls; another organization has no such connection; the outlet must exist", async () => {
    await expect(runSheetsSync(manager, { connectionId: connId, datasets: ["MATERIALS"] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(runSheetsSync(foreign, { connectionId: connId, datasets: ["MATERIALS"] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(runSheetsSync(owner, { connectionId: connId, datasets: ["STOCK"] })).rejects.toBeInstanceOf(ValidationError);
    await expect(runSheetsSync(owner, { connectionId: connId, datasets: ["STOCK"], outletId: "no-such-outlet" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(runSheetsSync(owner, { connectionId: connId, datasets: [] })).rejects.toThrow();
    await expect(runSheetsSync(owner, { connectionId: connId, datasets: ["PASSWORDS"] } as never)).rejects.toThrow();
    // a non-org-wide admin may push but never changes materials: the edit is reported, not applied
    sheet().edit(TAB, await rowOf(sku("salt")), 3, "3");
    const r = (await runSheetsSync(admin, { connectionId: connId, datasets: ["MATERIALS"] })).results[0];
    expect(r.pulled).toBe(0);
    expect(r.invalid.find((i) => i.key === sku("salt"))!.reason).toMatch(/needs the master-data permission/);
    expect(num((await materials()).get(sku("salt"))!.reorderLevel)).toBe(2);
    // the audit trail names the actor and carries no cell values
    const audit = await prisma.auditLog.findMany({ where: { organizationId: orgId, entityType: "SheetsSync" } });
    expect(audit.length).toBeGreaterThan(5);
    expect(audit.every((a) => a.action === "INTEGRATION_SYNC")).toBe(true);
    expect(JSON.stringify(audit)).not.toMatch(/Hand-typed name|twelve/);
  });
});
