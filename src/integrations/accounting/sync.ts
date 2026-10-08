/**
 * Direct accounting sync (proposal p. 17, "Tally / Zoho deep integration").
 * RESTORA stays the source of truth; each voucher is sent once, as its own
 * request, under the outbox's per-voucher idempotency key
 * (services/accountingSync.ts). Two adapters:
 *
 *  - TallyGatewayClient: TallyPrime's XML-over-HTTP import (the same envelope
 *    as the Tally file export, one voucher per request, with the target company
 *    as SVCURRENTCOMPANY). Tally listens on the accountant's machine, so the
 *    gateway URL can only be one the DEPLOYMENT allows (TALLY_GATEWAY_URLS):
 *    a tenant cannot point the server at an arbitrary address (no SSRF).
 *    The voucher carries REMOTEID = its RESTORA source key for traceability;
 *    whether a given Tally build treats a repeated REMOTEID as a duplicate is
 *    NOT relied on: a send whose outcome is unknown is never retried
 *    automatically (manual retry after checking Tally).
 *  - ZohoBooksClient: the Zoho Books v3 API with an OAuth refresh token
 *    (accounts.zoho.<dc>), one manual journal per voucher, reference_number =
 *    the source key; before re-sending a voucher whose earlier attempt has an
 *    unknown outcome it looks the reference up, so a lost response never
 *    creates a second journal. Base URLs are fixed per Zoho data centre.
 *
 * Errors are IntegrationErrors (secret-free); 401 / 403 are UNAUTHORIZED and
 * never retried until the credentials change. Neither adapter has been run
 * against a real Tally company or Zoho organisation: they are contract-tested
 * against emulators of the documented request / response shapes.
 */
import { IntegrationError, UnauthorizedIntegrationError, classifyStatus as classify, safeMessage, sendRequest as send, type FetchLike } from "@/integrations/http";

export { UnauthorizedIntegrationError };
import { TallyAccountingFormat, type Voucher } from "@/integrations/accounting";

// ---------------------------------------------------------------- Tally

/** Gateway URLs the deployment allows (comma-separated TALLY_GATEWAY_URLS); empty = Tally sync unavailable. */
export function allowedTallyGateways(env = process.env.TALLY_GATEWAY_URLS): string[] {
  return (env ?? "").split(",").map((s) => s.trim()).filter((s) => /^https?:\/\/[^\s/]+(:\d+)?\/?$/i.test(s));
}

export class TallyGatewayClient {
  constructor(private readonly opts: { url: string; company: string; fetchImpl?: FetchLike; timeoutMs?: number }) {
    if (!allowedTallyGateways().includes(opts.url)) throw new IntegrationError("NOT_CONFIGURED", "This Tally gateway address is not allowed by the deployment (TALLY_GATEWAY_URLS)", false);
  }

  /** One voucher per request. Returns Tally's created count; any LINEERROR / ERRORS is a REJECTED error. */
  async post(v: Voucher): Promise<{ created: number }> {
    const xml = new TallyAccountingFormat().render([v])
      .replace("<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>", `<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xmlText(this.opts.company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>`)
      .replace(`<VOUCHER VCHTYPE=`, `<VOUCHER REMOTEID="${xmlText(v.sourceKey)}" VCHTYPE=`);
    const res = await send(this.opts.fetchImpl ?? fetch, this.opts.url, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8" }, body: xml }, this.opts.timeoutMs ?? 15000);
    if (res.status >= 400) classify(res.status, "Tally");
    const tag = (t: string) => { const m = res.text.match(new RegExp(`<${t}>\\s*([^<]*)\\s*</${t}>`, "i")); return m ? m[1].trim() : null; };
    const lineError = tag("LINEERROR");
    const errors = Number(tag("ERRORS") ?? 0);
    const created = Number(tag("CREATED") ?? NaN);
    if (lineError || errors > 0) throw new IntegrationError("REJECTED", safeMessage(`Tally rejected the voucher${lineError ? `: ${lineError}` : ""}`), false);
    if (!Number.isFinite(created)) throw new IntegrationError("MALFORMED", "Tally returned an unexpected response", false);
    if (created < 1) throw new IntegrationError("REJECTED", "Tally did not create the voucher", false);
    return { created };
  }

  async healthCheck(): Promise<boolean> {
    const res = await send(this.opts.fetchImpl ?? fetch, this.opts.url, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8" }, body: `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Companies</REPORTNAME></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>` }, this.opts.timeoutMs ?? 8000);
    return res.status < 400;
  }
}

const xmlText = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

// ---------------------------------------------------------------- Zoho Books

export const ZOHO_DATA_CENTERS = { in: "in", com: "com", eu: "eu", au: "com.au", jp: "jp" } as const;
export type ZohoDataCenter = keyof typeof ZOHO_DATA_CENTERS;

export type ZohoCredentials = { clientId: string; clientSecret: string; refreshToken: string };

export class ZohoBooksClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchImpl: FetchLike;
  constructor(private readonly opts: { dataCenter: ZohoDataCenter; organizationId: string; credentials: ZohoCredentials; fetchImpl?: FetchLike; timeoutMs?: number }) {
    if (!ZOHO_DATA_CENTERS[opts.dataCenter]) throw new IntegrationError("NOT_CONFIGURED", "Unknown Zoho data centre", false);
    if (!/^\d{3,30}$/.test(opts.organizationId)) throw new IntegrationError("NOT_CONFIGURED", "The Zoho organisation id is missing or invalid", false);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }
  private get accounts() { return `https://accounts.zoho.${ZOHO_DATA_CENTERS[this.opts.dataCenter]}`; }
  private get api() { return `https://www.zohoapis.${ZOHO_DATA_CENTERS[this.opts.dataCenter]}/books/v3`; }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const q = new URLSearchParams({ refresh_token: this.opts.credentials.refreshToken, client_id: this.opts.credentials.clientId, client_secret: this.opts.credentials.clientSecret, grant_type: "refresh_token" });
    const res = await send(this.fetchImpl, `${this.accounts}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: q.toString() }, this.opts.timeoutMs ?? 10000);
    if (res.status >= 400) classify(res.status, "Zoho sign-in");
    let j: { access_token?: string; expires_in?: number; error?: string };
    try { j = JSON.parse(res.text); } catch { throw new IntegrationError("MALFORMED", "Zoho returned a malformed token response", false); }
    if (!j.access_token) throw new UnauthorizedIntegrationError(`Zoho did not issue an access token${j.error ? ` (${safeMessage(j.error, 60)})` : ""}`);
    this.token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const token = await this.accessToken();
    const sep = path.includes("?") ? "&" : "?";
    const res = await send(this.fetchImpl, `${this.api}${path}${sep}organization_id=${encodeURIComponent(this.opts.organizationId)}`, { method, headers: { Authorization: `Zoho-oauthtoken ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }, this.opts.timeoutMs ?? 15000);
    let j: { code?: number; message?: string } & Record<string, unknown> = {};
    try { j = JSON.parse(res.text); } catch { if (res.status < 400) throw new IntegrationError("MALFORMED", "Zoho returned a malformed response", false, res.status); }
    if (res.status >= 400) classify(res.status, "Zoho Books", typeof j.message === "string" ? j.message : "");
    if (j.code !== undefined && j.code !== 0) throw new IntegrationError("REJECTED", safeMessage(`Zoho Books refused the journal: ${j.message ?? `code ${j.code}`}`), false, res.status);
    return j as T;
  }

  /** A journal already created for this voucher (an earlier attempt whose answer was lost). */
  async findJournal(reference: string): Promise<string | null> {
    const r = await this.call<{ journals?: Array<{ journal_id: string; reference_number?: string }> }>("GET", `/journals?reference_number=${encodeURIComponent(reference)}`);
    return r.journals?.find((x) => x.reference_number === reference)?.journal_id ?? null;
  }

  /** One manual journal for the voucher; ledgers must already be mapped to Zoho account ids. */
  async createJournal(v: Voucher, accountIdOf: (ledger: string) => string | undefined): Promise<{ journalId: string }> {
    const missing = [...new Set(v.lines.map((l) => l.ledger).filter((l) => !accountIdOf(l)))];
    if (missing.length) throw new IntegrationError("NOT_CONFIGURED", `Map these ledgers to Zoho account ids first: ${missing.join(", ")}`, false);
    const r = await this.call<{ journal?: { journal_id?: string } }>("POST", "/journals", {
      journal_date: v.date, reference_number: v.sourceKey, notes: `${v.type} ${v.number}: ${v.narration}`.slice(0, 500),
      line_items: v.lines.map((l) => ({ account_id: accountIdOf(l.ledger)!, debit_or_credit: l.debit > 0 ? "debit" : "credit", amount: Number((l.debit > 0 ? l.debit : l.credit).toFixed(2)), description: v.party ?? v.narration })),
    });
    if (!r.journal?.journal_id) throw new IntegrationError("MALFORMED", "Zoho did not return the journal id", false);
    return { journalId: r.journal.journal_id };
  }

  async healthCheck(): Promise<boolean> {
    await this.call("GET", "/organizations");
    return true;
  }
}
