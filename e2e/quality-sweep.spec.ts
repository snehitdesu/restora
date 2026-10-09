/**
 * QUALITY-001 responsive sweep: every screen at ten viewports (a 320 px phone to a 1920 px monitor, with a phone held sideways):
 * the page loads, throws nothing in the console, and never scrolls sideways (wide tables scroll inside their own box).
 * QUALITY-002 accessibility sweep: every screen at a phone and a desktop width is scanned with axe (WCAG 2.1 A and AA); no
 * serious or critical violation may remain, apart from the ones listed with a reason in KNOWN below.
 *
 * Set QUALITY_COLLECT=1 to print everything found instead of failing on it (QUALITY_REPORT=<file> also writes it as JSON).
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { statePath, apiAs, apiData, outletByCode, CENTRAL } from "./helpers";

const COLLECT = process.env.QUALITY_COLLECT === "1";

const VIEWPORTS = [
  { name: "phone 320x568", width: 320, height: 568 },
  { name: "phone 360x740", width: 360, height: 740 },
  { name: "phone 390x844", width: 390, height: 844 },
  { name: "phone 414x896", width: 414, height: 896 },
  { name: "phone landscape 740x360", width: 740, height: 360 },
  { name: "tablet 768x1024", width: 768, height: 1024 },
  { name: "tablet landscape 1024x768", width: 1024, height: 768 },
  { name: "laptop 1280x720", width: 1280, height: 720 },
  { name: "desktop 1440x900", width: 1440, height: 900 },
  { name: "monitor 1920x1080", width: 1920, height: 1080 },
] as const;

/** Staff screens, signed in as the owner. */
const OWNER_PAGES = [
  "/dashboard", "/pos", "/kitchen", "/captain", "/manager", "/tables", "/reservations", "/notifications",
  "/menu", "/menu/categories", "/menu/modifiers", "/recipes",
  "/master/materials", "/master/vendors", "/master/units",
  "/inventory", "/inventory/ledger", "/inventory/matrix", "/inventory/counts", "/inventory/issues", "/inventory/transfers", "/inventory/wastage", "/inventory/production", "/inventory/worksheet", "/inventory/variance", "/inventory/expiry", "/inventory/labels",
  "/procurement/queue", "/procurement/reorder", "/procurement/indents", "/procurement/purchase-orders", "/procurement/grns", "/procurement/bills", "/procurement/payments", "/procurement/prices",
  "/finance", "/finance/money-desk", "/finance/payments", "/finance/expenses", "/finance/petty-cash", "/finance/drawer", "/finance/reconciliation", "/finance/aggregators",
  "/analytics", "/analytics/menu-engineering", "/analytics/departments", "/analytics/prep-times", "/reports", "/exports", "/anomalies", "/audit",
  "/customers", "/customers/segments", "/customers/loyalty", "/customers/coupons", "/customers/campaigns", "/customers/feedback", "/customers/growth-settings",
  "/staff", "/staff/roster", "/staff/attendance", "/staff/leave", "/staff/tasks", "/staff/checklists",
  "/settings/organization", "/settings/outlets", "/settings/departments", "/settings/printers", "/settings/integrations", "/settings/purchasing",
  "/account/password",
];
/** A representative cross-section for the viewports that are not the main phone / tablet / desktop ones. */
const CORE = ["/dashboard", "/pos", "/kitchen", "/menu", "/master/materials", "/inventory", "/procurement/purchase-orders", "/finance", "/reports", "/customers", "/staff/roster", "/settings/organization", "/tables"];
/** Public screens: no session. */
const PUBLIC_PAGES = ["/", "/product", "/solutions", "/resources", "/security", "/privacy", "/terms", "/download", "/login", "/forgot-password"];

/** Axe findings accepted with a reason. Anything else serious or critical fails. */
const KNOWN: Array<{ rule: string; reason: string }> = [];

type Finding = { page: string; viewport: string; kind: string; detail: string };
const findings: Finding[] = [];
const report = (f: Finding) => (COLLECT ? findings.push(f) : expect.soft(false, `${f.viewport} ${f.page}: ${f.kind}: ${f.detail}`).toBe(true));

async function settle(page: Page) {
  // Client screens fetch after hydration: wait for their loading indicators to go.
  await page.waitForLoadState("load");
  await page.waitForFunction(() => !document.querySelector('main [role="status"], [aria-busy="true"]') || document.querySelectorAll('main [role="status"]').length === 0, undefined, { timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(250);
}

async function dynamicPages(owner: APIRequestContext): Promise<string[]> {
  const out: string[] = [];
  const first = async (url: string, pick: (d: any) => string | undefined, href: (id: string) => string) => {
    try {
      const id = pick(await apiData<unknown>(owner, url));
      if (id) out.push(href(id));
    } catch { /* a screen without data is skipped */ }
  };
  const central = await outletByCode(owner, CENTRAL);
  await first("/api/master/materials?take=1", (d) => d.items?.[0]?.id, (id) => `/master/materials/${id}`);
  await first("/api/master/vendors?take=1", (d) => d.items?.[0]?.id, (id) => `/master/vendors/${id}`);
  await first("/api/recipes?take=1", (d) => (d.items ?? d)?.[0]?.id, (id) => `/recipes/${id}`);
  await first("/api/menu", (d) => (d.items ?? d)?.[0]?.id, (id) => `/menu/items/${id}`);
  await first(`/api/procurement/purchase-orders?outletId=${central.id}&take=1`, (d) => d.items?.[0]?.id, (id) => `/procurement/purchase-orders/${id}`);
  await first(`/api/procurement/indents?outletId=${central.id}&take=1`, (d) => d.items?.[0]?.id, (id) => `/procurement/indents/${id}`);
  await first("/api/customers?take=1", (d) => d.items?.[0]?.id, (id) => `/customers/${id}`);
  return out;
}

test.describe("responsive sweep (staff screens)", () => {
  test.use({ storageState: statePath("owner") });
  test.describe.configure({ timeout: 600_000 });
  let pages: string[] = [];

  test.beforeAll(async () => {
    const owner = await apiAs("owner");
    pages = [...OWNER_PAGES, ...(await dynamicPages(owner))];
    await owner.dispose();
  });

  for (const [i, vp] of VIEWPORTS.entries()) {
    test(`QUALITY-001 ${vp.name}`, async ({ browser }) => {
      const context = await browser.newContext({ storageState: statePath("owner"), viewport: { width: vp.width, height: vp.height }, isMobile: vp.width < 800, hasTouch: vp.width < 800 });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(`exception: ${e.message}`));
      page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`); });
      const list = [0, 2, 5, 8].includes(i) ? pages : CORE;
      for (const url of list) {
        errors.length = 0;
        const res = await page.goto(url, { waitUntil: "domcontentloaded" });
        await settle(page);
        if (!res || res.status() >= 400) report({ page: url, viewport: vp.name, kind: "status", detail: String(res?.status()) });
        const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        if (w.sw > w.iw + 1) report({ page: url, viewport: vp.name, kind: "horizontal-scroll", detail: `${w.sw}px of content in a ${w.iw}px window` });
        for (const e of errors) report({ page: url, viewport: vp.name, kind: "error", detail: e });
      }
      await context.close();
    });
  }
});

test.describe("responsive sweep (public screens)", () => {
  test.describe.configure({ timeout: 300_000 });
  for (const vp of [VIEWPORTS[0], VIEWPORTS[2], VIEWPORTS[5], VIEWPORTS[8], VIEWPORTS[9]]) {
    test(`QUALITY-001 public ${vp.name}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.width < 800, hasTouch: vp.width < 800 });
      const page = await context.newPage();
      for (const url of PUBLIC_PAGES) {
        const res = await page.goto(url, { waitUntil: "load" });
        if (!res || res.status() >= 400) report({ page: url, viewport: vp.name, kind: "status", detail: String(res?.status()) });
        const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        if (w.sw > w.iw + 1) report({ page: url, viewport: vp.name, kind: "horizontal-scroll", detail: `${w.sw}px of content in a ${w.iw}px window` });
      }
      await context.close();
    });
  }
});

test.describe("accessibility sweep", () => {
  test.describe.configure({ timeout: 600_000 });
  const axePath = path.join(process.cwd(), "node_modules", "axe-core", "axe.min.js");

  async function scan(page: Page, url: string, viewport: string) {
    // The marketing site fades sections in as they scroll into view; scan them as a reader sees them, fully shown.
    await page.evaluate(() => document.querySelectorAll(".s-reveal").forEach((el) => el.classList.add("is-in")));
    await page.waitForTimeout(1300);
    await page.addScriptTag({ path: axePath });
    const result = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: Array<{ id: string; impact: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> } }).axe;
      return axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
    });
    for (const v of result.violations) {
      if (v.impact !== "serious" && v.impact !== "critical") continue;
      if (KNOWN.some((k) => k.rule === v.id)) continue;
      report({ page: url, viewport, kind: `axe ${v.id} (${v.impact})`, detail: `${v.help}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}${v.nodes.length > 3 ? ` (+${v.nodes.length - 3} more)` : ""}` });
    }
  }

  for (const vp of [VIEWPORTS[2], VIEWPORTS[8]]) {
    test(`QUALITY-002 staff screens ${vp.name}`, async ({ browser }) => {
      const owner = await apiAs("owner");
      const list = [...OWNER_PAGES, ...(await dynamicPages(owner))];
      await owner.dispose();
      const context = await browser.newContext({ storageState: statePath("owner"), viewport: { width: vp.width, height: vp.height }, isMobile: vp.width < 800, hasTouch: vp.width < 800 });
      const page = await context.newPage();
      for (const url of list) {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await settle(page);
        await scan(page, url, vp.name);
      }
      await context.close();
    });

    test(`QUALITY-002 public screens ${vp.name}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await context.newPage();
      for (const url of PUBLIC_PAGES) {
        await page.goto(url, { waitUntil: "load" });
        await scan(page, url, vp.name);
      }
      await context.close();
    });
  }
});

test.afterAll(() => {
  if (!COLLECT) return;
  const grouped = new Map<string, Finding[]>();
  for (const f of findings) grouped.set(`${f.kind} :: ${f.detail}`, [...(grouped.get(`${f.kind} :: ${f.detail}`) ?? []), f]);
  console.log(`QUALITY FINDINGS: ${findings.length}`);
  for (const [k, v] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) console.log(`${v.length}x ${k}\n     ${[...new Set(v.map((f) => `${f.viewport} ${f.page}`))].slice(0, 6).join("; ")}`);
  if (process.env.QUALITY_REPORT) fs.writeFileSync(process.env.QUALITY_REPORT, JSON.stringify(findings, null, 1));
});
