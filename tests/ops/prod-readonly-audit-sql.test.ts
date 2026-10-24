/**
 * scripts/ops/prod-readonly-audit.sql is run by an operator against
 * Production with psql. It must stay read-only, never print tokens, and
 * classify QR tokens with the same rules as `npm run qr:audit`
 * (scripts/qr/audit-table-tokens.ts). Its behaviour on PostgreSQL is
 * recorded in docs/production-readonly-audit.md; these checks keep later
 * edits from drifting.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyCafeTableToken } from "../../prisma/coders-cafe/seed";

const sql = fs.readFileSync(path.join(process.cwd(), "scripts/ops/prod-readonly-audit.sql"), "utf8");
const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--") && !l.trim().startsWith("\\")).join("\n");

describe("prod-readonly-audit.sql", () => {
  it("is read-only by construction: read-only session + transaction, ends with ROLLBACK, no write statement", () => {
    expect(statements).toMatch(/SET default_transaction_read_only = on;/);
    expect(statements).toMatch(/BEGIN TRANSACTION READ ONLY;/);
    expect(statements.trim().split(";").filter((s) => s.trim()).at(-1)?.trim()).toBe("ROLLBACK");
    // String literals (e.g. has_table_privilege(..., 'INSERT')) are not statements.
    const code = statements.replace(/'(?:[^']|'')*'/g, "''");
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY|COMMIT)\b/i);
  });

  it("never selects a token column for output, only classifies it", () => {
    // "qrToken" appears only inside the CASE that classifies it.
    const uses = statements.split("\n").filter((l) => l.includes('"qrToken"'));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses) expect(l).toMatch(/WHEN t\."qrToken"/);
  });

  it("derives the legacy Coders' Cafe token exactly like legacyCafeTableToken", () => {
    // Same seed string, prefix and length; the SQL turns base64 into base64url by hand.
    expect(sql).toContain("'restora-demo:coders-cafe:table:' || t.code");
    expect(sql).toMatch(/'cc' \|\| left\(translate\(rtrim\(encode\(sha256\(.*'base64'\), '='\), '\+\/', '-_'\), 22\)/);
    const t = legacyCafeTableToken("T01");
    expect(t).toMatch(/^cc[A-Za-z0-9_-]{22}$/);
  });

  it("uses the same random-token shape and <outlet>-<table> rule as qr:audit", async () => {
    const { classifyTableToken } = await import("../../scripts/qr/audit-table-tokens");
    expect(sql).toContain(`'^[A-Za-z0-9_-]{24}$'`);
    expect(sql).toContain(`t."qrToken" = o.code || '-' || t.code`);
    expect(classifyTableToken("T02", "CC01-T02", "CC01")).toBe("legacy-derivable");
  });
});
