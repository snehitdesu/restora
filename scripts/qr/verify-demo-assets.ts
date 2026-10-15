/**
 * Decode every generated demo PNG and check it against cafeTableToken.
 *   npx tsx scripts/qr/verify-demo-assets.ts <dir>
 * Writes <dir>/verification.json. Never prints or stores a token or full URL.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import jsQR from "jsqr";
import { cafeTableToken } from "../../prisma/coders-cafe/seed";
import { CAFE_TABLE_CODES } from "@/server/qr/tableLabels";
import { guestTableUrl, parseTableQr } from "@/lib/qr/tableQrUrl";
import { DEMO_ORIGINS, DEMO_WARNING, sheetHtml, buildDemoPayloads } from "./demo-assets";

// pngjs is a transitive dependency without bundled types; used only by this script.
const { PNG } = createRequire(import.meta.url)("pngjs") as { PNG: { sync: { read(b: Buffer): { data: Buffer; width: number; height: number } } } };

export function decodePng(buf: Buffer): { text: string | null; width: number; height: number } {
  const png = PNG.sync.read(buf);
  const r = jsQR(new Uint8ClampedArray(png.data), png.width, png.height, { inversionAttempts: "dontInvert" });
  return { text: r?.data ?? null, width: png.width, height: png.height };
}

export function checkPayload(code: string, decoded: string | null, origin: string) {
  const parsed = parseTableQr(decoded ?? "", { trustedOrigins: [origin] });
  const route = parsed.ok && decoded !== null && /^https:\/\/[^/]+\/t\/[^/?#]+$/.test(decoded);
  const sameOrigin = parsed.ok && parsed.origin === origin;
  const matchesSeed = decoded === guestTableUrl(origin, cafeTableToken(code));
  return { route: !!route, origin: !!sameOrigin, matchesSeedToken: matchesSeed };
}

function pdfFacts(file: string) {
  const s = fs.readFileSync(file).toString("latin1");
  const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(s);
  const pages = (s.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  return { bytes: s.length, header: s.startsWith("%PDF-"), eof: s.includes("%%EOF"), pages, mediaBox: box ? [Number(box[1]), Number(box[2])] : null };
}

async function main() {
  const dir = path.resolve(process.argv[2] ?? "");
  if (!process.argv[2] || !fs.existsSync(dir)) throw new Error("Pass the output directory.");
  const origin = DEMO_ORIGINS[0];
  const tables = CAFE_TABLE_CODES.map((code) => {
    const f = path.join(dir, `${code}.png`);
    const exists = fs.existsSync(f);
    const buf = exists ? fs.readFileSync(f) : Buffer.alloc(0);
    const d = exists && buf.length ? decodePng(buf) : { text: null, width: 0, height: 0 };
    return { code, file: `${code}.png`, bytes: buf.length, width: d.width, height: d.height, decoded: d.text, ...checkPayload(code, d.text, origin) };
  });
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const t of tables) { if (t.decoded) { if (seen.has(t.decoded)) dupes.add(t.code); seen.add(t.decoded); } }

  // The print sheet: render its HTML, decode each QR cell, and confirm the labels/warnings it holds.
  const payloads = buildDemoPayloads(origin);
  const html = sheetHtml(payloads);
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  const sheetQr: Record<string, ReturnType<typeof checkPayload>> = {};
  try {
    const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 3 });
    await page.setContent(html);
    for (const code of CAFE_TABLE_CODES) {
      const shot = await page.locator(`.qr[data-code="${code}"]`).screenshot();
      sheetQr[code] = checkPayload(code, decodePng(shot).text, origin);
    }
  } finally { await browser.close(); }
  const sheetLabels = CAFE_TABLE_CODES.every((c) => html.includes(`<div class="code">${c}</div>`));
  const sheetWarnings = (html.split(DEMO_WARNING).length - 1) >= CAFE_TABLE_CODES.length + 1;

  const pdfPath = path.join(dir, "coders-cafe-qr-print-sheet.pdf");
  const pdf = fs.existsSync(pdfPath) ? pdfFacts(pdfPath) : null;
  const a4 = !!pdf?.mediaBox && Math.abs(pdf.mediaBox[0] - 595.28) < 1.5 && Math.abs(pdf.mediaBox[1] - 841.89) < 1.5;

  const rows = tables.map(({ decoded, ...t }) => ({
    ...t,
    decodedOk: decoded !== null,
    uniquePayload: !dupes.has(t.code),
    sheetQr: sheetQr[t.code],
    pass: decoded !== null && t.bytes > 5000 && t.width >= 1000 && t.route && t.origin && t.matchesSeedToken && !dupes.has(t.code) && Object.values(sheetQr[t.code]).every(Boolean),
  }));
  const report = {
    label: DEMO_WARNING,
    generatedAt: new Date().toISOString(),
    origin,
    tablesGenerated: rows.length,
    allPngPass: rows.every((r) => r.pass),
    tables: rows,
    pdf: {
      file: "coders-cafe-qr-print-sheet.pdf",
      ...pdf,
      a4,
      pagesIsOne: pdf?.pages === 1,
      sheetHtmlHasAllTableLabels: sheetLabels,
      sheetHtmlHasWarnings: sheetWarnings,
      limitation: "No PDF text extractor is installed; labels/warnings were verified in the exact HTML the PDF was printed from, and the PDF's page size/count from its structure.",
    },
    notes: ["No tokens or full URLs are stored in this report.", "Codes are DEMO / NOT FOR CUSTOMER USE."],
  };
  fs.writeFileSync(path.join(dir, "verification.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(`tables=${rows.length} allPngPass=${report.allPngPass} pdfA4=${a4} pages=${pdf?.pages}\n`);
  for (const r of rows) process.stdout.write(`${r.code} ${r.pass ? "PASS" : "FAIL"} ${r.width}x${r.height}\n`);
  if (!report.allPngPass || !a4) process.exitCode = 1;
}
const entry = process.argv[1];
if (entry && import.meta.url.endsWith(path.basename(entry))) {
  main().catch((e: unknown) => {
    process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
    process.exitCode = 1;
  });
}
