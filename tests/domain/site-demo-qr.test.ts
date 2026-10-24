/**
 * The website screenshot fixture (scripts/site/demo-state.ts) used to set a
 * fixed, source-visible table token and print the tokenized guest path. It now
 * issues a random token and hands the path to capture-screens.mjs via a
 * gitignored file.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { prisma } from "@/server/db/client";
import { GUEST_TABLE_TOKEN_RE } from "@/lib/qr/tableQrUrl";
import { assignSiteDemoQrToken, SITE_DEMO_GUEST_PATH_FILE } from "../../scripts/site/demo-qr";
import { readGuestPath } from "../../scripts/site/guest-path.mjs";

const RUN = Date.now().toString(36);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-demo-qr-"));
afterAll(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  await prisma.$disconnect();
});

async function table() {
  const org = await prisma.organization.create({ data: { name: `Site demo QR ${RUN}` } });
  const outlet = await prisma.outlet.create({ data: { organizationId: org.id, code: `SD${RUN}`.toUpperCase().slice(0, 20), name: "Main" } });
  return prisma.restaurantTable.create({ data: { organizationId: org.id, outletId: outlet.id, code: "F11" } });
}

describe("assignSiteDemoQrToken", () => {
  it("issues a random token, writes the guest path to the file and prints nothing", async () => {
    const t = await table();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const file = path.join(dir, "a", "guest-path.txt");
    expect(await assignSiteDemoQrToken(prisma, t.id, file)).toBe(file);
    const { qrToken } = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: t.id } });
    expect(qrToken).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(qrToken).toMatch(GUEST_TABLE_TOKEN_RE);
    expect(qrToken).not.toBe("site-demo-table-qr");
    expect(fs.readFileSync(file, "utf8")).toBe(`/t/${qrToken}\n`);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("gives a fresh token on every run", async () => {
    const t = await table();
    const file = path.join(dir, "b.txt");
    await assignSiteDemoQrToken(prisma, t.id, file);
    const first = fs.readFileSync(file, "utf8");
    await assignSiteDemoQrToken(prisma, t.id, file);
    expect(fs.readFileSync(file, "utf8")).not.toBe(first);
  });

  it("is read back by the screenshot script, which accepts only a relative /t/<token> path", async () => {
    const t = await table();
    const file = path.join(dir, "c.txt");
    await assignSiteDemoQrToken(prisma, t.id, file);
    const { qrToken } = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: t.id } });
    expect(readGuestPath(file)).toBe(`/t/${qrToken}`);
    for (const bad of ["https://evil.example/t/abcdefgh", "//evil.example/t/abcdefgh", "/dashboard", "/t/abc", "/t/abcdefgh?x=1", "/t/../login", ""]) {
      fs.writeFileSync(file, bad);
      expect(() => readGuestPath(file)).toThrow(/guest path/);
    }
  });

  it("is read lazily: the capture script only reads it inside the guest shots", () => {
    const src = fs.readFileSync(path.join("scripts", "site", "capture-screens.mjs"), "utf8");
    expect(src).toMatch(/const guestPath = async \(\) => readGuestPath\(\);/);
    expect(src.match(/readGuestPath\(/g)).toHaveLength(1);
  });

  it("writes to a gitignored path", () => {
    expect(() => execFileSync("git", ["check-ignore", "-q", SITE_DEMO_GUEST_PATH_FILE])).not.toThrow();
  });

  it("leaves no fixed table token in the screenshot scripts", () => {
    for (const f of ["demo-state.ts", "capture-screens.mjs"]) {
      expect(fs.readFileSync(path.join("scripts", "site", f), "utf8")).not.toMatch(/qrToken:\s*["']|\/t\/[A-Za-z0-9_-]{6,}["']/);
    }
  });
});
