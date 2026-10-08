/**
 * Google Sheets sync adapter (proposal p. 3 / p. 12: "your team keeps using the
 * spreadsheet they like; the system pushes and pulls without anyone copying
 * data"). The business rules (what is synced, who wins, conflicts) live in
 * services/sheetsSync.ts; this module only moves a tab's cell grid in and out.
 *
 *  - GoogleSheetsClient: the Sheets API v4 with a service account (the
 *    spreadsheet is shared with the account's e-mail). The OAuth token is
 *    obtained with a signed JWT (RS256, node:crypto: no SDK). Base URLs are
 *    constants (no tenant-configurable address: no SSRF); the spreadsheet id
 *    and tab names are validated before they reach a URL. Values are written
 *    RAW, so a cell such as "=1+1" stays text and is never evaluated.
 *    Contract-tested against an emulator of the documented request / response
 *    shapes; it has NOT been run against a real spreadsheet.
 *  - MockSheetsProvider: in memory, for tests and local development; labelled
 *    MOCK everywhere it is shown.
 *
 * Errors are IntegrationErrors with secret-free messages; 401 / 403 are
 * UNAUTHORIZED and never retried until the credentials change.
 */
import { createSign } from "node:crypto";
import { IntegrationError, UnauthorizedIntegrationError, classifyStatus, safeMessage, sendRequest, type FetchLike } from "@/integrations/http";

/** What is read back: every cell as text, row by row (row 0 = header). */
export type SheetValues = string[][];
/** What is written: numbers stay numbers (summable in the sheet), everything else is text. */
export type SheetCell = string | number;

export interface SheetsProvider {
  readonly name: string;
  readonly mode: "MOCK" | "SANDBOX" | "LIVE";
  /** Every non-empty row of the tab (header included). A tab that does not exist reads as empty. */
  read(tab: string): Promise<SheetValues>;
  /** Replace the tab's content (creating the tab when needed). */
  write(tab: string, values: SheetCell[][]): Promise<void>;
  healthCheck(): Promise<boolean>;
}

export const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,100}$/;
/** Tab names RESTORA writes: letters, digits, space, dash, underscore; no quotes or range characters. */
export const TAB_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,60}$/;

const cellText = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v));
const columnLetter = (n: number) => { let s = ""; for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

// ---------------------------------------------------------------- mock

/** In-memory spreadsheet (tests / local development). `edit` plays the team changing a cell. */
export class MockSheetsProvider implements SheetsProvider {
  readonly name = "mock";
  readonly mode = "MOCK" as const;
  readonly tabs = new Map<string, SheetValues>();
  failNext: IntegrationError | null = null;
  private maybeFail() { if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; } }
  async read(tab: string) { this.maybeFail(); return (this.tabs.get(tab) ?? []).map((r) => [...r]); }
  async write(tab: string, values: SheetCell[][]) { this.maybeFail(); this.tabs.set(tab, values.map((r) => r.map(cellText))); }
  async healthCheck() { return true; }
  /** Test helper: set one cell (0-based row / column) the way a person would. */
  edit(tab: string, row: number, col: number, value: string) {
    const rows = this.tabs.get(tab) ?? [];
    while (rows.length <= row) rows.push([]);
    while (rows[row].length <= col) rows[row].push("");
    rows[row][col] = value;
    this.tabs.set(tab, rows);
  }
}

// ---------------------------------------------------------------- Google

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export type GoogleServiceAccount = { clientEmail: string; privateKey: string };

function base64url(input: Buffer | string) {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** The signed assertion Google exchanges for an access token (RS256 JWT). */
export function signServiceAccountJwt(sa: GoogleServiceAccount, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const head = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({ iss: sa.clientEmail, scope: SCOPE, aud: GOOGLE_TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${claim}`);
  // Keys pasted into a single-line field carry literal "\n" sequences.
  const key = sa.privateKey.includes("\\n") ? sa.privateKey.replace(/\\n/g, "\n") : sa.privateKey;
  let sig: string;
  try { sig = base64url(signer.sign(key)); } catch { throw new IntegrationError("NOT_CONFIGURED", "The Google service account private key is not a valid PEM key", false); }
  return `${head}.${claim}.${sig}`;
}

export class GoogleSheetsClient implements SheetsProvider {
  readonly name = "google_sheets";
  private token: { value: string; expiresAt: number } | null = null;
  private knownTabs: Set<string> | null = null;
  private readonly fetchImpl: FetchLike;
  constructor(private readonly opts: { spreadsheetId: string; credentials: GoogleServiceAccount; mode?: "SANDBOX" | "LIVE"; fetchImpl?: FetchLike; timeoutMs?: number }) {
    if (!SPREADSHEET_ID.test(opts.spreadsheetId)) throw new IntegrationError("NOT_CONFIGURED", "The spreadsheet id is missing or invalid", false);
    if (!/^[^\s@]+@[^\s@]+$/.test(opts.credentials.clientEmail) || !opts.credentials.privateKey) throw new IntegrationError("NOT_CONFIGURED", "Google service account credentials are not set", false);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }
  get mode() { return this.opts.mode ?? "SANDBOX"; }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signServiceAccountJwt(this.opts.credentials) });
    const res = await sendRequest(this.fetchImpl, GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }, this.opts.timeoutMs ?? 10000);
    if (res.status >= 400) classifyStatus(res.status, "Google sign-in");
    let j: { access_token?: string; expires_in?: number; error?: string };
    try { j = JSON.parse(res.text); } catch { throw new IntegrationError("MALFORMED", "Google returned a malformed token response", false); }
    if (!j.access_token) throw new UnauthorizedIntegrationError(`Google did not issue an access token${j.error ? ` (${safeMessage(j.error, 60)})` : ""}`);
    this.token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    const token = await this.accessToken();
    const res = await sendRequest(this.fetchImpl, `${GOOGLE_SHEETS_API}/${this.opts.spreadsheetId}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }, this.opts.timeoutMs ?? 15000);
    let j: Record<string, unknown> & { error?: { message?: string } } = {};
    try { j = JSON.parse(res.text || "{}"); } catch { if (res.status < 400) throw new IntegrationError("MALFORMED", "Google returned a malformed response", false, res.status); }
    if (res.status >= 400) classifyStatus(res.status, "Google Sheets", j.error?.message ?? "");
    return j as T;
  }

  private checkTab(tab: string) {
    if (!TAB_NAME.test(tab)) throw new IntegrationError("REJECTED", "Invalid tab name", false);
  }

  private async tabs(): Promise<Set<string>> {
    if (this.knownTabs) return this.knownTabs;
    const meta = await this.call<{ sheets?: Array<{ properties?: { title?: string } }> }>("GET", "?fields=sheets.properties.title");
    if (!Array.isArray(meta.sheets)) throw new IntegrationError("MALFORMED", "Google returned an unexpected spreadsheet description", false);
    return (this.knownTabs = new Set(meta.sheets.map((s) => s.properties?.title ?? "")));
  }

  async read(tab: string): Promise<SheetValues> {
    this.checkTab(tab);
    if (!(await this.tabs()).has(tab)) return [];
    const r = await this.call<{ values?: unknown[][] }>("GET", `/values/${encodeURIComponent(`'${tab}'`)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`);
    if (r.values !== undefined && !Array.isArray(r.values)) throw new IntegrationError("MALFORMED", "Google returned unexpected cell values", false);
    return (r.values ?? []).map((row) => (Array.isArray(row) ? row.map(cellText) : []));
  }

  async write(tab: string, values: SheetCell[][]): Promise<void> {
    this.checkTab(tab);
    if (!(await this.tabs()).has(tab)) {
      await this.call("POST", ":batchUpdate", { requests: [{ addSheet: { properties: { title: tab } } }] });
      this.knownTabs!.add(tab);
    }
    const width = Math.max(1, ...values.map((r) => r.length));
    const range = `'${tab}'!A1:${columnLetter(width)}${Math.max(values.length, 1)}`;
    // Update first (the data is never missing), then clear what the new content no longer covers.
    await this.call("PUT", `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { range, majorDimension: "ROWS", values: values.map((r) => [...r, ...Array(width - r.length).fill("")]) });
    await this.call("POST", `/values/${encodeURIComponent(`'${tab}'!A${values.length + 1}:ZZ`)}:clear`, {});
  }

  async healthCheck(): Promise<boolean> {
    await this.tabs();
    return true;
  }
}
