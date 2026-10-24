import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

describe("docs/master-feature-audit.md", () => {
  it("has unique row ids, only known statuses, and a Totals table that matches the rows", () => {
    // Exits non-zero (and prints what it counted) when a status is unknown, an id repeats, or the table is stale.
    const out = execFileSync(process.execPath, ["scripts/audit-totals.mjs"], { encoding: "utf8" });
    expect(out).toContain("| **Total** |");
  });
});
