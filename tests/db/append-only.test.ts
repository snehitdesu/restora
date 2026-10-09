/**
 * The database itself refuses to change or remove audit and ledger rows (audit SE-08, IN-01): UPDATE and DELETE on AuditLog and
 * InventoryLedger abort whoever sends them (the ORM, a raw statement), on SQLite and on PostgreSQL (which also refuses
 * TRUNCATE). Inserting is untouched, corrections are new rows, and the readiness check notices if a trigger ever goes missing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { APPEND_ONLY_TABLES, SQLITE_GUARD_NAMES, SQLITE_GUARD_SQL, PG_GUARD_NAMES, missingAppendOnlyGuards, withAppendOnlyGuardsOff } from "@/server/db/appendOnly";
import { appendLedger, currentQuantity } from "@/server/services/inventory";
import { writeAudit } from "@/server/audit/log";
import { checkMigrations, resetReadinessCache } from "@/server/ops/readiness";
import { makeEnv, uniq, type Env } from "../domain/growthSupport";

const pg = (process.env.DATABASE_URL ?? "").startsWith("postgres");
let env: Env;
let materialId: string;
let ledgerId: string;
let auditId: string;

beforeAll(async () => {
  env = await makeEnv("Gao");
  const unit = await prisma.unit.create({ data: { organizationId: env.orgId, code: `kg${uniq()}`, name: "kg", kind: "WEIGHT" } });
  materialId = (await prisma.material.create({ data: { organizationId: env.orgId, sku: `AO-${uniq()}`, name: "Flour", baseUnitId: unit.id } })).id;
  ledgerId = (await prisma.inventoryLedger.create({ data: { organizationId: env.orgId, outletId: env.outletA, materialId, txnType: "OPENING_BALANCE", qty: 10, rate: 5, amount: 50, sourceRef: `ao-${uniq()}` } })).id;
  auditId = (await prisma.auditLog.create({ data: { organizationId: env.orgId, action: "CREATE", entityType: "AppendOnlyProbe", entityId: uniq() } })).id;
}, 60000);
afterAll(async () => { await prisma.$disconnect(); });

// What the database says when a statement is refused (the message differs by engine and, for the ORM, Prisma rewrites it).
const REFUSED = /is append-only: (a row cannot be (changed|removed)|(UPDATE|DELETE|TRUNCATE) is not allowed)/;

describe("A1. the database refuses to rewrite history", () => {
  it("A1 an audit row cannot be changed or removed, through the ORM or a raw statement", async () => {
    await expect(prisma.auditLog.update({ where: { id: auditId }, data: { action: "VOID" } })).rejects.toThrow();
    await expect(prisma.auditLog.updateMany({ where: { id: auditId }, data: { entityType: "x" } })).rejects.toThrow();
    await expect(prisma.auditLog.delete({ where: { id: auditId } })).rejects.toThrow();
    await expect(prisma.auditLog.deleteMany({ where: { organizationId: env.orgId } })).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET "action" = 'VOID' WHERE "id" = '${auditId}'`)).rejects.toThrow(REFUSED);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "id" = '${auditId}'`)).rejects.toThrow(REFUSED);
    const row = await prisma.auditLog.findUniqueOrThrow({ where: { id: auditId } });
    expect(row.action).toBe("CREATE");
    expect(row.entityType).toBe("AppendOnlyProbe");
  });

  it("A1 a stock ledger row cannot be changed or removed", async () => {
    await expect(prisma.inventoryLedger.update({ where: { id: ledgerId }, data: { qty: 999 } })).rejects.toThrow();
    await expect(prisma.inventoryLedger.delete({ where: { id: ledgerId } })).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`UPDATE "InventoryLedger" SET "qty" = 999 WHERE "id" = '${ledgerId}'`)).rejects.toThrow(REFUSED);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "InventoryLedger" WHERE "id" = '${ledgerId}'`)).rejects.toThrow(REFUSED);
    expect(Number((await prisma.inventoryLedger.findUniqueOrThrow({ where: { id: ledgerId } })).qty)).toBe(10);
  });

  it.skipIf(!pg)("A1 PostgreSQL also refuses TRUNCATE of either table", async () => {
    for (const t of APPEND_ONLY_TABLES) await expect(prisma.$executeRawUnsafe(`TRUNCATE "${t}"`)).rejects.toThrow(REFUSED);
  });

  it("A2 appending still works, and a correction is a new row that brings the balance right", async () => {
    const qty = async () => Number(await currentQuantity(prisma, env.owner, env.outletA, materialId));
    expect(await qty()).toBe(10);
    await prisma.$transaction((tx) => appendLedger(tx, env.owner, { outletId: env.outletA, materialId, txnType: "WASTAGE", magnitude: 4, rate: 5, sourceRef: `ao-w-${uniq()}` }));
    expect(await qty()).toBe(6);
    await prisma.$transaction((tx) => appendLedger(tx, env.owner, { outletId: env.outletA, materialId, txnType: "COUNT_ADJUSTMENT", direction: "IN", magnitude: 4, rate: 5, sourceRef: `ao-c-${uniq()}` }));
    expect(await qty()).toBe(10);
    expect(await prisma.inventoryLedger.count({ where: { organizationId: env.orgId, materialId } })).toBe(3); // nothing was rewritten
    await prisma.$transaction((tx) => writeAudit(tx, env.owner, { action: "UPDATE", entityType: "AppendOnlyProbe", entityId: auditId, before: { a: 1 }, after: { a: 2 } }));
  });

  it("A3 a statement that touches history inside a transaction takes the whole transaction down with it", async () => {
    const countBefore = await prisma.auditLog.count({ where: { organizationId: env.orgId } });
    await expect(prisma.$transaction(async (tx) => {
      await writeAudit(tx, env.owner, { action: "CREATE", entityType: "ShouldRollBack", entityId: uniq() });
      await tx.auditLog.deleteMany({ where: { id: auditId } });
    })).rejects.toThrow();
    expect(await prisma.auditLog.count({ where: { organizationId: env.orgId } })).toBe(countBefore);
  });
});

describe("A4. the guard is checked and can be lifted only for a disposable database", () => {
  it("A4 every trigger is present on the migrated test database, and readiness is still ready", async () => {
    expect(await missingAppendOnlyGuards(prisma)).toEqual([]);
    resetReadinessCache();
    expect(await checkMigrations(prisma, Date.now() + 10 * 60_000)).toBe("ok");
  });

  it("A4 the SQL kept in the application is the SQL the migration creates", () => {
    const migration = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20261021100000_append_only_rate_limit/migration.sql"), "utf8").replace(/\s+/g, " ");
    for (const sql of SQLITE_GUARD_SQL) expect(migration).toContain(sql.replace(/\s+/g, " ") + ";");
    const pgMigration = fs.readFileSync(path.join(process.cwd(), "prisma/postgres/migrations/20261021100000_append_only_rate_limit/migration.sql"), "utf8");
    for (const name of PG_GUARD_NAMES) expect(pgMigration).toContain(`"${name}"`);
    expect(SQLITE_GUARD_NAMES).toHaveLength(APPEND_ONLY_TABLES.length * 2);
  });
});

describe.skipIf(pg)("A5. lifting the guard on a disposable SQLite database (the demo seed and test fixtures do)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restora-append-only-"));
  const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
  const url = `file:${path.join(dir, "fresh.db").replace(/\\/g, "/")}`;
  let db: PrismaClient;

  beforeAll(async () => {
    execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate", "--accept-data-loss"], { stdio: "ignore", env: { ...process.env, DATABASE_URL: url } });
    db = new PrismaClient({ datasources: { db: { url } } });
    for (const sql of SQLITE_GUARD_SQL) await db.$executeRawUnsafe(sql);
  }, 120_000);
  afterAll(async () => { await db?.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });

  it("A5 inside the callback history can be wiped; afterwards the guard is back, even when the callback throws", async () => {
    await db.auditLog.create({ data: { organizationId: "o1", action: "CREATE", entityType: "T", entityId: "1" } });
    await expect(db.auditLog.deleteMany()).rejects.toThrow();
    expect(await missingAppendOnlyGuards(db)).toEqual([]);

    await withAppendOnlyGuardsOff(db, async () => {
      expect(await missingAppendOnlyGuards(db)).toHaveLength(SQLITE_GUARD_NAMES.length);
      await db.auditLog.deleteMany();
    });
    expect(await db.auditLog.count()).toBe(0);
    expect(await missingAppendOnlyGuards(db)).toEqual([]);

    await db.auditLog.create({ data: { organizationId: "o1", action: "CREATE", entityType: "T", entityId: "2" } });
    await expect(withAppendOnlyGuardsOff(db, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await missingAppendOnlyGuards(db)).toEqual([]);
    await expect(db.auditLog.deleteMany()).rejects.toThrow();
  });

  it("A5 readiness reports a missing trigger as a failed deploy", async () => {
    await db.$executeRawUnsafe(`DROP TRIGGER "AuditLog_append_only_delete"`);
    expect(await missingAppendOnlyGuards(db)).toEqual(["AuditLog_append_only_delete"]);
    await db.$executeRawUnsafe(SQLITE_GUARD_SQL[1]);
    expect(await missingAppendOnlyGuards(db)).toEqual([]);
  });
});
