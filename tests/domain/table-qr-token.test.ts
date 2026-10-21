/**
 * Table QR tokens are random (src/server/qr/tableToken.ts): never derivable
 * from a table code, unique, rotated by rotateTableQr with the old token dead
 * at once, and the guest lookup refuses anything that is not a live token.
 */
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { buildAccessContext } from "@/server/auth/context";
import { ConflictError } from "@/server/db/scope";
import { GUEST_TABLE_TOKEN_RE } from "@/lib/qr/tableQrUrl";
import { issueTableQrToken, newTableQrToken, TABLE_QR_TOKEN_BYTES } from "@/server/qr/tableToken";
import { revokeTableQr, rotateTableQr } from "@/server/services/masterData";
import { lookupTableToken, resolveTable } from "@/server/services/guestOrdering";
import { legacyCafeTableToken } from "../../prisma/coders-cafe/seed";

const RUN = Date.now().toString(36);
afterAll(async () => { await prisma.$disconnect(); });

async function outletWithTable(tag: string, qrToken: string | null = null) {
  const org = await prisma.organization.create({ data: { name: `QR token ${tag} ${RUN}` } });
  const outlet = await prisma.outlet.create({ data: { organizationId: org.id, code: `Q${tag}${RUN}`.toUpperCase().slice(0, 20), name: "Main" } });
  const user = await prisma.user.create({ data: { organizationId: org.id, email: `owner-${tag}-${RUN}@qr-token.test`, name: "Owner", passwordHash: "x" } });
  await prisma.membership.create({ data: { organizationId: org.id, userId: user.id, outletId: null, role: "OWNER" } });
  const table = await prisma.restaurantTable.create({ data: { organizationId: org.id, outletId: outlet.id, code: "T01", qrToken } });
  return { org, outlet, table, owner: await buildAccessContext(prisma, user.id) };
}

describe("newTableQrToken", () => {
  it("is 18 CSPRNG bytes as 24 base64url characters, accepted by the guest token rule", () => {
    const t = newTableQrToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(t).toMatch(GUEST_TABLE_TOKEN_RE);
    expect(Buffer.from(t, "base64url")).toHaveLength(TABLE_QR_TOKEN_BYTES);
  });

  it("does not repeat over many draws and never equals the derivable legacy demo token", () => {
    const seen = new Set(Array.from({ length: 5000 }, newTableQrToken));
    expect(seen.size).toBe(5000);
    for (let i = 1; i <= 10; i++) expect(seen.has(legacyCafeTableToken(`T${String(i).padStart(2, "0")}`))).toBe(false);
  });
});

describe("issueTableQrToken", () => {
  it("skips a value another table already holds", async () => {
    const taken = `taken${RUN}`;
    await outletWithTable("a", taken);
    const draws = [taken, taken, `fresh${RUN}`];
    expect(await issueTableQrToken(prisma, () => draws.shift()!)).toBe(`fresh${RUN}`);
    expect(draws).toHaveLength(0);
  });

  it("gives up with a conflict instead of reusing a held value", async () => {
    const taken = `stuck${RUN}`;
    await outletWithTable("b", taken);
    await expect(issueTableQrToken(prisma, () => taken)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("rotateTableQr", () => {
  it("issues a random token, kills the previous one at once, and audits without the token", async () => {
    const { table, owner, outlet } = await outletWithTable("c");
    const first = (await rotateTableQr(owner, table.id)).qrToken!;
    expect(first).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect((await resolveTable(first)).outlet.id).toBe(outlet.id);

    const second = (await rotateTableQr(owner, table.id)).qrToken!;
    expect(second).not.toBe(first);
    expect((await lookupTableToken(first)).status).toBe("not_found");
    await expect(resolveTable(first)).rejects.toThrow();
    expect((await resolveTable(second)).table).toEqual({ id: table.id, code: "T01" });

    const audits = await prisma.auditLog.findMany({ where: { entityId: table.id, entityType: "RestaurantTable" } });
    expect(audits).toHaveLength(2);
    for (const a of audits) expect(`${a.before ?? ""}${a.after ?? ""}`).not.toMatch(new RegExp(`${first}|${second}`));
    // Rotation touches the token only.
    expect(await prisma.restaurantTable.findUniqueOrThrow({ where: { id: table.id } })).toMatchObject({ id: table.id, code: "T01", outletId: outlet.id, qrToken: second });
  });

  it("a revoked table answers not_found until a new token is issued", async () => {
    const { table, owner } = await outletWithTable("d");
    const live = (await rotateTableQr(owner, table.id)).qrToken!;
    await revokeTableQr(owner, table.id);
    expect((await lookupTableToken(live)).status).toBe("not_found");
    const next = (await rotateTableQr(owner, table.id)).qrToken!;
    expect((await lookupTableToken(next)).status).toBe("ok");
  });
});

describe("guest token lookup", () => {
  it.each(["", "short", "has space here", "a/b/c/d/e/f", "x".repeat(65), "../../etc/passwd", "%2e%2e%2f"])("refuses malformed token %j", async (t) => {
    expect((await lookupTableToken(t)).status).toBe("not_found");
  });

  it("refuses a well-formed token no table holds, including the derivable legacy value", async () => {
    expect((await lookupTableToken(newTableQrToken())).status).toBe("not_found");
    const { table, owner } = await outletWithTable("e");
    await rotateTableQr(owner, table.id);
    expect((await lookupTableToken(legacyCafeTableToken("T01"))).status).toBe("not_found");
  });
});

describe("qr:audit classification", () => {
  it("flags the derivable legacy token and nonstandard values, never echoing the token", async () => {
    const { classifyTableToken, auditTableTokens } = await import("../../scripts/qr/audit-table-tokens");
    expect(classifyTableToken("T03", legacyCafeTableToken("T03"))).toBe("legacy-derivable");
    expect(classifyTableToken("T03", newTableQrToken())).toBe("random");
    expect(classifyTableToken("T03", "site-demo-table-qr")).toBe("nonstandard");
    expect(classifyTableToken("T03", null)).toBe("none");
    const legacy = legacyCafeTableToken("T01");
    const { outlet } = await outletWithTable("f", legacy);
    const rows = await auditTableTokens(prisma);
    expect(rows.find((r) => r.outlet === outlet.code)).toMatchObject({ code: "T01", class: "legacy-derivable" });
    expect(JSON.stringify(rows)).not.toContain(legacy);
  });

  it("flags the pre-2026-10-05 demo seed's <outlet>-<table> token as derivable too", async () => {
    const { classifyTableToken, auditTableTokens } = await import("../../scripts/qr/audit-table-tokens");
    expect(classifyTableToken("G1", "HYDCEN-G1", "HYDCEN")).toBe("legacy-derivable");
    expect(classifyTableToken("G1", "HYDJUB-G1", "HYDCEN")).toBe("nonstandard");
    expect(classifyTableToken("G1", "HYDCEN-G1")).toBe("nonstandard");
    const { outlet, table } = await outletWithTable("g");
    const old = `${outlet.code}-T01`;
    await prisma.restaurantTable.update({ where: { id: table.id }, data: { qrToken: old } });
    const rows = await auditTableTokens(prisma);
    expect(rows.find((r) => r.outlet === outlet.code)).toMatchObject({ code: "T01", class: "legacy-derivable" });
    expect(JSON.stringify(rows)).not.toContain(old);
  });
});
