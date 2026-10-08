/**
 * Group 5 accounting: mapping and direct sync to Tally (XML gateway) and Zoho
 * Books, against the real services and database with emulated providers.
 *
 *  G1 mapping: owner only, audited, applied to every export, amounts never change,
 *     a downloaded batch stays byte-identical
 *  G2 Tally: gateway allow-list at save time, each voucher sent once, a second
 *     sync sends nothing
 *  G3 partial failure: one voucher refused (final) while the rest are delivered;
 *     manual retry; SENT vouchers can't be retried
 *  G4 retryable failure: the worker retries exactly once, even with concurrent
 *     ticks; attempts are bounded
 *  G5 timeout / malformed answer / 401: classified, safe messages, health recorded
 *  G6 interrupted sends: Zoho is recovered for retry, Tally waits for a person
 *  G7 Zoho: account ids, an unmapped ledger stops the voucher, a lost answer never
 *     creates a second journal
 *  G8 authorization, tenants, input limits, secrets never leave the server
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { createMenuItem } from "@/server/services/menu";
import { placeOrder } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { createExpense } from "@/server/services/finance";
import { upsertIntegration, listIntegrations, integrationAudit } from "@/server/services/integrations";
import { exportAccounting, accountingBatch } from "@/server/services/accounting";
import { getAccountingMapping, saveAccountingMapping, syncAccounting, retryAccountingSync, listAccountingSync, recoverInterruptedAccountingSync, deliverAccountingSync, deliveryState } from "@/server/services/accountingSync";
import { retryDueDeliveries } from "@/server/ops/worker";

const RUN = Date.now().toString(36);
const GATEWAY = "http://tally.test:9000";
const ZOHO_ORG = "60099887";
const ZOHO = { clientId: "1000.G5CLIENT", clientSecret: "g5-client-secret-value", refreshToken: "1000.g5.refresh.token.value" };
let orgId: string, A: string, B: string;
let sys: AccessContext, owner: AccessContext, manager: AccessContext, foreign: AccessContext;
let tallyId: string, zohoId: string, item: string;
let n = 0;
const from = new Date(Date.now() - 3 * 86400000);
const to = new Date(Date.now() + 86400000);
const env0 = { ...process.env };
const res = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const member = (id: string, role: string, outletId: string): AccessContext => ({ userId: id, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });

async function sale(): Promise<void> {
  const o = await placeOrder(sys, { outletId: A, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: item, qty: 1 }] });
  const p = await createPayment(sys, o.id, { method: "CASH", amount: 105, idempotencyKey: `g5-${RUN}-${++n}-sale` });
  await verifyPayment(sys, p.id);
}
const expense = (amount: number, category = "GAS") => createExpense(sys, { outletId: A, category, amount, paidVia: "BANK" });

// ---------------- Tally emulator ----------------
type TallyMode = "ok" | "line-error" | "503" | "401" | "malformed" | "timeout";
const tally = { received: [] as string[], mode: "ok" as TallyMode, perVoucher: new Map<string, TallyMode>() };
const remoteId = (body: string) => /REMOTEID="([^"]+)"/.exec(body)?.[1] ?? "?";
async function tallyFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const body = String(init.body ?? "");
  if (!url.startsWith(GATEWAY)) return res({}, 404);
  if (body.includes("List of Companies")) return new Response("<ENVELOPE/>", { status: 200 });
  const id = remoteId(body);
  const mode = tally.perVoucher.get(id) ?? tally.mode;
  tally.received.push(id);
  if (mode === "timeout") throw Object.assign(new Error("aborted"), { name: "AbortError" });
  if (mode === "503") return new Response("busy", { status: 503 });
  if (mode === "401") return new Response("denied", { status: 401 });
  if (mode === "malformed") return new Response("<html>nope</html>", { status: 200 });
  if (mode === "line-error") return new Response("<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Ledger 'Sales' does not exist</LINEERROR></RESPONSE>", { status: 200 });
  return new Response("<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS></RESPONSE>", { status: 200 });
}
const resetTally = () => { tally.received.length = 0; tally.mode = "ok"; tally.perVoucher.clear(); };

// ---------------- Zoho emulator ----------------
const zoho = { journals: new Map<string, { id: string; ref: string; body: string }>(), tokenCalls: 0, loseNextAnswer: false, posts: 0, tokenStatus: 200 };
async function zohoFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? "GET";
  if (url.includes("accounts.zoho.in/oauth/v2/token")) { zoho.tokenCalls++; return zoho.tokenStatus === 200 ? res({ access_token: "ztok", expires_in: 3600 }) : res({ error: "invalid_client" }, zoho.tokenStatus); }
  if (!url.includes(`organization_id=${ZOHO_ORG}`)) return res({ code: 1, message: "organization missing" }, 400);
  if (url.includes("/books/v3/journals?reference_number=")) {
    const ref = decodeURIComponent(/reference_number=([^&]+)/.exec(url)![1]);
    return res({ code: 0, journals: [...zoho.journals.values()].filter((j) => j.ref === ref).map((j) => ({ journal_id: j.id, reference_number: j.ref })) });
  }
  if (method === "POST" && url.includes("/books/v3/journals")) {
    zoho.posts++;
    const b = JSON.parse(String(init.body)) as { reference_number: string };
    const id = `jr${zoho.journals.size + 1}`;
    zoho.journals.set(id, { id, ref: b.reference_number, body: String(init.body) });
    if (zoho.loseNextAnswer) { zoho.loseNextAnswer = false; throw new Error("socket hang up"); }
    return res({ code: 0, journal: { journal_id: id } });
  }
  if (url.includes("/books/v3/organizations")) return res({ code: 0, organizations: [] });
  return res({}, 404);
}

beforeAll(async () => {
  process.env.TALLY_GATEWAY_URLS = GATEWAY;
  orgId = (await prisma.organization.create({ data: { name: `G5 Org ${RUN}`, legalName: "G5 Foods" } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `G5A${RUN}`, name: "G5 A", gstin: "36ABCDE1234F1Z1", invoiceSeries: `G5A${RUN.slice(-3)}` } })).id;
  B = (await prisma.outlet.create({ data: { organizationId: orgId, code: `G5B${RUN}`, name: "G5 B" } })).id;
  sys = systemContext(orgId, [A, B]);
  owner = { ...systemContext(orgId, [A, B]), userId: `owner-${RUN}`, roles: ["OWNER"], orgRoles: ["OWNER"], isOrgWide: true };
  manager = member(`mgr-${RUN}`, "MANAGER", A);
  const fOrg = (await prisma.organization.create({ data: { name: `G5 Foreign ${RUN}` } })).id;
  const fOutlet = (await prisma.outlet.create({ data: { organizationId: fOrg, code: `G5F${RUN}`, name: "F" } })).id;
  foreign = { ...systemContext(fOrg, [fOutlet]), userId: `fowner-${RUN}`, roles: ["OWNER"], orgRoles: ["OWNER"], isOrgWide: true };
  await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId: A, name: "KITCHEN", kind: "KITCHEN" } });
  item = (await createMenuItem(sys, { name: `Dosa ${RUN}`, price: 100, taxPct: 5, station: "KITCHEN" })).id;
  await sale(); await sale();
  await expense(250);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const k of ["TALLY_GATEWAY_URLS"]) { if (env0[k] === undefined) delete process.env[k]; else process.env[k] = env0[k]; }
  await prisma.$disconnect();
});

describe("G1. mapping", () => {
  it("G1 owner only and audited; renames ledgers and parties in every export; amounts never change; a downloaded batch stays byte-identical", async () => {
    await expect(saveAccountingMapping(manager, { ledgers: { Sales: "X" } })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getAccountingMapping(prisma, manager)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveAccountingMapping(owner, { ledgers: { Sales: "Bad\u0000Name" } })).rejects.toThrow();
    await expect(saveAccountingMapping(owner, { ledgers: { Sales: "" } })).rejects.toThrow();
    await expect(saveAccountingMapping(owner, { ledgers: { Sales: "ok" }, extra: 1 } as never)).rejects.toThrow(); // strict

    expect(await getAccountingMapping(prisma, owner)).toMatchObject({ ledgers: {}, parties: {}, updatedAt: null });
    const saved = await saveAccountingMapping(owner, { ledgers: { Sales: "Sales - Dine In", Cash: "Cash in hand" }, parties: {} });
    expect(saved.ledgers).toEqual({ Sales: "Sales - Dine In", Cash: "Cash in hand" });
    expect(await getAccountingMapping(prisma, foreign)).toMatchObject({ ledgers: {} }); // another tenant has its own (empty) mapping

    const plain = await exportAccounting(owner, { format: "generic", outletId: A, from, to });
    if (plain.empty) throw new Error("expected vouchers");
    // The generic CSV carries the books' names; the duplicate guard and the amounts are RESTORA's.
    expect(plain.file).toContain("Sales - Dine In");
    expect(plain.file).toContain("Cash in hand");
    expect(plain.file).not.toMatch(/,Sales,/);
    const lines = (await prisma.integrationDelivery.findMany({ where: { organizationId: orgId, batchId: plain.batchId } })).flatMap((r) => JSON.parse(r.payload).lines as Array<{ debit: number; credit: number }>);
    const debit = lines.reduce((a, l) => a + l.debit, 0), credit = lines.reduce((a, l) => a + l.credit, 0);
    expect(debit).toBeGreaterThan(0);
    expect(Math.abs(debit - credit)).toBeLessThan(0.005);
    expect(plain.reconciliation!.every((c) => c.matches)).toBe(true);

    // Changing the mapping later does not change what was already downloaded.
    await saveAccountingMapping(owner, { ledgers: { Sales: "Revenue" }, parties: {} });
    expect((await accountingBatch(owner, plain.batchId)).checksum).toBe(plain.checksum);
    const audit = await integrationAudit(prisma, owner);
    expect(audit.filter((a) => a.entityType === "AccountingMapping")).toHaveLength(2);
    await expect(accountingBatch(foreign, plain.batchId)).rejects.toBeInstanceOf(NotFoundError);
    await saveAccountingMapping(owner, { ledgers: {}, parties: {} });
  });

  it("G1b the Zoho CSV carries the same vouchers, one journal per source key; a range over 400 days or backwards is refused", async () => {
    const zohoFile = await exportAccounting(owner, { format: "zoho", outletId: A, from, to });
    if (zohoFile.empty) throw new Error("expected vouchers");
    expect(zohoFile.file.split("\r\n")[0]).toBe("Journal Date,Reference Number,Notes,Journal Type,Currency,Account,Description,Contact Name,Debit,Credit");
    expect(zohoFile.file).toContain("inv:");
    await expect(exportAccounting(owner, { format: "generic", outletId: A, from, to: new Date(from.getTime() + 401 * 86400000) })).rejects.toThrow(/At most 400 days/);
    await expect(exportAccounting(owner, { format: "generic", outletId: A, from: to, to: from })).rejects.toThrow(/on or before/);
  });
});

describe("G2. Tally gateway", () => {
  it("G2 the gateway must be one the deployment allows; each voucher is sent once and a second sync sends nothing", async () => {
    await expect(upsertIntegration(owner, { kind: "ACCOUNTING", provider: "tally_gateway", config: { gatewayUrl: "http://169.254.169.254", company: "C" } })).rejects.toThrow(/not allowed by the deployment/);
    await expect(upsertIntegration(owner, { kind: "ACCOUNTING", provider: "tally_gateway", config: { gatewayUrl: GATEWAY } })).rejects.toThrow(/Invalid Tally settings/);
    await expect(upsertIntegration(manager, { kind: "ACCOUNTING", provider: "tally_gateway", config: { gatewayUrl: GATEWAY, company: "C" } })).rejects.toBeInstanceOf(ForbiddenError);
    const c = await upsertIntegration(owner, { kind: "ACCOUNTING", provider: "tally_gateway", config: { gatewayUrl: GATEWAY, company: "Coders Cafe" }, mode: "SANDBOX" });
    tallyId = c.id;
    expect(c).toMatchObject({ mode: "SANDBOX", configured: true, hasCredentials: false });

    resetTally();
    const first = await syncAccounting(owner, { connectionId: tallyId, outletId: A, from, to }, prisma, tallyFetch);
    expect(first).toMatchObject({ provider: "tally_gateway", mode: "SANDBOX", failed: 0 });
    expect(first.vouchers).toBeGreaterThanOrEqual(3); // two sales and an expense
    expect(first.delivered).toBe(first.vouchers);
    expect(new Set(tally.received).size).toBe(first.vouchers); // one request per voucher, none twice
    expect(tally.received.every((id) => /^(inv|ord|pay|rf|exp):/.test(id))).toBe(true);

    const second = await syncAccounting(owner, { connectionId: tallyId, outletId: A, from, to }, prisma, tallyFetch);
    expect(second).toMatchObject({ queued: 0, delivered: 0, failed: 0, alreadySynced: first.vouchers });
    expect(tally.received).toHaveLength(first.vouchers); // nothing more went out

    const rows = await prisma.integrationDelivery.findMany({ where: { organizationId: orgId, kind: "ACCOUNTING_SYNC", provider: "tally_gateway" } });
    expect(rows.every((r) => r.status === "SENT" && r.attempts === 1 && r.providerRef === "tally:1")).toBe(true);
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(rows.length);
    const audit = await integrationAudit(prisma, owner);
    expect(audit.some((a) => a.action === "INTEGRATION_SYNC" && a.entityType === "AccountingExport")).toBe(true);
    expect((await listAccountingSync(prisma, owner)).every((r) => r.state === "SUCCESS")).toBe(true);
    // a file-format connection cannot be synced; a disconnected one neither
    const file = await upsertIntegration(owner, { kind: "ACCOUNTING", provider: "generic" });
    await expect(syncAccounting(owner, { connectionId: file.id, outletId: A, from, to }, prisma, tallyFetch)).rejects.toThrow(/file format/);
  });
});

describe("G3. partial failure", () => {
  it("G3 a refused voucher is FAILED for good while the others are delivered; retry after the fix; a SENT voucher is not retried", async () => {
    await expense(75, "SUPPLIES");
    const newest = await prisma.integrationDelivery.count({ where: { organizationId: orgId, kind: "ACCOUNTING_SYNC" } });
    await expense(90, "REPAIRS");
    resetTally();
    // The second new expense is refused by Tally; the first goes through.
    const exps = await prisma.expense.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" } });
    const refused = `exp:${exps[exps.length - 1].id}`;
    tally.perVoucher.set(refused, "line-error");
    const r = await syncAccounting(owner, { connectionId: tallyId, outletId: A, from, to }, prisma, tallyFetch);
    expect(r).toMatchObject({ queued: 2, delivered: 1, failed: 1 });
    expect(await prisma.integrationDelivery.count({ where: { organizationId: orgId, kind: "ACCOUNTING_SYNC" } })).toBe(newest + 2);
    const bad = await prisma.integrationDelivery.findFirstOrThrow({ where: { organizationId: orgId, sourceId: refused, kind: "ACCOUNTING_SYNC" } });
    expect(bad).toMatchObject({ status: "FAILED", attempts: 1, nextAttemptAt: null });
    expect(bad.lastError).toMatch(/^REJECTED: Tally rejected the voucher: Ledger 'Sales' does not exist/);
    expect(deliveryState(bad)).toBe("FAILED"); // final: no automatic retry

    // Still refused on a manual retry; then Tally is fixed and the retry goes through.
    expect(await retryAccountingSync(owner, bad.id, prisma, tallyFetch)).toMatchObject({ status: "FAILED", attempts: 2 });
    tally.perVoucher.clear();
    const fixed = await retryAccountingSync(owner, bad.id, prisma, tallyFetch);
    expect(fixed).toMatchObject({ status: "SENT", attempts: 3, lastError: null });
    await expect(retryAccountingSync(owner, bad.id, prisma, tallyFetch)).rejects.toThrow(/Only a failed voucher can be retried/);
    expect(tally.received.filter((id) => id === refused)).toHaveLength(3);
    // The earlier SENT vouchers were never sent again.
    expect(tally.received.filter((id) => id !== refused)).toHaveLength(1);
  });
});

describe("G4. retries by the worker", () => {
  it("G4 a 503 is retried automatically exactly once even with concurrent ticks; attempts are bounded and exhausted rows stop", async () => {
    await expense(60, "UTILITIES");
    const exps = await prisma.expense.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" } });
    const key = `exp:${exps[exps.length - 1].id}`;
    resetTally();
    tally.perVoucher.set(key, "503");
    const r = await syncAccounting(owner, { connectionId: tallyId, outletId: A, from, to }, prisma, tallyFetch);
    expect(r).toMatchObject({ queued: 1, delivered: 0, failed: 1 });
    let row = await prisma.integrationDelivery.findFirstOrThrow({ where: { organizationId: orgId, sourceId: key, kind: "ACCOUNTING_SYNC" } });
    expect(row).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(row.nextAttemptAt).not.toBeNull();
    expect(row.lastError).toMatch(/^UNAVAILABLE:/);
    expect(deliveryState(row)).toBe("RETRYING");
    // Not due yet: the worker leaves it alone.
    expect(await retryDueDeliveries(prisma, new Date())).toMatchObject({ retried: 0 });

    // Due, and Tally is back: two worker ticks at the same moment send it once.
    vi.stubGlobal("fetch", tallyFetch);
    tally.perVoucher.clear();
    tally.received.length = 0; // count only what the worker sends from here on
    const later = new Date(Date.now() + 10 * 60_000);
    const [t1, t2] = await Promise.all([retryDueDeliveries(prisma, later), retryDueDeliveries(prisma, later)]);
    expect(t1.retried + t2.retried).toBe(1);
    expect(tally.received.filter((id) => id === key)).toHaveLength(1);
    row = await prisma.integrationDelivery.findFirstOrThrow({ where: { id: row.id } });
    expect(row).toMatchObject({ status: "SENT", attempts: 2, lastError: null });

    // Bounded: the fifth failed attempt leaves it FAILED with no schedule.
    await expense(61, "MARKETING");
    const exps2 = await prisma.expense.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" } });
    const key2 = `exp:${exps2[exps2.length - 1].id}`;
    tally.perVoucher.set(key2, "503");
    await syncAccounting(owner, { connectionId: tallyId, outletId: A, from, to }, prisma, tallyFetch);
    const r2 = await prisma.integrationDelivery.findFirstOrThrow({ where: { organizationId: orgId, sourceId: key2, kind: "ACCOUNTING_SYNC" } });
    await prisma.integrationDelivery.update({ where: { id: r2.id }, data: { attempts: 4, nextAttemptAt: new Date(Date.now() - 1000) } });
    const out = await deliverAccountingSync(r2.id, prisma, tallyFetch);
    expect(out).toMatchObject({ status: "FAILED", attempts: 5, nextAttemptAt: null });
    expect(deliveryState(out!)).toBe("EXHAUSTED");
    const sentBefore = tally.received.length;
    await retryDueDeliveries(prisma, new Date(Date.now() + 3600_000));
    expect(tally.received).toHaveLength(sentBefore); // exhausted rows are not picked up again
    vi.unstubAllGlobals();
  });
});

describe("G5. timeout, malformed answer, unauthorized", () => {
  async function failingSync(mode: TallyMode) {
    await expense(10 + ++n, ["RENT", "SALARY", "MISC"][n % 3]);
    const exps = await prisma.expense.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" } });
    const key = `exp:${exps[exps.length - 1].id}`;
    resetTally();
    tally.perVoucher.set(key, mode);
    await syncAccounting(owner, { connectionId: tallyId, outletId: A, from, to }, prisma, tallyFetch);
    return prisma.integrationDelivery.findFirstOrThrow({ where: { organizationId: orgId, sourceId: key, kind: "ACCOUNTING_SYNC" } });
  }

  it("G5 a timeout is retried later; a malformed answer is final; a refused login is final, flagged UNAUTHORIZED and recorded on the connection", async () => {
    const t = await failingSync("timeout");
    expect(t.lastError).toMatch(/^TIMEOUT:/);
    expect(t.nextAttemptAt).not.toBeNull();
    expect(deliveryState(t)).toBe("TIMEOUT_RETRYING");

    const m = await failingSync("malformed");
    expect(m.lastError).toMatch(/^MALFORMED:/);
    expect(m.nextAttemptAt).toBeNull();
    expect(deliveryState(m)).toBe("FAILED");

    const u = await failingSync("401");
    expect(u.lastError).toMatch(/^UNAUTHORIZED:/);
    expect(u.nextAttemptAt).toBeNull();
    expect(deliveryState(u)).toBe("UNAUTHORIZED");
    const conn = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: tallyId } });
    expect(conn.lastFailureAt).not.toBeNull();
    expect(conn.lastError).toMatch(/refused the credentials/);
    for (const row of [t, m, u]) expect(`${row.lastError} ${conn.lastError}`).not.toMatch(/password|secret/i);
  });
});

describe("G6. interrupted sends", () => {
  it("G6 a send that died mid-way: Zoho goes back to the retry queue (it looks the journal up first), Tally waits for a person", async () => {
    const old = new Date(Date.now() - 3600_000);
    const mk = async (provider: string, id: string) => {
      const d = await prisma.integrationDelivery.create({ data: { organizationId: orgId, outletId: A, kind: "ACCOUNTING_SYNC", provider, mode: "SANDBOX", idempotencyKey: `acctsync:${provider}:g6-${id}-${RUN}`, payload: "{}", status: "PENDING", attempts: 1, sourceType: "SALES", sourceId: `g6-${id}-${RUN}`, maxAttempts: 5 } });
      await prisma.integrationDelivery.update({ where: { id: d.id }, data: { updatedAt: old } });
      return d.id;
    };
    const z = await mk("zoho_books", "z"), t = await mk("tally_gateway", "t");
    const recent = await prisma.integrationDelivery.create({ data: { organizationId: orgId, outletId: A, kind: "ACCOUNTING_SYNC", provider: "zoho_books", mode: "SANDBOX", idempotencyKey: `acctsync:zoho_books:g6-r-${RUN}`, payload: "{}", status: "PENDING", attempts: 1, sourceId: `g6-r-${RUN}`, maxAttempts: 5 } });
    const now = new Date();
    expect(await recoverInterruptedAccountingSync(prisma, new Date(now.getTime() - 300_000), now)).toBe(2);
    expect(await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: z } })).toMatchObject({ status: "FAILED", lastError: expect.stringMatching(/^INTERRUPTED: .*looks the journal up first/) });
    expect((await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: z } })).nextAttemptAt).not.toBeNull();
    expect(await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: t } })).toMatchObject({ status: "FAILED", nextAttemptAt: null, lastError: expect.stringMatching(/check the books before retrying/) });
    expect((await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: recent.id } })).status).toBe("PENDING"); // too recent: still running
  });
});

describe("G7. Zoho Books", () => {
  it("G7 connect with write-only credentials; an unmapped ledger stops the voucher; mapped to account ids a retry delivers it; a lost answer never makes a second journal; a refused token is final", async () => {
    await expect(upsertIntegration(owner, { kind: "ACCOUNTING", provider: "zoho_books", config: { organizationId: "abc", dataCenter: "in" } })).rejects.toThrow(/Invalid Zoho Books settings/);
    await expect(upsertIntegration(owner, { kind: "ACCOUNTING", provider: "zoho_books", config: { organizationId: ZOHO_ORG, dataCenter: "in" }, credentials: { clientId: "x", clientSecret: "y", refreshToken: "z" } })).rejects.toThrow(/Invalid Zoho Books credentials/);
    const z = await upsertIntegration(owner, { kind: "ACCOUNTING", provider: "zoho_books", config: { organizationId: ZOHO_ORG, dataCenter: "in" }, credentials: ZOHO, mode: "SANDBOX" });
    zohoId = z.id;
    expect(z).toMatchObject({ configured: true, hasCredentials: true });
    expect(JSON.stringify(z)).not.toMatch(/g5-client-secret|refresh\.token/);

    // 1. no account ids yet: every voucher stops before a request is made and says what to map; none is retried by itself.
    const first = await syncAccounting(owner, { connectionId: zohoId, outletId: A, from, to }, prisma, zohoFetch);
    expect(first.delivered).toBe(0);
    expect(first.failed).toBe(first.vouchers);
    expect(zoho.posts).toBe(0);
    const stopped = await prisma.integrationDelivery.findMany({ where: { organizationId: orgId, provider: "zoho_books", kind: "ACCOUNTING_SYNC", lastError: { startsWith: "NOT_CONFIGURED" } } });
    expect(stopped).toHaveLength(first.vouchers);
    expect(stopped.every((r) => r.nextAttemptAt === null && /Map these ledgers to Zoho account ids first/.test(r.lastError ?? ""))).toBe(true);

    // 2. map every ledger to a Zoho account id, then retry the stopped vouchers: all arrive, one journal each.
    const ledgers = new Set<string>();
    for (const row of stopped) for (const l of JSON.parse(row.payload).lines as Array<{ ledger: string }>) ledgers.add(l.ledger);
    await saveAccountingMapping(owner, { ledgers: Object.fromEntries([...ledgers].map((l, i) => [l, String(2000000000100 + i)])), parties: {} });
    for (const row of stopped) expect(await retryAccountingSync(owner, row.id, prisma, zohoFetch)).toMatchObject({ status: "SENT" });
    expect(zoho.journals.size).toBe(first.vouchers);
    const refs = [...zoho.journals.values()].map((j) => j.ref);
    expect(new Set(refs).size).toBe(refs.length);
    const sample = JSON.parse([...zoho.journals.values()][0].body) as { line_items: Array<{ account_id: string }> };
    expect(sample.line_items.every((l) => /^2000000000\d+$/.test(l.account_id))).toBe(true);
    // syncing again sends nothing new
    const postsAfterSecond = zoho.posts;
    expect(await syncAccounting(owner, { connectionId: zohoId, outletId: A, from, to }, prisma, zohoFetch)).toMatchObject({ queued: 0, delivered: 0 });
    expect(zoho.posts).toBe(postsAfterSecond);

    // 3. Zoho creates the journal but the answer is lost: the attempt fails (retryable); the retry finds the journal by its reference.
    await expense(33, "GAS");
    zoho.loseNextAnswer = true;
    const journalsBefore = zoho.journals.size, postsBefore = zoho.posts;
    const lost = await syncAccounting(owner, { connectionId: zohoId, outletId: A, from, to }, prisma, zohoFetch);
    expect(lost).toMatchObject({ queued: 1, delivered: 0, failed: 1 });
    expect(zoho.journals.size).toBe(journalsBefore + 1);
    const row = await prisma.integrationDelivery.findFirstOrThrow({ where: { organizationId: orgId, provider: "zoho_books", kind: "ACCOUNTING_SYNC", status: "FAILED", lastError: { startsWith: "UNAVAILABLE" } } });
    expect(row.nextAttemptAt).not.toBeNull();
    const recovered = await retryAccountingSync(owner, row.id, prisma, zohoFetch);
    expect(recovered).toMatchObject({ status: "SENT", attempts: 2 });
    expect(recovered!.providerRef).toMatch(/^zoho:jr\d+$/);
    expect(zoho.journals.size).toBe(journalsBefore + 1); // no second journal
    expect(zoho.posts).toBe(postsBefore + 1); // the retry only looked the reference up

    // 4. Zoho refuses the refresh token: UNAUTHORIZED, final, no secret in the stored reason.
    await expense(34, "GAS");
    zoho.tokenStatus = 401;
    const bad = await syncAccounting(owner, { connectionId: zohoId, outletId: A, from, to }, prisma, zohoFetch);
    zoho.tokenStatus = 200;
    expect(bad).toMatchObject({ queued: 1, delivered: 0, failed: 1 });
    const unauth = (await listAccountingSync(prisma, owner)).find((r) => r.provider === "zoho_books" && r.state === "UNAUTHORIZED");
    expect(unauth).toBeTruthy();
    expect(unauth!.lastError).toMatch(/^UNAUTHORIZED:/);
    expect(unauth!.lastError).not.toMatch(/g5-client-secret|refresh\.token/);
  });
});

describe("G8. authorization, tenants, limits, secrets", () => {
  it("G8 only integration.manage; another organization's connection and deliveries do not exist; limits and shapes are enforced", async () => {
    const q = { connectionId: tallyId, outletId: A, from, to };
    await expect(syncAccounting(manager, q, prisma, tallyFetch)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listAccountingSync(prisma, manager)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(syncAccounting(foreign, q, prisma, tallyFetch)).rejects.toThrow(); // not their outlet / connection
    await expect(syncAccounting(foreign, { connectionId: tallyId, from, to }, prisma, tallyFetch)).rejects.toBeInstanceOf(NotFoundError);
    const mine = await prisma.integrationDelivery.findFirstOrThrow({ where: { organizationId: orgId, kind: "ACCOUNTING_SYNC", status: "FAILED" } });
    await expect(retryAccountingSync(foreign, mine.id, prisma, tallyFetch)).rejects.toBeInstanceOf(NotFoundError);
    await expect(retryAccountingSync(manager, mine.id, prisma, tallyFetch)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await listAccountingSync(prisma, foreign)).toEqual([]);
    await expect(syncAccounting(owner, { ...q, to: new Date(from.getTime() + 401 * 86400000) }, prisma, tallyFetch)).rejects.toThrow(/At most 400 days/);
    await expect(syncAccounting(owner, { ...q, from: to, to: from }, prisma, tallyFetch)).rejects.toThrow(/on or before/);
    await expect(syncAccounting(owner, { ...q, connectionId: "" }, prisma, tallyFetch)).rejects.toThrow();
    await expect(syncAccounting(owner, { ...q, outletId: "does-not-exist" }, prisma, tallyFetch)).rejects.toThrow();
    await expect(retryAccountingSync(owner, "nope", prisma, tallyFetch)).rejects.toBeInstanceOf(NotFoundError);
    // The sync of one organization never touches another's books.
    const other = await prisma.integrationDelivery.count({ where: { organizationId: foreign.organizationId } });
    expect(other).toBe(0);

    // Secrets never appear in what the server stores about the sync or returns.
    const everything = JSON.stringify([
      await listIntegrations(prisma, owner), await integrationAudit(prisma, owner), await listAccountingSync(prisma, owner),
      await prisma.integrationDelivery.findMany({ where: { organizationId: orgId } }), await prisma.auditLog.findMany({ where: { organizationId: orgId } }),
    ]);
    expect(everything).not.toMatch(/g5-client-secret-value|1000\.g5\.refresh\.token\.value|1000\.G5CLIENT/);
  });
});
