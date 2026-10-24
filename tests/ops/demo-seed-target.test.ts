import { describe, expect, it } from "vitest";
import { CONFIRM_FLAG, demoSeedTarget } from "../../prisma/demo-cafe/target";

// The demo seed's opt-in names the database it will write to, so a confirmation typed for one
// database can never seed another one DATABASE_URL happens to point at (e.g. a pulled Production URL).
describe("demo seed target confirmation", () => {
  const sqlite = { DATABASE_URL: "file:./demo-cafe.db" };
  const pg = { DATABASE_URL: "postgresql://demo_user:pw@localhost:55470/restora_demo?schema=public" };

  it("accepts a confirmation naming the SQLite file", () => {
    expect(demoSeedTarget([`${CONFIRM_FLAG}=demo-cafe.db`], sqlite)).toEqual({ engine: "sqlite", database: "demo-cafe.db" });
  });

  it("accepts a confirmation naming the PostgreSQL database", () => {
    expect(demoSeedTarget([`${CONFIRM_FLAG}=restora_demo`], pg)).toEqual({ engine: "postgresql", database: "restora_demo" });
  });

  it("refuses the bare flag and says which database it would have written to", () => {
    expect(() => demoSeedTarget([CONFIRM_FLAG], sqlite)).toThrow(/--confirm-demo-database=demo-cafe\.db/);
    expect(() => demoSeedTarget([], pg)).toThrow(/--confirm-demo-database=restora_demo/);
  });

  it("refuses a confirmation naming another database", () => {
    expect(() => demoSeedTarget([`${CONFIRM_FLAG}=demo-cafe.db`], pg)).toThrow(/restora_demo/);
    expect(() => demoSeedTarget([`${CONFIRM_FLAG}=other.db`], sqlite)).toThrow(/demo-cafe\.db/);
  });

  it("never prints the connection string or its password", () => {
    try {
      demoSeedTarget([CONFIRM_FLAG], pg);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/demo_user|pw@|localhost|55470/);
    }
  });

  it("always refuses the working dev.db, even when confirmed by name", () => {
    expect(() => demoSeedTarget([`${CONFIRM_FLAG}=dev.db`], { DATABASE_URL: "file:./dev.db" })).toThrow(/dev\.db/);
  });

  it("refuses production mode and a missing or unreadable DATABASE_URL", () => {
    expect(() => demoSeedTarget([`${CONFIRM_FLAG}=demo-cafe.db`], { ...sqlite, NODE_ENV: "production" })).toThrow(/NODE_ENV=production/);
    expect(() => demoSeedTarget([`${CONFIRM_FLAG}=x`], {})).toThrow(/DATABASE_URL/);
    expect(() => demoSeedTarget([`${CONFIRM_FLAG}=x`], { DATABASE_URL: "mysql://h/x" })).toThrow(/DATABASE_URL/);
  });
});
