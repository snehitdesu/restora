import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

// Recreate a clean test database and apply the schema before the suite runs.
//  - default: prisma/test-<pid>.db (SQLite), one file per vitest process, rebuilt with
//    `migrate deploy` and removed again when the run ends. One shared prisma/test.db let a
//    second run in the same checkout (a targeted rerun next to a full suite) delete and rebuild
//    it under the first run, whose next file then found no tables.
//  - TEST_DATABASE_URL=postgresql://...: the committed PostgreSQL migration
//    history (prisma/postgres/migrations) is applied with `migrate deploy` —
//    the production path. Nothing is reset: the database must be a FRESH,
//    disposable one (a CI service container, or `createdb` per run).

const SQLITE_SUFFIXES = ["", "-journal", "-wal", "-shm"];
const RUN_DB = /^test-(\d+)\.db(-journal|-wal|-shm)?$/;

// Resolve the Prisma CLI entry point and run it with the current Node binary
// so we don't depend on `prisma` being on PATH inside a spawned shell.
const prismaCli = () => createRequire(import.meta.url).resolve("prisma/build/index.js");

/** The SQLite file the vitest process `pid` runs against. */
export function sqliteTestDbPath(pid: number, dir = path.join(process.cwd(), "prisma")): string {
  return path.join(dir, `test-${pid}.db`);
}

export function removeSqliteDb(dbPath: string): void {
  for (const suffix of SQLITE_SUFFIXES) fs.rmSync(dbPath + suffix, { force: true });
}

/** Delete any previous copy of `dbPath` and apply the committed SQLite migration history to it. */
export function prepareSqliteTestDb(dbPath: string): void {
  removeSqliteDb(dbPath);
  // The committed SQLite migration history (the desktop/dev path), never `db push`:
  // every run proves the migrations reproduce the schema the services use.
  execFileSync(process.execPath, [prismaCli(), "migrate", "deploy"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: `file:${dbPath.replace(/\\/g, "/")}` },
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Run databases left in `dir` by vitest processes that are no longer running (a killed or crashed run). */
export function staleSqliteTestDbs(dir: string, alive: (pid: number) => boolean = processAlive): string[] {
  return fs.readdirSync(dir).flatMap((name) => {
    const m = RUN_DB.exec(name);
    return m && !alive(Number(m[1])) ? [path.join(dir, name)] : [];
  });
}

export default function setup() {
  const pgUrl = process.env.TEST_DATABASE_URL;
  if (pgUrl?.startsWith("postgres")) {
    execFileSync(process.execPath, [prismaCli(), "migrate", "deploy", "--schema", "prisma/postgres/schema.prisma"], {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: pgUrl },
    });
    return;
  }

  // vitest.config.ts chose this run's file; its workers receive the same path as DATABASE_URL.
  const dbPath = process.env.VITEST_SQLITE_DB ?? sqliteTestDbPath(process.pid);
  for (const f of staleSqliteTestDbs(path.dirname(dbPath))) fs.rmSync(f, { force: true });
  prepareSqliteTestDb(dbPath);
  return () => {
    try {
      removeSqliteDb(dbPath);
    } catch {
      // Still held open (Windows): the next run sweeps it as stale.
    }
  };
}
