/**
 * Group 5 provider adapters against emulators of the documented request /
 * response shapes (no network, no credentials). What is proven here is the
 * adapters' contract handling, NOT that Tally, Zoho Books or Google accept the
 * requests: that needs a real company / organisation / spreadsheet.
 *
 *  T  Tally gateway: SSRF allow-list, request envelope, success, line errors,
 *     malformed answer, 4xx / 5xx / 429, timeout
 *  Z  Zoho Books: OAuth refresh, one journal per voucher, unmapped ledgers,
 *     provider refusal, lookup of an earlier attempt, token failures
 *  S  Google Sheets: service-account JWT, tab creation, read / write contract,
 *     RAW values, tab-name validation, error classification
 *  C  statement CSV parser (cell-level errors, no guessing)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { TallyGatewayClient, ZohoBooksClient, allowedTallyGateways } from "@/integrations/accounting/sync";
import { GoogleSheetsClient, MockSheetsProvider, GOOGLE_SHEETS_API, GOOGLE_TOKEN_URL, signServiceAccountJwt } from "@/integrations/sheets";
import { IntegrationError, UnauthorizedIntegrationError } from "@/integrations/http";
import { parseStatementCsv } from "@/lib/statementCsv";
import type { Voucher } from "@/integrations/accounting";

const GATEWAY = "http://tally.test:9000";
const voucher: Voucher = { sourceKey: "inv:abc123", date: "2026-10-07", type: "SALES", number: "INV-0001", party: "Walk-in & <Co>", narration: "Sale \"A\"", lines: [{ ledger: "Cash", debit: 105, credit: 0 }, { ledger: "Sales", debit: 0, credit: 100 }, { ledger: "Output GST", debit: 0, credit: 5 }] };
const res = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const ok = (xml = "<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS></RESPONSE>") => new Response(xml, { status: 200 });

beforeAll(() => { process.env.TALLY_GATEWAY_URLS = `${GATEWAY}, http://other.test:9001`; });
afterAll(() => { delete process.env.TALLY_GATEWAY_URLS; });

describe("T. Tally gateway", () => {
  it("T1 only the deployment's gateways are reachable; a tenant cannot point the server anywhere else", () => {
    expect(allowedTallyGateways()).toEqual([GATEWAY, "http://other.test:9001"]);
    expect(allowedTallyGateways("http://169.254.169.254/latest, file:///etc/passwd, http://ok.test:1/path, javascript:1")).toEqual([]);
    expect(() => new TallyGatewayClient({ url: "http://169.254.169.254", company: "X" })).toThrow(/not allowed by the deployment/);
    delete process.env.TALLY_GATEWAY_URLS;
    expect(() => new TallyGatewayClient({ url: GATEWAY, company: "X" })).toThrow(/not allowed/);
    process.env.TALLY_GATEWAY_URLS = `${GATEWAY}, http://other.test:9001`;
  });

  it("T2 one voucher per request: company selected, REMOTEID = the source key, every value XML-escaped", async () => {
    let seen: { url: string; body: string; method?: string } | null = null;
    const c = new TallyGatewayClient({ url: GATEWAY, company: 'Coders & "Cafe"', fetchImpl: async (url, init) => { seen = { url, body: String(init?.body), method: init?.method }; return ok(); } });
    expect(await c.post(voucher)).toEqual({ created: 1 });
    expect(seen!.url).toBe(GATEWAY);
    expect(seen!.method).toBe("POST");
    expect(seen!.body).toContain("<SVCURRENTCOMPANY>Coders &amp; &quot;Cafe&quot;</SVCURRENTCOMPANY>");
    expect(seen!.body).toContain('REMOTEID="inv:abc123"');
    expect(seen!.body).toContain("Walk-in &amp; &lt;Co&gt;");
    expect(seen!.body).not.toContain("<Co>");
    expect((seen!.body.match(/<VOUCHER /g) ?? []).length).toBe(1);
  });

  it("T3 Tally's own refusal is final (REJECTED, not retryable) and its message is kept short and safe", async () => {
    const c = new TallyGatewayClient({ url: GATEWAY, company: "X", fetchImpl: async () => ok("<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Ledger 'Cash' does not exist</LINEERROR></RESPONSE>") });
    const e = await c.post(voucher).catch((x) => x as IntegrationError);
    expect(e).toBeInstanceOf(IntegrationError);
    expect(e).toMatchObject({ code: "REJECTED", retryable: false });
    expect(e.message).toMatch(/Ledger 'Cash' does not exist/);
    await expect(new TallyGatewayClient({ url: GATEWAY, company: "X", fetchImpl: async () => ok("<RESPONSE><CREATED>0</CREATED><ERRORS>0</ERRORS></RESPONSE>") }).post(voucher)).rejects.toMatchObject({ code: "REJECTED" });
  });

  it("T4 a garbled answer is MALFORMED and never counted as created", async () => {
    for (const body of ["", "<html>login</html>", "<RESPONSE><CREATED>many</CREATED></RESPONSE>"]) {
      await expect(new TallyGatewayClient({ url: GATEWAY, company: "X", fetchImpl: async () => ok(body) }).post(voucher)).rejects.toMatchObject({ code: "MALFORMED", retryable: false });
    }
  });

  it("T5 status classes: 401 / 403 unauthorized, 429 / 5xx retryable, other 4xx rejected", async () => {
    const attempt = (status: number) => new TallyGatewayClient({ url: GATEWAY, company: "X", fetchImpl: async () => new Response("no", { status }) }).post(voucher).catch((x) => x as IntegrationError);
    expect(await attempt(401)).toBeInstanceOf(UnauthorizedIntegrationError);
    expect(await attempt(403)).toBeInstanceOf(UnauthorizedIntegrationError);
    expect(await attempt(429)).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(await attempt(503)).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(await attempt(400)).toMatchObject({ code: "REJECTED", retryable: false });
  });

  it("T6 a gateway that never answers times out (retryable); one that cannot be reached is UNAVAILABLE", async () => {
    const hang = new TallyGatewayClient({ url: GATEWAY, company: "X", timeoutMs: 40, fetchImpl: (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))) });
    await expect(hang.post(voucher)).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
    await expect(new TallyGatewayClient({ url: GATEWAY, company: "X", fetchImpl: async () => { throw new Error("ECONNREFUSED 10.0.0.5:9000 secret=abc"); } }).post(voucher)).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true, message: "Provider unreachable" });
  });
});

describe("Z. Zoho Books", () => {
  const creds = { clientId: "1000.CLIENTID", clientSecret: "client-secret-value", refreshToken: "1000.refresh.token.value" };
  type Call = { url: string; method: string; headers: Record<string, string>; body: string };
  function zoho(opts: { journals?: Array<{ journal_id: string; reference_number: string }>; tokenStatus?: number; apiStatus?: number; apiBody?: unknown } = {}) {
    const calls: Call[] = [];
    const fetchImpl = async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: String(init.body ?? "") });
      if (url.includes("/oauth/v2/token")) return opts.tokenStatus ? res({ error: "invalid_client" }, opts.tokenStatus) : res({ access_token: "tok-1", expires_in: 3600 });
      if (opts.apiStatus) return res(opts.apiBody ?? { message: "x" }, opts.apiStatus);
      if (opts.apiBody) return res(opts.apiBody);
      if (url.includes("/journals?reference_number=")) return res({ code: 0, journals: opts.journals ?? [] });
      if (url.includes("/journals")) return res({ code: 0, journal: { journal_id: "9001" } });
      if (url.includes("/organizations")) return res({ code: 0, organizations: [] });
      return res({}, 404);
    };
    return { calls, fetchImpl };
  }
  const client = (z: ReturnType<typeof zoho>, extra: Partial<ConstructorParameters<typeof ZohoBooksClient>[0]> = {}) => new ZohoBooksClient({ dataCenter: "in", organizationId: "60012345", credentials: creds, fetchImpl: z.fetchImpl, ...extra });
  const accountOf = (l: string) => ({ Cash: "111", Sales: "222", "Output GST": "333" } as Record<string, string>)[l];

  it("Z1 a refresh token is exchanged once; the journal carries the source key as its reference and Zoho account ids", async () => {
    const z = zoho();
    const c = client(z);
    expect(await c.createJournal(voucher, accountOf)).toEqual({ journalId: "9001" });
    await c.createJournal({ ...voucher, sourceKey: "inv:second" }, accountOf);
    expect(z.calls.filter((x) => x.url.includes("/oauth/v2/token"))).toHaveLength(1); // token reused
    const token = z.calls[0];
    expect(token.url).toBe("https://accounts.zoho.in/oauth/v2/token");
    expect(token.body).toContain("grant_type=refresh_token");
    const post = z.calls[1];
    expect(post.url).toBe("https://www.zohoapis.in/books/v3/journals?organization_id=60012345");
    expect(post.headers.Authorization).toBe("Zoho-oauthtoken tok-1");
    const sent = JSON.parse(post.body);
    expect(sent.reference_number).toBe("inv:abc123");
    expect(sent.journal_date).toBe("2026-10-07");
    expect(sent.line_items).toEqual([
      { account_id: "111", debit_or_credit: "debit", amount: 105, description: "Walk-in & <Co>" },
      { account_id: "222", debit_or_credit: "credit", amount: 100, description: "Walk-in & <Co>" },
      { account_id: "333", debit_or_credit: "credit", amount: 5, description: "Walk-in & <Co>" },
    ]);
  });

  it("Z2 the data centre decides the (fixed) hosts; an unknown one or a bad organisation id is refused before any call", () => {
    const z = zoho();
    expect(() => client(z, { dataCenter: "evil.example.com" as never })).toThrow(/Unknown Zoho data centre/);
    expect(() => client(z, { organizationId: "60012345/../x" })).toThrow(/organisation id/);
    expect(z.calls).toHaveLength(0);
  });

  it("Z3 an unmapped ledger stops the voucher before it is sent, naming what to map", async () => {
    const z = zoho();
    await expect(client(z).createJournal(voucher, (l) => (l === "Cash" ? "111" : undefined))).rejects.toMatchObject({ code: "NOT_CONFIGURED", retryable: false, message: expect.stringMatching(/Map these ledgers to Zoho account ids first: Sales, Output GST/) });
    expect(z.calls.filter((x) => x.url.includes("/journals"))).toHaveLength(0);
  });

  it("Z4 Zoho refusing the journal (code != 0) is final; 401 is unauthorized; 429 / 5xx retryable; non-JSON is MALFORMED", async () => {
    await expect(client(zoho({ apiBody: { code: 4, message: "The journal date is in a locked period" } })).createJournal(voucher, accountOf)).rejects.toMatchObject({ code: "REJECTED", retryable: false, message: expect.stringMatching(/locked period/) });
    await expect(client(zoho({ apiStatus: 401, apiBody: { message: "Invalid token" } })).createJournal(voucher, accountOf)).rejects.toBeInstanceOf(UnauthorizedIntegrationError);
    await expect(client(zoho({ apiStatus: 429 })).createJournal(voucher, accountOf)).rejects.toMatchObject({ retryable: true });
    await expect(client(zoho({ apiStatus: 502 })).createJournal(voucher, accountOf)).rejects.toMatchObject({ retryable: true });
    await expect(client(zoho({ apiBody: "<html>" })).createJournal(voucher, accountOf)).rejects.toMatchObject({ code: "MALFORMED" });
  });

  it("Z5 sign-in failures are unauthorized and never leak the credentials", async () => {
    const e = await client(zoho({ tokenStatus: 400 })).createJournal(voucher, accountOf).catch((x) => x as Error);
    expect(e).toBeInstanceOf(IntegrationError);
    expect(e.message).not.toMatch(/client-secret-value|1000\.refresh|1000\.CLIENTID/);
    const noToken = await new ZohoBooksClient({ dataCenter: "in", organizationId: "60012345", credentials: creds, fetchImpl: async () => res({ error: "invalid_code" }) }).createJournal(voucher, accountOf).catch((x) => x as Error);
    expect(noToken).toBeInstanceOf(UnauthorizedIntegrationError);
  });

  it("Z6 an earlier attempt whose answer was lost is found by its reference, so a retry never creates a second journal", async () => {
    const z = zoho({ journals: [{ journal_id: "777", reference_number: "inv:abc123" }, { journal_id: "778", reference_number: "inv:other" }] });
    expect(await client(z).findJournal("inv:abc123")).toBe("777");
    expect(await client(zoho()).findJournal("inv:abc123")).toBeNull();
    expect(z.calls.some((x) => x.url.includes("reference_number=inv%3Aabc123"))).toBe(true);
  });
});

describe("S. Google Sheets", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const sa = { clientEmail: "restora@proj.iam.gserviceaccount.com", privateKey };
  const SHEET = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

  /** A tiny Sheets emulator: tabs with cell grids, token endpoint, batchUpdate addSheet, values get / update / clear. */
  function emulator(opts: { tabs?: Record<string, unknown[][]>; status?: number } = {}) {
    const tabs = new Map<string, unknown[][]>(Object.entries(opts.tabs ?? {}));
    const calls: Array<{ method: string; url: string; body: string; headers: Record<string, string> }> = [];
    const fetchImpl = async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ method, url, body: String(init.body ?? ""), headers: (init.headers ?? {}) as Record<string, string> });
      if (url === GOOGLE_TOKEN_URL) return res({ access_token: "gtok", expires_in: 3600 });
      if (opts.status) return res({ error: { message: "nope" } }, opts.status);
      const base = `${GOOGLE_SHEETS_API}/${SHEET}`;
      if (!url.startsWith(base)) return res({}, 404);
      const rest = url.slice(base.length);
      if (method === "GET" && rest.startsWith("?fields=")) return res({ sheets: [...tabs.keys()].map((title) => ({ properties: { title } })) });
      if (method === "POST" && rest === ":batchUpdate") { const t = JSON.parse(String(init.body)).requests[0].addSheet.properties.title; tabs.set(t, []); return res({}); }
      const m = /^\/values\/([^?:]+)(:clear)?(\?.*)?$/.exec(rest);
      if (!m) return res({}, 404);
      const range = decodeURIComponent(m[1]);
      const tab = /^'([^']+)'/.exec(range)![1];
      if (method === "GET") return res({ values: tabs.get(tab) ?? [] });
      if (m[2]) { const from = Number(/!A(\d+)/.exec(range)![1]); tabs.set(tab, (tabs.get(tab) ?? []).slice(0, from - 1)); return res({}); }
      tabs.set(tab, JSON.parse(String(init.body)).values);
      return res({ updatedCells: 1 });
    };
    return { tabs, calls, fetchImpl };
  }
  const client = (e: ReturnType<typeof emulator>) => new GoogleSheetsClient({ spreadsheetId: SHEET, credentials: sa, fetchImpl: e.fetchImpl });

  it("S1 the service-account assertion is a valid RS256 JWT for the Sheets scope, signed with the account's key", () => {
    const jwt = signServiceAccountJwt(sa, 1_800_000_000);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({ iss: sa.clientEmail, scope: "https://www.googleapis.com/auth/spreadsheets", aud: GOOGLE_TOKEN_URL, iat: 1_800_000_000, exp: 1_800_003_600 });
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${c}`);
    expect(v.verify(createPublicKey(publicKey), Buffer.from(s, "base64url"))).toBe(true);
    // a key pasted into a one-line field with literal \n sequences still signs
    expect(() => signServiceAccountJwt({ ...sa, privateKey: privateKey.replace(/\n/g, "\\n") })).not.toThrow();
    expect(() => signServiceAccountJwt({ ...sa, privateKey: "not a key" })).toThrow(/not a valid PEM key/);
  });

  it("S2 a tab that does not exist reads as empty; writing creates it, writes RAW values and clears what the new content no longer covers", async () => {
    const e = emulator({ tabs: { Other: [["x"]] } });
    const c = client(e);
    expect(await c.read("RESTORA Materials")).toEqual([]);
    await c.write("RESTORA Materials", [["SKU", "Name", "Reorder"], ["RM-1", "=SUM(A1)", 12.5]]);
    expect(e.tabs.get("RESTORA Materials")).toEqual([["SKU", "Name", "Reorder"], ["RM-1", "=SUM(A1)", 12.5]]);
    const put = e.calls.find((x) => x.method === "PUT")!;
    expect(put.url).toContain("valueInputOption=RAW"); // "=SUM(A1)" stays text, it is never evaluated
    expect(put.headers.Authorization).toBe("Bearer gtok");
    expect(e.calls.some((x) => x.url.endsWith(":batchUpdate"))).toBe(true);
    // shrinking: the old trailing rows are cleared AFTER the update
    await c.write("RESTORA Materials", [["SKU", "Name", "Reorder"]]);
    expect(e.tabs.get("RESTORA Materials")).toEqual([["SKU", "Name", "Reorder"]]);
    const order = e.calls.filter((x) => x.url.includes("/values/")).map((x) => (x.url.includes(":clear") ? "clear" : x.method));
    expect(order.slice(-2)).toEqual(["PUT", "clear"]);
    // numbers and booleans come back as text
    e.tabs.set("RESTORA Materials", [["SKU", "n", "b"], ["RM-1", 12.5, true]]);
    expect(await c.read("RESTORA Materials")).toEqual([["SKU", "n", "b"], ["RM-1", "12.5", "TRUE"]]);
  });

  it("S3 tab names and the spreadsheet id are validated before they reach a URL", async () => {
    const e = emulator();
    const c = client(e);
    for (const tab of ["a'b", "x/../y", "A1:B2", "", "=cmd", "a".repeat(70)]) await expect(c.read(tab)).rejects.toMatchObject({ code: "REJECTED" });
    expect(() => new GoogleSheetsClient({ spreadsheetId: "../../etc", credentials: sa })).toThrow(/spreadsheet id/);
    expect(() => new GoogleSheetsClient({ spreadsheetId: SHEET, credentials: { clientEmail: "nope", privateKey: "x" } })).toThrow(/credentials are not set/);
    expect(e.calls.filter((x) => x.url.startsWith(GOOGLE_SHEETS_API))).toHaveLength(0);
  });

  it("S4 error classes: 403 unauthorized (not retried), 429 / 5xx retryable, malformed answers MALFORMED; hosts are constants", async () => {
    await expect(client(emulator({ status: 403 })).read("RESTORA Materials")).rejects.toBeInstanceOf(UnauthorizedIntegrationError);
    await expect(client(emulator({ status: 429 })).read("RESTORA Materials")).rejects.toMatchObject({ retryable: true });
    await expect(client(emulator({ status: 500 })).healthCheck()).rejects.toMatchObject({ retryable: true });
    const bad = new GoogleSheetsClient({ spreadsheetId: SHEET, credentials: sa, fetchImpl: async (u) => (u === GOOGLE_TOKEN_URL ? res({ access_token: "t" }) : res("<html>")) });
    await expect(bad.healthCheck()).rejects.toMatchObject({ code: "MALFORMED" });
    const e = emulator();
    await client(e).healthCheck();
    expect(new Set(e.calls.map((x) => new URL(x.url).host))).toEqual(new Set(["oauth2.googleapis.com", "sheets.googleapis.com"]));
  });

  it("S5 the in-memory mock behaves like a sheet: replace, read back as text, a person's edit, an injected failure", async () => {
    const m = new MockSheetsProvider();
    await m.write("T", [["a", 1], ["b", 2]]);
    expect(await m.read("T")).toEqual([["a", "1"], ["b", "2"]]);
    m.edit("T", 1, 1, "9");
    expect((await m.read("T"))[1]).toEqual(["b", "9"]);
    m.failNext = new IntegrationError("UNAVAILABLE", "down", true);
    await expect(m.read("T")).rejects.toMatchObject({ retryable: true });
    expect(await m.read("T")).toHaveLength(2); // only the next call fails
    expect(m.mode).toBe("MOCK");
  });
});

describe("C. payout statement CSV", () => {
  const header = "order_id,settled_at,gross,commission,penalty,ad_spend,other_deductions,net_paid";

  it("C1 parses a complete statement (any column order, optional columns, quoted ids, BOM, CRLF)", () => {
    const r = parseStatementCsv(`﻿${header}\r\n"Z-1,1",2026-10-07,500.00,115.00,0,0,0,385.00\r\nZ-2,2026-10-07,200,44,10,0,0,146\r\n`);
    expect(r.errors).toEqual([]);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({ externalId: "Z-1,1", grossAmount: 500, commission: 115, netPayout: 385 });
    expect(r.lines[1]).toMatchObject({ penalty: 10, netPayout: 146 });
    const slim = parseStatementCsv("net,order,gross,date,commission\n385,Z-9,500,2026-10-07,115");
    expect(slim.errors).toEqual([]);
    expect(slim.lines[0]).toMatchObject({ externalId: "Z-9", penalty: 0, adSpend: 0, otherDeductions: 0 });
  });

  it("C2 every bad cell is reported with its row and column, and nothing is sent when anything is wrong", () => {
    const r = parseStatementCsv(`${header}\nZ-1,not-a-date,500,115,0,0,0,385\n,2026-10-07,500,abc,0,0,0,385\nZ-3,2026-10-07,5e2,115,0,0,0,385\nZ-4,2026-10-07,1.234,1,0,0,0,0`);
    expect(r.lines).toEqual([]);
    expect(r.errors.join("\n")).toMatch(/Row 2: settled_at must be a date/);
    expect(r.errors.join("\n")).toMatch(/Row 3: order_id is empty/);
    expect(r.errors.join("\n")).toMatch(/Row 3: commission must be a plain amount/);
    expect(r.errors.join("\n")).toMatch(/Row 4: grossAmount must be a plain amount/);
    expect(r.errors.join("\n")).toMatch(/Row 5: grossAmount must be a plain amount/);
  });

  it("C3 a missing header column, an empty paste and an oversized statement are refused up front", () => {
    expect(parseStatementCsv("order_id,gross\nZ-1,5").errors[0]).toMatch(/header row lacks: settledAt, commission, netPayout/);
    expect(parseStatementCsv("  \n").errors[0]).toMatch(/Paste the statement/);
    const big = [header, ...Array.from({ length: 3 }, (_, i) => `Z-${i},2026-10-07,1,0,0,0,0,1`)].join("\n");
    expect(parseStatementCsv(big, 2).errors[0]).toMatch(/At most 2 lines/);
  });
});
