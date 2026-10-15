import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cafeTableToken } from "../../prisma/coders-cafe/seed";
import { DEMO_ORIGINS, DEMO_WARNING, buildDemoPayloads, resolveOutDir, sheetHtml, tableCardHtml } from "../../scripts/qr/demo-assets";
import { checkPayload } from "../../scripts/qr/verify-demo-assets";
import { guestTableUrl } from "@/lib/qr/tableQrUrl";

const origin = DEMO_ORIGINS[0];

describe("demo table QR payloads", () => {
  it("maps T01–T10 to /t/<cafeTableToken> on the allowed origin, all distinct", () => {
    const p = buildDemoPayloads(origin);
    expect(p.map((x) => x.code)).toEqual(["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10"]);
    for (const x of p) expect(x.url).toBe(guestTableUrl(origin, cafeTableToken(x.code)));
    expect(new Set(p.map((x) => x.url)).size).toBe(10);
  });

  it.each([
    "http://restora-beta-six.vercel.app",
    "https://evil.example.com",
    "https://restora-beta-six.vercel.app/path",
    "https://restora-beta-six.vercel.app/?next=//evil",
    "javascript:alert(1)",
    "",
    "not a url",
  ])("refuses untrusted origin %j", (o) => {
    expect(() => buildDemoPayloads(o)).toThrow(/allowed demo origin/);
  });

  it("refuses unsupported table codes and an empty list", () => {
    expect(() => buildDemoPayloads(origin, ["T1"])).toThrow(/Unsupported/);
    expect(() => buildDemoPayloads(origin, ["../x"])).toThrow(/Unsupported/);
    expect(() => buildDemoPayloads(origin, [])).toThrow(/No table codes/);
  });

  it("stamps the demo warning on every card and the sheet", () => {
    const p = buildDemoPayloads(origin);
    expect(tableCardHtml(p[0])).toContain(DEMO_WARNING);
    expect(sheetHtml(p).split(DEMO_WARNING).length - 1).toBeGreaterThanOrEqual(11);
    expect(sheetHtml(p)).not.toContain("/t/");
  });

  it("checkPayload rejects a wrong table's payload, other origins and junk", () => {
    const t1 = guestTableUrl(origin, cafeTableToken("T01"));
    expect(Object.values(checkPayload("T01", t1, origin)).every(Boolean)).toBe(true);
    expect(checkPayload("T02", t1, origin).matchesSeedToken).toBe(false);
    expect(checkPayload("T01", guestTableUrl("https://other.example.com", cafeTableToken("T01")), origin).origin).toBe(false);
    expect(checkPayload("T01", null, origin).route).toBe(false);
  });
});

describe("resolveOutDir", () => {
  it("uses the directory when empty/absent, a timestamped child when it has files, and refuses escapes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qr-out-"));
    try {
      expect(resolveOutDir("o", new Date(), root)).toBe(path.join(root, "o"));
      fs.mkdirSync(path.join(root, "o"));
      fs.writeFileSync(path.join(root, "o", "x"), "1");
      const child = resolveOutDir("o", new Date("2026-10-15T01:02:03.000Z"), root);
      expect(path.dirname(child)).toBe(path.join(root, "o"));
      expect(path.basename(child)).toBe("2026-10-15T01-02-03-000Z");
      expect(() => resolveOutDir("../x", new Date(), root)).toThrow();
      expect(() => resolveOutDir(path.join(root, "abs"), new Date(), root)).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
