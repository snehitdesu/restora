/**
 * Coders' Cafe DEMO table QR images (T01–T10) + an A4 print sheet.
 *
 *   npx tsx scripts/qr/demo-assets.ts
 *   npx tsx scripts/qr/demo-assets.ts --out artifacts/coders-cafe-qr
 *
 * Reads no database and no environment. Each payload is the existing guest
 * route `/t/<token>` with the LEGACY token from `legacyCafeTableToken` (what
 * the demo seed stored before 2026-10-20), on one of the allow-listed public
 * origins. Those tokens are derived from public constants, so every image is
 * stamped DEMO / NOT FOR CUSTOMER USE, and the images stop working once
 * Production's tables are rotated (docs/qr-token-rotation.md). Nothing is created, rotated or written to a
 * database. An existing, non-empty output directory is never overwritten: the
 * files go into a timestamped child directory instead.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { legacyCafeTableToken } from "../../prisma/coders-cafe/seed";
import { CAFE_TABLE_CODES, TableQrError, buildTableQrPack } from "@/server/qr/tableLabels";
import { qrSvgPath } from "@/lib/qrSvg";
import { guestTableUrl } from "@/lib/qr/tableQrUrl";

/** The only origins these demo images may point at. */
export const DEMO_ORIGINS = ["https://restora-beta-six.vercel.app"] as const;
export const DEMO_WARNING = "DEMO / NOT FOR CUSTOMER USE";
export const DEFAULT_OUT = "artifacts/coders-cafe-qr";

export type DemoPayload = { code: string; url: string; token: string };

/** T01–T10 payloads from the seed's own token function. Refuses any origin that is not allow-listed. */
export function buildDemoPayloads(origin: string, codes: readonly string[] = CAFE_TABLE_CODES): DemoPayload[] {
  const clean = (() => {
    try {
      return new URL(origin).origin;
    } catch {
      return "";
    }
  })();
  if (!clean || !(DEMO_ORIGINS as readonly string[]).includes(clean) || origin.trim() !== clean) {
    throw new TableQrError("Origin is not an allowed demo origin; no QR codes were generated.");
  }
  if (!codes.length) throw new TableQrError("No table codes to generate.");
  const rows = codes.map((code) => {
    if (!/^T\d{2}$/.test(code)) throw new TableQrError(`Unsupported table code ${JSON.stringify(code)}.`);
    return { code, qrToken: legacyCafeTableToken(code) };
  });
  // buildTableQrPack applies the repo's own URL/token/duplicate checks.
  const pack = buildTableQrPack({ mode: "local", baseUrl: clean, restaurantName: "Coders' Cafe", tables: rows, expectedCodes: codes });
  return pack.labels.map((l, i) => {
    const url = guestTableUrl(clean, rows[i].qrToken);
    if (url !== l.url) throw new TableQrError(`Table ${l.code}: URL helpers disagree.`);
    return { code: l.code, url, token: rows[i].qrToken };
  });
}

/** Output directory: the requested one if absent/empty, else a timestamped child. Relative paths only. */
export function resolveOutDir(rel: string, now = new Date(), root = process.cwd()): string {
  if (!rel || path.isAbsolute(rel) || rel.split(/[/\\]/).includes("..")) throw new TableQrError("Output directory must be a relative path inside the project.");
  const abs = path.resolve(root, rel);
  if (fs.existsSync(abs) && fs.readdirSync(abs).length > 0) {
    return path.join(abs, now.toISOString().replace(/[:.]/g, "-"));
  }
  return abs;
}

const COLORS = { cream: "#fbf5ea", paper: "#fffdf8", ink: "#3a2418", terracotta: "#c85a35", terraDark: "#923b1f", line: "#e6d6c0" };
const FONT = `"Segoe UI", "Helvetica Neue", Arial, sans-serif`;

function qrSvg(url: string, px: number): string {
  const { size, d } = qrSvgPath(url);
  const k = Math.max(1, Math.floor(px / size));
  const w = size * k;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${w}" height="${w}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

const BASE_CSS = `*{box-sizing:border-box;margin:0}body{font-family:${FONT};color:${COLORS.ink};background:${COLORS.cream}}`;

export function tableCardHtml(p: DemoPayload): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
.card{width:1000px;height:1300px;background:${COLORS.paper};border:6px solid ${COLORS.ink};display:flex;flex-direction:column}
.top{background:${COLORS.terracotta};color:#fff;padding:34px 48px;display:flex;justify-content:space-between;align-items:baseline}
.top b{font-size:44px;letter-spacing:.14em}.top span{font-size:34px}
.mid{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px}
.code{font-size:150px;font-weight:800;letter-spacing:.04em;line-height:1}
.qr{border:4px solid ${COLORS.ink};line-height:0;background:#fff}
.hint{font-size:34px;color:${COLORS.terraDark}}
.warn{background:#b3261e;color:#fff;text-align:center;font-weight:800;font-size:44px;letter-spacing:.04em;padding:30px 20px}
</style></head><body><div class="card" id="card">
<div class="top"><b>RESTORA</b><span>Coders' Cafe</span></div>
<div class="mid"><div class="code">${p.code}</div><div class="qr" id="qr">${qrSvg(p.url, 700)}</div><div class="hint">Scan with the phone camera</div></div>
<div class="warn">${DEMO_WARNING}</div></div></body></html>`;
}

export function sheetHtml(payloads: DemoPayload[]): string {
  const cells = payloads
    .map(
      (p) => `<div class="cell"><div class="qr" data-code="${p.code}">${qrSvg(p.url, 400)}</div>
<div class="meta"><div class="code">${p.code}</div><div class="hint">Table ${p.code}</div><div class="w">${DEMO_WARNING}</div></div></div>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Coders' Cafe table QR sheet (DEMO)</title><style>
@page{size:A4;margin:0}${BASE_CSS}
.page{width:210mm;height:297mm;padding:10mm 10mm 8mm;background:${COLORS.cream};display:flex;flex-direction:column}
header{background:${COLORS.terracotta};color:#fff;padding:5mm 6mm;display:flex;justify-content:space-between;align-items:baseline;border-radius:2mm}
header b{font-size:7mm;letter-spacing:.14em}header span{font-size:5mm}
.banner{background:#b3261e;color:#fff;text-align:center;font-weight:800;font-size:6mm;padding:3mm;margin:3mm 0;border-radius:2mm;letter-spacing:.03em}
.grid{flex:1;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:repeat(5,1fr);gap:3mm}
.cell{background:${COLORS.paper};border:.4mm solid ${COLORS.line};border-radius:2mm;display:flex;align-items:center;gap:5mm;padding:3mm 4mm}
.qr{line-height:0;border:.3mm solid ${COLORS.ink};flex:none}.qr svg{width:38mm;height:38mm}
.code{font-size:13mm;font-weight:800;line-height:1}.hint{font-size:4mm;color:${COLORS.terraDark};margin-top:1.5mm}
.w{margin-top:3mm;font-size:3.2mm;font-weight:800;color:#b3261e;line-height:1.25}
footer{font-size:3mm;color:${COLORS.terraDark};text-align:center;margin-top:2mm}
</style></head><body><div class="page"><header><b>RESTORA</b><span>Coders' Cafe — table QR codes T01–T10</span></header>
<div class="banner">${DEMO_WARNING} — do not place on tables</div>
<div class="grid">${cells}</div>
<footer>Demo codes: tokens are derived from public constants and ordering is not production-ready.</footer></div></body></html>`;
}

export type RenderResult = { dir: string; pngs: string[]; pdf: string; payloads: DemoPayload[] };

export async function renderAssets(origin: string, outRel: string): Promise<RenderResult> {
  const payloads = buildDemoPayloads(origin);
  const dir = resolveOutDir(outRel);
  fs.mkdirSync(dir, { recursive: true });
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 1300 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const pngs: string[] = [];
    for (const p of payloads) {
      await page.setContent(tableCardHtml(p));
      const file = path.join(dir, `${p.code}.png`);
      await page.locator("#card").screenshot({ path: file });
      pngs.push(file);
    }
    const pdfPage = await browser.newPage();
    await pdfPage.setContent(sheetHtml(payloads));
    const pdf = path.join(dir, "coders-cafe-qr-print-sheet.pdf");
    await pdfPage.pdf({ path: pdf, format: "A4", printBackground: true, preferCSSPageSize: true });
    return { dir, pngs, pdf, payloads };
  } finally {
    await browser.close();
  }
}

async function main() {
  const i = process.argv.indexOf("--out");
  const out = i >= 0 ? process.argv[i + 1] : DEFAULT_OUT;
  try {
    const r = await renderAssets(DEMO_ORIGINS[0], out);
    process.stdout.write(`${r.pngs.length} PNG + 1 PDF written to ${r.dir}\n${DEMO_WARNING}\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) void main();
