/**
 * Table QR tokens are bearer secrets. Routine output — the Coders' Cafe seed
 * report and the guest API's slow-request log — must never contain one.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { cafeQrStatusLines } from "../../prisma/coders-cafe/qrStatus";
import { CAFE } from "../../prisma/coders-cafe/seed";
import { createGuestRouter } from "@/server/api/guestRouter";
import { setLogSink } from "@/server/observability/log";
import { SLOW_REQUEST_MS } from "@/server/observability/timing";

// Fixture only: shaped like a real token, never stored anywhere.
const TOKEN = "fixtureTok_Zq8xW3vN5mR1pL7kD2";

describe("seed QR status output", () => {
  const codes = CAFE.tableCodes;
  const allTables = codes.map((code) => ({ code, hasQrToken: true }));

  it("reports table counts and label commands without any token or guest link", () => {
    for (const baseUrl of [undefined, "", "http://localhost:3000", "http://192.168.1.4:3000/", "https://menus.example.com", "not a url", "http://user:pw@localhost:3000", `http://localhost:3000/t/${TOKEN}`]) {
      const out = cafeQrStatusLines({ baseUrl, tableCodes: codes, tables: allTables }).join("\n");
      expect(out, String(baseUrl)).toContain(`${codes.length} of ${codes.length} tables have a QR token stored (tokens are not printed)`);
      expect(out, String(baseUrl)).toMatch(/npm run qr:tables -- (--mode production )?--base-url /);
      expect(out, String(baseUrl)).not.toContain(TOKEN);
      expect(out, String(baseUrl)).not.toContain("/t/");
      expect(out, String(baseUrl)).not.toContain("user:pw");
    }
  });

  it("names tables without a token and echoes only a valid origin", () => {
    const out = cafeQrStatusLines({ baseUrl: "https://menus.example.com/", tableCodes: codes, tables: allTables.filter((t) => t.code !== "T03" && t.code !== "T07") });
    expect(out).toContain(`\nTable QR: ${codes.length - 2} of ${codes.length} tables have a QR token stored (tokens are not printed).`);
    expect(out).toContain("No QR token: T03, T07");
    expect(out).toContain("Print customer labels with: npm run qr:tables -- --mode production --base-url https://menus.example.com");

    const local = cafeQrStatusLines({ baseUrl: "http://192.168.1.4:3000", tableCodes: codes, tables: allTables });
    expect(local).toContain("Local test labels (not for customer printing): npm run qr:tables -- --base-url http://192.168.1.4:3000");
    expect(local).toContain("Customer labels: npm run qr:tables -- --mode production --base-url <public https address>");
  });

  it("the seed script never selects or prints table tokens", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "prisma/seed-coders-cafe.ts"), "utf8");
    expect(src).not.toMatch(/guestOrderingUrl/);
    expect(src).not.toMatch(/select:\s*\{[^}]*qrToken/);
    expect(src).toMatch(/cafeQrStatusLines\(/);
  });
});

describe("guest API slow-request log", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("logs the route pattern, not the token in the request path", async () => {
    const lines: string[] = [];
    restore = setLogSink((_level, line) => lines.push(line));
    const router = createGuestRouter([
      { method: "GET", path: "t/:token", handler: async () => { await new Promise((r) => setTimeout(r, SLOW_REQUEST_MS + 50)); return { served: true }; } },
    ]);
    const req = new NextRequest(`http://localhost/api/qr/t/${TOKEN}`, { headers: { "x-forwarded-for": `10.9.${Date.now() % 250}.7` } });
    const res = await router.GET(req, { params: Promise.resolve({ path: ["t", TOKEN] }) });
    expect(res.status).toBe(200);

    const slow = lines.filter((l) => l.includes("slow_request"));
    expect(slow).toHaveLength(1);
    expect(slow[0]).toContain("/api/qr/t/:token");
    for (const line of lines) expect(line).not.toContain(TOKEN);
  });
});
