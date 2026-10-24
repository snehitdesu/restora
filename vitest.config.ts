import { defineConfig } from "vitest/config";
import path from "node:path";
import { sqliteTestDbPath } from "./vitest.global-setup";

// Tests run against a dedicated SQLite file so they never touch dev.db: one per
// vitest process (prisma/test-<pid>.db), so two runs in the same checkout never
// rebuild each other's database. vitest.global-setup.ts reads the same path.
// TEST_DATABASE_URL=postgresql://... runs the same suite against PostgreSQL
// (see docs/postgres.md; requires the client generated from prisma/postgres).
process.env.VITEST_SQLITE_DB ??= sqliteTestDbPath(process.pid);
const testDbUrl = process.env.TEST_DATABASE_URL ?? `file:${process.env.VITEST_SQLITE_DB.replace(/\\/g, "/")}`;

export default defineConfig({
  // React components in UI tests (tsconfig keeps jsx: "preserve" for Next).
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": path.join(process.cwd(), "src"),
    },
  },
  test: {
    environment: "node",
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./tests/setup-after-commit.ts"],
    env: {
      DATABASE_URL: testDbUrl,
      VITEST_SQLITE_DB: process.env.VITEST_SQLITE_DB,
      // Integration-secret encryption and sessions need a key; a fresh checkout / CI has no .env.
      // Test-only value, never used outside the vitest processes.
      AUTH_SECRET: process.env.AUTH_SECRET || "vitest-only-auth-secret-never-used-in-production-0000",
    },
    // Backend suites run in node; UI suites opt into jsdom per file (// @vitest-environment jsdom).
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts"],
    // All suites are DB integration tests sharing one database. SQLite allows
    // a single writer, so parallel files contend for the write lock and Prisma's
    // interactive transactions abort nondeterministically. Run files
    // sequentially; tests within a file already run in order.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
