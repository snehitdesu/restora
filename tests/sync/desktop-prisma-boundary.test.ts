/**
 * Hosted PostgreSQL Prisma Client does not include CloudLink / CloudRecordMap /
 * SyncOperation. Desktop-only access must go through desktopSync() so Vercel
 * typechecking does not require those models on PrismaClient.
 */
import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DESKTOP_ONLY_MODELS } from "../../scripts/pg-schema.mjs";
import { prisma } from "@/server/db/client";
import { desktopSync } from "@/server/sync/desktopDb";
import { guardMirroredRequest } from "@/server/sync/mirrorGuard";
import type { AccessContext } from "@/server/db/scope";

const ROOT = path.resolve(__dirname, "../..");
const pg = (process.env.DATABASE_URL ?? "").startsWith("postgres");
const DELEGATE = /\b(?:db|prisma|tx)\.(cloudLink|cloudRecordMap|syncOperation)\b/;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("desktop-only Prisma models stay off the hosted client", () => {
  it("are listed for pg-schema to strip, and production source never reads them off PrismaClient directly", () => {
    expect(DESKTOP_ONLY_MODELS).toEqual(["CloudLink", "CloudRecordMap", "SyncOperation"]);
    const files = [...walkTs(path.join(ROOT, "src/server/sync")), ...walkTs(path.join(ROOT, "src/app/api/cloud"))];
    const hits: string[] = [];
    for (const file of files) {
      if (path.basename(file) === "desktopDb.ts") continue;
      const rel = path.relative(ROOT, file).replaceAll("\\", "/");
      for (const [i, line] of fs.readFileSync(file, "utf8").split(/\n/).entries()) {
        if (DELEGATE.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("desktopSync is the same runtime object (SQLite delegates are on the client; the helper only types them)", () => {
    const db = { cloudLink: { findUnique: () => null } };
    expect(desktopSync(db)).toBe(db);
  });

  it("the mirrored-order guard does not touch desktop models on the hosted deployment", async () => {
    vi.stubEnv("AHAROS_DESKTOP", "0");
    const cloudRecordMap = { findFirst: vi.fn() };
    const syncOperation = { findMany: vi.fn() };
    const ctx = { organizationId: "org", outletIds: [], userId: "u", roles: [], outletRoles: {}, orgRoles: [], isOrgWide: false, isSuperAdmin: false } as AccessContext;
    const result = await guardMirroredRequest({ cloudRecordMap, syncOperation } as never, { ctx, method: "POST", segs: ["order-1", "submit"], body: {} });
    expect(result).toBeNull();
    expect(cloudRecordMap.findFirst).not.toHaveBeenCalled();
    expect(syncOperation.findMany).not.toHaveBeenCalled();
  });

  it("exist only in the desktop (SQLite) database and client: the migrated PostgreSQL database and its client have none", async () => {
    const tables = pg
      ? await prisma.$queryRaw<Array<{ name: string }>>`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('CloudLink', 'CloudRecordMap', 'SyncOperation')`
      : await prisma.$queryRaw<Array<{ name: string }>>`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('CloudLink', 'CloudRecordMap', 'SyncOperation')`;
    expect(tables.map((t) => t.name).sort()).toEqual(pg ? [] : [...DESKTOP_ONLY_MODELS].sort());
    const delegates = desktopSync(prisma);
    for (const d of [delegates.cloudLink, delegates.cloudRecordMap, delegates.syncOperation]) expect(d === undefined).toBe(pg);
  });
});
