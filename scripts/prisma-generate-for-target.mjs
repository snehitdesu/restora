/**
 * Generate the Prisma client for the deployment target.
 *
 * Local / CI SQLite builds keep prisma/schema.prisma.
 * Vercel (VERCEL=1) and explicit PRISMA_CLIENT=postgresql generate from the
 * PostgreSQL schema produced by scripts/pg-schema.mjs so the production
 * client matches prisma/postgres/migrations.
 *
 * Does not connect to a database and never runs migrate / db push / seed.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function prismaGenerate(extraArgs = []) {
  const cli = require.resolve("prisma/build/index.js");
  execFileSync(process.execPath, [cli, "generate", ...extraArgs], { stdio: "inherit", env: process.env });
}

const postgres = process.env.VERCEL === "1" || process.env.PRISMA_CLIENT === "postgresql";
if (postgres) {
  execFileSync(process.execPath, ["scripts/pg-schema.mjs"], { stdio: "inherit" });
  prismaGenerate(["--schema", "prisma/postgres/schema.prisma"]);
} else {
  prismaGenerate([]);
}
