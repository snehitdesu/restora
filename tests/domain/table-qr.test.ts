/**
 * Coders' Cafe table QR labels: each stored token maps to /t/<token>, invalid
 * and duplicate tokens are refused, production mode requires a public https
 * URL, and a local sheet is never marked ready to print.
 */
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { NotFoundError } from "@/server/db/scope";
import { qrSvgDocument, qrSvgPath } from "@/lib/qrSvg";
import { createMenuItem } from "@/server/services/menu";
import { confirmGuestPayment, getGuestOrder, guestMenu, placeGuestOrder, quoteGuestCart, resolveTable } from "@/server/services/guestOrdering";
import {
  CAFE_TABLE_CODES,
  TableQrError,
  buildTableQrPack,
  guestOrderingUrl,
  isNonPublicHost,
  normalizeQrOrigin,
  parseQrArgs,
  qrBaseUrlProblem,
  writeTableQrFiles,
} from "@/server/qr/tableLabels";
import { loadCafeTableRows, runQrGenerate } from "../../scripts/qr/generate-table-qrs";
import { findCafe } from "../../prisma/coders-cafe/seed";

const RUN = Date.now().toString(36);
const PUBLIC = "https://menus.example.com";

function tokenFor(code: string): string {
  return `tok${code}${RUN}abcd`;
}

function rowsFor(codes: readonly string[] = CAFE_TABLE_CODES) {
  return codes.map((code) => ({ code, qrToken: tokenFor(code), outletId: "outlet-should-not-appear", price: "price-should-not-appear" }));
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("table QR URL validation", () => {
  it("requires a public https origin in production and allows this computer only in local mode", () => {
    expect(qrBaseUrlProblem("https://menus.example.com", "production")).toBeNull();
    expect(qrBaseUrlProblem("https://menus.example.com/", "production")).toBeNull();
    expect(qrBaseUrlProblem("https://menus.example.com:8443", "production")).toBeNull();
    expect(normalizeQrOrigin("https://menus.example.com:8443/")).toBe("https://menus.example.com:8443");

    for (const bad of [
      "",
      "not a url",
      "http://menus.example.com",
      "http://localhost:3000",
      "https://localhost:3000",
      "https://127.0.0.1",
      "https://[::1]",
      "https://192.168.1.8",
      "https://10.0.0.5",
      "https://172.16.0.4",
      "https://100.64.1.1",
      "https://menus.example.com/t/already",
      "https://user:pass@menus.example.com",
      "https://menus.example.com/?table=T01",
      "ftp://localhost",
    ]) {
      expect(qrBaseUrlProblem(bad, "production"), bad).toBeTruthy();
    }

    expect(qrBaseUrlProblem("http://localhost:3000", "local")).toBeNull();
    expect(qrBaseUrlProblem("http://127.0.0.1:3000", "local")).toBeNull();
    expect(qrBaseUrlProblem("http://192.168.1.8:3000", "local")).toBeNull();
    expect(qrBaseUrlProblem(PUBLIC, "local")).toBeNull();
    expect(qrBaseUrlProblem("ftp://localhost", "local")).toMatch(/http or https/);
    expect(isNonPublicHost("menus.example.com")).toBe(false);
    expect(isNonPublicHost("localhost")).toBe(true);
  });

  it("rejects malformed, documentation, mapped, and reserved IPv6 hosts", () => {
    const nonPublic = [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:192.168.1.8",
      "::ffff:c0a8:108",
      "::ffff:10.1.2.3",
      "::ffff:169.254.1.1",
      "::ffff:0.0.0.0",
      "::ffff:224.0.0.1",
      "::ffff:255.255.255.255",
      "::ffff:100.64.0.1",
      "::ffff:172.31.255.255",
      "::ffff:8.8.8.8",
      "::ffff:808:808",
      "::ffff:1.1.1.1",
      "::",
      "0:0:0:0:0:0:0:0",
      "::1",
      "0:0:0:0:0:0:0:1",
      "fe80::1",
      "fe80::1%eth0",
      "fe80:0:0:0:0:0:0:1",
      "fc00::1",
      "fd12:3456::1",
      "fec0::1",
      "ff02::1",
      "ff00::",
      "100::",
      "64:ff9b::8.8.8.8",
      "64:ff9b:1::1",
      "2001::1",
      "2001:2::1",
      "2001:20::1",
      "2002::1",
      "2001:db8::1",
      "2001:DB8::1",
      "2001:0db8::1",
      "[2001:db8::1]",
      "2001:db8::1.",
      "3fff::1",
      "3fff:0fff::1",
      "gggg::1",
      "1::2::3",
      ":::1",
      "::ffff:999.1.1.1",
      "1:2:3:4:5:6:7:8:9",
    ];
    for (const host of nonPublic) expect(isNonPublicHost(host), host).toBe(true);
    for (const host of ["2001:4860:4860::8888", "2606:4700:4700::1111", "2000::1"]) {
      expect(isNonPublicHost(host), host).toBe(false);
    }
    for (const url of [
      "https://[::ffff:127.0.0.1]",
      "https://[::ffff:8.8.8.8]",
      "https://[::ffff:10.0.0.1]",
      "https://[::]",
      "https://[::1]",
      "https://[fe80::1]",
      "https://[fc00::1]",
      "https://[ff02::1]",
      "https://[100::]",
      "https://[2001::1]",
      "https://[2002::1]",
      "https://[2001:db8::1]",
      "https://[3fff::1]",
      "https://[::ffff:192.168.1.8]",
    ]) {
      expect(qrBaseUrlProblem(url, "production"), url).toMatch(/public https/);
    }
    for (const url of ["https://[1::2::3]", "https://[gggg::1]"]) {
      expect(qrBaseUrlProblem(url, "production"), url).toBeTruthy();
    }
    expect(qrBaseUrlProblem("https://[2001:4860:4860::8888]", "production")).toBeNull();
    expect(qrBaseUrlProblem("https://[2606:4700:4700::1111]", "production")).toBeNull();
  });

  it("defaults local mode to this computer and rejects table, outlet, token, and price arguments", () => {
    expect(parseQrArgs([], {})).toEqual({ help: false, mode: "local", baseUrl: "http://localhost:3000", outDir: "artifacts/table-qr/local" });
    expect(parseQrArgs(["--mode", "production"], { PUBLIC_BASE_URL: PUBLIC })).toMatchObject({ help: false, mode: "production", baseUrl: PUBLIC, outDir: "artifacts/table-qr/production" });
    expect(parseQrArgs(["--help"], {})).toEqual({ help: true });
    expect(() => parseQrArgs(["--mode", "production"], {})).toThrow(/public https/);
    for (const flag of ["--table", "--outlet", "--token", "--price", "T01"]) {
      expect(() => parseQrArgs([flag], {})).toThrow(TableQrError);
    }
  });

  it("refuses a production localhost run before writing files or reading tokens", async () => {
    const out = `artifacts/table-qr/refuse-${RUN}`;
    const db = {
      organization: { findFirst: () => Promise.reject(new Error("database should not be read")) },
    };
    await expect(runQrGenerate(["--mode", "production", "--base-url", "http://localhost:3000", "--out", out], db as never, {})).rejects.toThrow(/public https/);
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe("generated table QR output", () => {
  it("maps each table token to that table's guest URL and encodes it in the QR", () => {
    const pack = buildTableQrPack({ mode: "production", baseUrl: PUBLIC, restaurantName: "Coders' Cafe", tables: rowsFor(), now: new Date("2026-10-09T04:00:00.000Z") });
    expect(pack.printReady).toBe(true);
    expect(pack.notice).toBeNull();
    expect(pack.labels.map((l) => l.code)).toEqual([...CAFE_TABLE_CODES]);
    expect(CAFE_TABLE_CODES).toEqual(["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10"]);
    const urls = new Set<string>();
    const paths = new Set<string>();
    for (const label of pack.labels) {
      expect(label.url).toBe(`${PUBLIC}/t/${tokenFor(label.code)}`);
      expect(label.url).not.toContain(`/t/${label.code}`);
      expect(label.svg).toContain(qrSvgPath(label.url).d);
      expect(label.svg).toContain(`Table ${label.code}`);
      expect(label.svg).not.toContain("outlet-should-not-appear");
      urls.add(label.url);
      paths.add(qrSvgPath(label.url).d);
    }
    expect(urls.size).toBe(10);
    expect(paths.size).toBe(10);
    expect(JSON.stringify(pack.manifest)).not.toContain("outlet-should-not-appear");
    expect(JSON.stringify(pack.manifest)).not.toContain("price-should-not-appear");
    expect(pack.html).not.toContain("NOT FOR CUSTOMER PRINTING");
    expect(pack.manifest).toMatchObject({ mode: "production", printReady: true, baseUrl: PUBLIC });
  });

  it("marks a localhost sheet as a local test and writes that warning with the files", () => {
    const local = buildTableQrPack({ mode: "local", baseUrl: "http://localhost:3000/", restaurantName: "Coders <Cafe> & Co", tables: rowsFor(), now: new Date("2026-10-09T04:00:00.000Z") });
    expect(local.printReady).toBe(false);
    expect(local.baseUrl).toBe("http://localhost:3000");
    expect(local.notice).toMatch(/NOT FOR CUSTOMER PRINTING/);
    expect(local.notice).toMatch(/phone cannot open it/);
    expect(local.html).toContain("NOT FOR CUSTOMER PRINTING");
    expect(local.html).toContain("Coders &lt;Cafe&gt; &amp; Co");
    expect(local.labels[0].url).toBe(`http://localhost:3000/t/${tokenFor("T01")}`);

    const dir = `artifacts/table-qr/local-${RUN}`;
    try {
      writeTableQrFiles(dir, local);
      expect(fs.readFileSync(`${dir}/NOT-FOR-CUSTOMER-PRINTING.txt`, "utf8")).toMatch(/NOT FOR CUSTOMER PRINTING/);
      const manifest = JSON.parse(fs.readFileSync(`${dir}/manifest.json`, "utf8"));
      expect(manifest.printReady).toBe(false);
      expect(manifest.tables).toHaveLength(10);
      expect(fs.readFileSync(`${dir}/T07.svg`, "utf8")).toContain(qrSvgPath(local.labels.find((l) => l.code === "T07")!.url).d);
      expect(fs.readFileSync(`${dir}/labels.html`, "utf8")).toContain("NOT FOR CUSTOMER PRINTING");
      expect(() => writeTableQrFiles(dir, { ...local, printReady: true })).toThrow(/print-ready/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a production sheet only for a public https URL, without the local warning", () => {
    const pack = buildTableQrPack({ mode: "production", baseUrl: `${PUBLIC}/`, restaurantName: "Coders' Cafe", tables: rowsFor(), now: new Date("2026-10-09T04:00:00.000Z") });
    const dir = `artifacts/table-qr/production-${RUN}`;
    try {
      writeTableQrFiles(dir, pack);
      expect(fs.existsSync(`${dir}/NOT-FOR-CUSTOMER-PRINTING.txt`)).toBe(false);
      expect(JSON.parse(fs.readFileSync(`${dir}/manifest.json`, "utf8")).printReady).toBe(true);
      expect(fs.readFileSync(`${dir}/labels.html`, "utf8")).not.toContain("NOT FOR CUSTOMER PRINTING");
      expect(fs.readdirSync(dir).filter((name) => name.endsWith(".svg")).sort()).toEqual(CAFE_TABLE_CODES.map((code) => `${code}.svg`));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing, invalid, and duplicate tokens", () => {
    expect(() => guestOrderingUrl(PUBLIC, "T01")).toThrow(TableQrError);
    const missing = rowsFor().filter((row) => row.code !== "T04");
    expect(() => buildTableQrPack({ mode: "local", baseUrl: "http://localhost:3000", restaurantName: "Coders' Cafe", tables: missing })).toThrow(/Missing QR token for T04/);
    const invalid = rowsFor().map((row) => (row.code === "T02" ? { ...row, qrToken: "nope" } : row));
    expect(() => buildTableQrPack({ mode: "local", baseUrl: "http://localhost:3000", restaurantName: "Coders' Cafe", tables: invalid })).toThrow(/T02 has no valid QR token/);
    const shared = tokenFor("T01");
    const duplicate = rowsFor().map((row) => (row.code === "T10" ? { ...row, qrToken: shared } : row));
    expect(() => buildTableQrPack({ mode: "production", baseUrl: PUBLIC, restaurantName: "Coders' Cafe", tables: duplicate })).toThrow(/T01 and T10 share one QR token/);
    expect(() => buildTableQrPack({ mode: "production", baseUrl: "http://localhost:3000", restaurantName: "Coders' Cafe", tables: rowsFor() })).toThrow(/public https/);
  });

  it("rejects an invalid pack and a blank output path before creating any files", () => {
    const local = buildTableQrPack({ mode: "local", baseUrl: "http://localhost:3000", restaurantName: "Coders' Cafe", tables: rowsFor(), now: new Date("2026-10-09T04:00:00.000Z") });
    const prod = buildTableQrPack({ mode: "production", baseUrl: PUBLIC, restaurantName: "Coders' Cafe", tables: rowsFor(), now: new Date("2026-10-09T04:00:00.000Z") });
    const dir = `artifacts/table-qr/partial-${RUN}`;
    const prodDir = `artifacts/table-qr/partial-prod-${RUN}`;
    const outside = `outside-qr-${RUN}`;
    const absolute = `/no-such-restora-qr-${RUN}`;
    const broken = {
      ...local,
      labels: local.labels.map((label, i) => (i === 3 ? { ...label, code: "NOPE" } : label)),
      manifest: { ...local.manifest, tables: local.manifest.tables.map((row, i) => (i === 3 ? { ...row, code: "NOPE" } : row)) },
    };
    const swapped = {
      ...local,
      labels: local.labels.map((label, i) => (i === 0 ? { ...label, svg: local.labels[1].svg } : label)),
    };
    const queriedUrl = `${local.labels[0].url}?table=T01`;
    const queried = {
      ...local,
      labels: local.labels.map((label, i) => (i === 0 ? { ...label, url: queriedUrl, svg: qrSvgDocument(queriedUrl, "Table T01") } : label)),
      manifest: { ...local.manifest, tables: local.manifest.tables.map((row, i) => (i === 0 ? { ...row, url: queriedUrl } : row)) },
    };
    const sheet = { ...local, html: `<html>${local.restaurantName}${local.notice}</html>` };
    const blankNotice = { ...local, notice: " \n\t", manifest: { ...local.manifest, notice: " \n\t" } };
    const notReady = { ...prod, printReady: false, manifest: { ...prod.manifest, printReady: false } };
    try {
      expect(() => writeTableQrFiles(dir, broken)).toThrow(/unexpected table code/);
      expect(() => writeTableQrFiles(dir, swapped)).toThrow(/does not encode the guest URL/);
      expect(() => writeTableQrFiles(dir, queried)).toThrow(/guest URL is not allowed/);
      expect(() => writeTableQrFiles(dir, sheet)).toThrow(/sheet does not match/);
      expect(() => writeTableQrFiles(dir, blankNotice)).toThrow(/print-ready/);
      expect(() => writeTableQrFiles(prodDir, notReady)).toThrow(/print-ready/);
      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.existsSync(prodDir)).toBe(false);
      for (const blank of ["", "   ", "\n\t"]) {
        expect(() => writeTableQrFiles(blank, local), JSON.stringify(blank)).toThrow(/Output directory is required/);
      }
      expect(() => writeTableQrFiles(absolute, local)).toThrow(/relative path/);
      expect(() => writeTableQrFiles(`artifacts/${outside}/../../${outside}`, local)).toThrow(/inside the project/);
      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.existsSync(prodDir)).toBe(false);
      expect(fs.existsSync(absolute)).toBe(false);
      expect(fs.existsSync(outside)).toBe(false);
      expect(fs.existsSync(`artifacts/${outside}`)).toBe(false);

      const crashDir = `artifacts/table-qr/crash-${RUN}`;
      const disk = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      try {
        expect(() => writeTableQrFiles(crashDir, local)).toThrow(/disk full/);
        expect(fs.existsSync(crashDir)).toBe(false);
      } finally {
        disk.mockRestore();
        fs.rmSync(crashDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(prodDir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(`artifacts/${outside}`, { recursive: true, force: true });
    }
  });
});

describe("table token mapping and checkout protections", () => {
  const tokens = new Map<string, string>();
  let orgId = "";
  let outletId = "";
  let itemId = "";

  beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `QR Labels ${RUN}` } })).id;
    outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `QL${RUN}`, name: "Label Outlet" } })).id;
    const sys = systemContext(orgId, [outletId]);
    itemId = (await createMenuItem(sys, { name: `Fries ${RUN}`, price: 120, taxPct: 5 })).id;
    for (const code of CAFE_TABLE_CODES) {
      const qrToken = tokenFor(code);
      await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code, qrToken } });
      tokens.set(code, qrToken);
    }
  });

  it("resolves each stored token to that table's menu and rejects anything else", async () => {
    await expect(prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: "T99", qrToken: tokenFor("T01") } })).rejects.toMatchObject({ code: "P2002" });

    for (const code of CAFE_TABLE_CODES) {
      const token = tokens.get(code)!;
      expect((await resolveTable(token)).table.code).toBe(code);
      const menu = await guestMenu(token);
      expect(menu.table).toEqual({ code });
      expect(menu.menu.map((item) => item.id)).toEqual([itemId]);
      expect(menu.menu[0].price).toBe(120);
      expect(JSON.stringify(menu)).not.toContain(outletId);
      expect(JSON.stringify(menu)).not.toContain(orgId);
    }
    expect((await resolveTable(tokens.get("T01")!)).table.code).not.toBe("T02");

    for (const bad of ["", "T01", "x", "../../etc", "a".repeat(80), "unknown-token-123"]) {
      await expect(resolveTable(bad)).rejects.toBeInstanceOf(NotFoundError);
    }

    const decoyToken = `decoy${RUN}tokenxxxx`;
    const decoyOrg = await prisma.organization.create({ data: { name: `Not Cafe ${RUN}` } });
    const decoyOutlet = await prisma.outlet.create({ data: { organizationId: decoyOrg.id, code: `DC${RUN}`, name: "Decoy" } });
    await prisma.restaurantTable.create({ data: { organizationId: decoyOrg.id, outletId: decoyOutlet.id, code: "T01", qrToken: decoyToken } });
    // The suite shares one database. Another file may already have seeded Coders' Cafe.
    // Park that organization for this assertion only, then put the name back.
    const parked: Array<{ id: string; name: string }> = [];
    let caught: unknown;
    try {
      for (;;) {
        const cafe = await findCafe(prisma);
        if (!cafe) break;
        parked.push({ id: cafe.id, name: cafe.name });
        await prisma.organization.update({ where: { id: cafe.id }, data: { name: `Hidden cafe ${RUN} ${cafe.id}` } });
      }
      try {
        await loadCafeTableRows(prisma);
      } catch (e) {
        caught = e;
      }
    } finally {
      for (const org of parked) await prisma.organization.update({ where: { id: org.id }, data: { name: org.name } });
    }
    expect(caught).toBeInstanceOf(TableQrError);
    expect((caught as Error).message).toMatch(/Coders' Cafe is not in this database/);
    expect((caught as Error).message).not.toContain(decoyToken);
    if (parked.length) {
      const restored = await loadCafeTableRows(prisma);
      expect(restored.map((row) => row.code)).toEqual([...CAFE_TABLE_CODES]);
      expect(restored.some((row) => row.qrToken === decoyToken)).toBe(false);
    }
  });

  it("quoting or scanning does not create an order, a payment, or a kitchen ticket", async () => {
    const token = tokens.get("T03")!;
    const before = await prisma.order.count({ where: { organizationId: orgId } });
    const key = `qr-label-${RUN}-bad1`;
    await expect(quoteGuestCart(token, { items: [{ menuItemId: itemId, qty: 1, unitPrice: 1 }], total: 1, outletId, tableId: "client-table" })).rejects.toBeInstanceOf(ZodError);
    await expect(placeGuestOrder(token, { items: [{ menuItemId: itemId, qty: 1 }], submit: true, outletId, tableId: "client-table", paymentMethod: "ONLINE" }, key)).rejects.toBeInstanceOf(ZodError);
    await expect(quoteGuestCart("unknown-token-123", { items: [{ menuItemId: itemId, qty: 1 }] })).rejects.toBeInstanceOf(NotFoundError);
    const quote = await quoteGuestCart(token, { items: [{ menuItemId: itemId, qty: 2 }] });
    expect(quote.lines[0]).toMatchObject({ ok: true, unitPrice: "120.00", qty: 2 });
    expect(quote.total).not.toBe("1.00");
    expect(await prisma.order.count({ where: { organizationId: orgId } })).toBe(before);

    const placed = await placeGuestOrder(token, { items: [{ menuItemId: itemId, qty: 1 }] }, `qr-label-${RUN}-ok`);
    const view = await getGuestOrder(placed.orderId, placed.accessKey);
    expect(view).toMatchObject({ status: "OPEN", fulfilment: "AWAITING_ACCEPTANCE" });
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId }, include: { kots: true, payments: true } });
    expect(stored).toMatchObject({ status: "OPEN", source: "QR", channel: "QR", outletId, tableId: (await resolveTable(token)).table.id });
    expect(stored.kots).toHaveLength(0);
    expect(stored.payments).toHaveLength(0);
    await expect(confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: "forged", gateway: { status: "captured" } })).rejects.toBeInstanceOf(NotFoundError);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId }, include: { payments: true, kots: true } });
    expect(after.status).toBe("OPEN");
    expect(after.payments).toHaveLength(0);
    expect(after.kots).toHaveLength(0);
  });
});
