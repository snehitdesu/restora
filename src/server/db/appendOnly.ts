/**
 * The database itself refuses to change or remove audit and stock-ledger rows (audit SE-08, IN-01; proposal p. 21: "the
 * database physically refuses edits").
 *
 * Triggers on AuditLog and InventoryLedger abort every UPDATE and DELETE (and, on PostgreSQL, TRUNCATE), whoever sends it:
 * the application role, the schema owner, a hand-typed query. A correction is a new row, which the services already write.
 * The triggers are created by the migration `20261021100000_append_only_rate_limit`; the SQL below is the same text, kept
 * here so the demo seed and the test suites can switch the guard off while they wipe a DISPOSABLE database, and so the
 * readiness check can prove the triggers are still there (a SQLite table rebuild by a later migration silently drops them).
 *
 * Nothing in the running application calls `withAppendOnlyGuardsOff`.
 */
import type { PrismaClient } from "@prisma/client";

export const APPEND_ONLY_TABLES = ["AuditLog", "InventoryLedger"] as const;
type Table = (typeof APPEND_ONLY_TABLES)[number];

const isPostgres = () => (process.env.DATABASE_URL ?? "").startsWith("postgres");

const sqliteTrigger = (table: Table, op: "update" | "delete") =>
  `CREATE TRIGGER "${table}_append_only_${op}" BEFORE ${op.toUpperCase()} ON "${table}" BEGIN SELECT RAISE(ABORT, '${table} is append-only: a row cannot be ${op === "update" ? "changed" : "removed"}'); END`;

export const SQLITE_GUARD_NAMES = APPEND_ONLY_TABLES.flatMap((t) => [`${t}_append_only_update`, `${t}_append_only_delete`]);
export const SQLITE_GUARD_SQL = APPEND_ONLY_TABLES.flatMap((t) => [sqliteTrigger(t, "update"), sqliteTrigger(t, "delete")]);
export const PG_GUARD_NAMES = APPEND_ONLY_TABLES.flatMap((t) => [`${t}_append_only`, `${t}_append_only_truncate`]);

/** Which triggers are installed right now, by table. Missing ones mean the database no longer protects that table. */
export async function missingAppendOnlyGuards(db: PrismaClient): Promise<string[]> {
  const have = new Set<string>();
  if (isPostgres()) {
    const rows = await db.$queryRawUnsafe<Array<{ tgname: string }>>(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1::text[])`, PG_GUARD_NAMES);
    for (const r of rows) have.add(r.tgname);
    return PG_GUARD_NAMES.filter((n) => !have.has(n));
  }
  const rows = await db.$queryRawUnsafe<Array<{ name: string }>>(`SELECT name FROM sqlite_master WHERE type = 'trigger'`);
  for (const r of rows) have.add(r.name);
  return SQLITE_GUARD_NAMES.filter((n) => !have.has(n));
}

/**
 * Run `fn` with the guards removed, then put them back (also when `fn` throws). ONLY for wiping a disposable database
 * (the demo seed, a test fixture): while it runs, nothing protects the audit trail or the ledger.
 */
export async function withAppendOnlyGuardsOff<T>(db: PrismaClient, fn: () => Promise<T>): Promise<T> {
  if (isPostgres()) {
    for (const t of APPEND_ONLY_TABLES) await db.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER USER`);
    try {
      return await fn();
    } finally {
      for (const t of APPEND_ONLY_TABLES) await db.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER USER`);
    }
  }
  for (const name of SQLITE_GUARD_NAMES) await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${name}"`);
  try {
    return await fn();
  } finally {
    for (const sql of SQLITE_GUARD_SQL) await db.$executeRawUnsafe(sql.replace("CREATE TRIGGER", "CREATE TRIGGER IF NOT EXISTS"));
  }
}
