/**
 * The backup / restore / verify tools check that the database holds "the
 * migration this release expects". By default that is the newest migration of
 * the checkout they run from, so a correct backup of a database that is still
 * on an older release (the pre-upgrade Production backup, or a rollback
 * restore) used to be reported as failed. `--expect-migration <name>` names
 * the migration to require instead; it must be a real migration of this
 * checkout, so a typo cannot silently weaken the check.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { backupMeetsExpected, expectedMigration, resolveExpectedMigration } from "../../scripts/ops/pg-common.mjs";
import { restore } from "../../scripts/ops/pg-restore.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "restora-expected-migration-"));
const migrations = path.join(root, "prisma", "postgres", "migrations");
for (const d of ["20261001100000_first", "20261016100000_integrations_control_room", "20261025100000_recipe_estimates"]) fs.mkdirSync(path.join(migrations, d), { recursive: true });
fs.writeFileSync(path.join(migrations, "migration_lock.toml"), "");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("resolveExpectedMigration", () => {
  it("defaults to the newest migration of the checkout", () => {
    expect(expectedMigration(root)).toBe("20261025100000_recipe_estimates");
    expect(resolveExpectedMigration(undefined, root)).toBe("20261025100000_recipe_estimates");
  });

  it("accepts an older migration of this checkout (a pre-upgrade backup)", () => {
    expect(resolveExpectedMigration("20261016100000_integrations_control_room", root)).toBe("20261016100000_integrations_control_room");
  });

  it("refuses a name that is not a migration of this checkout, or a bare flag", () => {
    expect(() => resolveExpectedMigration("20261016100000_integrations_contrl_room", root)).toThrow(/not a migration of this checkout/);
    expect(() => resolveExpectedMigration("migration_lock.toml", root)).toThrow(/not a migration of this checkout/);
    expect(() => resolveExpectedMigration("", root)).toThrow(/needs a migration name/);
    expect(() => resolveExpectedMigration(true, root)).toThrow(/needs a migration name/);
  });

  it("backupMeetsExpected: a backup whose newest migration is older than the expected one cannot pass", () => {
    expect(backupMeetsExpected("20261016100000_integrations_control_room", "20261025100000_recipe_estimates")).toBe(false);
    expect(backupMeetsExpected("20261025100000_recipe_estimates", "20261016100000_integrations_control_room")).toBe(true);
    expect(backupMeetsExpected("20261025100000_recipe_estimates", "20261025100000_recipe_estimates")).toBe(true);
    // Unknown on either side: no early verdict (the full verification still decides).
    expect(backupMeetsExpected(null, "20261025100000_recipe_estimates")).toBe(true);
    expect(backupMeetsExpected("20261025100000_recipe_estimates", null)).toBe(true);
  });

  it("the real checkout's default is the readiness probe's EXPECTED_MIGRATION", async () => {
    const { EXPECTED_MIGRATION } = await import("@/server/ops/readiness");
    expect(resolveExpectedMigration(undefined)).toBe(EXPECTED_MIGRATION);
  });
});

describe("pg-restore refuses a mismatched backup before touching the target", () => {
  // An unreachable target: reaching it at all would fail with a connection error, not the mismatch.
  const target = "postgresql://nobody@127.0.0.1:1/restora_verify_none";
  const backupFile = (latestMigration: string) => {
    const file = path.join(root, `backup-${latestMigration}.dump`);
    fs.writeFileSync(file, "not a real dump");
    const sha256 = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    fs.writeFileSync(`${file}.json`, JSON.stringify({ sha256, latestMigration }));
    return file;
  };

  it("a pre-upgrade backup restored with this release's default expectation is refused up front", async () => {
    const file = backupFile("20261016100000_integrations_control_room");
    await expect(restore({ file, target, confirmOverwrite: "restora_verify_none", key: undefined, expectMigration: undefined })).rejects.toThrow(/newest migration is 20261016100000_integrations_control_room.*--expect-migration/);
  });

  it("with --expect-migration naming the backup's release it gets past the check (and only then contacts the target)", async () => {
    const file = backupFile("20261016100000_integrations_control_room");
    const err = await restore({ file, target, confirmOverwrite: undefined, key: undefined, expectMigration: "20261016100000_integrations_control_room" }).then(() => null, (e: Error) => e);
    expect(err?.message).not.toMatch(/newest migration is/);
  });
});
