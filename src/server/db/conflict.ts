/**
 * Is this error a PostgreSQL serialization failure (SQLSTATE 40001) or deadlock
 * (40P01) — i.e. is retrying the whole transaction the right response?
 *
 * Prisma reports it as P2034 from its own queries, but a raw query
 * ($queryRaw / $executeRaw — e.g. the KOT-number nextval() inside an order
 * transaction) fails with P2010 and the SQLSTATE only in its message. Both are
 * the same condition: retried by runInTx, and HTTP 503 once retries run out
 * (api/respond.ts additionally requires a genuine Prisma known-request error).
 */
export function isSerializationConflict(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (!e) return false;
  if (e.code === "P2034") return true;
  return e.code === "P2010" && /\b(40001|40P01)\b|could not serialize access|deadlock detected/i.test(String(e.message ?? ""));
}

/**
 * A unique violation on the stock ledger's posting key (InventoryLedger.sourceRef).
 * Every stock movement has a deterministic key (`wastage:<doc>:<material>`,
 * `grn:<grn>:<line>`, `production:<batch>:out`, `issue:…`), and documents are
 * posted by "read it as a draft, write the ledger rows, mark it posted". Two
 * posts of one document at the same moment on PostgreSQL therefore both read the
 * draft; the second ledger insert waits for the first and then fails with
 * 23505 (P2002), not 40001, although it is the same serialization anomaly. The
 * unique key already kept stock from moving twice; re-running the transaction
 * sees the committed post and gives the normal answer (already posted / a no-op)
 * instead of a 500. Measured 2026-10-08 (tests/db/production-concurrency.test.ts).
 */
export function isLedgerKeyRace(error: unknown): boolean {
  const e = error as { code?: unknown; meta?: { target?: unknown } } | null;
  if (!e || e.code !== "P2002") return false;
  const target = e.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
  return fields.some((f) => f === "sourceRef" || f === "InventoryLedger_sourceRef_key");
}

/**
 * Is the database unreachable or restarting (a transient outage, not a bug)?
 * Measured during a PostgreSQL restart under load (Phase 12): Prisma reported
 * P1001 "Can't reach database server", and unknown-request errors carrying
 * "the database system is shutting down / starting up" (SQLSTATE 57P03) or
 * "terminating connection due to administrator command" (57P01). The app
 * reconnects by itself once the database is back; the API answers 503 +
 * Retry-After meanwhile instead of a 500.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; name?: unknown; errorCode?: unknown } | null;
  if (!e) return false;
  if (e.name === "PrismaClientInitializationError") return true;
  if (typeof e.code === "string" && ["P1001", "P1002", "P1017"].includes(e.code)) return true;
  if (e.name !== "PrismaClientUnknownRequestError" && e.name !== "PrismaClientKnownRequestError") return false;
  return /database system is (shutting down|starting up|in recovery mode)|terminating connection due to administrator command|\b57P0[1-3]\b|Server has closed the connection/i.test(String(e.message ?? ""));
}
