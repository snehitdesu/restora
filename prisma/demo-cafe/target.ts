/**
 * Which database the demo seed may write to (prisma/seed-demo-cafe.ts).
 *
 * The opt-in names the target: `--confirm-demo-database=<name>`, where <name> is the
 * SQLite file name (file:./demo-cafe.db → demo-cafe.db) or the PostgreSQL database
 * name. A bare flag is refused, so a confirmation typed for one database can never
 * seed another one DATABASE_URL happens to point at (a pulled Production URL, the
 * working dev.db). The refusal names the database it found — never the connection
 * string, user, host or password.
 */
import path from "node:path";

export const CONFIRM_FLAG = "--confirm-demo-database";

/** The working local database: holds the restaurant's own data, never seeded with the demo. */
const NEVER_SEED = new Set(["dev.db"]);

export type DemoSeedTarget = { engine: "sqlite" | "postgresql"; database: string };

function targetOf(url: string): DemoSeedTarget | null {
  if (/^file:/i.test(url)) {
    const database = path.basename(url.slice("file:".length).split("?")[0]);
    return database ? { engine: "sqlite", database } : null;
  }
  if (/^postgres(ql)?:\/\//i.test(url)) {
    try {
      const database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
      return database ? { engine: "postgresql", database } : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function demoSeedTarget(argv: readonly string[], env: Record<string, string | undefined> = process.env): DemoSeedTarget {
  if (env.NODE_ENV === "production") throw new Error("Refusing to seed demo data with NODE_ENV=production.");
  const target = targetOf(env.DATABASE_URL?.trim() ?? "");
  if (!target) throw new Error("Refusing to seed: DATABASE_URL is missing or is not a SQLite file: / PostgreSQL URL.");
  if (NEVER_SEED.has(target.database)) throw new Error(`Refusing to seed ${target.database}: it is the working local database. Point DATABASE_URL at a new, disposable demo database.`);
  const confirmed = argv.find((a) => a.startsWith(`${CONFIRM_FLAG}=`))?.slice(CONFIRM_FLAG.length + 1);
  if (confirmed !== target.database) {
    throw new Error(
      `Refusing to seed: it adds the demo organization and its sign-in accounts to the ${target.engine} database "${target.database}". ` +
        `If that is a local or disposable demo database, confirm it by name: ${CONFIRM_FLAG}=${target.database}`,
    );
  }
  return target;
}
