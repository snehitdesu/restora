/**
 * npm test expects the SQLite Prisma client (prisma/schema.prisma).
 * A PostgreSQL-targeted build (VERCEL=1 or PRISMA_CLIENT=postgresql) leaves
 * a postgres client that rejects the file: test URL. Regenerate only then.
 *
 * Does not connect, migrate, or seed. npm run test:pg generates the
 * PostgreSQL client itself and calls vitest directly, so it skips this.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";

const schemaPath = "node_modules/.prisma/client/schema.prisma";
let provider = "";
try {
  const text = fs.readFileSync(schemaPath, "utf8");
  provider = /datasource\s+db\s*\{[^}]*provider\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? "";
} catch {
  provider = "";
}
if (provider === "sqlite") process.exit(0);

const require = createRequire(import.meta.url);
const cli = require.resolve("prisma/build/index.js");
execFileSync(process.execPath, [cli, "generate"], { stdio: "inherit", env: process.env });
