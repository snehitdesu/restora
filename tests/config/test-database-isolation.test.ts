/**
 * Every vitest run has its own SQLite file (prisma/test-<pid>.db). With one shared prisma/test.db, a second run started
 * in the same checkout (a targeted rerun next to a full suite) deleted and rebuilt it under the running suite, whose
 * next beforeAll failed with "The table `main.Organization` does not exist" (append-only and upsell, 2026-10-19).
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/server/db/client";
import { prepareSqliteTestDb, removeSqliteDb, sqliteTestDbPath, staleSqliteTestDbs } from "../../vitest.global-setup";

const pg = (process.env.DATABASE_URL ?? "").startsWith("postgres");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restora-test-db-"));
afterAll(async () => { await prisma.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(pg)("each run has its own test database", () => {
  it("this run's database is a file named for the run, never the shared prisma/test.db", () => {
    const own = process.env.VITEST_SQLITE_DB ?? "";
    expect(path.basename(own)).toMatch(/^test-\d+\.db$/);
    expect(path.dirname(own)).toBe(path.join(process.cwd(), "prisma"));
    expect(process.env.DATABASE_URL).toBe(`file:${own.replace(/\\/g, "/")}`);
    expect(sqliteTestDbPath(4242)).toBe(path.join(process.cwd(), "prisma", "test-4242.db"));
  });

  it("another run preparing its database leaves this run's data alone", async () => {
    const org = await prisma.organization.create({ data: { name: `Isolation ${Date.now()}` } });
    const other = sqliteTestDbPath(999_999_999, dir);
    try {
      prepareSqliteTestDb(other);
      expect(fs.existsSync(other)).toBe(true);
      expect(await prisma.organization.findUnique({ where: { id: org.id } })).not.toBeNull();
    } finally {
      removeSqliteDb(other);
    }
    expect(fs.existsSync(other)).toBe(false);
  }, 120_000);

  it("only the databases of runs that have exited are swept, never this run's or any other database", () => {
    for (const f of ["test-1.db", "test-1.db-journal", "test-2.db", `test-${process.pid}.db`, "test.db", "dev.db", "test-x.db"]) fs.writeFileSync(path.join(dir, f), "");
    expect(staleSqliteTestDbs(dir, (pid) => pid === 2 || pid === process.pid).map((f) => path.basename(f)).sort()).toEqual(["test-1.db", "test-1.db-journal"]);
    // The default liveness check sees this process as running.
    expect(staleSqliteTestDbs(dir).map((f) => path.basename(f))).not.toContain(`test-${process.pid}.db`);
  });
});
